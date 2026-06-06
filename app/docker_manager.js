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

let lastRuntimeSetupFailureBannerKey = "";
let lastRuntimeSetupFailureMessage = "";

function sanitizeRuntimeSetup(runtimeSetup) {
  const setup = runtimeSetup && typeof runtimeSetup === "object" ? runtimeSetup : {};
  return {
    runtimeBackend: setup.runtimeBackend === "podman" ? "podman" : "",
    machineName: typeof setup.machineName === "string" ? setup.machineName : "",
    hasDockerHostOverride: !!setup.hasDockerHostOverride,
    usesDefaultDockerSocket: !!setup.usesDefaultDockerSocket,
    lastSuccessfulSetupAt: typeof setup.lastSuccessfulSetupAt === "string" ? setup.lastSuccessfulSetupAt : ""
  };
}

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
    runtimeSetup: sanitizeRuntimeSetup(store.runtimeSetup),
    portPreferences: store.portPreferences || null,
    retentionPolicy: store.retentionPolicy || null,
    instanceTabs: store.instanceTabs || { tabs: [], activeTabId: "" }
  };
}

function emitState() {
  const next = snapshot();
  window.__dmLastState = next;
  window.dispatchEvent(new CustomEvent("dm:state", { detail: next }));
  renderTerminalDock(next);
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

function isLauncherActiveContainer(container) {
  return container?.labels?.["a0.launcher.role"] === "active" ||
    String(container?.containerName || "").includes("-active__");
}

function cliHostFromState(state = snapshot()) {
  const managedHost = localUrl(state?.uiUrl);
  if (managedHost) return managedHost;

  const containers = Array.isArray(state?.containers) ? state.containers : [];
  const running = containers
    .filter((container) => String(container?.state || "").toLowerCase() === "running")
    .filter((container) => localUrl(container?.uiUrl))
    .sort((a, b) => Number(isLauncherActiveContainer(b)) - Number(isLauncherActiveContainer(a)));

  return localUrl(running[0]?.uiUrl);
}

function setBanner(type, message) {
  store.setBanner(type || "", message || "");
  if (message) {
    const fn = type === "error" ? window.toastFrontendError : window.toastFrontendInfo;
    fn?.(message, "Agent Zero", type === "error" ? 8 : 3, `dm-${type || "info"}`);
  }
  emitState();
}

function isRuntimeSetupFailureBanner() {
  return !!lastRuntimeSetupFailureMessage &&
    store.banner?.type === "error" &&
    store.banner?.message === lastRuntimeSetupFailureMessage;
}

function clearRuntimeSetupFailureBanner() {
  const shouldClearBanner = isRuntimeSetupFailureBanner();
  lastRuntimeSetupFailureBannerKey = "";
  lastRuntimeSetupFailureMessage = "";
  if (shouldClearBanner) {
    store.setBanner("", "");
  }
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
    const [inventory, state, runtimeSetup] = await Promise.all([
      typeof api.getInventory === "function" ? api.getInventory() : null,
      typeof api.getState === "function" ? api.getState() : null,
      typeof api.getRuntimeSetupState === "function" ? api.getRuntimeSetupState() : null
    ]);

    if (!isErrorResponse(runtimeSetup) && runtimeSetup && typeof runtimeSetup === "object") {
      store.runtimeSetup = sanitizeRuntimeSetup(runtimeSetup);
    }

    if (isErrorResponse(inventory)) {
      store.error = inventory.message;
      store.dockerAvailable = false;
      if (!isRuntimeSetupFailureBanner()) {
        setBanner("error", inventory.message);
      }
      store.loading = false;
      emitState();
      return;
    }

    const inventoryDockerAvailable = !!inventory?.dockerAvailable;
    const refreshSucceeded = !isErrorResponse(state);
    if (refreshSucceeded || inventoryDockerAvailable) {
      clearRuntimeSetupFailureBanner();
    }

    if (isErrorResponse(state)) {
      store.error = state.message;
      if (!isRuntimeSetupFailureBanner()) {
        setBanner("error", state.message);
      }
    } else {
      store.uiUrl = state?.uiUrl || "";
      store.versions = Array.isArray(state?.versions) ? state.versions : [];
      store.retainedInstances = Array.isArray(state?.retainedInstances) ? state.retainedInstances : [];
      store.remoteInstances = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
      store.storage = state?.storage || null;
      store.portPreferences = state?.portPreferences || null;
      store.retentionPolicy = state?.retentionPolicy || null;
      if (!store.error && !isRuntimeSetupFailureBanner()) {
        setBanner("", "");
      }
    }

    store.dockerAvailable = inventoryDockerAvailable;
    store.environment = inventory?.environment || null;
    store.images = Array.isArray(inventory?.images) ? inventory.images : [];
    store.containers = Array.isArray(inventory?.containers) ? inventory.containers : [];
    if (Array.isArray(inventory?.remoteInstances)) store.remoteInstances = inventory.remoteInstances;
    store.volumes = Array.isArray(inventory?.volumes) ? inventory.volumes : [];
  } catch (e) {
    store.error = e?.message || "Failed to load Docker inventory.";
    store.dockerAvailable = false;
    if (!isRuntimeSetupFailureBanner()) {
      setBanner("error", store.error);
    }
  } finally {
    store.loading = false;
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

async function startRuntimeSetup() {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.startRuntimeSetup !== "function") return;
  try {
    const res = await api.startRuntimeSetup();
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return;
    }
    setBanner("info", "Runtime setup started.");
  } catch (e) {
    setBanner("error", e?.message || "Unable to start runtime setup");
  }
}

async function cancelCurrentOperation() {
  const api = window.dockerManagerAPI;
  const opId = store.progress?.opId || "";
  if (!api || !opId || typeof api.cancel !== "function") return;
  try {
    const res = await api.cancel(opId);
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return;
    }
    if (res?.canceled) setBanner("info", "Operation canceled.");
  } catch (e) {
    setBanner("error", e?.message || "Unable to cancel operation");
  }
}

let postOperationRefreshTimer = 0;

function schedulePostOperationRefresh() {
  window.clearTimeout(postOperationRefreshTimer);
  postOperationRefreshTimer = window.setTimeout(() => {
    refresh();
  }, 350);
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
    const res = await api.openCliTerminal(cliHostFromState(snapshot()));
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
  startRuntimeSetup,
  cancelCurrentOperation,
  startActive,
  stopActive,
  activateTag,
  openCliTerminal,
  addRemoteInstance,
  deleteRemoteInstance,
  openRemoteInstance,
  openInstanceUi,
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

let terminalDockOpen = false;
let terminalDockTab = "cli";
let logsContainerId = "";
let logsLines = [];
let logsLinesFor = "";
let logsLoading = false;
let logsError = "";
let lastRenderedLogsFor = "";
let logsRequestSeq = 0;
const LOGS_NEAR_BOTTOM_PX = 24;

function logsContainerOptions(state = snapshot()) {
  const containers = Array.isArray(state?.containers) ? state.containers : [];
  return containers
    .filter((c) => c && typeof c.containerId === "string" && /^[a-f0-9]+$/i.test(c.containerId))
    .map((c) => ({
      id: c.containerId,
      name: c.containerName || c.containerId.slice(0, 12),
      state: String(c.state || "").toLowerCase(),
      active: isLauncherActiveContainer(c)
    }))
    .sort((a, b) => {
      const ar = a.state === "running" ? 1 : 0;
      const br = b.state === "running" ? 1 : 0;
      if (ar !== br) return br - ar;
      return Number(b.active) - Number(a.active);
    });
}

async function loadContainerLogs(id) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.readContainerLogs !== "function" || !id) return;
  // Tag this request so a stale response from a previous container can't
  // overwrite the panel after the user has switched selection.
  const reqSeq = ++logsRequestSeq;
  logsLoading = true;
  logsError = "";
  renderTerminalDock(snapshot());
  try {
    const res = await api.readContainerLogs(id, { maxLines: 1000 });
    if (reqSeq !== logsRequestSeq) return;
    if (isErrorResponse(res)) {
      logsLines = [];
      logsError = res.message;
    } else {
      logsLines = Array.isArray(res?.lines) ? res.lines : [];
      logsError = "";
    }
  } catch (e) {
    if (reqSeq !== logsRequestSeq) return;
    logsLines = [];
    logsError = e?.message || "Failed to load container logs.";
  } finally {
    if (reqSeq === logsRequestSeq) {
      logsLoading = false;
      logsLinesFor = id;
      renderTerminalDock(snapshot());
    }
  }
}

function makeDockTab(icon, label, active, onClick) {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = `dm-terminal-tab${active ? " active" : ""}`;
  const tabIcon = document.createElement("span");
  tabIcon.className = "material-symbols-outlined";
  tabIcon.textContent = icon;
  const tabText = document.createElement("span");
  tabText.textContent = label;
  tab.appendChild(tabIcon);
  tab.appendChild(tabText);
  tab.addEventListener("click", onClick);
  return tab;
}

function renderCliBody(body, cliHost) {
  const note = document.createElement("div");
  note.className = "dm-terminal-note";
  note.textContent = cliHost
    ? "Open the local Agent Zero CLI against this running instance."
    : "Start an instance first, then open the A0 CLI against its local socket.";
  const command = document.createElement("code");
  command.className = "dm-terminal-command";
  command.textContent = cliHost ? `a0 --host ${cliHost}` : "a0";
  body.appendChild(note);
  body.appendChild(command);
}

function renderLogsBody(body, containerOpts) {
  if (!containerOpts.length) {
    const note = document.createElement("div");
    note.className = "dm-terminal-note";
    note.textContent = "No Agent Zero containers found. Start an instance to view its logs.";
    body.appendChild(note);
    return;
  }

  const toolbar = document.createElement("div");
  toolbar.className = "dm-terminal-logs-toolbar";

  const label = document.createElement("span");
  label.className = "dm-terminal-logs-label";
  label.textContent = "Container";

  const select = document.createElement("select");
  select.className = "dm-terminal-logs-select";
  for (const opt of containerOpts) {
    const option = document.createElement("option");
    option.value = opt.id;
    option.textContent = `${opt.name} (${opt.state || "unknown"})`;
    if (opt.id === logsContainerId) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    logsContainerId = select.value;
    logsLines = [];
    logsLinesFor = "";
    logsError = "";
    loadContainerLogs(logsContainerId);
  });

  const refresh = document.createElement("button");
  refresh.className = "button icon-button dm-icon-button";
  refresh.type = "button";
  refresh.title = "Refresh logs";
  refresh.setAttribute("aria-label", "Refresh logs");
  refresh.disabled = logsLoading;
  refresh.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">refresh</span>';
  refresh.addEventListener("click", () => loadContainerLogs(logsContainerId));

  toolbar.appendChild(label);
  toolbar.appendChild(select);
  toolbar.appendChild(refresh);
  body.appendChild(toolbar);

  const logs = document.createElement("pre");
  logs.className = "dm-terminal-logs";
  if (logsLoading) {
    logs.textContent = "Loading logs…";
  } else if (logsError) {
    logs.textContent = logsError;
    logs.classList.add("error");
  } else if (!logsLines.length) {
    logs.textContent = "No log output.";
  } else {
    for (const evt of logsLines) {
      const line = document.createElement("div");
      line.className = `dm-log-line${evt?.stream === "stderr" ? " stderr" : ""}`;
      line.textContent = typeof evt?.line === "string" ? evt.line : "";
      logs.appendChild(line);
    }
  }
  body.appendChild(logs);

  // Auto-load once when the dock is open on the Logs tab and the cache is stale.
  if (terminalDockOpen && logsContainerId && !logsLoading && !logsError &&
    logsLinesFor !== logsContainerId) {
    loadContainerLogs(logsContainerId);
  }
}

function renderTerminalDock(state = snapshot()) {
  const mount = document.getElementById("dmTerminalDock");
  if (!mount) return;
  const cliHost = cliHostFromState(state);
  const containerOpts = logsContainerOptions(state);

  // Keep the selected logs container valid against current inventory.
  if (logsContainerId && !containerOpts.some((o) => o.id === logsContainerId)) {
    logsContainerId = "";
  }
  if (!logsContainerId && containerOpts.length) {
    logsContainerId = containerOpts[0].id;
  }
  if (logsLinesFor && logsLinesFor !== logsContainerId) {
    logsLines = [];
    logsLinesFor = "";
    logsError = "";
  }

  // Capture pre-render scroll state so we can preserve the user's position
  // across the dock's full DOM rebuild (which fires on every dm:state event).
  let prevLogsScrollTop = 0;
  let prevLogsAtBottom = true;
  const prevLogsEl = mount.querySelector(".dm-terminal-logs");
  if (prevLogsEl) {
    prevLogsScrollTop = prevLogsEl.scrollTop;
    prevLogsAtBottom = (prevLogsEl.scrollHeight - prevLogsEl.scrollTop - prevLogsEl.clientHeight)
      < LOGS_NEAR_BOTTOM_PX;
  }

  mount.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = `dm-terminal-shell${terminalDockOpen ? " open" : ""}`;

  const panel = document.createElement("div");
  panel.className = "dm-terminal-panel";

  const tabs = document.createElement("div");
  tabs.className = "dm-terminal-tabs";
  tabs.appendChild(makeDockTab("terminal", "A0 CLI Connector", terminalDockTab === "cli", () => {
    terminalDockTab = "cli";
    renderTerminalDock(snapshot());
  }));
  tabs.appendChild(makeDockTab("article", "Logs", terminalDockTab === "logs", () => {
    terminalDockTab = "logs";
    renderTerminalDock(snapshot());
  }));

  const body = document.createElement("div");
  body.className = "dm-terminal-body";
  if (terminalDockTab === "logs") {
    renderLogsBody(body, containerOpts);
  } else {
    renderCliBody(body, cliHost);
  }

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
  dot.className = `dm-terminal-dot${cliHost ? " connected" : ""}`;
  const statusText = document.createElement("span");
  statusText.textContent = cliHost ? "Instance socket ready" : "No running instance";
  const url = document.createElement("span");
  url.className = "dm-terminal-url";
  url.textContent = cliHost;
  status.appendChild(dot);
  status.appendChild(statusText);
  if (cliHost) status.appendChild(url);

  const launch = document.createElement("button");
  launch.className = "button confirm";
  launch.type = "button";
  launch.disabled = !cliHost;
  launch.title = cliHost ? "Open A0 CLI terminal" : "Start an instance first";
  launch.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">open_in_new</span><span>Open A0 CLI</span>';
  launch.addEventListener("click", () => window.dockerManagerActions?.openCliTerminal?.());

  footer.appendChild(toggle);
  footer.appendChild(status);
  footer.appendChild(launch);

  shell.appendChild(panel);
  shell.appendChild(footer);
  mount.appendChild(shell);

  // Preserve the user's scroll position across the dock rebuild. Only
  // auto-scroll to the newest line when the container changed (fresh load)
  // or when the user was already near the bottom before the rebuild.
  if (terminalDockTab === "logs") {
    const logs = mount.querySelector(".dm-terminal-logs");
    if (logs) {
      const containerChanged = (logsLinesFor || "") !== lastRenderedLogsFor;
      if (containerChanged || prevLogsAtBottom) {
        logs.scrollTop = logs.scrollHeight;
      } else {
        logs.scrollTop = prevLogsScrollTop;
      }
    }
    lastRenderedLogsFor = logsLinesFor || "";
  }
}

function maybeSurfaceRuntimeSetupFailure(progress) {
  const status = typeof progress?.status === "string" ? progress.status : "";
  if (progress?.type !== "runtime_setup") return;
  if (status === "running") {
    lastRuntimeSetupFailureBannerKey = "";
    lastRuntimeSetupFailureMessage = "";
    return;
  }
  if (status === "completed") {
    lastRuntimeSetupFailureBannerKey = "";
    lastRuntimeSetupFailureMessage = "";
    return;
  }
  if (status !== "failed") return;

  const message = String(progress?.error || progress?.message || "Runtime setup failed.").trim()
    || "Runtime setup failed.";
  lastRuntimeSetupFailureMessage = message;
  const key = `${progress?.opId || ""}:${message}`;
  if (key === lastRuntimeSetupFailureBannerKey) return;
  lastRuntimeSetupFailureBannerKey = key;
  setBanner("error", message);
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
      const status = typeof progress?.status === "string" ? progress.status : "";
      if (status === "completed" || status === "failed" || status === "canceled") {
        schedulePostOperationRefresh();
      }
      maybeSurfaceRuntimeSetupFailure(progress);
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
