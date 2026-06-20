// Copyright (c), Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::Json;
use fastcrypto::ed25519::Ed25519KeyPair;
use serde_json::json;
use std::fmt;

// One combined binary serves every category. Both sub-engines are compiled in: `finance`
// (apps/finance — the score categories + portfolio-roi behind a category dispatcher) and
// `prediction` (apps/polymarket — the polymarket-* categories). Each exposes Value-based
// process_data / validate_input handlers; the top-level `app` dispatcher routes by category_id.
mod apps {
    #[path = "finance/mod.rs"]
    pub mod finance;
    // Module name stays `prediction`; its code lives in apps/polymarket/.
    #[path = "polymarket/mod.rs"]
    pub mod prediction;
}

// The combined engine's HTTP handlers: a thin category dispatcher over both sub-engines.
pub mod app;

pub mod common;

// The shared job envelope plus the finance machinery (Pyth oracle, asset map, scoring registry)
// are always compiled now; the prediction side brings its own Polymarket client.
pub mod asset;
pub mod job;
pub mod oracle;
pub mod scoring;

/// App state, at minimum needs to maintain the ephemeral keypair.
pub struct AppState {
    /// Ephemeral keypair on boot
    pub eph_kp: Ed25519KeyPair,
}

/// Implement IntoResponse for EnclaveError.
impl IntoResponse for EnclaveError {
    fn into_response(self) -> Response {
        let (status, error_message) = match self {
            EnclaveError::GenericError(e) => (StatusCode::BAD_REQUEST, e),
        };
        let body = Json(json!({
            "error": error_message,
        }));
        (status, body).into_response()
    }
}

/// Enclave errors enum.
#[derive(Debug)]
pub enum EnclaveError {
    GenericError(String),
}

impl fmt::Display for EnclaveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EnclaveError::GenericError(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for EnclaveError {}
