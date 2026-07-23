const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { DEFAULT_LOCAL_FOLDER, getStatus, parseListOutput, runProton } = require('./protonCli');

app.disableHardwareAcceleration();

let mainWindow;

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
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proton:progress', payload);
}

ipcMain.handle('proton:getDefaultLocalFolder', async () => DEFAULT_LOCAL_FOLDER);
ipcMain.handle('proton:getStatus', async () => getStatus());
ipcMain.handle('proton:listMyFiles', async () => {
  const result = await runProton('list', { path: '/my-files' });
  return { items: parseListOutput(result.stdout), raw: result.stdout };
});
ipcMain.handle('proton:login', async () => {
  const result = await runProton('login', {}, sendProgress);
  return { ok: true, stdout: result.stdout, stderr: result.stderr };
});
ipcMain.handle('proton:logout', async () => {
  const result = await runProton('logout', {}, sendProgress);
  return { ok: true, stdout: result.stdout, stderr: result.stderr };
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
  const result = await runProton('download', { ...options, paths, localFolder }, sendProgress);
  return { ok: true, localFolder, stdout: result.stdout, stderr: result.stderr };
});
ipcMain.handle('proton:downloadPaths', async (_event, options = {}) => {
  const localFolder = options.localFolder || DEFAULT_LOCAL_FOLDER;
  fs.mkdirSync(localFolder, { recursive: true });
  const result = await runProton('download', { ...options, localFolder }, sendProgress);
  return { ok: true, localFolder, stdout: result.stdout, stderr: result.stderr };
});
ipcMain.handle('proton:uploadPaths', async (_event, options = {}) => {
  const result = await runProton('upload', options, sendProgress);
  return { ok: true, stdout: result.stdout, stderr: result.stderr };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
