const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { DEFAULT_LOCAL_FOLDER, getStatus, parseListOutput, runProton } = require('./protonCli');
const { createOperationStore } = require('./operationStore');
const { createProfileStore } = require('./profileStore');

app.disableHardwareAcceleration();

let mainWindow;
let operationStore;
let profileStore;
let tray;
let isQuitting = false;
let schedulerTimer;

function getOperationStore() {
  if (!operationStore) operationStore = createOperationStore(path.join(app.getPath('userData'), 'operations.json'));
  return operationStore;
}

function getProfileStore() {
  if (!profileStore) profileStore = createProfileStore(path.join(app.getPath('userData'), 'profiles.json'));
  return profileStore;
}

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:progress', payload);
}

async function recordOperation(action, options, runner) {
  const store = getOperationStore();
  const op = store.begin(action, options);
  sendProgress({ operationId: op.id, stream: 'system', text: `${action} queued` });
  const eventSink = (payload) => {
    store.appendEvent(op.id, payload.stream, payload.text);
    sendProgress({ operationId: op.id, ...payload });
  };
  try {
    const result = await runner(eventSink, op);
    store.finish(op.id, 'succeeded', result);
    sendProgress({ operationId: op.id, stream: 'system', text: `${action} succeeded` });
    return { ...result, operationId: op.id };
  } catch (err) {
    store.finish(op.id, 'failed', { code: err?.result?.code, stdout: err?.result?.stdout, stderr: err?.result?.stderr, error: err?.message || String(err) });
    sendProgress({ operationId: op.id, stream: 'stderr', text: err?.message || String(err) });
    throw err;
  }
}

function validateBackupProfile(profile) {
  if (!profile.enabled) throw new Error('Backup profile is disabled. Enable and save it first.');
  if (!profile.localPaths.length) throw new Error('Backup profile has no local paths. Add folders/files first.');
}

async function runDefaultBackupProfile() {
  const profile = getProfileStore().getDefaultBackupProfile();
  validateBackupProfile(profile);
  const options = {
    localPaths: profile.localPaths,
    parentPath: profile.remoteParentPath || '/my-files',
    fileConflictStrategy: profile.fileConflictStrategy || 'skip',
    folderConflictStrategy: profile.folderConflictStrategy || 'merge',
    deletePropagation: false
  };
  const result = await recordOperation('runBackupProfile', options, (eventSink) => runProton('upload', options, eventSink));
  return { ok: true, operationId: result.operationId, stdout: result.stdout, stderr: result.stderr };
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return tray;
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Aux Proton Bridge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Aux Proton Bridge', click: showMainWindow },
    { label: 'Run backup now', click: () => runDefaultBackupProfile().catch(err => sendProgress({ stream: 'stderr', text: err.message || String(err) })) },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showMainWindow);
  return tray;
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    const profile = getProfileStore().getDefaultBackupProfile();
    if (!profile.enabled || !profile.localPaths.length) return;
    runDefaultBackupProfile().catch(err => sendProgress({ stream: 'stderr', text: err.message || String(err) }));
  }, 30 * 60 * 1000);
  schedulerTimer.unref?.();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: 'Aux Proton Bridge',
    backgroundColor: '#090b10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

ipcMain.handle('proton:getDefaultLocalFolder', async () => DEFAULT_LOCAL_FOLDER);
ipcMain.handle('proton:getStatus', async () => getStatus());
ipcMain.handle('proton:listMyFiles', async () => recordOperation('list', { path: '/my-files' }, async (eventSink) => {
  const result = await runProton('list', { path: '/my-files' }, eventSink);
  return { ...result, items: parseListOutput(result.stdout), raw: result.stdout };
}));
ipcMain.handle('proton:login', async () => {
  const result = await recordOperation('login', {}, (eventSink) => runProton('login', {}, eventSink));
  return { ok: true, operationId: result.operationId, stdout: result.stdout, stderr: result.stderr };
});
ipcMain.handle('proton:logout', async () => {
  const result = await recordOperation('logout', {}, (eventSink) => runProton('logout', {}, eventSink));
  return { ok: true, operationId: result.operationId, stdout: result.stdout, stderr: result.stderr };
});
ipcMain.handle('proton:chooseLocalFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], defaultPath: DEFAULT_LOCAL_FOLDER });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});
ipcMain.handle('proton:chooseUploadPaths', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'openDirectory', 'multiSelections'] });
  if (result.canceled) return [];
  return result.filePaths;
});
ipcMain.handle('proton:chooseBackupPaths', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'openDirectory', 'multiSelections'] });
  if (result.canceled) return [];
  return result.filePaths;
});
ipcMain.handle('proton:openFolder', async (_event, folder) => {
  const target = folder || DEFAULT_LOCAL_FOLDER;
  fs.mkdirSync(target, { recursive: true });
  await shell.openPath(target);
  return target;
});
ipcMain.handle('proton:downloadAll', async (_event, options = {}) => {
  const localFolder = options.localFolder || DEFAULT_LOCAL_FOLDER;
  fs.mkdirSync(localFolder, { recursive: true });
  const paths = Array.isArray(options.paths) && options.paths.length ? options.paths : ['/my-files'];
  const result = await recordOperation('downloadAll', { ...options, paths, localFolder }, (eventSink) => runProton('download', { ...options, paths, localFolder }, eventSink));
  return { ok: true, operationId: result.operationId, localFolder, stdout: result.stdout, stderr: result.stderr };
});
ipcMain.handle('proton:downloadPaths', async (_event, options = {}) => {
  const localFolder = options.localFolder || DEFAULT_LOCAL_FOLDER;
  fs.mkdirSync(localFolder, { recursive: true });
  const result = await recordOperation('downloadPaths', { ...options, localFolder }, (eventSink) => runProton('download', { ...options, localFolder }, eventSink));
  return { ok: true, operationId: result.operationId, localFolder, stdout: result.stdout, stderr: result.stderr };
});
ipcMain.handle('proton:uploadPaths', async (_event, options = {}) => {
  const result = await recordOperation('uploadPaths', options, (eventSink) => runProton('upload', options, eventSink));
  return { ok: true, operationId: result.operationId, stdout: result.stdout, stderr: result.stderr };
});
ipcMain.handle('proton:getOperationHistory', async () => getOperationStore().list(50));
ipcMain.handle('proton:clearOperationHistory', async () => { getOperationStore().clear(); return []; });
ipcMain.handle('proton:getBackupProfile', async () => getProfileStore().getDefaultBackupProfile());
ipcMain.handle('proton:saveBackupProfile', async (_event, profile = {}) => getProfileStore().saveDefaultBackupProfile(profile));
ipcMain.handle('proton:runBackupProfile', async () => runDefaultBackupProfile());

app.whenReady().then(() => {
  createWindow();
  createTray();
  startScheduler();
});
app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => { if (process.platform === 'darwin') return; });
app.on('activate', () => { showMainWindow(); });
