const fs = require('node:fs');
const path = require('node:path');
const { sanitizeForStorage } = require('./operationStore');

const PROFILE_NAMESPACE = 'sync-profiles';

const DEFAULT_PROFILE = Object.freeze({
  id: '',
  name: '',
  mode: 'conservative',
  enabled: false,
  localPaths: [],
  remoteParentPath: '/my-files',
  localFolder: '',
  fileConflictStrategy: 'skip',
  folderConflictStrategy: 'merge',
  deletePropagation: false,
  pollIntervalMs: 60000,
  createdAt: null,
  updatedAt: null
});

function normalizeProfile(input = {}) {
  const now = new Date().toISOString();
  const localPaths = Array.isArray(input.localPaths) ? input.localPaths.map(String).filter(Boolean) : [];
  const profile = {
    ...DEFAULT_PROFILE,
    ...sanitizeForStorage(input),
    id: String(input.id || `profile_${Date.now()}`),
    name: String(input.name || 'Unnamed profile'),
    mode: ['conservative', 'one-way-upload', 'one-way-download', 'bidirectional'].includes(input.mode) ? input.mode : 'conservative',
    enabled: Boolean(input.enabled),
    localPaths,
    remoteParentPath: String(input.remoteParentPath || '/my-files'),
    localFolder: String(input.localFolder || ''),
    fileConflictStrategy: input.fileConflictStrategy === 'replace' || input.fileConflictStrategy === 'keep-both' ? input.fileConflictStrategy : 'skip',
    folderConflictStrategy: input.folderConflictStrategy === 'replace' || input.folderConflictStrategy === 'keep-both' || input.folderConflictStrategy === 'skip' ? input.folderConflictStrategy : 'merge',
    deletePropagation: false,
    pollIntervalMs: Math.max(5000, Number(input.pollIntervalMs) || 60000),
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

  // Legacy backup profile (one-way migration)
  function getDefaultBackupProfile() {
    const raw = loadRaw();
    if (!raw.defaultBackup) return { ...DEFAULT_PROFILE, id: 'default-backup', name: 'Default one-way backup', mode: 'one-way-upload' };
    return normalizeProfile(raw.defaultBackup);
  }

  function saveDefaultBackupProfile(profile) {
    const raw = loadRaw();
    raw.version = 2;
    raw.defaultBackup = normalizeProfile({ ...getDefaultBackupProfile(), ...profile });
    saveRaw(raw);
    return raw.defaultBackup;
  }

  // Multi-profile support
  function listProfiles() {
    const raw = loadRaw();
    const profiles = Array.isArray(raw[PROFILE_NAMESPACE]) ? raw[PROFILE_NAMESPACE] : [];
    // Include legacy as first profile if it exists
    if (raw.defaultBackup) {
      const legacy = normalizeProfile({ ...raw.defaultBackup, id: 'default-backup', name: 'Default one-way backup' });
      const alreadyListed = profiles.some(p => p.id === 'default-backup');
      if (!alreadyListed) profiles.unshift(legacy);
    }
    return profiles;
  }

  function getProfile(id) {
    const profiles = listProfiles();
    return profiles.find(p => p.id === id) || null;
  }

  function saveProfile(profile) {
    const raw = loadRaw();
    if (!Array.isArray(raw[PROFILE_NAMESPACE])) raw[PROFILE_NAMESPACE] = [];
    const profiles = raw[PROFILE_NAMESPACE];
    const normalized = normalizeProfile(profile);
    const idx = profiles.findIndex(p => p.id === normalized.id);
    if (idx >= 0) profiles[idx] = normalized;
    else profiles.push(normalized);
    raw[PROFILE_NAMESPACE] = profiles;
    raw.version = 2;
    saveRaw(raw);
    return normalized;
  }

  function deleteProfile(id) {
    if (id === 'default-backup') return false; // prevent deleting legacy
    const raw = loadRaw();
    if (!Array.isArray(raw[PROFILE_NAMESPACE])) return false;
    const before = raw[PROFILE_NAMESPACE].length;
    raw[PROFILE_NAMESPACE] = raw[PROFILE_NAMESPACE].filter(p => p.id !== id);
    saveRaw(raw);
    return raw[PROFILE_NAMESPACE].length < before;
  }

  function getActiveProfiles() {
    return listProfiles().filter(p => p.enabled);
  }

  return {
    filePath: resolved,
    getDefaultBackupProfile,
    saveDefaultBackupProfile,
    listProfiles,
    getProfile,
    saveProfile,
    deleteProfile,
    getActiveProfiles
  };
}

module.exports = { DEFAULT_PROFILE, createProfileStore, normalizeProfile };
