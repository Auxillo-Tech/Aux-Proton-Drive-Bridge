const fs = require('node:fs');
const path = require('node:path');
const { sanitizeForStorage } = require('./operationStore');

const DEFAULT_PROFILE = Object.freeze({
  id: 'default-backup',
  name: 'Default one-way backup',
  mode: 'one-way-upload',
  enabled: false,
  localPaths: [],
  remoteParentPath: '/my-files',
  fileConflictStrategy: 'skip',
  folderConflictStrategy: 'merge',
  deletePropagation: false,
  createdAt: null,
  updatedAt: null
});

function normalizeProfile(input = {}) {
  const now = new Date().toISOString();
  const localPaths = Array.isArray(input.localPaths) ? input.localPaths.map(String).filter(Boolean) : [];
  const profile = {
    ...DEFAULT_PROFILE,
    ...sanitizeForStorage(input),
    id: 'default-backup',
    mode: 'one-way-upload',
    name: String(input.name || DEFAULT_PROFILE.name),
    enabled: Boolean(input.enabled),
    localPaths,
    remoteParentPath: String(input.remoteParentPath || '/my-files'),
    fileConflictStrategy: input.fileConflictStrategy === 'replace' || input.fileConflictStrategy === 'keep-both' ? input.fileConflictStrategy : 'skip',
    folderConflictStrategy: input.folderConflictStrategy === 'replace' || input.folderConflictStrategy === 'keep-both' || input.folderConflictStrategy === 'skip' ? input.folderConflictStrategy : 'merge',
    deletePropagation: false,
    createdAt: input.createdAt || now,
    updatedAt: now
  };
  return profile;
}

function createProfileStore(filePath) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  function loadRaw() {
    try {
      const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      fs.renameSync(resolved, `${resolved}.corrupt-${Date.now()}`);
      return {};
    }
  }

  function saveRaw(data) {
    const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, resolved);
  }

  function getDefaultBackupProfile() {
    const raw = loadRaw();
    if (!raw.defaultBackup) return { ...DEFAULT_PROFILE };
    return normalizeProfile(raw.defaultBackup);
  }

  function saveDefaultBackupProfile(profile) {
    const raw = loadRaw();
    raw.version = 1;
    raw.defaultBackup = normalizeProfile({ ...getDefaultBackupProfile(), ...profile });
    saveRaw(raw);
    return raw.defaultBackup;
  }

  return { filePath: resolved, getDefaultBackupProfile, saveDefaultBackupProfile };
}

module.exports = { DEFAULT_PROFILE, createProfileStore, normalizeProfile };
