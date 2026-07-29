const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { sanitizeForStorage } = require('./operationStore');

const SCHEMA_VERSION = 4;
const SYNC_STATES = [
  'synced', 'pending_download', 'pending_upload', 'downloading', 'uploading',
  'conflict', 'unknown', 'local_new', 'remote_new', 'local_modified',
  'remote_modified', 'local_deleted', 'remote_deleted', 'ignored'
];
const EVENT_TYPES = [
  'local_create', 'local_modify', 'local_delete', 'local_move',
  'remote_create', 'remote_modify', 'remote_delete', 'remote_move',
  'download_start', 'download_complete', 'download_error',
  'upload_start', 'upload_complete', 'upload_error',
  'conflict_detected', 'conflict_resolved', 'sync_skipped', 'sync_error'
];
const MAX_EVENT_LIMIT = 500;
const MAX_EVENT_DETAIL_BYTES = 16 * 1024;
const MAX_SYNC_EVENTS = 10_000;

function safeLimit(value, fallback = 50) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(MAX_EVENT_LIMIT, Math.max(1, Math.trunc(number))) : fallback;
}

function pathToId(remotePath) {
  return crypto.createHash('sha256').update(String(remotePath)).digest('hex').slice(0, 16);
}

function createSyncDb(dbPath) {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tracked_files (
      id TEXT PRIMARY KEY,
      remote_path TEXT NOT NULL UNIQUE,
      local_path TEXT,
      type TEXT NOT NULL CHECK(type IN ('file','folder')),
      size INTEGER DEFAULT 0,
      local_size INTEGER,
      remote_size INTEGER,
      remote_modified TEXT,
      local_modified TEXT,
      remote_hash TEXT,
      local_hash TEXT,
      synced_local_size INTEGER,
      synced_remote_size INTEGER,
      synced_local_modified TEXT,
      synced_remote_modified TEXT,
      sync_state TEXT NOT NULL DEFAULT 'unknown' CHECK(sync_state IN (${SYNC_STATES.map(s => `'${s}'`).join(',')})),
      sync_version INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL REFERENCES tracked_files(id),
      event_type TEXT NOT NULL CHECK(event_type IN (${EVENT_TYPES.map(s => `'${s}'`).join(',')})),
      detail TEXT,
      severity TEXT DEFAULT 'info' CHECK(severity IN ('info','warn','error')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES tracked_files(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
      resolution TEXT,
      detected_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_events_file ON sync_events(file_id);
    CREATE INDEX IF NOT EXISTS idx_sync_events_time ON sync_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_tracked_state ON tracked_files(sync_state);
    CREATE INDEX IF NOT EXISTS idx_tracked_path ON tracked_files(remote_path);
    CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);
    CREATE INDEX IF NOT EXISTS idx_conflicts_file ON conflicts(file_id);
  `);
  const trackedColumns = new Set(db.prepare('PRAGMA table_info(tracked_files)').all().map(column => column.name));
  if (!trackedColumns.has('local_size')) db.exec('ALTER TABLE tracked_files ADD COLUMN local_size INTEGER');
  if (!trackedColumns.has('remote_size')) db.exec('ALTER TABLE tracked_files ADD COLUMN remote_size INTEGER');
  if (!trackedColumns.has('synced_local_size')) db.exec('ALTER TABLE tracked_files ADD COLUMN synced_local_size INTEGER');
  if (!trackedColumns.has('synced_remote_size')) db.exec('ALTER TABLE tracked_files ADD COLUMN synced_remote_size INTEGER');
  if (!trackedColumns.has('synced_local_modified')) db.exec('ALTER TABLE tracked_files ADD COLUMN synced_local_modified TEXT');
  if (!trackedColumns.has('synced_remote_modified')) db.exec('ALTER TABLE tracked_files ADD COLUMN synced_remote_modified TEXT');
  db.exec('UPDATE tracked_files SET local_size=COALESCE(local_size,size),remote_size=COALESCE(remote_size,size)');
  db.exec(`UPDATE tracked_files SET
    synced_local_size=COALESCE(synced_local_size,CASE WHEN sync_state='synced' THEN local_size END),
    synced_remote_size=COALESCE(synced_remote_size,CASE WHEN sync_state='synced' THEN remote_size END),
    synced_local_modified=COALESCE(synced_local_modified,CASE WHEN sync_state='synced' THEN local_modified END),
    synced_remote_modified=COALESCE(synced_remote_modified,CASE WHEN sync_state='synced' THEN remote_modified END)`);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));

  const statements = new Map();
  const stmt = sql => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  const now = () => new Date().toISOString();

  function getTrackedFile(fileId) {
    return stmt('SELECT * FROM tracked_files WHERE id = ?').get(fileId) || null;
  }

  function getTrackedFileByPath(remotePath) {
    return stmt('SELECT * FROM tracked_files WHERE remote_path = ?').get(remotePath) || null;
  }

  function listTrackedFiles(stateFilter, limit = null) {
    if (limit !== null) {
      const bounded = Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 500)));
      return stateFilter
        ? stmt('SELECT * FROM tracked_files WHERE sync_state = ? ORDER BY remote_path LIMIT ?').all(stateFilter, bounded)
        : stmt('SELECT * FROM tracked_files ORDER BY remote_path LIMIT ?').all(bounded);
    }
    return stateFilter
      ? stmt('SELECT * FROM tracked_files WHERE sync_state = ? ORDER BY remote_path').all(stateFilter)
      : stmt('SELECT * FROM tracked_files ORDER BY remote_path').all();
  }

  function listFilesNeedingSync(limit = 50) {
    return stmt(`SELECT * FROM tracked_files
      WHERE sync_state IN ('pending_download','pending_upload','local_new','remote_new','local_modified','remote_modified')
      ORDER BY sync_version ASC LIMIT ?`).all(safeLimit(limit));
  }

  function getStaleItemsByState(state, cutoff) {
    return stmt(`SELECT * FROM tracked_files
      WHERE sync_state = @state AND updated_at < @cutoff AND remote_path != '__checkpoint__'
      ORDER BY updated_at ASC`).all({ state, cutoff });
  }

  function upsertTrackedFile(fields) {
    if (!fields || typeof fields.remotePath !== 'string' || !fields.remotePath) throw new Error('remotePath is required');
    const id = pathToId(fields.remotePath);
    const timestamp = now();
    const existing = getTrackedFile(id);
    if (existing) {
      stmt(`UPDATE tracked_files SET
        remote_path=@remotePath,
        local_path=COALESCE(@localPath,local_path),
        type=COALESCE(@type,type),
        size=COALESCE(@size,size),
        local_size=COALESCE(@localSize,local_size),
        remote_size=COALESCE(@remoteSize,remote_size),
        remote_modified=COALESCE(@remoteModified,remote_modified),
        local_modified=COALESCE(@localModified,local_modified),
        remote_hash=COALESCE(@remoteHash,remote_hash),
        local_hash=COALESCE(@localHash,local_hash),
        sync_state=COALESCE(@syncState,sync_state),
        sync_version=sync_version+1,
        updated_at=@timestamp WHERE id=@id`).run({
        id,
        remotePath: fields.remotePath,
        localPath: fields.localPath ?? null,
        type: fields.type ?? null,
        size: fields.size ?? null,
        localSize: fields.localSize ?? null,
        remoteSize: fields.remoteSize ?? null,
        remoteModified: fields.remoteModified ?? null,
        localModified: fields.localModified ?? null,
        remoteHash: fields.remoteHash ?? null,
        localHash: fields.localHash ?? null,
        syncState: fields.syncState ?? null,
        timestamp
      });
    } else {
      stmt(`INSERT INTO tracked_files
        (id,remote_path,local_path,type,size,local_size,remote_size,remote_modified,local_modified,remote_hash,local_hash,sync_state,created_at,updated_at)
        VALUES (@id,@remotePath,@localPath,@type,@size,@localSize,@remoteSize,@remoteModified,@localModified,@remoteHash,@localHash,@syncState,@timestamp,@timestamp)`).run({
        id,
        remotePath: fields.remotePath,
        localPath: fields.localPath ?? null,
        type: fields.type ?? 'file',
        size: fields.size ?? 0,
        localSize: fields.localSize ?? fields.size ?? null,
        remoteSize: fields.remoteSize ?? fields.size ?? null,
        remoteModified: fields.remoteModified ?? null,
        localModified: fields.localModified ?? null,
        remoteHash: fields.remoteHash ?? null,
        localHash: fields.localHash ?? null,
        syncState: fields.syncState ?? 'unknown',
        timestamp
      });
    }
    return id;
  }

  function removeTrackedFile(remotePath) {
    return stmt('DELETE FROM tracked_files WHERE id = ?').run(pathToId(remotePath)).changes > 0;
  }

  function setSyncState(remotePath, state) {
    if (!SYNC_STATES.includes(state)) throw new Error(`Invalid sync state: ${state}`);
    stmt('UPDATE tracked_files SET sync_state=?,sync_version=sync_version+1,updated_at=? WHERE id=?')
      .run(state, now(), pathToId(remotePath));
  }

  function markSynced(remotePath) {
    stmt(`UPDATE tracked_files SET
      sync_state='synced',
      synced_local_size=local_size,
      synced_remote_size=remote_size,
      synced_local_modified=local_modified,
      synced_remote_modified=remote_modified,
      sync_version=sync_version+1,
      updated_at=? WHERE id=?`).run(now(), pathToId(remotePath));
  }

  function countByState() {
    const result = {};
    for (const row of stmt('SELECT sync_state,COUNT(*) AS count FROM tracked_files GROUP BY sync_state').all()) result[row.sync_state] = row.count;
    return result;
  }

  function logEvent({ fileId, eventType, detail, severity }) {
    if (!EVENT_TYPES.includes(eventType)) throw new Error(`Invalid sync event type: ${eventType}`);
    const serialized = detail ? JSON.stringify(sanitizeForStorage(detail)).slice(0, MAX_EVENT_DETAIL_BYTES) : null;
    const result = stmt('INSERT INTO sync_events (file_id,event_type,detail,severity,created_at) VALUES (?,?,?,?,?)')
      .run(fileId, eventType, serialized, severity || 'info', now()).lastInsertRowid;
    stmt('DELETE FROM sync_events WHERE id NOT IN (SELECT id FROM sync_events ORDER BY id DESC LIMIT ?)').run(MAX_SYNC_EVENTS);
    return result;
  }

  function getEvents(fileId, limit = 50) {
    const bounded = safeLimit(limit);
    return fileId
      ? stmt('SELECT * FROM sync_events WHERE file_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(fileId, bounded)
      : stmt('SELECT * FROM sync_events ORDER BY created_at DESC,id DESC LIMIT ?').all(bounded);
  }

  function getRecentErrors(limit = 20) {
    return stmt("SELECT * FROM sync_events WHERE severity='error' ORDER BY created_at DESC,id DESC LIMIT ?").all(safeLimit(limit, 20));
  }

  function clearEvents() {
    stmt('DELETE FROM sync_events').run();
  }

  function ensureTracked(fileId, remotePath, localPath) {
    if (!getTrackedFile(fileId)) {
      upsertTrackedFile({ remotePath, localPath, type: 'file', syncState: 'unknown' });
    }
  }

  function recordConflict(conflict) {
    const fileId = conflict.fileId || pathToId(conflict.remotePath);
    ensureTracked(fileId, conflict.remotePath, conflict.localPath);
    const id = conflict.conflictId || conflict.id || crypto.randomBytes(8).toString('hex');
    const detail = {
      id,
      type: conflict.type || 'unknown',
      reason: conflict.reason || 'Conflict detected',
      remotePath: conflict.remotePath,
      localPath: conflict.localPath || null,
      remoteModified: conflict.remoteModified || null,
      localModified: conflict.localModified || null,
      remoteSize: conflict.remoteSize || 0,
      localSize: conflict.localSize || 0,
      remoteHash: conflict.remoteHash || null,
      localHash: conflict.localHash || null,
      detectedAt: conflict.detectedAt || now(),
      status: 'open'
    };
    stmt(`INSERT INTO conflicts (id,file_id,type,reason,detail,status,detected_at)
      VALUES (@id,@fileId,@type,@reason,@detail,'open',@detectedAt)
      ON CONFLICT(id) DO UPDATE SET type=excluded.type,reason=excluded.reason,detail=excluded.detail,status='open',resolution=NULL,resolved_at=NULL`).run({
      id, fileId, type: detail.type, reason: detail.reason, detail: JSON.stringify(detail), detectedAt: detail.detectedAt
    });
    logEvent({ fileId, eventType: 'conflict_detected', detail: { conflictId: id, ...detail }, severity: 'warn' });
    setSyncState(conflict.remotePath, 'conflict');
    return id;
  }

  function resolveConflict(remotePath, resolution, conflictId = null, stateOverride = null) {
    const fileId = pathToId(remotePath);
    ensureTracked(fileId, remotePath, null);
    const resolvedAt = now();
    if (conflictId) {
      stmt("UPDATE conflicts SET status='resolved',resolution=?,resolved_at=? WHERE id=?").run(resolution, resolvedAt, conflictId);
    } else {
      stmt("UPDATE conflicts SET status='resolved',resolution=?,resolved_at=? WHERE file_id=? AND status='open'").run(resolution, resolvedAt, fileId);
    }
    logEvent({ fileId, eventType: 'conflict_resolved', detail: { conflictId, resolution } });
    const state = stateOverride || (
      ['keep_local', 'overwrite_remote'].includes(resolution) ? 'pending_upload'
        : ['keep_remote', 'overwrite_local'].includes(resolution) ? 'pending_download' : 'synced'
    );
    if (state === 'synced') markSynced(remotePath);
    else setSyncState(remotePath, state);
  }

  function listConflicts() {
    return stmt("SELECT * FROM tracked_files WHERE sync_state='conflict' ORDER BY updated_at DESC").all();
  }

  function listConflictRecords(status = null) {
    const rows = status
      ? stmt('SELECT * FROM conflicts WHERE status=? ORDER BY detected_at DESC').all(status)
      : stmt('SELECT * FROM conflicts ORDER BY detected_at DESC').all();
    return rows.map(row => {
      let detail = {};
      try { detail = JSON.parse(row.detail); } catch {}
      return { ...row, conflict: { ...detail, status: row.status, resolution: row.resolution, resolvedAt: row.resolved_at } };
    });
  }

  function saveCheckpoint(label) {
    const snapshot = {
      label,
      timestamp: now(),
      totalFiles: stmt("SELECT COUNT(*) AS c FROM tracked_files WHERE id!='__checkpoint__'").get().c,
      syncedCount: stmt("SELECT COUNT(*) AS c FROM tracked_files WHERE sync_state='synced'").get().c,
      pendingCount: stmt("SELECT COUNT(*) AS c FROM tracked_files WHERE sync_state IN ('pending_download','pending_upload','local_new','remote_new','local_modified','remote_modified')").get().c,
      conflictCount: stmt("SELECT COUNT(*) AS c FROM tracked_files WHERE sync_state='conflict'").get().c
    };
    const checkpointId = upsertTrackedFile({ remotePath: '__checkpoint__', type: 'file', syncState: 'ignored' });
    logEvent({ fileId: checkpointId, eventType: 'sync_skipped', detail: snapshot });
    return snapshot;
  }

  function getLastCheckpoint() {
    const row = stmt("SELECT detail FROM sync_events WHERE file_id=? AND event_type='sync_skipped' ORDER BY id DESC LIMIT 1").get(pathToId('__checkpoint__'));
    return row ? JSON.parse(row.detail) : null;
  }

  function transaction(fn) {
    return db.transaction(fn)();
  }

  function getStats() {
    return {
      fileCount: stmt("SELECT COUNT(*) AS c FROM tracked_files WHERE id!='__checkpoint__'").get().c,
      eventCount: stmt('SELECT COUNT(*) AS c FROM sync_events').get().c,
      byState: countByState(),
      dbSize: fs.existsSync(resolved) ? fs.statSync(resolved).size : 0,
      dbPath: resolved
    };
  }

  return {
    dbPath: resolved,
    getTrackedFile, getTrackedFileByPath, listTrackedFiles, listFilesNeedingSync,
    getStaleItemsByState, upsertTrackedFile, removeTrackedFile, setSyncState, markSynced,
    countByState, pathToId, logEvent, getEvents, getRecentErrors, clearEvents,
    recordConflict, resolveConflict, listConflicts, listConflictRecords,
    saveCheckpoint, getLastCheckpoint, transaction,
    vacuum: () => db.exec('VACUUM'), close: () => db.close(), getStats
  };
}

module.exports = { createSyncDb, pathToId };
