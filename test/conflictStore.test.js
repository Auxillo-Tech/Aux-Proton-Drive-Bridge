const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createSyncDb } = require('../src/main/syncDb');
const { createConflictStore, CONFLICT_TYPES, RESOLUTION_STRATEGIES } = require('../src/main/conflictStore');

describe('conflictStore — Conflict Detection and Resolution', () => {
  let db;
  let store;

  before(() => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-test-')), 'test.db');
    db = createSyncDb(dbPath);
    store = createConflictStore(db);
  });

  after(() => {
    try { fs.rmSync(path.dirname(db.dbPath), { recursive: true }); } catch {}
  });

  it('detects LOCAL_REMOTE_MODIFY when both sides changed', () => {
    const local = { path: '/local/file.txt', modified: '2026-07-24T12:00:00Z', size: 200 };
    const remote = { path: '/remote/file.txt', modified: '2026-07-24T13:00:00Z', size: 300 };
    const lastSync = { local_modified: '2026-07-24T12:00:00Z', remote_modified: '2026-07-24T13:00:00Z', local_size: 200, remote_size: 300, synced_local_modified: '2026-07-24T10:00:00Z', synced_remote_modified: '2026-07-24T10:00:00Z', synced_local_size: 100, synced_remote_size: 100, sync_state: 'local_modified' };

    const conflict = store.detect(local, remote, lastSync);
    assert.notStrictEqual(conflict, null);
    assert.strictEqual(conflict.type, CONFLICT_TYPES.LOCAL_REMOTE_MODIFY);
    assert.ok(conflict.reason.includes('Both'));
  });

  it('detects LOCAL_DELETE_REMOTE_MODIFY', () => {
    const local = null;
    const remote = { path: '/remote/file.txt', modified: '2026-07-24T13:00:00Z', size: 300 };
    const lastSync = { local_path: '/local/file.txt', remote_path: '/remote/file.txt', remote_modified: '2026-07-24T10:00:00Z', size: 100, type: 'file', sync_state: 'synced' };

    const conflict = store.detect(local, remote, lastSync);
    assert.notStrictEqual(conflict, null);
    assert.strictEqual(conflict.type, CONFLICT_TYPES.LOCAL_DELETE_REMOTE_MODIFY);
  });

  it('detects REMOTE_DELETE_LOCAL_MODIFY', () => {
    const local = { path: '/local/file.txt', modified: '2026-07-24T12:00:00Z', size: 200 };
    const remote = null;
    const lastSync = { local_path: '/local/file.txt', remote_path: '/remote/file.txt', local_modified: '2026-07-24T10:00:00Z', size: 100, type: 'file', sync_state: 'synced' };

    const conflict = store.detect(local, remote, lastSync);
    assert.notStrictEqual(conflict, null);
    assert.strictEqual(conflict.type, CONFLICT_TYPES.REMOTE_DELETE_LOCAL_MODIFY);
  });

  it('detects BOTH_CREATE when no lastSync exists', () => {
    const local = { path: '/local/new.txt', modified: '2026-07-24T12:00:00Z', size: 200, type: 'file' };
    const remote = { path: '/remote/new.txt', modified: '2026-07-24T12:00:00Z', size: 200, type: 'file' };

    const conflict = store.detect(local, remote, null);
    assert.notStrictEqual(conflict, null);
    assert.strictEqual(conflict.type, CONFLICT_TYPES.BOTH_CREATE);
  });

  it('detects TYPE_MISMATCH when local/remote types differ', () => {
    const local = { path: '/local/item', modified: '2026-07-24T12:00:00Z', type: 'file' };
    const remote = { path: '/remote/item', modified: '2026-07-24T12:00:00Z', type: 'folder' };
    const lastSync = { type: 'file', sync_state: 'synced', local_modified: '2026-07-24T10:00:00Z', remote_modified: '2026-07-24T10:00:00Z' };

    const conflict = store.detect(local, remote, lastSync);
    assert.notStrictEqual(conflict, null);
    assert.strictEqual(conflict.type, CONFLICT_TYPES.TYPE_MISMATCH);
  });

  it('detects SIZE_MISMATCH on "synced" files with size delta', () => {
    const local = { path: '/local/file.txt', modified: '2026-07-24T10:00:00Z', size: 5000 };
    const remote = { path: '/remote/file.txt', modified: '2026-07-24T10:00:00Z', size: 200 };
    const lastSync = { local_modified: '2026-07-24T10:00:00Z', remote_modified: '2026-07-24T10:00:00Z', size: 100, sync_state: 'synced', type: 'file' };

    const conflict = store.detect(local, remote, lastSync);
    assert.notStrictEqual(conflict, null);
    assert.strictEqual(conflict.type, CONFLICT_TYPES.SIZE_MISMATCH);
  });

  it('returns null when no conflict exists', () => {
    const local = { path: '/local/file.txt', modified: '2026-07-24T10:00:00Z', size: 100 };
    const remote = { path: '/remote/file.txt', modified: '2026-07-24T10:00:00Z', size: 100 };
    const lastSync = { local_modified: '2026-07-24T10:00:00Z', remote_modified: '2026-07-24T10:00:00Z', size: 100, sync_state: 'synced', type: 'file' };

    const conflict = store.detect(local, remote, lastSync);
    assert.strictEqual(conflict, null);
  });

  it('records a conflict and persists to syncDb', () => {
    const conflict = store.detect(
      { path: '/local/conflict.txt', modified: '2026-07-24T12:00:00Z', size: 200, type: 'file' },
      { path: '/remote/conflict.txt', modified: '2026-07-24T13:00:00Z', size: 300, type: 'file' },
      null
    );
    assert.ok(conflict);

    const id = store.record(conflict);
    assert.ok(id);

    // Check it's in persistent storage
    const active = store.listActive();
    assert.ok(active.some(c => c.remotePath.includes('conflict.txt')));
  });

  it('rehydrates open conflicts after the store is recreated', () => {
    const recreated = createConflictStore(db);
    const active = recreated.listActive();
    assert.ok(active.some(c => c.remotePath.includes('conflict.txt')));
  });

  it('resolves a conflict with keep_local strategy', () => {
    const active = store.listActive();
    const conflict = active.find(c => c.remotePath.includes('conflict.txt'));
    assert.ok(conflict);

    const result = store.resolve(conflict.id, 'keep_local');
    assert.notStrictEqual(result, false);
    assert.strictEqual(result.nextAction.action, 'upload');
  });

  it('resolves a conflict with keep_remote strategy', () => {
    // Create a fresh conflict
    const c = store.detect(
      { path: '/local/other.txt', modified: '2026-07-24T12:00:00Z', size: 200, type: 'file' },
      { path: '/remote/other.txt', modified: '2026-07-24T13:00:00Z', size: 300, type: 'file' },
      null
    );
    store.record(c);

    const result = store.resolve(c.id, 'keep_remote');
    assert.strictEqual(result.nextAction.action, 'download');
  });

  it('resolves a conflict with keep_both strategy (renames)', () => {
    const c = store.detect(
      { path: '/local/both.txt', modified: '2026-07-24T12:00:00Z', size: 200, type: 'file' },
      { path: '/remote/both.txt', modified: '2026-07-24T13:00:00Z', size: 300, type: 'file' },
      null
    );
    store.record(c);

    const result = store.resolve(c.id, 'keep_both');
    assert.strictEqual(result.nextAction.action, 'rename');
    assert.ok(result.nextAction.newLocalName.includes('conflict'));
    assert.ok(result.nextAction.newRemoteName.includes('conflict'));
  });

  it('resolves a conflict with skip strategy', () => {
    const c = store.detect(
      { path: '/local/skip.txt', modified: '2026-07-24T12:00:00Z', size: 200, type: 'file' },
      { path: '/remote/skip.txt', modified: '2026-07-24T13:00:00Z', size: 300, type: 'file' },
      null
    );
    store.record(c);
    const result = store.resolve(c.id, 'skip');
    assert.strictEqual(result.nextAction.action, 'none');
  });

  it('keeps a conflict open until a queued resolution transfer completes', () => {
    const c = store.detect(
      { path: '/local/deferred.txt', modified: '2026-07-24T12:00:00Z', size: 200, type: 'file' },
      { path: '/remote/deferred.txt', modified: '2026-07-24T13:00:00Z', size: 300, type: 'file' },
      null
    );
    store.record(c);
    const prepared = store.prepareResolution(c.id, 'keep_local');
    assert.strictEqual(prepared.nextAction.action, 'upload');
    assert.ok(store.listActive().some(item => item.id === c.id));
    store.commitResolution(c.id, 'keep_local', { transferCompleted: true });
    assert.ok(!store.listActive().some(item => item.id === c.id));
    assert.strictEqual(db.getTrackedFileByPath(c.remotePath).sync_state, 'synced');
  });

  it('returns false for unknown conflict ID', () => {
    assert.strictEqual(store.resolve('nonexistent-id', 'keep_local'), false);
  });

  it('throws on invalid resolution strategy for a real conflict', () => {
    const c = store.detect(
      { path: '/local/throw_test.txt', modified: '2026-07-24T12:00:00Z', size: 200, type: 'file' },
      { path: '/remote/throw_test.txt', modified: '2026-07-24T13:00:00Z', size: 300, type: 'file' },
      null
    );
    store.record(c);
    assert.throws(() => store.resolve(c.id, 'nonsense_strategy'), /Invalid resolution strategy/);
  });

  it('bulk-checks multiple file pairs', () => {
    const pairs = [
      {
        local: { path: '/local/a.txt', modified: '2026-07-24T12:00:00Z', size: 100, type: 'file' },
        remote: null,
        lastSync: { local_path: '/local/a.txt', remote_path: '/remote/a.txt', local_modified: '2026-07-24T10:00:00Z', size: 100, type: 'file', sync_state: 'synced' }
      }
    ];
    const detected = store.bulkCheck(pairs);
    assert.ok(detected.length >= 1);
  });

  it('provides conflict statistics', () => {
    const stats = store.getStats();
    assert.ok(stats.total > 0);
    assert.ok(stats.byType && typeof stats.byType === 'object');
  });

  it('exposes CONFLICT_TYPES and RESOLUTION_STRATEGIES constants', () => {
    assert.ok(CONFLICT_TYPES.LOCAL_REMOTE_MODIFY);
    assert.ok(CONFLICT_TYPES.TYPE_MISMATCH);
    assert.ok(RESOLUTION_STRATEGIES.KEEP_LOCAL);
    assert.ok(RESOLUTION_STRATEGIES.KEEP_REMOTE);
    assert.ok(RESOLUTION_STRATEGIES.KEEP_BOTH);
    assert.ok(RESOLUTION_STRATEGIES.SKIP);
  });
});
