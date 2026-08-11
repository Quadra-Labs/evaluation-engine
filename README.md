# Quadra evaluation engine

The only Quadra workload that runs inside a TEE. It decrypts sealed agent submissions, resolves
ground truth from Flare's FTSO anchor feeds, scores, and signs a settlement that `JobEscrow` and
`SealedCompetition` verify on chain.

It holds one secret and produces one kind of artifact. Everything else — deciding what is due,
paying gas, submitting transactions — belongs to callers that hold no key and can forge nothing.

## What runs privately, and what the chain checks

**What is private inside the TEE.** The secp256k1 key, generated inside the Confidential Space
container at boot and never exported — `keys.ts` refuses to start if a key is supplied from the
environment when `SIMULATE_ATTESTATION=false`, and the image's launch policy deliberately omits
`TEE_PRIVATE_KEY` from the overridable set, so not even an operator editing VM metadata can inject
one. Everything sealed to that key: each buyer's delivered result, and every competition entry
before settlement. And the scoring itself — the enclave sees plaintext, the chain never does.

**What is verified on chain.** Two independent things, and it matters that they are separate:

- _Identity._ `TeeRegistry.register` verifies a Google-signed Confidential Space attestation JWT in
  Solidity (RS256 against a mirrored JWKS), requires the attested `submods.container.image_digest`
  to equal the digest the registry pins, and binds the key only if the token's `eat_nonce` equals
  `keccak256(wallet, pubkey)` — so a captured token cannot bind any other key.
- _Each settlement._ The EIP-712 signature recovers to `activeTeeWallet`; `FtsoLib.checkGroundTruth`
  re-verifies the FTSO anchor-feed Merkle proof and requires it to equal the signed
  `groundTruthValue`; `keccak256(receipt)` must equal the anchored receipt hash. `quadra-verify`
  replays all of it from public data.

**Trust assumptions, stated rather than implied.**

1. The JWKS is mirrored on chain by the contract owner, not fetched from Google. A compromised
   owner could install a key they control. This is the residual trust Flare Confidential Compute
   removes by replacing it with data-provider consensus, which is why `registerFccTee` remains a
   third path rather than dead code.
2. The image digest pin is only as strong as the build's reproducibility. Base images are not yet
   pinned by digest ([BUGS.md 24](../_migration/BUGS.md)), so today the digest attests that _some_
   image ran, not that this published source did.
3. Anyone who runs the same public image in their own Confidential Space project can mint a valid
   token for their own enclave. Not a confidentiality break — their enclave runs this code — but a
   griefing surface, closed by pinning `VTPM_SUB_PREFIX` to your GCP project.
4. `portfolio-roi` settlements pin only one of a portfolio's feeds; the rest rest on the TEE
   signature alone.

**Why this needs confidential compute rather than a smart contract.** The product is a market for
forecasts, and a forecast is worth nothing once everyone can read it. On a public chain the scoring
inputs would be public the moment they were submitted: a competition entrant could read every rival
entry before the deadline and submit a strictly better one, and a buyer's paid result would be
readable by anyone who never paid. Commit-reveal fixes the first and not the second — the buyer's
result must stay private _permanently_, not just until settlement. So the requirement is a place
that can hold a decryption key, read the plaintext, and still be trusted by a contract that cannot
see any of it. That is exactly a TEE: the enclave decrypts, scores, and hands back a signed
statement the chain verifies against an attested identity and an independent oracle proof.

## What changed from the Sui version

The `sui` branch is a Rust binary compiled by StageX into an AWS Nitro enclave image, identified by
three PCR measurements registered on Sui, signing BCS `IntentMessage` blobs with a boot-generated
ed25519 key. None of that substrate exists on Flare. The rewrite changes five things that matter:

|              | Sui (`sui` branch)                  | Flare (`main`)                                                 |
| ------------ | ----------------------------------- | -------------------------------------------------------------- |
| Runtime      | Rust / axum in an AWS Nitro EIF     | TypeScript on Node 22 in a Confidential Space container        |
| Identity     | 3 PCRs in `enclave::EnclaveConfig`  | container code hash, registered in `TeeRegistry`               |
| Signature    | ed25519 over BCS `IntentMessage<T>` | secp256k1 EIP-712, or an FCC `TEE_ACTION_RESULT`               |
| Ground truth | Pyth Hermes, fetched over vsock     | FTSO anchor feeds with a Merkle proof the contract re-verifies |
| Input        | the caller POSTs a decrypted job    | the engine reads the chain itself and decrypts the sealed blob |

The last row is the substantive one. On Sui the caller decrypted the agent's result with Seal and
handed the enclave a finished plaintext job, so the enclave was a pure scorer and the caller saw
everything. Here the submission is encrypted to the TEE's own key and nobody else can read it.

Two smaller corrections came with the port, both deliberate:

- **The start price is no longer caller-supplied.** Sui's `/start_data` endpoint let the scheduler
  capture a price at delivery time and feed it back into `/process_data`, where the enclave used it
  verbatim. Both the price-range and movement-percentage scorers scale their entire tolerance off
  that number, so it was forgeable by whoever posted the job. The engine now re-derives both ends
  from the DA layer itself.
- **Errors are classified.** The Sui engine returned HTTP 400 for everything, so a transient oracle
  outage looked exactly like a malformed job. See the status codes below.

## How the enclave is bound, and how it signs

The same scoring code serves both signing paths, so they cannot produce different scores. What
differs is who holds the key and who vouches for the enclave.

**EIP-712 on GCP Confidential Space — the path this ships on.** The engine runs alone inside an
AMD SEV-SNP confidential VM. It generates its secp256k1 key at boot, signs a `JobSettlement` or
`Settlement` typed-data digest, and the market recovers the signer against
`TeeRegistry.activeTeeWallet()`. The binding is `TeeRegistry.register`, which verifies a
Google-signed attestation on chain before it will trust the key. See
[docs/deploy.md](docs/deploy.md).

**FCC `TEE_ACTION_RESULT`.** The engine runs as a Flare Compute Extension behind Flare's TEE node
and holds no key at all: decryption goes to the node's `/decrypt` port and the node signs the
result, which a relayer submits into `scoreJobFromTee` / `settleFromTee`. It is written and
unexercised — standing it up needs Coston2 indexer credentials and a named tunnel from Flare, both
with external lead time.

`setActiveTee` also exists and is development only: an owner transaction asserting a key belongs to
an enclave, with nothing verifying that claim. It is how the stack ran before a VM existed.

## HTTP surface

The EIP-712 service listens on `TEE_PORT` (default 3000).

| Route                      | Body                | Returns                                                |
| -------------------------- | ------------------- | ------------------------------------------------------ |
| `GET /health`              |                     | liveness, the bound addresses, DA-layer reachability   |
| `GET /pubkey`              |                     | `{ address, publicKey }`, the key agents seal to       |
| `GET /attestation`         |                     | `{ token, address }`                                   |
| `POST /validate`           | `{ jobId }`         | did the agent deliver something well formed — unsigned |
| `POST /score-job`          | `{ jobId }`         | a signed `scoreJob` argument set                       |
| `POST /settle-competition` | `{ competitionId }` | a signed `settle` argument set                         |
| `POST /score-market`       | `{ jobId }`         | a prediction-market score, unsigned and not settleable |

`/score-job` and `/settle-competition` return everything the caller needs to submit the transaction
and nothing it needs to trust: the signature is over the whole settlement, so a relayer cannot alter
a score, a ground-truth value or an entry list without invalidating it. All integers cross the wire
as decimal strings.

Status codes: `400` the caller or the agent is at fault, `409` not resolvable yet or already
terminal, `502` the DA layer or the RPC failed, `503` no chain configured.

`/validate` is deliberately unsigned. It answers "was this well formed", not "was it correct", and
payment is released on the first question alone — an agent that did honest work on time gets paid
even if the market moved against it.

The FCC extension serves `POST /action` and `GET /state` on `EXTENSION_PORT` (default 7702), with
the same three verbs as `(opType, opCommand)` pairs: `EVALUATION/VALIDATE`, `EVALUATION/SCORE_JOB`,
`EVALUATION/SETTLE_COMP`.

## Evaluators

Scoring is a lookup, not a chain of `if`s. `quadra-core`'s scorer registry is the single dispatch
point and the verifier uses the same one, so an evaluator the engine can score is an evaluator
anyone can re-derive.

| Evaluator                                     | Scores                                                                       | Settles as                   |
| --------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| `price-range-guess`                           | did the price land in the band, scaled by volatility over the job's lifetime | job or competition           |
| `up-down-guess`                               | integer Brier score over a confidence in [50,100]                            | job or competition           |
| `movement-percentage-guess`                   | Lorentzian decay on the error in basis points                                | job or competition           |
| `portfolio-roi`                               | `PERF_BASE + roi_bps` from a start allocation and a trade list               | performance competition only |
| `polymarket-resolution` / `-event` / `-price` | market outcome and price accuracy                                            | not settleable yet           |

Two limits are structural rather than unfinished work:

- `portfolio-roi` produces a `uint64` metric around 1e6, which fits `SealedCompetition`'s
  `EntryInput.score` and `KIND_PERFORMANCE` but not `scoreJob`'s `uint8`. Its settlement can pin
  only one FTSO feed, so the on-chain oracle cross-check covers one asset of a multi-asset
  portfolio. That is weaker than the price evaluators and is stated rather than hidden.
- The `polymarket-*` evaluators have no FTSO feed at all. Every settlement path calls
  `FtsoLib.checkGroundTruth`, which requires an anchor-feed proof matching the signed value, so
  `POST /score-market` runs the whole path — read the chain, decrypt, query Gamma or the CLOB,
  score — and stops at the settlement, unsigned, saying why. Landing them for real needs an FDC
  `Web2Json` verification path in `contracts`. Attaching an unrelated feed's proof would satisfy
  the contract and be a lie the verifier would faithfully confirm.

## Units

Prices are integers in 1e-8 fixed point (`PRICE_DECIMALS = 8`) everywhere — in submissions, in the
scorers, in the receipt and in `groundTruthValue`. An FTSO anchor feed carries its own `decimals`
(BTC/USD reads 2 at current prices, because `FeedData.value` is an `int32`), and
`normalizeToPrice` bridges that to the canonical unit using the same formula
`FtsoLib.normalizedPrice` uses on chain. A disagreement here mis-scales every price by a power of
ten, so both sides derive it from one place.

All scoring is integer arithmetic on `bigint`. Floating point would drift by a score point on
boundaries, and the score is signed.

## Development

```bash
pnpm install
pnpm typecheck
pnpm dev                 # the EIP-712 service on TEE_PORT
pnpm dev:fcc             # the FCC extension on EXTENSION_PORT
pnpm register-tee        # bind this instance's key into TeeRegistry (dev path)
```

Addresses are never hardcoded. `quadra-core/deployments` resolves them from
`contracts/deployments/<chainId>.json` by walking up from this checkout, so a redeploy needs no
change here. Copy `.env.example` to `.env` for the rest.

`quadra-core` is vendored as a tarball in `vendor/` rather than referenced across the repo
boundary, because this package becomes the TEE image and the image hash is the on-chain identity.
Re-vendor with `pnpm vendor:core` after any change in `data`, and re-register the code version
afterwards.

## Layout

```
src/
  main.ts server.ts config.ts log.ts   the EIP-712 service
  keys.ts attestation.ts               TEE identity and its proof
  decrypt.ts validate.ts               opening sealed deliveries, and the intake gate
  score.ts settlement.ts resolve.ts    scoring, receipts, signing, argument assembly
  evaluators/                          the evaluators quadra-core cannot hold (I/O or non-price)
  chain/                               Coston2 reads and the TeeRegistry write
  http/                                capped, retrying outbound fetch
  fcc/base/                            the FCC wire contract, ported verbatim
  fcc/app/                             our three handlers
```

`fcc/base/` is ported from Flare's `fce-extension-scaffold` and is not ours to redesign. The
`ActionResult` JSON is what the node hashes and signs, so field order, field presence and the
absence of whitespace are all load-bearing.
