# Quadra evaluation engines

Quadra runs each job category in its own Sui Nautilus enclave. One enclave
serves one category and nothing else. That keeps every category's scoring code,
its outbound network allow list, and its PCR measurements fully isolated from
the others.

## How a category maps to the enclave

Each category is one Cargo feature plus one app directory:

```
src/nautilus-server/
  Cargo.toml                         # one [features] entry per category
  src/
    job.rs                           # shared job envelope + validation
    oracle.rs                        # ground truth fetch (Pyth Hermes)
    scoring/
      mod.rs                         # Scorer trait, ScorerRegistry, ScoreResult
      btc_price.rs                   # the btc-price-guess scoring algorithm
    apps/
      btc-price-guess/
        mod.rs                       # process_data endpoint for this category
        allowed_endpoints.yaml       # outbound hosts this category may reach
```

The active category is chosen at build time by its feature flag. Exactly one
app feature is enabled per build, so each enclave image contains a single
category.

## The job in, the score out

A job is POSTed to `/process_data` wrapped in `{ "payload": { ... } }`:

```json
{
  "payload": {
    "agent_id": "0xab...ab",
    "category_id": "btc-price-guess",
    "job_id": "job-1",
    "agent_result":     { "minPrice": 60000, "maxPrice": 60100 },
    "job_template":     { "output": { "minPrice": "number", "maxPrice": "number" }, "lifetime": "5m" },
    "started_at_ms":    1700000000000,
    "delivered_at_ms":  1700000060000
  }
}
```

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
    "data": { "agent_id": [171, ...], "category_id": "btc-price-guess", "job_id": "job-1", "score": 100 }
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

## Adding a new category

1. Add a feature in `src/nautilus-server/Cargo.toml`:

```toml
[features]
my-category = []
```

2. Add the scorer in `src/nautilus-server/src/scoring/my_category.rs` and a
   `pub mod my_category;` line in `scoring/mod.rs`. Implement the `Scorer` trait
   and set its `category_id`.

3. Add the app in `src/nautilus-server/src/apps/my-category/mod.rs` plus an
   `allowed_endpoints.yaml` listing any oracle host the engine needs. Register
   the module and re-export in `lib.rs` under `#[cfg(feature = "my-category")]`,
   and gate `job`/`oracle`/`scoring` with the same feature.

4. If the category resolves its own ground truth, add the fetch to `oracle.rs`
   (or a sibling module) and list its host in `allowed_endpoints.yaml`. Keep the
   scorer pure: the app fetches, the scorer only does the math.

## Build, run, test

Local development (runs anywhere, no AWS, fresh key per boot):

```bash
cd src/nautilus-server
RUST_LOG=info cargo run --no-default-features --features btc-price-guess
cargo test --no-default-features --features btc-price-guess
```

Enclave image and PCRs (needs an AWS Nitro capable host):

```bash
make ENCLAVE_APP=btc-price-guess
cat out/nitro.pcrs   # PCR0/1/2 are unique to this category build
make run-debug       # debug build, all-zero PCRs, for development only
```

Because the scorer and its allow list are compiled into the image, each
category produces its own PCR set. Register those PCRs and the enclave public
key onchain per category when the Move verifier lands.
