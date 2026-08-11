#!/usr/bin/env bash
#
# Re-pack quadra-core from the sibling `data` checkout into vendor/.
#
# Why vendor at all: quadra-core is the trust core (scorers, EIP-712, receipt, envelope) and it
# lives in a DIFFERENT git repo. This package becomes the TEE image, and that image's hash is its
# on-chain identity, so "whatever is in ../data right now" is not an acceptable input — a dirty
# working tree two directories away would silently change the attested code hash. Vendoring pins
# the exact bytes, in this repo, reviewable in a diff.
#
# Run this whenever quadra-core changes, then commit the tarball. Re-registering the TEE code
# version with Flare is required after any change that reaches the image.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
core="${QUADRA_CORE_DIR:-$here/../data/packages/core}"

if [ ! -f "$core/package.json" ]; then
    echo "vendor-core: no quadra-core at $core" >&2
    echo "vendor-core: set QUADRA_CORE_DIR if the data repo is checked out elsewhere" >&2
    exit 1
fi

version="$(node -p "require('$core/package.json').version")"
out="$here/vendor/quadra-core-$version.tgz"

echo "vendor-core: building quadra-core $version"
(cd "$core" && pnpm build)

mkdir -p "$here/vendor"
(cd "$core" && pnpm pack --out "$out")

echo "vendor-core: wrote $out"
echo "vendor-core: if the version changed, update the quadra-core dependency in package.json"
