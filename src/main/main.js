const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const childProcess = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { DEFAULT_LOCAL_FOLDER, clearStatusCache, extractLoginUrl, getStatus, isAlreadyLoggedOutMessage, parseListOutput, runProton, shutdownProtonProcesses } = require('./protonCli');
const { createOperationStore, sanitizeForStorage } = require('./operationStore');
const { createProfileStore } = require('./profileStore');
const { createSyncDb } = require('./syncDb');
const { createTransferQueue } = require('./transferQueue');
const { createConflictStore } = require('./conflictStore');
const { createSyncEngine, normalizeIgnorePatterns } = require('./syncEngine');
const { createAutoUpdater } = require('./autoUpdater');
const { createFuseMount } = require('./fuseMount');
const { assertSafePathInside, isPathInside } = require('./pathSafety');
const { refreshUserIcons } = require('./iconRefresh');
const { buildChildEnv } = require('./childProcessEnv');
const { createProgressPersistenceGate } = require('./progressPersistence');

if (process.env.AUX_PROTON_DRIVE_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.AUX_PROTON_DRIVE_USER_DATA_DIR));
}

app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true, codeCache: true }
}]);
const hasSingleInstanceLock = app.requestSingleInstanceLock({ argv: process.argv.map(String) });
if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
  const commandLine = Array.isArray(additionalData?.argv) ? additionalData.argv : argv;
  handleExternalCommand(commandLine).catch(error => sendProgress({ stream: 'stderr', text: error.message || String(error) }));
});

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
let schedulerRunning = false;
let shutdownStarted = false;
let shutdownComplete = false;
const progressPersistence = createProgressPersistenceGate({ intervalMs: 1000 });
let externalLocalFolder = null;
const queuedOperations = new Map();
const grantedLocalPaths = new Set();
const applicationRoot = path.resolve(__dirname, '..', '..');
const rendererUrl = 'app://bundle/src/renderer/index.html';

function registerApplicationProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'bundle') return new Response('Not found', { status: 404 });
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const requestedPath = path.join(applicationRoot, relativePath);
    const allowedRoots = [path.join(applicationRoot, 'src', 'renderer'), path.join(applicationRoot, 'assets')];
    const allowedRoot = allowedRoots.find(root => isPathInside(requestedPath, root));
    if (!allowedRoot) return new Response(null, { status: 204 });
    const filePath = assertSafePathInside(requestedPath, allowedRoot, 'Application asset', { mustExist: true });
    return net.fetch(pathToFileURL(filePath).href);
  });
}

function assertTrustedIpcEvent(event) {
  const frame = event?.senderFrame;
  if (!mainWindow || mainWindow.isDestroyed() || !frame || frame !== mainWindow.webContents.mainFrame || frame.url !== rendererUrl) {
    throw new Error('IPC request rejected: untrusted renderer frame');
  }
}

function trustedHandle(channel, listener) {
  ipcMain['handle'](channel, (event, ...args) => {
    assertTrustedIpcEvent(event);
    return listener(event, ...args);
  });
}

function boundedString(value, label, max = 4096) {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

function grantLocalPath(localPath, options = {}) {
  const safePath = assertSafePathInside(localPath, os.homedir(), options.label || 'Local path', { mustExist: options.mustExist === true });
  grantedLocalPaths.add(safePath);
  return safePath;
}

function assertGrantedLocalPath(localPath, label, options = {}) {
  const safePath = assertSafePathInside(localPath, os.homedir(), label, { mustExist: options.mustExist === true });
  const granted = [...grantedLocalPaths].some(root => safePath === root || isPathInside(safePath, root));
  if (!granted) throw new Error(`${label} has not been approved through the file picker or a saved profile`);
  return safePath;
}

function validateRemotePath(remotePath, label = 'Remote path') {
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/my-files') ||
      (remotePath !== '/my-files' && !remotePath.startsWith('/my-files/')) || remotePath.includes('\0') ||
      remotePath.split('/').includes('..')) {
    throw new Error(`${label} must be inside /my-files`);
  }
  return remotePath;
}

function validateTransferOptions(action, options = {}) {
  if (action === 'upload') {
    const localPaths = Array.isArray(options.localPaths) ? options.localPaths : [];
    if (!localPaths.length || localPaths.length > 1000) throw new Error('Upload requires between 1 and 1000 local paths');
    const safePaths = localPaths.map(localPath => assertGrantedLocalPath(localPath, 'Upload path', { mustExist: true }));
    return {
      localPaths: safePaths,
      parentPath: validateRemotePath(options.parentPath || '/my-files', 'Upload destination'),
      fileConflictStrategy: ['keep-both', 'replace', 'skip'].includes(options.fileConflictStrategy) ? options.fileConflictStrategy : 'skip',
      folderConflictStrategy: ['merge', 'keep-both', 'replace', 'skip'].includes(options.folderConflictStrategy) ? options.folderConflictStrategy : 'merge',
      retries: Number.isFinite(Number(options.retries)) ? Math.min(3, Math.max(1, Math.trunc(Number(options.retries)))) : 3,
      logLevel: 'ERROR'
    };
  } else if (action === 'download') {
    const paths = Array.isArray(options.paths) && options.paths.length ? options.paths : ['/my-files'];
    if (paths.length > 1000) throw new Error('Download is limited to 1000 remote paths per operation');
    return {
      paths: paths.map(remotePath => validateRemotePath(remotePath)),
      localFolder: assertGrantedLocalPath(options.localFolder || DEFAULT_LOCAL_FOLDER, 'Download destination'),
      fileConflictStrategy: ['keep-both', 'replace', 'skip'].includes(options.fileConflictStrategy) ? options.fileConflictStrategy : 'skip',
      folderConflictStrategy: ['merge', 'keep-both', 'replace', 'skip'].includes(options.folderConflictStrategy) ? options.folderConflictStrategy : 'merge',
      retries: Number.isFinite(Number(options.retries)) ? Math.min(3, Math.max(1, Math.trunc(Number(options.retries)))) : 3,
      logLevel: 'ERROR'
    };
  }
  throw new Error(`Unsupported transfer action: ${action}`);
}

function parseExternalCommand(argv = []) {
  const args = argv.map(String);
  if (args.includes('--install-file-manager-integration')) return { action: 'install-file-manager-integration' };
  if (args.includes('--upload')) {
    const localPaths = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--path' && args[i + 1]) localPaths.push(args[++i]);
    }
    if (!localPaths.length) throw new Error('--upload requires at least one --path argument');
    return { action: 'upload', localPaths };
  }
  const downloadIndex = args.indexOf('--download-here');
  if (downloadIndex >= 0) {
    if (!args[downloadIndex + 1]) throw new Error('--download-here requires a folder path');
    return { action: 'open-download-folder', localFolder: args[downloadIndex + 1] };
  }
  return null;
}

function installFileManagerIntegration() {
  if (!app.isPackaged) throw new Error('Use npm run integration:file-manager from the source tree');
  const script = path.join(process.resourcesPath, 'integration', 'install-file-manager-integration.sh');
  if (!fs.statSync(script, { throwIfNoEntry: false })?.isFile()) throw new Error('File manager integration installer is missing');
  const bash = fs.existsSync('/usr/bin/bash') ? '/usr/bin/bash' : '/bin/bash';
  const executable = process.env.APPIMAGE || process.execPath;
  return new Promise((resolve, reject) => {
    childProcess.execFile(bash, [script], {
      env: buildChildEnv({ BIN_PATH: executable }),
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || error.message).trim()));
      resolve({ ok: true, message: (stdout || 'File manager integration installed').trim() });
    });
  });
}

async function handleExternalCommand(argv) {
  const command = parseExternalCommand(argv);
  if (!command) return null;
  if (command.action === 'install-file-manager-integration') {
    const result = await installFileManagerIntegration();
    try { new Notification({ title: 'Aux Proton Drive Bridge', body: 'File manager integration installed' }).show(); } catch {}
    return result;
  }
  if (command.action === 'upload') {
    for (const localPath of command.localPaths) grantLocalPath(localPath, { label: 'Upload path', mustExist: true });
    const options = validateTransferOptions('upload', {
      localPaths: command.localPaths,
      parentPath: '/my-files',
      fileConflictStrategy: 'skip',
      folderConflictStrategy: 'merge'
    });
    const result = enqueueRecordedTransfer('upload', options, 'medium');
    showMainWindow();
    return result;
  }
  externalLocalFolder = grantLocalPath(command.localFolder, { label: 'Download destination', mustExist: true });
  showMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('proton:externalDownloadFolder', { localFolder: externalLocalFolder });
  }
  return { ok: true, localFolder: externalLocalFolder };
}

// ── Lazy initializers ───────────────────────────────────────

function getOperationStore() {
  if (!operationStore) operationStore = createOperationStore(path.join(app.getPath('userData'), 'operations.json'));
  return operationStore;
}

function getProfileStore() {
  if (!profileStore) {
    profileStore = createProfileStore(path.join(app.getPath('userData'), 'profiles.json'));
    const saved = profileStore.getDefaultBackupProfile();
    for (const localPath of saved.localPaths || []) {
      try { grantLocalPath(localPath, { label: 'Saved backup path', mustExist: true }); } catch {}
    }
  }
  return profileStore;
}

function getSyncDb() {
  if (!syncDb) syncDb = createSyncDb(path.join(app.getPath('userData'), 'sync-metadata.db'));
  return syncDb;
}

function getTransferQueue() {
  if (!transferQueue) {
    transferQueue = createTransferQueue({ concurrency: 1, syncDb: getSyncDb() });
    // Pipe transfer queue events to the renderer
    transferQueue.on('progress', (payload) => {
      const operationId = queuedOperations.get(payload.id);
      if (operationId && progressPersistence.shouldPersist(payload.id, payload)) {
        getOperationStore().appendEvent(operationId, payload.stream || 'system', payload.text || '');
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proton:progress', sanitizeForStorage(payload));
      }
    });
    transferQueue.on('complete', (payload) => {
      progressPersistence.clear(payload.id);
      const operationId = queuedOperations.get(payload.id);
      if (operationId) {
        getOperationStore().finish(operationId, 'succeeded', payload.result);
        queuedOperations.delete(payload.id);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proton:transferComplete', sanitizeForStorage(payload));
      }
    });
    transferQueue.on('error', (payload) => {
      progressPersistence.clear(payload.id);
      const operationId = queuedOperations.get(payload.id);
      if (operationId) {
        getOperationStore().finish(operationId, 'failed', { error: payload.error });
        queuedOperations.delete(payload.id);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proton:transferError', sanitizeForStorage(payload));
      }
    });
    transferQueue.on('skipped', (payload) => {
      progressPersistence.clear(payload.id);
      const operationId = queuedOperations.get(payload.id);
      if (operationId) {
        getOperationStore().finish(operationId, 'skipped', payload.result);
        queuedOperations.delete(payload.id);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proton:transferError', sanitizeForStorage({ ...payload, error: `Proton Drive skipped ${payload.result?.summary?.totalSkipped || 1} item(s)` }));
      }
    });
    transferQueue.on('cancelled', (payload) => {
      progressPersistence.clear(payload.id);
      const operationId = queuedOperations.get(payload.id);
      if (operationId) {
        getOperationStore().finish(operationId, 'cancelled', { error: 'Cancelled' });
        queuedOperations.delete(payload.id);
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
      conflictStore: getConflictStore(),
      ignorePatterns: getProfileStore().getSettings().ignorePatterns
    });
    syncEngine.on('local_change', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:localChange', sanitizeForStorage(payload));
    });
    syncEngine.on('remote_change', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:remoteChange', sanitizeForStorage(payload));
    });
    syncEngine.on('activity', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:syncActivity', sanitizeForStorage(payload));
    });
    syncEngine.on('sync_complete', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:syncComplete', sanitizeForStorage(payload));
      try {
        if (payload.verified) new Notification({ title: 'Sync complete', body: 'All queued transfers were completed' }).show();
      } catch {}
    });
    syncEngine.on('error', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:syncError', sanitizeForStorage(payload));
      try {
        if (payload.message && !payload.message.includes('Skipping')) new Notification({ title: 'Sync error', body: payload.message }).show();
      } catch {}
    });
    syncEngine.on('sync_scan_complete', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:syncScanComplete', sanitizeForStorage(payload));
    });
    syncEngine.on('started', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:syncActivity', sanitizeForStorage({
        phase: 'scanning_local', message: 'Sync started', ...(payload || {})
      }));
    });
    syncEngine.on('stopped', (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:syncActivity', sanitizeForStorage({
        phase: 'idle', message: 'Sync stopped', ...(payload || {})
      }));
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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:progress', sanitizeForStorage(payload));
}

async function recordOperation(action, options, runner) {
  const store = getOperationStore();
  const op = store.begin(action, options);
  sendProgress({ operationId: op.id, stream: 'system', text: `${action} queued` });
  const eventSink = (payload) => {
    store.appendEvent(op.id, payload.stream, payload.text);
    sendProgress({ operationId: op.id, ...sanitizeForStorage(payload) });
  };
  try {
    const result = await runner(eventSink, op);
    store.finish(op.id, 'succeeded', result);
    sendProgress({ operationId: op.id, stream: 'system', text: `${action} succeeded` });
    return { ...sanitizeForStorage(result), operationId: op.id };
  } catch (err) {
    store.finish(op.id, 'failed', { code: err?.result?.code, stdout: err?.result?.stdout, stderr: err?.result?.stderr, error: err?.message || String(err) });
    sendProgress({ operationId: op.id, stream: 'stderr', text: err?.message || String(err) });
    throw err;
  }
}

function enqueueRecordedTransfer(action, options, priority = 'medium') {
  const cleanOptions = validateTransferOptions(action, options);
  const store = getOperationStore();
  const operation = store.begin(action, cleanOptions);
  try {
    const transferId = getTransferQueue().enqueue(action, cleanOptions, priority);
    queuedOperations.set(transferId, operation.id);
    store.appendEvent(operation.id, 'system', `${action} queued as ${transferId}`);
    return { ok: true, queued: true, operationId: operation.id, transferId };
  } catch (error) {
    store.finish(operation.id, 'failed', { error: error.message });
    throw error;
  }
}

function validateBackupProfile(profile) {
  if (!profile.enabled) throw new Error('Backup profile is disabled. Enable and save it first.');
  if (!profile.localPaths.length) throw new Error('Backup profile has no local paths. Add folders/files first.');
  validateRemotePath(profile.remoteParentPath || '/my-files', 'Backup destination');
  for (const localPath of profile.localPaths) {
    assertGrantedLocalPath(localPath, 'Backup path', { mustExist: true });
  }
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
  return enqueueRecordedTransfer('upload', options, 'low');
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
    { label: 'Check for updates', click: () => getAutoUpdater().checkForUpdates().then(r => sendProgress({ stream: 'system', text: r.hasUpdate ? `Update ${r.update.version} available` : 'No update available' })).catch(err => sendProgress({ stream: 'stderr', text: err.message })) },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showMainWindow);
  return tray;
}

function refreshStaleUserIcons() {
  try {
    const assetDir = app.isPackaged
      ? path.join(process.resourcesPath, 'integration', 'assets')
      : path.join(applicationRoot, 'assets');
    const updated = refreshUserIcons({ assetDir });
    if (!updated.length) return;
    // Nudge desktop icon caches so the refreshed artwork shows up; best-effort.
    try { fs.rmSync(path.join(app.getPath('home'), '.cache', 'icon-cache.kcache'), { force: true }); } catch {}
    for (const rebuild of ['kbuildsycoca6', 'kbuildsycoca5']) {
      try {
        const child = childProcess.spawn(rebuild, [], { stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
      } catch {}
    }
    console.log(`Refreshed stale user-level app icons: ${updated.join(', ')}px`);
  } catch {}
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    const profile = getProfileStore().getDefaultBackupProfile();
    if (!profile.enabled || !profile.localPaths.length || schedulerRunning) return;
    schedulerRunning = true;
    runDefaultBackupProfile()
      .catch(err => sendProgress({ stream: 'stderr', text: err.message || String(err) }))
      .finally(() => { schedulerRunning = false; });
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
      sandbox: true
    }
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.loadURL(rendererUrl);
}

// ── IPC Handlers: Core operations ───────────────────────────

trustedHandle('app:getVersion', async () => app.getVersion());
trustedHandle('proton:getDefaultLocalFolder', async () => externalLocalFolder || DEFAULT_LOCAL_FOLDER);
trustedHandle('proton:getStatus', async (_event, options = {}) => getStatus({ force: Boolean(options?.force) }));
trustedHandle('proton:listMyFiles', async () => recordOperation('list', { path: '/my-files' }, async (eventSink) => {
  const result = await runProton('list', { path: '/my-files' }, eventSink);
  return { code: result.code, items: parseListOutput(result.stdout) };
}));
trustedHandle('proton:login', async () => {
  clearStatusCache();
  const current = await getStatus({ force: true });
  if (current.authenticated) {
    return { ok: true, alreadyAuthenticated: true, message: 'Already signed in' };
  }
  let openedLoginUrl = null;
  const result = await recordOperation('login', {}, (eventSink) => runProton('login', {}, (payload) => {
    eventSink(payload);
    if (!openedLoginUrl && payload?.text) {
      const url = extractLoginUrl(payload.text);
      if (url) {
        openedLoginUrl = url;
        // Electron-spawned CLI often cannot open a browser because xdg-open needs
        // a fuller desktop session. Open the Proton login URL from the app itself.
        shell.openExternal(url).catch(() => {});
        sendProgress({ stream: 'system', text: `Login URL opened in browser (copy if needed): ${url}` });
      }
    }
  }));
  clearStatusCache();
  const after = await getStatus({ force: true });
  return {
    ok: true,
    authenticated: Boolean(after.authenticated),
    loginUrl: openedLoginUrl,
    operationId: result.operationId,
    stdout: result.stdout,
    stderr: result.stderr
  };
});
trustedHandle('proton:logout', async () => {
  clearStatusCache();
  const current = await getStatus({ force: true });
  if (!current.authenticated) {
    clearStatusCache();
    return { ok: true, alreadyLoggedOut: true, message: 'Already logged out' };
  }
  try {
    const result = await recordOperation('logout', {}, (eventSink) => runProton('logout', {}, eventSink));
    clearStatusCache();
    await getStatus({ force: true });
    return { ok: true, operationId: result.operationId, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const message = err?.message || String(err);
    // Treat interrupted/null-exit logout as success when CLI reports logged out afterward.
    clearStatusCache();
    const after = await getStatus({ force: true }).catch(() => ({ authenticated: true }));
    if (!after.authenticated || isAlreadyLoggedOutMessage(message)) {
      return { ok: true, recovered: true, message: 'Logged out (CLI session cleared)' };
    }
    throw err;
  }
});
trustedHandle('proton:chooseLocalFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], defaultPath: DEFAULT_LOCAL_FOLDER });
  if (result.canceled || !result.filePaths[0]) return null;
  return grantLocalPath(result.filePaths[0], { label: 'Selected folder', mustExist: true });
});
trustedHandle('proton:chooseUploadPaths', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'openDirectory', 'multiSelections'] });
  if (result.canceled) return [];
  return result.filePaths.map(localPath => grantLocalPath(localPath, { label: 'Selected upload path', mustExist: true }));
});
trustedHandle('proton:chooseBackupPaths', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'openDirectory', 'multiSelections'] });
  if (result.canceled) return [];
  return result.filePaths.map(localPath => grantLocalPath(localPath, { label: 'Selected backup path', mustExist: true }));
});
trustedHandle('proton:openFolder', async (_event, folder) => {
  const target = folder || DEFAULT_LOCAL_FOLDER;
  // Opening in the file manager only needs the path to be safe inside home; it must not
  // add the path to grantedLocalPaths, or the renderer could self-grant write capability.
  const safeTarget = assertSafePathInside(target, os.homedir(), 'Opened local folder');
  fs.mkdirSync(safeTarget, { recursive: true });
  // Fire and forget: shell.openPath can block indefinitely on some desktops, which
  // would leave this IPC reply (and the renderer button) hanging.
  shell.openPath(safeTarget).then(openError => {
    if (openError) console.warn(`Failed to open folder ${safeTarget}: ${openError}`);
  }).catch(() => {});
  return safeTarget;
});
trustedHandle('proton:downloadAll', async (_event, options = {}) => {
  const localFolder = assertGrantedLocalPath(options.localFolder || DEFAULT_LOCAL_FOLDER, 'Download destination');
  fs.mkdirSync(localFolder, { recursive: true });
  const paths = Array.isArray(options.paths) && options.paths.length ? options.paths : ['/my-files'];
  validateTransferOptions('download', { ...options, paths, localFolder });
  return { ...enqueueRecordedTransfer('download', { ...options, paths, localFolder }), localFolder };
});
trustedHandle('proton:downloadPaths', async (_event, options = {}) => {
  const localFolder = assertGrantedLocalPath(options.localFolder || DEFAULT_LOCAL_FOLDER, 'Download destination');
  validateTransferOptions('download', { ...options, localFolder });
  fs.mkdirSync(localFolder, { recursive: true });
  return { ...enqueueRecordedTransfer('download', { ...options, localFolder }), localFolder };
});
trustedHandle('proton:uploadPaths', async (_event, options = {}) => {
  return enqueueRecordedTransfer('upload', options);
});
trustedHandle('proton:getOperationHistory', async () => getOperationStore().list(50));
trustedHandle('proton:clearOperationHistory', async () => { getOperationStore().clear(); return []; });
trustedHandle('proton:getBackupProfile', async () => getProfileStore().getDefaultBackupProfile());
trustedHandle('proton:saveBackupProfile', async (_event, profile = {}) => {
  for (const localPath of Array.isArray(profile.localPaths) ? profile.localPaths : []) assertGrantedLocalPath(localPath, 'Backup path', { mustExist: true });
  if (profile.enabled) validateBackupProfile({ ...profile, localPaths: Array.isArray(profile.localPaths) ? profile.localPaths : [] });
  return getProfileStore().saveDefaultBackupProfile(profile);
});
trustedHandle('proton:runBackupProfile', async () => runDefaultBackupProfile());

// ── IPC Handlers: Multi-profile ─────────────────────────────

trustedHandle('profile:list', async () => getProfileStore().listProfiles());
trustedHandle('profile:get', async (_event, id) => getProfileStore().getProfile(boundedString(id, 'Profile ID', 128)));
trustedHandle('profile:save', async (_event, profile) => {
  for (const localPath of Array.isArray(profile?.localPaths) ? profile.localPaths : []) assertGrantedLocalPath(localPath, 'Backup path', { mustExist: true });
  if (profile?.enabled) validateBackupProfile({ ...profile, remoteParentPath: profile.remoteParentPath || '/my-files', localPaths: Array.isArray(profile.localPaths) ? profile.localPaths : [] });
  return getProfileStore().saveProfile(profile);
});
trustedHandle('profile:delete', async (_event, id) => getProfileStore().deleteProfile(boundedString(id, 'Profile ID', 128)));
trustedHandle('profile:getActive', async () => getProfileStore().getActiveProfiles());

// ── IPC Handlers: Sync Database ─────────────────────────────

trustedHandle('sync:getStats', async () => getSyncDb().getStats());
trustedHandle('sync:listTrackedFiles', async (_event, stateFilter) => getSyncDb().listTrackedFiles(stateFilter || null, 500));
trustedHandle('sync:listFilesNeedingSync', async () => getSyncDb().listFilesNeedingSync(50));
trustedHandle('sync:getEvents', async (_event, fileId, limit) => getSyncDb().getEvents(fileId || null, limit || 50));
trustedHandle('sync:clearEvents', async () => { getSyncDb().clearEvents(); return true; });
trustedHandle('sync:countByState', async () => getSyncDb().countByState());
trustedHandle('sync:getTrackedFile', async (_event, remotePath) => getSyncDb().getTrackedFileByPath(validateRemotePath(remotePath)));
trustedHandle('sync:saveCheckpoint', async () => getSyncDb().saveCheckpoint('manual'));

// ── IPC Handlers: Transfer Queue ────────────────────────────

trustedHandle('transfer:enqueue', async (_event, action, options, priority) => {
  const cleanOptions = validateTransferOptions(action, options);
  return getTransferQueue().enqueue(action, cleanOptions, priority);
});
trustedHandle('transfer:cancel', async (_event, id) => getTransferQueue().cancel(boundedString(id, 'Transfer ID', 128)));
trustedHandle('transfer:cancelAll', async () => getTransferQueue().cancelAll());
trustedHandle('transfer:pause', async () => { getTransferQueue().pause(); return true; });
trustedHandle('transfer:resume', async () => { getTransferQueue().resume(); return true; });
trustedHandle('transfer:getState', async () => getTransferQueue().getState());

// ── IPC Handlers: Conflicts ─────────────────────────────────

trustedHandle('conflict:listActive', async () => getConflictStore().listActive());
trustedHandle('conflict:listAll', async () => getConflictStore().listAll());
trustedHandle('conflict:resolve', async (_event, conflictId, strategy) => getSyncEngine().resolveConflict(
  boundedString(conflictId, 'Conflict ID', 128), boundedString(strategy, 'Conflict strategy', 64)
));
trustedHandle('conflict:getStats', async () => getConflictStore().getStats());

// ── IPC Handlers: Sync Engine ───────────────────────────────

trustedHandle('sync:start', async (_event, syncMode, syncFolder, intervalMs) => {
  const folder = assertGrantedLocalPath(syncFolder || DEFAULT_LOCAL_FOLDER, 'Sync folder');
  return getSyncEngine().start(syncMode, folder, intervalMs);
});
trustedHandle('sync:stop', async () => getSyncEngine().stop());
trustedHandle('sync:scanNow', async () => getSyncEngine().scanNow());
trustedHandle('sync:getState', async () => getSyncEngine().getState());
trustedHandle('sync:setMode', async (_event, mode) => { getSyncEngine().setMode(mode); return true; });
trustedHandle('sync:setPollInterval', async (_event, ms) => { getSyncEngine().setPollInterval(ms); return true; });
trustedHandle('sync:getIgnorePatterns', async () => getProfileStore().getSettings().ignorePatterns);
trustedHandle('sync:setIgnorePatterns', async (_event, patterns) => {
  if (!Array.isArray(patterns) || patterns.length > 100 || patterns.some(value => typeof value !== 'string' || value.length > 200)) {
    throw new Error('Ignore patterns must be an array of up to 100 strings (200 characters max each)');
  }
  const normalized = normalizeIgnorePatterns(patterns);
  getProfileStore().saveSettings({ ignorePatterns: normalized });
  getSyncEngine().setIgnorePatterns(normalized);
  return normalized;
});

// ── IPC Handlers: Auto-Update ───────────────────────────────

trustedHandle('update:check', async () => getAutoUpdater().checkForUpdates());
trustedHandle('update:checkAndDownload', async () => getAutoUpdater().checkAndDownload());
trustedHandle('update:download', async () => {
  const available = getAutoUpdater().getAvailableUpdate();
  if (!available) throw new Error('No update available. Check first.');
  return getAutoUpdater().downloadUpdate(available);
});
trustedHandle('update:apply', async (_event, downloadedAsset) => getAutoUpdater().applyUpdate(downloadedAsset));
trustedHandle('update:getAvailable', async () => getAutoUpdater().getAvailableUpdate());

// ── IPC Handlers: FUSE Mount ────────────────────────────────

trustedHandle('fuse:mount', async () => getFuseMount().mount());
trustedHandle('fuse:unmount', async () => getFuseMount().unmount());
trustedHandle('fuse:getStatus', async () => getFuseMount().getStatus());
trustedHandle('fuse:isAvailable', async () => getFuseMount().isFuseAvailable());

// ── App lifecycle ───────────────────────────────────────────

app.whenReady().then(async () => {
  const startupCommand = parseExternalCommand(process.argv);
  if (startupCommand?.action === 'install-file-manager-integration') {
    try {
      const result = await installFileManagerIntegration();
      console.log(result.message);
    } catch (error) {
      console.error(error.message || String(error));
      process.exitCode = 1;
    }
    shutdownComplete = true;
    app.quit();
    return;
  }
  registerApplicationProtocol();
  grantLocalPath(DEFAULT_LOCAL_FOLDER, { label: 'Default local folder' });
  try {
    const recovered = getOperationStore().recoverStaleRunning();
    if (recovered) console.log(`Recovered ${recovered} interrupted operation(s) from previous session`);
  } catch (error) {
    console.warn('Failed to recover interrupted operations:', error?.message || error);
  }
  createWindow();
  createTray();
  startScheduler();
  refreshStaleUserIcons();
  // Start periodic update checks
  getAutoUpdater().startPeriodicCheck();
  handleExternalCommand(process.argv).catch(error => sendProgress({ stream: 'stderr', text: error.message || String(error) }));
});
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  isQuitting = true;
  Promise.resolve().then(async () => {
    // Stop timers
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    // Stop sync engine
    if (syncEngine) { try { await syncEngine.stop(); } catch {} }
    // Unmount FUSE
    if (fuseMount) { try { await fuseMount.unmount(); } catch {} }
    // Cancel all transfers
    if (transferQueue) await transferQueue.destroy();
    shutdownProtonProcesses();
    // Destroy tray
    if (tray) { tray.destroy(); tray = null; }
    // Stop auto-updater
    if (autoUpdater) autoUpdater.stopPeriodicCheck();
    if (syncEngine) syncEngine.destroy();
    // Close sync DB last
    if (syncDb) { try { syncDb.close(); } catch {} }
  }).catch((err) => {
    console.error('Shutdown error:', err);
  }).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
});
app.on('activate', () => { showMainWindow(); });
