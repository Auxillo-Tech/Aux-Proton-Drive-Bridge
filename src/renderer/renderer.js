const api = window.auxProtonBridge;
const state = { items: [], selected: new Set(), localFolder: '', backupProfile: null };

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

function formatWhen(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function operationSummary(op) {
  const options = op.options || {};
  if (Array.isArray(options.paths) && options.paths.length) return options.paths.slice(0, 3).join(', ') + (options.paths.length > 3 ? ` +${options.paths.length - 3}` : '');
  if (Array.isArray(options.localPaths) && options.localPaths.length) return options.localPaths.slice(0, 3).join(', ') + (options.localPaths.length > 3 ? ` +${options.localPaths.length - 3}` : '');
  return options.path || options.localFolder || '—';
}

async function refreshHistory() {
  const history = await api.getOperationHistory();
  const container = $('operationHistory');
  if (!history.length) {
    container.className = 'history-list empty';
    container.textContent = 'No transfer history yet.';
    return;
  }
  container.className = 'history-list';
  container.innerHTML = '';
  for (const op of history) {
    const row = document.createElement('div');
    row.className = 'history-row';
    const action = document.createElement('strong');
    action.textContent = op.action;
    const status = document.createElement('span');
    status.className = `badge ${op.status}`;
    status.textContent = op.status;
    const summary = document.createElement('small');
    summary.textContent = operationSummary(op);
    const time = document.createElement('small');
    time.textContent = formatWhen(op.finishedAt || op.updatedAt || op.startedAt);
    row.append(action, status, summary, time);
    container.append(row);
  }
}

async function refreshBackupProfile() {
  const profile = await api.getBackupProfile();
  state.backupProfile = profile;
  $('backupEnabledInput').checked = Boolean(profile.enabled);
  $('backupRemoteInput').value = profile.remoteParentPath || '/my-files';
  renderBackupPaths();
  return profile;
}

function renderBackupPaths() {
  const list = $('backupPathList');
  const paths = state.backupProfile?.localPaths || [];
  if (!paths.length) {
    list.className = 'mini-list empty';
    list.textContent = 'No backup paths selected.';
    return;
  }
  list.className = 'mini-list';
  list.textContent = paths.join('\n');
}

function currentBackupProfileFromForm() {
  return {
    ...(state.backupProfile || {}),
    enabled: $('backupEnabledInput').checked,
    remoteParentPath: $('backupRemoteInput').value || '/my-files',
    localPaths: state.backupProfile?.localPaths || [],
    fileConflictStrategy: 'skip',
    folderConflictStrategy: 'merge',
    deletePropagation: false
  };
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
    await refreshHistory();
  } catch (err) {
    log(err?.message || String(err), 'error');
    await refreshHistory().catch(() => undefined);
  }
}

api.onProgress(({ stream, text }) => log(text.trim(), stream === 'stderr' ? 'warn' : 'info'));

$('refreshBtn').addEventListener('click', () => run('Refresh', refreshFiles));
$('loginBtn').addEventListener('click', () => run('Login', () => api.login()));
$('logoutBtn').addEventListener('click', () => run('Logout', () => api.logout()));
$('clearLogBtn').addEventListener('click', () => { logOutput.textContent = ''; });
$('clearHistoryBtn').addEventListener('click', () => run('Clear history', async () => {
  await api.clearOperationHistory();
  await refreshHistory();
  return { stdout: 'Transfer history cleared.' };
}));
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
$('chooseBackupPathsBtn').addEventListener('click', async () => {
  const localPaths = await api.chooseBackupPaths();
  if (!localPaths.length) return log('Backup path selection cancelled.', 'warn');
  state.backupProfile = { ...currentBackupProfileFromForm(), localPaths };
  renderBackupPaths();
});
$('saveBackupProfileBtn').addEventListener('click', () => run('Save backup profile', async () => {
  state.backupProfile = await api.saveBackupProfile(currentBackupProfileFromForm());
  renderBackupPaths();
  return { stdout: 'One-way backup profile saved.' };
}));
$('runBackupProfileBtn').addEventListener('click', () => run('Run backup profile', () => api.runBackupProfile()));

async function boot() {
  state.localFolder = await api.getDefaultLocalFolder();
  $('localFolderInput').value = state.localFolder;
  await refreshHistory();
  await refreshBackupProfile();
  const status = await refreshStatus();
  if (!status.busy && status.authenticated) refreshFiles().catch(err => log(err.message, 'error'));
  if (status.busy) log('Proton CLI cache is currently busy. Wait for the active download to finish, then refresh.', 'warn');
}

boot().catch(err => log(err.message, 'error'));
