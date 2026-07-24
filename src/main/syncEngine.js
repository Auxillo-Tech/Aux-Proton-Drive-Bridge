/**
 * syncEngine.js — Bidirectional Sync Engine
 *
 * Orchestrates bidirectional synchronization between local filesystem
 * and Proton Drive via the CLI. Combines:
 *   - Local filesystem watching (fs.watch)
 *   - Remote polling via proton-drive CLI
 *   - Conflict detection via conflictStore
 *   - Transfer execution via transferQueue
 *   - Metadata tracking via syncDb
 *
 * Sync modes:
 *   - ONE_WAY_UPLOAD: Local → Remote (backup profile)
 *   - ONE_WAY_DOWNLOAD: Remote → Local (restore snapshot)
 *   - BIDIRECTIONAL: Full two-way sync with conflict resolution
 *   - CONSERVATIVE: Upload only, skip existing, merge folders
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DEFAULT_LOCAL_FOLDER, getStatus, parseListOutput, runProton } = require('./protonCli');

const SYNC_MODES = Object.freeze({
  ONE_WAY_UPLOAD: 'one-way-upload',
  ONE_WAY_DOWNLOAD: 'one-way-download',
  BIDIRECTIONAL: 'bidirectional',
  CONSERVATIVE: 'conservative'
});

const DEFAULT_POLL_INTERVAL_MS = 60 * 1000; // 1 minute
const DEBOUNCE_MS = 500; // Debounce local FS events
const MAX_BATCH_SIZE = 50;

/**
 * Create a bidirectional sync engine.
 * @param {object} options
 * @param {object} options.syncDb - Sync metadata DB instance
 * @param {object} options.transferQueue - Transfer queue instance
 * @param {object} options.conflictStore - Conflict store instance
 * @param {string} [options.localFolder] - Default local sync folder
 * @returns {object} SyncEngine API
 */
function createSyncEngine(options = {}) {
  const syncDb = options.syncDb;
  const transferQueue = options.transferQueue;
  const conflictStore = options.conflictStore;
  const localFolder = options.localFolder || DEFAULT_LOCAL_FOLDER;

  let pollTimer = null;
  let watcher = null;
  let isRunning = false;
  let mode = SYNC_MODES.CONSERVATIVE;
  let pollInterval = DEFAULT_POLL_INTERVAL_MS;
  let debounceTimer = null;
  let pausedFolders = null;

  // Event callbacks
  const listeners = {};

  function on(event, handler) {
    (listeners[event] ||= []).push(handler);
    return () => {
      listeners[event] = listeners[event]?.filter(h => h !== handler) || [];
    };
  }

  function emit(event, data) {
    for (const handler of (listeners[event] || [])) {
      try { handler(data); } catch (e) { console.error('SyncEngine listener error:', e); }
    }
  }

  // ── Remote state polling ──────────────────────────────────

  async function pollRemote() {
    try {
      const status = await getStatus();
      if (status.busy || !status.authenticated || !status.installed) {
        emit('warn', { message: 'Skipping remote poll: CLI not ready', status });
        return [];
      }

      const result = await runProton('list', { path: '/my-files' });
      const items = parseListOutput(result.stdout);

      // Track remote state in DB
      const remotePaths = new Set();
      for (const item of items) {
        const remotePath = `/my-files/${item.name}`;
        remotePaths.add(remotePath);
        const existing = syncDb.getTrackedFileByPath(remotePath);

        if (!existing) {
          // New remote file
          syncDb.upsertTrackedFile({
            remotePath,
            type: item.type,
            syncState: 'remote_new'
          });
          syncDb.logEvent({
            fileId: syncDb.pathToId(remotePath),
            eventType: 'remote_create',
            detail: { name: item.name, type: item.type }
          });
          emit('remote_change', { type: 'create', path: remotePath, item });
        } else if (existing.sync_state === 'synced') {
          // Check for remote changes — for now just mark for deeper scan
          emit('info', { message: `Remote file exists: ${remotePath}`, state: existing.sync_state });
        }
      }

      emit('remote_poll', { count: items.length, ts: new Date().toISOString() });
      return items;
    } catch (err) {
      emit('error', { source: 'pollRemote', message: err.message });
      return [];
    }
  }

  // ── Local filesystem watching ─────────────────────────────

  function watchLocal(syncFolder) {
    const target = syncFolder || localFolder;
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    try {
      watcher = fs.watch(target, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Debounce rapid events
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          handleLocalChange(eventType, filename, target);
        }, DEBOUNCE_MS);
      });

      emit('watching', { folder: target });
      return true;
    } catch (err) {
      emit('error', { source: 'watchLocal', message: err.message });
      return false;
    }
  }

  function handleLocalChange(eventType, filename, baseFolder) {
    const fullPath = path.join(baseFolder, filename);

    // Skip hidden files and temp files
    const base = path.basename(filename);
    if (base.startsWith('.') || base.endsWith('.tmp') || base.endsWith('.swp') ||
        base.endsWith('~') || filename.includes('.git/')) return;

    let stat;
    try { stat = fs.statSync(fullPath); } catch { stat = null; }

    const relativePath = filename.replace(/\\/g, '/');
    const remotePath = `/my-files/${relativePath}`;

    if (!stat) {
      // File deleted locally
      syncDb.upsertTrackedFile({
        remotePath,
        localPath: fullPath,
        type: 'file',
        syncState: 'local_deleted'
      });
      syncDb.logEvent({
        fileId: syncDb.pathToId(remotePath),
        eventType: 'local_delete',
        detail: { path: fullPath, eventType }
      });
      emit('local_change', { type: 'delete', path: fullPath, remotePath });
      return;
    }

    const isDir = stat.isDirectory();
    const localModified = stat.mtime.toISOString();
    let localHash = null;

    // Read partial hash for files under 100MB to detect real changes
    if (!isDir && stat.size < 100 * 1024 * 1024) {
      try {
        localHash = fastHash(fullPath);
      } catch { /* ignore hash failures */ }
    }

    const existing = syncDb.getTrackedFileByPath(remotePath);

    if (!existing) {
      // New local file/folder
      syncDb.upsertTrackedFile({
        remotePath,
        localPath: fullPath,
        type: isDir ? 'folder' : 'file',
        size: stat.size,
        localModified,
        localHash,
        syncState: 'local_new'
      });
      syncDb.logEvent({
        fileId: syncDb.pathToId(remotePath),
        eventType: 'local_create',
        detail: { path: fullPath, size: stat.size, type: isDir ? 'folder' : 'file' }
      });
      emit('local_change', { type: 'create', path: fullPath, remotePath, isDir });
    } else {
      // Modified — check if really changed
      const prevModified = existing.local_modified || '';
      if (prevModified !== localModified) {
        syncDb.upsertTrackedFile({
          remotePath,
          localPath: fullPath,
          size: stat.size,
          localModified,
          localHash,
          syncState: 'local_modified'
        });
        syncDb.logEvent({
          fileId: syncDb.pathToId(remotePath),
          eventType: 'local_modify',
          detail: { path: fullPath, size: stat.size, prevModified }
        });
        emit('local_change', { type: 'modify', path: fullPath, remotePath, isDir });
      }
    }
  }

  function fastHash(filePath) {
    const BUFFER_SIZE = 4096;
    const fd = fs.openSync(filePath, 'r');
    try {
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.alloc(BUFFER_SIZE);
      let bytesRead;
      // Read first 64KB for fast comparison
      let totalRead = 0;
      const maxRead = 64 * 1024;
      while (totalRead < maxRead && (bytesRead = fs.readSync(fd, buffer, 0, BUFFER_SIZE, totalRead)) > 0) {
        hash.update(buffer.subarray(0, bytesRead));
        totalRead += bytesRead;
      }
      return hash.digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  }

  // ── Sync execution ────────────────────────────────────────

  async function syncPending() {
    if (!transferQueue) {
      emit('error', { source: 'syncPending', message: 'No transfer queue configured' });
      return { queued: 0 };
    }

    const pendingItems = syncDb.listFilesNeedingSync(MAX_BATCH_SIZE);
    let queued = 0;

    for (const item of pendingItems) {
      if (mode === SYNC_MODES.ONE_WAY_UPLOAD || mode === SYNC_MODES.CONSERVATIVE) {
        if (item.sync_state === 'local_new' || item.sync_state === 'local_modified') {
          const dir = path.dirname(item.remote_path);
          const serverFolder = dir === '/my-files' ? '/my-files' : dir;
          transferQueue.enqueue('upload', {
            localPaths: [item.local_path],
            parentPath: serverFolder,
            fileConflictStrategy: mode === SYNC_MODES.CONSERVATIVE ? 'skip' : 'replace',
            folderConflictStrategy: 'merge',
            logLevel: 'ERROR'
          }, 'medium');
          syncDb.setSyncState(item.remote_path, 'uploading');
          queued++;
        }
      }

      if (mode === SYNC_MODES.ONE_WAY_DOWNLOAD || mode === SYNC_MODES.BIDIRECTIONAL) {
        if (item.sync_state === 'remote_new' || item.sync_state === 'remote_modified') {
          transferQueue.enqueue('download', {
            paths: [item.remote_path],
            localFolder,
            fileConflictStrategy: 'skip',
            folderConflictStrategy: 'merge',
            logLevel: 'ERROR'
          }, 'medium');
          syncDb.setSyncState(item.remote_path, 'downloading');
          queued++;
        }
      }

      if (queued >= MAX_BATCH_SIZE) break;
    }

    if (queued > 0) {
      emit('sync_batch', { queued, remaining: pendingItems.length - queued });
    }

    return { queued, remaining: pendingItems.length - queued };
  }

  // ── Full sync cycle ───────────────────────────────────────

  async function runSyncCycle() {
    if (isRunning) return { skipped: true, reason: 'already running' };
    isRunning = true;

    try {
      emit('sync_start', { ts: new Date().toISOString() });

      // 1. Poll remote state
      const remoteItems = await pollRemote();

      // 2. Sync pending items from DB
      const result = await syncPending();

      // 3. Save checkpoint
      syncDb.saveCheckpoint(`sync_${Date.now()}`);

      emit('sync_complete', { ...result, remoteCount: remoteItems.length, ts: new Date().toISOString() });
      return result;
    } catch (err) {
      emit('error', { source: 'runSyncCycle', message: err.message });
      return { error: err.message };
    } finally {
      isRunning = false;
    }
  }

  // ── Lifecycle management ──────────────────────────────────

  function start(syncMode, syncFolder, intervalMs) {
    if (pollTimer) return { alreadyStarted: true };

    mode = syncMode || SYNC_MODES.CONSERVATIVE;
    pollInterval = intervalMs || DEFAULT_POLL_INTERVAL_MS;
    const targetFolder = syncFolder || localFolder;

    // Start local watcher for bidirectional/upload modes
    if (mode === SYNC_MODES.ONE_WAY_UPLOAD || mode === SYNC_MODES.BIDIRECTIONAL || mode === SYNC_MODES.CONSERVATIVE) {
      watchLocal(targetFolder);
    }

    // Start remote polling
    pollTimer = setInterval(() => {
      runSyncCycle().catch(err => emit('error', { source: 'pollInterval', message: err.message }));
    }, pollInterval);
    pollTimer.unref?.();

    emit('started', { mode, folder: targetFolder, pollInterval, ts: new Date().toISOString() });

    // Run first cycle immediately
    runSyncCycle().catch(err => emit('error', { source: 'initialCycle', message: err.message }));

    return { mode, folder: targetFolder, pollInterval };
  }

  function stop() {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    isRunning = false;
    emit('stopped', { ts: new Date().toISOString() });
  }

  function setMode(newMode) {
    if (!Object.values(SYNC_MODES).includes(newMode)) {
      throw new Error(`Invalid sync mode: ${newMode}`);
    }
    mode = newMode;
    emit('mode_changed', { mode: newMode, ts: new Date().toISOString() });
  }

  function setPollInterval(ms) {
    pollInterval = Math.max(5000, ms);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        runSyncCycle().catch(err => emit('error', { source: 'pollInterval', message: err.message }));
      }, pollInterval);
      pollTimer.unref?.();
    }
  }

  function getState() {
    return {
      isRunning,
      mode,
      pollInterval,
      isWatching: watcher !== null,
      localFolder,
      lastCheckpoint: syncDb?.getLastCheckpoint() || null,
      stats: syncDb?.getStats() || null,
      conflictStats: conflictStore?.getStats() || null
    };
  }

  async function scanNow() {
    return runSyncCycle();
  }

  return {
    start,
    stop,
    setMode,
    setPollInterval,
    getState,
    scanNow,
    runSyncCycle,
    pollRemote,
    syncPending,
    on,
    SYNC_MODES
  };
}

module.exports = { createSyncEngine, SYNC_MODES };
