const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const { createSyncDb } = require('../src/main/syncDb');
const { createConflictStore } = require('../src/main/conflictStore');
const { createSyncEngine, SYNC_MODES } = require('../src/main/syncEngine');
const { createTransferQueue } = require('../src/main/transferQueue');

// The CLI uploads a folder with everything in it. A new folder must therefore never be handed over
// whole when something inside it is excluded (dotfile, exclude pattern, symlink), or the exclusion
// rules are bypassed for every file inside the folder.
describe('syncEngine - a new folder honours exclusions and the dotfile policy', () => {
  let dir;
  let db;
  let queue;
  let engine;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-upload-'));
    db = createSyncDb(path.join(dir, 'sync.db'));
    const emitter = new EventEmitter();
    queue = {
      items: [],
      outstanding: new Set(),
      /** Directory listing of every uploaded path at the moment it was queued. */
      seen: [],
      /** Checks the engine registers for transfers flagged with options.preflight. */
      hooks: new Map(),
      registerPreflight(name, check) {
        this.hooks.set(name, check);
        return () => { if (this.hooks.get(name) === check) this.hooks.delete(name); };
      },
      enqueue(action, options, priority) {
        const id = `tx-${this.items.length + 1}`;
        this.items.push({ id, action, options, priority });
        this.outstanding.add(id);
        if (action === 'upload') {
          this.seen.push(options.localPaths.map(p => {
            const stat = fs.lstatSync(p);
            return { path: p, tree: stat.isDirectory() ? listTree(p) : null };
          }));
        }
        return id;
      },
      getState() {
        return { active: [], pending: [...this.outstanding].map(id => ({ id })), recentCompleted: [] };
      },
      on(event, handler) {
        emitter.on(event, handler);
        return () => emitter.off(event, handler);
      },
      emit(event, payload) {
        if (['complete', 'error', 'cancelled', 'skipped'].includes(event)) this.outstanding.delete(payload.id);
        emitter.emit(event, payload);
      }
    };
    engine = createSyncEngine({
      syncDb: db,
      transferQueue: queue,
      conflictStore: createConflictStore(db),
      localFolder: dir,
      // These tests write a folder and sync it at once; the settle window has its own tests below.
      folderSettleMs: 0,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stdout: '[]', stderr: '' })
    });
  });

  afterEach(async () => {
    await engine.stop();
    engine.destroy();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function listTree(root) {
    const out = [];
    (function walk(current) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        out.push(path.relative(root, full));
        if (entry.isDirectory()) walk(full);
      }
    })(root);
    return out.sort();
  }

  // A real scan tracks only what the rules allow, like the app does, then queues the batch.
  async function scanAndQueue() {
    engine.setMode(SYNC_MODES.ONE_WAY_UPLOAD);
    await engine.runSyncCycle();
  }

  function uploadedTrees() {
    return queue.seen.flat();
  }

  it('does not hand a folder holding a dotfile and an excluded file to the CLI whole', async () => {
    engine.setIgnorePatterns(['*.iso']);
    const folder = path.join(dir, 'Photos');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(folder, '.secret'), 'private');
    fs.writeFileSync(path.join(folder, 'disk.iso'), 'big');
    await scanAndQueue();

    const folderUploads = uploadedTrees().filter(u => u.tree !== null);
    assert.ok(folderUploads.length >= 1, 'the new folder is still created remotely');
    for (const upload of folderUploads) {
      assert.notStrictEqual(upload.path, folder, 'the real folder must not be uploaded whole');
      assert.deepStrictEqual(upload.tree, [], 'the stand-in holds no files');
      assert.strictEqual(path.basename(upload.path), 'Photos');
    }
    assert.strictEqual(db.getTrackedFileByPath('/my-files/Photos/.secret'), null);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/Photos/disk.iso'), null);
  });

  it('keeps the excluded files out in every upload that follows', async () => {
    engine.setIgnorePatterns(['*.iso']);
    const folder = path.join(dir, 'Photos');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(folder, '.secret'), 'private');
    fs.writeFileSync(path.join(folder, 'disk.iso'), 'big');
    await scanAndQueue();
    const first = queue.items[0];
    queue.emit('complete', { id: first.id, action: 'upload', options: first.options, result: { summary: { totalSkipped: 0 } } });
    for (let round = 0; round < 3; round++) {
      await engine.syncPending();
      for (const item of queue.items.filter(i => queue.outstanding.has(i.id))) {
        queue.emit('complete', { id: item.id, action: 'upload', options: item.options, result: { summary: { totalSkipped: 0 } } });
      }
    }
    assert.ok(!queue.items.some(i => i.options.localPaths.includes(folder)), 'the real folder is never uploaded whole');
    const uploadedNames = queue.items.flatMap(i => i.options.localPaths).map(p => path.basename(p));
    assert.ok(uploadedNames.includes('keep.txt'), 'the allowed file is uploaded on its own');
    assert.ok(!uploadedNames.includes('.secret'));
    assert.ok(!uploadedNames.includes('disk.iso'));
  });

  it('applies the same rule to a nested folder with a dotfile deep inside', async () => {
    const top = path.join(dir, 'Top');
    const deep = path.join(top, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(top, 'one.txt'), '1');
    fs.writeFileSync(path.join(deep, '.env'), 'TOKEN=x');
    fs.writeFileSync(path.join(deep, 'two.txt'), '2');
    await scanAndQueue();

    for (const upload of uploadedTrees().filter(u => u.tree !== null)) {
      assert.notStrictEqual(upload.path, top);
      assert.ok(!upload.tree.some(name => name.split(path.sep).some(part => part.startsWith('.'))),
        `a dotfile reached an uploaded folder: ${upload.tree.join(', ')}`);
    }
    assert.ok(!queue.items.some(i => i.options.localPaths.some(p => path.basename(p) === '.env')));
  });

  it('does not hand over a folder that contains a symlink', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-upload-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'private.txt'), 'private');
      const folder = path.join(dir, 'Linked');
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'ok.txt'), 'ok');
      fs.symlinkSync(outside, path.join(folder, 'escape'));
      await scanAndQueue();
      for (const upload of uploadedTrees().filter(u => u.tree !== null)) {
        assert.notStrictEqual(upload.path, folder);
        assert.ok(!upload.tree.some(name => name.startsWith('escape')), 'the symlink target must not be uploaded');
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('still hands a clean folder to the CLI whole, in one transfer', async () => {
    const folder = path.join(dir, 'Clean');
    fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
    fs.writeFileSync(path.join(folder, 'sub', 'b.txt'), 'b');
    db.upsertTrackedFile({ remotePath: '/my-files/Clean', localPath: folder, type: 'folder', syncState: 'local_new' });
    engine.setMode(SYNC_MODES.ONE_WAY_UPLOAD);
    await engine.syncPending();
    assert.deepStrictEqual(queue.items[0].options.localPaths, [folder]);
    assert.strictEqual(queue.items[0].options.trackedLocalPaths, undefined);
    // Only a plain name travels in the options; the check itself lives in the queue.
    assert.strictEqual(queue.items[0].options.preflight, 'sync-folder-upload');
    assert.ok(queue.hooks.has('sync-folder-upload'));
  });

  it('uses the stand-in when the queue cannot re-check the folder just before the CLI runs', async () => {
    const folder = path.join(dir, 'NoCheck');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
    delete queue.registerPreflight;
    await engine.stop();
    engine.destroy();
    engine = createSyncEngine({
      syncDb: db, transferQueue: queue, conflictStore: createConflictStore(db), localFolder: dir, folderSettleMs: 0,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stdout: '[]', stderr: '' })
    });
    db.upsertTrackedFile({ remotePath: '/my-files/NoCheck', localPath: folder, type: 'folder', syncState: 'local_new' });
    engine.setMode(SYNC_MODES.ONE_WAY_UPLOAD);
    await engine.syncPending();
    assert.notStrictEqual(queue.items[0].options.localPaths[0], folder);
    assert.deepStrictEqual(queue.seen[0][0].tree, []);
  });

  // The queue's check runs when the row is queued; the CLI runs later. A folder whose own path
  // became a symlink, or a file swapped for a link, must not reach the CLI in between or after.
  it('never queues a pending folder row whose path became a symlink to a folder outside the root (R2)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-upload-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'id_ed25519'), 'PRIVATE KEY OUTSIDE ROOT');
      const pics = path.join(dir, 'Pics');
      fs.mkdirSync(pics);
      fs.writeFileSync(path.join(pics, 'p.jpg'), 'p');
      await scanAndQueue();
      const first = queue.items[0];
      queue.emit('error', { id: first.id, action: 'upload', options: first.options, error: 'network timeout' });
      assert.strictEqual(db.getTrackedFileByPath('/my-files/Pics').sync_state, 'pending_upload');

      fs.rmSync(pics, { recursive: true });
      fs.symlinkSync(outside, pics);
      const before = queue.items.length;
      // syncPending itself: a full cycle can be deferred (the database sits in this root).
      await engine.syncPending();
      const later = queue.seen.slice(before).flat();
      assert.ok(!later.some(u => u.path === pics), 'the symlink must not be handed to the CLI');
      assert.ok(!later.some(u => Array.isArray(u.tree) && u.tree.includes('id_ed25519')), 'nothing from outside the root');
      assert.strictEqual(db.getTrackedFileByPath('/my-files/Pics').sync_state, 'ignored');
      const events = db.getEvents(db.getTrackedFileByPath('/my-files/Pics').id);
      assert.ok(events.some(e => JSON.stringify(e.detail).includes('upload_refused_symlink')), 'the refusal is logged');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never queues a pending file row whose path became a symlink to a file outside the root (R2b)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-upload-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'id_ed25519'), 'PRIVATE KEY OUTSIDE ROOT');
      const notes = path.join(dir, 'notes.txt');
      fs.writeFileSync(notes, 'n');
      await scanAndQueue();
      const first = queue.items[0];
      queue.emit('error', { id: first.id, action: 'upload', options: first.options, error: 'network timeout' });
      fs.rmSync(notes);
      fs.symlinkSync(path.join(outside, 'id_ed25519'), notes);
      const before = queue.items.length;
      await engine.syncPending();
      assert.ok(!queue.items.slice(before).some(i => i.options.localPaths.includes(notes)));
      assert.strictEqual(db.getTrackedFileByPath('/my-files/notes.txt').sync_state, 'ignored');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never queues a file row below a folder that became a symlink to a folder outside the root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-upload-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'a.txt'), 'OUTSIDE');
      const dirPath = path.join(dir, 'Docs');
      fs.mkdirSync(dirPath);
      fs.writeFileSync(path.join(dirPath, 'a.txt'), 'inside');
      db.upsertTrackedFile({ remotePath: '/my-files/Docs/a.txt', localPath: path.join(dirPath, 'a.txt'), type: 'file', syncState: 'pending_upload' });
      fs.rmSync(dirPath, { recursive: true });
      fs.symlinkSync(outside, dirPath);
      engine.setMode(SYNC_MODES.ONE_WAY_UPLOAD);
      await engine.syncPending();
      assert.strictEqual(queue.items.length, 0);
      assert.strictEqual(db.getTrackedFileByPath('/my-files/Docs/a.txt').sync_state, 'ignored');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not upload a file row whose path is now a folder, nor a folder row whose path is now a file', async () => {
    const asFile = path.join(dir, 'was-file');
    fs.mkdirSync(asFile);
    fs.writeFileSync(path.join(asFile, 'x.txt'), 'x');
    const asFolder = path.join(dir, 'was-folder');
    fs.writeFileSync(asFolder, 'now a file');
    db.upsertTrackedFile({ remotePath: '/my-files/was-file', localPath: asFile, type: 'file', syncState: 'pending_upload' });
    db.upsertTrackedFile({ remotePath: '/my-files/was-folder', localPath: asFolder, type: 'folder', syncState: 'pending_upload' });
    engine.setMode(SYNC_MODES.ONE_WAY_UPLOAD);
    await engine.syncPending();
    assert.strictEqual(queue.items.length, 0);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/was-file').sync_state, 'ignored');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/was-folder').sync_state, 'ignored');
  });

  it('still marks a row whose path is really gone as deleted', async () => {
    db.upsertTrackedFile({ remotePath: '/my-files/gone.txt', localPath: path.join(dir, 'gone.txt'), type: 'file', syncState: 'pending_upload' });
    engine.setMode(SYNC_MODES.ONE_WAY_UPLOAD);
    await engine.syncPending();
    assert.strictEqual(queue.items.length, 0);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/gone.txt').sync_state, 'local_deleted');
  });

  it('removes the temporary stand-in folder once its transfer ends, and settles the real folder row', async () => {
    fs.mkdirSync(path.join(dir, 'Dots'));
    fs.writeFileSync(path.join(dir, 'Dots', '.hidden'), 'x');
    fs.writeFileSync(path.join(dir, 'Dots', 'shown.txt'), 'y');
    db.upsertTrackedFile({ remotePath: '/my-files/Dots', localPath: path.join(dir, 'Dots'), type: 'folder', syncState: 'local_new' });
    engine.setMode(SYNC_MODES.ONE_WAY_UPLOAD);
    await engine.syncPending();
    const upload = queue.items[0];
    const staged = upload.options.localPaths[0];
    assert.ok(fs.existsSync(staged));
    assert.deepStrictEqual(upload.options.trackedLocalPaths, [path.join(dir, 'Dots')]);
    assert.strictEqual(db.getTrackedFileByPath('/my-files/Dots').sync_state, 'uploading');

    queue.emit('error', { id: upload.id, action: 'upload', options: upload.options, error: 'network timeout' });
    assert.ok(!fs.existsSync(staged), 'stand-in removed after a failed transfer');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/Dots').sync_state, 'pending_upload');
  });
});

// The clean check is made when a row is queued, but the CLI walks the folder later: behind other
// transfers (the app runs the queue with concurrency 1) or on a retry after a transient error.
// These tests drive the real transfer queue and a fake proton-drive that records everything it
// would upload (following links the way a naive uploader does).
describe('syncEngine and transfer queue - the folder is checked again right before the CLI runs', () => {
  let base;
  let dir;
  let outside;
  let db;
  let queue;
  let engine;
  let cliLog;
  let fakeBin;

  function mkEngine(extra = {}) {
    return createSyncEngine({
      syncDb: db, transferQueue: queue, conflictStore: createConflictStore(db), localFolder: dir,
      folderSettleMs: 0,
      getStatus: async () => ({ installed: true, authenticated: true, busy: false }),
      runProton: async () => ({ code: 0, stdout: '[]', stderr: '' }),
      ...extra
    });
  }

  function mkQueue(bin = fakeBin, retryDelayMs = 10) {
    const q = createTransferQueue({ concurrency: 1, syncDb: db, protonBin: bin, retryDelayMs });
    q.on('error', () => {});
    return q;
  }

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-upload-race-'));
    dir = path.join(base, 'sync');
    fs.mkdirSync(dir);
    outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'id_ed25519'), 'PRIVATE KEY OUTSIDE ROOT');
    db = createSyncDb(path.join(base, 'sync.db'));
    cliLog = path.join(base, 'cli.log');
    fakeBin = path.join(base, 'proton-drive');
    // For an upload: sleep when a path containing BLOCK is given, then record every path and
    // everything below it (symlinks followed). The upload paths sit between the flags and the parent.
    fs.writeFileSync(fakeBin, `#!/bin/bash
if [ "$2" = upload ]; then
  args=("$@"); n=\${#args[@]}
  for ((i=6;i<n-1;i++)); do p="\${args[$i]}"
    case "$p" in *BLOCK*) sleep 1.5;; esac
    echo "UPLOAD $p" >> ${cliLog}
    find -L "$p" -mindepth 1 2>/dev/null | sed "s|^$p|  +|" >> ${cliLog}
  done
fi
exit 0
`, { mode: 0o755 });
    queue = mkQueue();
    engine = mkEngine();
    engine.setMode(SYNC_MODES.ONE_WAY_UPLOAD);
  });

  afterEach(async () => {
    await engine.stop();
    engine.destroy();
    try { await queue.waitForIdle(15000); } catch {}
    queue.destroy();
    db.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const readLog = () => (fs.existsSync(cliLog) ? fs.readFileSync(cliLog, 'utf8') : '');
  const uploadedPaths = () => readLog().split('\n').filter(l => l.startsWith('UPLOAD ')).map(l => l.slice(7));
  const isStandIn = p => path.basename(path.dirname(p)).startsWith('aux-bridge-folder-');

  /** Cycle, let the queue drain, repeat: what the app does over the next few polls. */
  async function settleRounds(rounds = 6) {
    for (let i = 0; i < rounds; i++) {
      await engine.runSyncCycle();
      await queue.waitForIdle(20000);
    }
  }

  async function holdQueueBehindABlocker() {
    const blockDir = path.join(base, 'BLOCK');
    fs.mkdirSync(blockDir);
    queue.enqueue('upload', { localPaths: [blockDir], parentPath: '/my-files' });
  }

  it('R1: a dotfile written while the clean folder waits in the queue does not reach the CLI', async () => {
    await holdQueueBehindABlocker();
    const proj = path.join(dir, 'Proj');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'a.txt'), 'a');
    await engine.runSyncCycle();
    assert.strictEqual(db.getTrackedFileByPath('/my-files/Proj').sync_state, 'uploading', 'queued whole, behind the blocker');
    fs.mkdirSync(path.join(proj, '.git'));
    fs.writeFileSync(path.join(proj, '.git', 'config'), 'token');
    fs.writeFileSync(path.join(proj, '.env'), 'SECRET=1');
    await queue.waitForIdle(20000);

    assert.ok(!/\.env|\.git/.test(readLog()), `hidden files reached the CLI:\n${readLog()}`);
    assert.ok(!uploadedPaths().includes(proj), 'the real folder never went up whole');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/Proj').sync_state, 'pending_upload');

    await settleRounds();
    assert.ok(!/\.env|\.git/.test(readLog()), `hidden files reached the CLI in a later round:\n${readLog()}`);
    assert.ok(!uploadedPaths().includes(proj));
    assert.ok(uploadedPaths().some(isStandIn), 'the folder itself is created through the stand-in');
    assert.ok(uploadedPaths().includes(path.join(proj, 'a.txt')), 'the allowed file goes up on its own');
  });

  it('R1b: a dotfile written before the retry after a transient error does not reach the CLI', async () => {
    const flaky = path.join(base, 'flaky');
    fs.writeFileSync(flaky, `#!/bin/bash
c=$(cat ${cliLog}.n 2>/dev/null || echo 0); echo $((c+1)) > ${cliLog}.n
if [ "$c" = 0 ]; then echo "ECONNRESET network" >&2; exit 1; fi
exec ${fakeBin} "$@"
`, { mode: 0o755 });
    await engine.stop();
    engine.destroy();
    queue.destroy();
    queue = mkQueue(flaky, 300);
    engine = mkEngine();
    engine.setMode(SYNC_MODES.ONE_WAY_UPLOAD);
    const proj = path.join(dir, 'Proj');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'a.txt'), 'a');
    let retries = 0;
    queue.on('retry', () => { retries++; fs.writeFileSync(path.join(proj, '.env'), 'SECRET=1'); });
    await engine.runSyncCycle();
    await queue.waitForIdle(20000);

    assert.strictEqual(retries, 1, 'the first attempt failed and a retry was scheduled');
    assert.ok(!/\.env/.test(readLog()), `the retry carried the new dotfile:\n${readLog()}`);
    assert.strictEqual(fs.readFileSync(`${cliLog}.n`, 'utf8').trim(), '1', 'the CLI ran once, the retry was refused before it');
    assert.strictEqual(db.getTrackedFileByPath('/my-files/Proj').sync_state, 'pending_upload');

    await settleRounds();
    assert.ok(!/\.env/.test(readLog()));
    assert.ok(uploadedPaths().includes(path.join(proj, 'a.txt')));
  });

  it('R1c: a queued folder replaced by a symlink to a folder outside the root is not followed', async () => {
    await holdQueueBehindABlocker();
    const proj = path.join(dir, 'Proj');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'a.txt'), 'a');
    await engine.runSyncCycle();
    fs.rmSync(proj, { recursive: true });
    fs.symlinkSync(outside, proj);
    await queue.waitForIdle(20000);
    assert.ok(!/id_ed25519/.test(readLog()), `the link target reached the CLI:\n${readLog()}`);
    assert.ok(!uploadedPaths().includes(proj));
  });

  it('R1d: a queued file replaced by a symlink to a file outside the root is not followed', async () => {
    await holdQueueBehindABlocker();
    const note = path.join(dir, 'note.txt');
    fs.writeFileSync(note, 'n');
    await engine.runSyncCycle();
    fs.rmSync(note);
    fs.symlinkSync(path.join(outside, 'id_ed25519'), note);
    await queue.waitForIdle(20000);
    assert.ok(!uploadedPaths().includes(note), `the link reached the CLI:\n${readLog()}`);
  });

  it('still uploads a quiet clean folder whole, once, through the real queue', async () => {
    const proj = path.join(dir, 'Proj');
    fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'a.txt'), 'a');
    fs.writeFileSync(path.join(proj, 'sub', 'b.txt'), 'b');
    await engine.runSyncCycle();
    await queue.waitForIdle(20000);
    assert.deepStrictEqual(uploadedPaths(), [proj]);
    assert.ok(readLog().includes('+/sub/b.txt'));
  });

  describe('settle window', () => {
    it('a folder changed within the window takes the stand-in route, a quiet one goes whole', async () => {
      await engine.stop();
      engine.destroy();
      engine = mkEngine({ folderSettleMs: 700 });
      engine.setMode(SYNC_MODES.ONE_WAY_UPLOAD);
      const quiet = path.join(dir, 'Quiet');
      fs.mkdirSync(quiet);
      fs.writeFileSync(path.join(quiet, 'q.txt'), 'q');
      await new Promise(r => setTimeout(r, 900));
      const busy = path.join(dir, 'Busy');
      fs.mkdirSync(busy);
      fs.writeFileSync(path.join(busy, 'a.txt'), 'a');
      await engine.runSyncCycle();
      await queue.waitForIdle(20000);
      const first = uploadedPaths();
      assert.ok(first.includes(quiet), `a folder that stayed quiet goes up whole:\n${readLog()}`);
      const busyUploads = first.filter(p => path.basename(p) === 'Busy');
      assert.strictEqual(busyUploads.length, 1);
      assert.ok(isStandIn(busyUploads[0]), `Busy, changed a moment ago, must go up as a stand-in:\n${readLog()}`);
      assert.ok(!first.includes(busy));
    });

    it('a change in a nested folder inside the window also counts', async () => {
      await engine.stop();
      engine.destroy();
      engine = mkEngine({ folderSettleMs: 700 });
      engine.setMode(SYNC_MODES.ONE_WAY_UPLOAD);
      const proj = path.join(dir, 'Deep');
      fs.mkdirSync(path.join(proj, 'a', 'b'), { recursive: true });
      fs.writeFileSync(path.join(proj, 'a', 'b', 'old.txt'), 'old');
      await new Promise(r => setTimeout(r, 900));
      fs.writeFileSync(path.join(proj, 'a', 'b', 'fresh.txt'), 'fresh');
      await engine.runSyncCycle();
      await queue.waitForIdle(20000);
      assert.ok(!uploadedPaths().includes(proj), `a folder with a fresh file went up whole:\n${readLog()}`);
    });
  });

  describe('transfer queue preflight', () => {
    it('refuses the attempt without starting the CLI, does not retry it, and fails the transfer', async () => {
      const calls = [];
      queue.registerPreflight('test-check', async opts => { calls.push(opts); return 'changed'; });
      const errors = [];
      queue.on('error', e => errors.push(e));
      const retries = [];
      queue.on('retry', e => retries.push(e));
      const target = path.join(base, 'item');
      fs.mkdirSync(target);
      queue.enqueue('upload', { localPaths: [target], parentPath: '/my-files', preflight: 'test-check' });
      await queue.waitForIdle(10000);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].error, /source changed after it was queued \(changed\)/);
      assert.strictEqual(retries.length, 0);
      assert.strictEqual(readLog(), '', 'the CLI was never called');
    });

    it('runs the check before every attempt, inside the Proton process lock', async () => {
      const flaky = path.join(base, 'flaky2');
      fs.writeFileSync(flaky, `#!/bin/bash\nc=$(cat ${cliLog}.n 2>/dev/null || echo 0); echo $((c+1)) > ${cliLog}.n\nif [ "$c" = 0 ]; then echo "ECONNRESET" >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
      queue.destroy();
      queue = mkQueue(flaky, 10);
      let checks = 0;
      queue.registerPreflight('test-check', async () => { checks++; return null; });
      const target = path.join(base, 'item');
      fs.mkdirSync(target);
      const done = new Promise(resolve => queue.on('complete', resolve));
      queue.enqueue('upload', { localPaths: [target], parentPath: '/my-files', preflight: 'test-check' });
      await done;
      assert.strictEqual(checks, 2, 'one check per CLI attempt');
    });

    it('refuses a transfer whose flag names no registered check, and one whose check throws', async () => {
      const errors = [];
      queue.on('error', e => errors.push(e.error));
      const target = path.join(base, 'item');
      fs.mkdirSync(target);
      queue.enqueue('upload', { localPaths: [target], parentPath: '/my-files', preflight: 'nobody-home' });
      queue.registerPreflight('boom', async () => { throw new Error('disk gone'); });
      queue.enqueue('upload', { localPaths: [target], parentPath: '/my-files', preflight: 'boom' });
      await queue.waitForIdle(10000);
      assert.strictEqual(errors.length, 2);
      assert.match(errors[0], /no check registered/);
      assert.match(errors[1], /check failed: disk gone/);
      assert.strictEqual(readLog(), '');
    });

    it('leaves transfers without the flag alone', async () => {
      const target = path.join(base, 'plain');
      fs.mkdirSync(target);
      queue.enqueue('upload', { localPaths: [target], parentPath: '/my-files' });
      await queue.waitForIdle(10000);
      assert.deepStrictEqual(uploadedPaths(), [target]);
    });
  });
});
