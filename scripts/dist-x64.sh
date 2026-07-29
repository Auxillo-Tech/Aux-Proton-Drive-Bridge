#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

eval "$(bash scripts/prepare-fedora-builder-cache.sh)"
export LD_LIBRARY_PATH="$LIBCRYPT_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PATH="$RPMBUILD_BIN:$PATH"
export npm_config_build_from_source=false

node scripts/generate-third-party-notices.js
rm -rf dist
mkdir -p dist
./node_modules/.bin/electron-builder --config build.yml --linux AppImage deb rpm --x64 --publish never
