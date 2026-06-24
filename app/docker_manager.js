import { dockerManagerStore as store } from "./components/docker-manager/docker-manager-store.js";
import {
  buildInstanceEnvText,
  defaultInstanceName,
  normalizeInstanceDefaults
} from "./components/docker-manager/instance-defaults.js";
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
  dismiss.className = "dm-toast-dismiss dm-close-button";
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

const shownWorkspacePersistedOps = new Set();
const shownBackgroundOperationFailures = new Set();
let workspacePersistedDialogKeyHandler = null;

function cleanDialogText(value, fallback = "") {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (text || fallback).slice(0, 160);
}

function migrationDisplayName(name, containerName, fallback) {
  const label = cleanDialogText(name, fallback);
  const dockerName = cleanDialogText(containerName);
  if (dockerName && dockerName !== label) return `${label} (${dockerName})`;
  return label;
}

function removeWorkspacePersistedDialog() {
  if (workspacePersistedDialogKeyHandler) {
    document.removeEventListener("keydown", workspacePersistedDialogKeyHandler);
    workspacePersistedDialogKeyHandler = null;
  }
  document.getElementById("workspacePersistedDialog")?.remove();
}

function showWorkspacePersistedDialog(progress = {}) {
  const opId = cleanDialogText(progress?.opId);
  if (!opId || shownWorkspacePersistedOps.has(opId)) return;
  shownWorkspacePersistedOps.add(opId);

  const migration = progress?.workspaceMigration && typeof progress.workspaceMigration === "object"
    ? progress.workspaceMigration
    : {};
  const mountTarget = cleanDialogText(migration.mountTarget, "/a0/usr");
  const replacement = migrationDisplayName(
    migration.replacementName,
    migration.replacementContainerName,
    "the new persistent Instance"
  );
  const source = migrationDisplayName(
    migration.sourceName,
    migration.sourceContainerName,
    "the old ephemeral Instance"
  );

  removeWorkspacePersistedDialog();

  const backdrop = document.createElement("div");
  backdrop.id = "workspacePersistedDialog";
  backdrop.className = "dm-dialog-backdrop dm-workspace-persisted-backdrop";
  backdrop.setAttribute("role", "presentation");

  const dialog = document.createElement("div");
  dialog.className = "dm-dialog dm-workspace-persisted-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "workspacePersistedTitle");

  const header = document.createElement("div");
  header.className = "dm-dialog-header";
  const title = document.createElement("h2");
  title.id = "workspacePersistedTitle";
  title.className = "dm-dialog-title";
  title.textContent = "a0/usr data persisted";
  header.appendChild(title);

  const body = document.createElement("div");
  body.className = "dm-dialog-body";
  const summary = document.createElement("p");
  summary.className = "dm-dialog-copy";
  summary.textContent = `Open ${replacement} and check that your ${mountTarget} files are present.`;
  const next = document.createElement("p");
  next.className = "dm-dialog-copy";
  next.textContent = `When everything looks right, ${source} can be safely deleted.`;
  const reminder = document.createElement("p");
  reminder.className = "dm-field-hint";
  reminder.textContent = "The old Instance was kept running so you can compare before deleting it.";
  body.appendChild(summary);
  body.appendChild(next);
  body.appendChild(reminder);

  const footer = document.createElement("div");
  footer.className = "dm-dialog-footer";
  const spacer = document.createElement("span");
  const ok = document.createElement("button");
  ok.className = "button confirm";
  ok.type = "button";
  ok.textContent = "OK";
  const close = () => {
    removeWorkspacePersistedDialog();
  };
  const keyHandler = (event) => {
    if (event.key === "Escape") close();
  };
  workspacePersistedDialogKeyHandler = keyHandler;
  ok.addEventListener("click", close);
  footer.appendChild(spacer);
  footer.appendChild(ok);

  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  document.addEventListener("keydown", keyHandler);
  window.setTimeout(() => ok.focus(), 0);
}

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
    backgroundOperations: Array.isArray(store.backgroundOperations) ? store.backgroundOperations : [],
    volumes: Array.isArray(store.volumes) ? store.volumes : [],
    retainedInstances: Array.isArray(store.retainedInstances) ? store.retainedInstances : [],
    storage: store.storage || null,
    runtime: store.runtime || null,
    runtimeDiagnostics: store.runtimeDiagnostics || null,
    progress: store.progress || null,
    portPreferences: store.portPreferences || null,
    instanceDefaults: normalizeInstanceDefaults(store.instanceDefaults),
    cli: store.cli || { installed: false, command: "" },
    retentionPolicy: store.retentionPolicy || null,
    instanceTabs: store.instanceTabs || { tabs: [], activeTabId: "" }
  };
}

function backgroundOperationFailureLabel(operation = {}) {
  if (operation.type === "start") return "Start failed";
  if (operation.type === "stop") return "Stop failed";
  if (operation.type === "delete_instance") return "Delete failed";
  return "Instance action failed";
}

function notifyBackgroundOperationFailures(state = {}) {
  const operations = Array.isArray(state?.backgroundOperations) ? state.backgroundOperations : [];
  for (const operation of operations) {
    const opId = typeof operation?.opId === "string" ? operation.opId : "";
    if (!opId || operation.status !== "failed" || shownBackgroundOperationFailures.has(opId)) continue;
    shownBackgroundOperationFailures.add(opId);
    const message = typeof operation.error === "string" && operation.error.trim()
      ? operation.error
      : backgroundOperationFailureLabel(operation);
    window.toastFrontendError?.(message, backgroundOperationFailureLabel(operation), 8, `dm-bg-op-${opId}`);
  }
}

function emitState() {
  const next = snapshot();
  window.__dmLastState = next;
  window.dispatchEvent(new CustomEvent("dm:state", { detail: next }));
  notifyBackgroundOperationFailures(next);
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

function upsertRemoteInstance(remote = null) {
  if (!remote || typeof remote !== "object") return;
  const id = typeof remote.id === "string" ? remote.id.trim() : "";
  const url = typeof remote.url === "string" ? remote.url.trim() : "";
  if (!id || !url) return;
  const current = Array.isArray(store.remoteInstances) ? store.remoteInstances : [];
  store.remoteInstances = [
    ...current.filter((item) => item?.id !== id),
    remote
  ];
}

async function loadMeta() {
  try {
    const v = await window.electronAPI?.getContentVersion?.();
    store.meta.contentVersion = v || "";
  } catch {
    store.meta.contentVersion = "";
  }

  try {
    const v = await window.electronAPI?.getAppVersion?.();
    store.meta.appVersion = v || "";
  } catch {
    store.meta.appVersion = "";
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
      store.backgroundOperations = Array.isArray(state?.backgroundOperations) ? state.backgroundOperations : [];
      store.storage = state?.storage || null;
      store.runtime = state?.runtime || null;
      store.runtimeDiagnostics = state?.runtimeDiagnostics || store.runtimeDiagnostics || null;
      store.portPreferences = state?.portPreferences || null;
      store.storagePreferences = state?.storagePreferences || null;
      store.instanceDefaults = state?.instanceDefaults || null;
      store.cli = state?.cli || { installed: false, command: "" };
      store.retentionPolicy = state?.retentionPolicy || null;
      if (!store.error) setBanner("", "");
    }

    store.dockerAvailable = !!inventory?.dockerAvailable;
    store.environment = inventory?.environment || null;
    store.runtime = state?.runtime || inventory?.runtime || null;
    store.runtimeDiagnostics = inventory?.runtimeDiagnostics || state?.runtimeDiagnostics || null;
    store.images = Array.isArray(inventory?.images) ? inventory.images : [];
    store.containers = Array.isArray(inventory?.containers) ? inventory.containers : [];
    if (Array.isArray(inventory?.remoteInstances)) store.remoteInstances = inventory.remoteInstances;
    if (Array.isArray(inventory?.backgroundOperations)) store.backgroundOperations = inventory.backgroundOperations;
    store.volumes = Array.isArray(inventory?.volumes) ? inventory.volumes : [];
  } catch (e) {
    store.error = e?.message || "Failed to load Docker inventory.";
    store.dockerAvailable = false;
    setBanner("error", store.error);
  } finally {
    store.loading = false;
    store.stateLoaded = true;
    emitState();
    maybeStartPendingFirstInstanceFromState(snapshot());
  }
}

const NAV_REFRESH_TABS = new Set(["installs", "sessions", "advanced"]);
const INSTANCE_TAB = "sessions";
let navRefreshTimer = 0;
const handledRunCompletionOps = new Set();

function scheduleNavRefresh(tab) {
  if (!NAV_REFRESH_TABS.has(tab)) return;
  window.clearTimeout(navRefreshTimer);
  navRefreshTimer = window.setTimeout(() => {
    navRefreshTimer = 0;
    refresh();
  }, 0);
}

function navigateToInstancesAfterRun(progress = null) {
  const type = typeof progress?.type === "string" ? progress.type : "";
  const status = typeof progress?.status === "string" ? progress.status : "";
  const opId = typeof progress?.opId === "string" ? progress.opId.trim() : "";
  if (type !== "activate" || status !== "completed" || progress?.uiReady !== true || !opId) return;
  if (handledRunCompletionOps.has(opId)) return;
  handledRunCompletionOps.add(opId);
  window.dispatchEvent(new CustomEvent("dm:navigate", {
    detail: { tab: INSTANCE_TAB, userInitiated: false, source: "run-completed" }
  }));
  scheduleNavRefresh(INSTANCE_TAB);
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

function resourceLinkLabel(id) {
  if (id === "docs") return "Docs";
  if (id === "apiDashboard") return "API Dashboard";
  if (id === "support") return "Support";
  return "resource";
}

async function openResourceLink(id = "") {
  const linkId = typeof id === "string" ? id.trim() : "";
  const api = window.dockerManagerAPI;
  if (!api || typeof api.openResourceLink !== "function") {
    if (linkId === "apiDashboard") return openHomepage();
    setBanner("error", `Unable to open ${resourceLinkLabel(linkId)}`);
    return;
  }
  try {
    const res = await api.openResourceLink(linkId);
    if (isErrorResponse(res)) setBanner("error", res.message);
  } catch (e) {
    setBanner("error", e?.message || `Unable to open ${resourceLinkLabel(linkId)}`);
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

async function setStoragePreferences(preferences = {}) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.setStoragePreferences !== "function") return null;
  const payload = preferences && typeof preferences === "object" ? preferences : {};
  const result = await api.setStoragePreferences(payload);
  if (isErrorResponse(result)) {
    setBanner("error", result.message || "Unable to save workspace storage preferences.");
    return null;
  }
  store.storagePreferences = result || store.storagePreferences;
  setBanner("success", "Workspace storage preferences saved.");
  emitState();
  return result;
}

async function migrateLocalInstanceStorage(containerId, options = {}) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.migrateLocalInstanceStorage !== "function") return null;
  return runDockerOperation(
    "Persist a0/usr data",
    () => api.migrateLocalInstanceStorage(containerId, options),
    "Persisting /a0/usr data."
  );
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
    "Runtime Setup",
    () => api.provisionRuntime(),
    "Runtime Setup requested."
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

async function removeInstalledImage(tag) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.removeInstalledImage !== "function") return false;
  try {
    const res = await api.removeInstalledImage(tag || "");
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("success", "Install removed.");
    await refresh();
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to remove install");
    return false;
  }
}

const FIRST_INSTANCE_RUN_KEY = "a0Launcher.pendingFirstInstanceRun.v1";
const FIRST_INSTANCE_RUN_TTL_MS = 24 * 60 * 60 * 1000;

const handledFirstInstanceRunOps = new Set();

function normalizeWorkspaceStorageMode(value) {
  const mode = typeof value === "string" ? value.trim() : "";
  return mode === "host_directory" || mode === "named_volume" || mode === "ephemeral" ? mode : "";
}

function storageAvailable() {
  try {
    return typeof window.localStorage?.getItem === "function";
  } catch {
    return false;
  }
}

function normalizePendingFirstInstanceRun(value) {
  const input = value && typeof value === "object" ? value : {};
  const opId = typeof input.opId === "string" ? input.opId.trim() : "";
  const targetTag = typeof input.targetTag === "string" ? input.targetTag.trim() : "";
  if (!opId || !targetTag) return null;

  const now = Date.now();
  const createdAtMs = Number(input.createdAtMs);
  const createdAt = Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : now;
  if (now - createdAt > FIRST_INSTANCE_RUN_TTL_MS) return null;

  const pending = {
    opId,
    targetTag,
    instanceName: typeof input.instanceName === "string" ? input.instanceName.trim() : "",
    storageMode: normalizeWorkspaceStorageMode(input.storageMode),
    readyToRun: input.readyToRun === true,
    createdAtMs: createdAt
  };
  return pending;
}

function loadPendingFirstInstanceRun() {
  if (!storageAvailable()) return null;
  try {
    const pending = normalizePendingFirstInstanceRun(JSON.parse(window.localStorage.getItem(FIRST_INSTANCE_RUN_KEY) || "null"));
    if (!pending) window.localStorage.removeItem(FIRST_INSTANCE_RUN_KEY);
    return pending;
  } catch {
    try {
      window.localStorage.removeItem(FIRST_INSTANCE_RUN_KEY);
    } catch {
      // ignore
    }
    return null;
  }
}

function savePendingFirstInstanceRun(pending) {
  if (!storageAvailable()) return;
  try {
    if (!pending) {
      window.localStorage.removeItem(FIRST_INSTANCE_RUN_KEY);
      return;
    }
    const stored = {
      opId: pending.opId,
      targetTag: pending.targetTag,
      instanceName: pending.instanceName || "",
      storageMode: pending.storageMode || "",
      readyToRun: pending.readyToRun === true,
      createdAtMs: pending.createdAtMs || Date.now()
    };
    window.localStorage.setItem(FIRST_INSTANCE_RUN_KEY, JSON.stringify(stored));
  } catch {
    // Best-effort only; the in-memory copy still covers the current renderer.
  }
}

let pendingFirstInstanceRun = loadPendingFirstInstanceRun();

function hasLocalInstance(state = {}) {
  return Array.isArray(state?.containers) && state.containers.some((container) =>
    (typeof container?.containerId === "string" && container.containerId.trim()) ||
    (typeof container?.containerName === "string" && container.containerName.trim())
  );
}

function stateHasInstalledTag(state = {}, targetTag = "") {
  const tag = typeof targetTag === "string" ? targetTag.trim() : "";
  if (!tag) return false;

  const versions = Array.isArray(state?.versions) ? state.versions : [];
  if (versions.some((version) => {
    if (version?.id !== tag) return false;
    if (version?.isActive === true) return true;
    return ["installed", "update_available"].includes(version?.availability);
  })) {
    return true;
  }

  return Array.isArray(state?.images) && state.images.some((image) => image?.tag === tag);
}

async function setInstanceDefaults(instanceDefaults, options = {}) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.setInstanceDefaults !== "function") return false;
  try {
    const defaults = normalizeInstanceDefaults(instanceDefaults);
    const envResult = buildInstanceEnvText(defaults);
    if (!envResult.ok) {
      setBanner("error", envResult.message);
      return false;
    }
    const res = await api.setInstanceDefaults(defaults);
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    store.instanceDefaults = normalizeInstanceDefaults(res);
    if (!options?.quiet) setBanner("info", "Instance defaults saved.");
    emitState();
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Failed to save Instance defaults");
    return false;
  }
}

async function confirmFirstInstanceSetup(payload = {}) {
  const input = payload && typeof payload === "object" ? payload : {};
  const defaults = normalizeInstanceDefaults(input.instanceDefaults || input.defaults);
  const envResult = buildInstanceEnvText(defaults);
  if (!envResult.ok) {
    setBanner("error", envResult.message);
    return false;
  }

  const ok = await setInstanceDefaults(defaults, { quiet: true });
  if (!ok) return false;

  const opId = typeof input.opId === "string" ? input.opId.trim() : "";
  const targetTag = typeof input.targetTag === "string" ? input.targetTag.trim() : "";
  if (input.runFirstInstance === true && opId && targetTag) {
    pendingFirstInstanceRun = {
      opId,
      targetTag,
      instanceName: typeof input.instanceName === "string" ? input.instanceName.trim() : "",
      storageMode: normalizeWorkspaceStorageMode(input.storageMode),
      instanceDefaults: defaults,
      readyToRun: false,
      createdAtMs: Date.now()
    };
    savePendingFirstInstanceRun(pendingFirstInstanceRun);
    setBanner("info", "Defaults saved. Your first Instance will start when the download finishes.");
  } else {
    if (pendingFirstInstanceRun?.opId === opId) {
      pendingFirstInstanceRun = null;
      savePendingFirstInstanceRun(null);
    }
    setBanner("info", "Instance defaults saved.");
  }
  return true;
}

function skipFirstInstanceSetup(payload = {}) {
  const opId = typeof payload?.opId === "string" ? payload.opId.trim() : "";
  if (opId && pendingFirstInstanceRun?.opId === opId) {
    pendingFirstInstanceRun = null;
    savePendingFirstInstanceRun(null);
  }
  return true;
}

async function startPendingFirstInstance(progress = null, startOptions = {}) {
  const opId = typeof progress?.opId === "string" ? progress.opId.trim() : "";
  const pending = pendingFirstInstanceRun;
  if (!pending) return;
  if (pending.readyToRun !== true) return;
  if (opId && pending.opId !== opId) return;
  if (!opId && startOptions?.allowInstalledState !== true) return;

  const runKey = opId || `installed:${pending.opId}:${pending.targetTag}`;
  if (handledFirstInstanceRunOps.has(runKey)) return;
  handledFirstInstanceRunOps.add(runKey);
  pendingFirstInstanceRun = null;
  savePendingFirstInstanceRun(null);

  const targetTag = pending.targetTag || (typeof progress?.targetTag === "string" ? progress.targetTag.trim() : "");
  if (!targetTag) {
    handledFirstInstanceRunOps.delete(runKey);
    return;
  }

  const defaults = normalizeInstanceDefaults(pending.instanceDefaults || store.instanceDefaults);
  const envResult = buildInstanceEnvText(defaults);
  if (!envResult.ok) {
    setBanner("error", envResult.message);
    handledFirstInstanceRunOps.delete(runKey);
    return;
  }

  const state = snapshot();
  const options = {
    instanceName: pending.instanceName || defaultInstanceName(targetTag, state),
    portMappings: "0:80",
    envText: envResult.value || "",
    dataLossAck: "proceed_without_backup"
  };
  if (pending.storageMode) options.storageMode = pending.storageMode;

  const res = await activateTag(targetTag, options);
  if (isErrorResponse(res)) {
    pendingFirstInstanceRun = pending;
    savePendingFirstInstanceRun(pending);
    handledFirstInstanceRunOps.delete(runKey);
  }
}

function clearPendingFirstInstanceRun(progress = null) {
  const opId = typeof progress?.opId === "string" ? progress.opId.trim() : "";
  if (opId && pendingFirstInstanceRun?.opId === opId) {
    pendingFirstInstanceRun = null;
    savePendingFirstInstanceRun(null);
  }
}

function finishFirstInstanceSetup(payload = {}) {
  const opId = typeof payload?.opId === "string" ? payload.opId.trim() : "";
  if (opId && pendingFirstInstanceRun?.opId === opId) {
    pendingFirstInstanceRun = {
      ...pendingFirstInstanceRun,
      readyToRun: true
    };
    savePendingFirstInstanceRun(pendingFirstInstanceRun);
    maybeStartPendingFirstInstanceFromState(snapshot());
  }
  return true;
}

function maybeStartPendingFirstInstanceFromState(state = {}) {
  const pending = pendingFirstInstanceRun;
  if (!pending?.targetTag) return;
  if (hasLocalInstance(state)) {
    pendingFirstInstanceRun = null;
    savePendingFirstInstanceRun(null);
    return;
  }

  const progress = state?.progress || null;
  if (progress?.status === "running") return;
  if (!stateHasInstalledTag(state, pending.targetTag)) return;

  startPendingFirstInstance(null, { allowInstalledState: true }).catch((e) => {
    setBanner("error", e?.message || "Unable to start the first Instance");
  });
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
    if (res?.background === true) {
      const queuedMessage = `${label} queued.`;
      setBanner("info", res?.queued ? queuedMessage : successMessage);
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

async function startLocalInstance(containerId) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.startLocalInstance !== "function") return startActive();
  return runDockerOperation(
    "Start",
    () => api.startLocalInstance(containerId || ""),
    "Instance start requested."
  );
}

async function cloneLocalInstance(containerId, options = {}) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.cloneLocalInstance !== "function") return false;
  const payload = options && typeof options === "object" ? options : {};
  const res = await runDockerOperation(
    "Clone",
    () => api.cloneLocalInstance(containerId || "", payload),
    "Clone requested."
  );
  return !isErrorResponse(res);
}

async function backupLocalInstance(containerId) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.backupLocalInstance !== "function") return false;
  try {
    const res = await api.backupLocalInstance(containerId || "");
    if (res?.canceled) return false;
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("info", "Backup requested.");
    await refresh();
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to start backup");
    return false;
  }
}

async function restoreLocalInstance(containerId) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.restoreLocalInstance !== "function") return false;
  try {
    const res = await api.restoreLocalInstance(containerId || "");
    if (res?.canceled) return false;
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("info", "Restore requested.");
    await refresh();
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to start restore");
    return false;
  }
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

async function renameLocalInstance(containerId, name) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.renameLocalInstance !== "function") return false;
  try {
    const res = await api.renameLocalInstance(containerId || "", name || "");
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("info", "Instance renamed.");
    await refresh();
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to rename instance");
    return false;
  }
}

async function setLocalInstanceColor(containerId, color) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.setLocalInstanceColor !== "function") return false;
  try {
    const res = await api.setLocalInstanceColor(containerId || "", color || "");
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("info", "Instance color saved.");
    await refresh();
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to save instance color");
    return false;
  }
}

async function getLocalInstanceLogs(containerId, options = {}) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.getLocalInstanceLogs !== "function") return null;
  try {
    const res = await api.getLocalInstanceLogs(containerId || "", options && typeof options === "object" ? options : {});
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return null;
    }
    return res && typeof res === "object" ? res : null;
  } catch (e) {
    setBanner("error", e?.message || "Unable to load logs");
    return null;
  }
}

async function openLocalInstanceStorageFolder(containerId) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.openLocalInstanceStorageFolder !== "function") return false;
  try {
    const res = await api.openLocalInstanceStorageFolder(containerId || "");
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("info", "Storage folder opened.");
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to open storage folder");
    return false;
  }
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

async function runCustomImage(options = {}) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.runCustomImage !== "function") return false;
  const payload = options && typeof options === "object" ? options : {};
  const res = await runDockerOperation(
    "Run custom image",
    () => api.runCustomImage(payload),
    "Developer image run requested."
  );
  return !isErrorResponse(res);
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
    if (res?.canceled) return false;
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

async function installCli() {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.installCli !== "function") return false;
  try {
    const res = await api.installCli();
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("info", "A0 CLI installer opened.");
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to open A0 CLI installer");
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
    upsertRemoteInstance(res);
    setBanner("info", "Remote Instance added.");
    await refresh();
    return res || true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to add remote Instance");
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

async function renameRemoteInstance(id, name) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.renameRemoteInstance !== "function") return false;
  try {
    const res = await api.renameRemoteInstance(id || "", name || "");
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("info", "Remote instance renamed.");
    await refresh();
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to rename remote instance");
    return false;
  }
}

async function setRemoteInstanceColor(id, color) {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.setRemoteInstanceColor !== "function") return false;
  try {
    const res = await api.setRemoteInstanceColor(id || "", color || "");
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return false;
    }
    setBanner("info", "Instance color saved.");
    await refresh();
    return true;
  } catch (e) {
    setBanner("error", e?.message || "Unable to save instance color");
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
  openResourceLink,
  removeVolume,
  pruneVolumes,
  openDockerDownload,
  provisionRuntime,
  selectRuntimeEndpoint,
  installOrSync,
  removeInstalledImage,
  startActive,
  startLocalInstance,
  cloneLocalInstance,
  backupLocalInstance,
  restoreLocalInstance,
  migrateLocalInstanceStorage,
  renameLocalInstance,
  setLocalInstanceColor,
  stopActive,
  stopLocalInstance,
  deleteLocalInstance,
  getLocalInstanceLogs,
  openLocalInstanceStorageFolder,
  activateTag,
  runCustomImage,
  setStoragePreferences,
  openCliTerminal,
  installCli,
  openDockerLoginTerminal,
  retryInstall,
  cancelOperation,
  confirmFirstInstanceSetup,
  skipFirstInstanceSetup,
  finishFirstInstanceSetup,
  addRemoteInstance,
  deleteRemoteInstance,
  renameRemoteInstance,
  setRemoteInstanceColor,
  openRemoteInstance,
  openInstanceUi,
  selectInstanceHome,
  selectInstanceTab,
  closeInstanceTab,
  reloadInstanceTab,
  detachInstanceTab,
  syncInstanceTabBounds,
  setInstanceDefaults,
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
        if (Array.isArray(state?.containers)) store.containers = state.containers;
        store.retainedInstances = Array.isArray(state?.retainedInstances) ? state.retainedInstances : [];
        store.remoteInstances = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
        store.backgroundOperations = Array.isArray(state?.backgroundOperations) ? state.backgroundOperations : [];
        store.storage = state?.storage || null;
        store.runtime = state?.runtime || null;
        store.runtimeDiagnostics = state?.runtimeDiagnostics || store.runtimeDiagnostics || null;
        store.portPreferences = state?.portPreferences || null;
        store.instanceDefaults = state?.instanceDefaults || null;
        store.cli = state?.cli || { installed: false, command: "" };
        store.retentionPolicy = state?.retentionPolicy || null;
        emitState();
        maybeStartPendingFirstInstanceFromState(snapshot());
      }
    });
  }

  if (typeof api.onProgress === "function") {
    api.onProgress((progress) => {
      store.progress = progress && typeof progress === "object" ? progress : null;
      emitState();
      const status = typeof progress?.status === "string" ? progress.status : "";
      if (status === "completed" || status === "failed" || status === "canceled") {
        if (progress?.type === "install" && status === "completed") {
          startPendingFirstInstance(progress).catch((e) => {
            setBanner("error", e?.message || "Unable to start the first Instance");
          });
        } else if (progress?.type === "install") {
          clearPendingFirstInstanceRun(progress);
        }
        if (progress?.type === "migrate_workspace" && status === "completed") {
          showWorkspacePersistedDialog(progress);
        }
        navigateToInstancesAfterRun(progress);
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

function initNavigationRefresh() {
  window.addEventListener("dm:nav", (event) => {
    const detail = event?.detail && typeof event.detail === "object" ? event.detail : {};
    if (!detail.userInitiated) return;
    scheduleNavRefresh(detail.tab || "");
  });
}

function initResourceFooter() {
  document.querySelectorAll("[data-resource-link]").forEach((button) => {
    if (button.dataset.boundResourceLink) return;
    button.dataset.boundResourceLink = "1";
    button.addEventListener("click", () => {
      window.dockerManagerActions?.openResourceLink?.(button.dataset.resourceLink || "");
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadMeta();
  emitState();
  initSubscriptions();
  initNavigationRefresh();
  initResourceFooter();
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
