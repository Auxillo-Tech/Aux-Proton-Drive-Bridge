const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { DEFAULT_LOCAL_FOLDER, getStatus, parseListOutput, runProton } = require('./protonCli');
const { createOperationStore } = require('./operationStore');
const { createProfileStore } = require('./profileStore');
const { createSyncDb } = require('./syncDb');
const { createTransferQueue } = require('./transferQueue');
const { createConflictStore } = require('./conflictStore');
const { createSyncEngine, SYNC_MODES } = require('./syncEngine');
const { createAutoUpdater } = require('./autoUpdater');
const { createFuseMount, MOUNT_STATE } = require('./fuseMount');

app.disableHardwareAcceleration();

let mainWindow;
let operationStore;
let profileStore;
let syncDb;
let transferQueue;
let conflictStore;
let syncEngine;
let autoUpdater;
let fuseMount;
let tray;
let isQuitting = false;
let schedulerTimer;

// ── Lazy initializers ───────────────────────────────────────

function getOperationStore() {
  if (!operationStore) operationStore = createOperationStore(path.join(app.getPath('userData'), 'operations.json'));
  return operationStore;
}

function getProfileStore() {
  if (!profileStore) profileStore = createProfileStore(path.join(app.getPath('userData'), 'profiles.json'));
  return profileStore;
}

function getSyncDb() {
  if (!syncDb) syncDb = createSyncDb(path.join(app.getPath('userData'), 'sync-metadata.db'));
  return syncDb;
}

function getTransferQueue() {
  if (!transferQueue) {
    transferQueue = createTransferQueue({ concurrency: 2, syncDb: getSyncDb() });
    // Pipe transfer queue events to the renderer
    transferQueue.on('progress', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proton:progress', payload);
      }
    });
    transferQueue.on('complete', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proton:transferComplete', payload);
      }
    });
    transferQueue.on('error', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proton:transferError', payload);
      }
    });
  }
  return transferQueue;
}

function getConflictStore() {
  if (!conflictStore) conflictStore = createConflictStore(getSyncDb());
  return conflictStore;
}

function getSyncEngine() {
  if (!syncEngine) {
    syncEngine = createSyncEngine({
      syncDb: getSyncDb(),
      transferQueue: getTransferQueue(),
      conflictStore: getConflictStore()
    });
    syncEngine.on('local_change', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:localChange', payload);
    });
    syncEngine.on('remote_change', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:remoteChange', payload);
    });
    syncEngine.on('sync_complete', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:syncComplete', payload);
    });
    syncEngine.on('error', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:syncError', payload);
    });
  }
  return syncEngine;
}

function getAutoUpdater() {
  if (!autoUpdater) autoUpdater = createAutoUpdater({ currentVersion: app.getVersion() });
  return autoUpdater;
}

function getFuseMount() {
  if (!fuseMount) fuseMount = createFuseMount({ mountPoint: path.join(os.homedir(), 'ProtonDrive-FUSE') });
  return fuseMount;
}

// ── Progress/operation helpers ──────────────────────────────

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

// ── Window / Tray ───────────────────────────────────────────

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return tray;
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 24, height: 24 }));
  tray.setToolTip('Aux Proton Drive Bridge');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Aux Proton Drive Bridge', click: showMainWindow },
    { label: 'Run backup now', click: () => runDefaultBackupProfile().catch(err => sendProgress({ stream: 'stderr', text: err.message || String(err) })) },
    { type: 'separator' },
    { label: 'Sync now', click: () => getSyncEngine().scanNow().catch(err => sendProgress({ stream: 'stderr', text: err.message || String(err) })) },
    { label: 'Check for updates', click: () => getAutoUpdater().checkAndDownload().then(r => sendProgress({ stream: 'system', text: r.hasUpdate ? `Update ${r.update.version} available` : 'No update available' })).catch(err => sendProgress({ stream: 'stderr', text: err.message })) },
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
    width: 1400,
    height: 920,
    minWidth: 1000,
    minHeight: 700,
    title: 'Aux Proton Drive Bridge',
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

// ── IPC Handlers: Core operations ───────────────────────────

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
  // Validate local path is within home
  const resolved = path.resolve(localFolder);
  if (!resolved.startsWith(os.homedir())) throw new Error('Download destination must be under home directory');
  fs.mkdirSync(localFolder, { recursive: true });
  const result = await recordOperation('downloadPaths', { ...options, localFolder }, (eventSink) => runProton('download', { ...options, localFolder }, eventSink));
  return { ok: true, operationId: result.operationId, localFolder, stdout: result.stdout, stderr: result.stderr };
});
ipcMain.handle('proton:uploadPaths', async (_event, options = {}) => {
  // Validate all upload paths are within home
  const localPaths = Array.isArray(options.localPaths) ? options.localPaths : [];
  for (const p of localPaths) {
    if (!path.resolve(p).startsWith(os.homedir())) throw new Error('Upload paths must be under home directory');
  }
  const result = await recordOperation('uploadPaths', options, (eventSink) => runProton('upload', options, eventSink));
  return { ok: true, operationId: result.operationId, stdout: result.stdout, stderr: result.stderr };
});
ipcMain.handle('proton:getOperationHistory', async () => getOperationStore().list(50));
ipcMain.handle('proton:clearOperationHistory', async () => { getOperationStore().clear(); return []; });
ipcMain.handle('proton:getBackupProfile', async () => getProfileStore().getDefaultBackupProfile());
ipcMain.handle('proton:saveBackupProfile', async (_event, profile = {}) => getProfileStore().saveDefaultBackupProfile(profile));
ipcMain.handle('proton:runBackupProfile', async () => runDefaultBackupProfile());

// ── IPC Handlers: Sync Database ─────────────────────────────

ipcMain.handle('sync:getStats', async () => getSyncDb().getStats());
ipcMain.handle('sync:listTrackedFiles', async (_event, stateFilter) => getSyncDb().listTrackedFiles(stateFilter || null));
ipcMain.handle('sync:listFilesNeedingSync', async () => getSyncDb().listFilesNeedingSync(50));
ipcMain.handle('sync:getEvents', async (_event, fileId, limit) => getSyncDb().getEvents(fileId || null, limit || 50));
ipcMain.handle('sync:clearEvents', async () => { getSyncDb().clearEvents(); return true; });
ipcMain.handle('sync:countByState', async () => getSyncDb().countByState());
ipcMain.handle('sync:getTrackedFile', async (_event, remotePath) => getSyncDb().getTrackedFileByPath(remotePath));
ipcMain.handle('sync:saveCheckpoint', async () => getSyncDb().saveCheckpoint('manual'));

// ── IPC Handlers: Transfer Queue ────────────────────────────

ipcMain.handle('transfer:enqueue', async (_event, action, options, priority) => {
  return getTransferQueue().enqueue(action, options, priority);
});
ipcMain.handle('transfer:cancel', async (_event, id) => getTransferQueue().cancel(id));
ipcMain.handle('transfer:cancelAll', async () => getTransferQueue().cancelAll());
ipcMain.handle('transfer:pause', async () => { getTransferQueue().pause(); return true; });
ipcMain.handle('transfer:resume', async () => { getTransferQueue().resume(); return true; });
ipcMain.handle('transfer:getState', async () => getTransferQueue().getState());

// ── IPC Handlers: Conflicts ─────────────────────────────────

ipcMain.handle('conflict:listActive', async () => getConflictStore().listActive());
ipcMain.handle('conflict:listAll', async () => getConflictStore().listAll());
ipcMain.handle('conflict:resolve', async (_event, conflictId, strategy) => getConflictStore().resolve(conflictId, strategy));
ipcMain.handle('conflict:getStats', async () => getConflictStore().getStats());

// ── IPC Handlers: Sync Engine ───────────────────────────────

ipcMain.handle('sync:start', async (_event, syncMode, syncFolder, intervalMs) => {
  return getSyncEngine().start(syncMode, syncFolder, intervalMs);
});
ipcMain.handle('sync:stop', async () => { getSyncEngine().stop(); return true; });
ipcMain.handle('sync:scanNow', async () => getSyncEngine().scanNow());
ipcMain.handle('sync:getState', async () => getSyncEngine().getState());
ipcMain.handle('sync:setMode', async (_event, mode) => { getSyncEngine().setMode(mode); return true; });
ipcMain.handle('sync:setPollInterval', async (_event, ms) => { getSyncEngine().setPollInterval(ms); return true; });

// ── IPC Handlers: Auto-Update ───────────────────────────────

ipcMain.handle('update:check', async () => getAutoUpdater().checkForUpdates());
ipcMain.handle('update:checkAndDownload', async () => getAutoUpdater().checkAndDownload());
ipcMain.handle('update:download', async () => {
  const available = getAutoUpdater().getAvailableUpdate();
  if (!available) throw new Error('No update available. Check first.');
  return getAutoUpdater().downloadUpdate(available);
});
ipcMain.handle('update:apply', async (_event, downloadedAsset) => getAutoUpdater().applyUpdate(downloadedAsset));
ipcMain.handle('update:getAvailable', async () => getAutoUpdater().getAvailableUpdate());

// ── IPC Handlers: FUSE Mount ────────────────────────────────

ipcMain.handle('fuse:mount', async () => getFuseMount().mount());
ipcMain.handle('fuse:unmount', async () => getFuseMount().unmount());
ipcMain.handle('fuse:getStatus', async () => getFuseMount().getStatus());
ipcMain.handle('fuse:isAvailable', async () => getFuseMount().isFuseAvailable());

// ── App lifecycle ───────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createTray();
  startScheduler();
  // Start periodic update checks
  getAutoUpdater().startPeriodicCheck();
});
app.on('before-quit', async () => {
  isQuitting = true;
  try {
    // Stop timers
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    // Cancel all transfers
    if (transferQueue) transferQueue.destroy();
    // Stop sync engine
    if (syncEngine) { try { syncEngine.stop(); } catch {} }
    // Unmount FUSE
    if (fuseMount) { try { await fuseMount.destroy(); } catch {} }
    // Destroy tray
    if (tray) { tray.destroy(); tray = null; }
    // Stop auto-updater
    if (autoUpdater) autoUpdater.stopPeriodicCheck();
    // Close sync DB last
    if (syncDb) { try { syncDb.close(); } catch {} }
  } catch (err) {
    console.error('Shutdown error:', err);
  }
});
app.on('window-all-closed', () => {
  isQuitting = false;
  if (process.platform === 'darwin') return;
});
app.on('activate', () => { showMainWindow(); });
