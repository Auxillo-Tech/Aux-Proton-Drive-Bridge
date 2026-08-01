'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ICON_SIZES = [16, 32, 64, 128, 256, 512];
const ICON_NAME = 'aux-proton-drive-bridge.png';

function defaultUserIconRoot() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'icons', 'hicolor');
}

// User-level hicolor icons shadow the system theme, so copies installed by an
// older release keep winning over every upgrade. Refresh any that exist but
// no longer match the bundled artwork. Files are only ever overwritten, never
// created: without a pre-existing user-level icon the system icon already wins.
function refreshUserIcons({ assetDir, userIconRoot = defaultUserIconRoot() } = {}) {
  const updated = [];
  if (!assetDir) return updated;
  for (const size of ICON_SIZES) {
    const source = path.join(assetDir, `icon-${size}.png`);
    const destination = path.join(userIconRoot, `${size}x${size}`, 'apps', ICON_NAME);
    try {
      if (!fs.existsSync(source) || !fs.existsSync(destination)) continue;
      const bundled = fs.readFileSync(source);
      if (bundled.equals(fs.readFileSync(destination))) continue;
      fs.writeFileSync(destination, bundled, { mode: 0o644 });
      updated.push(size);
    } catch {
      // Icon refresh is cosmetic best-effort; never disturb startup.
    }
  }
  return updated;
}

module.exports = { refreshUserIcons, ICON_SIZES, ICON_NAME };
