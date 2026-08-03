const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const Database = require('better-sqlite3');
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
  let remoteError;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-engine-'));
    db = createSyncDb(path.join(dir, 'sync.db'));
    const emitter = new EventEmitter();
    queue = {
      items: [],
      enqueue(action, options, priority) {
        const id = `tx-${this.items.length + 1}`;
        this.items.push({ id, action, options, priority });
        return id;
      },
      on(event, handler) {
        emitter.on(event, handler);
        return () => emitter.off(event, handler);
      },
      emit(event, payload) { emitter.emit(event, payload); }
    };
    store = createConflictStore(db);
    remoteOutput = '[]';
    remoteError = null;
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async (_action, args = {}) => {
        if (remoteError) throw remoteError;
        const stdout = typeof remoteOutput === 'function' ? remoteOutput(args) : remoteOutput;
        return { code: 0, stdout, stderr: '' };
      }
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

  it('invalidates an active authoritative listing as soon as a watcher event is received', async () => {
    engine.destroy();
    const sub = path.join(dir, 'watcher-receipt-gate');
    fs.mkdirSync(sub, { recursive: true });
    const localPath = path.join(sub, 'watched.txt');
    fs.writeFileSync(localPath, 'new-local');
    const stat = fs.statSync(localPath);
    db.upsertTrackedFile({
      remotePath: '/my-files/watched.txt', localPath, type: 'file',
      localSize: stat.size, remoteSize: stat.size,
      localModified: stat.mtime.toISOString(), remoteModified: '2026-08-03T10:00:00.000Z',
      syncState: 'synced'
    });
    db.markSynced('/my-files/watched.txt');
    db.setSyncState('/my-files/watched.txt', 'local_modified');

    let watchCallback;
    const originalWatch = fs.watch;
    fs.watch = (_folder, _options, callback) => {
      watchCallback = callback;
      return { on() { return this; }, close() {} };
    };
    let signalFirstList;
    const firstListStarted = new Promise(resolve => { signalFirstList = resolve; });
    let releaseFirstList;
    const firstListResult = new Promise(resolve => { releaseFirstList = resolve; });
    let releaseSecondList;
    const secondListResult = new Promise(resolve => { releaseSecondList = resolve; });
    let listCalls = 0;
    const listing = {
      code: 0,
      stderr: '',
      stdout: JSON.stringify([{
        name: { ok: true, value: 'watched.txt' }, type: 'file',
        activeRevision: { value: {
          claimedSize: stat.size,
          claimedModificationTime: '2026-08-03T10:00:00.000Z'
        } }
      }])
    };
    try {
      engine = createSyncEngine({
        syncDb: db,
        transferQueue: queue,
        conflictStore: store,
        localFolder: sub,
        getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
        runProton: async () => {
          listCalls++;
          if (listCalls === 1) {
            signalFirstList();
            return firstListResult;
          }
          return secondListResult;
        }
      });
      engine.start(SYNC_MODES.BIDIRECTIONAL, sub, 60_000);
    } finally {
      fs.watch = originalWatch;
    }

    await firstListStarted;
    watchCallback('change', 'watched.txt');
    releaseFirstList(listing);
    const deadline = Date.now() + 250;
    while (Date.now() < deadline && listCalls < 2 && queue.items.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.ok(listCalls >= 2, 'the watcher event did not immediately force a newer listing');
    assert.strictEqual(queue.items.length, 0, 'the pre-event listing scheduled an upload');
    releaseSecondList(listing);
  });

  it('defers watcher uploads until the in-flight authoritative remote poll completes', async () => {
    engine.destroy();
    const sub = path.join(dir, 'watcher-remote-gate');
    fs.mkdirSync(sub, { recursive: true });
    let signalListStarted;
    const listStarted = new Promise(resolve => { signalListStarted = resolve; });
    let releaseList;
    const listResult = new Promise(resolve => { releaseList = resolve; });
    let listCalls = 0;
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: sub,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => {
        listCalls++;
        signalListStarted();
        return listResult;
      }
    });

    engine.start(SYNC_MODES.BIDIRECTIONAL, sub, 60_000);
    await listStarted;
    fs.writeFileSync(path.join(sub, 'watched.txt'), 'local');
    await new Promise(resolve => setTimeout(resolve, 750));
    const prematureTransfers = queue.items.length;

    releaseList({
      code: 0,
      stderr: '',
      stdout: JSON.stringify([{
        name: { ok: true, value: 'watched.txt' },
        type: 'file',
        size: 6,
        modificationTime: '2026-08-03T10:00:00.000Z'
      }])
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && db.getTrackedFileByPath('/my-files/watched.txt')?.sync_state !== 'conflict') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.strictEqual(prematureTransfers, 0, 'watcher queued a transfer before the remote poll completed');
    assert.ok(listCalls >= 2, 'a watcher event during reconciliation did not force a fresh authoritative listing');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/watched.txt')?.sync_state, 'conflict');
    assert.strictEqual(queue.items.length, 0, 'concurrent create was transferred instead of becoming a conflict');
  });

  it('does not flush deferred watcher uploads after a non-authoritative poll', async () => {
    engine.destroy();
    const sub = path.join(dir, 'watcher-non-authoritative');
    fs.mkdirSync(sub, { recursive: true });
    let signalStatusStarted;
    const statusStarted = new Promise(resolve => { signalStatusStarted = resolve; });
    let releaseStatus;
    const statusResult = new Promise(resolve => { releaseStatus = resolve; });
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: sub,
      getStatus: async () => {
        signalStatusStarted();
        return statusResult;
      },
      runProton: async () => ({ code: 0, stdout: '[]', stderr: '' })
    });

    engine.start(SYNC_MODES.BIDIRECTIONAL, sub, 60_000);
    await statusStarted;
    fs.writeFileSync(path.join(sub, 'deferred.txt'), 'local');
    await new Promise(resolve => setTimeout(resolve, 750));
    releaseStatus({ installed: true, authenticated: true, busy: true });
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.strictEqual(queue.items.length, 0, 'watcher upload escaped after a non-authoritative poll');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/deferred.txt')?.sync_state, 'local_new');

    fs.writeFileSync(path.join(sub, 'later.txt'), 'later');
    await new Promise(resolve => setTimeout(resolve, 750));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(queue.items.length, 0, 'a later watcher event bypassed authoritative reconciliation');
  });

  it('does not flush deferred watcher uploads after a failed remote listing', async () => {
    engine.destroy();
    const sub = path.join(dir, 'watcher-failed-listing');
    fs.mkdirSync(sub, { recursive: true });
    let signalListStarted;
    const listStarted = new Promise(resolve => { signalListStarted = resolve; });
    let rejectList;
    const listResult = new Promise((resolve, reject) => { rejectList = reject; });
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: sub,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => {
        signalListStarted();
        return listResult;
      }
    });

    engine.start(SYNC_MODES.BIDIRECTIONAL, sub, 60_000);
    await listStarted;
    fs.writeFileSync(path.join(sub, 'failed.txt'), 'local');
    await new Promise(resolve => setTimeout(resolve, 750));
    rejectList(new Error('remote listing failed'));
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.strictEqual(queue.items.length, 0, 'watcher upload escaped after a failed remote listing');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/failed.txt')?.sync_state, 'local_new');

    fs.writeFileSync(path.join(sub, 'later-failed.txt'), 'later');
    await new Promise(resolve => setTimeout(resolve, 750));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(queue.items.length, 0, 'a later watcher event bypassed a failed authoritative listing');
  });

  it('rejects an empty remote listing before deletion reconciliation', async () => {
    const localPath = path.join(dir, 'preserved.txt');
    fs.writeFileSync(localPath, 'preserved');
    db.upsertTrackedFile({
      remotePath: '/my-files/preserved.txt', localPath, type: 'file',
      localSize: 9, remoteSize: 9, localModified: '2026-08-03T10:00:00.000Z',
      remoteModified: '2026-08-03T10:00:00.000Z', syncState: 'synced'
    });
    db.markSynced('/my-files/preserved.txt');
    remoteOutput = '';
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);

    await assert.rejects(engine.pollRemote(), /empty JSON listing/i);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/preserved.txt').sync_state, 'synced');
    assert.strictEqual((await engine.syncPending()).queued, 0);
    assert.strictEqual(queue.items.length, 0);
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
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'concurrent.txt' },
      type: 'file', size: 10,
      modificationTime: new Date(Date.now() + 20000).toISOString()
    }]);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.scanLocalTree(dir);
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
    const remoteSha1 = crypto.createHash('sha1').update('local').digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'resolve.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 5, claimedModificationTime: '2026-07-24T14:00:00Z',
        claimedDigests: { sha1: remoteSha1, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', { id: result.transferId, action: 'upload', options: queue.items[0].options, result: { summary: { totalSkipped: 0 } } });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && store.listActive().some(item => item.id === conflict.id)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
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
    const remoteSha1 = crypto.createHash('sha1').update('one-shot').digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'one-shot.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 8, claimedModificationTime: '2026-08-03T12:00:00Z',
        claimedDigests: { sha1: remoteSha1, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', { id: item.id, action: item.action, options: item.options, result: { summary: { totalSkipped: 0 } } });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && db.getTrackedFileByPath('/my-files/one-shot.txt').sync_state !== 'synced') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.strictEqual(db.getTrackedFileByPath('/my-files/one-shot.txt').sync_state, 'synced');
  });

  it('verifies the authoritative remote revision before marking an upload synced', async () => {
    const localPath = path.join(dir, 'verify-upload.txt');
    fs.writeFileSync(localPath, 'old');
    db.upsertTrackedFile({
      remotePath: '/my-files/verify-upload.txt', localPath, type: 'file',
      localSize: 3, remoteSize: 3,
      localModified: '2026-08-03T10:00:00.000Z', remoteModified: '2026-08-03T10:00:00.000Z',
      remoteHash: `sha1:${'1'.repeat(40)}`, syncState: 'synced'
    });
    db.markSynced('/my-files/verify-upload.txt');

    const uploaded = 'new-local';
    fs.writeFileSync(localPath, uploaded);
    await engine.scanLocalTree(dir);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const uploadIndex = queue.items.findIndex(item => item.options.localPaths?.includes(localPath));
    const upload = queue.items[uploadIndex];
    assert.strictEqual(upload.action, 'upload');

    const remoteSha1 = crypto.createHash('sha1').update(uploaded).digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'verify-upload.txt' },
      type: 'file',
      activeRevision: { value: {
        claimedSize: Buffer.byteLength(uploaded),
        claimedModificationTime: '2026-08-03T11:00:00.000Z',
        claimedDigests: { sha1: remoteSha1, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', { id: upload.id || `tx-${uploadIndex + 1}`, action: 'upload', options: upload.options, result: { summary: { totalSkipped: 0 } } });

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && db.getTrackedFileByPath('/my-files/verify-upload.txt')?.synced_remote_hash !== `sha1:${remoteSha1}`) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const verified = db.getTrackedFileByPath('/my-files/verify-upload.txt');
    assert.strictEqual(verified.sync_state, 'synced');
    assert.strictEqual(verified.synced_remote_hash, `sha1:${remoteSha1}`);
    assert.strictEqual(verified.synced_remote_size, Buffer.byteLength(uploaded));
    const targetTransfers = queue.items.filter(item =>
      item.options.localPaths?.includes(localPath) || item.options.paths?.includes('/my-files/verify-upload.txt'));
    assert.deepEqual(targetTransfers.map(item => item.action), ['upload']);
  });

  it('does not verify an upload from a remote snapshot captured before transfer completion', async () => {
    engine.destroy();
    const localPath = path.join(dir, 'pre-completion-snapshot.txt');
    const uploaded = 'uploaded';
    fs.writeFileSync(localPath, uploaded);
    const remoteSha1 = crypto.createHash('sha1').update(uploaded).digest('hex');
    let signalSnapshotCaptured;
    const snapshotCaptured = new Promise(resolve => { signalSnapshotCaptured = resolve; });
    let releaseSnapshot;
    const snapshotRelease = new Promise(resolve => { releaseSnapshot = resolve; });
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({
        code: 0,
        stderr: '',
        stdout: JSON.stringify([{
          name: 'pre-completion-snapshot.txt', type: 'file', size: uploaded.length,
          modified: '2026-08-03T10:00:00.000Z', hash: `sha1:${remoteSha1}`
        }])
      }),
      parseListOutput: async stdout => {
        const parsed = JSON.parse(stdout);
        signalSnapshotCaptured();
        await snapshotRelease;
        return parsed;
      }
    });

    await engine.scanLocalTree(dir);
    const tracked = db.getTrackedFileByPath('/my-files/pre-completion-snapshot.txt');
    db.upsertTrackedFile({
      remotePath: tracked.remote_path, localPath, type: 'file',
      localSize: uploaded.length, remoteSize: uploaded.length,
      localModified: tracked.local_modified, remoteModified: '2026-08-03T10:00:00.000Z',
      localHash: tracked.local_hash, remoteHash: `sha1:${remoteSha1}`, syncState: 'synced'
    });
    db.markSynced(tracked.remote_path);
    db.setSyncState(tracked.remote_path, 'local_modified');
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const uploadIndex = queue.items.findIndex(item => item.options.localPaths?.includes(localPath));
    const upload = queue.items[uploadIndex];
    assert.strictEqual(upload.action, 'upload');

    const staleCycle = engine.runSyncCycle();
    await snapshotCaptured;
    queue.emit('complete', {
      id: upload.id || `tx-${uploadIndex + 1}`, action: 'upload', options: upload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    releaseSnapshot();
    const result = await staleCycle;

    assert.strictEqual(result.deferred, true);
    const pending = db.getTrackedFileByPath(tracked.remote_path);
    assert.strictEqual(pending.sync_state, 'uploading');
    assert.ok(pending.upload_verification_local_hash);
  });

  it('keeps an upload uncommitted when the authoritative revision has no verified digest', async () => {
    const localPath = path.join(dir, 'no-digest.txt');
    fs.writeFileSync(localPath, 'no-digest');
    db.upsertTrackedFile({
      remotePath: '/my-files/no-digest.txt', localPath, type: 'file',
      localSize: 9, localModified: fs.statSync(localPath).mtime.toISOString(), syncState: 'local_new'
    });
    engine.setMode(SYNC_MODES.CONSERVATIVE);
    await engine.syncPending();
    const uploadIndex = queue.items.findIndex(item => item.options.localPaths?.includes(localPath));
    const upload = queue.items[uploadIndex];
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'no-digest.txt' }, type: 'file',
      activeRevision: { value: { claimedSize: 9, claimedModificationTime: '2026-08-03T12:00:00Z' } }
    }]);
    queue.emit('complete', { id: upload.id || `tx-${uploadIndex + 1}`, action: 'upload', options: upload.options, result: { summary: { totalSkipped: 0 } } });
    await new Promise(resolve => setTimeout(resolve, 100));
    const pending = db.getTrackedFileByPath('/my-files/no-digest.txt');
    assert.strictEqual(pending.sync_state, 'uploading');
    assert.ok(pending.upload_verification_local_hash);
    assert.notStrictEqual(pending.synced_local_hash, pending.local_hash);
    const targetTransfers = queue.items.filter(item =>
      item.options.localPaths?.includes(localPath) || item.options.paths?.includes('/my-files/no-digest.txt'));
    assert.deepEqual(targetTransfers.map(item => item.action), ['upload']);
  });

  it('does not requeue a persisted upload verification as a stale upload', async () => {
    const localPath = path.join(dir, 'restart-verify.txt');
    fs.writeFileSync(localPath, 'restart');
    await engine.scanLocalTree(dir);
    db.setSyncState('/my-files/restart-verify.txt', 'uploading');
    db.beginUploadVerification('/my-files/restart-verify.txt');
    const raw = new Database(db.dbPath);
    raw.prepare("UPDATE tracked_files SET updated_at='2000-01-01T00:00:00.000Z' WHERE remote_path='/my-files/restart-verify.txt'").run();
    raw.close();
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'restart-verify.txt' }, type: 'file',
      activeRevision: { value: { claimedSize: 7, claimedModificationTime: '2026-08-03T12:00:00Z' } }
    }]);
    engine.start(SYNC_MODES.CONSERVATIVE, dir, 60_000);
    await new Promise(resolve => setTimeout(resolve, 100));
    const pending = db.getTrackedFileByPath('/my-files/restart-verify.txt');
    assert.strictEqual(pending.sync_state, 'uploading');
    assert.ok(pending.upload_verification_local_hash);
    assert.ok(!queue.items.some(item => item.options.localPaths?.includes(localPath)));
  });

  it('turns a mismatched post-upload remote digest into a conflict', async () => {
    const localPath = path.join(dir, 'mismatch.txt');
    fs.writeFileSync(localPath, 'old');
    db.upsertTrackedFile({
      remotePath: '/my-files/mismatch.txt', localPath, type: 'file',
      localSize: 3, remoteSize: 3, localModified: '2026-08-03T10:00:00Z',
      remoteModified: '2026-08-03T10:00:00Z', remoteHash: `sha1:${'1'.repeat(40)}`, syncState: 'synced'
    });
    db.markSynced('/my-files/mismatch.txt');
    fs.writeFileSync(localPath, 'new-local');
    await engine.scanLocalTree(dir);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const uploadIndex = queue.items.findIndex(item => item.options.localPaths?.includes(localPath));
    const upload = queue.items[uploadIndex];
    const differentSha1 = crypto.createHash('sha1').update('different').digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'mismatch.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 9, claimedModificationTime: '2026-08-03T12:00:00Z',
        claimedDigests: { sha1: differentSha1, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', { id: upload.id || `tx-${uploadIndex + 1}`, action: 'upload', options: upload.options, result: { summary: { totalSkipped: 0 } } });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && db.getTrackedFileByPath('/my-files/mismatch.txt').sync_state !== 'conflict') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.strictEqual(db.getTrackedFileByPath('/my-files/mismatch.txt').sync_state, 'conflict');
    assert.ok(store.listActive().some(conflict => conflict.remotePath === '/my-files/mismatch.txt'));
  });

  it('rejects a local file mutation that occurs during upload digest verification', async () => {
    const localPath = path.join(dir, 'mutate-during-verify.bin');
    const originalContent = Buffer.alloc(1024 * 1024, 0x41);
    fs.writeFileSync(localPath, originalContent);
    await engine.scanLocalTree(dir);
    db.setSyncState('/my-files/mutate-during-verify.bin', 'uploading');
    db.beginUploadVerification('/my-files/mutate-during-verify.bin');
    const remoteSha1 = crypto.createHash('sha1').update(originalContent).digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'mutate-during-verify.bin' }, type: 'file',
      activeRevision: { value: {
        claimedSize: originalContent.length, claimedModificationTime: '2026-08-03T16:00:00Z',
        claimedDigests: { sha1: remoteSha1, sha1Verified: true }
      } }
    }]);

    const originalCreateReadStream = fs.createReadStream;
    let mutated = false;
    fs.createReadStream = (...args) => {
      const stream = originalCreateReadStream(...args);
      if (path.resolve(args[0]) === path.resolve(localPath)) {
        stream.once('data', () => {
          fs.writeFileSync(localPath, Buffer.alloc(originalContent.length, 0x42));
          mutated = true;
        });
      }
      return stream;
    };
    try {
      await engine.pollRemote();
    } finally {
      fs.createReadStream = originalCreateReadStream;
    }
    assert.strictEqual(mutated, true);
    const row = db.getTrackedFileByPath('/my-files/mutate-during-verify.bin');
    assert.strictEqual(row.sync_state, 'local_modified');
    assert.strictEqual(row.upload_verification_local_hash, null);
    assert.strictEqual(Number(row.upload_reupload_pending), 1);
    assert.notStrictEqual(row.sync_state, 'synced');
    assert.ok(!store.listActive().some(item => item.remotePath === '/my-files/mutate-during-verify.bin'));
  });

  it('clears stale upload verification after a local edit and still converges on the new content', async () => {
    engine.destroy();
    const localPath = path.join(dir, 'stale-verify-converge.txt');
    fs.writeFileSync(localPath, 'AAA');
    let releaseList;
    const listHeld = new Promise(resolve => { releaseList = resolve; });
    let listCalls = 0;
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => {
        listCalls += 1;
        if (listCalls === 1) await listHeld;
        return {
          code: 0,
          stderr: '',
          stdout: remoteOutput
        };
      }
    });

    await engine.scanLocalTree(dir);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const firstUpload = queue.items.find(item => item.options.localPaths?.includes(localPath));
    assert.ok(firstUpload);

    const shaA = crypto.createHash('sha1').update('AAA').digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'stale-verify-converge.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T10:00:00.000Z',
        claimedDigests: { sha1: shaA, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', {
      id: firstUpload.id, action: 'upload', options: firstUpload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const pending = db.getTrackedFileByPath('/my-files/stale-verify-converge.txt');
    assert.strictEqual(pending.sync_state, 'uploading');
    assert.ok(pending.upload_verification_local_hash);
    db.setUploadExpectedRemoteHash('/my-files/stale-verify-converge.txt', `sha1:${shaA}`);

    fs.writeFileSync(localPath, 'BBB');
    await engine.scanLocalTree(dir);
    const afterEdit = db.getTrackedFileByPath('/my-files/stale-verify-converge.txt');
    assert.strictEqual(afterEdit.sync_state, 'local_modified');
    assert.strictEqual(afterEdit.upload_verification_local_hash, null);
    assert.strictEqual(Number(afterEdit.upload_reupload_pending), 1);

    releaseList();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(store.listActive().length, 0);
    const afterHeldCycle = db.getTrackedFileByPath('/my-files/stale-verify-converge.txt');
    assert.ok(
      ['local_modified', 'pending_upload', 'uploading'].includes(afterHeldCycle.sync_state),
      `unexpected state after cancelled verification: ${afterHeldCycle.sync_state}`
    );

    await engine.syncPending();
    const secondUpload = queue.items.filter(item => item.options.localPaths?.includes(localPath)).at(-1);
    assert.strictEqual(secondUpload.action, 'upload');
    const shaB = crypto.createHash('sha1').update('BBB').digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'stale-verify-converge.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T11:00:00.000Z',
        claimedDigests: { sha1: shaB, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', {
      id: secondUpload.id,
      action: 'upload',
      options: secondUpload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline &&
      db.getTrackedFileByPath('/my-files/stale-verify-converge.txt')?.synced_remote_hash !== `sha1:${shaB}`) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const finalRow = db.getTrackedFileByPath('/my-files/stale-verify-converge.txt');
    assert.strictEqual(finalRow.sync_state, 'synced');
    assert.strictEqual(finalRow.synced_remote_hash, `sha1:${shaB}`);
    assert.strictEqual(finalRow.upload_verification_local_hash, null);
    assert.strictEqual(Number(finalRow.upload_reupload_pending), 0);
    assert.strictEqual(store.listActive().length, 0);
  });

  it('does not sticky-conflict a previously synced file edited during upload verification', async () => {
    engine.destroy();
    const localPath = path.join(dir, 'prev-synced-verify.txt');
    fs.writeFileSync(localPath, 'OLD');
    let releaseList;
    const listHeld = new Promise(resolve => { releaseList = resolve; });
    let listCalls = 0;
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => {
        listCalls += 1;
        if (listCalls === 1) await listHeld;
        return { code: 0, stderr: '', stdout: remoteOutput };
      }
    });

    await engine.scanLocalTree(dir);
    const initial = db.getTrackedFileByPath('/my-files/prev-synced-verify.txt');
    const oldSha = crypto.createHash('sha1').update('OLD').digest('hex');
    db.upsertTrackedFile({
      remotePath: '/my-files/prev-synced-verify.txt',
      localPath,
      type: 'file',
      size: 3,
      localSize: 3,
      remoteSize: 3,
      localModified: initial.local_modified,
      remoteModified: initial.local_modified,
      localHash: initial.local_hash,
      remoteHash: `sha1:${oldSha}`,
      syncState: 'synced'
    });
    db.markSynced('/my-files/prev-synced-verify.txt');

    fs.writeFileSync(localPath, 'AAA');
    await engine.scanLocalTree(dir);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const firstUpload = queue.items.find(item => item.options.localPaths?.includes(localPath));
    assert.ok(firstUpload);

    const shaA = crypto.createHash('sha1').update('AAA').digest('hex');
    // Wait for real enqueue auto-pin (no manual setUploadExpectedRemoteHash).
    const pinDeadline = Date.now() + 2_000;
    while (Date.now() < pinDeadline &&
      db.getTrackedFileByPath('/my-files/prev-synced-verify.txt')?.upload_expected_remote_hash !== `sha1:${shaA}`) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.strictEqual(
      db.getTrackedFileByPath('/my-files/prev-synced-verify.txt').upload_expected_remote_hash,
      `sha1:${shaA}`,
      'auto-pin must store a single sha1: prefix matching the uploaded content'
    );

    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'prev-synced-verify.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T12:00:00.000Z',
        claimedDigests: { sha1: shaA, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', {
      id: firstUpload.id, action: 'upload', options: firstUpload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(db.getTrackedFileByPath('/my-files/prev-synced-verify.txt').upload_verification_local_hash);
    // Complete clears then re-pins the just-uploaded content asynchronously.
    const repinDeadline = Date.now() + 2_000;
    while (Date.now() < repinDeadline &&
      db.getTrackedFileByPath('/my-files/prev-synced-verify.txt')?.upload_expected_remote_hash !== `sha1:${shaA}`) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.strictEqual(
      db.getTrackedFileByPath('/my-files/prev-synced-verify.txt').upload_expected_remote_hash,
      `sha1:${shaA}`
    );

    fs.writeFileSync(localPath, 'BBB');
    await engine.scanLocalTree(dir);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/prev-synced-verify.txt').sync_state, 'local_modified');
    assert.strictEqual(Number(db.getTrackedFileByPath('/my-files/prev-synced-verify.txt').upload_reupload_pending), 1);

    releaseList();
    await new Promise(resolve => setTimeout(resolve, 80));
    await engine.pollRemote();
    assert.strictEqual(store.listActive().length, 0);
    assert.notStrictEqual(db.getTrackedFileByPath('/my-files/prev-synced-verify.txt').sync_state, 'conflict');

    await engine.syncPending();
    const secondUpload = queue.items.filter(item => item.options.localPaths?.includes(localPath)).at(-1);
    assert.strictEqual(secondUpload.action, 'upload');
    const shaB = crypto.createHash('sha1').update('BBB').digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'prev-synced-verify.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T13:00:00.000Z',
        claimedDigests: { sha1: shaB, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', {
      id: secondUpload.id,
      action: 'upload',
      options: secondUpload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline &&
      db.getTrackedFileByPath('/my-files/prev-synced-verify.txt')?.synced_remote_hash !== `sha1:${shaB}`) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const finalRow = db.getTrackedFileByPath('/my-files/prev-synced-verify.txt');
    assert.strictEqual(finalRow.sync_state, 'synced');
    assert.strictEqual(finalRow.synced_remote_hash, `sha1:${shaB}`);
    assert.strictEqual(Number(finalRow.upload_reupload_pending), 0);
    assert.strictEqual(store.listActive().length, 0);
  });

  it('conflicts when a third-party remote revision lands during cancelled upload reupload', async () => {
    engine.destroy();
    const localPath = path.join(dir, 'third-party-during-reupload.txt');
    fs.writeFileSync(localPath, 'OLD');
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stderr: '', stdout: remoteOutput })
    });
    await engine.scanLocalTree(dir);
    const initial = db.getTrackedFileByPath('/my-files/third-party-during-reupload.txt');
    const oldSha = crypto.createHash('sha1').update('OLD').digest('hex');
    db.upsertTrackedFile({
      remotePath: '/my-files/third-party-during-reupload.txt',
      localPath,
      type: 'file',
      size: 3,
      localSize: 3,
      remoteSize: 3,
      localModified: initial.local_modified,
      remoteModified: initial.local_modified,
      localHash: initial.local_hash,
      remoteHash: `sha1:${oldSha}`,
      syncState: 'synced'
    });
    db.markSynced('/my-files/third-party-during-reupload.txt');

    fs.writeFileSync(localPath, 'AAA');
    await engine.scanLocalTree(dir);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const firstUpload = queue.items.find(item => item.options.localPaths?.includes(localPath));
    const shaA = crypto.createHash('sha1').update('AAA').digest('hex');
    queue.emit('complete', {
      id: firstUpload.id, action: 'upload', options: firstUpload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    db.setUploadExpectedRemoteHash('/my-files/third-party-during-reupload.txt', `sha1:${shaA}`);
    fs.writeFileSync(localPath, 'BBB');
    await engine.scanLocalTree(dir);
    assert.strictEqual(Number(db.getTrackedFileByPath('/my-files/third-party-during-reupload.txt').upload_reupload_pending), 1);

    const shaC = crypto.createHash('sha1').update('CCC').digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'third-party-during-reupload.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T14:00:00.000Z',
        claimedDigests: { sha1: shaC, sha1Verified: true }
      } }
    }]);
    await engine.pollRemote();
    const row = db.getTrackedFileByPath('/my-files/third-party-during-reupload.txt');
    assert.strictEqual(row.sync_state, 'conflict');
    assert.ok(store.listActive().some(item => item.remotePath === '/my-files/third-party-during-reupload.txt'));
    assert.notStrictEqual(row.synced_remote_hash, `sha1:${shaC}`);
  });

  it('does not treat a missing remote listing as delete while upload reupload is pending', async () => {
    engine.destroy();
    const localPath = path.join(dir, 'reupload-empty-listing.txt');
    fs.writeFileSync(localPath, 'OLD');
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stderr: '', stdout: remoteOutput })
    });
    await engine.scanLocalTree(dir);
    const initial = db.getTrackedFileByPath('/my-files/reupload-empty-listing.txt');
    const oldSha = crypto.createHash('sha1').update('OLD').digest('hex');
    db.upsertTrackedFile({
      remotePath: '/my-files/reupload-empty-listing.txt',
      localPath,
      type: 'file',
      size: 3,
      localSize: 3,
      remoteSize: 3,
      localModified: initial.local_modified,
      remoteModified: initial.local_modified,
      localHash: initial.local_hash,
      remoteHash: `sha1:${oldSha}`,
      syncState: 'synced'
    });
    db.markSynced('/my-files/reupload-empty-listing.txt');

    fs.writeFileSync(localPath, 'AAA');
    await engine.scanLocalTree(dir);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const firstUpload = queue.items.find(item => item.options.localPaths?.includes(localPath));
    const shaA = crypto.createHash('sha1').update('AAA').digest('hex');
    queue.emit('complete', {
      id: firstUpload.id, action: 'upload', options: firstUpload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    db.setUploadExpectedRemoteHash('/my-files/reupload-empty-listing.txt', `sha1:${shaA}`);
    fs.writeFileSync(localPath, 'BBB');
    await engine.scanLocalTree(dir);
    assert.strictEqual(Number(db.getTrackedFileByPath('/my-files/reupload-empty-listing.txt').upload_reupload_pending), 1);

    // Authoritative empty listing during propagation must not sticky-conflict.
    remoteOutput = '[]';
    await engine.pollRemote();
    const mid = db.getTrackedFileByPath('/my-files/reupload-empty-listing.txt');
    assert.strictEqual(mid.sync_state, 'local_modified');
    assert.strictEqual(Number(mid.upload_reupload_pending), 1);
    assert.strictEqual(store.listActive().length, 0);

    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'reupload-empty-listing.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T15:00:00.000Z',
        claimedDigests: { sha1: shaA, sha1Verified: true }
      } }
    }]);
    await engine.pollRemote();
    assert.strictEqual(store.listActive().length, 0);
    assert.notStrictEqual(db.getTrackedFileByPath('/my-files/reupload-empty-listing.txt').sync_state, 'conflict');
    assert.strictEqual(Number(db.getTrackedFileByPath('/my-files/reupload-empty-listing.txt').upload_reupload_pending), 1);
  });

  it('does not false-conflict when prior own revision is still listed during successor upload', async () => {
    engine.destroy();
    const localPath = path.join(dir, 'prior-own-during-successor.txt');
    fs.writeFileSync(localPath, 'OLD');
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stderr: '', stdout: remoteOutput })
    });
    await engine.scanLocalTree(dir);
    const initial = db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt');
    const oldSha = crypto.createHash('sha1').update('OLD').digest('hex');
    db.upsertTrackedFile({
      remotePath: '/my-files/prior-own-during-successor.txt',
      localPath,
      type: 'file',
      size: 3,
      localSize: 3,
      remoteSize: 3,
      localModified: initial.local_modified,
      remoteModified: initial.local_modified,
      localHash: initial.local_hash,
      remoteHash: `sha1:${oldSha}`,
      syncState: 'synced'
    });
    db.markSynced('/my-files/prior-own-during-successor.txt');

    fs.writeFileSync(localPath, 'AAA');
    await engine.scanLocalTree(dir);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const firstUpload = queue.items.find(item => item.options.localPaths?.includes(localPath));
    const shaA = crypto.createHash('sha1').update('AAA').digest('hex');
    const pinDeadline = Date.now() + 2_000;
    while (Date.now() < pinDeadline &&
      db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt')?.upload_expected_remote_hash !== `sha1:${shaA}`) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'prior-own-during-successor.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T12:00:00.000Z',
        claimedDigests: { sha1: shaA, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', {
      id: firstUpload.id, action: 'upload', options: firstUpload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    const syncDeadline = Date.now() + 2_000;
    while (Date.now() < syncDeadline &&
      db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt')?.sync_state !== 'synced') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.strictEqual(db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt').sync_state, 'synced');

    fs.writeFileSync(localPath, 'BBB');
    await engine.scanLocalTree(dir);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt').sync_state, 'local_modified');
    await engine.syncPending();
    const secondUpload = queue.items.filter(item => item.options.localPaths?.includes(localPath)).at(-1);
    assert.ok(secondUpload);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt').sync_state, 'uploading');
    assert.strictEqual(Number(db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt').upload_reupload_pending), 0);

    // Remote still shows prior own A while B is uploading.
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'prior-own-during-successor.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T12:00:00.000Z',
        claimedDigests: { sha1: shaA, sha1Verified: true }
      } }
    }]);
    await engine.pollRemote();
    assert.strictEqual(store.listActive().length, 0);
    assert.notStrictEqual(db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt').sync_state, 'conflict');

    const shaB = crypto.createHash('sha1').update('BBB').digest('hex');
    const pinBDeadline = Date.now() + 2_000;
    while (Date.now() < pinBDeadline &&
      db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt')?.upload_expected_remote_hash !== `sha1:${shaB}`) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // Complete B while remote still shows A: must wait, not conflict.
    queue.emit('complete', {
      id: secondUpload.id,
      action: 'upload',
      options: secondUpload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    await engine.pollRemote();
    assert.strictEqual(store.listActive().length, 0);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt').sync_state, 'uploading');
    assert.ok(db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt').upload_verification_local_hash);

    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'prior-own-during-successor.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T13:00:00.000Z',
        claimedDigests: { sha1: shaB, sha1Verified: true }
      } }
    }]);
    await engine.pollRemote();
    const finalRow = db.getTrackedFileByPath('/my-files/prior-own-during-successor.txt');
    assert.strictEqual(finalRow.sync_state, 'synced');
    assert.strictEqual(finalRow.synced_remote_hash, `sha1:${shaB}`);
  });

  it('cancels into reupload when local edits during the in-flight transfer before verification', async () => {
    engine.destroy();
    const localPath = path.join(dir, 'edit-during-transfer.txt');
    fs.writeFileSync(localPath, 'AAA');
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stderr: '', stdout: remoteOutput })
    });
    await engine.scanLocalTree(dir);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const firstUpload = queue.items.find(item => item.options.localPaths?.includes(localPath));
    assert.ok(firstUpload);
    const shaA = crypto.createHash('sha1').update('AAA').digest('hex');
    const pinDeadline = Date.now() + 2_000;
    while (Date.now() < pinDeadline &&
      db.getTrackedFileByPath('/my-files/edit-during-transfer.txt')?.upload_expected_remote_hash !== `sha1:${shaA}`) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.strictEqual(db.getTrackedFileByPath('/my-files/edit-during-transfer.txt').sync_state, 'uploading');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/edit-during-transfer.txt').upload_verification_local_hash, null);

    fs.writeFileSync(localPath, 'BBB');
    await engine.scanLocalTree(dir);
    const afterEdit = db.getTrackedFileByPath('/my-files/edit-during-transfer.txt');
    assert.strictEqual(afterEdit.sync_state, 'local_modified');
    assert.strictEqual(Number(afterEdit.upload_reupload_pending), 1);
    assert.strictEqual(afterEdit.upload_verification_local_hash, null);

    // Re-enqueue successor BBB (clears reupload_pending via setSyncState uploading).
    await engine.syncPending();
    const secondUpload = [...queue.items].reverse()
      .find(item => item.options.localPaths?.includes(localPath) && item.id !== firstUpload.id);
    assert.ok(secondUpload, 'successor upload for BBB should be enqueued');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/edit-during-transfer.txt').sync_state, 'uploading');
    assert.strictEqual(Number(db.getTrackedFileByPath('/my-files/edit-during-transfer.txt').upload_reupload_pending), 0);

    // Stale complete of original AAA must not verify/conflict after re-enqueue.
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'edit-during-transfer.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T12:00:00.000Z',
        claimedDigests: { sha1: shaA, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', {
      id: firstUpload.id, action: 'upload', options: firstUpload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    await engine.pollRemote();
    const afterStale = db.getTrackedFileByPath('/my-files/edit-during-transfer.txt');
    assert.strictEqual(store.listActive().length, 0);
    assert.notStrictEqual(afterStale.sync_state, 'conflict');
    assert.ok(['local_modified', 'pending_upload', 'uploading'].includes(afterStale.sync_state));
    // Stale AAA complete must not start verification of post-edit BBB bytes.
    assert.strictEqual(afterStale.upload_verification_local_hash, null);

    // Successor BBB completes and converges when remote shows BBB.
    const shaB = crypto.createHash('sha1').update('BBB').digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'edit-during-transfer.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T12:30:00.000Z',
        claimedDigests: { sha1: shaB, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', {
      id: secondUpload.id, action: 'upload', options: secondUpload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline &&
      db.getTrackedFileByPath('/my-files/edit-during-transfer.txt')?.sync_state !== 'synced') {
      await engine.pollRemote();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const converged = db.getTrackedFileByPath('/my-files/edit-during-transfer.txt');
    assert.strictEqual(converged.sync_state, 'synced');
    assert.strictEqual(converged.synced_remote_hash, `sha1:${shaB}`);
  });

  it('does not false-conflict when successor verifies while remote still shows intermediate own upload', async () => {
    engine.destroy();
    const localPath = path.join(dir, 'successor-lag.txt');
    fs.writeFileSync(localPath, 'OLD');
    const shaOld = crypto.createHash('sha1').update('OLD').digest('hex');
    const shaA = crypto.createHash('sha1').update('AAA').digest('hex');
    const shaB = crypto.createHash('sha1').update('BBB').digest('hex');
    db.upsertTrackedFile({
      remotePath: '/my-files/successor-lag.txt', localPath, type: 'file', size: 3, localSize: 3, remoteSize: 3,
      localModified: '2026-08-04T10:00:00.000Z', remoteModified: '2026-08-04T10:00:00.000Z',
      localHash: `v2:${shaOld.slice(0, 16)}:1.000`, remoteHash: `sha1:${shaOld}`, syncState: 'synced'
    });
    db.markSynced('/my-files/successor-lag.txt');
    engine = createSyncEngine({
      syncDb: db, transferQueue: queue, conflictStore: store, localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stderr: '', stdout: remoteOutput })
    });
    fs.writeFileSync(localPath, 'AAA');
    await engine.scanLocalTree(dir);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const firstUpload = queue.items.find(item => item.options.localPaths?.includes(localPath));
    assert.ok(firstUpload);
    const pinDeadline = Date.now() + 2000;
    while (Date.now() < pinDeadline &&
      db.getTrackedFileByPath('/my-files/successor-lag.txt')?.upload_expected_remote_hash !== `sha1:${shaA}`) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    fs.writeFileSync(localPath, 'BBB');
    await engine.scanLocalTree(dir);
    await engine.syncPending();
    const secondUpload = [...queue.items].reverse()
      .find(item => item.options.localPaths?.includes(localPath) && item.id !== firstUpload.id);
    assert.ok(secondUpload);
    // Stale A complete ignored.
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'successor-lag.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T12:00:00.000Z',
        claimedDigests: { sha1: shaA, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', { id: firstUpload.id, action: 'upload', options: firstUpload.options, result: { summary: { totalSkipped: 0 } } });
    await new Promise(resolve => setTimeout(resolve, 30));
    // Successor B completes while remote still shows intermediate own A.
    queue.emit('complete', { id: secondUpload.id, action: 'upload', options: secondUpload.options, result: { summary: { totalSkipped: 0 } } });
    await new Promise(resolve => setTimeout(resolve, 40));
    await engine.pollRemote();
    const lag = db.getTrackedFileByPath('/my-files/successor-lag.txt');
    assert.notStrictEqual(lag.sync_state, 'conflict');
    assert.strictEqual(store.listActive().length, 0);
    assert.ok(['uploading', 'local_modified', 'pending_upload'].includes(lag.sync_state));
    // Converge when remote catches up to B.
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'successor-lag.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T12:30:00.000Z',
        claimedDigests: { sha1: shaB, sha1Verified: true }
      } }
    }]);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && db.getTrackedFileByPath('/my-files/successor-lag.txt')?.sync_state !== 'synced') {
      await engine.pollRemote();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.strictEqual(db.getTrackedFileByPath('/my-files/successor-lag.txt').sync_state, 'synced');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/successor-lag.txt').synced_remote_hash, `sha1:${shaB}`);
  });

  it('cancels into reupload when file is quietly edited before upload complete (no scan)', async () => {
    engine.destroy();
    const localPath = path.join(dir, 'quiet-edit-complete.txt');
    fs.writeFileSync(localPath, 'AAA');
    engine = createSyncEngine({
      syncDb: db, transferQueue: queue, conflictStore: store, localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stderr: '', stdout: remoteOutput })
    });
    await engine.scanLocalTree(dir);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const firstUpload = queue.items.find(item => item.options.localPaths?.includes(localPath));
    assert.ok(firstUpload);
    const shaA = crypto.createHash('sha1').update('AAA').digest('hex');
    const pinDeadline = Date.now() + 2000;
    while (Date.now() < pinDeadline &&
      db.getTrackedFileByPath('/my-files/quiet-edit-complete.txt')?.upload_expected_remote_hash !== `sha1:${shaA}`) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const preEdit = db.getTrackedFileByPath('/my-files/quiet-edit-complete.txt');
    assert.strictEqual(preEdit.sync_state, 'uploading');
    assert.ok(!preEdit.upload_verification_local_hash);

    // Quiet rewrite after transfer, before complete — no scan/watcher.
    fs.writeFileSync(localPath, 'BBB');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'quiet-edit-complete.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T12:00:00.000Z',
        claimedDigests: { sha1: shaA, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', {
      id: firstUpload.id, action: 'upload', options: firstUpload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const immediately = db.getTrackedFileByPath('/my-files/quiet-edit-complete.txt');
    // Must not bind verification to post-edit BBB bytes against the finished AAA upload.
    assert.strictEqual(immediately.upload_verification_local_hash, null);
    assert.notStrictEqual(immediately.sync_state, 'conflict');
    assert.ok(
      Number(immediately.upload_reupload_pending) === 1 ||
      ['local_modified', 'pending_upload', 'uploading'].includes(immediately.sync_state),
      'quiet edit must cancel into reupload or already enqueue successor content'
    );

    await engine.pollRemote();
    const after = db.getTrackedFileByPath('/my-files/quiet-edit-complete.txt');
    assert.notStrictEqual(after.sync_state, 'conflict');
    assert.strictEqual(store.listActive().length, 0);
    assert.strictEqual(after.upload_verification_local_hash, null);
    assert.ok(['local_modified', 'pending_upload', 'uploading'].includes(after.sync_state));
  });

  it('waits on size-lag last-synced listing even without a verified remote digest', async () => {
    engine.destroy();
    const localPath = path.join(dir, 'size-lag-nodigest.txt');
    fs.writeFileSync(localPath, 'OLD');
    const shaOld = crypto.createHash('sha1').update('OLD').digest('hex');
    db.upsertTrackedFile({
      remotePath: '/my-files/size-lag-nodigest.txt', localPath, type: 'file', size: 3, localSize: 3, remoteSize: 3,
      localModified: '2026-08-04T10:00:00.000Z', remoteModified: '2026-08-04T10:00:00.000Z',
      localHash: `v2:${shaOld.slice(0, 16)}:1.000`, remoteHash: `sha1:${shaOld}`, syncState: 'synced'
    });
    db.markSynced('/my-files/size-lag-nodigest.txt');
    engine = createSyncEngine({
      syncDb: db, transferQueue: queue, conflictStore: store, localFolder: dir,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stderr: '', stdout: remoteOutput })
    });
    fs.writeFileSync(localPath, 'NEWCONTENT'); // size 10
    await engine.scanLocalTree(dir);
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    const upload = queue.items.find(item => item.options.localPaths?.includes(localPath));
    assert.ok(upload);
    const shaNew = crypto.createHash('sha1').update('NEWCONTENT').digest('hex');
    const pinDeadline = Date.now() + 2000;
    while (Date.now() < pinDeadline &&
      db.getTrackedFileByPath('/my-files/size-lag-nodigest.txt')?.upload_expected_remote_hash !== `sha1:${shaNew}`) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // Listing still shows last-synced size, no verified digest yet.
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'size-lag-nodigest.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 3, claimedModificationTime: '2026-08-04T10:00:00.000Z'
      } }
    }]);
    queue.emit('complete', {
      id: upload.id, action: 'upload', options: upload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    await engine.pollRemote();
    const lag = db.getTrackedFileByPath('/my-files/size-lag-nodigest.txt');
    assert.notStrictEqual(lag.sync_state, 'conflict');
    assert.strictEqual(store.listActive().length, 0);
    assert.strictEqual(lag.sync_state, 'uploading');
    assert.ok(lag.upload_verification_local_hash);
  });

  it('does not auto-commit an obsolete conflict resolution after upload verification fails', async () => {
    const localPath = path.join(dir, 'obsolete-resolution.txt');
    fs.writeFileSync(localPath, 'local');
    const conflict = store.detect(
      { path: localPath, modified: '2026-08-03T12:00:00Z', size: 5, type: 'file' },
      { path: '/my-files/obsolete-resolution.txt', modified: '2026-08-03T13:00:00Z', size: 6, type: 'file' },
      null
    );
    store.record(conflict);
    const result = engine.resolveConflict(conflict.id, 'keep_local');
    const upload = queue.items.at(-1);
    const mismatchedSha1 = crypto.createHash('sha1').update('other').digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'obsolete-resolution.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 5, claimedModificationTime: '2026-08-03T14:00:00Z',
        claimedDigests: { sha1: mismatchedSha1, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', {
      id: result.transferId, action: 'upload', options: upload.options,
      result: { summary: { totalSkipped: 0 } }
    });
    await engine.stop();
    const mismatchPoll = await engine.pollRemote();
    assert.strictEqual(mismatchPoll.items[0]?.hash, `sha1:${mismatchedSha1}`);
    const mismatchedRow = db.getTrackedFileByPath(conflict.remotePath);
    assert.strictEqual(mismatchedRow.sync_state, 'conflict');
    const reopenedConflicts = store.listActive().filter(item => item.remotePath === conflict.remotePath);
    assert.strictEqual(reopenedConflicts.length, 1);
    assert.strictEqual(reopenedConflicts[0].id, conflict.id);
    assert.strictEqual(reopenedConflicts[0].type, 'hash_mismatch');

    const matchingSha1 = crypto.createHash('sha1').update('local').digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'obsolete-resolution.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 5, claimedModificationTime: '2026-08-03T15:00:00Z',
        claimedDigests: { sha1: matchingSha1, sha1Verified: true }
      } }
    }]);
    await engine.runSyncCycle();
    assert.strictEqual(db.getTrackedFileByPath(conflict.remotePath).sync_state, 'conflict');
    assert.ok(store.listActive().some(item => item.id === conflict.id));
    assert.notStrictEqual(db.getTrackedFileByPath(conflict.remotePath).synced_remote_hash, `sha1:${matchingSha1}`);
  });

  it('restores transfer state when a queued transfer is cancelled', async () => {
    const localPath = path.join(dir, 'cancelled.txt');
    fs.writeFileSync(localPath, 'cancelled');
    db.upsertTrackedFile({ remotePath: '/my-files/cancelled.txt', localPath, type: 'file', syncState: 'local_new' });
    engine.setMode(SYNC_MODES.CONSERVATIVE);
    await engine.syncPending();
    const item = queue.items[0];
    queue.emit('cancelled', { id: item.id, action: item.action, options: item.options });
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
    const remoteSha1 = crypto.createHash('sha1').update('pending').digest('hex');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'pending.txt' }, type: 'file',
      activeRevision: { value: {
        claimedSize: 7, claimedModificationTime: '2026-08-03T12:00:00Z',
        claimedDigests: { sha1: remoteSha1, sha1Verified: true }
      } }
    }]);
    queue.emit('complete', { id: item.id, action: item.action, options: item.options, result: { summary: { totalSkipped: 0 } } });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && completed === 0) await new Promise(resolve => setTimeout(resolve, 10));
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
    remoteOutput = args => args.path === '/my-files'
      ? JSON.stringify([{ name: { ok: true, value: 'folder' }, type: 'folder' }])
      : '[]';
    queue.emit('complete', { id: queue.items[0].id, action: 'upload', options: queue.items[0].options, result: { summary: { totalSkipped: 0 } } });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && db.getTrackedFileByPath('/my-files/folder').sync_state !== 'synced') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.strictEqual(db.getTrackedFileByPath('/my-files/folder').sync_state, 'synced');
    assert.notStrictEqual(db.getTrackedFileByPath('/my-files/folder/child.txt').sync_state, 'synced');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/folder/child.txt').upload_verification_local_hash, null);
  });

  it('keeps a completed download pending when the expected file is missing', async () => {
    const missing = path.join(dir, 'missing.txt');
    db.upsertTrackedFile({ remotePath: '/my-files/missing.txt', localPath: missing, type: 'file', remoteSize: 7, syncState: 'remote_new' });
    engine.setMode(SYNC_MODES.BIDIRECTIONAL);
    await engine.syncPending();
    queue.emit('complete', { id: queue.items[0].id, action: 'download', options: queue.items[0].options, result: { summary: { totalSkipped: 0 } } });
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

  it('reports periodic cycle failures instead of leaving rejected timer promises unhandled', async () => {
    const completed = new Promise(resolve => engine.on('sync_scan_complete', resolve));
    engine.start(SYNC_MODES.ONE_WAY_DOWNLOAD, dir, 60000);
    await completed;

    let timerCallback;
    const realSetInterval = global.setInterval;
    global.setInterval = callback => {
      timerCallback = callback;
      return { unref() {} };
    };
    try {
      engine.setPollInterval(5000);
    } finally {
      global.setInterval = realSetInterval;
    }

    remoteError = new Error('timer failure');
    const reported = new Promise(resolve => engine.on('error', resolve));
    await timerCallback();
    const error = await reported;
    assert.match(error.message, /timer failure/);
    assert.strictEqual(error.source, 'runSyncCycle');
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

  it('rejects a restart until an overlapping stop has fully settled', async () => {
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
        if (listCalls === 1) return listGate;
        return { code: 0, stdout: '[]', stderr: '' };
      }
    });

    engine.start(SYNC_MODES.BIDIRECTIONAL, dir, 60000);
    while (listCalls === 0) await new Promise(resolve => setTimeout(resolve, 1));
    const stopping = engine.stop();
    let restartError = null;
    try { engine.start(SYNC_MODES.BIDIRECTIONAL, dir, 60000); } catch (error) { restartError = error; }
    releaseList({ code: 0, stdout: '[]', stderr: '' });
    await stopping;

    assert.match(restartError?.message || '', /stopping/i);
    assert.strictEqual(engine.getState().engineActive, false);
    engine.start(SYNC_MODES.BIDIRECTIONAL, dir, 60000);
    while (listCalls < 2) await new Promise(resolve => setTimeout(resolve, 1));
    assert.strictEqual(engine.getState().engineActive, true);
  });

  function createEngineForTree(sub, ignorePatterns) {
    engine.destroy();
    fs.mkdirSync(sub, { recursive: true });
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: store,
      localFolder: sub,
      ignorePatterns,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => {
        if (remoteError) throw remoteError;
        return { code: 0, stdout: remoteOutput, stderr: '' };
      }
    });
    return engine;
  }

  it('skips locally scanned files that match user ignore patterns', async () => {
    const sub = path.join(dir, 'tree');
    createEngineForTree(sub, ['node_modules', '*.iso', 'Videos/**']);
    fs.mkdirSync(path.join(sub, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'node_modules', 'pkg', 'index.js'), 'skip me');
    fs.writeFileSync(path.join(sub, 'image.iso'), 'skip me');
    fs.mkdirSync(path.join(sub, 'Videos', 'clips'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'Videos', 'clips', 'movie.mp4'), 'skip me');
    fs.writeFileSync(path.join(sub, 'keep.txt'), 'keep me');
    await engine.scanLocalTree(sub);
    const tracked = db.listTrackedFiles().map(item => item.remote_path).sort();
    // `Videos/**` excludes the folder's contents; the empty folder itself stays tracked.
    assert.deepEqual(tracked, ['/my-files/Videos', '/my-files/keep.txt']);
  });

  it('applies updated ignore patterns live and reports them in state', async () => {
    const sub = path.join(dir, 'tree');
    createEngineForTree(sub, []);
    fs.writeFileSync(path.join(sub, 'draft.bak'), 'ignore later');
    fs.writeFileSync(path.join(sub, 'keep.txt'), 'keep me');
    assert.deepEqual(engine.getState().ignorePatterns, []);
    engine.setIgnorePatterns(['*.bak', '', '   ', '*', '**', 'x'.repeat(300)]);
    assert.deepEqual(engine.getState().ignorePatterns, ['*.bak']);
    await engine.scanLocalTree(sub);
    const tracked = db.listTrackedFiles().map(item => item.remote_path);
    assert.deepEqual(tracked, ['/my-files/keep.txt']);
  });

  it('does not let ignore patterns with regex metacharacters escape their literal meaning', async () => {
    const sub = path.join(dir, 'tree');
    createEngineForTree(sub, ['a+b.txt']);
    fs.writeFileSync(path.join(sub, 'a+b.txt'), 'literal plus');
    fs.writeFileSync(path.join(sub, 'aab.txt'), 'keep me');
    await engine.scanLocalTree(sub);
    const tracked = db.listTrackedFiles().map(item => item.remote_path);
    assert.deepEqual(tracked, ['/my-files/aab.txt']);
  });

  it('keeps the event loop responsive while scanning a large local tree', async () => {
    const sub = path.join(dir, 'responsive-tree');
    createEngineForTree(sub, []);
    for (let index = 0; index < 300; index++) {
      fs.writeFileSync(path.join(sub, `file-${index}.txt`), String(index));
    }

    let scanComplete = false;
    const nextEventLoopTurn = new Promise(resolve => setImmediate(resolve));
    const scan = Promise.resolve(engine.scanLocalTree(sub)).then(result => {
      scanComplete = true;
      return result;
    });

    await nextEventLoopTurn;
    assert.strictEqual(scanComplete, false, 'the scan monopolized the event loop');
    const result = await scan;
    assert.strictEqual(result.count, 300);
  });

  it('keeps the event loop responsive while inspecting ignored entries', async () => {
    const sub = path.join(dir, 'responsive-ignored-tree');
    createEngineForTree(sub, []);
    for (let index = 0; index < 300; index++) {
      fs.writeFileSync(path.join(sub, `.ignored-${index}`), String(index));
    }

    let scanComplete = false;
    const nextEventLoopTurn = new Promise(resolve => setImmediate(resolve));
    const scan = Promise.resolve(engine.scanLocalTree(sub)).then(result => {
      scanComplete = true;
      return result;
    });

    await nextEventLoopTurn;
    assert.strictEqual(scanComplete, false, 'ignored entries monopolized the event loop');
    const result = await scan;
    assert.strictEqual(result.count, 0);
  });

  it('keeps the event loop responsive while filtering out-of-scope tracked rows', async () => {
    const sub = path.join(dir, 'responsive-out-of-scope-rows');
    createEngineForTree(sub, []);
    for (let index = 0; index < 300; index++) {
      db.upsertTrackedFile({
        remotePath: `/outside-${index}`,
        localPath: path.join(dir, '..', `outside-${index}`),
        type: 'file',
        size: 1,
        syncState: 'synced'
      });
    }

    let scanComplete = false;
    const scan = engine.scanLocalTree(sub).then(result => {
      scanComplete = true;
      return result;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(scanComplete, false, 'out-of-scope tracked rows monopolized the event loop');
    await scan;
  });

  it('runs only one initial local scan when sync starts', async () => {
    const sub = path.join(dir, 'single-start-scan');
    createEngineForTree(sub, []);
    for (let index = 0; index < 150; index++) {
      fs.writeFileSync(path.join(sub, `file-${index}.txt`), String(index));
    }

    let localScans = 0;
    engine.on('local_scan', () => { localScans += 1; });
    const cycleComplete = new Promise(resolve => engine.on('sync_scan_complete', resolve));
    engine.start(SYNC_MODES.CONSERVATIVE, sub, 60000);
    await cycleComplete;

    assert.strictEqual(localScans, 1, 'sync startup scanned the same tree more than once');
  });

  it('summarizes a bulk scan without flooding the renderer with per-item changes', async () => {
    const sub = path.join(dir, 'bulk-events');
    createEngineForTree(sub, []);
    fs.writeFileSync(path.join(sub, 'one.txt'), 'one');
    fs.writeFileSync(path.join(sub, 'two.txt'), 'two');

    let localChanges = 0;
    let localScans = 0;
    engine.on('local_change', () => { localChanges += 1; });
    engine.on('local_scan', () => { localScans += 1; });
    await engine.scanLocalTree(sub);

    assert.strictEqual(localChanges, 0, 'bulk scan emitted one IPC event per item');
    assert.strictEqual(localScans, 1);
  });

  it('does not rewrite unchanged metadata during every periodic scan', async () => {
    const sub = path.join(dir, 'unchanged-metadata');
    createEngineForTree(sub, []);
    fs.writeFileSync(path.join(sub, 'stable.txt'), 'stable');

    await engine.scanLocalTree(sub);
    const before = db.getTrackedFileByPath('/my-files/stable.txt');
    await engine.scanLocalTree(sub);
    const after = db.getTrackedFileByPath('/my-files/stable.txt');

    assert.strictEqual(after.sync_version, before.sync_version, 'unchanged files were rewritten');
    assert.strictEqual(after.updated_at, before.updated_at, 'unchanged timestamp was refreshed');
  });

  it('detects same-size same-mtime content replacements', async () => {
    const sub = path.join(dir, 'same-metadata-change');
    createEngineForTree(sub, []);
    const file = path.join(sub, 'same.txt');
    fs.writeFileSync(file, 'first');
    const originalMtime = fs.statSync(file).mtime;
    await engine.scanLocalTree(sub);
    db.markSynced('/my-files/same.txt');

    fs.writeFileSync(file, 'other');
    fs.utimesSync(file, originalMtime, originalMtime);
    await engine.scanLocalTree(sub);

    assert.strictEqual(db.getTrackedFileByPath('/my-files/same.txt').sync_state, 'local_modified');
  });

  it('detects same-size same-mtime edits outside the first 64 KiB', async () => {
    const sub = path.join(dir, 'tail-change');
    createEngineForTree(sub, []);
    const file = path.join(sub, 'large.txt');
    fs.writeFileSync(file, Buffer.alloc(70 * 1024, 0x61));
    const originalMtime = fs.statSync(file).mtime;
    await engine.scanLocalTree(sub);
    db.markSynced('/my-files/large.txt');

    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.from('z'), 0, 1, 68 * 1024);
    fs.closeSync(fd);
    fs.utimesSync(file, originalMtime, originalMtime);
    await engine.scanLocalTree(sub);

    assert.strictEqual(db.getTrackedFileByPath('/my-files/large.txt').sync_state, 'local_modified');
  });

  it('detects same-size same-mtime edits in files larger than 100 MiB', async () => {
    const sub = path.join(dir, 'very-large-change');
    createEngineForTree(sub, []);
    const file = path.join(sub, 'large.bin');
    fs.writeFileSync(file, 'start');
    fs.truncateSync(file, 101 * 1024 * 1024);
    const originalMtime = fs.statSync(file).mtime;
    await engine.scanLocalTree(sub);
    db.markSynced('/my-files/large.bin');
    assert.match(db.getTrackedFileByPath('/my-files/large.bin').local_hash, /^v2:/);

    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.from('z'), 0, 1, 100 * 1024 * 1024);
    fs.closeSync(fd);
    fs.utimesSync(file, originalMtime, originalMtime);
    await engine.scanLocalTree(sub);

    assert.strictEqual(db.getTrackedFileByPath('/my-files/large.bin').sync_state, 'local_modified');
  });

  it('records a conflict for a hash-only local edit while the remote side is modified', async () => {
    const sub = path.join(dir, 'hash-conflict');
    createEngineForTree(sub, []);
    const file = path.join(sub, 'concurrent.txt');
    fs.writeFileSync(file, 'first');
    const originalMtime = fs.statSync(file).mtime;
    await engine.scanLocalTree(sub);
    const syncedLocalHash = db.getTrackedFileByPath('/my-files/concurrent.txt').local_hash;
    db.upsertTrackedFile({
      remotePath: '/my-files/concurrent.txt',
      remoteModified: '2026-08-03T10:00:00.000Z',
      remoteSize: 5,
      remoteHash: 'sha1:1111111111111111111111111111111111111111'
    });
    db.markSynced('/my-files/concurrent.txt');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'concurrent.txt' },
      type: 'file',
      activeRevision: { value: {
        claimedSize: 5,
        claimedModificationTime: '2026-08-03T10:00:00.000Z',
        claimedDigests: { sha1: '2222222222222222222222222222222222222222', sha1Verified: true }
      } }
    }]);
    await engine.pollRemote();
    assert.strictEqual(db.getTrackedFileByPath('/my-files/concurrent.txt').sync_state, 'remote_modified');

    fs.writeFileSync(file, 'other');
    fs.utimesSync(file, originalMtime, originalMtime);
    await engine.scanLocalTree(sub);

    const conflicted = db.getTrackedFileByPath('/my-files/concurrent.txt');
    assert.strictEqual(conflicted.sync_state, 'conflict');
    assert.notStrictEqual(conflicted.local_hash, syncedLocalHash);
    assert.strictEqual(conflicted.remote_hash, 'sha1:2222222222222222222222222222222222222222');
    assert.strictEqual(store.listActive().length, 1);
  });

  it('records the same hash-only conflict when the local edit is observed first', async () => {
    const sub = path.join(dir, 'hash-conflict-local-first');
    createEngineForTree(sub, []);
    const file = path.join(sub, 'concurrent.txt');
    fs.writeFileSync(file, 'first');
    const originalMtime = fs.statSync(file).mtime;
    await engine.scanLocalTree(sub);
    const syncedLocalHash = db.getTrackedFileByPath('/my-files/concurrent.txt').local_hash;
    db.upsertTrackedFile({
      remotePath: '/my-files/concurrent.txt',
      remoteModified: '2026-08-03T10:00:00.000Z',
      remoteSize: 5,
      remoteHash: 'sha1:1111111111111111111111111111111111111111'
    });
    db.markSynced('/my-files/concurrent.txt');

    fs.writeFileSync(file, 'other');
    fs.utimesSync(file, originalMtime, originalMtime);
    await engine.scanLocalTree(sub);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/concurrent.txt').sync_state, 'local_modified');

    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'concurrent.txt' },
      type: 'file',
      activeRevision: { value: {
        claimedSize: 5,
        claimedModificationTime: '2026-08-03T10:00:00.000Z',
        claimedDigests: { sha1: '2222222222222222222222222222222222222222', sha1Verified: true }
      } }
    }]);
    await engine.pollRemote();

    const conflicted = db.getTrackedFileByPath('/my-files/concurrent.txt');
    assert.strictEqual(conflicted.sync_state, 'conflict');
    assert.notStrictEqual(conflicted.local_hash, syncedLocalHash);
    assert.strictEqual(conflicted.remote_hash, 'sha1:2222222222222222222222222222222222222222');
    assert.strictEqual(store.listActive().length, 1);
  });

  it('keeps a real v4 unknown remote hash conservative in remote-first order', async () => {
    const sub = path.join(dir, 'legacy-remote-first');
    createEngineForTree(sub, []);
    const file = path.join(sub, 'legacy.txt');
    fs.writeFileSync(file, 'AAAAAA');
    const originalMtime = new Date('2026-08-03T09:00:00.000Z');
    fs.utimesSync(file, originalMtime, originalMtime);
    await engine.scanLocalTree(sub);
    db.upsertTrackedFile({
      remotePath: '/my-files/legacy.txt',
      remoteSize: 6,
      remoteModified: '2026-08-03T10:00:00.000Z',
      remoteHash: null
    });
    db.markSynced('/my-files/legacy.txt');

    engine.destroy();
    db.close();
    const raw = new Database(path.join(dir, 'sync.db'));
    raw.exec('ALTER TABLE tracked_files DROP COLUMN synced_local_hash');
    raw.exec('ALTER TABLE tracked_files DROP COLUMN synced_remote_hash');
    raw.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run();
    raw.close();

    db = createSyncDb(path.join(dir, 'sync.db'));
    store = createConflictStore(db);
    createEngineForTree(sub, []);
    const migrated = db.getTrackedFileByPath('/my-files/legacy.txt');
    assert.strictEqual(migrated.synced_remote_hash, 'legacy:unknown');
    remoteOutput = JSON.stringify([{
      name: { ok: true, value: 'legacy.txt' },
      type: 'file',
      size: 6,
      modificationTime: '2026-08-03T10:00:00.000Z',
      activeRevision: { value: {
        claimedSize: 6,
        claimedModificationTime: '2026-08-03T10:00:00.000Z',
        claimedDigests: { sha1: '2222222222222222222222222222222222222222', sha1Verified: true }
      } }
    }]);

    await engine.pollRemote();
    const afterRemote = db.getTrackedFileByPath('/my-files/legacy.txt');
    assert.strictEqual(afterRemote.sync_state, 'remote_modified', 'unknown remote baseline was silently blessed');
    fs.writeFileSync(file, 'BBBBBB');
    fs.utimesSync(file, originalMtime, originalMtime);
    await engine.scanLocalTree(sub);
    const result = await engine.syncPending();
    assert.strictEqual(db.getTrackedFileByPath('/my-files/legacy.txt').sync_state, 'conflict');
    assert.strictEqual(store.listActive().length, 1);
    assert.strictEqual(result.queued, 0);
    assert.strictEqual(queue.items.length, 0);
  });

  it('does not bless unsampled edits while migrating legacy fingerprints', async () => {
    const sub = path.join(dir, 'legacy-fingerprint-conflict');
    createEngineForTree(sub, []);
    const file = path.join(sub, 'legacy.bin');
    fs.writeFileSync(file, Buffer.alloc(70 * 1024, 0x61));
    const originalMtime = fs.statSync(file).mtime;
    await engine.scanLocalTree(sub);
    const initial = db.getTrackedFileByPath('/my-files/legacy.bin');
    const legacyHash = initial.local_hash.split(':')[1];
    db.upsertTrackedFile({
      remotePath: '/my-files/legacy.bin',
      localHash: legacyHash,
      remoteModified: '2026-08-03T09:00:00.000Z',
      remoteSize: 70 * 1024,
      remoteHash: 'remote-v1'
    });
    db.markSynced('/my-files/legacy.bin');

    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.from('z'), 0, 1, 68 * 1024);
    fs.closeSync(fd);
    fs.utimesSync(file, originalMtime, originalMtime);
    db.upsertTrackedFile({
      remotePath: '/my-files/legacy.bin',
      remoteModified: '2026-08-03T10:00:00.000Z',
      remoteSize: 70 * 1024,
      syncState: 'remote_modified'
    });

    await engine.scanLocalTree(sub);
    const migrated = db.getTrackedFileByPath('/my-files/legacy.bin');
    assert.strictEqual(migrated.sync_state, 'conflict');
    assert.strictEqual(migrated.synced_local_hash, legacyHash, 'legacy baseline was silently rewritten');
    assert.match(migrated.local_hash, /^v2:/);
  });

  it('treats a missing legacy hash as unknown instead of blessing a large-file edit', async () => {
    const sub = path.join(dir, 'legacy-large-conflict');
    createEngineForTree(sub, []);
    const file = path.join(sub, 'legacy-large.bin');
    fs.writeFileSync(file, 'start');
    fs.truncateSync(file, 101 * 1024 * 1024);
    const originalStat = fs.statSync(file);
    const originalMtime = originalStat.mtime;
    db.upsertTrackedFile({
      remotePath: '/my-files/legacy-large.bin',
      localPath: file,
      type: 'file',
      size: originalStat.size,
      localSize: originalStat.size,
      localModified: originalStat.mtime.toISOString(),
      localHash: null,
      remoteModified: '2026-08-03T09:00:00.000Z',
      remoteSize: 101 * 1024 * 1024,
      remoteHash: 'remote-v1',
      syncState: 'synced'
    });
    db.markSynced('/my-files/legacy-large.bin');

    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.from('z'), 0, 1, 100 * 1024 * 1024);
    fs.closeSync(fd);
    fs.utimesSync(file, originalMtime, originalMtime);
    db.upsertTrackedFile({
      remotePath: '/my-files/legacy-large.bin',
      remoteModified: '2026-08-03T10:00:00.000Z',
      remoteSize: 101 * 1024 * 1024,
      syncState: 'remote_modified'
    });

    await engine.scanLocalTree(sub);
    const migrated = db.getTrackedFileByPath('/my-files/legacy-large.bin');
    assert.strictEqual(migrated.sync_state, 'conflict');
    assert.strictEqual(migrated.synced_local_hash, 'legacy:unknown');
  });

  it('summarizes bulk scan deletions without per-item renderer events', async () => {
    const sub = path.join(dir, 'bulk-delete-events');
    createEngineForTree(sub, []);
    const file = path.join(sub, 'removed.txt');
    fs.writeFileSync(file, 'remove me');
    await engine.scanLocalTree(sub);
    db.markSynced('/my-files/removed.txt');

    let localChanges = 0;
    engine.on('local_change', () => { localChanges += 1; });
    fs.rmSync(file);
    await engine.scanLocalTree(sub);

    assert.strictEqual(localChanges, 0, 'bulk deletion emitted one IPC event per item');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/removed.txt').sync_state, 'local_deleted');
  });

  it('keeps the event loop responsive and summarizes a large remote listing', async () => {
    const sub = path.join(dir, 'responsive-remote');
    createEngineForTree(sub, []);
    remoteOutput = JSON.stringify(Array.from({ length: 300 }, (_, index) => ({
      name: { ok: true, value: `remote-${index}.txt` },
      type: 'file',
      size: index + 1,
      modificationTime: '2026-08-03T10:00:00.000Z'
    })));

    const remoteChanges = [];
    let pollComplete = false;
    engine.on('remote_change', payload => remoteChanges.push(payload));
    const poll = engine.pollRemote().then(result => {
      pollComplete = true;
      return result;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(pollComplete, false, 'remote listing monopolized the event loop');
    const result = await poll;
    assert.strictEqual(result.items.length, 300);
    assert.strictEqual(remoteChanges.length, 1, 'bulk remote poll flooded listeners with per-item events');
    assert.strictEqual(remoteChanges[0].type, 'scan_summary');
    assert.deepStrictEqual(remoteChanges[0].counts, { created: 300, modified: 0, deleted: 0 });
  });

  it('accepts authoritative remote snapshots larger than ten thousand items', async () => {
    const sub = path.join(dir, 'large-remote-snapshot');
    createEngineForTree(sub, []);
    const itemCount = 10_001;
    remoteOutput = JSON.stringify(Array.from({ length: itemCount }, (_, index) => ({
      name: { ok: true, value: `remote-${index}.txt` },
      type: 'file',
      size: index + 1,
      modificationTime: '2026-08-03T10:00:00.000Z'
    })));

    const result = await engine.pollRemote();
    assert.strictEqual(result.authoritative, true);
    assert.strictEqual(result.items.length, itemCount);
    assert.strictEqual(db.listTrackedFiles().length, itemCount);
  });

  it('cancels local scan processing promptly when sync is stopped', async () => {
    const sub = path.join(dir, 'cancel-local-scan');
    createEngineForTree(sub, []);
    for (let index = 0; index < 300; index++) {
      fs.writeFileSync(path.join(sub, `file-${index}.txt`), String(index));
    }

    let completedScans = 0;
    engine.on('local_scan', () => { completedScans += 1; });
    engine.start(SYNC_MODES.CONSERVATIVE, sub, 60000);
    await engine.stop();

    assert.strictEqual(completedScans, 0, 'stopped local scan still reported completion');
    assert.ok(db.listTrackedFiles().length < 300, 'stopped local scan processed the entire tree');
  });

  it('cancels remote result processing promptly when sync is stopped', async () => {
    const sub = path.join(dir, 'cancel-remote-processing');
    createEngineForTree(sub, []);
    remoteOutput = JSON.stringify(Array.from({ length: 300 }, (_, index) => ({
      name: { ok: true, value: `remote-${index}.txt` },
      type: 'file',
      size: index + 1,
      modificationTime: '2026-08-03T10:00:00.000Z'
    })));

    let remotePolls = 0;
    engine.on('remote_poll', () => { remotePolls += 1; });
    engine.start(SYNC_MODES.ONE_WAY_DOWNLOAD, sub, 60000);
    await new Promise(resolve => setImmediate(resolve));
    await engine.stop();

    assert.strictEqual(remotePolls, 0, 'stopped remote poll still reported completion');
    assert.ok(db.listTrackedFiles().length < 300, 'stopped remote poll persisted the entire listing');
  });
});
