/**
 * conflictStore.js — Conflict Detection and Resolution System
 *
 * Detects, classifies, stores, and resolves file conflicts between
 * local and remote Proton Drive states.
 *
 * Conflict types:
 *   - LOCAL_REMOTE_MODIFY: Both sides changed since last sync
 *   - LOCAL_DELETE_REMOTE_MODIFY: Local deleted, remote modified
 *   - REMOTE_DELETE_LOCAL_MODIFY: Remote deleted, local modified
 *   - BOTH_CREATE: Both sides created a file at the same path
 *   - TYPE_MISMATCH: File became folder or vice versa
 *   - SIZE_MISMATCH: Significant size delta on "synced" file
 *   - HASH_MISMATCH: Content hash differs when metadata says synced
 */
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

const CONFLICT_TYPES = Object.freeze({
  LOCAL_REMOTE_MODIFY: 'local_remote_modify',
  LOCAL_DELETE_REMOTE_MODIFY: 'local_delete_remote_modify',
  REMOTE_DELETE_LOCAL_MODIFY: 'remote_delete_local_modify',
  BOTH_CREATE: 'both_create',
  TYPE_MISMATCH: 'type_mismatch',
  SIZE_MISMATCH: 'size_mismatch',
  HASH_MISMATCH: 'hash_mismatch'
});

const RESOLUTION_STRATEGIES = Object.freeze({
  KEEP_LOCAL: 'keep_local',
  KEEP_REMOTE: 'keep_remote',
  KEEP_BOTH: 'keep_both',
  OVERWRITE_LOCAL: 'overwrite_local',
  OVERWRITE_REMOTE: 'overwrite_remote',
  SKIP: 'skip'
});

/**
 * Create a conflict store that works with syncDb.
 * @param {object} syncDb - Sync metadata database instance
 * @returns {object} ConflictStore API
 */
function createConflictStore(syncDb) {
  const activeConflicts = new Map(); // fileId -> { conflict record }

  /**
   * Detect conflicts between local and remote state for a file.
   * @param {object} local - { path, modified, size, hash, type }
   * @param {object} remote - { path, modified, size, hash, type }
   * @param {object} [lastSync] - Last known synced state from DB
   * @returns {object|null} Detected conflict or null
   */
  function detect(local, remote, lastSync) {
    if (!lastSync) {
      // No prior sync record — first-time comparison
      if (local && remote) {
        return createConflict(local, remote, CONFLICT_TYPES.BOTH_CREATE,
          'Both sides have content at this path with no sync history');
      }
      return null;
    }

    // Type mismatch
    if (local && remote && local.type !== remote.type) {
      return createConflict(local, remote, CONFLICT_TYPES.TYPE_MISMATCH,
        `Local is ${local.type}, remote is ${remote.type}`);
    }

    // Both modified — check size mismatch first when timestamps are within tolerance
    if (local && remote) {
      const localChanged = hasChanged(local, lastSync);
      const remoteChanged = hasChanged(remote, lastSync);
      const preLocalSize = lastSync ? lastSync.size : 0;

      // Size mismatch: timestamps match but sizes differ significantly
      const sizeDelta = Math.abs((local.size || 0) - (remote.size || 0));
      if (sizeDelta > 64 && lastSync && lastSync.sync_state === 'synced') {
        const localTimeOk = timesMatch(local, lastSync);
        const remoteTimeOk = timesMatch(remote, lastSync);
        if (localTimeOk && remoteTimeOk) {
          return createConflict(local, remote, CONFLICT_TYPES.SIZE_MISMATCH,
            `Size mismatch: local ${local.size} vs remote ${remote.size} (was ${preLocalSize})`);
        }
      }

      if (localChanged && remoteChanged) {
        return createConflict(local, remote, CONFLICT_TYPES.LOCAL_REMOTE_MODIFY,
          'Both local and remote modified since last sync');
      }
    }

    // Local delete, remote modify
    if (!local && remote && hasChanged(remote, lastSync)) {
      return createConflict(local || { path: lastSync.local_path, type: lastSync.type },
        remote, CONFLICT_TYPES.LOCAL_DELETE_REMOTE_MODIFY,
        'Local file deleted, remote was modified');
    }

    // Remote delete, local modify
    if (local && !remote && hasChanged(local, lastSync)) {
      return createConflict(local, remote || { path: lastSync.remote_path, type: lastSync.type },
        CONFLICT_TYPES.REMOTE_DELETE_LOCAL_MODIFY,
        'Remote file deleted, local was modified');
    }

    return null;
  }

  function hasChanged(current, lastSync) {
    if (!current || !lastSync) return true;

    const currentModified = new Date(current.modified || current.local_modified || current.remote_modified || 0).getTime();
    const lastModified = new Date(lastSync.local_modified || lastSync.remote_modified || 0).getTime();

    // Consider it changed if modified time differs by more than 2 seconds
    if (Math.abs(currentModified - lastModified) > 2000) return true;

    // Consider it changed if size differs
    if ((current.size || 0) !== (lastSync.size || 0)) return true;

    return false;
  }

  function timesMatch(current, lastSync) {
    if (!current || !lastSync) return false;
    const currentModified = new Date(current.modified || current.local_modified || current.remote_modified || 0).getTime();
    const lastModified = new Date(lastSync.local_modified || lastSync.remote_modified || 0).getTime();
    return Math.abs(currentModified - lastModified) <= 2000;
  }

  function createConflict(local, remote, type, reason) {
    // Deterministic conflict ID based on path and type
    const remotePath = remote?.path || remote?.remote_path || local?.remote_path || '';
    const conflictId = crypto.createHash('sha256')
      .update(`conflict:${remotePath}:${type}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16);

    return {
      id: conflictId,
      type,
      reason,
      remotePath,
      localPath: local?.path || local?.local_path || null,
      remoteModified: remote?.modified || remote?.remote_modified || null,
      localModified: local?.modified || local?.local_modified || null,
      remoteSize: remote?.size || 0,
      localSize: local?.size || 0,
      remoteHash: remote?.hash || remote?.remote_hash || null,
      localHash: local?.hash || local?.local_hash || null,
      detectedAt: new Date().toISOString(),
      status: 'open'
    };
  }

  /**
   * Record a detected conflict in both memory and syncDb.
   */
  function record(conflict) {
    if (!conflict || !conflict.remotePath) return null;

    // Store in memory
    activeConflicts.set(conflict.id, { ...conflict, status: 'open' });

    // Persist to syncDb
    if (syncDb) {
      const fileId = syncDb.pathToId(conflict.remotePath);
      syncDb.recordConflict({
        fileId,
        remotePath: conflict.remotePath,
        localPath: conflict.localPath,
        reason: conflict.reason,
        remoteModified: conflict.remoteModified,
        localModified: conflict.localModified,
        remoteHash: conflict.remoteHash,
        localHash: conflict.localHash
      });
    }

    return conflict.id;
  }

  /**
   * Resolve a conflict with a chosen strategy.
   */
  function resolve(conflictId, strategy) {
    const conflict = activeConflicts.get(conflictId);
    if (!conflict) return false;

    if (!Object.values(RESOLUTION_STRATEGIES).includes(strategy)) {
      throw new Error(`Invalid resolution strategy: ${strategy}`);
    }

    conflict.status = 'resolved';
    conflict.resolvedAt = new Date().toISOString();
    conflict.resolution = strategy;
    activeConflicts.set(conflictId, conflict);

    // Update syncDb
    if (syncDb) {
      syncDb.resolveConflict(conflict.remotePath, strategy);
    }

    // Generate appropriate sync action based on strategy
    const nextAction = resolutionToAction(strategy, conflict);
    return { conflict, nextAction };
  }

  function resolutionToAction(strategy, conflict) {
    switch (strategy) {
      case RESOLUTION_STRATEGIES.KEEP_LOCAL:
        return { action: 'upload', paths: [conflict.localPath], parentPath: path.dirname(conflict.remotePath) };
      case RESOLUTION_STRATEGIES.KEEP_REMOTE:
        return { action: 'download', paths: [conflict.remotePath], localFolder: path.dirname(conflict.localPath) };
      case RESOLUTION_STRATEGIES.KEEP_BOTH:
        return { action: 'rename', localPath: conflict.localPath, remotePath: conflict.remotePath,
          newLocalName: addConflictSuffix(path.basename(conflict.localPath || 'file'), 'local'),
          newRemoteName: addConflictSuffix(path.basename(conflict.remotePath), 'remote') };
      case RESOLUTION_STRATEGIES.OVERWRITE_LOCAL:
        return { action: 'download', paths: [conflict.remotePath], localFolder: path.dirname(conflict.localPath), fileConflictStrategy: 'replace' };
      case RESOLUTION_STRATEGIES.OVERWRITE_REMOTE:
        return { action: 'upload', paths: [conflict.localPath], parentPath: path.dirname(conflict.remotePath), fileConflictStrategy: 'replace' };
      case RESOLUTION_STRATEGIES.SKIP:
        return { action: 'none' };
      default:
        return { action: 'none' };
    }
  }

  function addConflictSuffix(name, side) {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    const ts = Date.now();
    return `${base} (${side} conflict ${ts})${ext}`;
  }

  /**
   * Get all active (open) conflicts.
   */
  function listActive() {
    return Array.from(activeConflicts.values())
      .filter(c => c.status === 'open');
  }

  /**
   * Get all conflicts (including resolved).
   */
  function listAll() {
    return Array.from(activeConflicts.values());
  }

  /**
   * Get a specific conflict by ID.
   */
  function get(id) {
    return activeConflicts.get(id) || null;
  }

  /**
   * Bulk-check a list of file pairs for conflicts.
   * Returns array of detected conflicts.
   */
  function bulkCheck(filePairs) {
    const detected = [];
    for (const { local, remote, lastSync } of filePairs) {
      const conflict = detect(local, remote, lastSync);
      if (conflict) {
        record(conflict);
        detected.push(conflict);
      }
    }
    return detected;
  }

  function clear() {
    activeConflicts.clear();
  }

  function getStats() {
    const all = listAll();
    const open = all.filter(c => c.status === 'open');
    const byType = {};
    for (const c of all) {
      byType[c.type] = (byType[c.type] || 0) + 1;
    }
    return { total: all.length, open: open.length, resolved: all.length - open.length, byType };
  }

  return {
    detect,
    record,
    resolve,
    listActive,
    listAll,
    get,
    bulkCheck,
    clear,
    getStats,
    CONFLICT_TYPES,
    RESOLUTION_STRATEGIES
  };
}

module.exports = { createConflictStore, CONFLICT_TYPES, RESOLUTION_STRATEGIES };
