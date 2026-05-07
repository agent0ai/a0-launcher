const { contextBridge, ipcRenderer } = require('electron');

// Store listener references for cleanup
let statusListener = null;
let errorListener = null;

contextBridge.exposeInMainWorld('electronAPI', {
  onStatusUpdate: (callback) => {
    // Remove existing listener before adding new one
    if (statusListener) {
      ipcRenderer.removeListener('update-status', statusListener);
    }
    statusListener = (_event, message) => callback(message);
    ipcRenderer.on('update-status', statusListener);
  },
  onError: (callback) => {
    // Remove existing listener before adding new one
    if (errorListener) {
      ipcRenderer.removeListener('update-error', errorListener);
    }
    errorListener = (_event, message) => callback(message);
    ipcRenderer.on('update-error', errorListener);
  },
  removeAllListeners: () => {
    if (statusListener) {
      ipcRenderer.removeListener('update-status', statusListener);
      statusListener = null;
    }
    if (errorListener) {
      ipcRenderer.removeListener('update-error', errorListener);
      errorListener = null;
    }
  },
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getContentVersion: () => ipcRenderer.invoke('get-content-version'),
  getShellIconDataUrl: () => ipcRenderer.invoke('get-shell-icon-data-url')
});

contextBridge.exposeInMainWorld('dockerManagerAPI', {
  getState: () => ipcRenderer.invoke('docker-manager:getState'),
  refresh: () => ipcRenderer.invoke('docker-manager:refresh'),
  installOrSync: (tag) => ipcRenderer.invoke('docker-manager:install', { tag }),
  startActive: () => ipcRenderer.invoke('docker-manager:startActive'),
  stopActive: () => ipcRenderer.invoke('docker-manager:stopActive'),
  setRetentionPolicy: (keepCount) => ipcRenderer.invoke('docker-manager:setRetentionPolicy', { keepCount }),
  setPortPreferences: (prefs) => {
    const p = prefs && typeof prefs === 'object' ? prefs : {};
    return ipcRenderer.invoke('docker-manager:setPortPreferences', { ui: p.ui, ssh: p.ssh });
  },
  addRemoteInstance: (remote) => {
    const r = remote && typeof remote === 'object' ? remote : {};
    return ipcRenderer.invoke('docker-manager:addRemoteInstance', {
      name: typeof r.name === 'string' ? r.name : '',
      url: typeof r.url === 'string' ? r.url : ''
    });
  },
  deleteRemoteInstance: (id) => ipcRenderer.invoke('docker-manager:deleteRemoteInstance', { id }),
  deleteRetainedInstance: (containerId) =>
    ipcRenderer.invoke('docker-manager:deleteRetainedInstance', { containerId }),
  updateToLatest: (dataLossAck) => ipcRenderer.invoke('docker-manager:updateToLatest', { dataLossAck }),
  activateTag: (tag, dataLossAck, options) => {
    const opts = options && typeof options === 'object' ? options : {};
    return ipcRenderer.invoke('docker-manager:activate', {
      tag,
      dataLossAck,
      instanceName: typeof opts.instanceName === 'string' ? opts.instanceName : '',
      portMappings: typeof opts.portMappings === 'string' ? opts.portMappings : '',
      envText: typeof opts.envText === 'string' ? opts.envText : ''
    });
  },
  activateRetainedInstance: (containerId, dataLossAck) =>
    ipcRenderer.invoke('docker-manager:activateRetainedInstance', { containerId, dataLossAck }),
  cancel: (opId) => ipcRenderer.invoke('docker-manager:cancel', { opId }),
  getInventory: () => ipcRenderer.invoke('docker-manager:getInventory'),
  removeVolume: (volumeName) => ipcRenderer.invoke('docker-manager:removeVolume', { volumeName }),
  pruneVolumes: () => ipcRenderer.invoke('docker-manager:pruneVolumes'),
  installDocker: () => ipcRenderer.invoke('docker-manager:installDocker'),
  openUi: () => ipcRenderer.invoke('docker-manager:openUi'),
  openContainerUi: (containerId) => ipcRenderer.invoke('docker-manager:openContainerUi', { containerId }),
  openRemoteInstance: (id) => ipcRenderer.invoke('docker-manager:openRemoteInstance', { id }),
  openHomepage: () => ipcRenderer.invoke('docker-manager:openHomepage'),
  openCliTerminal: (host) => ipcRenderer.invoke('docker-manager:openCliTerminal', { host }),
  onStateChange: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('docker-manager:state', listener);
    return () => ipcRenderer.removeListener('docker-manager:state', listener);
  },
  onProgress: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('docker-manager:progress', listener);
    return () => ipcRenderer.removeListener('docker-manager:progress', listener);
  }
});
