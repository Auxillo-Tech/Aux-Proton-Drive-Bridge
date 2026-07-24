/**
 * syncDb.js — Persistent Sync Metadata Database
 *
 * SQLite-backed store for tracking local<->remote file state,
 * change history, and sync checkpoints for the Aux Proton Drive Bridge.
 *
 * Schema:
 *   tracked_files  — one row per tracked file with local + remote metadata
 *   sync_events    — immutable log of every detected change and sync action
 *   checkpoints    — known-good sync state snapshots
 *   conflicts      — conflict records for review/resolution
 */

const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');

  CREATE TABLE IF NOT EXISTS tracked_files (
    id                TEXT PRIMARY KEY,              -- remote path hash (sha256 of remotePath)
    remote_path       TEXT NOT NULL,                 -- e.g. /my-files/Documents/report.pdf
    local_path        TEXT,                          -- absolute local path or NULL if not synced locally
    type              TEXT NOT NULL CHECK(type IN ('file','folder')),
    size              INTEGER DEFAULT 0,
    remote_modified   TEXT,                          -- ISO timestamp from remote
    local_modified    TEXT,                          -- ISO timestamp from local fs
    remote_hash       TEXT,                          -- content hash from CLI if available
    local_hash        TEXT,                          -- SHA-256 of local file content
    sync_state        TEXT NOT NULL DEFAULT 'unknown'
                      CHECK(sync_state IN (
                        'synced','pending_download','pending_upload',
                        'downloading','uploading','conflict','unknown',
                        'local_new','remote_new','local_modified','remote_modified',
                        'local_deleted','remote_deleted','ignored'
                      )),
    sync_version      INTEGER DEFAULT 0,             -- incremented on each sync action
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id           TEXT NOT NULL REFERENCES tracked_files(id),
    event_type        TEXT NOT NULL CHECK(event_type IN (
                        'local_create','local_modify','local_delete','local_move',
                        'remote_create','remote_modify','remote_delete','remote_move',
                        'download_start','download_complete','download_error',
                        'upload_start','upload_complete','upload_error',
                        'conflict_detected','conflict_resolved',
                        'sync_skipped','sync_error'
                      )),
    detail            TEXT,                          -- JSON payload with path, size, hash delta
    severity          TEXT DEFAULT 'info' CHECK(severity IN ('info','warn','error')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sync_events_file ON sync_events(file_id);
  CREATE INDEX IF NOT EXISTS idx_sync_events_time ON sync_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_tracked_state ON tracked_files(sync_state);
  CREATE INDEX IF NOT EXISTS idx_tracked_path ON tracked_files(remote_path);
`;

/**
 * Create or open the sync metadata database.
 * @param {string} dbPath - Absolute path to the SQLite file
 * @returns {object} SyncDb API
 */
function createSyncDb(dbPath) {
  const resolved = path.resolve(dbPath);
  const dir = path.dirname(resolved);
  const fs = require('node:fs');
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  // Prepared statements (cache for performance)
  const stmts = {};

  function getStmt(sql) {
    if (!stmts[sql]) stmts[sql] = db.prepare(sql);
    return stmts[sql];
  }

  /** Hash a remote path to a deterministic file ID */
  function pathToId(remotePath) {
    return crypto.createHash('sha256').update(String(remotePath)).digest('hex').slice(0, 16);
  }

  // ── Tracked file CRUD ──────────────────────────────────────

  function getTrackedFile(fileId) {
    return getStmt('SELECT * FROM tracked_files WHERE id = ?').get(fileId) || null;
  }

  function getTrackedFileByPath(remotePath) {
    return getStmt('SELECT * FROM tracked_files WHERE remote_path = ?').get(remotePath) || null;
  }

  function listTrackedFiles(stateFilter) {
    if (stateFilter) {
      return getStmt('SELECT * FROM tracked_files WHERE sync_state = ? ORDER BY remote_path').all(stateFilter);
    }
    return getStmt('SELECT * FROM tracked_files ORDER BY remote_path').all();
  }

  function listFilesNeedingSync(limit = 50) {
    return getStmt(`
      SELECT * FROM tracked_files
      WHERE sync_state IN ('pending_download','pending_upload','local_new','remote_new','local_modified','remote_modified')
      ORDER BY sync_version ASC
      LIMIT ?
    `).all(limit);
  }

  function upsertTrackedFile({ remotePath, localPath, type, size, remoteModified, localModified, remoteHash, localHash, syncState }) {
    const id = pathToId(remotePath);
    const now = new Date().toISOString();
    const existing = getTrackedFile(id);

    if (existing) {
      getStmt(`
        UPDATE tracked_files SET
          remote_path = @remotePath,
          local_path = COALESCE(@localPath, local_path),
          type = COALESCE(@type, type),
          size = COALESCE(@size, size),
          remote_modified = COALESCE(@remoteModified, remote_modified),
          local_modified = COALESCE(@localModified, local_modified),
          remote_hash = COALESCE(@remoteHash, remote_hash),
          local_hash = COALESCE(@localHash, local_hash),
          sync_state = @syncState,
          sync_version = sync_version + 1,
          updated_at = @now
        WHERE id = @id
      `).run({ id, remotePath, localPath: localPath || null, type: type || 'file', size: size || 0, remoteModified: remoteModified || null, localModified: localModified || null, remoteHash: remoteHash || null, localHash: localHash || null, syncState: syncState || 'unknown', now });
    } else {
      getStmt(`
        INSERT INTO tracked_files (id, remote_path, local_path, type, size, remote_modified, local_modified, remote_hash, local_hash, sync_state, created_at, updated_at)
        VALUES (@id, @remotePath, @localPath, @type, @size, @remoteModified, @localModified, @remoteHash, @localHash, @syncState, @now, @now)
      `).run({ id, remotePath, localPath: localPath || null, type: type || 'file', size: size || 0, remoteModified: remoteModified || null, localModified: localModified || null, remoteHash: remoteHash || null, localHash: localHash || null, syncState: syncState || 'unknown', now });
    }
    return id;
  }

  function removeTrackedFile(remotePath) {
    const id = pathToId(remotePath);
    const info = getStmt('DELETE FROM tracked_files WHERE id = ?').run(id);
    return info.changes > 0;
  }

  function setSyncState(remotePath, state) {
    const id = pathToId(remotePath);
    getStmt(`
      UPDATE tracked_files SET
        sync_state = ?,
        sync_version = sync_version + 1,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(state, id);
  }

  function countByState() {
    const rows = getStmt(`
      SELECT sync_state, COUNT(*) as count FROM tracked_files GROUP BY sync_state
    `).all();
    const counts = {};
    for (const r of rows) counts[r.sync_state] = r.count;
    return counts;
  }

  // ── Sync events (immutable log) ────────────────────────────

  function logEvent({ fileId, eventType, detail, severity }) {
    const stmt = getStmt(`
      INSERT INTO sync_events (file_id, event_type, detail, severity)
      VALUES (?, ?, ?, ?)
    `);
    const info = stmt.run(fileId, eventType, detail ? JSON.stringify(detail) : null, severity || 'info');
    return info.lastInsertRowid;
  }

  function getEvents(fileId, limit = 50) {
    if (fileId) {
      return getStmt('SELECT * FROM sync_events WHERE file_id = ? ORDER BY created_at DESC LIMIT ?').all(fileId, limit);
    }
    return getStmt('SELECT * FROM sync_events ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  function getRecentErrors(limit = 20) {
    return getStmt(`
      SELECT * FROM sync_events
      WHERE severity = 'error'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  }

  function clearEvents() {
    getStmt('DELETE FROM sync_events').run();
  }

  // ── Conflicts ──────────────────────────────────────────────

  function recordConflict({ fileId, remotePath, localPath, reason, remoteModified, localModified, remoteHash, localHash }) {
    // Ensure the file exists in tracked_files before recording the conflict event
    const existing = getTrackedFile(fileId);
    if (!existing) {
      getStmt(`
        INSERT OR IGNORE INTO tracked_files (id, remote_path, type, sync_state, created_at, updated_at)
        VALUES (?, ?, 'file', 'unknown', datetime('now'), datetime('now'))
      `).run(fileId, remotePath);
    }

    const stmt = getStmt(`
      INSERT INTO sync_events (file_id, event_type, detail, severity)
      VALUES (?, 'conflict_detected', ?, 'warn')
    `);
    stmt.run(fileId, JSON.stringify({
      remotePath, localPath, reason,
      remoteModified, localModified,
      remoteHash: remoteHash ? remoteHash.slice(0, 16) : null,
      localHash: localHash ? localHash.slice(0, 16) : null
    }));

    setSyncState(remotePath, 'conflict');
    return fileId;
  }

  function resolveConflict(remotePath, resolution) {
    const id = pathToId(remotePath);
    // Ensure the file exists
    const existing = getTrackedFile(id);
    if (!existing) {
      getStmt(`
        INSERT OR IGNORE INTO tracked_files (id, remote_path, type, sync_state, created_at, updated_at)
        VALUES (?, ?, 'file', 'unknown', datetime('now'), datetime('now'))
      `).run(id, remotePath);
    }

    getStmt(`
      INSERT INTO sync_events (file_id, event_type, detail)
      VALUES (?, 'conflict_resolved', ?)
    `).run(id, JSON.stringify({ resolution }));

    const state = resolution === 'keep_local' ? 'pending_upload' :
                  resolution === 'keep_remote' ? 'pending_download' :
                  'synced';
    setSyncState(remotePath, state);
  }

  function listConflicts() {
    return getStmt(`
      SELECT * FROM tracked_files WHERE sync_state = 'conflict' ORDER BY updated_at DESC
    `).all();
  }

  // ── Checkpoints ────────────────────────────────────────────

  function saveCheckpoint(label) {
    const snapshot = {
      label,
      timestamp: new Date().toISOString(),
      totalFiles: getStmt('SELECT COUNT(*) as c FROM tracked_files').get().c,
      syncedCount: getStmt("SELECT COUNT(*) as c FROM tracked_files WHERE sync_state = 'synced'").get().c,
      pendingCount: getStmt("SELECT COUNT(*) as c FROM tracked_files WHERE sync_state IN ('pending_download','pending_upload','local_new','remote_new','local_modified','remote_modified')").get().c,
      conflictCount: getStmt("SELECT COUNT(*) as c FROM tracked_files WHERE sync_state = 'conflict'").get().c
    };

    // Ensure a dummy file entry exists for the checkpoint event FK constraint
    getStmt(`
      INSERT OR IGNORE INTO tracked_files (id, remote_path, type, sync_state, created_at, updated_at)
      VALUES ('__checkpoint__', '__checkpoint__', 'file', 'ignored', datetime('now'), datetime('now'))
    `).run();

    getStmt(`
      INSERT INTO sync_events (file_id, event_type, detail)
      VALUES ('__checkpoint__', 'sync_skipped', ?)
    `).run(JSON.stringify(snapshot));

    return snapshot;
  }

  function getLastCheckpoint() {
    const row = getStmt(`
      SELECT detail FROM sync_events
      WHERE file_id = '__checkpoint__'
      ORDER BY created_at DESC LIMIT 1
    `).get();
    return row ? JSON.parse(row.detail) : null;
  }

  // ── Transaction helper ─────────────────────────────────────

  function transaction(fn) {
    const txn = db.transaction(fn);
    return txn();
  }

  // ── Maintenance ────────────────────────────────────────────

  function vacuum() {
    db.exec('VACUUM');
  }

  function close() {
    db.close();
  }

  function getStats() {
    return {
      fileCount: getStmt('SELECT COUNT(*) as c FROM tracked_files').get().c,
      eventCount: getStmt('SELECT COUNT(*) as c FROM sync_events').get().c,
      byState: countByState(),
      dbSize: fs.existsSync(resolved) ? fs.statSync(resolved).size : 0,
      dbPath: resolved
    };
  }

  return {
    // File tracking
    getTrackedFile,
    getTrackedFileByPath,
    listTrackedFiles,
    listFilesNeedingSync,
    upsertTrackedFile,
    removeTrackedFile,
    setSyncState,
    countByState,
    pathToId,

    // Events
    logEvent,
    getEvents,
    getRecentErrors,
    clearEvents,

    // Conflicts
    recordConflict,
    resolveConflict,
    listConflicts,

    // Checkpoints
    saveCheckpoint,
    getLastCheckpoint,

    // Transactions
    transaction,

    // Maintenance
    vacuum,
    close,
    getStats
  };
}

module.exports = { createSyncDb, pathToId: (p) => crypto.createHash('sha256').update(String(p)).digest('hex').slice(0, 16) };
