// Copyright (c), Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

use anyhow::Result;
use axum::{routing::get, routing::post, Router};
use fastcrypto::{ed25519::Ed25519KeyPair, traits::KeyPair};
use nautilus_server::common::{get_attestation, health_check};
// Both engines expose process_data / validate_input through `app` (finance dispatches by
// category_id; prediction matches on the polymarket-* categories). Only the finance engine has the
// delivery-price /start_data step — prediction resolves everything itself at scoring time.
use nautilus_server::app::{process_data, validate_input};
#[cfg(feature = "finance")]
use nautilus_server::app::start_data;
use nautilus_server::AppState;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    // Turn on logging. Defaults to info, override with RUST_LOG (for example
    // RUST_LOG=debug) when you need more detail.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    info!("starting quadra evaluation enclave");

    let eph_kp = Ed25519KeyPair::generate(&mut rand::thread_rng());

    let state = Arc::new(AppState { eph_kp });

    // Define your own restricted CORS policy here if needed.
    let cors = CorsLayer::new().allow_methods(Any).allow_headers(Any);

    let router = Router::new()
        .route("/", get(ping))
        .route("/get_attestation", get(get_attestation))
        .route("/process_data", post(process_data))
        .route("/validate", post(validate_input))
        .route("/health_check", get(health_check));

    // The /start_data (delivery price snapshot) step exists only on the finance engine's score
    // categories; the prediction engine resolves everything itself, so it has no /start_data route.
    #[cfg(feature = "finance")]
    let router = router.route("/start_data", post(start_data));

    let app = router.with_state(state).layer(cors);

    // Bind 0.0.0.0:3000 by default; PORT lets the finance and prediction engines run side by side
    // locally, each mapped to its own URL in the eval-engines registry / EVAL_ENGINES.
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    info!("listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app.into_make_service())
        .await
        .map_err(|e| anyhow::anyhow!("Server error: {e}"))
}

async fn ping() -> &'static str {
    "Pong!"
}
