const fs = require('node:fs');
const path = require('node:path');
const required = [
  'src/main/main.js',
  'src/main/preload.js',
  'src/main/protonCli.js',
  'src/main/operationStore.js',
  'src/main/profileStore.js',
  'src/renderer/index.html',
  'src/renderer/renderer.js',
  'src/renderer/styles.css'
];
for (const rel of required) {
  const p = path.join(__dirname, '..', rel);
  if (!fs.existsSync(p)) throw new Error(`Missing required file: ${rel}`);
}
const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
if (!main.includes('contextIsolation: true')) throw new Error('Electron contextIsolation must stay enabled');
if (!main.includes('nodeIntegration: false')) throw new Error('Renderer nodeIntegration must stay disabled');
if (!main.includes('sandbox: true')) throw new Error('Electron renderer sandbox must stay enabled');
const preload = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
for (const api of ['getDefaultLocalFolder', 'getStatus', 'listMyFiles', 'downloadAll', 'downloadPaths', 'uploadPaths', 'login', 'logout', 'getOperationHistory', 'clearOperationHistory', 'chooseBackupPaths', 'getBackupProfile', 'saveBackupProfile', 'runBackupProfile']) {
  if (!preload.includes(api)) throw new Error(`Preload API missing ${api}`);
}
// Check new modules exist
const newModules = ['syncDb.js', 'transferQueue.js', 'progressParser.js', 'conflictStore.js', 'syncEngine.js', 'autoUpdater.js', 'fuseMount.js', 'pathSafety.js', 'protonProcessLock.js', 'childProcessEnv.js'];
for (const mod of newModules) {
  const p = path.join(__dirname, '..', 'src/main', mod);
  if (!fs.existsSync(p)) throw new Error(`Missing new module: src/main/${mod}`);
}
// IPC handlers for new features
for (const api of ['sync:getStats', 'transfer:enqueue', 'conflict:listActive', 'sync:start', 'update:check', 'fuse:mount', 'profile:list', 'profile:save']) {
  if (!main.includes(api)) throw new Error(`IPC handler missing: ${api}`);
}
// Check new APIs in preload (use regex to handle nested object notation like `profile: { list: ... }`)
const apiChecks = {
  'profile.list': /profile:\s*\{[^}]*\blist\b\s*[:]/,
  'profile.save': /profile:\s*\{[^}]*\bsave\b\s*[:]/,
  'profile.getActive': /profile:\s*\{[^}]*\bgetActive\b\s*[:]/,
  'sync.getStats': /sync:\s*\{[^}]*\bgetStats\b\s*[:]/,
  'transfer.enqueue': /transfer:\s*\{[^}]*\benqueue\b\s*[:]/,
  'conflict.listActive': /conflict:\s*\{[^}]*\blistActive\b\s*[:]/,
  'syncEngine.start': /syncEngine:\s*\{[^}]*\bstart\b\s*[:]/,
  'update.check': /update:\s*\{[^}]*\bcheck\b\s*[:]/,
  'fuse.mount': /fuse:\s*\{[^}]*\bmount\b\s*[:]/
};
for (const [api, regex] of Object.entries(apiChecks)) {
  if (!regex.test(preload)) throw new Error(`Preload API missing: ${api}`);
}
if (!main.includes('assertTrustedIpcEvent')) throw new Error('IPC sender provenance guard is missing');
if (main.includes('ipcMain.handle(')) throw new Error('IPC handlers must be registered through trustedHandle');
if (!main.includes('protocol.registerSchemesAsPrivileged') || !main.includes("protocol.handle('app'") || !main.includes('mainWindow.loadURL(rendererUrl)')) {
  throw new Error('Secure custom renderer protocol is missing');
}
const afterPack = fs.readFileSync(path.join(__dirname, '..', 'scripts/after-pack.js'), 'utf8');
for (const requirement of ['strictlyRequireAllFuses: true', '[FuseV1Options.GrantFileProtocolExtraPrivileges]: false', '[FuseV1Options.OnlyLoadAppFromAsar]: true']) {
  if (!afterPack.includes(requirement)) throw new Error(`Electron fuse hardening is missing: ${requirement}`);
}
const rendererHtml = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
const rendererJs = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/renderer.js'), 'utf8');
if (/\sstyle\s*=/.test(rendererHtml)) throw new Error('Inline style attributes are blocked by the renderer CSP');
if (/\.style\.[A-Za-z]/.test(rendererJs)) throw new Error('Renderer style mutations are blocked by the renderer CSP');
for (const match of rendererJs.matchAll(/\.innerHTML\s*=\s*([^;\n]+)/g)) {
  if (!/^(['"])\1$/.test(match[1].trim())) throw new Error('Dynamic innerHTML assignment is not allowed');
}
// Check new docs and config files exist
const extraFiles = [
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'packaging/aur/README.md', 'packaging/flatpak/README.md',
  'assets/release-public-key.pem', 'scripts/release-signing.js', 'scripts/after-pack.js',
  'scripts/update-aur-metadata.js', 'scripts/e2e-source.js', 'scripts/e2e-packaged.js', 'scripts/e2e-restart.js',
  'scripts/test-installed-packages.sh', 'scripts/test-aur-package.sh', 'scripts/inspect-release-artifacts.js', 'scripts/patch-dependency-compat.js'
];
for (const f of extraFiles) {
  const p = path.join(__dirname, '..', f);
  if (!fs.existsSync(p)) throw new Error(`Missing file: ${f}`);
}
const removedFlatpak = path.join(__dirname, '..', 'dist/flatpak/tech.auxillo.auxprotondrivebridge.json');
if (fs.existsSync(removedFlatpak)) throw new Error('The unsupported Flatpak manifest must not be shipped');
const updater = fs.readFileSync(path.join(__dirname, '..', 'src/main/autoUpdater.js'), 'utf8');
if (!updater.includes('verifyChecksumManifestSignature')) throw new Error('Updater publisher signature verification is missing');
console.log('static checks passed');
