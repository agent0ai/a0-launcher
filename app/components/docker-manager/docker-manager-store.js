import { createStore } from "/a0ui/js/AlpineStore.js";

export const dockerManagerStore = createStore("dockerManager", {
  loading: false,
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
  progress: null,
  runtimeSetup: {
    runtimeBackend: "",
    machineName: "",
    dockerHostOverride: "",
    usesDefaultDockerSocket: false,
    lastSuccessfulSetupAt: ""
  },
  portPreferences: null,
  retentionPolicy: null,
  instanceTabs: { tabs: [], activeTabId: "" },
  setBanner(type, message) {
    this.banner = { type: type || "", message: message || "" };
  }
});
