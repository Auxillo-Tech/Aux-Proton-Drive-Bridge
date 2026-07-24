const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createSyncDb } = require('../src/main/syncDb');

describe('syncDb — SQLite sync metadata database', () => {
  let db;
  let dbPath;

  before(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'syncdb-test-')), 'test-sync.db');
    db = createSyncDb(dbPath);
  });

  after(() => {
    db.close();
    try { fs.rmSync(path.dirname(dbPath), { recursive: true }); } catch {}
  });

  it('creates the database file on disk', () => {
    assert.ok(fs.existsSync(dbPath));
  });

  it('tracks a new file entry via upsertTrackedFile', () => {
    const id = db.upsertTrackedFile({
      remotePath: '/my-files/test.txt',
      localPath: '/home/user/ProtonDrive/test.txt',
      type: 'file',
      size: 1024,
      remoteModified: '2026-07-24T10:00:00Z',
      localModified: '2026-07-24T09:00:00Z',
      syncState: 'synced'
    });
    assert.ok(id);
    assert.strictEqual(id.length, 16); // sha256 hex prefix

    const stored = db.getTrackedFile(id);
    assert.notStrictEqual(stored, null);
    assert.strictEqual(stored.remote_path, '/my-files/test.txt');
    assert.strictEqual(stored.size, 1024);
    assert.strictEqual(stored.sync_state, 'synced');
  });

  it('finds files by remote path', () => {
    const file = db.getTrackedFileByPath('/my-files/test.txt');
    assert.notStrictEqual(file, null);
    assert.strictEqual(file.local_path, '/home/user/ProtonDrive/test.txt');
  });

  it('upserts existing file (updates, not duplicates)', () => {
    db.upsertTrackedFile({
      remotePath: '/my-files/test.txt',
      size: 2048,
      syncState: 'pending_download'
    });
    const file = db.getTrackedFileByPath('/my-files/test.txt');
    assert.strictEqual(file.size, 2048);
    assert.strictEqual(file.sync_state, 'pending_download');
    assert.strictEqual(file.local_path, '/home/user/ProtonDrive/test.txt'); // preserved from original
  });

  it('lists all tracked files', () => {
    // Add a second file
    db.upsertTrackedFile({
      remotePath: '/my-files/docs/report.pdf',
      type: 'file',
      syncState: 'remote_new'
    });
    const all = db.listTrackedFiles();
    assert.strictEqual(all.length, 2);
  });

  it('filters tracked files by sync state', () => {
    const pending = db.listTrackedFiles('pending_download');
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].remote_path, '/my-files/test.txt');

    const remoteNew = db.listTrackedFiles('remote_new');
    assert.strictEqual(remoteNew.length, 1);
  });

  it('lists files needing sync', () => {
    const needsSync = db.listFilesNeedingSync(10);
    assert.strictEqual(needsSync.length, 2);
  });

  it('updates sync state', () => {
    db.setSyncState('/my-files/test.txt', 'synced');
    const file = db.getTrackedFileByPath('/my-files/test.txt');
    assert.strictEqual(file.sync_state, 'synced');
    // sync_version increments
    assert.ok(file.sync_version > 0);
  });

  it('removes a tracked file', () => {
    db.upsertTrackedFile({
      remotePath: '/my-files/temp_delete_me.txt',
      type: 'file',
      syncState: 'local_new'
    });
    assert.ok(db.getTrackedFileByPath('/my-files/temp_delete_me.txt'));
    const removed = db.removeTrackedFile('/my-files/temp_delete_me.txt');
    assert.strictEqual(removed, true);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/temp_delete_me.txt'), null);
  });

  it('counts files grouped by sync state', () => {
    const counts = db.countByState();
    assert.ok(counts.synced >= 1);
    assert.ok(counts.remote_new >= 1);
  });

  it('logs sync events', () => {
    const fileId = db.pathToId('/my-files/test.txt');
    const eventId = db.logEvent({
      fileId,
      eventType: 'local_modify',
      detail: { size: 2048 },
      severity: 'info'
    });
    assert.ok(eventId > 0);
  });

  it('retrieves events for a specific file', () => {
    const fileId = db.pathToId('/my-files/test.txt');
    const events = db.getEvents(fileId, 10);
    assert.ok(events.length >= 1);
    assert.strictEqual(events[0].event_type, 'local_modify');
  });

  it('retrieves recent errors', () => {
    const fileId = db.pathToId('/my-files/test.txt');
    db.logEvent({ fileId, eventType: 'sync_error', detail: { error: 'timeout' }, severity: 'error' });
    const errors = db.getRecentErrors(5);
    assert.ok(errors.length >= 1);
    assert.strictEqual(errors[0].severity, 'error');
  });

  it('records and lists conflicts', () => {
    db.upsertTrackedFile({
      remotePath: '/my-files/conflict_file.txt',
      type: 'file',
      size: 500,
      syncState: 'unknown'
    });
    const fileId = db.pathToId('/my-files/conflict_file.txt');
    db.recordConflict({
      fileId,
      remotePath: '/my-files/conflict_file.txt',
      localPath: '/home/user/conflict_file.txt',
      reason: 'Both sides modified',
      remoteModified: '2026-07-24T10:00:00Z',
      localModified: '2026-07-24T11:00:00Z',
      remoteHash: 'abc123',
      localHash: 'def456'
    });
    const file = db.getTrackedFileByPath('/my-files/conflict_file.txt');
    assert.strictEqual(file.sync_state, 'conflict');
  });

  it('resolves conflicts', () => {
    db.resolveConflict('/my-files/conflict_file.txt', 'keep_local');
    const file = db.getTrackedFileByPath('/my-files/conflict_file.txt');
    assert.strictEqual(file.sync_state, 'pending_upload');
  });

  it('lists conflicted files', () => {
    // The resolved one should no longer be in conflicts
    const conflicts = db.listConflicts();
    // Filter out resolved ones by checking state
    for (const c of conflicts) {
      assert.strictEqual(c.sync_state, 'conflict');
    }
  });

  it('saves and retrieves checkpoints', () => {
    const checkpoint = db.saveCheckpoint('test_sync');
    assert.ok(checkpoint.label, 'test_sync');
    assert.ok(checkpoint.timestamp);
    assert.ok(checkpoint.totalFiles >= 0);

    const loaded = db.getLastCheckpoint();
    assert.notStrictEqual(loaded, null);
    assert.strictEqual(loaded.label, 'test_sync');
  });

  it('generates deterministic path hashes', () => {
    const hash1 = db.pathToId('/my-files/docs/file.pdf');
    const hash2 = db.pathToId('/my-files/docs/file.pdf');
    assert.strictEqual(hash1, hash2); // deterministic
    assert.strictEqual(hash1.length, 16);
  });

  it('provides database stats', () => {
    const stats = db.getStats();
    assert.ok(stats.fileCount > 0);
    assert.ok(stats.eventCount > 0);
    assert.ok(stats.byState && typeof stats.byState === 'object');
    assert.ok(stats.dbSize > 0);
    assert.ok(stats.dbPath.endsWith('.db'));
  });

  it('clears sync events', () => {
    db.clearEvents();
    const events = db.getEvents(null, 100);
    assert.strictEqual(events.length, 0);
  });

  it('transactions work with the transaction helper', () => {
    const result = db.transaction(() => {
      db.upsertTrackedFile({ remotePath: '/my-files/txn_test.txt', type: 'file', syncState: 'local_new' });
      db.setSyncState('/my-files/txn_test.txt', 'synced');
      return db.getTrackedFileByPath('/my-files/txn_test.txt');
    });
    assert.ok(result);
    assert.strictEqual(result.sync_state, 'synced');
  });

});
