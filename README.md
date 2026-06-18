# Quadra evaluation engines

Quadra runs each job evaluator in its own Sui Nautilus enclave. One enclave
serves one evaluator and nothing else. That keeps every evaluator's scoring code,
its outbound network allow list, and its PCR measurements fully isolated from
the others.

The finance evaluators (all `category: finance`) are:

| evaluator_id                 | agent output                       | scoring |
| ---------------------------- | ---------------------------------- | --- |
| `price-range-guess`          | `{ minPrice, maxPrice }`           | end price in band → 100, else decay vs a **start-price-relative, √lifetime-scaled** tolerance |
| `up-down-guess`              | `{ isUp, confidence∈[0.5,1] }`     | Brier `(p_up − outcome)²` mapped to [0,100] |
| `movement-percentage-guess`  | `{ percentage }`                   | gentle decay of `|guess − actual%|` (no cliff) |

All three predict a curated asset's price (BTC, ETH, SOL, SUI for now — see
`src/asset.rs`). The price at **delivery** (start_price) is captured via
`/start_data` and scored against the price at **resolution** (`started_at +
lifetime`). Prices are 1e-8 fixed-point integers so cheap assets and percentage
math stay precise and integer-only.

## How an evaluator maps to the enclave

Each evaluator is one Cargo feature plus one app directory; everything else is
shared (gated behind the `finance` feature the evaluators enable):

```
src/nautilus-server/
  Cargo.toml                         # one [features] entry per evaluator (+ `finance`)
  src/
    asset.rs                         # curated asset -> Pyth feed-id map
    job.rs                           # shared job envelope + validation
    oracle.rs                        # Pyth Hermes fetch, fixed-point (1e-8) prices
    endpoints.rs                     # shared /validate, /start_data, /process_data
    scoring/
      mod.rs                         # Scorer trait, ScorerRegistry, ScoreResult
      price_range.rs up_down.rs movement_pct.rs
    apps/
      price-range-guess/             # mod.rs (CATEGORY_ID + build_registry) + allowed_endpoints.yaml
      up-down-guess/
      movement-percentage-guess/
```

The active evaluator is chosen at build time by its feature flag
(`--no-default-features --features <evaluator_id>`). Exactly one is enabled per
build, so each enclave image contains a single evaluator.

## The job in, the score out

A job is POSTed to `/process_data` wrapped in `{ "payload": { ... } }`:

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

`asset` selects the price feed; `start_data.start_price` is the 1e-8 fixed-point
price captured at delivery (from `/start_data`). Both are added by the scheduler.

Notes:

- There is no `finalized_result` in the request. The engine resolves the real
  value itself from its oracle (see `oracle.rs`), so the caller can not forge it.
- `agent_result` is free-form JSON. Only the category's scorer knows how to read
  it.
- `agent_id` is a `0x` Sui address (32 bytes). It is signed back as raw bytes so
  it lines up with a Move `address` on the verifier.
- Timestamps are epoch milliseconds, not ISO strings. This keeps the enclave
  free of a date parsing dependency and the build deterministic.
- The resolution moment is `started_at_ms + lifetime`. The engine reads the
  price at that exact time, so the score does not depend on when it is called.
  A job is rejected if that moment is still in the future.

The enclave validates the job, scores it in `[0, 100]`, and signs the result:

```json
{
  "response": {
    "intent": 0,
    "timestamp_ms": 1700000061000,
    "data": { "agent_id": [171, ...], "category_id": "price-range-guess", "job_id": "job-1", "score": 100 }
  },
  "signature": "<hex ed25519 over bcs(IntentMessage{intent, timestamp_ms, data})>"
}
```

## Validation order

1. `ensure_category` rejects any job whose `category_id` is not the one this
   enclave was built for.
2. `ensure_timely` rejects deliveries that landed after `started_at_ms` plus the
   template `lifetime`.
3. `validate_output_schema` rejects an `agent_result` that does not carry every
   field the template promised, with the right JSON type.
4. The engine resolves the ground truth from its oracle at the job resolution
   time, rejecting the job if that time has not arrived yet.
5. The scorer reads `agent_result` plus the resolved ground truth and returns
   the score.

## Two purposes: validate, then score

Each engine serves both halves of a job's life:

- **`POST /validate`** — input validation only (steps 1–3 above; no oracle, no
  scoring). Same `{ "payload": { ... } }` body as `/process_data`. Returns
  `{ "valid": true, "job_id": ... }`, or a 400 with the rejection reason. The
  scheduler's **validator engine** calls this when an agent claims delivery, so
  the intake engine can release payment without reading the sealed result. The
  response is unsigned: validation only gates payment, scores are the signed,
  verifiable artifact.
- **`POST /process_data`** — the full pipeline (steps 1–5) at lifetime end,
  called by the **scheduler engine**; returns the enclave-signed score.

## Adding a new evaluator

1. Add a feature in `src/nautilus-server/Cargo.toml` that enables the shared
   `finance` machinery:

```toml
[features]
my-evaluator = ["finance"]
```

2. Add the scorer in `src/nautilus-server/src/scoring/my_evaluator.rs` and a
   `pub mod my_evaluator;` line in `scoring/mod.rs`. Implement the `Scorer` trait
   (its `score` gets `start_price` + `end_price` in 1e-8 units) and set its
   `category_id`.

3. Add the app in `src/nautilus-server/src/apps/my-evaluator/mod.rs` (just
   `CATEGORY_ID`, `IntentScope`, and `build_registry` — the handlers are shared
   in `endpoints.rs`) plus an `allowed_endpoints.yaml`. Wire it into `lib.rs`
   under `#[cfg(feature = "my-evaluator")]`.

4. Make sure every asset the evaluator needs is in `src/asset.rs` (symbol → Pyth
   feed id). The shared oracle resolves prices; the scorer only does the math.

5. Register the enclave's HTTP URL in the Walrus `eval_engines` catalog (from the
   `data/` package, after the gateway is running):

```bash
cd ../data
EVALUATOR_ID=my-evaluator \
ENCLAVE_URL=http://host:port \
ENCLAVE_OBJECT_ID=0x... \   # optional in local dev
npm run register-eval-engine
```

Do **not** add the URL to `.env` — the scheduler and competition engine load the
catalog dynamically and refresh when the pointer advances.

## Build, run, test

Local development (runs anywhere, no AWS, fresh key per boot). Pick one evaluator:

```bash
cd src/nautilus-server
RUST_LOG=info cargo run --no-default-features --features price-range-guess
cargo test --no-default-features --features price-range-guess   # (or up-down-guess / movement-percentage-guess)
```

Enclave image and PCRs (needs an AWS Nitro capable host):

```bash
make ENCLAVE_APP=price-range-guess
cat out/nitro.pcrs   # PCR0/1/2 are unique to this evaluator build
make run-debug       # debug build, all-zero PCRs, for development only
```

Because the scorer and its allow list are compiled into the image, each
evaluator produces its own PCR set. Register those PCRs and the enclave public
key onchain per evaluator when the Move verifier lands.
