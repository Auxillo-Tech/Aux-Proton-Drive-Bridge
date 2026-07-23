const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProfileStore, normalizeProfile } = require('../src/main/profileStore');

test('backup profile is conservative and persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-profile-'));
  const store = createProfileStore(path.join(dir, 'profiles.json'));
  const saved = store.saveDefaultBackupProfile({ enabled: true, localPaths: ['/home/jd/Documents'], remoteParentPath: '/my-files/Backups', fileConflictStrategy: 'replace', deletePropagation: true });
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.localPaths, ['/home/jd/Documents']);
  assert.equal(saved.remoteParentPath, '/my-files/Backups');
  assert.equal(saved.fileConflictStrategy, 'replace');
  assert.equal(saved.deletePropagation, false);
  const loaded = createProfileStore(path.join(dir, 'profiles.json')).getDefaultBackupProfile();
  assert.equal(loaded.remoteParentPath, '/my-files/Backups');
});

test('backup profile defaults to skip/merge/no-delete', () => {
  const profile = normalizeProfile({ localPaths: ['/tmp/a'] });
  assert.equal(profile.fileConflictStrategy, 'skip');
  assert.equal(profile.folderConflictStrategy, 'merge');
  assert.equal(profile.deletePropagation, false);
  assert.equal(profile.mode, 'one-way-upload');
});
