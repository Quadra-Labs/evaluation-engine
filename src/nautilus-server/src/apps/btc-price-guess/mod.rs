// Quadra btc-price-guess evaluation engine.
//
// One enclave serves one category. This app takes a job, checks it belongs to
// this category, checks it was delivered on time, checks the agent output has
// the promised shape, scores it in [0, 100], and returns the score signed by
// the enclave key so it can be verified onchain later.

use crate::common::IntentMessage;
use crate::common::{to_signed_response, ProcessDataRequest, ProcessedDataResponse};
use crate::job::{self, JobEnvelope};
use crate::oracle::{self, BTC_USD_FEED_ID};
use crate::scoring::btc_price::{BtcPriceScorer, CATEGORY_ID};
use crate::scoring::{ScoreResult, ScorerRegistry, SuiAddress};
use crate::AppState;
use crate::EnclaveError;
use axum::extract::State;
use axum::Json;
use serde::Serialize;
use serde_repr::{Deserialize_repr, Serialize_repr};
use std::sync::Arc;
use tracing::{info, warn};

// Every signed message type gets its own intent scope so a signature for one
// kind of message can not be replayed as another.
#[derive(Serialize_repr, Deserialize_repr, Debug)]
#[repr(u8)]
pub enum IntentScope {
    Score = 0,
}

// To build the registry of scorers this enclave knows about. Since this binary
// is built for one category it holds exactly one scorer.
fn build_registry() -> ScorerRegistry {
    let mut registry = ScorerRegistry::new();
    registry.register(Box::new(BtcPriceScorer));
    registry
}

// The /validate response. No signature: validation only gates payment release
// (via the validator engine); scores are the signed, verifiable artifact.
#[derive(Serialize)]
pub struct ValidateResponse {
    pub valid: bool,
    pub job_id: String,
}

// Input validation only — the first of this engine's two purposes. The
// validator engine calls this to decide whether the agent's delivery is a
// valid output (right category, on time, promised shape) before the intake
// engine releases payment. No oracle, no scoring.
pub async fn validate_input(
    Json(request): Json<ProcessDataRequest<JobEnvelope>>,
) -> Result<Json<ValidateResponse>, EnclaveError> {
    let job = request.payload;
    info!("validating job '{}' for agent '{}'", job.job_id, job.agent_id);

    job::ensure_category(&job, CATEGORY_ID).map_err(to_enclave_error)?;
    job::ensure_timely(&job).map_err(to_enclave_error)?;
    job::validate_output_schema(&job).map_err(to_enclave_error)?;

    Ok(Json(ValidateResponse { valid: true, job_id: job.job_id }))
}

pub async fn process_data(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProcessDataRequest<JobEnvelope>>,
) -> Result<Json<ProcessedDataResponse<IntentMessage<ScoreResult>>>, EnclaveError> {
    let job = request.payload;
    info!(
        "received job '{}' for agent '{}' in category '{}'",
        job.job_id, job.agent_id, job.category_id
    );

    // This enclave only scores the category it was built for.
    job::ensure_category(&job, CATEGORY_ID).map_err(to_enclave_error)?;

    // The delivery has to land inside the job lifetime, otherwise it is stale.
    job::ensure_timely(&job).map_err(to_enclave_error)?;

    // The agent output must carry every field the template promised.
    job::validate_output_schema(&job).map_err(to_enclave_error)?;

    // The price is read for the moment the job is meant to resolve, not for
    // whenever this call happens, so the score is well defined.
    let resolve_at_ms = job::resolution_time_ms(&job).map_err(to_enclave_error)?;
    let timestamp_ms = now_unix_ms()?;
    if resolve_at_ms > timestamp_ms {
        warn!("job '{}' resolves at {}ms but now is {}ms", job.job_id, resolve_at_ms, timestamp_ms);
        return Err(EnclaveError::GenericError(format!(
            "job is not resolvable yet, resolves at {resolve_at_ms}ms but now is {timestamp_ms}ms"
        )));
    }

    let price = oracle::fetch_price_usd(BTC_USD_FEED_ID, resolve_at_ms / 1000)
        .await
        .map_err(|e| EnclaveError::GenericError(format!("oracle fetch failed: {e}")))?;
    info!("resolved BTC price {} USD for job '{}'", price, job.job_id);

    let finalized_result = serde_json::json!({ "price": price });
    let score = score_job(&job, &finalized_result)?;
    info!("job '{}' scored {}", job.job_id, score);

    let agent_id = job::parse_sui_address(&job.agent_id).map_err(to_enclave_error)?;

    let result = ScoreResult {
        agent_id: SuiAddress::new(agent_id),
        category_id: job.category_id.clone(),
        job_id: job.job_id.clone(),
        score,
        finalized_price: price,
    };

    info!("signing score for job '{}' at timestamp {}", job.job_id, timestamp_ms);

    Ok(Json(to_signed_response(
        &state.eph_kp,
        result,
        timestamp_ms,
        IntentScope::Score as u8,
    )))
}

// To look up the right scorer for the job and run it against the resolved
// ground truth. Kept separate from the network fetch so it can be tested
// without hitting the oracle.
fn score_job(job: &JobEnvelope, finalized_result: &serde_json::Value) -> Result<u8, EnclaveError> {
    let registry = build_registry();
    let scorer = registry.get(&job.category_id).ok_or_else(|| {
        warn!("no scorer registered for category '{}'", job.category_id);
        EnclaveError::GenericError(format!("no scorer for category '{}'", job.category_id))
    })?;
    scorer
        .score(job, finalized_result)
        .map_err(|e| EnclaveError::GenericError(format!("scoring failed: {e}")))
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

#[cfg(test)]
mod test {
    use super::*;
    use serde_json::json;

    fn sample_job() -> JobEnvelope {
        let body = json!({
            "agent_id": "0x".to_string() + &"ab".repeat(32),
            "category_id": "btc-price-guess",
            "job_id": "job-1",
            "agent_result": { "minPrice": 60000, "maxPrice": 60100 },
            "job_template": {
                "output": { "minPrice": "number", "maxPrice": "number" },
                "lifetime": "5m"
            },
            "started_at_ms": 1_700_000_000_000u64,
            "delivered_at_ms": 1_700_000_060_000u64
        });
        serde_json::from_value(body).unwrap()
    }

    #[test]
    fn scores_a_contained_price_as_perfect() {
        let job = sample_job();
        assert_eq!(score_job(&job, &json!({ "price": 60050 })).unwrap(), 100);
    }

    #[test]
    fn scores_a_far_price_as_zero() {
        let job = sample_job();
        assert_eq!(score_job(&job, &json!({ "price": 70000 })).unwrap(), 0);
    }
}
