// Copyright (c), Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::Json;
use fastcrypto::ed25519::Ed25519KeyPair;
use serde_json::json;
use std::fmt;

mod apps {
    #[cfg(feature = "price-range-guess")]
    #[path = "price-range-guess/mod.rs"]
    pub mod price_range_guess;
    #[cfg(feature = "up-down-guess")]
    #[path = "up-down-guess/mod.rs"]
    pub mod up_down_guess;
    #[cfg(feature = "movement-percentage-guess")]
    #[path = "movement-percentage-guess/mod.rs"]
    pub mod movement_percentage_guess;
    #[cfg(feature = "portfolio-roi")]
    #[path = "portfolio-roi/mod.rs"]
    pub mod portfolio_roi;
    #[cfg(feature = "polymarket")]
    #[path = "polymarket/mod.rs"]
    pub mod polymarket;
}

// The active enclave's evaluator (exactly one feature is enabled per build).
pub mod app {
    #[cfg(feature = "price-range-guess")]
    pub use crate::apps::price_range_guess::*;
    #[cfg(feature = "up-down-guess")]
    pub use crate::apps::up_down_guess::*;
    #[cfg(feature = "movement-percentage-guess")]
    pub use crate::apps::movement_percentage_guess::*;
    #[cfg(feature = "portfolio-roi")]
    pub use crate::apps::portfolio_roi::*;
    #[cfg(feature = "polymarket")]
    pub use crate::apps::polymarket::*;
}

pub mod common;

// Low-level modules shared by the finance evaluators AND the portfolio-roi enclave: the job
// model, ground truth oracle, and curated asset->feed map. The polymarket enclave reuses the job
// model only (it has its own Polymarket client, not the Pyth oracle / asset map).
#[cfg(any(feature = "finance", feature = "portfolio-roi"))]
pub mod asset;
#[cfg(any(feature = "finance", feature = "portfolio-roi", feature = "polymarket"))]
pub mod job;
#[cfg(any(feature = "finance", feature = "portfolio-roi"))]
pub mod oracle;

// The u8-score machinery (scoring registry + shared HTTP handlers) is finance-only. portfolio-roi
// returns a signed ROI metric instead and provides its own handlers (apps/portfolio-roi).
#[cfg(feature = "finance")]
pub mod endpoints;
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
