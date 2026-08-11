#!/usr/bin/env bash
#
# build-push.sh — build the Confidential Space image, push it, and print the digest to pin.
#
# THE DIGEST THIS PRINTS IS THE ENCLAVE'S ON-CHAIN IDENTITY. `TeeRegistry.expectedImageDigest` is
# set to it, and `register` binds the settlement key only if the attestation reports the enclave is
# running that exact image. A tag will not do: tags move, and a moved tag means the pin no longer
# describes what is running.
#
# Confidential Space pulls the image itself, as the VM's service account, so the image must live
# somewhere that service account can read — Artifact Registry, in the same project by default.
#
#   PROJECT=my-project REGION=us-central1 ./deploy/gcp/build-push.sh
#
# Environment:
#   PROJECT     GCP project id.                                  Required.
#   REGION      Artifact Registry region.                        Default us-central1.
#   REPO        Artifact Registry repository name.               Default quadra.
#   IMAGE       Image name.                                      Default evaluation-engine.
#   TAG         Tag to push (the digest is what matters).        Default latest.
#   SOURCE_DATE_EPOCH  Fixed build timestamp for reproducibility. Default 1735689600.

set -euo pipefail

: "${PROJECT:?set PROJECT to your GCP project id}"
REGION="${REGION:-us-central1}"
REPO="${REPO:-quadra}"
IMAGE="${IMAGE:-evaluation-engine}"
TAG="${TAG:-latest}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1735689600}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ref="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${IMAGE}"

echo "==> ensuring the Artifact Registry repository exists"
if ! gcloud artifacts repositories describe "$REPO" \
    --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
    gcloud artifacts repositories create "$REPO" \
        --project "$PROJECT" --location "$REGION" \
        --repository-format=docker \
        --description="Quadra confidential workloads"
fi

echo "==> configuring docker auth for ${REGION}-docker.pkg.dev"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo "==> re-vendoring quadra-core so the image carries the current trust core"
(cd "$here" && pnpm vendor:core)

echo "==> building ${ref}:${TAG}"
docker build \
    --file "$here/Dockerfile.tee" \
    --build-arg "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" \
    --tag "${ref}:${TAG}" \
    "$here"

echo "==> pushing"
docker push "${ref}:${TAG}"

# Read the digest back from the REGISTRY rather than from the local build. What the enclave will
# run is what the registry serves, and if the two ever disagree it is the registry that decides.
digest="$(gcloud artifacts docker images describe "${ref}:${TAG}" \
    --project "$PROJECT" --format='value(image_summary.digest)')"

cat <<EOF

================================================================================
  Image:  ${ref}:${TAG}
  DIGEST: ${digest}

  This digest is the enclave's identity. Next:

    1. Pin it on chain, either at deploy time
         EXPECTED_IMAGE_DIGEST=${digest} DEPLOY_VTPM=true forge script script/Deploy.s.sol ...
       or on an existing registry that already has a verifier
         cast send \$TEE_REGISTRY "setExpectedImageDigest(string)" "${digest}" ...

    2. Boot the VM against this exact reference:
         TEE_IMAGE=${ref}@${digest} ./deploy/gcp/create-vm.sh

  Use the DIGEST form (@sha256:...) for tee-image-reference, not the tag. A tag would let the
  running enclave drift away from the digest the chain has pinned, and registration would then
  fail with BadImageDigest and no obvious cause.
================================================================================
EOF
