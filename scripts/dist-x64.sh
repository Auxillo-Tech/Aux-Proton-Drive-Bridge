#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
CACHE_ENV="$(bash scripts/prepare-fedora-builder-cache.sh)"
LIBCRYPT_DIR="$(printf '%s
' "$CACHE_ENV" | awk -F= '/^LIBCRYPT_DIR=/{print $2}' | tail -1)"
RPMBUILD_BIN="$(printf '%s
' "$CACHE_ENV" | awk -F= '/^RPMBUILD_BIN=/{print $2}' | tail -1)"
export LD_LIBRARY_PATH="$LIBCRYPT_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PATH="$RPMBUILD_BIN:$PATH"
export npm_config_build_from_source=false
npx electron-builder --config build.yml --linux AppImage deb rpm --x64 --publish never
