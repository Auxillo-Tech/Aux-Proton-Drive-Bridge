const api = window.auxProtonDriveBridge;
const state = { items: [], selected: new Set(), localFolder: '', backupProfile: null, syncDbStats: null };

const $ = (id) => document.getElementById(id);
const logOutput = $('logOutput');

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

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
  const ready = Boolean(status.installed && status.authenticated && !status.busy);
  for (const id of ['refreshBtn', 'downloadAllBtn', 'downloadSelectedBtn', 'uploadBtn', 'runBackupProfileBtn', 'syncStartBtn']) {
    if ($(id)) $(id).disabled = !ready;
  }
  if ($('loginBtn')) $('loginBtn').disabled = !status.installed || status.authenticated || status.busy;
  if ($('logoutBtn')) $('logoutBtn').disabled = !status.authenticated || status.busy;
}

// ── Tab switching ───────────────────────────────────────────

function switchTab(tabName) {
  currentTab = tabName;
  try { localStorage.setItem('aux-proton-last-tab', tabName); } catch {}
  document.querySelectorAll('.tab').forEach(t => {
    const selected = t.id === `tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`;
    t.classList.toggle('active', selected);
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    const selected = p.id === `panel${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`;
    p.classList.toggle('active', selected);
    p.hidden = !selected;
  });
  const tabBtn = $(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
  if (tabBtn) tabBtn.classList.add('active');
  const panel = $(`panel${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
  if (panel) panel.classList.add('active');
  // Refresh data on tab switch
  if (tabName === 'sync') refreshSyncDashboard();
  if (tabName === 'conflicts') refreshConflicts();
  if (tabName === 'queue') refreshQueue();
  if (tabName === 'fuse') refreshFuse();
  if (tabName === 'updates' && !updateCheckedThisSession) refreshUpdates();
  startAutoRefresh();
}

// Tab click handlers
['Files', 'Sync', 'Conflicts', 'Queue', 'Fuse', 'Updates'].forEach(name => {
  const btn = $(`tab${name}`);
  if (btn) btn.addEventListener('click', () => switchTab(name.toLowerCase()));
});
document.querySelector('.tab-bar')?.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('.tab')];
  let index = tabs.indexOf(document.activeElement);
  if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = tabs.length - 1;
  else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[index].focus();
  tabs[index].click();
});
document.querySelectorAll('.tab-panel').forEach(panel => {
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', panel.id.replace('panel', 'tab'));
  panel.hidden = !panel.classList.contains('active');
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

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    if (result?.queued) log(`${label} queued as ${result.transferId}.`, 'success');
    else log(`${label} finished.`);
    await refreshStatus();
    await refreshHistory();
  } catch (err) {
    log(err?.message || String(err), 'error');
    await refreshHistory().catch(() => undefined);
  }
}

// ── Sync Dashboard ──────────────────────────────────────────

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
      activityState.engineActive = Boolean(engineState.engineActive);
      $('syncIcon').textContent = engineState.isRunning ? '🔄' : (engineState.engineActive ? '▶' : '⏸');
      $('syncStatusText').textContent = engineState.isRunning ? 'Syncing…' : engineState.engineActive ? 'Active' : 'Stopped';
      updateSyncIndicator(Boolean(engineState.isRunning), $('syncStatusText').textContent);
      updateActivityBar();
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
        row.className = 'file-row compact';
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
    localStorage.setItem('aux-proton-default-sync-mode', mode);
    await api.syncEngine.start(mode, state.localFolder, interval);
    log(`Sync started: mode=${mode}, interval=${interval}ms`);
    refreshSyncDashboard();
  } catch (err) { log(`Sync start error: ${err.message}`, 'error'); }
});

$('syncStopBtn').addEventListener('click', async () => {
  try {
    await api.syncEngine.stop();

    log('Sync stopped');
    refreshSyncDashboard();
  } catch (err) { log(`Sync stop error: ${err.message}`, 'error'); }
});

$('syncScanNowBtn').addEventListener('click', async () => {
  log('Running sync scan…');
  try {
    const result = await api.syncEngine.scanNow();
    if (result?.ok === false || result?.skipped) {
      log(`Sync scan not completed: ${result.reason || 'remote state unavailable'}`, 'warn');
    } else {
      log(`Sync scan complete: ${result.queued || 0} queued, ${result.remaining || 0} remaining`);
    }
    refreshSyncDashboard();
  } catch (err) { log(`Sync scan error: ${err.message}`, 'error'); }
});

$('syncRefreshBtn').addEventListener('click', refreshSyncDashboard);

$('saveIgnorePatternsBtn').addEventListener('click', async () => {
  const patterns = $('ignorePatternsInput').value.split('\n').map(value => value.trim()).filter(Boolean);
  try {
    const saved = await api.syncEngine.setIgnorePatterns(patterns);
    $('ignorePatternsInput').value = saved.join('\n');
    $('ignorePatternsStatus').textContent = saved.length
      ? `${saved.length} pattern${saved.length === 1 ? '' : 's'} active`
      : 'No exclusions active';
    showToast('Excluded patterns saved', 'success');
    log(`Selective sync: ${saved.length} excluded pattern(s) saved`);
  } catch (err) {
    showToast(err.message, 'error');
    log(`Failed to save excluded patterns: ${err.message}`, 'error');
  }
});

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
      const localSize = conflict.localSize ? formatBytes(conflict.localSize) : '—';
      const remoteSize = conflict.remoteSize ? formatBytes(conflict.remoteSize) : '—';
      info.append(
        makeElement('div', 'conflict-type', conflict.type),
        makeElement('div', 'conflict-path', conflict.remotePath),
        makeElement('div', 'conflict-reason', conflict.reason)
      );
      const details = makeElement('details', 'conflict-diff');
      details.append(makeElement('summary', '', 'Show metadata diff'));
      const diff = makeElement('div', 'diff-container');
      const local = makeElement('div', 'diff-side local');
      local.append(
        makeElement('div', 'diff-header', 'Local'),
        makeElement('div', 'diff-item', `Size: ${localSize}`),
        makeElement('div', 'diff-item', `Modified: ${formatWhen(conflict.localModified)}`),
        makeElement('div', 'diff-item', `Hash: ${(conflict.localHash || '—').slice(0, 16)}`)
      );
      const remote = makeElement('div', 'diff-side remote');
      remote.append(
        makeElement('div', 'diff-header', 'Remote'),
        makeElement('div', 'diff-item', `Size: ${remoteSize}`),
        makeElement('div', 'diff-item', `Modified: ${formatWhen(conflict.remoteModified)}`),
        makeElement('div', 'diff-item', `Hash: ${(conflict.remoteHash || '—').slice(0, 16)}`)
      );
      diff.append(local, remote);
      details.append(diff);
      info.append(details);
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
        const cancel = makeElement('button', 'secondary', 'Cancel');
        cancel.addEventListener('click', () => window.cancelTransfer(a.id));
        row.append(makeElement('span', 'badge running', a.action), makeElement('span', '', a.id), cancel);
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
        const cancel = makeElement('button', 'secondary', 'Cancel');
        cancel.addEventListener('click', () => window.cancelTransfer(p.id));
        row.append(makeElement('span', 'badge pending', p.action), makeElement('span', '', p.priority), cancel);
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
        row.append(
          makeElement('span', `badge ${statusClass}`, c.action),
          makeElement('span', '', c.status),
          makeElement('small', '', formatWhen(c.completedAt))
        );
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
      const reason = status.capabilityReason || 'FUSE is unavailable on this system.';
      errorEl.textContent = reason;
      errorEl.classList.remove('hidden');
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

function renderUpdateBanner(banner, title, detail, body = '') {
  banner.replaceChildren();
  banner.append(makeElement('strong', '', title));
  if (detail) banner.append(document.createElement('br'), makeElement('span', '', detail));
  if (body) banner.append(makeElement('p', '', body));
}

async function refreshUpdates() {
  showStatus('info', 'Checking for updates…');
  try {
    const result = await api.update.check();
    updateCheckedThisSession = true;
    lastUpdateCheck = result;
    if (result.currentVersion) $('updateCurrentVersion').textContent = result.currentVersion;
    $('updateLatestVersion').textContent = result.latestVersion || (result.update?.version) || '—';

    const banner = $('updateBanner');
    if (result.hasUpdate) {
      banner.className = 'update-banner';
      renderUpdateBanner(banner, `✓ Update available: v${result.update.version}`,
        formatWhen(result.update.publishedAt), result.update.body ? result.update.body.slice(0, 300) : '');
      $('updateDownloadBtn').classList.remove('hidden');
      $('updateApplyBtn').classList.add('hidden');
      $('updateInstallHelp').classList.add('hidden');
      log(`Update available: v${result.update.version}`);
    } else if (result.error) {
      const isNetworkError = result.error.includes('ENOTFOUND') || result.error.includes('ETIMEDOUT') || result.error.includes('EAI_AGAIN') || result.error.includes('timed out');
      if (isNetworkError) {
        $('updateLatestVersion').textContent = '⚠ Offline';
        banner.className = 'update-banner info';
        renderUpdateBanner(banner, "⚠ You're offline", "Can't check for updates. Connect to the internet and try again.");
      } else {
        showStatus('error', `Update check failed: ${result.error}`);
      }
      $('updateDownloadBtn').classList.add('hidden');
      $('updateApplyBtn').classList.add('hidden');
    } else {
      banner.className = 'update-banner';
      renderUpdateBanner(banner, "✓ You're up to date",
        `Installed v${result.currentVersion || 'unknown'} · latest is v${result.latestVersion || 'unknown'}`);
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

$('updateCheckBtn').addEventListener('click', refreshUpdates);

$('updateDownloadBtn').addEventListener('click', async () => {
  try {
    $('updateDownloadBtn').textContent = 'Downloading…';
    $('updateDownloadBtn').disabled = true;
    $('updateProgress').classList.remove('hidden');
    $('progressFill').classList.remove('complete');
    $('updateProgressText').textContent = 'Starting download…';

    const available = lastUpdateCheck?.update || await api.update.getAvailable();
    if (!available) {
      showStatus('error', 'No update available. Click "Check for updates" first.');
      $('updateProgress').classList.add('hidden');
      $('updateDownloadBtn').textContent = 'Download update';
      $('updateDownloadBtn').disabled = false;
      return;
    }

    // Real progress tracking from download response
    const downloaded = await api.update.download(available);

    $('progressFill').classList.add('complete');
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
      helpText.textContent = `sudo rpm -Uvh "${downloaded.filePath}"`;
    } else if (downloaded.name.endsWith('.deb')) {
      helpText.textContent = `sudo dpkg -i "${downloaded.filePath}"`;
    } else if (downloaded.name.endsWith('.AppImage')) {
      helpText.textContent = `chmod +x "${downloaded.filePath}" && "${downloaded.filePath}"`;
    } else {
      helpText.textContent = `Extract "${downloaded.name}" and replace the application files.`;
    }
    helpEl.classList.remove('hidden');

    renderUpdateBanner($('updateBanner'), '✓ Downloaded and verified',
      `${downloaded.name} (${(downloaded.size / 1024 / 1024).toFixed(1)} MB)`);
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
    renderUpdateBanner($('updateBanner'), '✓ Ready to install',
      result.instruction || 'Restart the app to use the new version.');
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

let autoRefreshTimer = null;
const AUTO_REFRESH_MS = 5000; // 5 seconds
let currentTab = 'files';
let activityState = { syncing: false, uploading: 0, downloading: 0, lastSync: '—', engineActive: false };

function startAutoRefresh() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(() => {
    refreshCurrentTab();
  }, AUTO_REFRESH_MS);
}

async function refreshCurrentTab() {
  try {
    // Always keep CLI status fresh
    await refreshStatus();
    switch (currentTab) {
      case 'sync': refreshSyncDashboard(); break;
      case 'conflicts': refreshConflicts(); break;
      case 'queue': refreshQueue(); break;
      case 'fuse': refreshFuse(); break;
    }
  } catch { /* silent — background refresh shouldn't spam */ }
}

// ── Live activity bar ─────────────────────────────────────

function updateActivityBar() {
  const bar = $('activityBar');
  if (!bar) return;
  const { syncing, uploading, downloading, lastSync, engineActive } = activityState;

  if (uploading > 0 || downloading > 0) {
    bar.className = 'activity-bar active';
    const parts = [];
    if (uploading > 0) parts.push(`↑ ${uploading} uploading`);
    if (downloading > 0) parts.push(`↓ ${downloading} downloading`);
    bar.textContent = `🔄 ${parts.join(' · ')}`;
  } else if (syncing) {
    bar.className = 'activity-bar active';
    bar.textContent = '🔄 Scanning for changes…';
  } else if (engineActive) {
    bar.className = 'activity-bar';
    bar.textContent = `✓ All synced · Last sync: ${lastSync}`;
  } else {
    bar.className = 'activity-bar';
    bar.textContent = 'Sync stopped';
  }
}

// ── Sync indicator in header ──────────────────────────────

function updateSyncIndicator(isRunning, statusText) {
  const indicator = $('syncIndicator');
  if (!indicator) return;
  $('syncIcon').textContent = isRunning ? '🔄' : '▶';
  $('syncStatusText').textContent = statusText || (isRunning ? 'Syncing' : 'Idle');
  indicator.className = 'sync-indicator' + (isRunning ? ' syncing' : '');
}

// ── Toast notifications ───────────────────────────────────

function showToast(message, type = 'info', duration = 4000) {
  const container = $('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── IPC event handlers ────────────────────────────────────

api.onProgress((payload = {}) => {
  const { stream, text, action } = payload;
  const message = typeof text === 'string' ? text.trim() : '';
  if (message) log(message, stream === 'stderr' ? 'warn' : 'info');
  // Update activity counts from progress lines
  if ((message && message.includes('%')) || Number.isFinite(payload.percent)) {
    activityState.syncing = true;
    activityState.uploading = message.includes('Upload') || message.includes('upload') || action === 'upload' ? 1 : activityState.uploading;
    activityState.downloading = message.includes('Download') || message.includes('download') || action === 'download' ? 1 : activityState.downloading;
    updateActivityBar();
  }
});

api.onTransferComplete((payload) => {
  log(`Transfer complete: ${payload.action}`, 'info');
  activityState.syncing = false;
  activityState.uploading = 0;
  activityState.downloading = 0;
  activityState.lastSync = new Date().toLocaleTimeString();
  updateActivityBar();
  refreshSyncDashboard().catch(() => {});
  showToast(`✓ ${payload.action} completed`, 'success');
  refreshHistory();
  refreshQueue();
  // Refresh file list if on Files tab
  if (currentTab === 'files') refreshFiles().catch(() => {});
});

api.onTransferError((payload) => {
  log(`Transfer error: ${payload.action} — ${payload.error}`, 'error');
  activityState.uploading = 0;
  activityState.downloading = 0;
  updateActivityBar();
  showToast(`✗ ${payload.error}`, 'error', 6000);
  refreshQueue();
});

api.onExternalDownloadFolder((payload) => {
  if (!payload?.localFolder) return;
  state.localFolder = payload.localFolder;
  $('localFolderInput').value = payload.localFolder;
  showToast('Download folder selected from your file manager.', 'success');
});

api.onSyncComplete((payload) => {
  log(payload.verified ? 'Sync completed and verified.' : 'Sync scan completed.', 'info');
  activityState.lastSync = new Date().toLocaleTimeString();
  activityState.syncing = false;
  updateActivityBar();
  refreshSyncDashboard().catch(() => {});
  refreshConflicts().catch(() => {});
});

api.onSyncError((payload) => {
  log(`Sync error: ${payload.message}`, 'error');
  activityState.syncing = false;
  updateActivityBar();
  showToast(`✗ Sync error: ${payload.message}`, 'error', 6000);
});

api.onLocalChange((payload) => {
  log(`Local change: ${payload.type} ${payload.path}`, 'info');
  activityState.syncing = true;
  updateActivityBar();
  updateSyncIndicator(true, 'Scanning');
});

api.onRemoteChange((payload) => {
  log(`Remote change: ${payload.type} ${payload.path}`, 'info');
  activityState.syncing = true;
  updateActivityBar();
});

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
$('openFolderBtn').addEventListener('click', () => {
  const folder = state.localFolder || $('localFolderInput')?.value || '';
  run('Open local folder', () => api.openFolder(folder));
});
$('downloadAllBtn').addEventListener('click', () => {
  if (!state.items.length) return log('Refresh the remote file list before downloading everything.', 'warn');
  return run('Download all', () => api.downloadAll({
    paths: state.items.map(i => remotePathForName(i.name)),
    localFolder: state.localFolder,
    fileConflictStrategy: 'skip',
    folderConflictStrategy: 'merge'
  }));
});
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
  const appVersion = await api.getAppVersion();
  $('updateCurrentVersion').textContent = appVersion;
  state.localFolder = await api.getDefaultLocalFolder();
  $('localFolderInput').value = state.localFolder;

  // Persist last used sync mode as default
  const savedMode = localStorage.getItem('aux-proton-default-sync-mode');
  const modeSel = $('syncModeSelect');
  if (savedMode && modeSel) {
    const has = [...modeSel.options].some(o => o.value === savedMode);
    if (has) modeSel.value = savedMode;
  }
  if (modeSel) {
    modeSel.addEventListener('change', () => {
      localStorage.setItem('aux-proton-default-sync-mode', modeSel.value);
    });
  }

  // Persist last used poll interval as default
  const savedInterval = localStorage.getItem('aux-proton-default-poll-interval');
  const intervalSel = $('pollIntervalSelect');
  if (intervalSel) {
    if (savedInterval && [...intervalSel.options].some(o => o.value === savedInterval)) intervalSel.value = savedInterval;
    intervalSel.addEventListener('change', () => {
      localStorage.setItem('aux-proton-default-poll-interval', intervalSel.value);
    });
  }

  // Restore the tab that was open when the app was last used
  const savedTab = localStorage.getItem('aux-proton-last-tab');
  if (savedTab && savedTab !== 'files' && $(`tab${savedTab.charAt(0).toUpperCase() + savedTab.slice(1)}`)) {
    switchTab(savedTab);
  }

  // Selective sync excluded patterns
  try {
    const patterns = await api.syncEngine.getIgnorePatterns();
    $('ignorePatternsInput').value = (patterns || []).join('\n');
  } catch {}

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
