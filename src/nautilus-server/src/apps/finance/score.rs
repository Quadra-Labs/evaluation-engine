// The u8-score pipeline for the finance engine's three "guess" categories (price-range,
// up-down, movement-percentage). Moved out of the old top-level endpoints.rs and split into
// inner functions (no axum wrappers) so the finance dispatcher (mod.rs) can call them after it
// has picked this branch by category_id. Each scorer lives in crate::scoring; the merged
// registry (super::build_registry) holds all three, and the job's own category_id selects one.
//
//   validate    input checks only (category in the score set, timeliness, output schema)
//   start_data  the asset's price at the delivery moment -> { start_price }
//   process     resolve the end price, score against the delivered start price, sign (Score=0)

use super::{build_registry, IntentScope, SCORE_CATEGORIES};
use crate::asset;
use crate::common::{to_signed_response, IntentMessage, ProcessedDataResponse};
use crate::job::{self, JobEnvelope};
use crate::oracle;
use crate::scoring::{ScoreResult, SuiAddress};
use crate::EnclaveError;
use fastcrypto::ed25519::Ed25519KeyPair;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};

#[derive(Serialize)]
pub struct ValidateResponse {
    pub valid: bool,
    pub job_id: String,
}

#[derive(Debug, Deserialize)]
pub struct StartDataRequest {
    pub asset: String,
    /// The delivery moment in epoch ms; the start price is read at this time.
    pub at_ms: u64,
}

#[derive(Serialize)]
pub struct StartDataResponse {
    /// e.g. `{ "start_price": <1e-8 fixed-point units> }`.
    pub start_data: Value,
}

// Input validation only (no oracle, no scoring). The job's category must be one of the score
// categories this engine serves; the matching scorer is selected later by category_id.
pub async fn validate(job: JobEnvelope) -> Result<ValidateResponse, EnclaveError> {
    info!("validating job '{}' for agent '{}'", job.job_id, job.agent_id);
    job::ensure_category_in(&job, SCORE_CATEGORIES).map_err(to_enclave_error)?;
    job::ensure_timely(&job).map_err(to_enclave_error)?;
    job::validate_output_schema(&job).map_err(to_enclave_error)?;
    Ok(ValidateResponse { valid: true, job_id: job.job_id })
}

pub async fn start_data(req: StartDataRequest) -> Result<StartDataResponse, EnclaveError> {
    let feed = asset::feed_id(&req.asset)
        .ok_or_else(|| EnclaveError::GenericError(format!("unsupported asset '{}'", req.asset)))?;
    let price = oracle::fetch_price_scaled(feed, req.at_ms / 1000)
        .await
        .map_err(|e| EnclaveError::GenericError(format!("oracle fetch failed: {e}")))?;
    info!("start price for {} at {}ms is {} (1e-8 units)", req.asset, req.at_ms, price);
    Ok(StartDataResponse { start_data: serde_json::json!({ "start_price": price }) })
}

// Full scoring pipeline at resolution: resolve the end price, score against the delivered start
// price, and sign the score (IntentScope::Score). Signs with the passed ephemeral keypair.
pub async fn process(
    kp: &Ed25519KeyPair,
    job: JobEnvelope,
) -> Result<ProcessedDataResponse<IntentMessage<ScoreResult>>, EnclaveError> {
    info!("scoring job '{}' (asset {}) in '{}'", job.job_id, job.asset, job.category_id);

    job::ensure_category_in(&job, SCORE_CATEGORIES).map_err(to_enclave_error)?;
    job::ensure_timely(&job).map_err(to_enclave_error)?;
    job::validate_output_schema(&job).map_err(to_enclave_error)?;

    // Resolve the end price at the job's resolution moment (not "now").
    let resolve_at_ms = job::resolution_time_ms(&job).map_err(to_enclave_error)?;
    let timestamp_ms = now_unix_ms()?;
    if resolve_at_ms > timestamp_ms {
        warn!("job '{}' resolves at {}ms but now is {}ms", job.job_id, resolve_at_ms, timestamp_ms);
        return Err(EnclaveError::GenericError(format!(
            "job is not resolvable yet, resolves at {resolve_at_ms}ms but now is {timestamp_ms}ms"
        )));
    }

    let feed = asset::feed_id(&job.asset)
        .ok_or_else(|| EnclaveError::GenericError(format!("unsupported asset '{}'", job.asset)))?;
    let end_price = oracle::fetch_price_scaled(feed, resolve_at_ms / 1000)
        .await
        .map_err(|e| EnclaveError::GenericError(format!("oracle fetch failed: {e}")))?;
    let start_price = start_price_from(&job.start_data)?;
    info!("job '{}': start {} end {} (1e-8 units)", job.job_id, start_price, end_price);

    let registry = build_registry();
    let scorer = registry.get(&job.category_id).ok_or_else(|| {
        EnclaveError::GenericError(format!("no scorer for category '{}'", job.category_id))
    })?;
    let score = scorer
        .score(&job, start_price, end_price)
        .map_err(|e| EnclaveError::GenericError(format!("scoring failed: {e}")))?;
    info!("job '{}' scored {}", job.job_id, score);

    let agent_id = job::parse_sui_address(&job.agent_id).map_err(to_enclave_error)?;
    let result = ScoreResult {
        agent_id: SuiAddress::new(agent_id),
        category_id: job.category_id.clone(),
        job_id: job.job_id.clone(),
        score,
        finalized_price: oracle::scaled_to_usd(end_price),
    };

    Ok(to_signed_response(kp, result, timestamp_ms, IntentScope::Score as u8))
}

// The delivered start price, read from the job envelope's start_data (1e-8 units).
fn start_price_from(start_data: &Value) -> Result<u128, EnclaveError> {
    start_data
        .get("start_price")
        .and_then(|v| v.as_u64())
        .map(u128::from)
        .ok_or_else(|| EnclaveError::GenericError("missing start_data.start_price".to_string()))
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
