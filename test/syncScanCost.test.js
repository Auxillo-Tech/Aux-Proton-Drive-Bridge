const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { createSyncDb } = require('../src/main/syncDb');
const { createConflictStore } = require('../src/main/conflictStore');
const { createSyncEngine } = require('../src/main/syncEngine');

// The fingerprint the scan has always stored: SHA-256 of the first 64 KB plus the size, then
// the change time. Written out here so the tests do not depend on the engine's own helper.
function referenceFingerprint(file) {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let filled = 0;
    while (filled < buffer.length) {
      const n = fs.readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (!n) break;
      filled += n;
    }
    const hash = crypto.createHash('sha256');
    hash.update(buffer.subarray(0, filled));
    hash.update(String(stat.size));
    return `v2:${hash.digest('hex')}:${Number(stat.ctimeMs).toFixed(3)}`;
  } finally {
    fs.closeSync(fd);
  }
}

function waitTick(ms = 25) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe('syncEngine - transfer events and remote poll cost', () => {
  let dir;
  let root;
  let db;
  let queue;
  let engine;

  function makeEngine(extra = {}) {
    const emitter = new EventEmitter();
    queue = {
      items: [],
      enqueue(action, options, priority) {
        const id = `tx-${this.items.length + 1}`;
        this.items.push({ id, action, options, priority });
        return id;
      },
      getState() { return { active: [], pending: this.items.map(({ id }) => ({ id })), recentCompleted: [] }; },
      on(event, handler) { emitter.on(event, handler); return () => emitter.off(event, handler); },
      emit(event, payload) { emitter.emit(event, payload); }
    };
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: createConflictStore(db),
      localFolder: root,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stdout: '[]', stderr: '' }),
      ...extra
    });
    return engine;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-cost-'));
    root = path.join(dir, 'tree');
    fs.mkdirSync(root);
    db = createSyncDb(path.join(dir, 'sync.db'));
  });

  afterEach(async () => {
    await engine?.stop();
    engine?.destroy?.();
    db.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeTree() {
    fs.mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(root, 'empty.txt'), '');
    fs.writeFileSync(path.join(root, 'small.txt'), 'hello');
    fs.writeFileSync(path.join(root, 'sub', 'big.bin'), crypto.randomBytes(200 * 1024));
    fs.writeFileSync(path.join(root, 'sub', 'exact.bin'), crypto.randomBytes(64 * 1024));
    fs.writeFileSync(path.join(root, 'sub', 'deeper', 'name with space.txt'), 'spaced');
    for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(root, `bulk-${i}.txt`), `content ${i}`);
  }

  function rows() {
    return db.listTrackedFiles().map(row => ({
      remote: row.remote_path, local: row.local_path, type: row.type, size: row.local_size,
      modified: row.local_modified, hash: row.local_hash, state: row.sync_state
    }));
  }

  it('stores the same fingerprint for every file as the synchronous reference', async () => {
    writeTree();
    makeEngine();
    await engine.scanLocalTree(root);
    const files = rows().filter(row => row.type === 'file');
    assert.strictEqual(files.length, 155);
    for (const row of files) assert.strictEqual(row.hash, referenceFingerprint(row.local), row.local);
    assert.strictEqual(rows().filter(row => row.type === 'folder').every(row => row.hash === null), true);
  });

  it('gives an identical sync result when the same tree is scanned twice', async () => {
    writeTree();
    makeEngine();
    await engine.scanLocalTree(root);
    const first = rows();
    await engine.scanLocalTree(root);
    const second = rows();
    assert.deepStrictEqual(second, first);
    assert.strictEqual(first.every(row => row.state === 'local_new'), true);
  });

  it('still sees an edit that keeps the size and restores the modification time', async () => {
    const file = path.join(root, 'edited.txt');
    fs.writeFileSync(file, 'aaaa');
    makeEngine();
    await engine.scanLocalTree(root);
    const remotePath = '/my-files/edited.txt';
    db.markSynced(remotePath);
    assert.strictEqual(db.getTrackedFileByPath(remotePath).sync_state, 'synced');
    const mtime = fs.statSync(file).mtime;
    waitTick();
    fs.writeFileSync(file, 'bbbb');
    fs.utimesSync(file, mtime, mtime);
    await engine.scanLocalTree(root);
    assert.strictEqual(db.getTrackedFileByPath(remotePath).sync_state, 'local_modified');
  });

  it('does not read the whole table when a transfer finishes, fails or is skipped', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(root, name), name);
    for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(root, `other-${i}.txt`), String(i));
    makeEngine();
    await engine.stop();
    const result = await engine.scanNow();
    assert.ok(result.queued >= 3);
    const upload = name => queue.items.find(item => item.options.localPaths?.includes(path.join(root, name)));
    const [a, b, c] = [upload('a.txt'), upload('b.txt'), upload('c.txt')];
    assert.ok(a && b && c);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/a.txt').sync_state, 'uploading');

    const statesBefore = Object.fromEntries(db.listTrackedFiles().map(row => [row.remote_path, row.sync_state]));
    const realList = db.listTrackedFiles;
    let wholeTableReads = 0;
    db.listTrackedFiles = (...args) => {
      if (args[0] == null && args[1] == null) wholeTableReads++;
      return realList(...args);
    };
    try {
      queue.emit('error', { id: a.id, action: 'upload', options: a.options, error: 'network timeout' });
      queue.emit('skipped', { id: b.id, action: 'upload', options: b.options, result: { summary: { totalSkipped: 1 } } });
      queue.emit('complete', { id: c.id, action: 'upload', options: c.options, result: { summary: { totalSkipped: 0 } } });
    } finally {
      db.listTrackedFiles = realList;
    }
    assert.strictEqual(wholeTableReads, 0, 'a transfer event read every tracked row');
    // Only the rows the events were about changed.
    assert.strictEqual(db.getTrackedFileByPath('/my-files/a.txt').sync_state, 'pending_upload');
    // A skipped transfer is put back and then recorded as a conflict, as before.
    assert.strictEqual(db.getTrackedFileByPath('/my-files/b.txt').sync_state, 'conflict');
    for (const row of db.listTrackedFiles()) {
      if (["/my-files/a.txt", "/my-files/b.txt", "/my-files/c.txt"].includes(row.remote_path)) continue;
      assert.strictEqual(row.sync_state, statesBefore[row.remote_path], row.remote_path);
    }
  });

  describe('remote poll hashing', () => {
    it('does not open local files for rows that are already synced', async () => {
      const remoteModified = '2026-08-04T12:00:00.000Z';
      const listing = [];
      for (let i = 0; i < 60; i++) {
        const name = `p-${i}.txt`;
        const file = path.join(root, name);
        fs.writeFileSync(file, `poll ${i}`);
        const stat = fs.statSync(file);
        db.upsertTrackedFile({
          remotePath: `/my-files/${name}`, localPath: file, type: 'file', size: stat.size, localSize: stat.size,
          remoteSize: stat.size, localModified: stat.mtime.toISOString(), remoteModified, syncState: 'synced'
        });
        listing.push({
          name: { ok: true, value: name }, type: 'file',
          activeRevision: { value: { claimedSize: stat.size, claimedModificationTime: remoteModified } }
        });
      }
      makeEngine({ runProton: async () => ({ code: 0, stdout: JSON.stringify(listing), stderr: '' }) });
      const opened = [];
      const realOpenSync = fs.openSync;
      fs.openSync = (...args) => { opened.push(args[0]); return realOpenSync.apply(fs, args); };
      try {
        const result = await engine.pollRemote();
        assert.strictEqual(result.authoritative, true);
        assert.strictEqual(result.items.length, 60);
      } finally {
        fs.openSync = realOpenSync;
      }
      assert.deepStrictEqual(opened.filter(p => String(p).startsWith(root)), [], 'a synced row caused a local read');
      for (const row of db.listTrackedFiles()) assert.strictEqual(row.sync_state, 'synced', row.remote_path);
    });

    it('does not open local files for synced rows that vanished from the remote listing', async () => {
      for (let i = 0; i < 60; i++) {
        const name = `gone-${i}.txt`;
        const file = path.join(root, name);
        fs.writeFileSync(file, `gone ${i}`);
        const stat = fs.statSync(file);
        db.upsertTrackedFile({
          remotePath: `/my-files/${name}`, localPath: file, type: 'file', size: stat.size, localSize: stat.size,
          remoteSize: stat.size, localModified: stat.mtime.toISOString(),
          remoteModified: '2026-08-04T12:00:00.000Z', syncState: 'synced'
        });
      }
      makeEngine({ runProton: async () => ({ code: 0, stdout: JSON.stringify([]), stderr: '' }) });
      const opened = [];
      const realOpenSync = fs.openSync;
      fs.openSync = (...args) => { opened.push(args[0]); return realOpenSync.apply(fs, args); };
      try {
        const result = await engine.pollRemote();
        assert.strictEqual(result.authoritative, true);
      } finally {
        fs.openSync = realOpenSync;
      }
      assert.deepStrictEqual(opened.filter(p => String(p).startsWith(root)), [], 'a remote deletion caused a local read');
      for (const row of db.listTrackedFiles()) assert.strictEqual(row.sync_state, 'remote_deleted', row.remote_path);
    });
  });
});
