// Quadra FINANCE evaluation engine: ONE binary that serves every finance-class category.
//
// Built with `--no-default-features --features finance`. It serves the three u8-SCORE "guess"
// categories (price-range-guess, up-down-guess, movement-percentage-guess) via the shared scoring
// registry (IntentScope::Score=0, with a delivery-price /start_data step) AND the u64-METRIC
// portfolio-roi category (IntentScope::Metric=1, its own pipeline, no /start_data). These have
// DIFFERENT request bodies (JobEnvelope vs PortfolioJob), response types (ScoreResult vs
// MetricResult), and intent scopes, so `/validate` and `/process_data` here are DISPATCHERS:
// peek `payload.category_id`, then re-deserialize into the right typed body and run the right
// pipeline, serializing the signed response to a uniform JSON value. The category peek MUST come
// first: PortfolioJob flattens JobEnvelope, so a portfolio body would also parse as a bare
// envelope. Each engine rejects categories outside its set (category isolation).

mod portfolio;
mod roi;
mod score;

use crate::common::ProcessDataRequest;
use crate::job::JobEnvelope;
use crate::AppState;
use crate::EnclaveError;
use axum::{extract::State, Json};
use serde_json::Value;
use serde_repr::{Deserialize_repr, Serialize_repr};
use std::sync::Arc;

// The three u8-score categories this engine serves (their ids live next to their scorers).
pub const SCORE_CATEGORIES: &[&str] = &[
    crate::scoring::price_range::CATEGORY_ID,
    crate::scoring::up_down::CATEGORY_ID,
    crate::scoring::movement_pct::CATEGORY_ID,
];
// The u64-metric category this engine serves.
pub const CAT_PORTFOLIO: &str = "portfolio-roi";

// Two distinct intent scopes in one engine: a score signature (0) and a metric signature (1) can
// never be replayed as each other. Each pipeline signs with its own scope.
#[derive(Serialize_repr, Deserialize_repr, Debug)]
#[repr(u8)]
pub enum IntentScope {
    Score = 0,
    Metric = 1,
}

// The merged score registry: all three score scorers at once. `registry.get(&job.category_id)`
// then selects the right one for the job.
pub fn build_registry() -> crate::scoring::ScorerRegistry {
    let mut registry = crate::scoring::ScorerRegistry::new();
    registry.register(Box::new(crate::scoring::price_range::PriceRangeScorer));
    registry.register(Box::new(crate::scoring::up_down::UpDownScorer));
    registry.register(Box::new(crate::scoring::movement_pct::MovementPctScorer));
    registry
}

// Pull payload.category_id out of an untyped request body so we can pick the typed pipeline
// BEFORE deserializing (the typed bodies overlap via serde flatten).
fn category_of(raw: &Value) -> Result<String, EnclaveError> {
    raw.get("payload")
        .and_then(|p| p.get("category_id"))
        .and_then(|c| c.as_str())
        .map(str::to_string)
        .ok_or_else(|| EnclaveError::GenericError("missing payload.category_id".to_string()))
}

fn reject_unknown(category: &str) -> EnclaveError {
    EnclaveError::GenericError(format!(
        "this finance engine only serves {SCORE_CATEGORIES:?} and '{CAT_PORTFOLIO}', got '{category}'"
    ))
}

fn de_err(e: serde_json::Error) -> EnclaveError {
    EnclaveError::GenericError(format!("invalid request body for category: {e}"))
}

fn ser_err(e: serde_json::Error) -> EnclaveError {
    EnclaveError::GenericError(format!("failed to serialize response: {e}"))
}

// --- POST /validate ---------------------------------------------------------
pub async fn validate_input(Json(raw): Json<Value>) -> Result<Json<Value>, EnclaveError> {
    let category = category_of(&raw)?;
    if SCORE_CATEGORIES.contains(&category.as_str()) {
        let req: ProcessDataRequest<JobEnvelope> = serde_json::from_value(raw).map_err(de_err)?;
        let resp = score::validate(req.payload).await?;
        Ok(Json(serde_json::to_value(resp).map_err(ser_err)?))
    } else if category == CAT_PORTFOLIO {
        let req: ProcessDataRequest<portfolio::PortfolioJob> =
            serde_json::from_value(raw).map_err(de_err)?;
        let resp = portfolio::validate(req.payload).await?;
        Ok(Json(serde_json::to_value(resp).map_err(ser_err)?))
    } else {
        Err(reject_unknown(&category))
    }
}

// --- POST /process_data -----------------------------------------------------
pub async fn process_data(
    State(state): State<Arc<AppState>>,
    Json(raw): Json<Value>,
) -> Result<Json<Value>, EnclaveError> {
    let category = category_of(&raw)?;
    if SCORE_CATEGORIES.contains(&category.as_str()) {
        let req: ProcessDataRequest<JobEnvelope> = serde_json::from_value(raw).map_err(de_err)?;
        let signed = score::process(&state.eph_kp, req.payload).await?;
        Ok(Json(serde_json::to_value(signed).map_err(ser_err)?))
    } else if category == CAT_PORTFOLIO {
        let req: ProcessDataRequest<portfolio::PortfolioJob> =
            serde_json::from_value(raw).map_err(de_err)?;
        let signed = portfolio::process(&state.eph_kp, req.payload).await?;
        Ok(Json(serde_json::to_value(signed).map_err(ser_err)?))
    } else {
        Err(reject_unknown(&category))
    }
}

// --- POST /start_data (score categories only) -------------------------------
// Asset-keyed (not category-keyed); portfolio-roi has no start_data step.
pub async fn start_data(
    Json(request): Json<ProcessDataRequest<score::StartDataRequest>>,
) -> Result<Json<score::StartDataResponse>, EnclaveError> {
    let resp = score::start_data(request.payload).await?;
    Ok(Json(resp))
}
