const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DEFAULT_LOCAL_FOLDER, getStatus, normalizeRemotePath, parseListOutputAsync, runProton } = require('./protonCli');
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
const MAX_REMOTE_ITEMS = 100_000;
const MAX_REMOTE_DEPTH = 100;
const SCAN_YIELD_EVERY = 25;

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

function createSyncEngine(options = {}) {
  const syncDb = options.syncDb;
  const transferQueue = options.transferQueue;
  const conflictStore = options.conflictStore;
  const statusProvider = options.getStatus || getStatus;
  const protonRunner = options.runProton || runProton;
  const customListParser = options.parseListOutput || null;
  const defaultLocalFolder = path.resolve(options.localFolder || DEFAULT_LOCAL_FOLDER);
  if (!syncDb) throw new Error('syncDb is required');

  let activeFolder = defaultLocalFolder;
  let pollTimer = null;
  let watcher = null;
  let schedulerActive = false;
  let cycleRunning = false;
  let activeCyclePromise = null;
  let stoppingPromise = null;
  let watcherSyncDeferred = false;
  let authoritativeRequestVersion = 0;
  let lifecycleGeneration = 0;
  let mode = SYNC_MODES.CONSERVATIVE;
  let pollInterval = DEFAULT_POLL_INTERVAL_MS;
  let queueRemoveHandlers = [];
  let ignoreMatchers = compileIgnorePatterns(options.ignorePatterns);
  const pendingResolutions = new Map();
  const pendingUploadResolutions = new Map();
  const syncTransferIds = new Set();
  /** Latest in-flight upload transfer id per remote path (stale completes must not verify). */
  const activeUploadTransferByPath = new Map();
  const debounceTimers = new Map();
  const listeners = new Map();

  function rememberOwnUploadDigest(remotePath, digest) {
    if (!syncDb.rememberOwnUploadDigest) return;
    try { syncDb.rememberOwnUploadDigest(remotePath, digest); } catch {}
  }

  function isOwnPriorRemoteDigest(remotePath, digest) {
    if (!remotePath || !digest) return false;
    if (typeof syncDb.hasOwnUploadDigest === 'function') {
      try { return Boolean(syncDb.hasOwnUploadDigest(remotePath, digest)); } catch { return false; }
    }
    return false;
  }

  function clearOwnUploadDigests(remotePath) {
    if (typeof syncDb.clearOwnUploadDigests === 'function') {
      try { syncDb.clearOwnUploadDigests(remotePath); } catch {}
    }
  }

  function isRemoteStillPropagationLag(existing, remoteHash, remoteSize = null) {
    const syncedRemoteHash = existing?.synced_remote_hash || null;
    if (remoteHash && syncedRemoteHash && syncedRemoteHash !== 'legacy:unknown' &&
        remoteHash === syncedRemoteHash) {
      return true;
    }
    // Superseded intermediate own upload still listed while verifying a later successor.
    // Durable across restart via tracked_files.own_upload_digests.
    if (remoteHash && isOwnPriorRemoteDigest(existing.remote_path, remoteHash)) {
      const expected = existing.upload_expected_remote_hash || null;
      if (!expected || remoteHash !== expected) return true;
    }
    // Unverified listing still reports the last fully synced size: ordinary propagation lag
    // when size updates before the verified digest lands.
    const syncedRemoteSize = existing?.synced_remote_size;
    if ((remoteHash == null || remoteHash === '') &&
        syncedRemoteSize != null && remoteSize != null &&
        Number.isFinite(Number(syncedRemoteSize)) && Number.isFinite(Number(remoteSize)) &&
        Number(syncedRemoteSize) === Number(remoteSize)) {
      return true;
    }
    return false;
  }

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

  function throwIfCancelled(expectedGeneration, message = 'Sync operation cancelled') {
    if (expectedGeneration !== null && expectedGeneration !== lifecycleGeneration) {
      throw Object.assign(new Error(message), { name: 'AbortError', cancelled: true });
    }
  }

  function authoritativeRequestSuperseded(expectedRequestVersion) {
    return expectedRequestVersion !== null && expectedRequestVersion !== authoritativeRequestVersion;
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
    if (!isDirectory) {
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
      const stat = fs.fstatSync(fd);
      hash.update(String(stat.size));
      const legacyHash = hash.digest('hex');
      return `v2:${legacyHash}:${Number(stat.ctimeMs).toFixed(3)}`;
    } finally {
      fs.closeSync(fd);
    }
  }

  function sha1File(filePath, expectedGeneration = null) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha1');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => {
        if (expectedGeneration !== null && expectedGeneration !== lifecycleGeneration) {
          stream.destroy(Object.assign(new Error('Upload verification cancelled'), { name: 'AbortError', cancelled: true }));
          return;
        }
        hash.update(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(`sha1:${hash.digest('hex')}`));
    });
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
    syncDb.upsertTrackedFile({
      remotePath: conflict.remotePath,
      localPath: local?.path || local?.local_path || null,
      type: local?.type || remote?.type || lastSync?.type || 'file',
      size: remote?.size ?? local?.size ?? null,
      localSize: local?.size ?? null,
      remoteSize: remote?.size ?? null,
      localModified: local?.modified ?? local?.local_modified ?? null,
      remoteModified: remote?.modified ?? remote?.remote_modified ?? null,
      localHash: local?.hash ?? local?.local_hash ?? null,
      remoteHash: remote?.hash ?? remote?.remote_hash ?? null,
      syncState: 'conflict'
    });
    syncDb.setSyncState(conflict.remotePath, 'conflict');
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
        if (!String(eventType).startsWith('scan')) {
          emit('local_change', { type: 'delete', path: fullPath, remotePath });
        }
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
      if (!String(eventType).startsWith('scan')) {
        emit('local_change', { type: 'create', path: fullPath, remotePath, isDir: local.type === 'folder' });
      }
      return remotePath;
    }

    if (existing.sync_state === 'remote_new') {
      recordConflict(local, {
        path: remotePath, modified: existing.remote_modified, size: existing.remote_size ?? existing.size,
        hash: existing.remote_hash, type: existing.type
      }, null);
      return remotePath;
    }

    if (['downloading', 'conflict'].includes(existing.sync_state)) return remotePath;

    // Local edit while a transfer is still in flight (before post-upload verification starts):
    // cancel into reupload-pending so we do not bind verification to post-edit bytes later.
    if (existing.sync_state === 'uploading' && !existing.upload_verification_local_hash) {
      if (!stat) return remotePath;
      const metadataChanged = existing.local_modified !== local.modified ||
        Number(existing.local_size ?? existing.size ?? 0) !== Number(local.size || 0);
      const hashChanged = Boolean(existing.local_hash && local.hash && existing.local_hash !== local.hash);
      if (metadataChanged || hashChanged) {
        syncDb.cancelUploadVerificationForLocalEdit(remotePath, {
          uploadedLocalHash: existing.local_hash,
          uploadedLocalSize: existing.local_size ?? existing.size,
          uploadedLocalModified: existing.local_modified,
          localPath: fullPath,
          localHash: local.hash,
          localSize: local.size,
          localModified: local.modified,
          type: local.type
        });
        syncDb.logEvent({
          fileId: existing.id,
          eventType: 'upload_error',
          detail: { path: remotePath, reason: 'upload_verification_cancelled', cause: 'local_edit_during_transfer' },
          severity: 'warn'
        });
        if (!String(eventType).startsWith('scan')) {
          emit('local_change', { type: 'modify', path: fullPath, remotePath, isDir: local.type === 'folder' });
        }
        requestAuthoritativeCycle();
      }
      return remotePath;
    }
    const metadataChanged = existing.local_modified !== local.modified ||
      Number(existing.local_size ?? existing.size ?? 0) !== Number(local.size || 0);
    const localHashParts = typeof local.hash === 'string' ? local.hash.split(':') : [];
    const fingerprintUpgrade = !metadataChanged && localHashParts[0] === 'v2' &&
      (!existing.local_hash || (!String(existing.local_hash).startsWith('v2:') && existing.local_hash === localHashParts[1]));
    if (fingerprintUpgrade) {
      syncDb.upgradeLocalFingerprint(remotePath, local.hash);
      if (['remote_new', 'remote_modified', 'remote_deleted'].includes(existing.sync_state)) {
        const migrated = syncDb.getTrackedFileByPath(remotePath);
        const remote = existing.sync_state === 'remote_deleted' ? null : {
          path: remotePath,
          modified: migrated.remote_modified,
          size: migrated.remote_size ?? migrated.size,
          hash: migrated.remote_hash,
          type: migrated.type
        };
        recordConflict(local, remote, migrated);
      }
      return remotePath;
    }
    const hashChanged = Boolean(existing.local_hash && local.hash && existing.local_hash !== local.hash);
    const hashMissing = Boolean(!existing.local_hash && local.hash);
    const changed = metadataChanged || hashChanged;
    if (!changed && !hashMissing) return remotePath;
    const hadPendingUploadVerification = Boolean(existing.upload_verification_local_hash);
    const nextState = existing.sync_state === 'remote_modified' && changed ? 'conflict'
      : changed && !['local_new', 'local_modified', 'pending_upload'].includes(existing.sync_state) ? 'local_modified'
      : existing.sync_state;

    if (nextState === 'conflict') {
      recordConflict(local, {
        path: remotePath, modified: existing.remote_modified, size: existing.remote_size ?? existing.size,
        hash: existing.remote_hash, type: existing.type
      }, existing);
    } else if (hadPendingUploadVerification && nextState === 'local_modified') {
      syncDb.cancelUploadVerificationForLocalEdit(remotePath, {
        uploadedLocalHash: existing.upload_verification_local_hash,
        uploadedLocalSize: existing.local_size ?? existing.size,
        uploadedLocalModified: existing.local_modified,
        localPath: fullPath,
        localHash: local.hash,
        localSize: local.size,
        localModified: local.modified,
        type: local.type
      });
      syncDb.logEvent({
        fileId: existing.id,
        eventType: 'upload_error',
        detail: { path: remotePath, reason: 'upload_verification_cancelled', cause: 'local_edit_before_verification' },
        severity: 'warn'
      });
      if (!String(eventType).startsWith('scan')) {
        emit('local_change', { type: 'modify', path: fullPath, remotePath, isDir: local.type === 'folder' });
      }
      requestAuthoritativeCycle();
    } else {
      syncDb.upsertTrackedFile({
        remotePath, localPath: fullPath, type: local.type, size: local.size, localSize: local.size,
        localModified: local.modified, localHash: local.hash, syncState: nextState
      });
      if (changed && nextState === 'local_modified') {
        syncDb.logEvent({ fileId: existing.id, eventType: 'local_modify', detail: { path: fullPath, size: local.size } });
        if (!String(eventType).startsWith('scan')) {
          emit('local_change', { type: 'modify', path: fullPath, remotePath, isDir: local.type === 'folder' });
        }
      }
      if (hadPendingUploadVerification && nextState !== 'uploading') {
        requestAuthoritativeCycle();
      }
    }
    return remotePath;
  }

  async function scanLocalTree(folder = activeFolder, expectedGeneration = null) {
    throwIfCancelled(expectedGeneration, 'Local scan cancelled');
    const target = path.resolve(folder);
    if (!isPathInside(target, activeFolder) && target !== activeFolder) throw new Error('Local scan escaped the active sync folder');
    fs.mkdirSync(target, { recursive: true });
    const stack = [target];
    const seen = new Set();
    let count = 0;
    let inspectedCount = 0;
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = await fs.promises.readdir(current, { withFileTypes: true }); }
      catch (error) { emit('warn', { message: `Cannot read ${current}: ${error.message}` }); continue; }
      throwIfCancelled(expectedGeneration, 'Local scan cancelled');
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        const relative = path.relative(activeFolder, fullPath);
        if (++inspectedCount > MAX_LOCAL_ITEMS) throw new Error(`Local scan exceeded ${MAX_LOCAL_ITEMS} items`);
        if (inspectedCount % SCAN_YIELD_EVERY === 0) {
          await yieldToEventLoop();
          throwIfCancelled(expectedGeneration, 'Local scan cancelled');
        }
        if (shouldIgnore(relative) || entry.isSymbolicLink()) continue;
        count++;
        const remotePath = trackLocalPath(fullPath, relative, 'scan');
        if (remotePath) seen.add(remotePath);
        if (entry.isDirectory()) stack.push(fullPath);
      }
    }

    let trackedCount = 0;
    for (const tracked of syncDb.listTrackedFiles()) {
      if (++trackedCount % SCAN_YIELD_EVERY === 0) {
        await yieldToEventLoop();
        throwIfCancelled(expectedGeneration, 'Local scan cancelled');
      }
      if (!tracked.local_path || tracked.remote_path === '__checkpoint__' || !isPathInside(tracked.local_path, activeFolder)) continue;
      if (!seen.has(tracked.remote_path) && !fs.existsSync(tracked.local_path)) {
        trackLocalPath(tracked.local_path, path.relative(activeFolder, tracked.local_path), 'scan-delete');
      }
    }
    emit('local_scan', { count, folder: activeFolder, ts: new Date().toISOString() });
    return { count, seen };
  }

  function requestAuthoritativeCycle() {
    watcherSyncDeferred = true;
    authoritativeRequestVersion++;
    if (cycleRunning) return;
    const requestedGeneration = lifecycleGeneration;
    setImmediate(() => {
      if (cycleRunning || requestedGeneration !== lifecycleGeneration) return;
      runSyncCycle().catch(() => {});
    });
  }

  function watchLocal(folder = activeFolder) {
    fs.mkdirSync(folder, { recursive: true });
    try {
      watcher = fs.watch(folder, { recursive: true }, (eventType, filename) => {
        if (!filename || shouldIgnore(filename)) return;
        const key = String(filename);
        const fullPath = path.resolve(folder, key);
        if (!isPathInside(fullPath, folder)) return;
        requestAuthoritativeCycle();
        clearTimeout(debounceTimers.get(key));
        debounceTimers.set(key, setTimeout(() => {
          debounceTimers.delete(key);
          try {
            trackLocalPath(fullPath, key, eventType);
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
    let inspectedCount = 0;
    let pendingIndex = 0;
    while (pendingIndex < pending.length) {
      throwIfCancelled(expectedGeneration, 'Remote traversal cancelled');
      const current = pending[pendingIndex++];
      if (current.depth > MAX_REMOTE_DEPTH) throw new Error(`Remote tree exceeded maximum depth ${MAX_REMOTE_DEPTH}`);
      const result = await protonRunner('list', { path: current.remotePath, logLevel: 'ERROR' });
      throwIfCancelled(expectedGeneration, 'Remote traversal cancelled');
      const listedItems = customListParser
        ? await customListParser(result.stdout)
        : await parseListOutputAsync(result.stdout, { requireJson: true });
      throwIfCancelled(expectedGeneration, 'Remote traversal cancelled');
      for (const item of listedItems) {
        inspectedCount += 1;
        if (inspectedCount % SCAN_YIELD_EVERY === 0) {
          await yieldToEventLoop();
          throwIfCancelled(expectedGeneration, 'Remote traversal cancelled');
        }
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

  function recordUploadVerificationConflict(existing, local, remote, reason) {
    const pendingResolution = pendingUploadResolutions.get(existing.remote_path);
    pendingUploadResolutions.delete(existing.remote_path);
    if (!conflictStore) {
      syncDb.setSyncState(existing.remote_path, 'conflict');
      return;
    }
    conflictStore.record({
      id: pendingResolution?.conflictId || crypto.randomBytes(8).toString('hex'),
      type: local && remote && local.type !== remote.type ? 'type_mismatch' : 'hash_mismatch',
      reason,
      remotePath: existing.remote_path,
      localPath: existing.local_path,
      remoteModified: remote?.modified || null,
      localModified: local?.modified || null,
      remoteSize: remote?.size || 0,
      localSize: local?.size || 0,
      remoteHash: remote?.hash || null,
      localHash: local?.hash || null,
      detectedAt: new Date().toISOString()
    });
  }

  async function reconcileUploadVerification(existing, local, remote, item, expectedGeneration, expectedRequestVersion = null) {
    if (authoritativeRequestSuperseded(expectedRequestVersion)) return false;
    const localSnapshotMatches = remote.type === 'folder'
      ? existing.upload_verification_local_hash === 'folder:upload'
      : local?.hash === existing.upload_verification_local_hash;
    if (!local || local.type !== remote.type) {
      recordUploadVerificationConflict(existing, local, remote,
        'The local upload snapshot changed or no longer matches the authoritative remote revision');
      return;
    }
    if (!localSnapshotMatches) {
      // Local content changed after the upload finished. Cancel verification ownership and
      // treat this as a fresh local modification instead of a sticky conflict.
      pendingUploadResolutions.delete(existing.remote_path);
      const expectedRemoteHash = existing.upload_expected_remote_hash || null;
      syncDb.cancelUploadVerificationForLocalEdit(existing.remote_path, {
        uploadedLocalHash: existing.upload_verification_local_hash,
        uploadedLocalSize: existing.local_size ?? existing.size,
        uploadedLocalModified: existing.local_modified,
        localPath: existing.local_path || local.path,
        localHash: local.hash,
        localSize: local.size,
        localModified: local.modified,
        type: local.type
      });
      if (remote.hash && expectedRemoteHash && remote.hash === expectedRemoteHash) {
        syncDb.adoptRemoteBaselineForReupload(existing.remote_path, {
          remoteHash: remote.hash,
          remoteSize: remote.size,
          remoteModified: remote.modified
        });
      } else if (remote.hash && expectedRemoteHash && remote.hash !== expectedRemoteHash) {
        if (isRemoteStillPropagationLag(existing, remote.hash, remote.size)) {
          syncDb.upsertTrackedFile({
            remotePath: existing.remote_path,
            localPath: existing.local_path || local.path,
            type: local.type,
            size: local.size,
            localSize: local.size,
            localModified: local.modified,
            localHash: local.hash,
            remoteSize: remote.size,
            remoteModified: remote.modified,
            remoteHash: remote.hash,
            syncState: 'local_modified'
          });
        } else {
          recordConflict(local, remote, existing);
        }
      } else {
        syncDb.upsertTrackedFile({
          remotePath: existing.remote_path,
          localPath: existing.local_path || local.path,
          type: local.type,
          size: local.size,
          localSize: local.size,
          localModified: local.modified,
          localHash: local.hash,
          remoteSize: remote.size,
          remoteModified: remote.modified,
          remoteHash: remote.hash,
          syncState: 'local_modified'
        });
      }
      syncDb.logEvent({
        fileId: existing.id,
        eventType: 'upload_error',
        detail: { path: existing.remote_path, reason: 'upload_verification_cancelled', cause: 'local_snapshot_changed' },
        severity: 'warn'
      });
      requestAuthoritativeCycle();
      return;
    }
    const compatible = remote.type === 'folder' || Number(local.size) === Number(remote.size);
    if (!compatible) {
      // Size differs from observed remote. If the listing is still the last fully synced
      // revision or an intermediate own upload, this is propagation lag — wait.
      if (isRemoteStillPropagationLag(existing, remote.hash || null, remote.size)) {
        syncDb.upsertTrackedFile({
          remotePath: existing.remote_path, localPath: existing.local_path, type: remote.type || existing.type,
          localSize: local.size, localModified: local.modified, localHash: local.hash,
          remoteSize: remote.size, remoteModified: remote.modified, remoteHash: remote.hash || null,
          syncState: 'uploading'
        });
        emit('warn', {
          message: 'Upload is awaiting the expected remote digest after local upload',
          path: existing.remote_path,
          expectedRemoteHash: existing.upload_expected_remote_hash || null,
          observedRemoteHash: remote.hash || null
        });
        return;
      }
      recordUploadVerificationConflict(existing, local, remote,
        'The local upload snapshot changed or no longer matches the authoritative remote revision');
      return;
    }

    let verifiedLocal = local;
    if (remote.type === 'file') {
      if (!item.hash) {
        syncDb.upsertTrackedFile({
          remotePath: existing.remote_path, localPath: existing.local_path, type: remote.type,
          localSize: local.size, localModified: local.modified, localHash: local.hash,
          remoteSize: remote.size, remoteModified: remote.modified, remoteHash: null,
          syncState: 'uploading'
        });
        emit('warn', { message: 'Upload is awaiting a verified remote digest', path: existing.remote_path });
        return;
      }
      const localSha1 = await sha1File(existing.local_path, expectedGeneration);
      throwIfCancelled(expectedGeneration, 'Upload verification cancelled');
      if (authoritativeRequestSuperseded(expectedRequestVersion)) return false;
      try {
        const stat = fs.lstatSync(existing.local_path);
        verifiedLocal = stat.isFile() ? localMetadata(existing.local_path, stat) : null;
      } catch {
        verifiedLocal = null;
      }
      if (!verifiedLocal || verifiedLocal.hash !== existing.upload_verification_local_hash) {
        pendingUploadResolutions.delete(existing.remote_path);
        if (verifiedLocal) {
          const expectedRemoteHash = existing.upload_expected_remote_hash || null;
          syncDb.cancelUploadVerificationForLocalEdit(existing.remote_path, {
            uploadedLocalHash: existing.upload_verification_local_hash,
            uploadedLocalSize: existing.local_size ?? existing.size,
            uploadedLocalModified: existing.local_modified,
            localPath: existing.local_path || verifiedLocal.path,
            localHash: verifiedLocal.hash,
            localSize: verifiedLocal.size,
            localModified: verifiedLocal.modified,
            type: verifiedLocal.type
          });
          if (remote.hash && expectedRemoteHash && remote.hash === expectedRemoteHash) {
            syncDb.adoptRemoteBaselineForReupload(existing.remote_path, {
              remoteHash: remote.hash,
              remoteSize: remote.size,
              remoteModified: remote.modified
            });
          } else if (remote.hash && expectedRemoteHash && remote.hash !== expectedRemoteHash) {
            if (isRemoteStillPropagationLag(existing, remote.hash, remote.size)) {
              syncDb.upsertTrackedFile({
                remotePath: existing.remote_path,
                localPath: existing.local_path || verifiedLocal.path,
                type: verifiedLocal.type,
                size: verifiedLocal.size,
                localSize: verifiedLocal.size,
                localModified: verifiedLocal.modified,
                localHash: verifiedLocal.hash,
                remoteSize: remote.size,
                remoteModified: remote.modified,
                remoteHash: remote.hash,
                syncState: 'local_modified'
              });
            } else {
              recordConflict(verifiedLocal, remote, existing);
            }
          } else {
            syncDb.upsertTrackedFile({
              remotePath: existing.remote_path,
              localPath: existing.local_path || verifiedLocal.path,
              type: verifiedLocal.type,
              size: verifiedLocal.size,
              localSize: verifiedLocal.size,
              localModified: verifiedLocal.modified,
              localHash: verifiedLocal.hash,
              remoteSize: remote.size,
              remoteModified: remote.modified,
              remoteHash: remote.hash,
              syncState: 'local_modified'
            });
          }
          syncDb.logEvent({
            fileId: existing.id,
            eventType: 'upload_error',
            detail: { path: existing.remote_path, reason: 'upload_verification_cancelled', cause: 'local_snapshot_changed_during_hash' },
            severity: 'warn'
          });
          requestAuthoritativeCycle();
        } else {
          recordUploadVerificationConflict(existing, verifiedLocal, remote,
            'The verified remote digest does not match the unchanged uploaded local content');
        }
        return;
      }
      if (Number(verifiedLocal.size) !== Number(remote.size) || localSha1 !== item.hash) {
        // Propagation lag: last-synced baseline OR intermediate own upload still listed.
        const expectedRemoteHash = existing.upload_expected_remote_hash || null;
        if (isRemoteStillPropagationLag(existing, item.hash || null, item.size)) {
          syncDb.upsertTrackedFile({
            remotePath: existing.remote_path, localPath: existing.local_path, type: remote.type,
            localSize: verifiedLocal.size, localModified: verifiedLocal.modified, localHash: verifiedLocal.hash,
            remoteSize: remote.size, remoteModified: remote.modified, remoteHash: item.hash || null,
            syncState: 'uploading'
          });
          emit('warn', {
            message: 'Upload is awaiting the expected remote digest after local upload',
            path: existing.remote_path,
            expectedRemoteHash,
            observedRemoteHash: item.hash || null
          });
          return;
        }
        recordUploadVerificationConflict(existing, verifiedLocal, remote,
          'The verified remote digest does not match the unchanged uploaded local content');
        return;
      }
    }

    const pendingResolution = pendingUploadResolutions.get(existing.remote_path);
    const activeConflict = conflictStore?.listActive?.().find(conflict => conflict.remotePath === existing.remote_path);
    if (activeConflict && !pendingResolution) {
      syncDb.setSyncState(existing.remote_path, 'conflict');
      return;
    }

    syncDb.upsertTrackedFile({
      remotePath: existing.remote_path, localPath: existing.local_path, type: remote.type,
      size: remote.size, localSize: verifiedLocal.size, remoteSize: remote.size,
      localModified: verifiedLocal.modified, remoteModified: remote.modified,
      localHash: verifiedLocal.hash, remoteHash: remote.hash, syncState: 'uploading'
    });
    syncDb.markSynced(existing.remote_path);
    clearOwnUploadDigests(existing.remote_path);
    syncDb.logEvent({ fileId: existing.id, eventType: 'upload_complete', detail: { path: existing.remote_path, remoteHash: remote.hash, authoritativeVerification: true } });
    if (pendingResolution) {
      conflictStore.commitResolution(pendingResolution.conflictId, pendingResolution.strategy, { transferCompleted: true });
      pendingUploadResolutions.delete(existing.remote_path);
      emit('conflict_resolved', {
        conflictId: pendingResolution.conflictId,
        strategy: pendingResolution.strategy,
        transferId: pendingResolution.transferId
      });
    }
  }

  async function pollRemote(expectedGeneration = null, expectedRequestVersion = null) {
    const status = await statusProvider();
    throwIfCancelled(expectedGeneration, 'Remote poll cancelled');
    if (status.busy || !status.authenticated || !status.installed) {
      emit('warn', { message: 'Skipping remote poll: CLI not ready', status });
      return { authoritative: false, items: [], reason: 'cli-not-ready', status };
    }

    const items = await listRemoteTree('/my-files', expectedGeneration);
    const supersededSnapshot = () => ({ authoritative: true, items, superseded: true });
    if (authoritativeRequestSuperseded(expectedRequestVersion)) return supersededSnapshot();
    const seen = new Set();
    const changeCounts = { created: 0, modified: 0, deleted: 0 };
    let processedRemoteItems = 0;
    for (const item of items) {
      if (processedRemoteItems > 0 && processedRemoteItems % SCAN_YIELD_EVERY === 0) {
        await yieldToEventLoop();
        throwIfCancelled(expectedGeneration, 'Remote poll cancelled');
        if (authoritativeRequestSuperseded(expectedRequestVersion)) return supersededSnapshot();
      }
      processedRemoteItems++;
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
          changeCounts.created++;
        }
        continue;
      }

      if (existing.sync_state === 'uploading' && existing.upload_verification_local_hash) {
        const reconciled = await reconcileUploadVerification(
          existing, local, remote, item, expectedGeneration, expectedRequestVersion
        );
        if (reconciled === false) return supersededSnapshot();
        continue;
      }

      if (Number(existing.upload_reupload_pending) === 1 &&
          ['local_modified', 'pending_upload'].includes(existing.sync_state)) {
        const expectedRemoteHash = existing.upload_expected_remote_hash || null;
        if (local) {
          syncDb.upsertTrackedFile({
            remotePath,
            localPath: existing.local_path || localPath,
            type: local.type,
            size: local.size,
            localSize: local.size,
            localModified: local.modified,
            localHash: local.hash,
            remoteSize: remote.size,
            remoteModified: remote.modified,
            remoteHash: remote.hash,
            syncState: 'local_modified'
          });
        } else {
          syncDb.upsertTrackedFile({
            remotePath,
            remoteSize: remote.size,
            remoteModified: remote.modified,
            remoteHash: remote.hash,
            syncState: 'local_modified'
          });
        }

        // Only absorb a remote revision we know came from the cancelled upload.
        if (remote.hash && expectedRemoteHash && remote.hash === expectedRemoteHash) {
          syncDb.adoptRemoteBaselineForReupload(remotePath, {
            remoteHash: remote.hash,
            remoteSize: remote.size,
            remoteModified: remote.modified
          });
          continue;
        }

        // A different verified remote digest means a concurrent remote edit, not our upload.
        // Last-synced baseline or intermediate own upload is listing lag, not third-party.
        if (remote.hash && expectedRemoteHash && remote.hash !== expectedRemoteHash) {
          if (!isRemoteStillPropagationLag(existing, remote.hash, remote.size)) {
            recordConflict(local || {
              path: existing.local_path,
              modified: existing.local_modified,
              size: existing.local_size ?? existing.size,
              hash: existing.local_hash,
              type: existing.type
            }, remote, existing);
          }
          continue;
        }

        // Pin missing: if remote advanced past the last fully synchronized revision, do not
        // silently replace it. Conflict instead of overwrite — unless it is our intermediate.
        if (remote.hash && !expectedRemoteHash) {
          const syncedRemote = existing.synced_remote_hash || null;
          if (syncedRemote && syncedRemote !== 'legacy:unknown' && remote.hash !== syncedRemote &&
              !isOwnPriorRemoteDigest(remotePath, remote.hash)) {
            recordConflict(local || {
              path: existing.local_path,
              modified: existing.local_modified,
              size: existing.local_size ?? existing.size,
              hash: existing.local_hash,
              type: existing.type
            }, remote, existing);
          }
          continue;
        }

        // No verified remote digest yet, or remote still matches last sync: keep waiting to re-upload.
        continue;
      }

      const remoteHashBaselineUnknown = Boolean(
        item.type === 'file' && item.hash && existing.sync_state === 'synced' &&
        (!existing.synced_remote_hash || existing.synced_remote_hash === 'legacy:unknown')
      );
      const remoteHashChanged = Boolean(
        item.type === 'file' && item.hash && existing.remote_hash && item.hash !== existing.remote_hash
      );
      const remoteChanged = Boolean(
        (item.modified && existing.remote_modified && item.modified !== existing.remote_modified) ||
        (item.type === 'file' && Number(item.size || 0) !== Number(existing.remote_size ?? existing.size ?? 0)) ||
        remoteHashBaselineUnknown || remoteHashChanged
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
        changeCounts.modified++;
      }
      syncDb.upsertTrackedFile(update);
      if (existing.sync_state === 'synced' && !existing.remote_modified && item.modified) {
        syncDb.markSynced(remotePath);
      }
    }

    if (authoritativeRequestSuperseded(expectedRequestVersion)) return supersededSnapshot();
    let checkedTrackedItems = 0;
    for (const existing of syncDb.listTrackedFiles()) {
      if (checkedTrackedItems > 0 && checkedTrackedItems % SCAN_YIELD_EVERY === 0) {
        await yieldToEventLoop();
        throwIfCancelled(expectedGeneration, 'Remote poll cancelled');
        if (authoritativeRequestSuperseded(expectedRequestVersion)) return supersededSnapshot();
      }
      checkedTrackedItems++;
      if (existing.remote_path === '__checkpoint__' || !existing.remote_path.startsWith('/my-files/')) continue;
      if (seen.has(existing.remote_path) || ['local_new', 'pending_upload', 'uploading', 'conflict', 'remote_deleted'].includes(existing.sync_state)) continue;
      // A cancelled upload waiting to re-upload is not a remote delete, even if the listing is
      // briefly empty while the remote revision propagates.
      if (Number(existing.upload_reupload_pending) === 1) continue;
      const local = existing.local_path && fs.existsSync(existing.local_path)
        ? localMetadata(existing.local_path, fs.lstatSync(existing.local_path)) : null;
      if (local && ['local_modified', 'local_deleted'].includes(existing.sync_state)) {
        recordConflict(local, null, existing);
      } else {
        syncDb.setSyncState(existing.remote_path, 'remote_deleted');
        syncDb.logEvent({ fileId: existing.id, eventType: 'remote_delete', detail: { path: existing.remote_path }, severity: 'warn' });
        changeCounts.deleted++;
      }
    }
    const totalChanges = changeCounts.created + changeCounts.modified + changeCounts.deleted;
    if (totalChanges) emit('remote_change', { type: 'scan_summary', counts: changeCounts, total: totalChanges });
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
    for (const item of syncDb.listTrackedFiles('local_deleted')) {
      syncDb.setSyncState(item.remote_path, canDownload() ? 'pending_download' : 'ignored');
    }
    for (const item of syncDb.listTrackedFiles('remote_deleted')) {
      const canRestoreRemote = canUpload() && item.local_path && fs.existsSync(item.local_path);
      syncDb.setSyncState(item.remote_path, canRestoreRemote ? 'pending_upload' : 'ignored');
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
          const intentLocalHash = item.local_hash || null;
          const previousTransferId = activeUploadTransferByPath.get(item.remote_path);
          const transferId = transferQueue.enqueue('upload', {
            localPaths: [item.local_path],
            parentPath: path.posix.dirname(item.remote_path),
            fileConflictStrategy: mode === SYNC_MODES.CONSERVATIVE ? 'skip' : 'replace',
            folderConflictStrategy: 'merge',
            logLevel: 'ERROR'
          }, 'medium');
          if (previousTransferId && previousTransferId !== transferId) {
            try { transferQueue.cancel?.(previousTransferId); } catch {}
            syncTransferIds.delete(previousTransferId);
          }
          syncTransferIds.add(transferId);
          activeUploadTransferByPath.set(item.remote_path, transferId);
          syncDb.setSyncState(item.remote_path, 'uploading');
          // Pin the uploaded content digest as early as possible so a later local edit during
          // verification still knows which remote revision is "ours".
          if (item.type === 'file' && item.local_path && intentLocalHash) {
            void pinUploadContentDigest(item.remote_path, item.local_path, intentLocalHash);
          }
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
    const uploads = syncDb.getStaleItemsByState('uploading', cutoff)
      .filter(item => !item.upload_verification_local_hash);
    for (const item of downloads) syncDb.setSyncState(item.remote_path, 'pending_download');
    for (const item of uploads) syncDb.setSyncState(item.remote_path, 'pending_upload');
    if (downloads.length || uploads.length) {
      emit('info', {
        message: `Recovered ${downloads.length} stale downloads and ${uploads.length} stale uploads`
      });
    }
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

  async function pinUploadContentDigest(remotePath, localPath, intentLocalHash) {
    try {
      if (!localPath || !fs.existsSync(localPath) || !intentLocalHash) return false;
      const latestBefore = syncDb.getTrackedFileByPath(remotePath);
      if (!latestBefore) return false;
      // Only hash bytes that still match the upload intent. After a local edit, the current
      // file is no longer the uploaded revision and must not become the expected remote pin.
      const currentIsIntent = latestBefore.local_hash === intentLocalHash ||
        latestBefore.upload_verification_local_hash === intentLocalHash;
      if (!currentIsIntent) return false;
      // sha1File already returns a fully qualified "sha1:<hex>" digest.
      const digest = await sha1File(localPath, lifecycleGeneration);
      const latest = syncDb.getTrackedFileByPath(remotePath);
      if (!latest) return false;
      // Do not accept the pin via synced_local_hash alone: cancel-for-reupload writes the
      // uploaded snapshot into synced_local while the current file may already be newer.
      const stillIntent = latest.local_hash === intentLocalHash ||
        latest.upload_verification_local_hash === intentLocalHash;
      if (!stillIntent) return false;
      if (!digest || typeof digest !== 'string' || !digest.startsWith('sha1:')) return false;
      rememberOwnUploadDigest(remotePath, digest);
      return syncDb.setUploadExpectedRemoteHash(remotePath, digest);
    } catch {
      return false;
    }
  }

  function cleanupQueueListeners() {
    for (const remove of queueRemoveHandlers) {
      try { if (typeof remove === 'function') remove(); } catch {}
    }
    queueRemoveHandlers = [];
  }

  function maybeEmitSyncComplete() {
    const queueState = transferQueue?.getState?.();
    const counts = syncDb.countByState();
    const outstanding = ['pending_upload', 'pending_download', 'uploading', 'downloading', 'local_new', 'remote_new', 'local_modified', 'remote_modified', 'conflict']
      .reduce((total, state) => total + Number(counts[state] || 0), 0);
    if ((!queueState || (!queueState.active.length && !queueState.pending.length)) && outstanding === 0) {
      syncDb.saveCheckpoint(`sync_complete_${Date.now()}`);
      emit('sync_complete', { verified: true, stats: syncDb.getStats(), ts: new Date().toISOString() });
    }
  }

  function setupQueueListeners() {
    if (!transferQueue?.on) return;
    if (queueRemoveHandlers.length) return;
    queueRemoveHandlers.push(transferQueue.on('complete', payload => {
      if (!syncTransferIds.delete(payload.id)) return;
      const completedUploadPaths = [];
      const verificationJobs = [];
      for (const localPath of payload.options?.localPaths || []) {
        for (const item of syncDb.listTrackedFiles().filter(record => record.local_path === localPath)) {
          // Snapshot upload intent before refresh so a quiet post-transfer edit cannot bind
          // verification to the wrong local bytes.
          const before = syncDb.getTrackedFileByPath(item.remote_path);
          const priorLocalHash = before?.local_hash || null;
          const priorPin = before?.upload_expected_remote_hash || null;

          // A newer upload for this path superseded this transfer — ignore its completion.
          if (activeUploadTransferByPath.get(item.remote_path) !== payload.id) {
            completedUploadPaths.push(item.remote_path);
            continue;
          }

          // Edit during transfer already cancelled verification ownership.
          if (before && Number(before.upload_reupload_pending) === 1 &&
              ['local_modified', 'pending_upload'].includes(before.sync_state)) {
            completedUploadPaths.push(item.remote_path);
            continue;
          }

          let currentLocal = null;
          try {
            if (item.local_path && fs.existsSync(item.local_path)) {
              const stat = fs.lstatSync(item.local_path);
              if (!stat.isSymbolicLink()) currentLocal = localMetadata(item.local_path, stat);
            }
          } catch {
            currentLocal = null;
          }

          // Quiet local edit after the transfer finished (no watcher/scan yet): do not verify
          // the new bytes against the just-finished upload. Cancel into reupload instead.
          if (currentLocal && priorLocalHash && currentLocal.hash !== priorLocalHash) {
            syncDb.cancelUploadVerificationForLocalEdit(item.remote_path, {
              uploadedLocalHash: priorLocalHash,
              uploadedLocalSize: before?.local_size ?? before?.size ?? null,
              uploadedLocalModified: before?.local_modified ?? null,
              localPath: item.local_path || currentLocal.path,
              localHash: currentLocal.hash,
              localSize: currentLocal.size,
              localModified: currentLocal.modified,
              type: currentLocal.type
            });
            if (priorPin) {
              try { syncDb.setUploadExpectedRemoteHash(item.remote_path, priorPin); } catch {}
            }
            completedUploadPaths.push(item.remote_path);
            continue;
          }

          if (currentLocal) {
            syncDb.upsertTrackedFile({
              remotePath: item.remote_path,
              localPath: item.local_path,
              type: currentLocal.type,
              size: currentLocal.size,
              localSize: currentLocal.size,
              localModified: currentLocal.modified,
              localHash: currentLocal.hash
            });
          }

          // Bind verification to the uploaded intent (pre-complete local hash + enqueue pin).
          syncDb.beginUploadVerification(item.remote_path, {
            expectedRemoteHash: priorPin,
            verificationLocalHash: priorLocalHash
          });
          completedUploadPaths.push(item.remote_path);
          verificationJobs.push({
            remotePath: item.remote_path,
            localPath: item.local_path,
            type: item.type,
            intentLocalHash: priorLocalHash
          });
          syncDb.logEvent({
            fileId: item.id,
            eventType: 'upload_complete',
            detail: { path: item.remote_path, awaitingRemoteVerification: true }
          });
        }
      }
      if (completedUploadPaths.length && !verificationJobs.length) requestAuthoritativeCycle();
      void (async () => {
        for (const job of verificationJobs) {
          try {
            if (job.type === 'folder' || !job.localPath) continue;
            const row = syncDb.getTrackedFileByPath(job.remotePath);
            if (!row) continue;
            const intent = job.intentLocalHash || row.upload_verification_local_hash || row.local_hash;
            await pinUploadContentDigest(job.remotePath, job.localPath, intent);
          } catch {}
        }
        if (completedUploadPaths.length) requestAuthoritativeCycle();
      })().catch(error => emit('error', { source: 'uploadVerificationPin', message: error.message }));
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
        if (completedUploadPaths.length) {
          for (const remotePath of completedUploadPaths) {
            pendingUploadResolutions.set(remotePath, { ...pendingResolution, transferId: payload.id });
          }
          pendingResolutions.delete(payload.id);
        } else {
          conflictStore.commitResolution(pendingResolution.conflictId, pendingResolution.strategy, { transferCompleted: true });
          pendingResolutions.delete(payload.id);
          emit('conflict_resolved', { conflictId: pendingResolution.conflictId, strategy: pendingResolution.strategy, transferId: payload.id });
        }
      }
      if (completedUploadPaths.length) requestAuthoritativeCycle();
      maybeEmitSyncComplete();
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
    const requestVersionAtStart = authoritativeRequestVersion;
    let authoritativeRemoteObserved = false;
    const work = (async () => {
      try {
        recoverStaleStates();
        emit('sync_start', { ts: new Date().toISOString() });
        if (canUpload()) await scanLocalTree(activeFolder, generation);
        const remoteSnapshot = await pollRemote(generation, requestVersionAtStart);
        if (generation !== lifecycleGeneration) return { stopped: true, queued: 0 };
        if (!remoteSnapshot.authoritative) {
          return { ok: false, skipped: true, reason: remoteSnapshot.reason, queued: 0, remoteCount: 0 };
        }
        authoritativeRemoteObserved = true;
        const remoteItems = remoteSnapshot.items;
        if (authoritativeRequestVersion !== requestVersionAtStart) {
          return { ok: true, deferred: true, queued: 0, remoteCount: remoteItems.length };
        }
        watcherSyncDeferred = false;
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
        if (authoritativeRemoteObserved && watcherSyncDeferred && generation === lifecycleGeneration) {
          setImmediate(() => {
            if (!watcherSyncDeferred || cycleRunning || generation !== lifecycleGeneration) return;
            runSyncCycle().catch(() => {});
          });
        }
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
    if (stoppingPromise) throw new Error('Sync is stopping. Wait for stop() to settle before restarting.');
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
      watchLocal(activeFolder);
    }
    pollTimer = setInterval(() => runSyncCycle().catch(() => {}), pollInterval);
    pollTimer.unref?.();
    emit('started', { mode, folder: activeFolder, pollInterval, ts: new Date().toISOString() });
    runSyncCycle().catch(() => {});
    return getState();
  }

  async function stop() {
    if (stoppingPromise) return stoppingPromise;
    const work = (async () => {
      schedulerActive = false;
      watcherSyncDeferred = false;
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
    })();
    stoppingPromise = work;
    try {
      return await work;
    } finally {
      if (stoppingPromise === work) stoppingPromise = null;
    }
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
      pollTimer = setInterval(() => runSyncCycle().catch(() => {}), pollInterval);
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
      const conflict = conflictStore.get?.(conflictId) || conflictStore.listActive?.().find(c => c.id === conflictId);
      const remotePath = conflict?.remotePath || action.remotePath ||
        (action.localPaths?.[0] ? path.posix.join(action.parentPath || '/my-files', path.basename(action.localPaths[0])) : null);
      if (remotePath) activeUploadTransferByPath.set(remotePath, result.transferId);
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
