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
console.log('static checks passed');
