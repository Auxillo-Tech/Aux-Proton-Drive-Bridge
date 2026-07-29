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
  assert.equal(profile.mode, 'conservative');
});

test('profile normalization drops unknown and sensitive fields and clamps intervals', () => {
  const profile = normalizeProfile({ name: 'Safe', token: 'secret', bin: '/bin/sh', pollIntervalMs: Infinity });
  assert.equal(profile.token, undefined);
  assert.equal(profile.bin, undefined);
  assert.equal(profile.pollIntervalMs, 60000);
});

test('profile reads normalize malformed and attacker-controlled persisted entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-proton-profile-read-'));
  const file = path.join(dir, 'profiles.json');
  fs.writeFileSync(file, JSON.stringify({
    defaultBackup: { id: 'attacker-id', token: 'secret', localPaths: 'invalid' },
    'sync-profiles': [
      { id: 'unsafe', enabled: 'yes', token: 'secret', pollIntervalMs: 1 },
      null,
      { id: 'unsafe', name: 'duplicate' }
    ]
  }));
  const store = createProfileStore(file);
  const defaultProfile = store.getDefaultBackupProfile();
  assert.equal(defaultProfile.id, 'default-backup');
  assert.equal(defaultProfile.token, undefined);
  const profiles = store.listProfiles();
  assert.equal(profiles.filter(profile => profile.id === 'unsafe').length, 1);
  assert.equal(profiles.find(profile => profile.id === 'unsafe').pollIntervalMs, 5000);
  assert.equal(profiles.some(profile => Object.hasOwn(profile, 'token')), false);
});
