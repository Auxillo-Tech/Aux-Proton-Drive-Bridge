'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Chromium in Electron 43 rejects --use-gl=swiftshader outright (GPU process exits);
// software GL must be requested through ANGLE via --use-angle=swiftshader.
const LINUX_GRAPHICS_WORKAROUNDS = new Map([
  ['1002:7550', { useAngle: 'swiftshader', reason: 'amd-navi48-7550' }]
]);

function normalizePciId(value) {
  return String(value || '').trim().toLowerCase().replace(/^0x/, '');
}

function detectLinuxGraphicsWorkaround(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'linux') return null;
  const env = options.env || process.env;
  if (env.AUX_PROTON_FORCE_SOFTWARE_GL === '1') {
    return { useAngle: 'swiftshader', reason: 'environment-override' };
  }
  const drmRoot = options.drmRoot || '/sys/class/drm';
  let cards;
  try {
    cards = fs.readdirSync(drmRoot, { withFileTypes: true })
      .filter(entry => /^card\d+$/.test(entry.name))
      .map(entry => entry.name);
  } catch {
    return null;
  }
  for (const card of cards) {
    try {
      const deviceRoot = path.join(drmRoot, card, 'device');
      const vendor = normalizePciId(fs.readFileSync(path.join(deviceRoot, 'vendor'), 'utf8'));
      const device = normalizePciId(fs.readFileSync(path.join(deviceRoot, 'device'), 'utf8'));
      const workaround = LINUX_GRAPHICS_WORKAROUNDS.get(`${vendor}:${device}`);
      if (workaround) return { ...workaround };
    } catch {}
  }
  return null;
}

module.exports = { detectLinuxGraphicsWorkaround, normalizePciId };
