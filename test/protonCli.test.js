const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCommand, parseListOutput, parseListOutputAsync, normalizeRemotePath } = require('../src/main/protonCli');

test('normalizeRemotePath builds safe Proton POSIX paths', () => {
  assert.equal(normalizeRemotePath('/my-files', '1. Misc'), '/my-files/1. Misc');
  assert.equal(normalizeRemotePath('/my-files/', 'foo/bar'), '/my-files/foo\/bar');
});

test('buildCommand returns argv without shell interpolation', () => {
  const cmd = buildCommand('download', {
    paths: ['/my-files/1. Misc', '/my-files/7. Videos'],
    localFolder: '/home/jd/ProtonDrive',
    fileConflictStrategy: 'skip',
    folderConflictStrategy: 'merge'
  });
  assert.equal(cmd.bin, 'proton-drive');
  assert.deepEqual(cmd.args, [
    'filesystem', 'download',
    '--folder-conflict-strategy', 'merge',
    '--file-conflict-strategy', 'skip',
    '/my-files/1. Misc',
    '/my-files/7. Videos',
    '/home/jd/ProtonDrive'
  ]);
});

test('parseListOutput extracts Proton folders from human CLI output', () => {
  const rows = parseListOutput('🗂  👑 user@example.com Dec 09 2025 22:56 - 1. Misc\n📄  👑 user@example.com Jan 01 2026 10:00 12 KB - note.txt');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { type: 'folder', name: '1. Misc', raw: '🗂  👑 user@example.com Dec 09 2025 22:56 - 1. Misc' });
  assert.equal(rows[1].type, 'file');
});

test('parseListOutput rejects incomplete JSON snapshots in strict listing mode', async () => {
  assert.throws(() => parseListOutput('', { requireJson: true }), /empty JSON listing/i);
  assert.throws(() => parseListOutput('{"items":[]}', { requireJson: true }), /array root/i);
  assert.throws(() => parseListOutput('[{"type":"file"}]', { requireJson: true }), /invalid row/i);
  assert.deepEqual(parseListOutput('[]', { requireJson: true }), []);
  await assert.rejects(parseListOutputAsync('', { requireJson: true }), /empty JSON listing/i);
});

test('parseListOutput preserves structured JSON metadata', () => {
  const rows = parseListOutput(JSON.stringify([
    {
      type: 'file',
      name: { ok: true, value: 'report.pdf' },
      modificationTime: '2026-07-27T10:00:00.000Z',
      activeRevision: {
        value: {
          claimedSize: 12345,
          claimedModificationTime: '2026-07-27T10:00:00.000Z',
          claimedDigests: { sha1: '0123456789ABCDEF0123456789ABCDEF01234567', sha1Verified: true }
        }
      },
      uid: 'remote-uid'
    }
  ]));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    type: 'file',
    name: 'report.pdf',
    size: 12345,
    modified: '2026-07-27T10:00:00.000Z',
    hash: 'sha1:0123456789abcdef0123456789abcdef01234567',
    uid: 'remote-uid'
  });
});

test('parseListOutputAsync moves large JSON listings off the event loop', async () => {
  const output = JSON.stringify(Array.from({ length: 10_000 }, (_, index) => ({
    type: 'file',
    name: { ok: true, value: `remote-${index}.txt` },
    modificationTime: '2026-08-03T10:00:00.000Z',
    totalStorageSize: index,
    uid: `uid-${index}`
  })));
  let settled = false;
  const parsing = parseListOutputAsync(output).then(rows => {
    settled = true;
    return rows;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(settled, false, 'large remote JSON was parsed synchronously on the event loop');
  assert.strictEqual((await parsing).length, 10_000);
});

test('buildCommand uses JSON for list and info operations', () => {
  assert.deepEqual(buildCommand('list', { path: '/my-files' }).args, ['filesystem', 'list', '-j', '/my-files']);
  assert.deepEqual(buildCommand('info', { path: '/my-files' }).args, ['filesystem', 'info', '-j', '/my-files']);
});

test('buildCommand ignores renderer-style executable overrides', () => {
  assert.equal(buildCommand('list', { path: '/my-files', bin: '/bin/sh' }).bin, 'proton-drive');
});

test('parseListOutput maps live totalStorageSize and undecryptable-name UID fields', () => {
  const rows = parseListOutput(JSON.stringify([{
    uid: 'NODE-123',
    type: 'file',
    name: { ok: false, error: 'undecryptable' },
    totalStorageSize: 987,
    modificationTime: '2026-07-27T10:00:00.000Z'
  }]));
  assert.strictEqual(rows[0].name, 'NODE-123');
  assert.strictEqual(rows[0].size, 987);
});

test('extractLoginUrl finds Proton desktop login links', () => {
  const { extractLoginUrl, isAlreadyLoggedOutMessage } = require('../src/main/protonCli');
  const text = 'Open following URL manually if browser did not open automatically:\nhttps://account.proton.me/desktop/login?app=drive&pv=3#payload=abc:cli-drive\n';
  assert.equal(
    extractLoginUrl(text),
    'https://account.proton.me/desktop/login?app=drive&pv=3#payload=abc:cli-drive'
  );
  assert.equal(extractLoginUrl('no url here'), null);
  assert.equal(isAlreadyLoggedOutMessage('You need to login first'), true);
  assert.equal(isAlreadyLoggedOutMessage('ok'), false);
});
