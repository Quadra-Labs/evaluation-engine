// Quadra Polymarket prediction-market evaluation enclave.
//
// One enclave serves THREE prediction categories, dispatched internally by category_id (the
// competition engine routes all three evaluator ids to this one URL):
//
//   polymarket-resolution  the agent guessed YES/NO for a market; score 100 if it matches the
//                          market's resolved winner, else 0.
//   polymarket-event       the agent guessed outcomes for markets in an event; score is
//                          coverage-weighted (correct / total markets in the event * 100).
//   polymarket-price       the agent guessed the YES probability for a target date; score is the
//                          Brier closeness to the real CLOB price at that date.
//
// Like portfolio-roi this returns a SIGNED u8 score (record_score on-chain), so it has its own
// scoring (NOT the shared Pyth oracle) and reuses only the shared job envelope. Resolution/price
// that is not yet available returns a transient error so the engine retries until it resolves.
//
// Both engines are now compiled into one binary. The top-level dispatcher (src/app.rs) peeks
// payload.category_id and forwards the prediction categories here through the Value-based
// validate_input / process_data below (the same shape the finance dispatcher uses), so the two
// sub-engines compose without their handler names colliding.

mod client;
mod score;

use crate::common::{to_signed_response, IntentMessage, ProcessDataRequest, ProcessedDataResponse};
use crate::job::{self, JobEnvelope};
use crate::AppState;
use crate::EnclaveError;
use axum::extract::State;
use axum::Json;
use fastcrypto::ed25519::Ed25519KeyPair;
use score::Guess;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_repr::{Deserialize_repr, Serialize_repr};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use tracing::{info, warn};

pub const CAT_RESOLUTION: &str = "polymarket-resolution";
pub const CAT_EVENT: &str = "polymarket-event";
pub const CAT_PRICE: &str = "polymarket-price";

// The three prediction categories this engine owns; the top-level dispatcher routes these here.
pub const PREDICTION_CATEGORIES: &[&str] = &[CAT_RESOLUTION, CAT_EVENT, CAT_PRICE];

// All three return a u8 score, so they share the score evaluators' intent scope (Score = 0); the
// engine verifies the signature as a score and records it with record_score.
#[derive(Serialize_repr, Deserialize_repr, Debug)]
#[repr(u8)]
pub enum IntentScope {
    Score = 0,
}

// The [start, end] window the competition engine supplies (epoch ms); informational here since
// resolution is driven by the market state / target date, not the window. Accepted for contract
// completeness but not read during scoring.
#[allow(dead_code)]
#[derive(Debug, Default, Deserialize)]
pub struct Window {
    #[serde(default)]
    pub start_ms: u64,
    #[serde(default)]
    pub end_ms: u64,
}

// The prediction job: the shared envelope plus the fixed competition params (market_id / event_id
// / target_ts) and the window.
#[derive(Debug, Deserialize)]
pub struct PredictionJob {
    #[serde(flatten)]
    pub job: JobEnvelope,
    #[serde(default)]
    pub params: BTreeMap<String, String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub window: Window,
}

// The signed payload. Field order/types MUST match the competition engine's BCS ScoreResult
// (agent_id [u8;32], category_id string, job_id string, score u8, finalized_price u64). `[u8;32]`
// serializes as 32 raw bytes under BCS and a JSON number array; the engine's verifier accepts
// either a hex string or a byte array. `finalized_price` is an informational echo of what was
// scored against (resolution: 1 if YES won; event: total markets; price: actual price in bps).
#[derive(Debug, Serialize, Clone)]
pub struct ScoreResult {
    pub agent_id: [u8; 32],
    pub category_id: String,
    pub job_id: String,
    pub score: u8,
    pub finalized_price: u64,
}

#[derive(Serialize)]
pub struct ValidateResponse {
    pub valid: bool,
    pub job_id: String,
}

// --- POST /validate (Value-based, dispatched here by src/app.rs) ------------
// PredictionJob flattens JobEnvelope, so the top-level dispatcher peeks category_id first and only
// then hands us the raw body to deserialize into the typed prediction job.
pub async fn validate_input(Json(raw): Json<Value>) -> Result<Json<Value>, EnclaveError> {
    let req: ProcessDataRequest<PredictionJob> = serde_json::from_value(raw).map_err(de_err)?;
    let resp = validate(req.payload).await?;
    Ok(Json(serde_json::to_value(resp).map_err(ser_err)?))
}

// --- POST /process_data (Value-based, dispatched here by src/app.rs) --------
pub async fn process_data(
    State(state): State<Arc<AppState>>,
    Json(raw): Json<Value>,
) -> Result<Json<Value>, EnclaveError> {
    let req: ProcessDataRequest<PredictionJob> = serde_json::from_value(raw).map_err(de_err)?;
    let signed = process(&state.eph_kp, req.payload).await?;
    Ok(Json(serde_json::to_value(signed).map_err(ser_err)?))
}

// Input validation only (right category, on time, promised output shape).
async fn validate(pjob: PredictionJob) -> Result<ValidateResponse, EnclaveError> {
    ensure_prediction_category(&pjob.job)?;
    job::ensure_timely(&pjob.job).map_err(to_enclave_error)?;
    job::validate_output_schema(&pjob.job).map_err(to_enclave_error)?;
    Ok(ValidateResponse { valid: true, job_id: pjob.job.job_id })
}

async fn process(
    kp: &Ed25519KeyPair,
    pjob: PredictionJob,
) -> Result<ProcessedDataResponse<IntentMessage<ScoreResult>>, EnclaveError> {
    let job = &pjob.job;
    info!("polymarket job '{}' ({}) for agent '{}'", job.job_id, job.category_id, job.agent_id);

    ensure_prediction_category(job)?;
    job::ensure_timely(job).map_err(to_enclave_error)?;
    job::validate_output_schema(job).map_err(to_enclave_error)?;

    let (score, finalized_price) = match job.category_id.as_str() {
        CAT_RESOLUTION => score_resolution(job, &pjob.params).await?,
        CAT_EVENT => score_event(job, &pjob.params).await?,
        CAT_PRICE => score_price(job, &pjob.params).await?,
        other => return Err(EnclaveError::GenericError(format!("unsupported category '{other}'"))),
    };
    info!("polymarket job '{}' scored {}", job.job_id, score);

    let timestamp_ms = now_unix_ms()?;
    let agent_id = job::parse_sui_address(&job.agent_id).map_err(to_enclave_error)?;
    let result = ScoreResult {
        agent_id,
        category_id: job.category_id.clone(),
        job_id: job.job_id.clone(),
        score,
        finalized_price,
    };
    Ok(to_signed_response(kp, result, timestamp_ms, IntentScope::Score as u8))
}

// --- per-category scoring ---------------------------------------------------

/// Job #1: 100 if the agent's `outcome` equals the market's resolved winner, else 0.
async fn score_resolution(
    job: &JobEnvelope,
    params: &BTreeMap<String, String>,
) -> Result<(u8, u64), EnclaveError> {
    let market_id = required_param(params, "market_id")?;
    let agent_outcome = result_str(job, "outcome")?;
    let market = client::fetch_market(market_id).await.map_err(to_polymarket_error)?;
    let winner = market
        .winner()
        .ok_or_else(|| EnclaveError::GenericError(format!("market {market_id} not resolved yet")))?;
    let yes_won = winner.trim().eq_ignore_ascii_case("yes");
    Ok((score::score_resolution(agent_outcome, &winner), yes_won as u64))
}

/// Job #2: coverage-weighted score over the event's markets. Requires every guessed market in the
/// event to be resolved (else transient retry); a guess for a market not in the event is an agent
/// fault.
async fn score_event(
    job: &JobEnvelope,
    params: &BTreeMap<String, String>,
) -> Result<(u8, u64), EnclaveError> {
    let event_id = required_param(params, "event_id")?;
    let guesses = parse_guesses(job)?;
    let markets = client::fetch_event_markets(event_id).await.map_err(to_polymarket_error)?;

    let ids: BTreeSet<&str> = markets.iter().map(|m| m.id.as_str()).collect();
    let mut winners: BTreeMap<String, String> = BTreeMap::new();
    for m in &markets {
        if let Some(w) = m.winner() {
            winners.insert(m.id.clone(), w);
        }
    }
    // Every guessed market must belong to the event; and each guessed market must have resolved
    // (otherwise retry so the score reflects the final outcome).
    for g in &guesses {
        if !ids.contains(g.market_id.as_str()) {
            return Err(EnclaveError::GenericError(format!(
                "unknown market '{}' (not in event {event_id})",
                g.market_id
            )));
        }
        if !winners.contains_key(&g.market_id) {
            return Err(EnclaveError::GenericError(format!(
                "market '{}' in event {event_id} not resolved yet",
                g.market_id
            )));
        }
    }
    let total = markets.len();
    Ok((score::score_event(&guesses, &winners, total), total as u64))
}

/// Job #3: Brier closeness of the agent's `probability` to the real CLOB YES price at `target_ts`.
async fn score_price(
    job: &JobEnvelope,
    params: &BTreeMap<String, String>,
) -> Result<(u8, u64), EnclaveError> {
    let market_id = required_param(params, "market_id")?;
    let target_ts: u64 = required_param(params, "target_ts")?
        .parse()
        .map_err(|_| EnclaveError::GenericError("param 'target_ts' is not a unix-seconds integer".into()))?;
    let guess = result_f64(job, "probability")?;

    let now_s = now_unix_ms()? / 1000;
    if target_ts > now_s {
        return Err(EnclaveError::GenericError(format!(
            "target_ts {target_ts} is in the future, not resolvable yet (now {now_s})"
        )));
    }
    let market = client::fetch_market(market_id).await.map_err(to_polymarket_error)?;
    let token = market
        .yes_token_id()
        .ok_or_else(|| EnclaveError::GenericError(format!("market {market_id} has no YES token id")))?;
    let actual = client::fetch_price_at(&token, target_ts).await.map_err(to_polymarket_error)?;
    let finalized_bps = (actual.clamp(0.0, 1.0) * 10_000.0).round() as u64;
    Ok((score::score_price(guess, actual), finalized_bps))
}

// --- helpers ----------------------------------------------------------------

fn de_err(e: serde_json::Error) -> EnclaveError {
    EnclaveError::GenericError(format!("invalid request body for category: {e}"))
}

fn ser_err(e: serde_json::Error) -> EnclaveError {
    EnclaveError::GenericError(format!("failed to serialize response: {e}"))
}

fn ensure_prediction_category(job: &JobEnvelope) -> Result<(), EnclaveError> {
    match job.category_id.as_str() {
        CAT_RESOLUTION | CAT_EVENT | CAT_PRICE => Ok(()),
        other => Err(EnclaveError::GenericError(format!(
            "this enclave only serves the polymarket categories, got '{other}'"
        ))),
    }
}

fn required_param<'a>(
    params: &'a BTreeMap<String, String>,
    key: &str,
) -> Result<&'a str, EnclaveError> {
    match params.get(key) {
        Some(v) if !v.trim().is_empty() => Ok(v.as_str()),
        _ => Err(EnclaveError::GenericError(format!("job params missing '{key}'"))),
    }
}

// Read a required string field out of agent_result. "missing field" classifies as an agent fault.
fn result_str<'a>(job: &'a JobEnvelope, field: &str) -> Result<&'a str, EnclaveError> {
    job.agent_result
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| EnclaveError::GenericError(format!("agent_result '{field}' is missing field or not a string")))
}

fn result_f64(job: &JobEnvelope, field: &str) -> Result<f64, EnclaveError> {
    job.agent_result
        .get(field)
        .and_then(|v| v.as_f64())
        .ok_or_else(|| EnclaveError::GenericError(format!("agent_result '{field}' is missing field or not a number")))
}

// The agent's guesses live in agent_result.guesses as a JSON-encoded array string (the data-layer
// output schema is primitives only). A parse failure is the agent's fault.
fn parse_guesses(job: &JobEnvelope) -> Result<Vec<Guess>, EnclaveError> {
    let raw = result_str(job, "guesses")?;
    serde_json::from_str::<Vec<Guess>>(raw).map_err(|e| {
        warn!("bad guesses for job '{}': {}", job.job_id, e);
        EnclaveError::GenericError(format!("invalid guess list (not a JSON array of {{market_id,outcome}}): {e}"))
    })
}

fn now_unix_ms() -> Result<u64, EnclaveError> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| EnclaveError::GenericError(format!("failed to read current time: {e}")))?
        .as_millis() as u64)
}

fn to_enclave_error(error: job::JobError) -> EnclaveError {
    warn!("rejecting job: {error}");
    EnclaveError::GenericError(error.to_string())
}

fn to_polymarket_error(error: client::PolymarketError) -> EnclaveError {
    warn!("polymarket lookup failed: {error}");
    EnclaveError::GenericError(error.to_string())
}

#[cfg(test)]
mod test {
    use super::*;

    fn sample() -> ScoreResult {
        ScoreResult {
            agent_id: [0xab; 32],
            category_id: CAT_RESOLUTION.to_string(),
            job_id: "job-1".to_string(),
            score: 100,
            finalized_price: 1,
        }
    }

    // The signed bytes MUST match competition/src/evaluation.ts ScoreResult: agent_id as 32 raw
    // bytes (no length prefix), then category_id/job_id as BCS strings, then score (u8) and
    // finalized_price (u64). A drift here silently fails verifyScoreSignature on a real enclave.
    #[test]
    fn bcs_layout_matches_engine_scoreresult() {
        let bytes = bcs::to_bytes(&sample()).unwrap();
        assert_eq!(&bytes[..32], &[0xab; 32]);
        assert_eq!(bytes[32] as usize, CAT_RESOLUTION.len()); // uleb128 length prefix (< 128)
        assert_eq!(&bytes[33..33 + CAT_RESOLUTION.len()], CAT_RESOLUTION.as_bytes());
    }

    #[test]
    fn score_intent_scope_is_zero() {
        assert_eq!(IntentScope::Score as u8, 0);
    }
}
