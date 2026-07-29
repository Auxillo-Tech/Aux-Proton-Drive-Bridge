#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

command -v podman >/dev/null || { printf 'podman is required for disposable package tests\n' >&2; exit 1; }
version="$(node -p "require('./package.json').version")"
deb="dist/Aux.Proton.Drive.Bridge-${version}-amd64.deb"
rpm="dist/Aux.Proton.Drive.Bridge-${version}-x86_64.rpm"
[[ -f "$deb" && -f "$rpm" ]] || { printf 'Current DEB/RPM artifacts are missing\n' >&2; exit 1; }

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
install -m 0644 "$deb" "$fixture/"
install -m 0644 "$rpm" "$fixture/"
install -m 0644 scripts/smoke-source.js "$fixture/smoke-source.js"
# mktemp dirs are 0700; package-test user inside the container must read them.
chmod 0755 "$fixture"
test -f "$fixture/smoke-source.js"
ls -la "$fixture"

printf 'Testing DEB install, GUI launch, shutdown, and uninstall...\n'
podman run --rm --pull=missing -v "$fixture:/fixture:ro,Z" docker.io/library/ubuntu:24.04 bash -lc '
  set -euo pipefail
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq /fixture/*.deb nodejs xvfb dbus-x11 procps libasound2t64 libnss3 libatk-bridge2.0-0t64 libgtk-3-0t64 libgbm1 libxshmfence1 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 >/tmp/apt-install.log || apt-get install -y -qq /fixture/*.deb nodejs xvfb dbus-x11 procps libasound2 libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libxshmfence1 >/tmp/apt-install.log
  test -x /usr/bin/aux-proton-drive-bridge
  useradd --create-home --shell /bin/bash package-test
  runuser -u package-test -- env HOME=/home/package-test SMOKE_EXECUTABLE=/usr/bin/aux-proton-drive-bridge xvfb-run -a dbus-run-session -- node /fixture/smoke-source.js
  runuser -u package-test -- env HOME=/home/package-test xvfb-run -a /usr/bin/aux-proton-drive-bridge --install-file-manager-integration
  test -L /home/package-test/.local/bin/aux-proton-drive-bridge
  test -x "/home/package-test/.local/share/nautilus/scripts/Aux Proton Drive Bridge/Upload to Proton Drive"
  test -f /home/package-test/.local/share/kio/servicemenus/aux-proton-drive-bridge.desktop
  test -f /home/package-test/.local/share/Thunar/sendto/aux-proton-drive-bridge.desktop
  test -f /home/package-test/.local/share/icons/hicolor/256x256/apps/aux-proton-drive-bridge.png
  runuser -u package-test -- env HOME=/home/package-test SMOKE_EXECUTABLE=/usr/bin/aux-proton-drive-bridge SMOKE_EXTRA_ARGS="[\"--download-here\",\"/home/package-test\"]" xvfb-run -a dbus-run-session -- node /fixture/smoke-source.js
  apt-get remove -y -qq aux-proton-drive-bridge >/tmp/apt-remove.log
  test ! -e /usr/bin/aux-proton-drive-bridge
'

printf 'Testing RPM install, GUI launch, shutdown, and uninstall...\n'
podman run --rm --pull=missing -v "$fixture:/fixture:ro,Z" registry.fedoraproject.org/fedora:44 bash -lc '
  set -euo pipefail
  dnf install -y -q /fixture/*.rpm nodejs xorg-x11-server-Xvfb dbus-daemon procps-ng alsa-lib nss at-spi2-atk gtk3 mesa-libgbm libX11 libxshmfence >/tmp/dnf-install.log
  test -x /usr/bin/aux-proton-drive-bridge
  useradd --create-home --shell /bin/bash package-test
  runuser -u package-test -- env HOME=/home/package-test SMOKE_EXECUTABLE=/usr/bin/aux-proton-drive-bridge xvfb-run -a dbus-run-session -- node /fixture/smoke-source.js
  runuser -u package-test -- env HOME=/home/package-test xvfb-run -a /usr/bin/aux-proton-drive-bridge --install-file-manager-integration
  test -L /home/package-test/.local/bin/aux-proton-drive-bridge
  test -x "/home/package-test/.local/share/nautilus/scripts/Aux Proton Drive Bridge/Upload to Proton Drive"
  test -f /home/package-test/.local/share/kio/servicemenus/aux-proton-drive-bridge.desktop
  test -f /home/package-test/.local/share/Thunar/sendto/aux-proton-drive-bridge.desktop
  test -f /home/package-test/.local/share/icons/hicolor/256x256/apps/aux-proton-drive-bridge.png
  runuser -u package-test -- env HOME=/home/package-test SMOKE_EXECUTABLE=/usr/bin/aux-proton-drive-bridge SMOKE_EXTRA_ARGS="[\"--download-here\",\"/home/package-test\"]" xvfb-run -a dbus-run-session -- node /fixture/smoke-source.js
  dnf remove -y -q aux-proton-drive-bridge >/tmp/dnf-remove.log
  test ! -e /usr/bin/aux-proton-drive-bridge
'

printf 'Disposable DEB and RPM package tests passed.\n'
