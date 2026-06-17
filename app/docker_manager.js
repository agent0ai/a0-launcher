import { dockerManagerStore as store } from "./components/docker-manager/docker-manager-store.js";
import { renderOperationDialog } from "./components/docker-manager/operation-modal/operation-modal.js";
import { renderRuntimeGate } from "./components/docker-manager/runtime-gate/runtime-gate.js";

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
    stateLoaded: !!store.stateLoaded,
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
    runtime: store.runtime || null,
    progress: store.progress || null,
    portPreferences: store.portPreferences || null,
    retentionPolicy: store.retentionPolicy || null,
    instanceTabs: store.instanceTabs || { tabs: [], activeTabId: "" }
  };
}

function emitState() {
  const next = snapshot();
  window.__dmLastState = next;
  window.dispatchEvent(new CustomEvent("dm:state", { detail: next }));
  renderRuntimeGate(next, window.dockerManagerActions || {});
  renderOperationDialog(next, window.dockerManagerActions || {});
}

function applyInstanceTabsSnapshot(snap) {
  const tabs = Array.isArray(snap?.tabs) ? snap.tabs : [];
  store.instanceTabs = {
    tabs,
    activeTabId: typeof snap?.activeTabId === "string" ? snap.activeTabId : ""
  };
  emitState();
}

function localUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return "";
    return url.toString();
  } catch {
    return "";
  }
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
    store.stateLoaded = true;
    setBanner("error", store.error);
    return;
  }

  store.loading = true;
  store.error = "";
  emitState();

  try {
    const stateRequest = typeof api.refresh === "function"
      ? api.refresh()
      : typeof api.getState === "function" ? api.getState() : null;
    const [inventory, state] = await Promise.all([
      typeof api.getInventory === "function" ? api.getInventory() : null,
      stateRequest
    ]);

    if (isErrorResponse(inventory)) {
      store.error = inventory.message;
      store.dockerAvailable = false;
      store.stateLoaded = true;
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
      store.runtime = state?.runtime || null;
      store.portPreferences = state?.portPreferences || null;
      store.retentionPolicy = state?.retentionPolicy || null;
      if (!store.error) setBanner("", "");
    }

    store.dockerAvailable = !!inventory?.dockerAvailable;
    store.environment = inventory?.environment || null;
    store.runtime = state?.runtime || inventory?.runtime || null;
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
    store.stateLoaded = true;
    emitState();
  }
}

async function openInstanceUi(target = {}) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.openInstanceUi !== "function") {
    if (api && target?.kind === "remote" && typeof api.openRemoteInstance === "function") {
      const res = await api.openRemoteInstance(target.instanceId || "");
      if (isErrorResponse(res)) setBanner("error", res.message);
      return;
    }
    if (api && target?.kind === "local") {
      const fn = target.containerId && typeof api.openContainerUi === "function"
        ? () => api.openContainerUi(target.containerId)
        : typeof api.openUi === "function" ? () => api.openUi() : null;
      if (fn) {
        const res = await fn();
        if (isErrorResponse(res)) setBanner("error", res.message);
      }
    }
    return;
  }
  try {
    const payload = target && typeof target === "object" ? target : {};
    const res = await api.openInstanceUi(payload);
    if (isErrorResponse(res)) setBanner("error", res.message);
    else if (res?.opened && !res?.focusedExisting) {
      window.toastFrontendInfo?.("Instance UI opened.", "Agent Zero", 2, "dm-open-ui");
    }
  } catch (e) {
    setBanner("error", e?.message || "Unable to open UI");
  }
}

async function openUi(containerId = "") {
  return openInstanceUi({ kind: "local", containerId: containerId || "" });
}

async function selectInstanceTab(id) {
  await window.dockerManagerAPI?.selectInstanceTab?.(id);
}

async function selectInstanceHome() {
  await window.dockerManagerAPI?.selectInstanceHome?.();
}

async function closeInstanceTab(id) {
  await window.dockerManagerAPI?.closeInstanceTab?.(id);
}

async function reloadInstanceTab(id) {
  await window.dockerManagerAPI?.reloadInstanceTab?.(id);
}

async function detachInstanceTab(id) {
  await window.dockerManagerAPI?.detachInstanceTab?.(id);
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

async function openDockerDownload(url = "") {
  const targetUrl = typeof url === "string" && /^https?:\/\//i.test(url)
    ? url
    : "https://www.docker.com/products/docker-desktop/";
  const api = window.dockerManagerAPI;
  if (!url && api && typeof api.installDocker === "function") {
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
  window.open(targetUrl, "_blank");
}

async function provisionRuntime() {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.provisionRuntime !== "function") {
    return openDockerDownload();
  }

  return runDockerOperation(
    "Runtime setup",
    () => api.provisionRuntime(),
    "Runtime setup requested."
  );
}

async function selectRuntimeEndpoint(id) {
  const api = window.dockerManagerAPI;
  const endpointId = typeof id === "string" ? id.trim() : "";
  if (!endpointId) return true;
  if (!api || typeof api.selectRuntimeEndpoint !== "function") return false;
  try {
    const res = await api.selectRuntimeEndpoint(endpointId);
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to select runtime");
    return false;
  }
}

async function installOrSync(tag) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.installOrSync !== "function") return;
  return runDockerOperation(
    "Install",
    () => api.installOrSync(tag),
    "Install requested."
  );
}

let postOperationRefreshTimer = 0;
let postOperationRefreshTimers = [];

function clearPostOperationRefreshTimers() {
  window.clearTimeout(postOperationRefreshTimer);
  postOperationRefreshTimer = 0;
  for (const timer of postOperationRefreshTimers) {
    window.clearTimeout(timer);
  }
  postOperationRefreshTimers = [];
}

function schedulePostOperationRefresh(progress = null) {
  clearPostOperationRefreshTimers();
  const isCompletedInstall = progress?.type === "install" && progress?.status === "completed";
  const delays = isCompletedInstall ? [350, 1500, 3500] : [350];
  postOperationRefreshTimers = delays.map((delay, index) => window.setTimeout(() => {
    if (index === 0) postOperationRefreshTimer = 0;
    refresh();
  }, delay));
  postOperationRefreshTimer = postOperationRefreshTimers[0] || 0;
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

async function stopLocalInstance(containerId) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.stopLocalInstance !== "function") return stopActive();
  return runDockerOperation(
    "Stop",
    () => api.stopLocalInstance(containerId || ""),
    "Instance stop requested."
  );
}

async function deleteLocalInstance(containerId) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.deleteLocalInstance !== "function") return false;
  const res = await runDockerOperation(
    "Delete",
    () => api.deleteLocalInstance(containerId || ""),
    "Instance delete requested."
  );
  return !isErrorResponse(res);
}

async function activateTag(tag, options = {}) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.activateTag !== "function") return;
  const payload = options && typeof options === "object" ? options : {};
  const dataLossAck = payload.dataLossAck || "proceed_without_backup";
  return runDockerOperation(
    "Run",
    () => api.activateTag(tag, dataLossAck, payload),
    "Instance run requested."
  );
}

async function openCliTerminal(host = "") {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.openCliTerminal !== "function") return;
  const target = localUrl(host);
  if (!target) {
    setBanner("error", "Open the A0 CLI from a running local instance.");
    return false;
  }
  try {
    const res = await api.openCliTerminal(target);
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("info", "A0 CLI terminal opened.");
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to open A0 CLI terminal");
    return false;
  }
}

async function openDockerLoginTerminal() {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.openDockerLoginTerminal !== "function") return false;
  try {
    const res = await api.openDockerLoginTerminal();
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    const target = typeof res?.command === "string" && res.command ? ` in ${res.command}` : "";
    setBanner("info", `Docker login opened${target}. Finish sign-in, then click Retry.`);
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to open a Docker login terminal");
    return false;
  }
}

async function retryInstall(tag = "") {
  const targetTag = typeof tag === "string" ? tag.trim() : "";
  if (!targetTag) {
    setBanner("error", "Choose a version to install.");
    return false;
  }
  await installOrSync(targetTag);
  return true;
}

async function cancelOperation(opId = "") {
  const api = window.dockerManagerAPI;
  const id = typeof opId === "string" ? opId.trim() : "";
  if (!api || typeof api.cancel !== "function" || !id) return false;
  try {
    const res = await api.cancel(id);
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    if (!res?.canceled) {
      setBanner("warning", "This operation cannot be canceled right now.");
      return false;
    }
    setBanner("info", "Cancel requested.");
    return !!res?.canceled;
  } catch (e) {
    setBanner("error", e?.message || "Unable to cancel the current operation");
    return false;
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
  return openInstanceUi({ kind: "remote", instanceId: id || "" });
}

let instanceTabBoundsTimer = 0;

function readInstanceTabViewportBounds() {
  const el = document.getElementById("dmInstanceTabViewport");
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function syncInstanceTabBounds() {
  window.clearTimeout(instanceTabBoundsTimer);
  instanceTabBoundsTimer = window.setTimeout(() => {
    const bounds = readInstanceTabViewportBounds();
    if (bounds) window.dockerManagerAPI?.setInstanceTabBounds?.(bounds);
  }, 40);
}

function initInstanceTabBoundsObserver() {
  const el = document.getElementById("dmInstanceTabViewport");
  if (!el) return;
  syncInstanceTabBounds();
  window.addEventListener("resize", syncInstanceTabBounds);
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(syncInstanceTabBounds);
    observer.observe(el);
  }
}

window.dockerManagerActions = {
  refresh,
  openUi,
  openHomepage,
  removeVolume,
  pruneVolumes,
  openDockerDownload,
  provisionRuntime,
  selectRuntimeEndpoint,
  installOrSync,
  startActive,
  stopActive,
  stopLocalInstance,
  deleteLocalInstance,
  activateTag,
  openCliTerminal,
  openDockerLoginTerminal,
  retryInstall,
  cancelOperation,
  addRemoteInstance,
  deleteRemoteInstance,
  openRemoteInstance,
  openInstanceUi,
  selectInstanceHome,
  selectInstanceTab,
  closeInstanceTab,
  reloadInstanceTab,
  detachInstanceTab,
  syncInstanceTabBounds,
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

function initSubscriptions() {
  const api = window.dockerManagerAPI;
  if (!api) return;

  if (typeof api.onStateChange === "function") {
    api.onStateChange((state) => {
      if (!isErrorResponse(state)) {
        store.stateLoaded = true;
        store.uiUrl = state?.uiUrl || "";
        store.versions = Array.isArray(state?.versions) ? state.versions : [];
        store.retainedInstances = Array.isArray(state?.retainedInstances) ? state.retainedInstances : [];
        store.remoteInstances = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
        store.storage = state?.storage || null;
        store.runtime = state?.runtime || null;
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
      const status = typeof progress?.status === "string" ? progress.status : "";
      if (status === "completed" || status === "failed" || status === "canceled") {
        schedulePostOperationRefresh(progress);
      }
    });
  }

  if (typeof api.onInstanceTabsChange === "function") {
    api.onInstanceTabsChange((tabsSnapshot) => {
      applyInstanceTabsSnapshot(tabsSnapshot);
    });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadMeta();
  await loadHeaderLogo();
  emitState();
  initSubscriptions();
  initInstanceTabBoundsObserver();
  if (typeof window.dockerManagerAPI?.getInstanceTabs === "function") {
    try {
      const tabsSnapshot = await window.dockerManagerAPI.getInstanceTabs();
      if (!isErrorResponse(tabsSnapshot)) applyInstanceTabsSnapshot(tabsSnapshot);
    } catch {
      // ignore; tab state can still arrive through the live subscription
    }
  }
  await refresh();
});
