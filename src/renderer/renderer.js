const api = window.auxProtonDriveBridge;
const state = { items: [], selected: new Set(), localFolder: '', backupProfile: null, syncDbStats: null };

const $ = (id) => document.getElementById(id);
const logOutput = $('logOutput');

function log(message, kind = 'info') {
  const ts = new Date().toLocaleTimeString();
  logOutput.textContent += `[${ts}] ${kind.toUpperCase()} ${message}\n`;
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

// ── Tab switching ───────────────────────────────────────────

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const tabBtn = $(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
  if (tabBtn) tabBtn.classList.add('active');
  const panel = $(`panel${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
  if (panel) panel.classList.add('active');
  // Refresh data on tab switch
  if (tabName === 'sync') refreshSyncDashboard();
  if (tabName === 'conflicts') refreshConflicts();
  if (tabName === 'queue') refreshQueue();
  if (tabName === 'fuse') refreshFuse();
}

// Tab click handlers
['Files', 'Sync', 'Conflicts', 'Queue', 'Fuse', 'Updates'].forEach(name => {
  const btn = $(`tab${name}`);
  if (btn) btn.addEventListener('click', () => switchTab(name.toLowerCase()));
});

// ── Original file listing ───────────────────────────────────

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
  return `/my-files/${String(name).replaceAll('/', '\\/')}`;
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

// ── Sync Dashboard ──────────────────────────────────────────

let syncStarted = false;

async function refreshSyncDashboard() {
  try {
    const stats = await api.sync.getStats();
    state.syncDbStats = stats;
    $('syncSynced').textContent = stats.byState?.synced || '0';
    const pending = (stats.byState?.pending_download || 0) + (stats.byState?.pending_upload || 0) +
                    (stats.byState?.local_new || 0) + (stats.byState?.remote_new || 0) +
                    (stats.byState?.local_modified || 0) + (stats.byState?.remote_modified || 0);
    $('syncPending').textContent = pending;
    $('syncConflicts').textContent = stats.byState?.conflict || '0';
    $('syncTotal').textContent = stats.fileCount || '0';
    $('syncEvents').textContent = stats.eventCount || '0';
    $('syncDbSize').textContent = stats.dbSize ? `${(stats.dbSize / 1024).toFixed(0)} KB` : '—';

    // Update conflict badge in tab
    const conflictCount = stats.byState?.conflict || 0;
    const badge = $('conflictBadge');
    if (conflictCount > 0) {
      badge.textContent = conflictCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    // Sync engine state
    const engineState = await api.syncEngine.getState();
    if (engineState) {
      $('syncIcon').textContent = engineState.isRunning ? '🔄' : (syncStarted ? '▶' : '⏸');
      $('syncStatusText').textContent = engineState.isRunning ? 'Syncing…' : syncStarted ? 'Active' : 'Idle';
    }

    // Pending items list
    const pendingItems = await api.sync.listFilesNeedingSync();
    const pendingList = $('syncPendingList');
    if (!pendingItems || !pendingItems.length) {
      pendingList.className = 'file-list empty';
      pendingList.textContent = 'No items pending sync.';
    } else {
      pendingList.className = 'file-list';
      pendingList.innerHTML = '';
      for (const item of pendingItems) {
        const row = document.createElement('div');
        row.className = 'file-row';
        row.style.gridTemplateColumns = '1fr auto';
        const name = document.createElement('span');
        name.textContent = item.remote_path;
        const state = document.createElement('span');
        state.className = `badge ${item.sync_state}`;
        state.textContent = item.sync_state;
        row.append(name, state);
        pendingList.append(row);
      }
    }
  } catch (err) {
    log(`Sync dashboard error: ${err.message}`, 'error');
  }
}

$('syncStartBtn').addEventListener('click', async () => {
  const mode = $('syncModeSelect').value;
  const interval = parseInt($('pollIntervalSelect').value, 10);
  try {
    await api.syncEngine.start(mode, null, interval);
    syncStarted = true;
    log(`Sync started: mode=${mode}, interval=${interval}ms`);
    refreshSyncDashboard();
  } catch (err) { log(`Sync start error: ${err.message}`, 'error'); }
});

$('syncStopBtn').addEventListener('click', async () => {
  try {
    await api.syncEngine.stop();
    syncStarted = false;
    log('Sync stopped');
    refreshSyncDashboard();
  } catch (err) { log(`Sync stop error: ${err.message}`, 'error'); }
});

$('syncScanNowBtn').addEventListener('click', async () => {
  log('Running sync scan…');
  try {
    const result = await api.syncEngine.scanNow();
    log(`Sync scan complete: ${result.queued || 0} queued, ${result.remaining || 0} remaining`);
    refreshSyncDashboard();
  } catch (err) { log(`Sync scan error: ${err.message}`, 'error'); }
});

$('syncRefreshBtn').addEventListener('click', refreshSyncDashboard);

// ── Conflicts ───────────────────────────────────────────────

async function refreshConflicts() {
  try {
    const conflicts = await api.conflict.listActive();
    const stats = await api.conflict.getStats();
    const container = $('conflictList');

    $('conflictStats').textContent = stats ? `${stats.open} open, ${stats.resolved} resolved` : '';

    if (!conflicts || !conflicts.length) {
      container.className = 'file-list empty';
      container.textContent = 'No conflicts detected.';
      return;
    }

    container.className = 'file-list';
    container.innerHTML = '';
    for (const conflict of conflicts) {
      const row = document.createElement('div');
      row.className = 'conflict-row';
      const info = document.createElement('div');
      info.innerHTML = `
        <div class="conflict-type">${conflict.type}</div>
        <div class="conflict-path">${conflict.remotePath}</div>
        <div class="conflict-reason">${conflict.reason}</div>
      `;
      const actions = document.createElement('div');
      actions.className = 'conflict-actions';
      ['keep_local', 'keep_remote', 'keep_both', 'skip'].forEach(strategy => {
        const btn = document.createElement('button');
        btn.className = 'secondary';
        btn.textContent = strategy.replace('_', ' ');
        btn.addEventListener('click', async () => {
          try {
            const result = await api.conflict.resolve(conflict.id, strategy);
            log(`Resolved conflict ${conflict.id}: ${strategy}`);
            refreshConflicts();
            refreshSyncDashboard();
          } catch (err) { log(`Conflict resolution error: ${err.message}`, 'error'); }
        });
        actions.append(btn);
      });
      row.append(info, actions);
      container.append(row);
    }
  } catch (err) {
    log(`Conflicts error: ${err.message}`, 'error');
  }
}

$('conflictRefreshBtn').addEventListener('click', refreshConflicts);

// ── Transfer Queue ──────────────────────────────────────────

async function refreshQueue() {
  try {
    const queueState = await api.transfer.getState();
    if (!queueState) return;

    // Active
    const activeContainer = $('queueActive');
    if (!queueState.active || !queueState.active.length) {
      activeContainer.className = 'file-list empty';
      activeContainer.textContent = 'No active transfers.';
    } else {
      activeContainer.className = 'file-list';
      activeContainer.innerHTML = '';
      for (const a of queueState.active) {
        const row = document.createElement('div');
        row.className = 'queue-row';
        row.innerHTML = `<span class="badge running">${a.action}</span><span>${a.id}</span><button class="secondary" onclick="cancelTransfer('${a.id}')">Cancel</button>`;
        activeContainer.append(row);
      }
    }

    // Pending
    const pendingContainer = $('queuePending');
    if (!queueState.pending || !queueState.pending.length) {
      pendingContainer.className = 'file-list empty';
      pendingContainer.textContent = 'No pending transfers.';
    } else {
      pendingContainer.className = 'file-list';
      pendingContainer.innerHTML = '';
      for (const p of queueState.pending) {
        const row = document.createElement('div');
        row.className = 'queue-row';
        row.innerHTML = `<span class="badge pending">${p.action}</span><span>${p.priority}</span><button class="secondary" onclick="cancelTransfer('${p.id}')">Cancel</button>`;
        pendingContainer.append(row);
      }
    }

    // Completed
    const completedContainer = $('queueCompleted');
    if (!queueState.recentCompleted || !queueState.recentCompleted.length) {
      completedContainer.className = 'file-list empty';
      completedContainer.textContent = 'No completed transfers yet.';
    } else {
      completedContainer.className = 'file-list';
      completedContainer.innerHTML = '';
      for (const c of queueState.recentCompleted) {
        const row = document.createElement('div');
        row.className = 'queue-row';
        const statusClass = c.status === 'succeeded' ? 'succeeded' : 'failed';
        row.innerHTML = `<span class="badge ${statusClass}">${c.action}</span><span>${c.status}</span><small>${formatWhen(c.completedAt)}</small>`;
        completedContainer.append(row);
      }
    }
  } catch (err) {
    log(`Queue refresh error: ${err.message}`, 'error');
  }
}

window.cancelTransfer = async (id) => {
  try { await api.transfer.cancel(id); refreshQueue(); }
  catch (err) { log(`Cancel error: ${err.message}`, 'error'); }
};

$('queuePauseBtn').addEventListener('click', async () => {
  try { await api.transfer.pause(); log('Queue paused'); refreshQueue(); }
  catch (err) { log(`Pause error: ${err.message}`, 'error'); }
});

$('queueResumeBtn').addEventListener('click', async () => {
  try { await api.transfer.resume(); log('Queue resumed'); refreshQueue(); }
  catch (err) { log(`Resume error: ${err.message}`, 'error'); }
});

$('queueCancelAllBtn').addEventListener('click', async () => {
  try {
    const result = await api.transfer.cancelAll();
    log(`Cancelled ${result.cancelledActive} active, ${result.cancelledPending} pending`);
    refreshQueue();
  } catch (err) { log(`Cancel all error: ${err.message}`, 'error'); }
});

// ── FUSE Mount ──────────────────────────────────────────────

async function refreshFuse() {
  try {
    const status = await api.fuse.getStatus();
    if (!status) return;

    const dot = $('fuseStateDot');
    dot.className = 'dot';
    if (status.isMounted) { dot.classList.add('ok');
      $('fuseStateText').textContent = `Mounted at ${status.mountPoint}`; }
    else if (status.state === 'error') { dot.classList.add('bad');
      $('fuseStateText').textContent = 'Error'; }
    else if (status.state === 'mounting') { dot.classList.add('warn');
      $('fuseStateText').textContent = 'Mounting…'; }
    else { dot.classList.add('bad');
      $('fuseStateText').textContent = 'Not mounted'; }

    $('fuseMountPoint').textContent = status.mountPoint || '~/ProtonDrive-FUSE';

    const errorEl = $('fuseError');
    if (status.error) {
      errorEl.textContent = `Error: ${status.error}`;
      errorEl.classList.remove('hidden');
    } else {
      errorEl.classList.add('hidden');
    }

    $('fuseMountBtn').disabled = !status.canMount;
    $('fuseUnmountBtn').disabled = !status.canUnmount;

    if (!status.isFuseAvailable) {
      log('FUSE is not available on this system. Install fuse3 package.', 'warn');
    }
  } catch (err) {
    log(`FUSE refresh error: ${err.message}`, 'error');
  }
}

$('fuseMountBtn').addEventListener('click', async () => {
  try {
    log('Mounting Proton Drive via FUSE…');
    const result = await api.fuse.mount();
    if (result.ok) log('FUSE mount successful');
    else log(`FUSE mount failed: ${result.error}`, 'error');
    refreshFuse();
  } catch (err) { log(`FUSE mount error: ${err.message}`, 'error'); }
});

$('fuseUnmountBtn').addEventListener('click', async () => {
  try {
    log('Unmounting…');
    await api.fuse.unmount();
    log('FUSE unmounted');
    refreshFuse();
  } catch (err) { log(`FUSE unmount error: ${err.message}`, 'error'); }
});

$('fuseRefreshBtn').addEventListener('click', refreshFuse);

// ── Updates ─────────────────────────────────────────────────

let lastUpdateCheck = null;
let updateCheckedThisSession = false;

async function refreshUpdates() {
  showStatus('info', 'Checking for updates…');
  try {
    const result = await api.update.check();
    updateCheckedThisSession = true;
    lastUpdateCheck = result;
    $('updateLatestVersion').textContent = result.latestVersion || (result.update?.version) || '—';

    const banner = $('updateBanner');
    if (result.hasUpdate) {
      banner.className = 'update-banner';
      banner.innerHTML = `
        <strong style="font-size:16px">✓ Update available: v${result.update.version}</strong><br/>
        <span>${formatWhen(result.update.publishedAt)}</span>
        ${result.update.body ? `<p style="margin-top:6px;opacity:.8">${result.update.body.slice(0, 300)}</p>` : ''}
      `;
      $('updateDownloadBtn').classList.remove('hidden');
      $('updateApplyBtn').classList.add('hidden');
      $('updateInstallHelp').classList.add('hidden');
      log(`Update available: v${result.update.version}`);
    } else if (result.error) {
      showStatus('error', `Update check failed: ${result.error}`);
      $('updateDownloadBtn').classList.add('hidden');
      $('updateApplyBtn').classList.add('hidden');
    } else {
      banner.className = 'update-banner';
      banner.innerHTML = `<strong>✓ You're up to date</strong><br/>
        <span>Installed v${result.currentVersion || '0.3.0'} — latest is v${result.latestVersion || '0.3.0'}</span>`;
      $('updateDownloadBtn').classList.add('hidden');
      $('updateApplyBtn').classList.add('hidden');
      $('updateInstallHelp').classList.add('hidden');
    }
    $('updateResult').classList.remove('hidden');
  } catch (err) {
    showStatus('error', `Update check failed: ${err.message}`);
    log(`Update check error: ${err.message}`, 'error');
  }
}

function showStatus(type, text) {
  const banner = $('updateBanner');
  banner.className = `update-banner ${type === 'error' ? 'error' : type === 'info' ? 'info' : ''}`;
  banner.textContent = text;
  $('updateResult').classList.remove('hidden');
}

// Auto-check on first tab switch to Updates
const _origSwitchTab = switchTab;
switchTab = function(name) {
  _origSwitchTab(name);
  if (name === 'updates' && !updateCheckedThisSession) {
    refreshUpdates();
  }
};

$('updateCheckBtn').addEventListener('click', refreshUpdates);

$('updateDownloadBtn').addEventListener('click', async () => {
  try {
    $('updateDownloadBtn').textContent = 'Downloading…';
    $('updateDownloadBtn').disabled = true;
    $('updateProgress').classList.remove('hidden');
    $('progressFill').style.width = '0%';
    $('updateProgressText').textContent = 'Starting download…';

    // Start download with animated progress indicator
    $('updateProgressText').textContent = 'Downloading update…';
    $('progressFill').style.width = '30%';

    const available = lastUpdateCheck?.update || await api.update.getAvailable();
    if (!available) {
      showStatus('error', 'No update available. Click "Check for updates" first.');
      return;
    }

    $('progressFill').style.width = '60%';
    const downloaded = await api.update.download(available);

    $('progressFill').style.width = '100%';
    $('updateProgressText').textContent = 'Download complete!';
    setTimeout(() => {
      $('updateProgress').classList.add('hidden');
    }, 1500);

    $('updateDownloadBtn').classList.add('hidden');
    $('updateApplyBtn').classList.remove('hidden');
    window._lastDownloadedAsset = downloaded;
    log(`Update downloaded: ${downloaded.name}`);

    // Show install help based on file type
    const helpEl = $('updateInstallHelp');
    const helpText = $('updateInstallText');
    if (downloaded.name.endsWith('.rpm')) {
      helpText.textContent = `sudo dnf install "${downloaded.filePath}"`;
    } else if (downloaded.name.endsWith('.deb')) {
      helpText.textContent = `sudo dpkg -i "${downloaded.filePath}"`;
    } else if (downloaded.name.endsWith('.AppImage')) {
      helpText.textContent = `chmod +x "${downloaded.filePath}" && "${downloaded.filePath}"`;
    } else {
      helpText.textContent = `Extract "${downloaded.name}" and replace the application files.`;
    }
    helpEl.classList.remove('hidden');

    $('updateBanner').innerHTML = `
      <strong>✓ Downloaded</strong><br/>
      <span>${downloaded.name} (${(downloaded.size / 1024 / 1024).toFixed(1)} MB)</span>
    `;
  } catch (err) {
    $('updateProgress').classList.add('hidden');
    showStatus('error', `Download failed: ${err.message}`);
    log(`Download error: ${err.message}`, 'error');
    $('updateDownloadBtn').textContent = 'Download update';
    $('updateDownloadBtn').disabled = false;
  }
});

$('updateApplyBtn').addEventListener('click', async () => {
  try {
    const asset = window._lastDownloadedAsset;
    if (!asset) { showStatus('error', 'No downloaded asset to apply. Download first.'); return; }
    const result = await api.update.apply(asset);
    log(`Update ready: ${result.method}`);
    $('updateBanner').innerHTML = `
      <strong>✓ Ready to install</strong><br/>
      <span>${result.instruction || 'Restart the app to use the new version.'}</span>
    `;
    // Show the install instructions again for reference
    const helpText = $('updateInstallText');
    if (result.instruction) helpText.textContent = result.instruction;
    $('updateInstallHelp').classList.remove('hidden');
  } catch (err) {
    showStatus('error', `Apply error: ${err.message}`);
    log(`Apply error: ${err.message}`, 'error');
  }
});

// ── Live event subscriptions ────────────────────────────────

api.onProgress(({ stream, text }) => log(text.trim(), stream === 'stderr' ? 'warn' : 'info'));
api.onTransferComplete((payload) => {
  log(`Transfer complete: ${payload.action}`, 'info');
  refreshHistory();
  refreshQueue();
});
api.onTransferError((payload) => {
  log(`Transfer error: ${payload.action} — ${payload.error}`, 'error');
  refreshQueue();
});
api.onSyncComplete((payload) => {
  refreshSyncDashboard();
  refreshConflicts();
});
api.onSyncError((payload) => {
  log(`Sync error: ${payload.message}`, 'error');
});
api.onLocalChange((payload) => log(`Local change: ${payload.type} ${payload.path}`, 'info'));
api.onRemoteChange((payload) => log(`Remote change: ${payload.type} ${payload.path}`, 'info'));

// ── Original button handlers ────────────────────────────────

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

// ── Boot ────────────────────────────────────────────────────

async function boot() {
  state.localFolder = await api.getDefaultLocalFolder();
  $('localFolderInput').value = state.localFolder;
  await refreshHistory();
  await refreshBackupProfile();
  const status = await refreshStatus();
  if (!status.busy && status.authenticated) refreshFiles().catch(err => log(err.message, 'error'));
  if (status.busy) log('Proton CLI cache is currently busy. Wait for the active download to finish, then refresh.', 'warn');
  // Load sync/fuse/conflict stats in background
  refreshSyncDashboard().catch(() => {});
  refreshFuse().catch(() => {});
}

boot().catch(err => log(err.message, 'error'));
