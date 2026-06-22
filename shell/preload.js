const { contextBridge, ipcRenderer } = require('electron');

// Store listener references for cleanup
let statusListener = null;
let errorListener = null;
let launcherUpdateListener = null;
let launcherUpdateStatusListener = null;
let launcherOpeningAppListener = null;

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
    if (launcherUpdateListener) {
      ipcRenderer.removeListener('launcher-update-available', launcherUpdateListener);
      launcherUpdateListener = null;
    }
    if (launcherUpdateStatusListener) {
      ipcRenderer.removeListener('launcher-update-status', launcherUpdateStatusListener);
      launcherUpdateStatusListener = null;
    }
    if (launcherOpeningAppListener) {
      ipcRenderer.removeListener('launcher-opening-app', launcherOpeningAppListener);
      launcherOpeningAppListener = null;
    }
  },
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getContentVersion: () => ipcRenderer.invoke('get-content-version'),
  getShellIconDataUrl: () => ipcRenderer.invoke('get-shell-icon-data-url'),
  onLauncherUpdateAvailable: (callback) => {
    if (launcherUpdateListener) {
      ipcRenderer.removeListener('launcher-update-available', launcherUpdateListener);
    }
    launcherUpdateListener = (_event, info) => callback(info);
    ipcRenderer.on('launcher-update-available', launcherUpdateListener);
  },
  onLauncherUpdateStatus: (callback) => {
    if (launcherUpdateStatusListener) {
      ipcRenderer.removeListener('launcher-update-status', launcherUpdateStatusListener);
    }
    launcherUpdateStatusListener = (_event, info) => callback(info);
    ipcRenderer.on('launcher-update-status', launcherUpdateStatusListener);
  },
  onLauncherOpeningApp: (callback) => {
    if (launcherOpeningAppListener) {
      ipcRenderer.removeListener('launcher-opening-app', launcherOpeningAppListener);
    }
    launcherOpeningAppListener = (_event) => callback();
    ipcRenderer.on('launcher-opening-app', launcherOpeningAppListener);
  },
  checkLauncherUpdate: () => ipcRenderer.invoke('check-launcher-update'),
  beginLauncherUpdate: () => ipcRenderer.invoke('begin-launcher-update'),
  downloadLauncherUpdate: () => ipcRenderer.invoke('download-launcher-update'),
  installLauncherUpdate: () => ipcRenderer.invoke('install-launcher-update'),
  debugLauncherReinstall: (version = '') => ipcRenderer.invoke('launcher-debug-reinstall', { version }),
  continueAfterLauncherUpdate: () => ipcRenderer.invoke('continue-after-launcher-update')
});

ipcRenderer.on('launcher-update-status', (_event, payload) => {
  window.dispatchEvent(new CustomEvent('launcher-update-status', {
    detail: payload
  }));
});

const launcherUpdaterDebugAPI = {
  platform: process.platform,
  arch: process.arch,
  checkForUpdates: () => ipcRenderer.invoke('check-launcher-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-launcher-update'),
  installUpdate: () => ipcRenderer.invoke('install-launcher-update'),
  debugReinstall: (version = '') => ipcRenderer.invoke('launcher-debug-reinstall', { version })
};

contextBridge.exposeInMainWorld('space', launcherUpdaterDebugAPI);
contextBridge.exposeInMainWorld('launcherUpdater', launcherUpdaterDebugAPI);

contextBridge.exposeInMainWorld('dockerManagerAPI', {
  getState: () => ipcRenderer.invoke('docker-manager:getState'),
  refresh: () => ipcRenderer.invoke('docker-manager:refresh'),
  installOrSync: (tag) => ipcRenderer.invoke('docker-manager:install', { tag }),
  startActive: () => ipcRenderer.invoke('docker-manager:startActive'),
  startLocalInstance: (containerId) => ipcRenderer.invoke('docker-manager:startLocalInstance', { containerId }),
  cloneLocalInstance: (containerId, options) => {
    const opts = options && typeof options === 'object' ? options : {};
    const hasWorkspaceCategories = Object.prototype.hasOwnProperty.call(opts, 'workspaceCategories');
    return ipcRenderer.invoke('docker-manager:cloneLocalInstance', {
      containerId,
      workspaceCategories: hasWorkspaceCategories && (
        Array.isArray(opts.workspaceCategories) ||
        (opts.workspaceCategories && typeof opts.workspaceCategories === 'object')
      )
        ? opts.workspaceCategories
        : null
    });
  },
  openLocalInstanceStorageFolder: (containerId) =>
    ipcRenderer.invoke('docker-manager:openLocalInstanceStorageFolder', { containerId }),
  migrateLocalInstanceStorage: (containerId, options) => {
    const opts = options && typeof options === 'object' ? options : {};
    return ipcRenderer.invoke('docker-manager:migrateLocalInstanceStorage', {
      containerId,
      storageMode: typeof opts.storageMode === 'string' ? opts.storageMode : '',
      hostRoot: typeof opts.hostRoot === 'string' ? opts.hostRoot : '',
      volumeName: typeof opts.volumeName === 'string' ? opts.volumeName : ''
    });
  },
  stopActive: () => ipcRenderer.invoke('docker-manager:stopActive'),
  stopLocalInstance: (containerId) => ipcRenderer.invoke('docker-manager:stopLocalInstance', { containerId }),
  setRetentionPolicy: (keepCount) => ipcRenderer.invoke('docker-manager:setRetentionPolicy', { keepCount }),
  setPortPreferences: (prefs) => {
    const p = prefs && typeof prefs === 'object' ? prefs : {};
    return ipcRenderer.invoke('docker-manager:setPortPreferences', { ui: p.ui, ssh: p.ssh });
  },
  setStoragePreferences: (prefs) => {
    const p = prefs && typeof prefs === 'object' ? prefs : {};
    return ipcRenderer.invoke('docker-manager:setStoragePreferences', {
      mode: typeof p.mode === 'string' ? p.mode : '',
      hostRoot: typeof p.hostRoot === 'string' ? p.hostRoot : '',
      volumePrefix: typeof p.volumePrefix === 'string' ? p.volumePrefix : ''
    });
  },
  setInstanceDefaults: (defaults) => {
    const d = defaults && typeof defaults === 'object' ? defaults : {};
    return ipcRenderer.invoke('docker-manager:setInstanceDefaults', {
      models: d.models && typeof d.models === 'object' ? d.models : {}
    });
  },
  provisionRuntime: () => ipcRenderer.invoke('docker-manager:provisionRuntime'),
  selectRuntimeEndpoint: (id) => ipcRenderer.invoke('docker-manager:selectRuntimeEndpoint', {
    id: typeof id === 'string' ? id : ''
  }),
  addRemoteInstance: (remote) => {
    const r = remote && typeof remote === 'object' ? remote : {};
    return ipcRenderer.invoke('docker-manager:addRemoteInstance', {
      name: typeof r.name === 'string' ? r.name : '',
      url: typeof r.url === 'string' ? r.url : ''
    });
  },
  deleteRemoteInstance: (id) => ipcRenderer.invoke('docker-manager:deleteRemoteInstance', { id }),
  renameRemoteInstance: (id, name) => ipcRenderer.invoke('docker-manager:renameRemoteInstance', { id, name }),
  renameLocalInstance: (containerId, name) => ipcRenderer.invoke('docker-manager:renameLocalInstance', { containerId, name }),
  deleteLocalInstance: (containerId) => ipcRenderer.invoke('docker-manager:deleteLocalInstance', { containerId }),
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
      envText: typeof opts.envText === 'string' ? opts.envText : '',
      storageMode: typeof opts.storageMode === 'string' ? opts.storageMode : '',
      hostRoot: typeof opts.hostRoot === 'string' ? opts.hostRoot : '',
      volumeName: typeof opts.volumeName === 'string' ? opts.volumeName : ''
    });
  },
  runCustomImage: (options) => {
    const opts = options && typeof options === 'object' ? options : {};
    return ipcRenderer.invoke('docker-manager:runCustomImage', {
      image: typeof opts.image === 'string' ? opts.image : '',
      tag: typeof opts.tag === 'string' ? opts.tag : '',
      instanceName: typeof opts.instanceName === 'string' ? opts.instanceName : '',
      portMappings: typeof opts.portMappings === 'string' ? opts.portMappings : '',
      envText: typeof opts.envText === 'string' ? opts.envText : '',
      mountsText: typeof opts.mountsText === 'string' ? opts.mountsText : '',
      storageMode: typeof opts.storageMode === 'string' ? opts.storageMode : '',
      hostRoot: typeof opts.hostRoot === 'string' ? opts.hostRoot : '',
      volumeName: typeof opts.volumeName === 'string' ? opts.volumeName : '',
      pull: opts.pull !== false
    });
  },
  activateRetainedInstance: (containerId, dataLossAck) =>
    ipcRenderer.invoke('docker-manager:activateRetainedInstance', { containerId, dataLossAck }),
  cancel: (opId) => ipcRenderer.invoke('docker-manager:cancel', { opId }),
  getInventory: () => ipcRenderer.invoke('docker-manager:getInventory'),
  getLocalInstanceLogs: (containerId, options = {}) => {
    const opts = options && typeof options === 'object' ? options : {};
    return ipcRenderer.invoke('docker-manager:getLocalInstanceLogs', {
      containerId,
      maxLines: opts.maxLines
    });
  },
  removeVolume: (volumeName) => ipcRenderer.invoke('docker-manager:removeVolume', { volumeName }),
  pruneVolumes: () => ipcRenderer.invoke('docker-manager:pruneVolumes'),
  installDocker: () => ipcRenderer.invoke('docker-manager:installDocker'),
  openUi: () => ipcRenderer.invoke('docker-manager:openUi'),
  openContainerUi: (containerId) => ipcRenderer.invoke('docker-manager:openContainerUi', { containerId }),
  openRemoteInstance: (id) => ipcRenderer.invoke('docker-manager:openRemoteInstance', { id }),
  openHomepage: () => ipcRenderer.invoke('docker-manager:openHomepage'),
  openCliTerminal: (host) => ipcRenderer.invoke('docker-manager:openCliTerminal', { host }),
  installCli: () => ipcRenderer.invoke('docker-manager:installCli'),
  openDockerLoginTerminal: () => ipcRenderer.invoke('docker-manager:openDockerLoginTerminal'),
  getInstanceTabs: () => ipcRenderer.invoke('docker-manager:getInstanceTabs'),
  openInstanceUi: (target) => {
    const t = target && typeof target === 'object' ? target : {};
    return ipcRenderer.invoke('docker-manager:openInstanceUi', {
      kind: typeof t.kind === 'string' ? t.kind : '',
      containerId: typeof t.containerId === 'string' ? t.containerId : '',
      instanceId: typeof t.instanceId === 'string' ? t.instanceId : '',
      title: typeof t.title === 'string' ? t.title : ''
    });
  },
  selectInstanceHome: () => ipcRenderer.invoke('docker-manager:selectInstanceHome'),
  selectInstanceTab: (id) => ipcRenderer.invoke('docker-manager:selectInstanceTab', { id }),
  closeInstanceTab: (id) => ipcRenderer.invoke('docker-manager:closeInstanceTab', { id }),
  reloadInstanceTab: (id) => ipcRenderer.invoke('docker-manager:reloadInstanceTab', { id }),
  detachInstanceTab: (id) => ipcRenderer.invoke('docker-manager:detachInstanceTab', { id }),
  setInstanceTabBounds: (bounds) => {
    const b = bounds && typeof bounds === 'object' ? bounds : {};
    return ipcRenderer.invoke('docker-manager:setInstanceTabBounds', {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height
    });
  },
  onInstanceTabsChange: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('docker-manager:instanceTabs', listener);
    return () => ipcRenderer.removeListener('docker-manager:instanceTabs', listener);
  },
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
