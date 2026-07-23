const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('auxProtonBridge', {
  getDefaultLocalFolder: () => ipcRenderer.invoke('proton:getDefaultLocalFolder'),
  getStatus: () => ipcRenderer.invoke('proton:getStatus'),
  listMyFiles: () => ipcRenderer.invoke('proton:listMyFiles'),
  login: () => ipcRenderer.invoke('proton:login'),
  logout: () => ipcRenderer.invoke('proton:logout'),
  chooseLocalFolder: () => ipcRenderer.invoke('proton:chooseLocalFolder'),
  chooseUploadPaths: () => ipcRenderer.invoke('proton:chooseUploadPaths'),
  openFolder: (folder) => ipcRenderer.invoke('proton:openFolder', folder),
  downloadAll: (options) => ipcRenderer.invoke('proton:downloadAll', options),
  downloadPaths: (options) => ipcRenderer.invoke('proton:downloadPaths', options),
  uploadPaths: (options) => ipcRenderer.invoke('proton:uploadPaths', options),
  getOperationHistory: () => ipcRenderer.invoke('proton:getOperationHistory'),
  clearOperationHistory: () => ipcRenderer.invoke('proton:clearOperationHistory'),
  onProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('proton:progress', handler);
    return () => ipcRenderer.removeListener('proton:progress', handler);
  }
});
