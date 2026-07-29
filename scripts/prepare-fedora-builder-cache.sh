#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .cache/rpms .cache/libxcrypt-compat .cache/rpm-build

fetch_extract() {
  local url="$1"
  local dest="$2"
  local expected_sha256="$3"
  local rpm_file
  rpm_file=".cache/rpms/$(basename "$url")"
  if [[ ! -f "$rpm_file" ]]; then
    curl --fail --location --retry 3 --retry-delay 2 "$url" --output "$rpm_file"
  fi
  printf '%s  %s\n' "$expected_sha256" "$rpm_file" | sha256sum --check --status || {
    rm -f "$rpm_file"
    printf 'Checksum verification failed for %s\n' "$url" >&2
    return 1
  }
  mkdir -p "$dest"
  (cd "$dest" && rpm2cpio "../../$rpm_file" | cpio -idmu >/dev/null)
}

if [[ ! -e .cache/libxcrypt-compat/usr/lib64/libcrypt.so.1 ]]; then
  fetch_extract \
    "https://download.fedoraproject.org/pub/fedora/linux/releases/44/Everything/x86_64/os/Packages/l/libxcrypt-compat-4.5.2-3.fc44.x86_64.rpm" \
    .cache/libxcrypt-compat \
    "034224edcf30d52bec20a75e8e04912891fbcdbb3381c11963fa415c2608ae44"
fi

if ! command -v rpmbuild >/dev/null 2>&1 && [[ ! -x .cache/rpm-build/usr/bin/rpmbuild ]]; then
  fetch_extract \
    "https://download.fedoraproject.org/pub/fedora/linux/releases/44/Everything/x86_64/os/Packages/r/rpm-build-6.0.1-2.fc44.x86_64.rpm" \
    .cache/rpm-build \
    "6a5380b92a426198dae2deccbdf7c82b01f0a74b98ba97123eb253cd5230d773"
  fetch_extract \
    "https://download.fedoraproject.org/pub/fedora/linux/releases/44/Everything/x86_64/os/Packages/r/rpm-build-libs-6.0.1-2.fc44.x86_64.rpm" \
    .cache/rpm-build \
    "d5af54f4941f368c8957c826a7285f503d9e233aeeb8a4a8e7e218d2e08d25cf"
fi

if command -v rpmbuild >/dev/null 2>&1; then
  rpm_bin_dir="$(dirname "$(command -v rpmbuild)")"
else
  rpm_bin_dir="$PWD/.cache/rpm-build/usr/bin"
fi

printf 'LIBCRYPT_DIR=%q\n' "$PWD/.cache/libxcrypt-compat/usr/lib64"
printf 'RPMBUILD_BIN=%q\n' "$rpm_bin_dir"
