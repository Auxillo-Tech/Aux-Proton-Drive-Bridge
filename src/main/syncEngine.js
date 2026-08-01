const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DEFAULT_LOCAL_FOLDER, getStatus, normalizeRemotePath, parseListOutput, runProton } = require('./protonCli');
const { isPathInside } = require('./pathSafety');

const SYNC_MODES = Object.freeze({
  ONE_WAY_UPLOAD: 'one-way-upload',
  ONE_WAY_DOWNLOAD: 'one-way-download',
  BIDIRECTIONAL: 'bidirectional',
  CONSERVATIVE: 'conservative'
});
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MAX_IGNORE_PATTERNS = 100;

function normalizeIgnorePatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  return [...new Set(patterns
    .map(pattern => String(pattern).replace(/\0/g, '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(pattern => pattern && pattern !== '*' && pattern !== '**' && pattern.length <= 200))]
    .slice(0, MAX_IGNORE_PATTERNS);
}

function compileIgnorePatterns(patterns) {
  return normalizeIgnorePatterns(patterns).map(pattern => {
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0000/g, '.*');
    const matcher = new RegExp(`^${source}$`, 'i');
    matcher.pattern = pattern;
    return matcher;
  });
}
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60_000;
const DEBOUNCE_MS = 500;
const MAX_BATCH_SIZE = 50;
const MAX_LOCAL_ITEMS = 100_000;
const MAX_REMOTE_ITEMS = 10_000;
const MAX_REMOTE_DEPTH = 100;

function createSyncEngine(options = {}) {
  const syncDb = options.syncDb;
  const transferQueue = options.transferQueue;
  const conflictStore = options.conflictStore;
  const statusProvider = options.getStatus || getStatus;
  const protonRunner = options.runProton || runProton;
  const listParser = options.parseListOutput || parseListOutput;
  const defaultLocalFolder = path.resolve(options.localFolder || DEFAULT_LOCAL_FOLDER);
  if (!syncDb) throw new Error('syncDb is required');

  let activeFolder = defaultLocalFolder;
  let pollTimer = null;
  let watcher = null;
  let schedulerActive = false;
  let cycleRunning = false;
  let activeCyclePromise = null;
  let lifecycleGeneration = 0;
  let mode = SYNC_MODES.CONSERVATIVE;
  let pollInterval = DEFAULT_POLL_INTERVAL_MS;
  let queueRemoveHandlers = [];
  let ignoreMatchers = compileIgnorePatterns(options.ignorePatterns);
  const pendingResolutions = new Map();
  const syncTransferIds = new Set();
  const debounceTimers = new Map();
  const listeners = new Map();

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  }

  function emit(event, data) {
    for (const handler of listeners.get(event) || []) {
      try { handler(data); } catch (error) { console.error('SyncEngine listener error:', error); }
    }
  }

  function shouldIgnore(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    if (normalized.split('/').some(part => !part || part.startsWith('.')) ||
      normalized.endsWith('.tmp') || normalized.endsWith('.swp') || normalized.endsWith('~')) return true;
    if (!ignoreMatchers.length) return false;
    const parts = normalized.split('/');
    return ignoreMatchers.some(matcher => matcher.test(normalized) || parts.some(part => matcher.test(part)));
  }

  function setIgnorePatterns(patterns) {
    ignoreMatchers = compileIgnorePatterns(patterns);
    emit('ignore_patterns_changed', { patterns: ignoreMatchers.map(matcher => matcher.pattern), ts: new Date().toISOString() });
    return ignoreMatchers.map(matcher => matcher.pattern);
  }

  function safeRemotePath(relativePath) {
    const parts = String(relativePath).replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.reduce((parent, part) => normalizeRemotePath(parent, part), '/my-files');
  }

  function localMetadata(filePath, stat) {
    const isDirectory = stat.isDirectory();
    let hash = null;
    if (!isDirectory && stat.size < 100 * 1024 * 1024) {
      try { hash = fastHash(filePath); } catch {}
    }
    return {
      path: filePath,
      modified: stat.mtime.toISOString(),
      size: stat.size,
      hash,
      type: isDirectory ? 'folder' : 'file'
    };
  }

  function fastHash(filePath) {
    const fd = fs.openSync(filePath, 'r');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(4096);
    try {
      let offset = 0;
      while (offset < 64 * 1024) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      hash.update(String(fs.fstatSync(fd).size));
      return hash.digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  }

  function recordConflict(local, remote, lastSync) {
    if (!conflictStore) return null;
    const baseline = lastSync ? {
      ...lastSync,
      syncedLocalSize: lastSync.syncedLocalSize ?? lastSync.synced_local_size,
      syncedRemoteSize: lastSync.syncedRemoteSize ?? lastSync.synced_remote_size,
      syncedLocalModified: lastSync.syncedLocalModified ?? lastSync.synced_local_modified,
      syncedRemoteModified: lastSync.syncedRemoteModified ?? lastSync.synced_remote_modified
    } : null;
    const conflict = conflictStore.detect(local, remote, baseline);
    if (!conflict) return null;
    conflictStore.record(conflict);
    emit('conflict', conflict);
    return conflict;
  }

  function trackLocalPath(fullPath, relativePath, eventType = 'scan') {
    if (shouldIgnore(relativePath) || !isPathInside(fullPath, activeFolder)) return null;
    let stat;
    try { stat = fs.lstatSync(fullPath); } catch { stat = null; }
    const remotePath = safeRemotePath(relativePath);
    const existing = syncDb.getTrackedFileByPath(remotePath);

    if (!stat) {
      if (existing && ['synced', 'remote_modified', 'pending_download', 'downloading'].includes(existing.sync_state)) {
        const changed = existing.sync_state === 'remote_modified'
          ? recordConflict(null, {
              path: remotePath, modified: existing.remote_modified, size: existing.remote_size ?? existing.size,
              hash: existing.remote_hash, type: existing.type
            }, existing)
          : null;
        if (!changed) syncDb.upsertTrackedFile({ remotePath, localPath: fullPath, syncState: 'local_deleted' });
        syncDb.logEvent({ fileId: existing.id, eventType: 'local_delete', detail: { path: fullPath, eventType } });
        emit('local_change', { type: 'delete', path: fullPath, remotePath });
      }
      return null;
    }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return null;

    const local = localMetadata(fullPath, stat);
    if (!existing) {
      const id = syncDb.upsertTrackedFile({
        remotePath, localPath: fullPath, type: local.type, size: local.size, localSize: local.size,
        localModified: local.modified, localHash: local.hash, syncState: 'local_new'
      });
      syncDb.logEvent({ fileId: id, eventType: 'local_create', detail: { path: fullPath, size: local.size, type: local.type } });
      emit('local_change', { type: 'create', path: fullPath, remotePath, isDir: local.type === 'folder' });
      return remotePath;
    }

    if (existing.sync_state === 'remote_new') {
      recordConflict(local, {
        path: remotePath, modified: existing.remote_modified, size: existing.remote_size ?? existing.size,
        hash: existing.remote_hash, type: existing.type
      }, null);
      return remotePath;
    }

    if (['downloading', 'uploading', 'conflict'].includes(existing.sync_state)) return remotePath;
    const changed = existing.local_modified !== local.modified || Number(existing.local_size ?? existing.size ?? 0) !== Number(local.size || 0) ||
      (existing.local_hash && local.hash && existing.local_hash !== local.hash);
    const nextState = existing.sync_state === 'remote_modified' && changed ? 'conflict'
      : changed && !['local_new', 'local_modified', 'pending_upload'].includes(existing.sync_state) ? 'local_modified'
      : existing.sync_state;

    if (nextState === 'conflict') {
      recordConflict(local, {
        path: remotePath, modified: existing.remote_modified, size: existing.remote_size ?? existing.size,
        hash: existing.remote_hash, type: existing.type
      }, existing);
    } else {
      syncDb.upsertTrackedFile({
        remotePath, localPath: fullPath, type: local.type, size: local.size, localSize: local.size,
        localModified: local.modified, localHash: local.hash, syncState: nextState
      });
      if (changed && nextState === 'local_modified') {
        syncDb.logEvent({ fileId: existing.id, eventType: 'local_modify', detail: { path: fullPath, size: local.size } });
        emit('local_change', { type: 'modify', path: fullPath, remotePath, isDir: local.type === 'folder' });
      }
    }
    return remotePath;
  }

  function scanLocalTree(folder = activeFolder) {
    const target = path.resolve(folder);
    if (!isPathInside(target, activeFolder) && target !== activeFolder) throw new Error('Local scan escaped the active sync folder');
    fs.mkdirSync(target, { recursive: true });
    const stack = [target];
    const seen = new Set();
    let count = 0;
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); }
      catch (error) { emit('warn', { message: `Cannot read ${current}: ${error.message}` }); continue; }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        const relative = path.relative(activeFolder, fullPath);
        if (shouldIgnore(relative) || entry.isSymbolicLink()) continue;
        if (++count > MAX_LOCAL_ITEMS) throw new Error(`Local scan exceeded ${MAX_LOCAL_ITEMS} items`);
        const remotePath = trackLocalPath(fullPath, relative, 'scan');
        if (remotePath) seen.add(remotePath);
        if (entry.isDirectory()) stack.push(fullPath);
      }
    }

    for (const tracked of syncDb.listTrackedFiles()) {
      if (!tracked.local_path || tracked.remote_path === '__checkpoint__' || !isPathInside(tracked.local_path, activeFolder)) continue;
      if (!seen.has(tracked.remote_path) && !fs.existsSync(tracked.local_path)) {
        trackLocalPath(tracked.local_path, path.relative(activeFolder, tracked.local_path), 'scan-delete');
      }
    }
    emit('local_scan', { count, folder: activeFolder, ts: new Date().toISOString() });
    return { count, seen };
  }

  function watchLocal(folder = activeFolder) {
    fs.mkdirSync(folder, { recursive: true });
    try {
      watcher = fs.watch(folder, { recursive: true }, (eventType, filename) => {
        if (!filename || shouldIgnore(filename)) return;
        const key = String(filename);
        clearTimeout(debounceTimers.get(key));
        debounceTimers.set(key, setTimeout(() => {
          debounceTimers.delete(key);
          const fullPath = path.resolve(folder, key);
          if (!isPathInside(fullPath, folder)) return;
          try {
            trackLocalPath(fullPath, key, eventType);
            syncPending().catch(error => emit('error', { source: 'localSync', message: error.message }));
          } catch (error) {
            emit('error', { source: 'watchLocal', message: error.message });
          }
        }, DEBOUNCE_MS));
      });
      watcher.on?.('error', error => emit('error', { source: 'watchLocal', message: error.message }));
      emit('watching', { folder });
      return true;
    } catch (error) {
      emit('error', { source: 'watchLocal', message: error.message });
      return false;
    }
  }

  async function listRemoteTree(root = '/my-files', expectedGeneration = null) {
    const pending = [{ remotePath: root, segments: [], depth: 0 }];
    const all = [];
    while (pending.length) {
      if (expectedGeneration !== null && expectedGeneration !== lifecycleGeneration) {
        throw Object.assign(new Error('Remote traversal cancelled'), { name: 'AbortError', cancelled: true });
      }
      const current = pending.shift();
      if (current.depth > MAX_REMOTE_DEPTH) throw new Error(`Remote tree exceeded maximum depth ${MAX_REMOTE_DEPTH}`);
      const result = await protonRunner('list', { path: current.remotePath, logLevel: 'ERROR' });
      if (expectedGeneration !== null && expectedGeneration !== lifecycleGeneration) {
        throw Object.assign(new Error('Remote traversal cancelled'), { name: 'AbortError', cancelled: true });
      }
      for (const item of listParser(result.stdout)) {
        if (!item?.name || item.name === '.' || item.name === '..') continue;
        if (all.length >= MAX_REMOTE_ITEMS) throw new Error(`Remote tree exceeded ${MAX_REMOTE_ITEMS} items`);
        const remotePath = normalizeRemotePath(current.remotePath, item.name);
        const remote = { ...item, path: remotePath, segments: [...current.segments, item.name] };
        all.push(remote);
        if (remote.type === 'folder') pending.push({ remotePath, segments: remote.segments, depth: current.depth + 1 });
      }
    }
    return all;
  }

  function remoteMetadata(item) {
    return {
      path: item.path,
      modified: item.modified || null,
      size: Number(item.size || 0),
      hash: item.hash || null,
      type: item.type
    };
  }

  function localPathForRemote(item) {
    const safeSegments = item.segments.map(segment => String(segment).replaceAll('/', '／').replaceAll('\0', ''));
    const candidate = path.resolve(activeFolder, ...safeSegments);
    if (!isPathInside(candidate, activeFolder)) throw new Error(`Unsafe remote path: ${item.path}`);
    return candidate;
  }

  async function pollRemote(expectedGeneration = null) {
    const status = await statusProvider();
    if (status.busy || !status.authenticated || !status.installed) {
      emit('warn', { message: 'Skipping remote poll: CLI not ready', status });
      return { authoritative: false, items: [], reason: 'cli-not-ready', status };
    }

    const items = await listRemoteTree('/my-files', expectedGeneration);
    const seen = new Set();
    for (const item of items) {
      const remotePath = item.path;
      seen.add(remotePath);
      const remote = remoteMetadata(item);
      const localPath = localPathForRemote(item);
      let local = null;
      try {
        const stat = fs.lstatSync(localPath);
        if (!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory())) local = localMetadata(localPath, stat);
      } catch {}
      const existing = syncDb.getTrackedFileByPath(remotePath);
      if (!existing) {
        if (local) {
          recordConflict(local, remote, null);
        } else {
          const id = syncDb.upsertTrackedFile({
            remotePath, localPath, type: item.type, size: item.size, remoteSize: item.size,
            remoteModified: item.modified, remoteHash: item.hash, syncState: 'remote_new'
          });
          syncDb.logEvent({ fileId: id, eventType: 'remote_create', detail: { type: item.type, size: item.size } });
          emit('remote_change', { type: 'create', path: remotePath, item });
        }
        continue;
      }

      const remoteChanged = Boolean(
        (item.modified && existing.remote_modified && item.modified !== existing.remote_modified) ||
        (item.type === 'file' && Number(item.size || 0) !== Number(existing.remote_size ?? existing.size ?? 0))
      );
      const localPending = ['local_new', 'local_modified', 'pending_upload', 'local_deleted'].includes(existing.sync_state);
      if ((localPending && existing.sync_state !== 'local_deleted') || (remoteChanged && localPending)) {
        recordConflict(local || {
          path: existing.local_path, modified: existing.local_modified, size: existing.local_size ?? existing.size,
          hash: existing.local_hash, type: existing.type
        }, remote, existing.sync_state === 'local_new' ? null : existing);
        continue;
      }
      if (existing.sync_state === 'local_deleted' && remoteChanged) {
        recordConflict(null, remote, existing);
        continue;
      }

      const update = {
        remotePath, localPath: existing.local_path || localPath, type: item.type,
        size: item.size, remoteSize: item.size, remoteModified: item.modified, remoteHash: item.hash
      };
      if (remoteChanged && !['downloading', 'uploading', 'conflict'].includes(existing.sync_state)) {
        update.syncState = 'remote_modified';
        syncDb.logEvent({ fileId: existing.id, eventType: 'remote_modify', detail: { size: item.size, modified: item.modified } });
        emit('remote_change', { type: 'modify', path: remotePath, item });
      }
      syncDb.upsertTrackedFile(update);
      if (existing.sync_state === 'synced' && !existing.remote_modified && item.modified) {
        syncDb.markSynced(remotePath);
      }
    }

    for (const existing of syncDb.listTrackedFiles()) {
      if (existing.remote_path === '__checkpoint__' || !existing.remote_path.startsWith('/my-files/')) continue;
      if (seen.has(existing.remote_path) || ['local_new', 'pending_upload', 'uploading', 'conflict', 'remote_deleted'].includes(existing.sync_state)) continue;
      const local = existing.local_path && fs.existsSync(existing.local_path)
        ? localMetadata(existing.local_path, fs.lstatSync(existing.local_path)) : null;
      if (local && ['local_modified', 'local_deleted'].includes(existing.sync_state)) {
        recordConflict(local, null, existing);
      } else {
        syncDb.setSyncState(existing.remote_path, 'remote_deleted');
        syncDb.logEvent({ fileId: existing.id, eventType: 'remote_delete', detail: { path: existing.remote_path }, severity: 'warn' });
        emit('remote_change', { type: 'delete', path: existing.remote_path });
      }
    }
    emit('remote_poll', { count: items.length, ts: new Date().toISOString() });
    return { authoritative: true, items };
  }

  function canUpload() {
    return [SYNC_MODES.ONE_WAY_UPLOAD, SYNC_MODES.BIDIRECTIONAL, SYNC_MODES.CONSERVATIVE].includes(mode);
  }

  function canDownload() {
    return [SYNC_MODES.ONE_WAY_DOWNLOAD, SYNC_MODES.BIDIRECTIONAL].includes(mode);
  }

  async function syncPending() {
    if (!transferQueue) return { queued: 0, remaining: syncDb.listFilesNeedingSync(MAX_BATCH_SIZE).length };
    // The CLI has no safe cross-platform remote-delete primitive. Preserve data by restoring
    // the surviving side instead of silently propagating deletions.
    for (const item of syncDb.listTrackedFiles()) {
      if (item.sync_state === 'local_deleted') {
        syncDb.setSyncState(item.remote_path, canDownload() ? 'pending_download' : 'ignored');
      } else if (item.sync_state === 'remote_deleted') {
        const canRestoreRemote = canUpload() && item.local_path && fs.existsSync(item.local_path);
        syncDb.setSyncState(item.remote_path, canRestoreRemote ? 'pending_upload' : 'ignored');
      }
    }
    const pending = syncDb.listFilesNeedingSync(MAX_BATCH_SIZE);
    const uploadFolderPaths = new Set(pending
      .filter(item => item.type === 'folder' && ['local_new', 'local_modified', 'pending_upload'].includes(item.sync_state))
      .map(item => item.remote_path));
    const downloadFolderPaths = new Set(pending
      .filter(item => item.type === 'folder' && ['remote_new', 'remote_modified', 'pending_download'].includes(item.sync_state))
      .map(item => item.remote_path));
    const hasQueuedAncestor = (remotePath, folders) => {
      let parent = path.posix.dirname(remotePath);
      while (parent && parent !== '/' && parent !== '/my-files') {
        if (folders.has(parent)) return true;
        parent = path.posix.dirname(parent);
      }
      return false;
    };
    let queued = 0;
    for (const item of pending) {
      if (canUpload() && ['local_new', 'local_modified', 'pending_upload'].includes(item.sync_state)) {
        if (hasQueuedAncestor(item.remote_path, uploadFolderPaths)) continue;
        if (!item.local_path || !fs.existsSync(item.local_path)) {
          syncDb.setSyncState(item.remote_path, 'local_deleted');
          continue;
        }
        try {
          const transferId = transferQueue.enqueue('upload', {
            localPaths: [item.local_path],
            parentPath: path.posix.dirname(item.remote_path),
            fileConflictStrategy: mode === SYNC_MODES.CONSERVATIVE ? 'skip' : 'replace',
            folderConflictStrategy: 'merge',
            logLevel: 'ERROR'
          }, 'medium');
          syncTransferIds.add(transferId);
          syncDb.setSyncState(item.remote_path, 'uploading');
          queued++;
        } catch (error) {
          emit('error', { source: 'syncPending', message: error.message, path: item.remote_path });
        }
      }
      if (canDownload() && ['remote_new', 'remote_modified', 'pending_download'].includes(item.sync_state)) {
        if (hasQueuedAncestor(item.remote_path, downloadFolderPaths)) continue;
        try {
          const transferId = transferQueue.enqueue('download', {
            paths: [item.remote_path], localFolder: activeFolder,
            fileConflictStrategy: item.sync_state === 'pending_download' ? 'replace' : 'skip',
            folderConflictStrategy: 'merge', logLevel: 'ERROR'
          }, 'medium');
          syncTransferIds.add(transferId);
          syncDb.setSyncState(item.remote_path, 'downloading');
          queued++;
        } catch (error) {
          emit('error', { source: 'syncPending', message: error.message, path: item.remote_path });
        }
      }
      if (queued >= MAX_BATCH_SIZE) break;
    }
    const result = { queued, remaining: Math.max(0, pending.length - queued) };
    if (queued) emit('sync_batch', result);
    return result;
  }

  function recoverStaleStates() {
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    const downloads = syncDb.getStaleItemsByState('downloading', cutoff);
    const uploads = syncDb.getStaleItemsByState('uploading', cutoff);
    for (const item of downloads) syncDb.setSyncState(item.remote_path, 'pending_download');
    for (const item of uploads) syncDb.setSyncState(item.remote_path, 'pending_upload');
    if (downloads.length || uploads.length) emit('info', { message: `Recovered ${downloads.length} stale downloads and ${uploads.length} stale uploads` });
  }

  function refreshLocalMetadata(item) {
    if (!item?.local_path || !fs.existsSync(item.local_path)) return;
    const stat = fs.lstatSync(item.local_path);
    if (stat.isSymbolicLink()) return;
    const local = localMetadata(item.local_path, stat);
    syncDb.upsertTrackedFile({
      remotePath: item.remote_path, localPath: item.local_path, type: local.type,
      size: local.size, localSize: local.size, localModified: local.modified, localHash: local.hash
    });
  }

  function cleanupQueueListeners() {
    for (const remove of queueRemoveHandlers) {
      try { if (typeof remove === 'function') remove(); } catch {}
    }
    queueRemoveHandlers = [];
  }

  function setupQueueListeners() {
    if (!transferQueue?.on) return;
    if (queueRemoveHandlers.length) return;
    queueRemoveHandlers.push(transferQueue.on('complete', payload => {
      if (!syncTransferIds.delete(payload.id)) return;
      for (const localPath of payload.options?.localPaths || []) {
        for (const item of syncDb.listTrackedFiles().filter(record => record.local_path === localPath)) {
          refreshLocalMetadata(item);
          syncDb.markSynced(item.remote_path);
          syncDb.logEvent({ fileId: item.id, eventType: 'upload_complete', detail: { path: item.remote_path } });
        }
      }
      for (const remotePath of payload.options?.paths || []) {
        const matched = syncDb.listTrackedFiles().filter(item => item.remote_path === remotePath || item.remote_path.startsWith(`${remotePath}/`));
        for (const item of matched) {
          const expected = item.local_path || path.join(activeFolder, item.remote_path.slice('/my-files/'.length));
          syncDb.upsertTrackedFile({ remotePath: item.remote_path, localPath: expected });
          const downloaded = syncDb.getTrackedFileByPath(item.remote_path);
          if (!fs.existsSync(expected)) {
            syncDb.setSyncState(item.remote_path, 'pending_download');
            continue;
          }
          const stat = fs.lstatSync(expected);
          if (stat.isSymbolicLink() || (item.type === 'file' && !stat.isFile()) || (item.type === 'folder' && !stat.isDirectory()) ||
              (item.type === 'file' && Number(item.remote_size ?? item.size ?? 0) !== stat.size)) {
            syncDb.setSyncState(item.remote_path, 'pending_download');
            continue;
          }
          refreshLocalMetadata(downloaded);
          syncDb.markSynced(item.remote_path);
          syncDb.logEvent({ fileId: item.id, eventType: 'download_complete', detail: { path: item.remote_path } });
        }
      }
      const pendingResolution = pendingResolutions.get(payload.id);
      if (pendingResolution) {
        conflictStore.commitResolution(pendingResolution.conflictId, pendingResolution.strategy, { transferCompleted: true });
        pendingResolutions.delete(payload.id);
        emit('conflict_resolved', { conflictId: pendingResolution.conflictId, strategy: pendingResolution.strategy, transferId: payload.id });
      }
      const queueState = transferQueue.getState?.();
      const counts = syncDb.countByState();
      const outstanding = ['pending_upload', 'pending_download', 'uploading', 'downloading', 'local_new', 'remote_new', 'local_modified', 'remote_modified', 'conflict']
        .reduce((total, state) => total + Number(counts[state] || 0), 0);
      if ((!queueState || (!queueState.active.length && !queueState.pending.length)) && outstanding === 0) {
        syncDb.saveCheckpoint(`sync_complete_${Date.now()}`);
        emit('sync_complete', { verified: true, stats: syncDb.getStats(), ts: new Date().toISOString() });
      }
    }));
    const restoreFailedTransfer = payload => {
      if (!syncTransferIds.delete(payload.id)) return false;
      for (const localPath of payload.options?.localPaths || []) {
        const prefix = `${path.resolve(localPath)}${path.sep}`;
        for (const item of syncDb.listTrackedFiles().filter(record => record.local_path === localPath ||
          (record.local_path && path.resolve(record.local_path).startsWith(prefix)))) {
          syncDb.setSyncState(item.remote_path, 'pending_upload');
          syncDb.logEvent({ fileId: item.id, eventType: 'upload_error', detail: { error: payload.error }, severity: 'error' });
        }
      }
      for (const remotePath of payload.options?.paths || []) {
        for (const item of syncDb.listTrackedFiles().filter(record => record.remote_path === remotePath || record.remote_path.startsWith(`${remotePath}/`))) {
          syncDb.setSyncState(item.remote_path, 'pending_download');
          syncDb.logEvent({ fileId: item.id, eventType: 'download_error', detail: { error: payload.error }, severity: 'error' });
        }
      }
      const pendingResolution = pendingResolutions.get(payload.id);
      if (pendingResolution) {
        if (pendingResolution.renameRollback) {
          try { fs.renameSync(pendingResolution.renameRollback.to, pendingResolution.renameRollback.from); } catch {}
        }
        const conflict = conflictStore.get(pendingResolution.conflictId);
        if (conflict?.remotePath) syncDb.setSyncState(conflict.remotePath, 'conflict');
        pendingResolutions.delete(payload.id);
        emit('conflict_resolution_error', { conflictId: pendingResolution.conflictId, strategy: pendingResolution.strategy, transferId: payload.id, error: payload.error || 'Transfer cancelled' });
      }
      return true;
    };
    queueRemoveHandlers.push(transferQueue.on('error', restoreFailedTransfer));
    queueRemoveHandlers.push(transferQueue.on('cancelled', restoreFailedTransfer));
    queueRemoveHandlers.push(transferQueue.on('skipped', payload => {
      const summary = payload.result?.summary || {};
      if (!restoreFailedTransfer({ ...payload, error: `Proton Drive skipped ${summary.totalSkipped || 1} item(s)` })) return;
      for (const localPath of payload.options?.localPaths || []) {
        const item = syncDb.listTrackedFiles().find(record => record.local_path === localPath);
        if (item) conflictStore?.recordTransferSkipped({ remotePath: item.remote_path, localPath: item.local_path, action: payload.action, summary, type: item.type });
      }
      for (const remotePath of payload.options?.paths || []) {
        const item = syncDb.getTrackedFileByPath(remotePath);
        if (item) conflictStore?.recordTransferSkipped({ remotePath: item.remote_path, localPath: item.local_path, action: payload.action, summary, type: item.type });
      }
      emit('transfer_skipped', { id: payload.id, action: payload.action, summary });
    }));
  }

  async function runSyncCycle() {
    if (cycleRunning) return { skipped: true, reason: 'already running' };
    cycleRunning = true;
    const generation = lifecycleGeneration;
    const work = (async () => {
      try {
        recoverStaleStates();
        emit('sync_start', { ts: new Date().toISOString() });
        if (canUpload()) scanLocalTree(activeFolder);
        const remoteSnapshot = await pollRemote(generation);
        if (generation !== lifecycleGeneration) return { stopped: true, queued: 0 };
        if (!remoteSnapshot.authoritative) {
          return { ok: false, skipped: true, reason: remoteSnapshot.reason, queued: 0, remoteCount: 0 };
        }
        const remoteItems = remoteSnapshot.items;
        const result = await syncPending();
        emit('sync_scan_complete', { ...result, remoteCount: remoteItems.length, ts: new Date().toISOString() });
        const counts = syncDb.countByState();
        const unresolved = ['pending_upload', 'pending_download', 'uploading', 'downloading', 'local_new', 'remote_new', 'local_modified', 'remote_modified', 'conflict']
          .reduce((total, state) => total + Number(counts[state] || 0), 0);
        if (result.queued === 0 && unresolved === 0) {
          syncDb.saveCheckpoint(`sync_complete_${Date.now()}`);
          emit('sync_complete', { ...result, verified: true, remoteCount: remoteItems.length, ts: new Date().toISOString() });
        }
        return result;
      } catch (error) {
        if (generation !== lifecycleGeneration || error.cancelled || error.name === 'AbortError') {
          return { stopped: true, queued: 0 };
        }
        emit('error', { source: 'runSyncCycle', message: error.message });
        throw error;
      } finally {
        cycleRunning = false;
      }
    })();
    activeCyclePromise = work;
    try {
      return await work;
    } finally {
      if (activeCyclePromise === work) activeCyclePromise = null;
    }
  }

  function normalizePollInterval(value, fallback = DEFAULT_POLL_INTERVAL_MS) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(MAX_POLL_INTERVAL_MS, Math.max(5000, Math.trunc(numeric)));
  }

  function start(syncMode, syncFolder, intervalMs) {
    if (schedulerActive) {
      const requestedMode = syncMode || mode;
      const requestedFolder = path.resolve(syncFolder || activeFolder);
      const requestedInterval = normalizePollInterval(intervalMs, pollInterval);
      if (requestedMode !== mode || requestedFolder !== activeFolder || requestedInterval !== pollInterval) {
        throw new Error('Sync is already active with different settings. Stop sync before changing mode, folder, or interval.');
      }
      return { alreadyStarted: true, ...getState() };
    }
    setMode(syncMode || SYNC_MODES.CONSERVATIVE);
    activeFolder = path.resolve(syncFolder || defaultLocalFolder);
    pollInterval = normalizePollInterval(intervalMs);
    fs.mkdirSync(activeFolder, { recursive: true });
    schedulerActive = true;
    if (canUpload()) {
      scanLocalTree(activeFolder);
      watchLocal(activeFolder);
    }
    pollTimer = setInterval(() => runSyncCycle().catch(error => emit('error', { source: 'pollInterval', message: error.message })), pollInterval);
    pollTimer.unref?.();
    emit('started', { mode, folder: activeFolder, pollInterval, ts: new Date().toISOString() });
    runSyncCycle().catch(error => emit('error', { source: 'initialCycle', message: error.message }));
    return getState();
  }

  async function stop() {
    schedulerActive = false;
    lifecycleGeneration++;
    watcher?.close();
    watcher = null;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    const stoppingTransfers = [...syncTransferIds];
    for (const id of stoppingTransfers) transferQueue?.cancel?.(id);
    if (stoppingTransfers.length && transferQueue?.waitForSettled) {
      try { await transferQueue.waitForSettled(stoppingTransfers); } catch (error) { emit('error', { source: 'stop', message: error.message }); }
    }
    syncTransferIds.clear();
    if (activeCyclePromise) {
      try { await activeCyclePromise; } catch {}
    }
    emit('stopped', { ts: new Date().toISOString() });
    return true;
  }

  function setMode(nextMode) {
    if (!Object.values(SYNC_MODES).includes(nextMode)) throw new Error(`Invalid sync mode: ${nextMode}`);
    mode = nextMode;
    emit('mode_changed', { mode, ts: new Date().toISOString() });
  }

  function setPollInterval(ms) {
    pollInterval = normalizePollInterval(ms);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = setInterval(() => runSyncCycle(), pollInterval);
      pollTimer.unref?.();
    }
  }

  function getState() {
    return {
      engineActive: schedulerActive,
      isRunning: cycleRunning,
      mode,
      pollInterval,
      isWatching: watcher !== null,
      ignorePatterns: ignoreMatchers.map(matcher => matcher.pattern),
      folder: activeFolder,
      localFolder: activeFolder,
      lastCheckpoint: syncDb.getLastCheckpoint(),
      stats: syncDb.getStats(),
      conflictStats: conflictStore?.getStats() || null
    };
  }

  function resolveConflict(conflictId, strategy) {
    if (!conflictStore) throw new Error('Conflict store is unavailable');
    const result = conflictStore.prepareResolution(conflictId, strategy);
    if (!result) return false;
    const action = result.nextAction;
    if (action.action === 'none') {
      return { ...result, pending: false, skipped: true, conflictOpen: true };
    }
    if (!transferQueue) throw new Error('Transfer queue is unavailable');
    setupQueueListeners();
    let renameRollback = null;
    if (action.action === 'upload') {
      result.transferId = transferQueue.enqueue('upload', {
        localPaths: action.localPaths,
        parentPath: action.parentPath,
        fileConflictStrategy: action.fileConflictStrategy || 'replace',
        folderConflictStrategy: 'merge'
      }, 'high');
    } else if (action.action === 'download') {
      result.transferId = transferQueue.enqueue('download', {
        paths: action.paths,
        localFolder: action.localFolder || activeFolder,
        fileConflictStrategy: action.fileConflictStrategy || 'replace',
        folderConflictStrategy: 'merge'
      }, 'high');
    } else if (action.action === 'rename') {
      const renamed = path.join(path.dirname(action.localPath), action.newLocalName);
      fs.renameSync(action.localPath, renamed);
      renameRollback = { from: action.localPath, to: renamed };
      result.preservedLocalPath = renamed;
      try {
        result.transferId = transferQueue.enqueue('download', {
          paths: [action.remotePath], localFolder: path.dirname(action.localPath),
          fileConflictStrategy: 'replace', folderConflictStrategy: 'merge'
        }, 'high');
      } catch (error) {
        try { fs.renameSync(renamed, action.localPath); } catch {}
        throw error;
      }
    }
    syncTransferIds.add(result.transferId);
    pendingResolutions.set(result.transferId, { conflictId, strategy, renameRollback });
    result.pending = true;
    return result;
  }

  setupQueueListeners();

  function destroy() {
    cleanupQueueListeners();
    listeners.clear();
  }

  return {
    start, stop, setMode, setPollInterval, setIgnorePatterns, getState,
    scanNow: runSyncCycle, runSyncCycle, pollRemote, scanLocalTree,
    syncPending, resolveConflict, on, destroy, SYNC_MODES
  };
}

module.exports = { createSyncEngine, normalizeIgnorePatterns, SYNC_MODES };
