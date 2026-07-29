const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const { createSyncDb } = require('../src/main/syncDb');
const { createConflictStore } = require('../src/main/conflictStore');
const { createSyncEngine, SYNC_MODES } = require('../src/main/syncEngine');

describe('syncEngine - end-to-end state orchestration', () => {
  let dir;
  let db;
  let queue;
  let engine;
  let store;
  let remoteOutput;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-engine-'));
    db = createSyncDb(path.join(dir, 'sync.db'));
    const emitter = new EventEmitter();
    queue = {
      items: [],
      enqueue(action, options, priority) {
        this.items.push({ action, options, priority });
        return `tx-${this.items.length}`;
      },
      on(event, handler) {
        emitter.on(event, handler);
        return () => emitter.off(event, handler);
      },
      emit(event, payload) { emitter.emit(event, payload); }
    };
    store = createConflictStore(db);
    remoteOutput = '[]';
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stdout: remoteOutput, stderr: '' })
    });
  });

  afterEach(async () => {
    await engine.stop();
    engine.destroy();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('queues both upload and download work in bidirectional mode', async () => {
    const localPath = path.join(dir, 'local.txt');
    fs.writeFileSync(localPath, 'local');
    db.upsertTrackedFile({ remotePath: '/my-files/local.txt', localPath, type: 'file', syncState: 'local_new' });
    db.upsertTrackedFile({ remotePath: '/my-files/remote.txt', type: 'file', syncState: 'remote_new' });
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    const result = await engine.syncPending();
    assert.strictEqual(result.queued, 2);
    assert.deepEqual(queue.items.map(item => item.action).sort(), ['download', 'upload']);
  });

  it('reports the scheduler as active between sync cycles and uses the selected folder', async () => {
    const selected = path.join(dir, 'selected');
    const started = engine.start(SYNC_MODES.CONSERVATIVE, selected, 30000);
    assert.strictEqual(started.folder, selected);
    const state = engine.getState();
    assert.strictEqual(state.engineActive, true);
    assert.strictEqual(state.localFolder, selected);
    await engine.stop();
    assert.strictEqual(engine.getState().engineActive, false);
  });

  it('scans pre-existing local files when sync starts', async () => {
    const selected = path.join(dir, 'selected');
    fs.mkdirSync(selected);
    fs.writeFileSync(path.join(selected, 'existing.txt'), 'existing');
    engine.start(SYNC_MODES.CONSERVATIVE, selected, 30000);
    await new Promise(resolve => setTimeout(resolve, 50));
    const tracked = db.getTrackedFileByPath('/my-files/existing.txt');
    assert.ok(tracked);
    assert.strictEqual(tracked.local_path, path.join(selected, 'existing.txt'));
  });

  it('detects concurrent local and remote changes against the last synced baseline', async () => {
    const localPath = path.join(dir, 'concurrent.txt');
    fs.writeFileSync(localPath, 'old');
    const oldTime = '2026-07-24T10:00:00.000Z';
    db.upsertTrackedFile({ remotePath: '/my-files/concurrent.txt', localPath, type: 'file', localSize: 3, remoteSize: 3, localModified: oldTime, remoteModified: oldTime });
    db.markSynced('/my-files/concurrent.txt');
    fs.writeFileSync(localPath, 'local-new');
    const future = new Date(Date.now() + 10000);
    fs.utimesSync(localPath, future, future);
    remoteOutput = JSON.stringify([{ name: 'concurrent.txt', type: 'file', size: 10, modificationTime: new Date(Date.now() + 20000).toISOString() }]);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    engine.scanLocalTree(dir);
    await engine.pollRemote();
    assert.ok(store.listActive().some(conflict => conflict.remotePath === '/my-files/concurrent.txt'));
    assert.strictEqual(db.getTrackedFileByPath('/my-files/concurrent.txt').sync_state, 'conflict');
  });

  it('commits a conflict resolution only after the queued transfer completes', async () => {
    const localPath = path.join(dir, 'resolve.txt');
    fs.writeFileSync(localPath, 'local');
    const conflict = store.detect(
      { path: localPath, modified: '2026-07-24T12:00:00Z', size: 5, type: 'file' },
      { path: '/my-files/resolve.txt', modified: '2026-07-24T13:00:00Z', size: 6, type: 'file' },
      null
    );
    store.record(conflict);
    const result = engine.resolveConflict(conflict.id, 'keep_local');
    assert.strictEqual(result.pending, true);
    assert.ok(store.listActive().some(item => item.id === conflict.id));
    queue.emit('complete', { id: result.transferId, action: 'upload', options: queue.items[0].options, result: { summary: { totalSkipped: 0 } } });
    assert.ok(!store.listActive().some(item => item.id === conflict.id));
    assert.strictEqual(db.getTrackedFileByPath(conflict.remotePath).sync_state, 'synced');
  });

  it('leaves a conflict open when its resolution transfer fails', () => {
    const localPath = path.join(dir, 'failed-resolve.txt');
    fs.writeFileSync(localPath, 'local');
    const conflict = store.detect(
      { path: localPath, modified: '2026-07-24T12:00:00Z', size: 5, type: 'file' },
      { path: '/my-files/failed-resolve.txt', modified: '2026-07-24T13:00:00Z', size: 6, type: 'file' },
      null
    );
    store.record(conflict);
    const result = engine.resolveConflict(conflict.id, 'keep_local');
    queue.emit('error', { id: result.transferId, action: 'upload', options: queue.items.at(-1).options, error: 'network timeout' });
    assert.ok(store.listActive().some(item => item.id === conflict.id));
    assert.strictEqual(db.getTrackedFileByPath(conflict.remotePath).sync_state, 'conflict');
  });

  it('handles one-shot scan completion while the scheduler is stopped', async () => {
    const syncRoot = path.join(dir, 'one-shot-root');
    fs.mkdirSync(syncRoot);
    engine.start(SYNC_MODES.CONSERVATIVE, syncRoot, 60000);
    await engine.stop();
    const localPath = path.join(syncRoot, 'one-shot.txt');
    fs.writeFileSync(localPath, 'one-shot');
    const result = await engine.scanNow();
    assert.strictEqual(result.queued, 1);
    const item = queue.items.find(entry => entry.options.localPaths?.includes(localPath));
    queue.emit('complete', { id: 'tx-1', action: item.action, options: item.options, result: { summary: { totalSkipped: 0 } } });
    assert.strictEqual(db.getTrackedFileByPath('/my-files/one-shot.txt').sync_state, 'synced');
  });

  it('restores transfer state when a queued transfer is cancelled', async () => {
    const localPath = path.join(dir, 'cancelled.txt');
    fs.writeFileSync(localPath, 'cancelled');
    db.upsertTrackedFile({ remotePath: '/my-files/cancelled.txt', localPath, type: 'file', syncState: 'local_new' });
    engine.setMode(SYNC_MODES.CONSERVATIVE);
    await engine.syncPending();
    const item = queue.items[0];
    queue.emit('cancelled', { id: 'tx-1', action: item.action, options: item.options });
    assert.strictEqual(db.getTrackedFileByPath('/my-files/cancelled.txt').sync_state, 'pending_upload');
  });

  it('does not emit sync_complete before queued work completes', async () => {
    const syncRoot = path.join(dir, 'pending-root');
    fs.mkdirSync(syncRoot);
    engine.start(SYNC_MODES.CONSERVATIVE, syncRoot, 60000);
    await engine.stop();
    const localPath = path.join(syncRoot, 'pending.txt');
    fs.writeFileSync(localPath, 'pending');
    let completed = 0;
    engine.on('sync_complete', () => { completed++; });
    const result = await engine.scanNow();
    assert.strictEqual(result.queued, 1);
    assert.strictEqual(completed, 0);
    const item = queue.items.find(entry => entry.options.localPaths?.includes(localPath));
    queue.emit('complete', { id: 'tx-1', action: item.action, options: item.options, result: { summary: { totalSkipped: 0 } } });
    assert.strictEqual(completed, 1);
  });

  it('does not mark unverified upload descendants as synced', async () => {
    const folder = path.join(dir, 'folder');
    const child = path.join(folder, 'child.txt');
    fs.mkdirSync(folder);
    fs.writeFileSync(child, 'child');
    db.upsertTrackedFile({ remotePath: '/my-files/folder', localPath: folder, type: 'folder', syncState: 'local_new' });
    db.upsertTrackedFile({ remotePath: '/my-files/folder/child.txt', localPath: child, type: 'file', localSize: 5, syncState: 'local_new' });
    engine.setMode(SYNC_MODES.CONSERVATIVE);
    await engine.syncPending();
    queue.emit('complete', { id: 'tx-1', action: 'upload', options: queue.items[0].options, result: { summary: { totalSkipped: 0 } } });
    assert.strictEqual(db.getTrackedFileByPath('/my-files/folder').sync_state, 'synced');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/folder/child.txt').sync_state, 'local_new');
  });

  it('keeps a completed download pending when the expected file is missing', async () => {
    const missing = path.join(dir, 'missing.txt');
    db.upsertTrackedFile({ remotePath: '/my-files/missing.txt', localPath: missing, type: 'file', remoteSize: 7, syncState: 'remote_new' });
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    queue.emit('complete', { id: 'tx-1', action: 'download', options: queue.items[0].options, result: { summary: { totalSkipped: 0 } } });
    assert.strictEqual(db.getTrackedFileByPath('/my-files/missing.txt').sync_state, 'pending_download');
  });

  it('ignores manual queue completions not owned by the sync engine', () => {
    const localPath = path.join(dir, 'manual.txt');
    fs.writeFileSync(localPath, 'manual');
    db.upsertTrackedFile({ remotePath: '/my-files/manual.txt', localPath, type: 'file', localSize: 6, syncState: 'local_modified' });
    queue.emit('complete', { id: 'manual-transfer', action: 'upload', options: { localPaths: [localPath], parentPath: '/unrelated' }, result: { summary: { totalSkipped: 0 } } });
    assert.strictEqual(db.getTrackedFileByPath('/my-files/manual.txt').sync_state, 'local_modified');
  });

  it('keeps skipped conflict resolutions open', () => {
    const localPath = path.join(dir, 'skip-open.txt');
    fs.writeFileSync(localPath, 'local');
    const conflict = store.detect(
      { path: localPath, modified: '2026-07-24T12:00:00Z', size: 5, type: 'file' },
      { path: '/my-files/skip-open.txt', modified: '2026-07-24T13:00:00Z', size: 6, type: 'file' },
      null
    );
    store.record(conflict);
    const result = engine.resolveConflict(conflict.id, 'skip');
    assert.strictEqual(result.conflictOpen, true);
    assert.ok(store.listActive().some(item => item.id === conflict.id));
    assert.strictEqual(db.getTrackedFileByPath(conflict.remotePath).sync_state, 'conflict');
  });

  it('rejects non-finite poll intervals instead of creating a 1 ms timer', () => {
    const started = engine.start(SYNC_MODES.CONSERVATIVE, dir, Infinity);
    assert.strictEqual(started.pollInterval, 60000);
  });

  it('does not report verified completion when the Proton CLI is unavailable', async () => {
    engine.destroy();
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: false, busy: false })
    });
    let completed = 0;
    engine.on('sync_complete', () => { completed++; });
    const result = await engine.scanNow();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'cli-not-ready');
    assert.strictEqual(completed, 0);
  });

  it('rejects explicit remote listing failures', async () => {
    engine.destroy();
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => { throw new Error('remote listing failed'); }
    });
    await assert.rejects(engine.scanNow(), /remote listing failed/);
  });

  it('stops an in-flight recursive remote scan before it queues transfers', async () => {
    engine.destroy();
    let releaseList;
    let listCalls = 0;
    const listGate = new Promise(resolve => { releaseList = resolve; });
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => {
        listCalls++;
        return listGate;
      }
    });
    engine.start(SYNC_MODES.BIDIRECTIONAL, dir, 60000);
    const trackedPath = path.join(dir, 'tracked.txt');
    fs.writeFileSync(trackedPath, 'tracked');
    db.upsertTrackedFile({ remotePath: '/my-files/tracked.txt', localPath: trackedPath, type: 'file', localSize: 7, remoteSize: 7 });
    db.markSynced('/my-files/tracked.txt');
    while (listCalls === 0) await new Promise(resolve => setTimeout(resolve, 1));
    const stopped = engine.stop();
    releaseList({ stdout: JSON.stringify([{ name: 'nested', type: 'folder', modified: '2026-01-01T00:00:00Z', size: 0 }]) });
    await stopped;
    assert.strictEqual(listCalls, 1);
    assert.strictEqual(queue.items.length, 0);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/tracked.txt').sync_state, 'synced');
  });
});
