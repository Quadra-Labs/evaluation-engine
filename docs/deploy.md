# Deploying the evaluation engine

Three ways to bind this engine's identity on chain, in increasing order of what they actually
prove. **Route B is the real one** — it is what the bounty submission runs on.

|                     | Who vouches for the enclave              | Needs                          |
| ------------------- | ---------------------------------------- | ------------------------------ |
| A. `setActiveTee`   | the contract owner's word                | nothing                        |
| **B. `register`**   | **the chain, from a Google attestation** | **a Confidential Space VM**    |
| C. `registerFccTee` | Flare's data-provider consensus          | Flare's scaffold + credentials |

All three converge on `activeTeeWallet`, so the markets never learn which one bound it.

---

# Route B: GCP Confidential Space (the real TEE)

The workload runs alone inside an AMD SEV-SNP confidential VM. Its memory is encrypted with a key
the hypervisor cannot read, it has no SSH, and the settlement key is generated inside it at boot
and never leaves. The chain verifies a Google-signed attestation before it will trust that key.

## What you need first

- A GCP project with billing, and `gcloud` authenticated against it.
- Docker, for the image build.
- A funded Coston2 key to pay gas for two transactions (the JWKS sync and the registration).
- **`n2d`-family quota in your chosen zone.** SEV-SNP needs AMD Milan; the default `n2d-standard-2`
  is the smallest that qualifies.

## 1. Build and push the image

```bash
PROJECT=my-project REGION=us-central1 ./deploy/gcp/build-push.sh
```

It re-vendors `quadra-core`, builds `Dockerfile.tee`, pushes to Artifact Registry, and prints the
immutable **digest**. That digest is the enclave's identity — everything below refers to it.

Pin the base images by digest before a submission build (BUGS.md 24); until then the image is not
byte-reproducible and a third party cannot confirm the digest matches this source.

## 2. Deploy the contracts with a verifier

`TeeRegistry.vtpm` is `immutable`, and the live Coston2 registry was deployed with it set to zero —
so `register()` reverts `VtpmUnset` there permanently. The attested path needs a fresh deploy, and
because both markets hold `teeRegistry` immutably, they come with it.

```bash
cd ../contracts
DEPLOY_VTPM=true \
EXPECTED_IMAGE_DIGEST=sha256:<from step 1> \
VTPM_SUB_PREFIX="https://www.googleapis.com/compute/v1/projects/my-project/" \
QUADRA_TOKEN=0x64eDA650dE75504E8e540FdEb0edDD4E8D631Dd3 \
TREASURY=<addr> INTAKE_ADDRESS=<addr> PRIVATE_KEY=<deployer> \
forge script script/Deploy.s.sol --rpc-url coston2 --broadcast
```

- `QUADRA_TOKEN` reuses the existing token, so agent balances and the fee history survive.
- **`VTPM_SUB_PREFIX` matters more than it looks.** Without it, anyone who pulls your public image
  and runs it in their own Confidential Space project can mint a valid token and bind their own
  enclave as the active TEE. It is not a confidentiality break — their enclave runs your code — but
  it is a griefing surface. Pinning the `sub` prefix restricts registration to your project.

It writes `deployments/114.json`, including the new `vtpmVerifier`. Every other repo reads that
file, so nothing downstream needs changing.

Later image releases do **not** need another deploy — that is what `setExpectedImageDigest` is for:

```bash
cast send $TEE_REGISTRY "setExpectedImageDigest(string)" "sha256:<new>" --private-key <owner> ...
```

## 3. Mirror Google's signing keys

The verifier checks an RS256 signature and cannot fetch keys itself, so they have to be put there.

```bash
DEPLOYER_PRIVATE_KEY=<owner> pnpm sync-jwks        # --dry to preview
```

Re-run this whenever registration fails with `UnknownKey` — that is the signal Google rotated.

## 4. Boot the enclave

```bash
PROJECT=my-project \
TEE_IMAGE=us-central1-docker.pkg.dev/my-project/quadra/evaluation-engine@sha256:<digest> \
JOB_ESCROW=<addr> SEALED_COMPETITION=<addr> TEE_REGISTRY=<addr> FROM_BLOCK=<deploy block> \
./deploy/gcp/create-vm.sh
```

Use the **digest** form. A tag lets the running enclave drift from what the chain pinned, and
registration then fails `BadImageDigest` with nothing pointing at the cause.

Give it two minutes to pull, then:

```bash
curl http://<vm-ip>:3000/health
curl http://<vm-ip>:3000/attestation     # must NOT say SIMULATED_ATTESTATION_TOKEN
```

There is no SSH. Logs come from Cloud Logging:

```bash
gcloud logging read 'resource.type="gce_instance" AND labels.instance_name="quadra-evaluation-engine"' \
  --project my-project --limit 50 --format='value(textPayload)'
```

## 5. Bind it

```bash
RELAYER_PRIVATE_KEY=<any funded key> pnpm self-register --url http://<vm-ip>:3000
```

The relayer key only pays gas. `register` is permissionless — the token is the credential, not the
sender — which is what keeps the enclave gasless and unstarvable. The relayer cannot substitute a
key either: the token's `eat_nonce` is `keccak256(wallet, pubkey)`, so changing the wallet fails the
nonce check and changing the token fails the RSA check.

Confirm:

```bash
cast call $TEE_REGISTRY "activeTeeWallet()(address)" --rpc-url coston2   # == the enclave's address
```

## 6. Prove it end to end

Run an agent, let it deliver, then past `lifetimeEnd`:

```bash
curl -XPOST http://<vm-ip>:3000/score-job -d '{"jobId":"0x..."}' -H 'content-type: application/json'
```

Submit the returned settlement, then replay it:

```bash
pnpm --dir ../data --filter quadra-verify start -- <jobId>
```

Green means: the score was re-derived from public data, the FTSO proof re-fetched and matched, the
receipt re-hashed to the anchored value, and the signature recovered to the attested enclave. That
run is the demo.

## What breaks, and what it looks like

| Symptom                    | Cause                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `VtpmUnset`                | the registry was deployed without a verifier; it is immutable, so redeploy                                                           |
| `UnknownKey`               | Google rotated — re-run `pnpm sync-jwks`                                                                                             |
| `BadImageDigest`           | the VM runs a different image than the registry pins; check you used `@sha256:`                                                      |
| `BadNonce`                 | the engine restarted between `/pubkey` and `/attestation`; re-run `self-register`                                                    |
| `BadSubject`               | `VTPM_SUB_PREFIX` pins a different project than the VM lives in                                                                      |
| `SecureBootOff`            | `--shielded-secure-boot` was omitted                                                                                                 |
| container restarts forever | a required address was missing; `tee-env-*` names must appear in the image's `allow_env_override` label or they are dropped silently |

---

# Route A: `setActiveTee` (development only)

An owner transaction asserting a key belongs to a TEE. It proves the owner said so. Use it to get
the stack moving before a VM exists.

```bash
pnpm dev              # one terminal
pnpm register-tee     # another
```

Pass a real image digest or none. An empty digest makes `quadra-verify` report the image check as
`skipped`, which is honest; a placeholder like `sha256:dev` makes it report a pass that attests to
nothing.

**Rebinding invalidates anything already sealed.** Agents read `activeTeePublicKey()` before they
seal, so deliveries made under an old key can never be opened by the new one.

---

# Route C: Flare Confidential Compute

The extension runs alongside Flare's TEE node; Flare's data providers verify the attestation and
our contract trusts their registry. It needs no contract changes — `configureFcc` and
`registerFccTee` work on any deployment — but it does need two things from Flare with real lead
time:

1. **Coston2 indexer database credentials.** The extension proxy reads the chain through Flare's
   indexer rather than an RPC node. Request read-only access from Flare technical support or
   @FlareDevs. They go in `config/proxy/extension_proxy.coston2.docker.toml` (gitignored; the
   `.example` documents the shape). Coston2 needs no VPN — Coston does, and uses different keys.
2. **A NAMED HTTPS tunnel to host port 6674.** The proxy's public URL is written on chain during
   `register-tee`. A quick tunnel mints a new hostname on every restart, so the registered URL
   silently stops resolving and the queue stays empty with no error anywhere.

```bash
export SCAFFOLD_DIR=/path/to/fce-extension-scaffold
cd "$SCAFFOLD_DIR" && ./scripts/pre-build.sh          # deploys the sender, writes EXTENSION_ID
cd - && docker compose -f docker-compose.fcc.yaml up --build -d
until curl -sf http://localhost:6674/info >/dev/null; do sleep 2; done
cd "$SCAFFOLD_DIR" && ./scripts/post-build.sh
```

`post-build.sh` runs `allow-tee-version`, `set-governance`, then `register-tee -command rRap`.
**The capital R matters** — the default `rap` is not the full first-time sequence, and without it
the machine never leaves the initialized state, `getRandomTeeIds` returns nothing, and calls revert
`TooMany()`.

Then bind it with `contracts/script/DeployFcc.s.sol` pass 2 and write the sender address into
`deployments/114.json`.

**Rebuild the public key, do not concatenate it.** `/info` reports X and Y separately; an
uncompressed key is `0x04 || pad32(X) || pad32(Y)`. `ProxyClient.publicKey()` does it correctly.

## Two things no Flare document specifies

**The ECIES variant `POST /decrypt` accepts.** The docs say only that callers "ECIES-encrypt using
the TEE's public key from `/info`". `ecies-geth` is an inference from the node being
go-ethereum-backed. Verify before any agent seals anything real: seal a known plaintext, POST it to
`http://localhost:$SIGN_PORT/decrypt` as base64, confirm it returns. If it is wrong,
`data/packages/core/src/ecies.ts` is the single file that changes — and everything sealed
beforehand is unrecoverable.

**`machineData.platform`.** Assumed to start `0x4743505f414d445f534556` (`GCP_AMD_SEV`). No
document shows a value. Read it off a real VM.

## Silent failures worth knowing

- **Reserved names.** Flare reserves the `F_` prefix and 17 command names (`TEE_ATTESTATION`,
  `TEE_INFO`, `TEE_BACKUP`, `KEY_GENERATE`, `KEY_INFO`, `KEY_PROOF`, `KEY_DELETE`,
  `KEY_DIRECT_BACKUP`, `KEY_DIRECT_RESTORE`, `KEY_DATA_PROVIDER_RESTORE`, `INITIALIZE_POLICY`,
  `UPDATE_POLICY`, `SET_MACHINE_PATH_LIST`, `PAY`, `REISSUE`, `VRF`, `PROVE`). A collision is
  accepted on chain and never delivered. `VALIDATE`, `SCORE_JOB` and `SETTLE_COMP` collide with
  none — check this list before adding a fourth verb.
- **A stale registered URL.** `go run ./tools/cmd/query-tee -reg <FlareTeeManager> <tee id>` and
  compare the registered `url` character by character with what you serve.
- **Version skew** between `tee-node` and `tee-proxy` surfaces as
  `fetching initial TEE info: hex string without 0x prefix` or `invalid signature`. Never bump one
  side alone.

If the extension answers `unsupported op type`, the instruction DID arrive and the `bytes32`
constants disagree — compare `EvaluationInstructionSender.sol` against `src/fcc/app/config.ts`. The
501 response decodes both names for exactly this reason.
