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
const preload = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
for (const api of ['getDefaultLocalFolder', 'getStatus', 'listMyFiles', 'downloadAll', 'downloadPaths', 'uploadPaths', 'login', 'logout', 'getOperationHistory', 'clearOperationHistory', 'chooseBackupPaths', 'getBackupProfile', 'saveBackupProfile', 'runBackupProfile']) {
  if (!preload.includes(api)) throw new Error(`Preload API missing ${api}`);
}
// Check new modules exist
const newModules = ['syncDb.js', 'transferQueue.js', 'progressParser.js', 'conflictStore.js', 'syncEngine.js', 'autoUpdater.js', 'fuseMount.js'];
for (const mod of newModules) {
  const p = path.join(__dirname, '..', 'src/main', mod);
  if (!fs.existsSync(p)) throw new Error(`Missing new module: src/main/${mod}`);
}
// IPC handlers for new features
for (const api of ['sync:getStats', 'transfer:enqueue', 'conflict:listActive', 'sync:start', 'update:check', 'fuse:mount', 'profile:list', 'profile:save']) {
  if (!main.includes(api)) throw new Error(`IPC handler missing: ${api}`);
}
// Check new APIs in preload
for (const api of ['profile.list', 'profile.save', 'profile.getActive', 'sync.getStats', 'transfer.enqueue', 'conflict.listActive', 'syncEngine.start', 'update.check', 'fuse.mount']) {
  if (!preload.includes(api)) throw new Error(`Preload API missing: ${api}`);
}
// Check new docs and config files exist
const extraFiles = ['LICENSE', 'dist/aur/PKGBUILD', 'dist/aur/.SRCINFO', 'dist/flatpak/tech.auxillo.auxprotondrivebridge.json'];
for (const f of extraFiles) {
  const p = path.join(__dirname, '..', f);
  if (!fs.existsSync(p)) throw new Error(`Missing file: ${f}`);
}
console.log('static checks passed');
