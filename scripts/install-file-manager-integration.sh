#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Aux Proton Drive Bridge"
APP_BIN="${APP_BIN:-aux-proton-drive-bridge}"
SHARE_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}"
USER_BIN="${HOME}/.local/bin/${APP_BIN}"
BIN_PATH="${BIN_PATH:-/usr/bin/${APP_BIN}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ASSET_DIR="${SCRIPT_DIR}/assets"
[[ -d "$ASSET_DIR" ]] || ASSET_DIR="${ROOT}/assets"

if [[ ! -x "$BIN_PATH" ]]; then
  resolved="$(command -v "$APP_BIN" || true)"
  [[ -n "$resolved" && "$resolved" != "$USER_BIN" ]] || {
    echo "Aux Proton Drive Bridge executable not found. Set BIN_PATH to the installed executable." >&2
    exit 1
  }
  BIN_PATH="$resolved"
fi

mkdir -p "${HOME}/.local/bin"
ln -sfn "$BIN_PATH" "$USER_BIN"

install_nautilus() {
  local script_dir="${SHARE_DIR}/nautilus/scripts/${APP_NAME}"
  mkdir -p "$script_dir"
  cat > "${script_dir}/Upload to Proton Drive" <<'SCRIPT'
#!/bin/sh
set -eu
if [ "$#" -eq 0 ] && [ -n "${NAUTILUS_SCRIPT_SELECTED_FILE_PATHS:-}" ]; then
  printf '%s\n' "$NAUTILUS_SCRIPT_SELECTED_FILE_PATHS" | while IFS= read -r selected; do
    [ -n "$selected" ] && "$HOME/.local/bin/aux-proton-drive-bridge" --upload --path "$selected"
  done
else
  for selected in "$@"; do
    "$HOME/.local/bin/aux-proton-drive-bridge" --upload --path "$selected"
  done
fi
SCRIPT
  chmod 755 "${script_dir}/Upload to Proton Drive"

  cat > "${script_dir}/Open Aux Proton Drive Bridge here" <<'SCRIPT'
#!/bin/sh
exec "$HOME/.local/bin/aux-proton-drive-bridge" --download-here "$PWD"
SCRIPT
  chmod 755 "${script_dir}/Open Aux Proton Drive Bridge here"
}

install_dolphin() {
  local menu_dir="${SHARE_DIR}/kio/servicemenus"
  mkdir -p "$menu_dir"
  cat > "${menu_dir}/aux-proton-drive-bridge.desktop" <<DESKTOP
[Desktop Entry]
Type=Service
Name=Aux Proton Drive Bridge actions
ServiceTypes=KonqPopupMenu/Plugin
MimeType=application/octet-stream;inode/directory;
Actions=uploadToProton;openHere;
X-KDE-Priority=TopLevel
X-KDE-Submenu=Aux Proton Drive Bridge

[Desktop Action uploadToProton]
Name=Upload to Proton Drive
Icon=aux-proton-drive-bridge
Exec="${USER_BIN}" --upload --path %f

[Desktop Action openHere]
Name=Open Aux Proton Drive Bridge here
Icon=aux-proton-drive-bridge
Exec="${USER_BIN}" --download-here %f
DESKTOP
  chmod 644 "${menu_dir}/aux-proton-drive-bridge.desktop"
}

install_thunar() {
  local actions_dir="${SHARE_DIR}/Thunar/sendto"
  mkdir -p "$actions_dir"
  cat > "${actions_dir}/aux-proton-drive-bridge.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Upload to Proton Drive
Icon=aux-proton-drive-bridge
Exec="${USER_BIN}" --upload --path %F
MimeType=application/octet-stream;inode/directory;
DESKTOP
  chmod 644 "${actions_dir}/aux-proton-drive-bridge.desktop"
}

install_icons() {
  local size source destination
  for size in 16 32 64 128 256 512; do
    source="${ASSET_DIR}/icon-${size}.png"
    [[ -f "$source" ]] || continue
    destination="${SHARE_DIR}/icons/hicolor/${size}x${size}/apps/aux-proton-drive-bridge.png"
    install -Dm644 "$source" "$destination"
  done
}

refresh_icon_caches() {
  # Best effort: stale desktop caches otherwise keep showing the previous icon.
  rm -f "${HOME}/.cache/icon-cache.kcache" 2>/dev/null || true
  command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
  command -v kbuildsycoca5 >/dev/null && kbuildsycoca5 >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t "${SHARE_DIR}/icons/hicolor" >/dev/null 2>&1 || true
  command -v xdg-desktop-menu >/dev/null && xdg-desktop-menu forceupdate >/dev/null 2>&1 || true
}

install_nautilus
install_dolphin
install_thunar
install_icons
refresh_icon_caches
printf 'File manager integration installed for Nautilus, Dolphin, and Thunar.\n'
