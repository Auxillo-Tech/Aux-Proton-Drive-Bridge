const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Database = require('better-sqlite3');
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

  it('migrates a version 4 database with conservative immutable hash baselines', () => {
    const legacyPath = path.join(path.dirname(dbPath), 'legacy-v4.db');
    let legacy = createSyncDb(legacyPath);
    legacy.upsertTrackedFile({
      remotePath: '/my-files/legacy.txt', localPath: '/tmp/legacy.txt', type: 'file',
      size: 6, localSize: 6, remoteSize: 6, localHash: 'local-v1', remoteHash: null,
      localModified: '2026-08-03T10:00:00.000Z', remoteModified: '2026-08-03T10:00:00.000Z',
      syncState: 'synced'
    });
    legacy.close();

    const raw = new Database(legacyPath);
    raw.exec('ALTER TABLE tracked_files DROP COLUMN synced_local_hash');
    raw.exec('ALTER TABLE tracked_files DROP COLUMN synced_remote_hash');
    raw.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run();
    raw.close();

    legacy = createSyncDb(legacyPath);
    const migrated = legacy.getTrackedFileByPath('/my-files/legacy.txt');
    assert.strictEqual(migrated.synced_local_hash, 'local-v1');
    assert.strictEqual(migrated.synced_remote_hash, 'legacy:unknown');
    legacy.close();
    const verify = new Database(legacyPath, { readonly: true });
    assert.strictEqual(verify.prepare("SELECT value FROM meta WHERE key='schema_version'").pluck().get(), '9');
    assert.ok(verify.prepare('PRAGMA table_info(tracked_files)').all().some(column => column.name === 'upload_reupload_pending'));
    assert.ok(verify.prepare('PRAGMA table_info(tracked_files)').all().some(column => column.name === 'upload_expected_remote_hash'));
    assert.ok(verify.prepare('PRAGMA table_info(tracked_files)').all().some(column => column.name === 'upload_verification_local_hash'));
    assert.ok(verify.prepare('PRAGMA table_info(tracked_files)').all().some(column => column.name === 'own_upload_digests'));
    assert.strictEqual(verify.pragma('integrity_check', { simple: true }), 'ok');
    verify.close();
  });

  it('persists own intermediate upload digests across reopen until markSynced', () => {
    const remotePath = '/my-files/own-digests.txt';
    db.upsertTrackedFile({
      remotePath, localPath: '/tmp/own-digests.txt', type: 'file',
      localHash: 'v2:a:1', syncState: 'uploading'
    });
    assert.ok(db.rememberOwnUploadDigest(remotePath, 'sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    assert.ok(db.rememberOwnUploadDigest(remotePath, 'sha1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
    assert.ok(db.hasOwnUploadDigest(remotePath, 'sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    db.close();
    db = createSyncDb(dbPath);
    assert.ok(db.hasOwnUploadDigest(remotePath, 'sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
    assert.ok(db.hasOwnUploadDigest(remotePath, 'sha1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
    db.markSynced(remotePath);
    assert.equal(db.hasOwnUploadDigest(remotePath, 'sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false);
    db.removeTrackedFile(remotePath);
  });

  it('persists upload-verification ownership until synchronization is committed', () => {
    db.upsertTrackedFile({
      remotePath: '/my-files/verify-persist.txt', localPath: '/tmp/verify-persist.txt', type: 'file',
      localHash: 'v2:verification-snapshot:1.000', syncState: 'uploading'
    });
    assert.ok(db.beginUploadVerification('/my-files/verify-persist.txt'));
    let row = db.getTrackedFileByPath('/my-files/verify-persist.txt');
    assert.strictEqual(row.upload_verification_local_hash, 'v2:verification-snapshot:1.000');
    assert.strictEqual(row.sync_state, 'uploading');
    db.markSynced('/my-files/verify-persist.txt');
    row = db.getTrackedFileByPath('/my-files/verify-persist.txt');
    assert.strictEqual(row.upload_verification_local_hash, null);
    assert.strictEqual(row.sync_state, 'synced');
    db.removeTrackedFile('/my-files/verify-persist.txt');
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

  it('preserves omitted metadata and sync state during partial upserts', () => {
    db.upsertTrackedFile({
      remotePath: '/my-files/preserve-folder',
      localPath: '/home/user/ProtonDrive/preserve-folder',
      type: 'folder',
      size: 4096,
      syncState: 'synced'
    });
    db.upsertTrackedFile({
      remotePath: '/my-files/preserve-folder',
      localModified: '2026-07-27T11:00:00.000Z'
    });
    const file = db.getTrackedFileByPath('/my-files/preserve-folder');
    assert.strictEqual(file.type, 'folder');
    assert.strictEqual(file.size, 4096);
    assert.strictEqual(file.sync_state, 'synced');
    db.removeTrackedFile('/my-files/preserve-folder');
  });

  it('does not classify a freshly updated transfer as stale', () => {
    db.upsertTrackedFile({
      remotePath: '/my-files/fresh-upload.txt',
      localPath: '/home/user/ProtonDrive/fresh-upload.txt',
      type: 'file',
      syncState: 'local_new'
    });
    db.setSyncState('/my-files/fresh-upload.txt', 'uploading');
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    assert.strictEqual(db.getStaleItemsByState('uploading', cutoff).length, 0);
    db.removeTrackedFile('/my-files/fresh-upload.txt');
  });

  it('keeps immutable last-synced baselines while current metadata changes', () => {
    const remotePath = '/my-files/baseline.txt';
    db.upsertTrackedFile({
      remotePath,
      localPath: '/tmp/baseline.txt',
      localSize: 100,
      remoteSize: 100,
      localModified: '2026-07-24T10:00:00Z',
      remoteModified: '2026-07-24T10:00:00Z',
      localHash: 'local-hash-v1',
      remoteHash: 'remote-hash-v1',
      syncState: 'pending_upload'
    });
    db.markSynced(remotePath);
    db.upsertTrackedFile({
      remotePath,
      localSize: 200,
      localModified: '2026-07-24T11:00:00Z',
      localHash: 'local-hash-v2',
      syncState: 'local_modified'
    });
    const row = db.getTrackedFileByPath(remotePath);
    assert.strictEqual(row.local_size, 200);
    assert.strictEqual(row.synced_local_size, 100);
    assert.strictEqual(row.synced_local_modified, '2026-07-24T10:00:00Z');
    assert.strictEqual(row.local_hash, 'local-hash-v2');
    assert.strictEqual(row.synced_local_hash, 'local-hash-v1');
    assert.strictEqual(row.synced_remote_hash, 'remote-hash-v1');
    db.removeTrackedFile(remotePath);
  });

  it('stores independent local and remote size baselines', () => {
    db.upsertTrackedFile({ remotePath: '/my-files/split-size.bin', type: 'file', size: 5000, remoteSize: 5000, syncState: 'synced' });
    db.upsertTrackedFile({ remotePath: '/my-files/split-size.bin', size: 1000, localSize: 1000 });
    const file = db.getTrackedFileByPath('/my-files/split-size.bin');
    assert.strictEqual(file.local_size, 1000);
    assert.strictEqual(file.remote_size, 5000);
    db.removeTrackedFile('/my-files/split-size.bin');
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

  it('caps retained sync events at ten thousand while preserving the newest entries', () => {
    db.clearEvents();
    const fileId = db.upsertTrackedFile({
      remotePath: '/my-files/event-cap.txt',
      type: 'file',
      syncState: 'synced'
    });
    let newestId = 0;
    for (let index = 0; index < 10_005; index++) {
      newestId = db.logEvent({ fileId, eventType: 'local_modify', detail: { index } });
    }

    assert.strictEqual(db.getStats().eventCount, 10_000);
    const newest = db.getEvents(null, 1);
    assert.strictEqual(newest[0].id, Number(newestId));
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
