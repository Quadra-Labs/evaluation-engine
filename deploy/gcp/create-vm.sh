#!/usr/bin/env bash
#
# create-vm.sh — boot the evaluation engine inside a GCP Confidential Space VM.
#
# WHAT MAKES THIS A TEE AND NOT JUST A VM, in the flags below:
#
#   --confidential-compute-type=SEV_SNP   AMD SEV-SNP. Memory is encrypted with a key the host
#                                         cannot read, and the guest can prove its own state.
#   --shielded-secure-boot                The `secboot: true` claim the verifier requires. Without
#                                         it the boot chain is unattested and the token is refused.
#   image-family=confidential-space       Google's hardened image. It runs ONE container, gives
#                                         nobody SSH, and mints attestation tokens over a local
#                                         socket. The `-debug` variant relaxes that; see DEBUG below.
#   --maintenance-policy=TERMINATE        Confidential VMs cannot live-migrate.
#
# The workload's identity is `tee-image-reference`, and it must be the DIGEST form. A tag would let
# the running code drift from what the chain pinned, and `register` would then fail BadImageDigest
# with nothing pointing at the cause.
#
#   TEE_IMAGE=us-central1-docker.pkg.dev/p/quadra/evaluation-engine@sha256:... \
#   PROJECT=my-project ./deploy/gcp/create-vm.sh
#
# Environment:
#   PROJECT              GCP project id.                              Required.
#   TEE_IMAGE            Image reference, DIGEST form.                Required.
#   ZONE                 Default us-central1-a.
#   VM_NAME              Default quadra-evaluation-engine.
#   MACHINE_TYPE         Default n2d-standard-2 (SEV-SNP needs an AMD Milan machine family).
#   SERVICE_ACCOUNT      Defaults to the project's compute default SA.
#   CHAIN_RPC_URL, CHAIN_ID, JOB_ESCROW, SEALED_COMPETITION, TEE_REGISTRY, FROM_BLOCK,
#   DA_URL, DEFAULT_FEED, DEFAULT_LIFETIME_SECS, TEE_PORT, LOG_LEVEL
#                        Passed through as tee-env-* metadata. Each MUST appear in the image's
#                        tee.launch_policy.allow_env_override label or it is silently ignored.
#   DEBUG=true           Use confidential-space-debug: allows SSH and shell access. NEVER for a
#                        real deployment — a debug image is one an operator can inspect, which
#                        defeats the point, and its measurement differs so the digest pin changes.

set -euo pipefail

: "${PROJECT:?set PROJECT to your GCP project id}"
: "${TEE_IMAGE:?set TEE_IMAGE to the image DIGEST reference printed by build-push.sh}"

ZONE="${ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-quadra-evaluation-engine}"
MACHINE_TYPE="${MACHINE_TYPE:-n2d-standard-2}"
TEE_PORT="${TEE_PORT:-3000}"

case "$TEE_IMAGE" in
*@sha256:*) ;;
*)
    echo "TEE_IMAGE must be the digest form (repo/image@sha256:...), not a tag." >&2
    echo "A tag lets the running enclave drift from the digest pinned on chain." >&2
    exit 1
    ;;
esac

if [[ "${DEBUG:-false}" == "true" ]]; then
    IMAGE_FAMILY="confidential-space-debug"
    echo "WARNING: building a DEBUG Confidential Space VM. It permits shell access, so it is not"
    echo "         a trustworthy enclave, and its measurement differs from the production image."
else
    IMAGE_FAMILY="confidential-space"
fi

SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com}"

# Every value here reaches the container as an environment variable. Anything absent from the
# image's allow_env_override label is dropped WITHOUT an error, so a missing setting looks like a
# working boot with surprising behaviour rather than a failure.
metadata="tee-image-reference=${TEE_IMAGE}"
metadata+=",tee-container-log-redirect=true"
metadata+=",tee-restart-policy=Always"

add_env() {
    local name="$1" value="${2:-}"
    [[ -z "$value" ]] && return 0
    metadata+=",tee-env-${name}=${value}"
}

add_env CHAIN_ID "${CHAIN_ID:-114}"
add_env CHAIN_RPC_URL "${CHAIN_RPC_URL:-https://coston2-api.flare.network/ext/C/rpc}"
add_env JOB_ESCROW "${JOB_ESCROW:-}"
add_env SEALED_COMPETITION "${SEALED_COMPETITION:-}"
add_env TEE_REGISTRY "${TEE_REGISTRY:-}"
add_env FROM_BLOCK "${FROM_BLOCK:-}"
add_env DA_URL "${DA_URL:-https://ctn2-data-availability.flare.network}"
add_env DA_API_KEY "${DA_API_KEY:-}"
add_env DEFAULT_FEED "${DEFAULT_FEED:-BTC/USD}"
add_env DEFAULT_LIFETIME_SECS "${DEFAULT_LIFETIME_SECS:-3600}"
add_env TEE_PORT "$TEE_PORT"
add_env LOG_LEVEL "${LOG_LEVEL:-info}"
# Recorded in every receipt, and compared by quadra-verify against what the registry pinned.
add_env TEE_IMAGE_DIGEST "${TEE_IMAGE#*@}"

# The deployment file is not in the image, so the three addresses have to arrive here. Catching it
# now beats a container that boots, fails config, restarts forever, and says so only in a log the
# operator has not thought to look at yet.
for required in JOB_ESCROW SEALED_COMPETITION TEE_REGISTRY; do
    if [[ -z "${!required:-}" ]]; then
        echo "$required is required: contracts/deployments/<chainId>.json is not inside the image," >&2
        echo "so the enclave cannot resolve addresses on its own." >&2
        exit 1
    fi
done

echo "==> creating ${VM_NAME} in ${ZONE} (${IMAGE_FAMILY}, ${MACHINE_TYPE})"
gcloud compute instances create "$VM_NAME" \
    --project "$PROJECT" \
    --zone "$ZONE" \
    --machine-type "$MACHINE_TYPE" \
    --confidential-compute-type=SEV_SNP \
    --shielded-secure-boot \
    --maintenance-policy=TERMINATE \
    --image-family="$IMAGE_FAMILY" \
    --image-project=confidential-space-images \
    --service-account="$SERVICE_ACCOUNT" \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    --tags=quadra-tee \
    --metadata="$metadata"

echo "==> opening ${TEE_PORT} to the relayer"
if ! gcloud compute firewall-rules describe quadra-tee-port --project "$PROJECT" >/dev/null 2>&1; then
    # The enclave SERVES: the scheduler asks it for a signed settlement and self-register reads its
    # /pubkey and /attestation. That is safe to expose because everything it returns is either
    # public or signed — there is no endpoint that reveals a decrypted submission, and no request
    # can make it sign something it did not derive from the chain itself.
    gcloud compute firewall-rules create quadra-tee-port \
        --project "$PROJECT" \
        --allow="tcp:${TEE_PORT}" \
        --target-tags=quadra-tee \
        --description="Quadra evaluation engine: signed settlement API"
fi

ip="$(gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
    --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"

cat <<EOF

================================================================================
  VM:  ${VM_NAME}  (${ZONE})
  URL: http://${ip}:${TEE_PORT}

  The image pull and first boot take a couple of minutes. Then:

    curl http://${ip}:${TEE_PORT}/health
    curl http://${ip}:${TEE_PORT}/pubkey

  Once /attestation returns a real JWT (not SIMULATED_ATTESTATION_TOKEN), bind it:

    RELAYER_PRIVATE_KEY=<funded key> pnpm self-register --url http://${ip}:${TEE_PORT}

  Logs (there is no SSH on a production Confidential Space VM):

    gcloud logging read 'resource.type="gce_instance" AND labels.instance_name="${VM_NAME}"' \\
      --project ${PROJECT} --limit 50 --format='value(textPayload)'
================================================================================
EOF
