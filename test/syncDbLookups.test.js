const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSyncDb } = require('../src/main/syncDb');

describe('syncDb - transfer event lookups', () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-db-lookups-'));
    db = createSyncDb(path.join(dir, 'sync.db'));
    const add = (remotePath, localPath, type = 'file') => db.upsertTrackedFile({
      remotePath, localPath, type, size: 1, localSize: 1, syncState: 'synced'
    });
    add('/my-files/a', '/home/u/a', 'folder');
    add('/my-files/a/b.txt', '/home/u/a/b.txt');
    add('/my-files/a/c/d.txt', '/home/u/a/c/d.txt');
    add('/my-files/a-b.txt', '/home/u/a-b.txt');
    add('/my-files/a0', '/home/u/a0');
    add('/my-files/a%', '/home/u/a%');
    add('/my-files/aXb', '/home/u/a_b');
    add('/my-files/A/x.txt', '/home/u/A/x.txt');
  });

  afterEach(() => {
    db.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds the rows for one local path and nothing else', () => {
    assert.deepStrictEqual(db.listTrackedFilesByLocalPath('/home/u/a/b.txt').map(r => r.remote_path), ['/my-files/a/b.txt']);
    assert.deepStrictEqual(db.listTrackedFilesByLocalPath('/home/u/a_b').map(r => r.remote_path), ['/my-files/aXb']);
    assert.deepStrictEqual(db.listTrackedFilesByLocalPath('/home/u/a%').map(r => r.remote_path), ['/my-files/a%']);
    assert.deepStrictEqual(db.listTrackedFilesByLocalPath('/home/u/missing'), []);
  });

  it('finds a path and everything below it, exactly like a prefix match on "path/"', () => {
    const under = base => db.listTrackedFilesUnderRemotePath(base).map(r => r.remote_path);
    assert.deepStrictEqual(under('/my-files/a'), ['/my-files/a', '/my-files/a/b.txt', '/my-files/a/c/d.txt']);
    assert.deepStrictEqual(under('/my-files/a/c'), ['/my-files/a/c/d.txt']);
    assert.deepStrictEqual(under('/my-files/a-b.txt'), ['/my-files/a-b.txt']);
    assert.deepStrictEqual(under('/my-files/a%'), ['/my-files/a%']);
    assert.deepStrictEqual(under('/my-files/nothing'), []);
  });

  it('agrees with the old whole-table filter for every tracked path', () => {
    const all = db.listTrackedFiles();
    for (const { remote_path: base } of all) {
      const old = all.filter(item => item.remote_path === base || item.remote_path.startsWith(`${base}/`))
        .map(item => item.remote_path).sort();
      assert.deepStrictEqual(db.listTrackedFilesUnderRemotePath(base).map(r => r.remote_path).sort(), old, base);
    }
  });
});
