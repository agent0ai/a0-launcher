import { createStore } from "/a0ui/js/AlpineStore.js";

export const dockerManagerStore = createStore("dockerManager", {
  loading: false,
  stateLoaded: false,
  banner: { type: "", message: "" },
  meta: { appVersion: "", contentVersion: "" },
  dockerAvailable: false,
  uiUrl: "",
  error: "",
  environment: null,
  images: [],
  versions: [],
  containers: [],
  remoteInstances: [],
  volumes: [],
  retainedInstances: [],
  storage: null,
  runtime: null,
  runtimeDiagnostics: null,
  progress: null,
  portPreferences: null,
  storagePreferences: null,
  instanceDefaults: null,
  retentionPolicy: null,
  instanceTabs: { tabs: [], activeTabId: "" },
  setBanner(type, message) {
    this.banner = { type: type || "", message: message || "" };
  }
});
