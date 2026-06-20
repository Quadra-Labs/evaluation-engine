# Quadra evaluation engine

Quadra scores every job inside a single Sui Nautilus enclave, which is a secure box on AWS
Nitro. One enclave image serves every evaluator category and dispatches each job by its
`category_id`. Keeping all the scoring code, the outbound network allow list, and the PCR
measurements in one image means there is one engine to deploy, one enclave identity to register
on-chain, and one URL the scheduler and competition engine route to.

The categories fall into two families.

The finance evaluators (all `category: finance`) predict a curated asset's price:

| evaluator_id                 | agent output                       | scoring |
| ---------------------------- | ---------------------------------- | --- |
| `price-range-guess`          | `{ minPrice, maxPrice }`           | end price in band -> 100, else decay vs a **start-price-relative, sqrt(lifetime)-scaled** tolerance |
| `up-down-guess`              | `{ isUp, confidence in [0.5,1] }`  | Brier `(p_up - outcome)^2` mapped to [0,100] |
| `movement-percentage-guess`  | `{ percentage }`                   | gentle decay of `|guess - actual%|` (no cliff) |
| `portfolio-roi`              | `{ trades }`                       | a `u64` ROI **metric** (not a [0,100] score), recorded as performance |

The first three predict a curated asset (BTC, ETH, SOL, SUI for now -- see `src/asset.rs`). The
price at **delivery** (start_price) is captured via `/start_data` and scored against the price at
**resolution** (`started_at + lifetime`). Prices are 1e-8 fixed-point integers so cheap assets and
percentage math stay precise and integer-only. `portfolio-roi` is a PERFORMANCE evaluator: it signs
a `u64` ROI metric with a distinct intent scope, so it can never be replayed as a `[0,100]` score.

The prediction evaluators resolve ground truth from Polymarket's Gamma and CLOB APIs (not Pyth) and
read `market_id`, `event_id`, and `target_ts` from the job `params`:

| evaluator_id            | agent output                  | scoring |
| ----------------------- | ----------------------------- | --- |
| `polymarket-resolution` | `{ outcome }`                 | 100 if `outcome` matches the market's resolved winner, else 0 |
| `polymarket-event`      | `{ guesses }` (JSON array)    | coverage-weighted: correct guesses over the event's total markets, mapped to [0,100] |
| `polymarket-price`      | `{ probability }` in [0,1]    | Brier closeness of `probability` to the real CLOB YES price at `target_ts` |

## How the engine is laid out

Everything compiles into one binary; a top-level dispatcher routes by `category_id`:

```
src/nautilus-server/
  Cargo.toml                         # one no-op `evaluation` feature (default); selects nothing
  src/
    main.rs                          # axum router: /validate /process_data /start_data /health_check
    app.rs                           # top-level dispatcher: peek category_id -> finance or prediction
    common.rs                        # shared IntentMessage, signing, attestation, health check
    job.rs                           # shared job envelope + validation
    asset.rs                         # curated asset -> Pyth feed-id map (finance)
    oracle.rs                        # Pyth Hermes fetch, fixed-point (1e-8) prices (finance)
    scoring/                         # Scorer trait + the three finance score scorers
      mod.rs price_range.rs up_down.rs movement_pct.rs
    apps/
      finance/                       # finance sub-engine: dispatches score categories + portfolio-roi
        mod.rs score.rs portfolio.rs roi.rs
      polymarket/                    # prediction sub-engine: the three polymarket-* categories
        mod.rs score.rs client.rs
      evaluation/
        allowed_endpoints.yaml       # the one outbound allow list (Pyth + Polymarket hosts)
```

`app.rs` peeks `payload.category_id` on the untyped body and forwards the request to the finance or
prediction sub-engine. Both sub-engines expose Value-based `validate_input` / `process_data`
handlers and re-deserialize the body into their own typed job (the peek must come first, because
`PortfolioJob` and `PredictionJob` both flatten the job envelope). Each sub-engine still rejects any
category outside its set as a backstop.

## The job in, the score out

A job is POSTed to `/process_data` wrapped in `{ "payload": { ... } }`. A finance score job:

```json
{
  "payload": {
    "agent_id": "0xab...ab",
    "category_id": "price-range-guess",
    "job_id": "job-1",
    "asset": "BTC",
    "agent_result":     { "minPrice": 60000, "maxPrice": 60100 },
    "job_template":     { "output": { "minPrice": "number", "maxPrice": "number" }, "lifetime": "5m" },
    "start_data":       { "start_price": 6000000000000 },
    "started_at_ms":    1700000000000,
    "delivered_at_ms":  1700000060000
  }
}
```

`asset` selects the price feed; `start_data.start_price` is the 1e-8 fixed-point price captured at
delivery (from `/start_data`). Both are added by the scheduler. A polymarket job carries no `asset`
and no `start_data`; instead it has `params` (the fixed competition values the evaluator resolves
against Polymarket) and an informational `window`.

Notes:

- There is no `finalized_result` in the request. The engine resolves the real value itself (from
  Pyth for finance, from Polymarket for prediction), so the caller can not forge it.
- `agent_result` is free-form JSON. Only the category's scorer knows how to read it.
- `agent_id` is a `0x` Sui address (32 bytes), signed back as raw bytes so it lines up with a Move
  `address` on the verifier.
- Timestamps are epoch milliseconds, not ISO strings. This keeps the enclave free of a date parsing
  dependency and the build deterministic.

The enclave validates the job, scores it, and signs the result:

```json
{
  "response": {
    "intent": 0,
    "timestamp_ms": 1700000061000,
    "data": { "agent_id": [171, "..."], "category_id": "price-range-guess", "job_id": "job-1", "score": 100, "finalized_price": 6050000000000 }
  },
  "signature": "<hex ed25519 over bcs(IntentMessage{intent, timestamp_ms, data})>"
}
```

`intent` is `0` for a score and `1` for the `portfolio-roi` metric. The signed BCS layout is the
contract the on-chain verifier depends on, so it does not change.

## Validation order

1. `ensure_category` rejects any job whose `category_id` the engine does not serve.
2. `ensure_timely` rejects deliveries that landed after `started_at_ms` plus the template
   `lifetime`.
3. `validate_output_schema` rejects an `agent_result` that does not carry every field the template
   promised, with the right JSON type.
4. The engine resolves the ground truth (Pyth at the resolution time for finance; Polymarket for
   prediction), rejecting the job if that value is not available yet.
5. The scorer reads `agent_result` plus the resolved ground truth and returns the score.

## Two purposes: validate, then score

The engine serves both halves of a job's life:

- **`POST /validate`** -- input validation only (steps 1-3; no oracle, no scoring). Same
  `{ "payload": { ... } }` body as `/process_data`. Returns `{ "valid": true, "job_id": ... }`, or a
  400 with the rejection reason. The scheduler's validator calls this when an agent claims delivery,
  so intake can release payment without reading the sealed result. The response is unsigned:
  validation only gates payment, scores are the signed, verifiable artifact.
- **`POST /process_data`** -- the full pipeline (steps 1-5) at lifetime end, called by the scheduler
  engine; returns the enclave-signed score or metric.
- **`POST /start_data`** -- the delivery-price snapshot for the finance score categories
  (asset-keyed). `portfolio-roi` and the polymarket categories do not use it.

## Adding a new category

1. Finance score category: add the scorer in `src/scoring/<id>.rs` (implement the `Scorer` trait,
   set its `category_id`), register it in `apps/finance/mod.rs::build_registry()`, add the id to
   `SCORE_CATEGORIES`, and make sure every asset it needs is in `src/asset.rs`.
2. Prediction category: add the constant + a `score_*` function in `apps/polymarket/`, add the id to
   `PREDICTION_CATEGORIES`, and dispatch it in `process`.
3. If the category needs a new outbound host, add it to `apps/evaluation/allowed_endpoints.yaml`.
4. Register the new `evaluator_id` in the Walrus `eval_engines` catalog pointing at this one engine
   URL (see below).

## Build, run, test

One engine, one build. The `evaluation` feature is the default and is a no-op label kept only so the
deterministic enclave build command keeps a stable shape.

Local development (runs anywhere, no AWS, fresh key per boot):

```bash
cd src/nautilus-server
RUST_LOG=info cargo run                 # serves all categories on :3000 (PORT overrides)
cargo test
```

Enclave image and PCRs (needs an AWS Nitro capable host):

```bash
make ENCLAVE_APP=evaluation             # builds out/nitro.eif + out/nitro.pcrs
cat out/nitro.pcrs                       # PCR0/1/2 for this engine build
make run-debug                           # debug build, all-zero PCRs, for development only
```

`configure_enclave.sh evaluation` reads `src/nautilus-server/src/apps/evaluation/allowed_endpoints.yaml`
and wires the vsock-proxy forwarders for Pyth Hermes and the two Polymarket hosts.

## Register the engine

There is one engine URL. Register every `evaluator_id` it serves to that same URL in the Walrus
`eval_engines` catalog, from the `data/` package, after the gateway is running:

```bash
cd ../data
for id in price-range-guess up-down-guess movement-percentage-guess portfolio-roi \
          polymarket-resolution polymarket-event polymarket-price; do
  EVALUATOR_ID=$id \
  ENCLAVE_URL=http://host:port \
  ENCLAVE_OBJECT_ID=0x... \   # optional in local dev
  npm run register-eval-engine
done
```

Do **not** add the URL to `.env` -- the scheduler and competition engine load the catalog
dynamically and refresh when the pointer advances.
