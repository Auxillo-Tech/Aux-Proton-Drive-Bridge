#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
PUBLIC_KEY="$ROOT/assets/release-public-key.pem"
PRIVATE_KEY="${AUX_PROTON_RELEASE_PRIVATE_KEY:-$HOME/.hermes/credentials/aux-proton-drive-release-private.pem}"
SIGNING_TOOL="$ROOT/scripts/release-signing.js"
SET_VERIFIER="$ROOT/scripts/verify-release-set.js"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARTIFACTS=(
  "Aux.Proton.Drive.Bridge-${VERSION}-x86_64.AppImage"
  "Aux.Proton.Drive.Bridge-${VERSION}-amd64.deb"
  "Aux.Proton.Drive.Bridge-${VERSION}-x86_64.rpm"
  "aux-proton-drive-bridge-${VERSION}-source.tar.gz"
  "aux-proton-drive-bridge-${VERSION}-source.zip"
  "aux-proton-drive-bridge-${VERSION}-aur.tar.gz"
  "latest-linux.yml"
  "sbom.cdx.json"
  "release-manifest.json"
)
cd "$DIST"

verify_release() {
  [[ -s SHA256SUMS.txt ]] || { echo 'Missing SHA256SUMS.txt' >&2; exit 1; }
  [[ -s SHA256SUMS.txt.sig ]] || { echo 'Missing SHA256SUMS.txt.sig' >&2; exit 1; }
  [[ -s "$PUBLIC_KEY" ]] || { echo 'Missing pinned release public key' >&2; exit 1; }
  node "$SET_VERIFIER" --checksums
  sha256sum --check --strict SHA256SUMS.txt
  node "$SIGNING_TOOL" --verify --public "$PUBLIC_KEY" --file SHA256SUMS.txt --signature SHA256SUMS.txt.sig
}

if [[ "${1:-}" == '--verify' ]]; then
  verify_release
  exit 0
fi

[[ -s "$PRIVATE_KEY" ]] || { echo "Missing Ed25519 release private key: $PRIVATE_KEY" >&2; exit 1; }
[[ "$(stat -c '%a' "$PRIVATE_KEY")" == '600' ]] || { echo 'Release private key permissions must be 600' >&2; exit 1; }
[[ -s "$PUBLIC_KEY" ]] || { echo "Missing pinned release public key: $PUBLIC_KEY" >&2; exit 1; }
node "$SET_VERIFIER"
rm -f SHA256SUMS.txt SHA256SUMS.txt.sig
sha256sum "${ARTIFACTS[@]}" > SHA256SUMS.txt
node "$SIGNING_TOOL" --sign --key "$PRIVATE_KEY" --file SHA256SUMS.txt --output SHA256SUMS.txt.sig
verify_release
echo "Exact release set signed and verified with pinned Ed25519 key."
