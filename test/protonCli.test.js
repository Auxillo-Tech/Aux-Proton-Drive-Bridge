const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCommand, parseListOutput, parseListOutputAsync, normalizeRemotePath, runProton } = require('../src/main/protonCli');

// Runs `fn` with PROTON_DRIVE_BIN pointing at a throwaway Node script that stands in for the CLI.
async function withFakeCli(source, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proton-cli-'));
  const bin = path.join(dir, 'proton-drive');
  fs.writeFileSync(bin, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  const previous = process.env.PROTON_DRIVE_BIN;
  process.env.PROTON_DRIVE_BIN = bin;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PROTON_DRIVE_BIN;
    else process.env.PROTON_DRIVE_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeRemotePath builds safe Proton POSIX paths', () => {
  assert.equal(normalizeRemotePath('/my-files', '1. Misc'), '/my-files/1. Misc');
  assert.equal(normalizeRemotePath('/my-files/', 'foo/bar'), '/my-files/foo\/bar');
});

test('normalizeRemotePath joins the name as given, without rewriting it', () => {
  assert.equal(normalizeRemotePath('/my-files/Docs', 'a b (1).txt'), '/my-files/Docs/a b (1).txt');
  assert.equal(normalizeRemotePath('/my-files', 'back\\slash.txt'), '/my-files/back\\slash.txt');
  assert.equal(normalizeRemotePath('', 'x'), '/my-files/x');
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

test('parseListOutput excludes unverified claimed SHA-1 digests entirely', () => {
  const rows = parseListOutput(JSON.stringify([{
    type: 'file',
    name: { ok: true, value: 'legacy.txt' },
    activeRevision: { value: {
      claimedSize: 6,
      claimedModificationTime: '2026-08-12T10:00:00.000Z',
      claimedDigests: { sha1: '0123456789ABCDEF0123456789ABCDEF01234567', sha1Verified: false }
    } },
    uid: 'legacy-uid'
  }]));

  assert.equal(rows[0].hash, undefined);
  assert.equal(rows[0].claimedHash, undefined);
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

test('parseListOutput marks rows whose name could not be read', () => {
  const rows = parseListOutput(JSON.stringify([
    { uid: 'NODE-123', type: 'file', name: { ok: false, error: 'undecryptable' } },
    { uid: 'NODE-456', type: 'file', name: { ok: true, value: 'readable.txt' } }
  ]), { requireJson: true });
  assert.strictEqual(rows[0].nameUnavailable, true);
  assert.strictEqual('nameUnavailable' in rows[1], false);
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

test('runProton keeps non-ASCII names intact when a character is split across output chunks', async () => {
  const name = 'café-日本.txt';
  const result = await withFakeCli(`
    const buf = Buffer.from(JSON.stringify([{ uid: 'u1', type: 'file', name: { ok: true, value: ${JSON.stringify(name)} } }]));
    const cut = buf.indexOf(Buffer.from('é')) + 1;
    process.stdout.write(buf.subarray(0, cut), () => setTimeout(() => process.stdout.write(buf.subarray(cut)), 150));
  `, () => runProton('list', { path: '/my-files' }));
  assert.equal(parseListOutput(result.stdout, { requireJson: true })[0].name, name);
});

test('runProton does not mistake a file name in a JSON listing for a sign-in error', async () => {
  const listing = JSON.stringify([{ uid: 'u1', type: 'file', name: { ok: true, value: 'why am I not logged in.txt' } }]);
  const result = await withFakeCli(`process.stdout.write(${JSON.stringify(listing)});`, () => runProton('list', { path: '/my-files' }));
  assert.equal(parseListOutput(result.stdout, { requireJson: true })[0].name, 'why am I not logged in.txt');
});

test('runProton still reports a sign-in error printed with a zero exit code', async () => {
  await assert.rejects(
    withFakeCli(`process.stdout.write('You need to login first\\n');`, () => runProton('list', { path: '/my-files' })),
    /need to login/i
  );
  await assert.rejects(
    withFakeCli(`process.stdout.write('[]'); process.stderr.write('Error: unauthenticated\\n');`, () => runProton('list', { path: '/my-files' })),
    /unauthenticated/i
  );
});
