// Shared HTTP handlers for every finance evaluator enclave. Each enclave is built
// for exactly one evaluator (one Cargo feature) which fixes `app::CATEGORY_ID` and
// `app::build_registry`; these handlers are otherwise identical:
//
//   POST /validate     input checks only (category, timeliness, output schema) -> {valid}
//   POST /start_data   the asset's price "at_ms" (delivery) -> {start_data:{start_price}}
//   POST /process_data full pipeline at resolution: resolve end price, score against
//                      the delivered start_price, sign the score.

use crate::app::{build_registry, IntentScope, CATEGORY_ID};
use crate::asset;
use crate::common::{to_signed_response, IntentMessage, ProcessDataRequest, ProcessedDataResponse};
use crate::job::{self, JobEnvelope};
use crate::oracle;
use crate::scoring::{ScoreResult, SuiAddress};
use crate::AppState;
use crate::EnclaveError;
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tracing::{info, warn};

// --- /validate -------------------------------------------------------------

#[derive(Serialize)]
pub struct ValidateResponse {
    pub valid: bool,
    pub job_id: String,
}

// Input validation only (no oracle, no scoring). The scheduler's validator engine
// calls this so the intake engine can release payment before scoring.
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

// --- /start_data -----------------------------------------------------------

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

pub async fn start_data(
    Json(request): Json<ProcessDataRequest<StartDataRequest>>,
) -> Result<Json<StartDataResponse>, EnclaveError> {
    let req = request.payload;
    let feed = asset::feed_id(&req.asset)
        .ok_or_else(|| EnclaveError::GenericError(format!("unsupported asset '{}'", req.asset)))?;
    let price = oracle::fetch_price_scaled(feed, req.at_ms / 1000)
        .await
        .map_err(|e| EnclaveError::GenericError(format!("oracle fetch failed: {e}")))?;
    info!("start price for {} at {}ms is {} (1e-8 units)", req.asset, req.at_ms, price);
    Ok(Json(StartDataResponse { start_data: serde_json::json!({ "start_price": price }) }))
}

// --- /process_data ---------------------------------------------------------

pub async fn process_data(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProcessDataRequest<JobEnvelope>>,
) -> Result<Json<ProcessedDataResponse<IntentMessage<ScoreResult>>>, EnclaveError> {
    let job = request.payload;
    info!("scoring job '{}' (asset {}) in '{}'", job.job_id, job.asset, job.category_id);

    job::ensure_category(&job, CATEGORY_ID).map_err(to_enclave_error)?;
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

    Ok(Json(to_signed_response(&state.eph_kp, result, timestamp_ms, IntentScope::Score as u8)))
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
