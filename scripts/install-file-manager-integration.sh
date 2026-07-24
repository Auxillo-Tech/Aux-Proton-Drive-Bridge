#!/bin/bash
#──────────────────────────────────────────────────────────────
# install-file-manager-integration.sh
#──────────────────────────────────────────────────────────────
# Install file manager integration for Aux Proton Drive Bridge.
#
# Adds:
#   - Nautilus (GNOME Files) context menu script
#   - Dolphin (KDE) service menu
#   - Thunar custom action
#   - MIME type association for proton-drive links
#──────────────────────────────────────────────────────────────

set -euo pipefail
APP_NAME="Aux Proton Drive Bridge"
APP_BIN="${APP_BIN:-aux-proton-drive-bridge}"
SHARE_DIR="${HOME}/.local/share"
BIN_PATH="${BIN_PATH:-/usr/bin/${APP_BIN}}"
USER_BIN="${HOME}/.local/bin/${APP_BIN}"

#──────────────────────────────────────────────────────────────
# Nautilus Scripts
#──────────────────────────────────────────────────────────────
install_nautilus() {
  local script_dir="${SHARE_DIR}/nautilus/scripts/${APP_NAME}"
  mkdir -p "$script_dir"

  # Sync to Proton Drive
  cat > "${script_dir}/Sync to Proton Drive" << 'SCRIPT'
#!/bin/bash
# Nautilus script: Sync selected files to Proton Drive
for file in "$@"; do
  "$HOME/.local/bin/aux-proton-drive-bridge" --upload --path "$file"
done
SCRIPT
  chmod +x "${script_dir}/Sync to Proton Drive"

  # Download here
  cat > "${script_dir}/Download from Proton Drive" << 'SCRIPT'
#!/bin/bash
# Nautilus script: Download Proton Drive file to current directory
exec "$HOME/.local/bin/aux-proton-drive-bridge" --download-here "$PWD"
SCRIPT
  chmod +x "${script_dir}/Download from Proton Drive"

  echo "  ✓ Nautilus scripts installed: $script_dir"
}

#──────────────────────────────────────────────────────────────
# Dolphin Service Menus
#──────────────────────────────────────────────────────────────
install_dolphin() {
  local menu_dir="${SHARE_DIR}/kio/servicemenus"
  mkdir -p "$menu_dir"

  cat > "${menu_dir}/auxillo-proton-drive-bridge.desktop" << DESKTOP
[Desktop Entry]
Type=Service
ServiceTypes=KonqPopupMenu/Plugin
MimeType=inode/directory;
Actions=syncToProton;uploadToProton;
X-KDE-Priority=TopLevel
X-KDE-Submenu=Aux Proton Drive Bridge

[Desktop Action syncToProton]
Name=Sync folder to Proton Drive
Icon=aux-proton-drive-bridge
Exec=${USER_BIN} --upload --path %f

[Desktop Action uploadToProton]
Name=Upload file to Proton Drive
Icon=aux-proton-drive-bridge
Exec=${USER_BIN} --upload --path %f
DESKTOP

  echo "  ✓ Dolphin service menu installed: $menu_dir"
}

#──────────────────────────────────────────────────────────────
# Thunar Custom Actions
#──────────────────────────────────────────────────────────────
install_thunar() {
  local actions_dir="${SHARE_DIR}/Thunar/sendto"
  mkdir -p "$actions_dir"

  cat > "${actions_dir}/aux-proton-drive-bridge.desktop" << DESKTOP
[Desktop Entry]
Type=Service
Name=Upload to Proton Drive
Icon=aux-proton-drive-bridge
Exec=${USER_BIN} --upload --path %f
X-XFCE-Actions-Handler=true
DESKTOP

  echo "  ✓ Thunar action installed: $actions_dir"
}

#──────────────────────────────────────────────────────────────
# Desktop Theme Icon
#──────────────────────────────────────────────────────────────
install_icon() {
  local icon_dir="${SHARE_DIR}/icons/hicolor"
  local icon_src="assets/icon.png"

  if [[ -f "$icon_src" ]]; then
    local sizes=(16 32 64 128 256 512)
    for size in "${sizes[@]}"; do
      local size_dir="${icon_dir}/${size}x${size}/apps"
      local variant=""
      if [[ -f "assets/icon-${size}.png" ]]; then
        mkdir -p "$size_dir"
        cp "assets/icon-${size}.png" "${size_dir}/aux-proton-drive-bridge.png"
      fi
    done
    echo "  ✓ Theme icons installed"
  fi
}

#──────────────────────────────────────────────────────────────
# MIME type
#──────────────────────────────────────────────────────────────
install_mime() {
  local mime_dir="${SHARE_DIR}/mime/packages"
  mkdir -p "$mime_dir"

  cat > "${mime_dir}/x-auxillo-proton-drive.xml" << XML
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-auxillo-proton-drive-link">
    <comment>Proton Drive link</comment>
    <glob pattern="*.proton-drive-link"/>
    <icon name="aux-proton-drive-bridge"/>
  </mime-type>
</mime-info>
XML

  update-mime-database "${SHARE_DIR}/mime" 2>/dev/null || true
  echo "  ✓ MIME type installed"
}

#──────────────────────────────────────────────────────────────
# Thumbnailer
#──────────────────────────────────────────────────────────────
install_thumbnailer() {
  local thumb_dir="${SHARE_DIR}/thumbnailers"
  mkdir -p "$thumb_dir"

  cat > "${thumb_dir}/aux-proton-drive-bridge.thumbnailer" << THUMB
[Thumbnailer Entry]
Type=X-Proton-Drive-Thumbnail;
Exec=${USER_BIN} --generate-thumbnail %i %o
MimeType=application/x-auxillo-proton-drive-link;
THUMB

  echo "  ✓ Thumbnailer installed"
}

#──────────────────────────────────────────────────────────────
# Main
#──────────────────────────────────────────────────────────────
echo "Installing file manager integration for ${APP_NAME}..."

install_nautilus
install_dolphin
install_thunar
install_icon
install_mime
install_thumbnailer

echo ""
echo "── Integration complete ──"
echo "Restart your file manager (nautilus -q, dolphin --refresh) to apply."
echo "Or log out and back in for MIME/icon changes to take effect."
