#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v podman >/dev/null || { printf 'podman is required for disposable AUR validation\n' >&2; exit 1; }
version="$(node -p "require('./package.json').version")"
appimage="Aux.Proton.Drive.Bridge-${version}-x86_64.AppImage"
[[ -f "dist/${appimage}" && -f dist/aur/PKGBUILD && -f dist/aur/.SRCINFO ]] || {
  printf 'Generate the x64 package and AUR metadata before AUR validation\n' >&2
  exit 1
}
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/dist" "$fixture/scripts"
cp "dist/${appimage}" dist/aur/PKGBUILD dist/aur/.SRCINFO dist/aur/LICENSE "$fixture/dist/"
cp scripts/smoke-source.js "$fixture/scripts/"
chmod -R a+rX "$fixture"
podman run --rm --network=host -v "$fixture:/work:ro,Z" docker.io/library/archlinux:latest bash -lc '
  set -euo pipefail
  pacman -Syu --noconfirm --needed base-devel nodejs xorg-server-xvfb dbus nss gtk3 alsa-lib libxss >/dev/null
  useradd -m builder
  install -d -o builder -g builder /home/builder/pkg /home/builder/src
  cp /work/dist/PKGBUILD /work/dist/.SRCINFO /work/dist/LICENSE /home/builder/pkg/
  cp /work/dist/*.AppImage /home/builder/src/
  chown -R builder:builder /home/builder/pkg /home/builder/src
  runuser -u builder -- bash -lc "cd /home/builder/pkg && makepkg --printsrcinfo > .SRCINFO.generated && diff -u .SRCINFO .SRCINFO.generated"
  runuser -u builder -- env SRCDEST=/home/builder/src bash -lc "cd /home/builder/pkg && makepkg --nodeps --noconfirm"
  package="$(find /home/builder/pkg -maxdepth 1 -name "*.pkg.tar.zst" -print -quit)"
  test -n "$package"
  bsdtar -tf "$package" > /tmp/aux-proton-package-files.txt
  grep -q "usr/bin/aux-proton-drive-bridge" /tmp/aux-proton-package-files.txt
  grep -q "opt/aux-proton-drive-bridge/aux-proton-drive-bridge" /tmp/aux-proton-package-files.txt
  grep -q "usr/share/licenses/aux-proton-drive-bridge/LICENSE" /tmp/aux-proton-package-files.txt
  pacman -U --noconfirm --assume-installed proton-drive-cli=0.6.0 "$package" >/dev/null
  useradd -m tester
  runuser -u tester -- env HOME=/home/tester SMOKE_EXECUTABLE=/usr/bin/aux-proton-drive-bridge \
    xvfb-run -a dbus-run-session -- node /work/scripts/smoke-source.js
  pacman -Rns --noconfirm aux-proton-drive-bridge-bin >/dev/null
  test ! -e /usr/bin/aux-proton-drive-bridge
'
printf 'AUR build, install, launch, and uninstall validation passed\n'
