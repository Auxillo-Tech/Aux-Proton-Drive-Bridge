#!/usr/bin/env bash
#──────────────────────────────────────────────────────────────
# sign-release.sh — Sign and attest release artifacts
#──────────────────────────────────────────────────────────────
# Generates GPG signatures and/or signify attestations for
# every release artifact in dist/.
#
# Prerequisites:
#   - GPG key set up for signing (or signify installed)
#   - SIGNING_KEY env var with key ID for GPG
#
# Usage:
#   ./scripts/sign-release.sh                # Sign all artifacts
#   ./scripts/sign-release.sh --method=both  # GPG + signify
#   ./scripts/sign-release.sh --method=gpg   # GPG only
#   ./scripts/sign-release.sh --verify       # Verify existing sigs
#──────────────────────────────────────────────────────────────

set -euo pipefail
cd "$(dirname "$0")/.."

METHOD="${1:-both}"
METHOD="${METHOD#--method=}"
VERIFY_MODE=false

if [[ "$1" == "--verify" || "$2" == "--verify" ]]; then
  VERIFY_MODE=true
fi

DIST_DIR="dist"
SIGNING_KEY="${SIGNING_KEY:-}"
ARTIFACTS=()

# Collect artifacts
while IFS= read -r f; do
  case "$f" in
    *.sha256|*.sha256sum|*.sig|*.asc|*manifest*.json) ;;
    *) ARTIFACTS+=("$f") ;;
  esac
done < <(find "$DIST_DIR" -maxdepth 1 -type f | sort)

if [[ ${#ARTIFACTS[@]} -eq 0 ]]; then
  echo "No artifacts found in $DIST_DIR/"
  exit 1
fi

echo "Found ${#ARTIFACTS[@]} artifacts to sign"

#──────────────────────────────────────────────────────────────
# GPG Signing
#──────────────────────────────────────────────────────────────
sign_gpg() {
  if command -v gpg &>/dev/null; then
    echo "── GPG signing ──"
    for artifact in "${ARTIFACTS[@]}"; do
      sigfile="${artifact}.asc"
      if [[ -n "$SIGNING_KEY" ]]; then
        gpg --batch --yes --detach-sign --armor --default-key "$SIGNING_KEY" -o "$sigfile" "$artifact"
      else
        gpg --batch --yes --detach-sign --armor -o "$sigfile" "$artifact"
      fi
      echo "  ✓ Signed: $(basename "$artifact") → $(basename "$sigfile")"
    done
  else
    echo "  ⚠ gpg not found, skipping GPG signing"
    return 1
  fi
}

verify_gpg() {
  echo "── GPG verification ──"
  for artifact in "${ARTIFACTS[@]}"; do
    sigfile="${artifact}.asc"
    if [[ -f "$sigfile" ]]; then
      if gpg --verify "$sigfile" "$artifact" 2>/dev/null; then
        echo "  ✓ $(basename "$artifact"): Good signature"
      else
        echo "  ✗ $(basename "$artifact"): BAD signature!"
      fi
    fi
  done
}

#──────────────────────────────────────────────────────────────
# Signify (Minisign) Signing
#──────────────────────────────────────────────────────────────
SIGNIFY_BIN=""
for cmd in signify minisign; do
  if command -v "$cmd" &>/dev/null; then
    SIGNIFY_BIN="$cmd"
    break
  fi
done

sign_signify() {
  if [[ -z "$SIGNIFY_BIN" ]]; then
    echo "  ⚠ signify/minisign not found, skipping"
    return 1
  fi

  echo "── Signify signing ──"
  # Determine secret key location
  SECRET_KEY="${SIGNIFY_SECRET_KEY:-$HOME/.auxillo-release.sec}"
  if [[ ! -f "$SECRET_KEY" ]]; then
    echo "  ⚠ Secret key not found at $SECRET_KEY, skipping signify"
    return 1
  fi

  for artifact in "${ARTIFACTS[@]}"; do
    sigfile="${artifact}.sig"
    if [[ "$SIGNIFY_BIN" == "minisign" ]]; then
      minisign -Sm "$artifact" -s "$SECRET_KEY" -x "$sigfile"
    else
      signify -S -s "$SECRET_KEY" -m "$artifact" -x "$sigfile"
    fi
    echo "  ✓ Signed: $(basename "$artifact") → $(basename "$sigfile")"
  done
}

verify_signify() {
  [[ -z "$SIGNIFY_BIN" ]] && return 0
  PUBLIC_KEY="${SIGNIFY_PUBLIC_KEY:-$HOME/.auxillo-release.pub}"

  echo "── Signify verification ──"
  for artifact in "${ARTIFACTS[@]}"; do
    sigfile="${artifact}.sig"
    if [[ -f "$sigfile" ]]; then
      if "$SIGNIFY_BIN" -V -p "$PUBLIC_KEY" -m "$artifact" -x "$sigfile" 2>/dev/null; then
        echo "  ✓ $(basename "$artifact"): Good signature"
      else
        echo "  ✗ $(basename "$artifact"): BAD signature!"
      fi
    fi
  done
}

#──────────────────────────────────────────────────────────────
# Generate checksum file with SHA256
#──────────────────────────────────────────────────────────────
generate_checksums() {
  echo "── Generating SHA256SUMS ──"
  (
    cd "$DIST_DIR"
    sha256sum "${ARTIFACTS[@]/#./}" > SHA256SUMS.txt
  )
  echo "  ✓ SHA256SUMS.txt generated"
}

#──────────────────────────────────────────────────────────────
# Main
#──────────────────────────────────────────────────────────────
if [[ "$VERIFY_MODE" == "true" ]]; then
  verify_gpg
  verify_signify
  echo "── Checking SHA256SUMS ──"
  (cd "$DIST_DIR" && sha256sum -c SHA256SUMS.txt 2>/dev/null || echo "  ⚠ SHA256SUMS check incomplete")
  exit 0
fi

case "$METHOD" in
  gpg)
    sign_gpg
    ;;
  signify|minisign)
    sign_signify
    ;;
  both|all)
    sign_gpg || true
    sign_signify || true
    ;;
  checksum)
    generate_checksums
    ;;
  *)
    echo "Unknown method: $METHOD"
    echo "Usage: $0 [--method=gpg|signify|both|checksum] [--verify]"
    exit 1
    ;;
esac

generate_checksums

echo ""
echo "── Signing complete ──"
echo "Artifacts processed: ${#ARTIFACTS[@]}"
ls -lh "$DIST_DIR"/*.{asc,sig} 2>/dev/null || true
