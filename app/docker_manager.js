import { dockerManagerStore as store } from "./components/docker-manager/docker-manager-store.js";

function isErrorResponse(obj) {
  return !!obj && typeof obj === "object" && typeof obj.message === "string";
}

function toastIcon(type) {
  if (type === "error") return "error";
  if (type === "success") return "check_circle";
  if (type === "warning") return "warning";
  return "info";
}

function getToastStack() {
  let stack = document.getElementById("dmToastStack");
  if (stack) return stack;
  stack = document.createElement("div");
  stack.id = "dmToastStack";
  stack.className = "dm-toast-stack";
  stack.setAttribute("aria-live", "polite");
  document.body.appendChild(stack);
  return stack;
}

function showToast(type, message, title = "", displayTime = 4, group = "") {
  const text = String(message || "").trim();
  if (!text) return Promise.resolve("");

  const stack = getToastStack();
  if (group) {
    stack.querySelectorAll("[data-toast-group]").forEach((el) => {
      if (el.dataset.toastGroup === group) el.remove();
    });
  }

  const toast = document.createElement("div");
  const id = `dm-toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  toast.id = id;
  toast.className = `dm-toast ${type || "info"}`;
  if (group) toast.dataset.toastGroup = group;

  const icon = document.createElement("span");
  icon.className = "material-symbols-outlined dm-toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = toastIcon(type);

  const content = document.createElement("div");
  if (title) {
    const titleEl = document.createElement("div");
    titleEl.className = "dm-toast-title";
    titleEl.textContent = title;
    content.appendChild(titleEl);
  }
  const msg = document.createElement("div");
  msg.className = "dm-toast-message";
  msg.textContent = text;
  content.appendChild(msg);

  const dismiss = document.createElement("button");
  dismiss.className = "dm-toast-dismiss";
  dismiss.type = "button";
  dismiss.title = "Dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">close</span>';
  dismiss.addEventListener("click", () => toast.remove());

  toast.appendChild(icon);
  toast.appendChild(content);
  toast.appendChild(dismiss);
  stack.appendChild(toast);

  const timeoutMs = Math.max(1000, Number(displayTime || 4) * 1000);
  window.setTimeout(() => toast.remove(), timeoutMs);
  return Promise.resolve(id);
}

window.toastFrontendInfo = (message, title = "Agent Zero", displayTime = 3, group = "") =>
  showToast("info", message, title, displayTime, group);
window.toastFrontendError = (message, title = "Agent Zero", displayTime = 8, group = "") =>
  showToast("error", message, title, displayTime, group);
window.toastFrontendSuccess = (message, title = "Agent Zero", displayTime = 3, group = "") =>
  showToast("success", message, title, displayTime, group);
window.toastFrontendWarning = (message, title = "Agent Zero", displayTime = 5, group = "") =>
  showToast("warning", message, title, displayTime, group);

function snapshot() {
  return {
    loading: !!store.loading,
    banner: store.banner || { type: "", message: "" },
    meta: store.meta || { appVersion: "", contentVersion: "" },
    dockerAvailable: !!store.dockerAvailable,
    uiUrl: store.uiUrl || "",
    error: store.error || "",
    environment: store.environment || null,
    images: Array.isArray(store.images) ? store.images : [],
    versions: Array.isArray(store.versions) ? store.versions : [],
    containers: Array.isArray(store.containers) ? store.containers : [],
    remoteInstances: Array.isArray(store.remoteInstances) ? store.remoteInstances : [],
    volumes: Array.isArray(store.volumes) ? store.volumes : [],
    retainedInstances: Array.isArray(store.retainedInstances) ? store.retainedInstances : [],
    storage: store.storage || null,
    progress: store.progress || null,
    portPreferences: store.portPreferences || null,
    retentionPolicy: store.retentionPolicy || null
  };
}

function emitState() {
  const next = snapshot();
  window.__dmLastState = next;
  window.dispatchEvent(new CustomEvent("dm:state", { detail: next }));
  renderTerminalDock(next);
}

function setBanner(type, message) {
  store.setBanner(type || "", message || "");
  if (message) {
    const fn = type === "error" ? window.toastFrontendError : window.toastFrontendInfo;
    fn?.(message, "Agent Zero", type === "error" ? 8 : 3, `dm-${type || "info"}`);
  }
  emitState();
}

async function loadMeta() {
  try {
    const v = await window.electronAPI?.getContentVersion?.();
    store.meta.contentVersion = v ? `Content: ${v}` : "";
  } catch {
    store.meta.contentVersion = "";
  }

  try {
    const v = await window.electronAPI?.getAppVersion?.();
    store.meta.appVersion = v ? `App: ${v}` : "";
  } catch {
    store.meta.appVersion = "";
  }
}

async function loadHeaderLogo() {
  const img = document.getElementById("headerLogo");
  if (!img) return;
  try {
    const dataUrl = await window.electronAPI?.getShellIconDataUrl?.();
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
      img.src = dataUrl;
      img.classList.remove("hidden");
    }
  } catch {
    // ignore
  }
}

async function refresh() {
  const api = window.dockerManagerAPI;
  if (!api) {
    store.error = "Agent Zero controls are not available.";
    store.dockerAvailable = false;
    setBanner("error", store.error);
    return;
  }

  store.loading = true;
  store.error = "";
  emitState();

  try {
    const [inventory, state] = await Promise.all([
      typeof api.getInventory === "function" ? api.getInventory() : null,
      typeof api.getState === "function" ? api.getState() : null
    ]);

    if (isErrorResponse(inventory)) {
      store.error = inventory.message;
      store.dockerAvailable = false;
      setBanner("error", inventory.message);
      store.loading = false;
      emitState();
      return;
    }

    if (isErrorResponse(state)) {
      store.error = state.message;
      setBanner("error", state.message);
    } else {
      store.uiUrl = state?.uiUrl || "";
      store.versions = Array.isArray(state?.versions) ? state.versions : [];
      store.retainedInstances = Array.isArray(state?.retainedInstances) ? state.retainedInstances : [];
      store.remoteInstances = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
      store.storage = state?.storage || null;
      store.portPreferences = state?.portPreferences || null;
      store.retentionPolicy = state?.retentionPolicy || null;
      if (!store.error) setBanner("", "");
    }

    store.dockerAvailable = !!inventory?.dockerAvailable;
    store.environment = inventory?.environment || null;
    store.images = Array.isArray(inventory?.images) ? inventory.images : [];
    store.containers = Array.isArray(inventory?.containers) ? inventory.containers : [];
    if (Array.isArray(inventory?.remoteInstances)) store.remoteInstances = inventory.remoteInstances;
    store.volumes = Array.isArray(inventory?.volumes) ? inventory.volumes : [];
  } catch (e) {
    store.error = e?.message || "Failed to load Docker inventory.";
    store.dockerAvailable = false;
    setBanner("error", store.error);
  } finally {
    store.loading = false;
    emitState();
  }
}

async function openUi(containerId = "") {
  const api = window.dockerManagerAPI;
  if (!api) return;
  try {
    const res = containerId && typeof api.openContainerUi === "function"
      ? await api.openContainerUi(containerId)
      : typeof api.openUi === "function"
        ? await api.openUi()
        : null;
    if (isErrorResponse(res)) setBanner("error", res.message);
    else if (res?.opened) window.toastFrontendInfo?.("Instance UI opened.", "Agent Zero", 2, "dm-open-ui");
  } catch (e) {
    setBanner("error", e?.message || "Unable to open UI");
  }
}

async function openHomepage() {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.openHomepage !== "function") return;
  try {
    const res = await api.openHomepage();
    if (isErrorResponse(res)) setBanner("error", res.message);
  } catch (e) {
    setBanner("error", e?.message || "Unable to open API Dashboard");
  }
}

async function removeVolume(volumeName) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.removeVolume !== "function") return;
  if (!volumeName) return;
  try {
    const res = await api.removeVolume(volumeName);
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return;
    }
    setBanner("info", `Removed volume ${volumeName}`);
    await refresh();
  } catch (e) {
    setBanner("error", e?.message || "Failed to remove volume");
  }
}

async function pruneVolumes() {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.pruneVolumes !== "function") return;
  try {
    const res = await api.pruneVolumes();
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return;
    }
    setBanner("info", "Unused volumes cleared.");
    await refresh();
  } catch (e) {
    setBanner("error", e?.message || "Failed to prune volumes");
  }
}

async function openDockerDownload() {
  const api = window.dockerManagerAPI;
  if (api && typeof api.installDocker === "function") {
    try {
      const res = await api.installDocker();
      if (isErrorResponse(res)) {
        setBanner("error", res.message);
        return;
      }
      setBanner("info", "Docker installer opened.");
      return;
    } catch (e) {
      setBanner("error", e?.message || "Unable to start Docker installer");
      return;
    }
  }
  window.open("https://www.docker.com/products/docker-desktop/", "_blank");
}

async function runDockerOperation(label, action, successMessage) {
  try {
    const res = await action();
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return res;
    }
    if (successMessage) setBanner("info", successMessage);
    await refresh();
    return res;
  } catch (e) {
    const message = e?.message || `${label} failed`;
    setBanner("error", message);
    return { message };
  }
}

async function startActive() {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.startActive !== "function") return;
  return runDockerOperation("Start", () => api.startActive(), "Instance start requested.");
}

async function stopActive() {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.stopActive !== "function") return;
  return runDockerOperation("Stop", () => api.stopActive(), "Instance stop requested.");
}

async function activateTag(tag, options = {}) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.activateTag !== "function") return;
  const payload = options && typeof options === "object" ? options : {};
  const dataLossAck = payload.dataLossAck || "proceed_without_backup";
  return runDockerOperation(
    "Activate",
    () => api.activateTag(tag, dataLossAck, payload),
    "Instance activation requested."
  );
}

async function openCliTerminal() {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.openCliTerminal !== "function") return;
  try {
    const res = await api.openCliTerminal(store.uiUrl || "");
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return;
    }
    setBanner("info", "A0 CLI terminal opened.");
  } catch (e) {
    setBanner("error", e?.message || "Unable to open A0 CLI terminal");
  }
}

async function addRemoteInstance(remote = {}) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.addRemoteInstance !== "function") return false;
  try {
    const res = await api.addRemoteInstance(remote);
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("info", "Remote instance added.");
    await refresh();
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to add remote instance");
    return false;
  }
}

async function deleteRemoteInstance(id) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.deleteRemoteInstance !== "function") return false;
  try {
    const res = await api.deleteRemoteInstance(id);
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("info", "Remote instance removed.");
    await refresh();
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to remove remote instance");
    return false;
  }
}

async function openRemoteInstance(id) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.openRemoteInstance !== "function") return;
  try {
    const res = await api.openRemoteInstance(id);
    if (isErrorResponse(res)) setBanner("error", res.message);
    else if (res?.opened) window.toastFrontendInfo?.("Remote instance opened.", "Agent Zero", 2, "dm-open-remote");
  } catch (e) {
    setBanner("error", e?.message || "Unable to open remote instance");
  }
}

window.dockerManagerActions = {
  refresh,
  openUi,
  openHomepage,
  removeVolume,
  pruneVolumes,
  openDockerDownload,
  startActive,
  stopActive,
  activateTag,
  openCliTerminal,
  addRemoteInstance,
  deleteRemoteInstance,
  openRemoteInstance,
  async setPortPreferences(prefs) {
    const api = window.dockerManagerAPI;
    if (!api || typeof api.setPortPreferences !== "function") return false;
    try {
      const res = await api.setPortPreferences(prefs);
      if (isErrorResponse(res)) { setBanner("error", res.message); return false; }
      setBanner("info", "Port preferences saved.");
      await refresh();
      return true;
    } catch (e) {
      setBanner("error", e?.message || "Failed to save port preferences");
      return false;
    }
  },
  async setRetentionPolicy(keepCount) {
    const api = window.dockerManagerAPI;
    if (!api || typeof api.setRetentionPolicy !== "function") return false;
    try {
      const res = await api.setRetentionPolicy(keepCount);
      if (isErrorResponse(res)) { setBanner("error", res.message); return false; }
      setBanner("info", "Retention policy saved.");
      await refresh();
      return true;
    } catch (e) {
      setBanner("error", e?.message || "Failed to save retention policy");
      return false;
    }
  }
};

let terminalDockOpen = false;

function renderTerminalDock(state = snapshot()) {
  const mount = document.getElementById("dmTerminalDock");
  if (!mount) return;

  mount.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = `dm-terminal-shell${terminalDockOpen ? " open" : ""}`;

  const panel = document.createElement("div");
  panel.className = "dm-terminal-panel";

  const tabs = document.createElement("div");
  tabs.className = "dm-terminal-tabs";
  const tab = document.createElement("div");
  tab.className = "dm-terminal-tab";
  const tabIcon = document.createElement("span");
  tabIcon.className = "material-symbols-outlined";
  tabIcon.textContent = "terminal";
  const tabText = document.createElement("span");
  tabText.textContent = "A0 CLI Connector";
  tab.appendChild(tabIcon);
  tab.appendChild(tabText);
  tabs.appendChild(tab);

  const body = document.createElement("div");
  body.className = "dm-terminal-body";
  const note = document.createElement("div");
  note.className = "dm-terminal-note";
  note.textContent = state?.uiUrl
    ? "Open the local Agent Zero CLI against this running instance."
    : "Start an instance first, then open the A0 CLI against its local socket.";
  const command = document.createElement("code");
  command.className = "dm-terminal-command";
  command.textContent = state?.uiUrl ? `a0 --host ${state.uiUrl}` : "a0";
  body.appendChild(note);
  body.appendChild(command);

  panel.appendChild(tabs);
  panel.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "dm-terminal-footer";

  const toggle = document.createElement("button");
  toggle.className = "button dm-terminal-toggle";
  toggle.type = "button";
  toggle.title = terminalDockOpen ? "Hide terminal" : "Show terminal";
  toggle.setAttribute("aria-label", toggle.title);
  toggle.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">keyboard_arrow_up</span>';
  toggle.addEventListener("click", () => {
    terminalDockOpen = !terminalDockOpen;
    renderTerminalDock(snapshot());
  });

  const status = document.createElement("div");
  status.className = "dm-terminal-status";
  const dot = document.createElement("span");
  dot.className = `dm-terminal-dot${state?.uiUrl ? " connected" : ""}`;
  const statusText = document.createElement("span");
  statusText.textContent = state?.uiUrl ? "Instance socket ready" : "No running instance";
  const url = document.createElement("span");
  url.className = "dm-terminal-url";
  url.textContent = state?.uiUrl || "";
  status.appendChild(dot);
  status.appendChild(statusText);
  if (state?.uiUrl) status.appendChild(url);

  const launch = document.createElement("button");
  launch.className = "button confirm";
  launch.type = "button";
  launch.disabled = !state?.uiUrl;
  launch.title = state?.uiUrl ? "Open A0 CLI terminal" : "Start an instance first";
  launch.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">open_in_new</span><span>Open A0 CLI</span>';
  launch.addEventListener("click", () => window.dockerManagerActions?.openCliTerminal?.());

  footer.appendChild(toggle);
  footer.appendChild(status);
  footer.appendChild(launch);

  shell.appendChild(panel);
  shell.appendChild(footer);
  mount.appendChild(shell);
}

function initSubscriptions() {
  const api = window.dockerManagerAPI;
  if (!api) return;

  if (typeof api.onStateChange === "function") {
    api.onStateChange((state) => {
      if (!isErrorResponse(state)) {
        store.uiUrl = state?.uiUrl || "";
        store.versions = Array.isArray(state?.versions) ? state.versions : [];
        store.retainedInstances = Array.isArray(state?.retainedInstances) ? state.retainedInstances : [];
        store.remoteInstances = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
        store.storage = state?.storage || null;
        store.portPreferences = state?.portPreferences || null;
        store.retentionPolicy = state?.retentionPolicy || null;
        emitState();
      }
    });
  }

  if (typeof api.onProgress === "function") {
    api.onProgress((progress) => {
      store.progress = progress && typeof progress === "object" ? progress : null;
      emitState();
    });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadMeta();
  await loadHeaderLogo();
  emitState();
  initSubscriptions();
  await refresh();
});
