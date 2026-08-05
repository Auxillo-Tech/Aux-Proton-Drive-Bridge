const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('auxProtonDriveBridge', {
  // Core
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getDefaultLocalFolder: () => ipcRenderer.invoke('proton:getDefaultLocalFolder'),
  getStatus: (options) => ipcRenderer.invoke('proton:getStatus', options || {}),
  listMyFiles: () => ipcRenderer.invoke('proton:listMyFiles'),
  login: () => ipcRenderer.invoke('proton:login'),
  logout: () => ipcRenderer.invoke('proton:logout'),
  chooseLocalFolder: () => ipcRenderer.invoke('proton:chooseLocalFolder'),
  chooseUploadPaths: () => ipcRenderer.invoke('proton:chooseUploadPaths'),
  chooseBackupPaths: () => ipcRenderer.invoke('proton:chooseBackupPaths'),
  openFolder: (folder) => ipcRenderer.invoke('proton:openFolder', folder),
  downloadAll: (options) => ipcRenderer.invoke('proton:downloadAll', options),
  downloadPaths: (options) => ipcRenderer.invoke('proton:downloadPaths', options),
  uploadPaths: (options) => ipcRenderer.invoke('proton:uploadPaths', options),
  getOperationHistory: () => ipcRenderer.invoke('proton:getOperationHistory'),
  clearOperationHistory: () => ipcRenderer.invoke('proton:clearOperationHistory'),
  getBackupProfile: () => ipcRenderer.invoke('proton:getBackupProfile'),
  saveBackupProfile: (profile) => ipcRenderer.invoke('proton:saveBackupProfile', profile),
  runBackupProfile: () => ipcRenderer.invoke('proton:runBackupProfile'),

  // Multi-profile
  profile: {
    list: () => ipcRenderer.invoke('profile:list'),
    get: (id) => ipcRenderer.invoke('profile:get', id),
    save: (profile) => ipcRenderer.invoke('profile:save', profile),
    delete: (id) => ipcRenderer.invoke('profile:delete', id),
    getActive: () => ipcRenderer.invoke('profile:getActive')
  },

  // Sync metadata DB
  sync: {
    getStats: () => ipcRenderer.invoke('sync:getStats'),
    listTrackedFiles: (stateFilter) => ipcRenderer.invoke('sync:listTrackedFiles', stateFilter),
    listFilesNeedingSync: () => ipcRenderer.invoke('sync:listFilesNeedingSync'),
    getEvents: (fileId, limit) => ipcRenderer.invoke('sync:getEvents', fileId, limit),
    clearEvents: () => ipcRenderer.invoke('sync:clearEvents'),
    countByState: () => ipcRenderer.invoke('sync:countByState'),
    getTrackedFile: (remotePath) => ipcRenderer.invoke('sync:getTrackedFile', remotePath),
    saveCheckpoint: () => ipcRenderer.invoke('sync:saveCheckpoint')
  },

  // Transfer queue
  transfer: {
    enqueue: (action, options, priority) => ipcRenderer.invoke('transfer:enqueue', action, options, priority),
    cancel: (id) => ipcRenderer.invoke('transfer:cancel', id),
    cancelAll: () => ipcRenderer.invoke('transfer:cancelAll'),
    pause: () => ipcRenderer.invoke('transfer:pause'),
    resume: () => ipcRenderer.invoke('transfer:resume'),
    getState: () => ipcRenderer.invoke('transfer:getState')
  },

  // Conflicts
  conflict: {
    listActive: () => ipcRenderer.invoke('conflict:listActive'),
    listAll: () => ipcRenderer.invoke('conflict:listAll'),
    resolve: (conflictId, strategy) => ipcRenderer.invoke('conflict:resolve', conflictId, strategy),
    getStats: () => ipcRenderer.invoke('conflict:getStats')
  },

  // Sync engine
  syncEngine: {
    start: (syncMode, syncFolder, intervalMs) => ipcRenderer.invoke('sync:start', syncMode, syncFolder, intervalMs),
    stop: () => ipcRenderer.invoke('sync:stop'),
    scanNow: () => ipcRenderer.invoke('sync:scanNow'),
    getState: () => ipcRenderer.invoke('sync:getState'),
    setMode: (mode) => ipcRenderer.invoke('sync:setMode', mode),
    setPollInterval: (ms) => ipcRenderer.invoke('sync:setPollInterval', ms),
    getIgnorePatterns: () => ipcRenderer.invoke('sync:getIgnorePatterns'),
    setIgnorePatterns: (patterns) => ipcRenderer.invoke('sync:setIgnorePatterns', patterns)
  },

  // Auto-update
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    checkAndDownload: () => ipcRenderer.invoke('update:checkAndDownload'),
    download: () => ipcRenderer.invoke('update:download'),
    apply: (downloadedAsset) => ipcRenderer.invoke('update:apply', downloadedAsset),
    getAvailable: () => ipcRenderer.invoke('update:getAvailable')
  },

  // FUSE mount
  fuse: {
    mount: () => ipcRenderer.invoke('fuse:mount'),
    unmount: () => ipcRenderer.invoke('fuse:unmount'),
    getStatus: () => ipcRenderer.invoke('fuse:getStatus'),
    isAvailable: () => ipcRenderer.invoke('fuse:isAvailable')
  },

  // Progress / event subscriptions
  onProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('proton:progress', handler);
    return () => ipcRenderer.removeListener('proton:progress', handler);
  },
  onTransferComplete: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('proton:transferComplete', handler);
    return () => ipcRenderer.removeListener('proton:transferComplete', handler);
  },
  onTransferError: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('proton:transferError', handler);
    return () => ipcRenderer.removeListener('proton:transferError', handler);
  },
  onExternalDownloadFolder: (callback) => {
    const handler = (_event, payload) => callback({ localFolder: payload?.localFolder });
    ipcRenderer.on('proton:externalDownloadFolder', handler);
    return () => ipcRenderer.removeListener('proton:externalDownloadFolder', handler);
  },
  onLocalChange: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('proton:localChange', handler);
    return () => ipcRenderer.removeListener('proton:localChange', handler);
  },
  onRemoteChange: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('proton:remoteChange', handler);
    return () => ipcRenderer.removeListener('proton:remoteChange', handler);
  },
  onSyncActivity: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('proton:syncActivity', handler);
    return () => ipcRenderer.removeListener('proton:syncActivity', handler);
  },
  onSyncScanComplete: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('proton:syncScanComplete', handler);
    return () => ipcRenderer.removeListener('proton:syncScanComplete', handler);
  },
  onSyncComplete: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('proton:syncComplete', handler);
    return () => ipcRenderer.removeListener('proton:syncComplete', handler);
  },
  onSyncError: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('proton:syncError', handler);
    return () => ipcRenderer.removeListener('proton:syncError', handler);
  }
});
