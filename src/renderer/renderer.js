const api = window.auxProtonBridge;
const state = { items: [], selected: new Set(), localFolder: '' };

const $ = (id) => document.getElementById(id);
const logOutput = $('logOutput');

function log(message, kind = 'info') {
  const ts = new Date().toLocaleTimeString();
  logOutput.textContent += `[${ts}] ${kind.toUpperCase()} ${message}
`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function setStatus(status) {
  const dot = $('statusDot');
  dot.className = 'dot';
  if (status.busy) dot.classList.add('warn');
  else if (status.installed && status.authenticated) dot.classList.add('ok');
  else dot.classList.add('bad');
  $('statusText').textContent = status.busy ? 'Proton CLI busy' : status.installed ? (status.authenticated ? 'Ready' : 'Login needed') : 'CLI missing';
  $('versionText').textContent = status.version || status.error || 'No version available';
}

function renderFiles() {
  const list = $('fileList');
  if (!state.items.length) {
    list.className = 'file-list empty';
    list.textContent = 'No files loaded yet.';
    return;
  }
  list.className = 'file-list';
  list.innerHTML = '';
  for (const item of state.items) {
    const row = document.createElement('label');
    row.className = 'file-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(item.name);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(item.name); else state.selected.delete(item.name);
    });
    const icon = document.createElement('span');
    icon.textContent = item.type === 'folder' ? '🗂️' : '📄';
    const name = document.createElement('span');
    name.textContent = item.name;
    row.append(cb, icon, name);
    list.append(row);
  }
}

async function refreshStatus() {
  const status = await api.getStatus();
  setStatus(status);
  return status;
}

async function refreshFiles() {
  log('Listing /my-files…');
  const result = await api.listMyFiles();
  state.items = result.items;
  state.selected = new Set(result.items.filter(i => i.type === 'folder').map(i => i.name));
  renderFiles();
  log(`Loaded ${result.items.length} remote entries.`);
}

function remotePathForName(name) {
  return `/my-files/${String(name).replaceAll('/', '\/')}`;
}

async function run(label, fn) {
  try {
    log(`${label} started…`);
    const result = await fn();
    if (result?.stdout) log(result.stdout.trim());
    if (result?.stderr) log(result.stderr.trim(), 'warn');
    log(`${label} finished.`);
    await refreshStatus();
  } catch (err) {
    log(err?.message || String(err), 'error');
  }
}

api.onProgress(({ stream, text }) => log(text.trim(), stream === 'stderr' ? 'warn' : 'info'));

$('refreshBtn').addEventListener('click', () => run('Refresh', refreshFiles));
$('loginBtn').addEventListener('click', () => run('Login', () => api.login()));
$('logoutBtn').addEventListener('click', () => run('Logout', () => api.logout()));
$('clearLogBtn').addEventListener('click', () => { logOutput.textContent = ''; });
$('chooseFolderBtn').addEventListener('click', async () => {
  const folder = await api.chooseLocalFolder();
  if (folder) { state.localFolder = folder; $('localFolderInput').value = folder; }
});
$('localFolderInput').addEventListener('input', (event) => { state.localFolder = event.target.value; });
$('openFolderBtn').addEventListener('click', () => api.openFolder(state.localFolder));
$('downloadAllBtn').addEventListener('click', () => run('Download all', () => api.downloadAll({
  paths: state.items.length ? state.items.map(i => remotePathForName(i.name)) : ['/my-files'],
  localFolder: state.localFolder,
  fileConflictStrategy: 'skip',
  folderConflictStrategy: 'merge'
})));
$('downloadSelectedBtn').addEventListener('click', () => {
  const paths = [...state.selected].map(remotePathForName);
  if (!paths.length) return log('Nothing selected.', 'warn');
  return run('Download selected', () => api.downloadPaths({ paths, localFolder: state.localFolder, fileConflictStrategy: 'skip', folderConflictStrategy: 'merge' }));
});
$('uploadBtn').addEventListener('click', async () => {
  const localPaths = await api.chooseUploadPaths();
  if (!localPaths.length) return log('Upload cancelled.', 'warn');
  return run('Upload', () => api.uploadPaths({ localPaths, parentPath: '/my-files', fileConflictStrategy: 'skip', folderConflictStrategy: 'merge' }));
});

async function boot() {
  state.localFolder = await api.getDefaultLocalFolder();
  $('localFolderInput').value = state.localFolder;
  const status = await refreshStatus();
  if (!status.busy && status.authenticated) refreshFiles().catch(err => log(err.message, 'error'));
  if (status.busy) log('Proton CLI cache is currently busy. Wait for the active download to finish, then refresh.', 'warn');
}

boot().catch(err => log(err.message, 'error'));
