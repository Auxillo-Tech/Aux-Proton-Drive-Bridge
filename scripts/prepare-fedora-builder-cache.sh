#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .cache/rpms .cache/libxcrypt-compat .cache/rpm-build

fetch_extract() {
  local url="$1"
  local dest="$2"
  local rpm_file=".cache/rpms/$(basename "$url")"
  if [ ! -f "$rpm_file" ]; then
    curl -fL --retry 3 --retry-delay 2 "$url" -o "$rpm_file"
  fi
  mkdir -p "$dest"
  (cd "$dest" && rpm2cpio "../../$rpm_file" | cpio -idmu >/dev/null)
}

if [ ! -e .cache/libxcrypt-compat/usr/lib64/libcrypt.so.1 ]; then
  fetch_extract "https://download.fedoraproject.org/pub/fedora/linux/releases/44/Everything/x86_64/os/Packages/l/libxcrypt-compat-4.5.2-3.fc44.x86_64.rpm" .cache/libxcrypt-compat
fi

if ! command -v rpmbuild >/dev/null 2>&1 && [ ! -x .cache/rpm-build/usr/bin/rpmbuild ]; then
  fetch_extract "https://download.fedoraproject.org/pub/fedora/linux/releases/44/Everything/x86_64/os/Packages/r/rpm-build-6.0.1-2.fc44.x86_64.rpm" .cache/rpm-build
  fetch_extract "https://download.fedoraproject.org/pub/fedora/linux/releases/44/Everything/x86_64/os/Packages/r/rpm-build-libs-6.0.1-2.fc44.x86_64.rpm" .cache/rpm-build
fi

printf 'LIBCRYPT_DIR=%s
' "$(pwd)/.cache/libxcrypt-compat/usr/lib64"
printf 'RPMBUILD_BIN=%s
' "$(pwd)/.cache/rpm-build/usr/bin"
