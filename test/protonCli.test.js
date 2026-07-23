const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCommand, parseListOutput, normalizeRemotePath } = require('../src/main/protonCli');

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
