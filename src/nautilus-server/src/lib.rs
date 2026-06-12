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
    #[cfg(feature = "btc-price-guess")]
    #[path = "btc-price-guess/mod.rs"]
    pub mod btc_price_guess;
}

pub mod app {
    #[cfg(feature = "btc-price-guess")]
    pub use crate::apps::btc_price_guess::*;
}

pub mod common;

// Shared job model, scoring engine, and ground truth oracle, used by category
// apps like btc-price-guess.
#[cfg(feature = "btc-price-guess")]
pub mod job;
#[cfg(feature = "btc-price-guess")]
pub mod oracle;
#[cfg(feature = "btc-price-guess")]
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
