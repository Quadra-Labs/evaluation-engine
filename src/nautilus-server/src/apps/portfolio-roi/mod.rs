// Quadra portfolio-roi evaluation enclave.
//
// One enclave serves the trading/performance category. An agent is given a starting portfolio
// (USD per asset) and submits rebalancing trades; after the window we price the resulting
// allocation against real Pyth prices and return a SIGNED ROI metric (PERF_BASE + roi_bps,
// floored at 0), which the competition engine records on-chain (record_performance) and the
// contract ranks. Unlike the finance "guess" evaluators this returns a u64 metric, not a u8
// score, so it has its own handlers (it does NOT use the shared scoring registry / endpoints.rs)
// while reusing the shared job/asset/oracle modules. main.rs routes here under
// `--features portfolio-roi`.

mod roi;

use crate::asset;
use crate::common::{to_signed_response, IntentMessage, ProcessDataRequest, ProcessedDataResponse};
use crate::job::{self, JobEnvelope};
use crate::oracle;
use crate::AppState;
use crate::EnclaveError;
use axum::extract::State;
use axum::Json;
use roi::{compute_metric, Trade};
use serde::{Deserialize, Serialize};
use serde_repr::{Deserialize_repr, Serialize_repr};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use tracing::{info, warn};

pub const CATEGORY_ID: &str = "portfolio-roi";

// Distinct intent scope from the score evaluators (Score = 0) so a metric signature can never be
// replayed as a score, or vice versa.
#[derive(Serialize_repr, Deserialize_repr, Debug)]
#[repr(u8)]
pub enum IntentScope {
    Metric = 1,
}

// The [start, end] window the result is priced against (epoch ms).
#[derive(Debug, Deserialize)]
pub struct Window {
    pub start_ms: u64,
    pub end_ms: u64,
}

// The portfolio job: the shared envelope plus the starting allocation, window, and allowed
// assets the competition engine supplies.
#[derive(Debug, Deserialize)]
pub struct PortfolioJob {
    #[serde(flatten)]
    pub job: JobEnvelope,
    pub portfolio_start: BTreeMap<String, u64>,
    pub window: Window,
    #[serde(default)]
    pub allowed_assets: Vec<String>,
}

// The signed payload. Field order/types MUST match the competition engine's BCS MetricResult
// (agent_id [u8;32], category_id string, job_id string, metric u64). A `[u8; 32]` serializes as
// 32 raw bytes under BCS (no length prefix) and as a JSON number array (the engine's verifier
// accepts either a hex string or a byte array).
#[derive(Debug, Serialize, Clone)]
pub struct MetricResult {
    pub agent_id: [u8; 32],
    pub category_id: String,
    pub job_id: String,
    pub metric: u64,
}

#[derive(Serialize)]
pub struct ValidateResponse {
    pub valid: bool,
    pub job_id: String,
}

// Input validation only (right category, on time, promised output shape, parseable trades).
pub async fn validate_input(
    Json(request): Json<ProcessDataRequest<PortfolioJob>>,
) -> Result<Json<ValidateResponse>, EnclaveError> {
    let pjob = request.payload;
    job::ensure_category(&pjob.job, CATEGORY_ID).map_err(to_enclave_error)?;
    job::ensure_timely(&pjob.job).map_err(to_enclave_error)?;
    job::validate_output_schema(&pjob.job).map_err(to_enclave_error)?;
    let _ = parse_trades(&pjob.job)?;
    Ok(Json(ValidateResponse { valid: true, job_id: pjob.job.job_id }))
}

pub async fn process_data(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ProcessDataRequest<PortfolioJob>>,
) -> Result<Json<ProcessedDataResponse<IntentMessage<MetricResult>>>, EnclaveError> {
    let pjob = request.payload;
    let job = &pjob.job;
    info!("portfolio job '{}' for agent '{}'", job.job_id, job.agent_id);

    job::ensure_category(job, CATEGORY_ID).map_err(to_enclave_error)?;
    job::ensure_timely(job).map_err(to_enclave_error)?;
    job::validate_output_schema(job).map_err(to_enclave_error)?;

    // Price the result at the window end, which must already be in the past.
    let timestamp_ms = now_unix_ms()?;
    if pjob.window.end_ms > timestamp_ms {
        return Err(EnclaveError::GenericError(format!(
            "window not resolvable yet, ends at {}ms but now is {}ms",
            pjob.window.end_ms, timestamp_ms
        )));
    }

    let trades = parse_trades(job)?;

    // The set of assets to price: the starting portfolio plus anything traded into/out of.
    let mut assets: BTreeSet<String> = pjob.portfolio_start.keys().cloned().collect();
    for t in &trades {
        assets.insert(t.from.clone());
        assets.insert(t.to.clone());
    }

    // Every asset must be allowed (when the competition declares a set) and priceable. Prices are
    // 1e-8 fixed-point (oracle::PRICE_SCALE); the ROI ratio is scale-invariant.
    let mut start_prices: BTreeMap<String, u128> = BTreeMap::new();
    let mut end_prices: BTreeMap<String, u128> = BTreeMap::new();
    for sym in &assets {
        if !pjob.allowed_assets.is_empty() && !pjob.allowed_assets.iter().any(|a| a == sym) {
            return Err(EnclaveError::GenericError(format!("unknown asset '{sym}' (not allowed)")));
        }
        let feed = asset::feed_id(sym)
            .ok_or_else(|| EnclaveError::GenericError(format!("unknown asset '{sym}' (no price feed)")))?;
        let sp = oracle::fetch_price_scaled(feed, pjob.window.start_ms / 1000)
            .await
            .map_err(|e| EnclaveError::GenericError(format!("oracle fetch failed: {e}")))?;
        let ep = oracle::fetch_price_scaled(feed, pjob.window.end_ms / 1000)
            .await
            .map_err(|e| EnclaveError::GenericError(format!("oracle fetch failed: {e}")))?;
        start_prices.insert(sym.clone(), sp);
        end_prices.insert(sym.clone(), ep);
    }

    let (roi_bps, metric) = compute_metric(&pjob.portfolio_start, &trades, &start_prices, &end_prices)
        .map_err(|e| EnclaveError::GenericError(e.to_string()))?;
    info!("portfolio job '{}' roi {} bps -> metric {}", job.job_id, roi_bps, metric);

    let agent_id = job::parse_sui_address(&job.agent_id).map_err(to_enclave_error)?;
    let result = MetricResult {
        agent_id,
        category_id: job.category_id.clone(),
        job_id: job.job_id.clone(),
        metric,
    };

    Ok(Json(to_signed_response(
        &state.eph_kp,
        result,
        timestamp_ms,
        IntentScope::Metric as u8,
    )))
}

// To pull the agent's trades out of agent_result.trades (a JSON-encoded array string, since the
// data-layer output schema is primitives only). A parse failure is the agent's fault.
fn parse_trades(job: &JobEnvelope) -> Result<Vec<Trade>, EnclaveError> {
    let raw = job
        .agent_result
        .get("trades")
        .and_then(|v| v.as_str())
        .ok_or_else(|| EnclaveError::GenericError("agent_result 'trades' is missing field".to_string()))?;
    serde_json::from_str::<Vec<Trade>>(raw).map_err(|e| {
        warn!("bad trades for job '{}': {}", job.job_id, e);
        EnclaveError::GenericError(format!("agent_result 'trades' is not of type JSON array: {e}"))
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
