'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const version = require(path.join(root, 'package.json')).version;
const executable = path.join(root, 'dist', `Aux.Proton.Drive.Bridge-${version}-x86_64.AppImage`);
if (!fs.existsSync(executable)) throw new Error(`Packaged AppImage not found: ${executable}`);
fs.chmodSync(executable, 0o755);
const result = spawnSync(process.execPath, [path.join(__dirname, 'e2e-source.js')], {
  cwd: root,
  env: { ...process.env, E2E_EXECUTABLE: executable },
  stdio: 'inherit',
  timeout: 120000
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
