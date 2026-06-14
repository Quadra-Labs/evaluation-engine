// Quadra job envelope shared by every category engine.
//
// A job arrives as JSON on /process_data. agent_result keeps its raw JSON shape
// because each category reads a different structure out of it. The engine no
// longer trusts a finalized result from the request; it resolves the real value
// itself through its oracle (see oracle.rs).

use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

// Timestamps are epoch milliseconds. We use raw millis instead of ISO strings
// so the enclave stays free of a date parsing dependency and the build stays
// deterministic for reproducible PCRs.
#[derive(Debug, Deserialize)]
pub struct JobEnvelope {
    pub agent_id: String,
    pub category_id: String,
    pub job_id: String,
    pub agent_result: Value,
    pub job_template: JobTemplate,
    pub started_at_ms: u64,
    pub delivered_at_ms: u64,
    // The asset the job targets (e.g. "BTC"); the scorer resolves its price feed.
    // Absent for plain validation requests, so it defaults to empty.
    #[serde(default)]
    pub asset: String,
    // The start data snapshotted at delivery (e.g. { "start_price": <1e-8 units> }).
    // Absent for validation requests; present for scoring (process_data).
    #[serde(default)]
    pub start_data: Value,
}

// To work out the moment a job should be resolved against: the agent commits at
// started_at and the guess is for one lifetime later.
pub fn resolution_time_ms(job: &JobEnvelope) -> Result<u64, JobError> {
    let lifetime_ms = parse_lifetime_ms(&job.job_template.lifetime)?;
    job.started_at_ms
        .checked_add(lifetime_ms)
        .ok_or_else(|| JobError::BadLifetime(job.job_template.lifetime.clone()))
}

// output maps each promised field name to its JSON type: "number", "string"
// or "boolean". lifetime is a short duration string like "5m", "30s", "1h".
#[derive(Debug, Deserialize)]
pub struct JobTemplate {
    pub output: BTreeMap<String, String>,
    pub lifetime: String,
}

#[derive(Debug)]
pub enum JobError {
    WrongCategory { expected: String, got: String },
    DeliveredBeforeStart,
    DeliveredTooLate { elapsed_ms: u64, allowed_ms: u64 },
    BadLifetime(String),
    MissingField(String),
    TypeMismatch { field: String, expected: String },
    UnknownType { field: String, declared: String },
    BadAddress(String),
}

impl fmt::Display for JobError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JobError::WrongCategory { expected, got } => {
                write!(f, "this enclave only serves category '{expected}', got '{got}'")
            }
            JobError::DeliveredBeforeStart => {
                write!(f, "delivered_at_ms is before started_at_ms")
            }
            JobError::DeliveredTooLate { elapsed_ms, allowed_ms } => {
                write!(f, "job delivered too late: took {elapsed_ms}ms but lifetime allows {allowed_ms}ms")
            }
            JobError::BadLifetime(s) => write!(f, "could not parse lifetime '{s}'"),
            JobError::MissingField(field) => {
                write!(f, "agent_result is missing field '{field}' promised by the job template")
            }
            JobError::TypeMismatch { field, expected } => {
                write!(f, "agent_result field '{field}' is not of type '{expected}'")
            }
            JobError::UnknownType { field, declared } => {
                write!(f, "job template field '{field}' declares unknown type '{declared}'")
            }
            JobError::BadAddress(s) => write!(f, "agent_id is not a valid Sui address: {s}"),
        }
    }
}

impl std::error::Error for JobError {}

// To make sure this enclave only ever scores the category it was built for.
pub fn ensure_category(job: &JobEnvelope, expected: &str) -> Result<(), JobError> {
    if job.category_id != expected {
        return Err(JobError::WrongCategory {
            expected: expected.to_string(),
            got: job.category_id.clone(),
        });
    }
    Ok(())
}

// To reject deliveries that arrived after the job lifetime ran out.
pub fn ensure_timely(job: &JobEnvelope) -> Result<(), JobError> {
    if job.delivered_at_ms < job.started_at_ms {
        return Err(JobError::DeliveredBeforeStart);
    }
    let elapsed_ms = job.delivered_at_ms - job.started_at_ms;
    let allowed_ms = parse_lifetime_ms(&job.job_template.lifetime)?;
    if elapsed_ms > allowed_ms {
        return Err(JobError::DeliveredTooLate { elapsed_ms, allowed_ms });
    }
    Ok(())
}

// To check the agent's output carries every field the template promised, with
// the right JSON type. The scorer does deeper parsing afterwards.
pub fn validate_output_schema(job: &JobEnvelope) -> Result<(), JobError> {
    for (field, declared_type) in &job.job_template.output {
        let value = job
            .agent_result
            .get(field)
            .ok_or_else(|| JobError::MissingField(field.clone()))?;

        let matches = match declared_type.as_str() {
            "number" => value.is_number(),
            "string" => value.is_string(),
            "boolean" => value.is_boolean(),
            other => {
                return Err(JobError::UnknownType {
                    field: field.clone(),
                    declared: other.to_string(),
                })
            }
        };

        if !matches {
            return Err(JobError::TypeMismatch {
                field: field.clone(),
                expected: declared_type.clone(),
            });
        }
    }
    Ok(())
}

// To turn a "0x" hex string into the 32 byte Sui address that goes into the
// signed score, so the bytes line up with a Move `address` on the verifier.
pub fn parse_sui_address(value: &str) -> Result<[u8; 32], JobError> {
    let trimmed = value.strip_prefix("0x").unwrap_or(value);
    if trimmed.len() != 64 {
        return Err(JobError::BadAddress(format!(
            "expected 64 hex chars, got {}",
            trimmed.len()
        )));
    }
    let mut out = [0u8; 32];
    for (i, chunk) in trimmed.as_bytes().chunks(2).enumerate() {
        let pair = std::str::from_utf8(chunk)
            .map_err(|e| JobError::BadAddress(e.to_string()))?;
        out[i] = u8::from_str_radix(pair, 16)
            .map_err(|e| JobError::BadAddress(e.to_string()))?;
    }
    Ok(out)
}

// To turn a short duration string like "5m" into milliseconds.
pub fn parse_lifetime_ms(lifetime: &str) -> Result<u64, JobError> {
    let lifetime = lifetime.trim();
    if lifetime.len() < 2 {
        return Err(JobError::BadLifetime(lifetime.to_string()));
    }

    let (number_part, unit) = lifetime.split_at(lifetime.len() - 1);
    let amount: u64 = number_part
        .parse()
        .map_err(|_| JobError::BadLifetime(lifetime.to_string()))?;

    let unit_ms = match unit {
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        _ => return Err(JobError::BadLifetime(lifetime.to_string())),
    };

    amount
        .checked_mul(unit_ms)
        .ok_or_else(|| JobError::BadLifetime(lifetime.to_string()))
}

#[cfg(test)]
mod test {
    use super::*;
    use serde_json::json;

    fn sample_job() -> JobEnvelope {
        JobEnvelope {
            agent_id: "0x".to_string() + &"ab".repeat(32),
            category_id: "btc-price-guess".to_string(),
            job_id: "job-1".to_string(),
            agent_result: json!({ "minPrice": 60000, "maxPrice": 60100 }),
            job_template: JobTemplate {
                output: BTreeMap::from([
                    ("minPrice".to_string(), "number".to_string()),
                    ("maxPrice".to_string(), "number".to_string()),
                ]),
                lifetime: "5m".to_string(),
            },
            started_at_ms: 1_700_000_000_000,
            delivered_at_ms: 1_700_000_060_000,
            asset: "BTC".to_string(),
            start_data: json!({ "start_price": 6_000_000_000_000u64 }),
        }
    }

    #[test]
    fn parses_lifetime_units() {
        assert_eq!(parse_lifetime_ms("30s").unwrap(), 30_000);
        assert_eq!(parse_lifetime_ms("5m").unwrap(), 300_000);
        assert_eq!(parse_lifetime_ms("1h").unwrap(), 3_600_000);
        assert_eq!(parse_lifetime_ms("2d").unwrap(), 172_800_000);
        assert!(parse_lifetime_ms("5x").is_err());
        assert!(parse_lifetime_ms("m").is_err());
    }

    #[test]
    fn resolution_time_is_start_plus_lifetime() {
        let job = sample_job();
        assert_eq!(resolution_time_ms(&job).unwrap(), job.started_at_ms + 300_000);
    }

    #[test]
    fn category_guard_rejects_other_categories() {
        let job = sample_job();
        assert!(ensure_category(&job, "btc-price-guess").is_ok());
        assert!(ensure_category(&job, "weather").is_err());
    }

    #[test]
    fn timeliness_accepts_within_lifetime_and_rejects_late() {
        let mut job = sample_job();
        assert!(ensure_timely(&job).is_ok());

        job.delivered_at_ms = job.started_at_ms + 6 * 60_000;
        assert!(ensure_timely(&job).is_err());

        job.delivered_at_ms = job.started_at_ms - 1;
        assert!(matches!(ensure_timely(&job), Err(JobError::DeliveredBeforeStart)));
    }

    #[test]
    fn schema_validation_checks_fields_and_types() {
        let mut job = sample_job();
        assert!(validate_output_schema(&job).is_ok());

        job.agent_result = json!({ "minPrice": 60000 });
        assert!(matches!(validate_output_schema(&job), Err(JobError::MissingField(_))));

        job.agent_result = json!({ "minPrice": "low", "maxPrice": 60100 });
        assert!(matches!(validate_output_schema(&job), Err(JobError::TypeMismatch { .. })));
    }

    #[test]
    fn parses_sui_address_to_32_bytes() {
        let addr = parse_sui_address(&("0x".to_string() + &"01".repeat(32))).unwrap();
        assert_eq!(addr, [1u8; 32]);
        assert!(parse_sui_address("0x1234").is_err());
    }
}
