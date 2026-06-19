// Copyright (c), Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::Json;
use fastcrypto::ed25519::Ed25519KeyPair;
use serde_json::json;
use std::fmt;

// Exactly one engine feature is enabled per build: `finance` (apps/finance — score categories +
// portfolio-roi behind a category dispatcher) or `prediction` (apps/polymarket — the polymarket-*
// categories). Each exposes process_data / validate_input (and finance also start_data).
mod apps {
    #[cfg(feature = "finance")]
    #[path = "finance/mod.rs"]
    pub mod finance;
    #[cfg(feature = "prediction")]
    #[path = "polymarket/mod.rs"]
    pub mod prediction;
}

// The active engine's handlers (exactly one feature is enabled per build).
pub mod app {
    #[cfg(feature = "finance")]
    pub use crate::apps::finance::*;
    #[cfg(feature = "prediction")]
    pub use crate::apps::prediction::*;
}

pub mod common;

// The shared job envelope is used by both engines. The Pyth oracle, asset map, and scoring
// registry are finance-only (the prediction engine has its own Polymarket client).
#[cfg(any(feature = "finance", feature = "prediction"))]
pub mod job;
#[cfg(feature = "finance")]
pub mod asset;
#[cfg(feature = "finance")]
pub mod oracle;
#[cfg(feature = "finance")]
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
