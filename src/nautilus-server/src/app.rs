// Top-level category dispatcher for the single combined evaluation engine.
//
// One binary now serves every category. Both sub-engines (apps::finance and apps::prediction)
// expose Value-based validate_input / process_data handlers that peek the body themselves; this
// module only decides WHICH sub-engine owns the incoming category and forwards the raw body to it.
//
// Routing the raw serde_json::Value (rather than a typed body) is required because the finance
// score body is a bare JobEnvelope while PortfolioJob and PredictionJob both `#[serde(flatten)]`
// it, so the category peek MUST happen before any typed deserialization. Reaching each sub-engine
// by full path (never a glob `use`) is also what lets apps::finance and apps::prediction keep their
// identically-named handlers without colliding.

use crate::apps::{finance, prediction};
use crate::AppState;
use crate::EnclaveError;
use axum::{extract::State, Json};
use serde_json::Value;
use std::sync::Arc;

// The delivery-price step belongs to finance's score categories; prediction never calls it. It is
// asset-keyed (not category-keyed), so the combined engine exposes finance's handler unchanged.
pub use crate::apps::finance::start_data;

// Pull payload.category_id out of the untyped body so we can pick the owning sub-engine before any
// typed deserialization.
fn category_of(raw: &Value) -> Result<String, EnclaveError> {
    raw.get("payload")
        .and_then(|p| p.get("category_id"))
        .and_then(|c| c.as_str())
        .map(str::to_string)
        .ok_or_else(|| EnclaveError::GenericError("missing payload.category_id".to_string()))
}

fn is_prediction(category: &str) -> bool {
    prediction::PREDICTION_CATEGORIES.contains(&category)
}

// --- POST /validate ---------------------------------------------------------
pub async fn validate_input(Json(raw): Json<Value>) -> Result<Json<Value>, EnclaveError> {
    let category = category_of(&raw)?;
    if is_prediction(&category) {
        prediction::validate_input(Json(raw)).await
    } else {
        // The finance dispatcher serves its score categories + portfolio-roi and rejects anything
        // else, so an unknown category surfaces a clean 400 from there.
        finance::validate_input(Json(raw)).await
    }
}

// --- POST /process_data -----------------------------------------------------
pub async fn process_data(
    State(state): State<Arc<AppState>>,
    Json(raw): Json<Value>,
) -> Result<Json<Value>, EnclaveError> {
    let category = category_of(&raw)?;
    if is_prediction(&category) {
        prediction::process_data(State(state), Json(raw)).await
    } else {
        finance::process_data(State(state), Json(raw)).await
    }
}
