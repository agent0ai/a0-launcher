import {
  INSTANCE_COLOR_OPTIONS,
  createInstanceVisual,
  normalizedInstanceColorId
} from "../card-visuals.js";
import { openAddRemoteInstanceDialog } from "../remote-instance-dialog.js";
import {
  createLocalInstanceButtonModel,
  openCreateLocalInstanceDialog
} from "../run-instance-dialog.js";

function byId(id) { return document.getElementById(id); }

let logsRequestSeq = 0;

function localUiUrl(value) {
  const raw = String(value || "").trim();
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

function loopbackHost(value) {
  const host = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "127.0.0.1";
  return "";
}

function localLoopbackPortKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    if (!loopbackHost(url.hostname)) return "";
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return "";
  }
}

function localCloneTargetForRemote(remote, containers) {
  const remotePortKey = localLoopbackPortKey(remote?.url);
  if (!remotePortKey) return null;
  return (Array.isArray(containers) ? containers : []).find((container) =>
    container?.containerId && localLoopbackPortKey(container?.uiUrl) === remotePortKey
  ) || null;
}

function tagFromImageRef(value) {
  const raw = String(value || "").trim();
  if (!raw || !raw.includes(":")) return "";
  return raw.slice(raw.lastIndexOf(":") + 1);
}

function runtimeBranch(c) {
  return c?.runtimeBranch || c?.runtimeSource?.branch || "";
}

function runtimeTag(c) {
  return c?.runtimeTag || c?.runtimeSource?.tag || "";
}

function runtimeShortCommit(c) {
  const shortCommit = c?.runtimeShortCommit || c?.runtimeSource?.shortCommit || "";
  if (shortCommit) return shortCommit;
  const commit = c?.runtimeCommit || c?.runtimeSource?.commit || "";
  return commit ? String(commit).slice(0, 12) : "";
}

function imageTagForContainer(c) {
  return c?.versionTag ||
    c?.labels?.["a0.launcher.versionTag"] ||
    c?.tag ||
    tagFromImageRef(c?.imageRef) ||
    "";
}

function releaseTagLabel(tag) {
  return String(tag || "").trim().replace(/^v(?=\d)/i, "");
}

function isReleaseTag(tag) {
  return /^v\d+\.\d+(?:\.\d+)?$/i.test(String(tag || "").trim());
}

function instanceVisualBadge(c) {
  const sourceTag = releaseTagLabel(runtimeTag(c));
  if (sourceTag) return sourceTag;

  const imageTag = imageTagForContainer(c);
  const matchedReleaseTag = releaseTagLabel(c?.matchedReleaseTag);
  if ((imageTag === "latest" || imageTag === "ready") && matchedReleaseTag) {
    return matchedReleaseTag;
  }
  if (isReleaseTag(imageTag)) return releaseTagLabel(imageTag);
  return runtimeBranch(c) || imageTag;
}

function dockerInstanceRuntimeSummary(c) {
  const imageTag = imageTagForContainer(c);
  const branch = releaseTagLabel(runtimeTag(c)) || (isReleaseTag(imageTag) ? releaseTagLabel(imageTag) : runtimeBranch(c));
  const shortCommit = runtimeShortCommit(c);
  if (branch && shortCommit) return `${branch} @ ${shortCommit}`;
  return branch || shortCommit || "";
}

function workspaceMigrationAvailable(c) {
  const storage = c?.workspaceStorage || null;
  return !!(storage && (storage.migrationAvailable || storage.legacy || storage.persistent === false));
}

function workspaceStorageFolderAvailable(c) {
  const storage = c?.workspaceStorage || null;
  return !!(storage?.persistent && typeof storage.hostPath === "string" && storage.hostPath.trim());
}

function backgroundOperationForContainer(state, containerId) {
  const id = String(containerId || "").trim();
  if (!id) return null;
  const operations = Array.isArray(state?.backgroundOperations) ? state.backgroundOperations : [];
  return operations.find((operation) => {
    if (!operation || operation.containerId !== id) return false;
    return operation.status === "queued" || operation.status === "running";
  }) || null;
}

function backgroundOperationLabel(operation) {
  if (!operation) return "";
  const queued = operation.status === "queued";
  const message = !queued && typeof operation.message === "string" ? operation.message.trim() : "";
  if (message) return message;
  if (operation.type === "start") return queued ? "Queued start" : "Starting";
  if (operation.type === "stop") return queued ? "Queued stop" : "Stopping";
  if (operation.type === "delete_instance") return queued ? "Queued delete" : "Deleting";
  return queued ? "Queued" : "Working";
}

function progressPresentedAsToast(progress = null) {
  return typeof progress?.presentation === "string" && progress.presentation.trim() === "toast";
}

function isBlockingOperationRunning(state = {}) {
  const progress = state?.progress || null;
  return progress?.status === "running" && !progressPresentedAsToast(progress);
}

function localCardsRenderKey(state = {}) {
  return JSON.stringify({
    loading: !!state?.loading,
    stateLoaded: !!state?.stateLoaded,
    images: Array.isArray(state?.images) ? state.images : [],
    versions: Array.isArray(state?.versions) ? state.versions : [],
    containers: Array.isArray(state?.containers) ? state.containers : [],
    remoteInstances: Array.isArray(state?.remoteInstances) ? state.remoteInstances : [],
    backgroundOperations: Array.isArray(state?.backgroundOperations) ? state.backgroundOperations : [],
    cli: state?.cli || null,
    blockingOperationRunning: isBlockingOperationRunning(state)
  });
}

function instancePowerMenuConfig({ isRunning, canStart, canStop, containerId, containerOperationRunning } = {}) {
  const hasContainer = !!String(containerId || "").trim();
  const busy = !!containerOperationRunning;
  const stoppingAllowed = isRunning || canStop;
  if (stoppingAllowed) {
    return {
      action: "stop",
      icon: "stop_circle",
      label: "Stop",
      disabled: !hasContainer || (busy && !canStop),
      title: canStop ? "Stop this starting instance" : busy ? "An action is already queued for this instance" : "Stop this instance"
    };
  }
  return {
    action: "start",
    icon: "play_arrow",
    label: "Start",
    disabled: !hasContainer || !canStart || busy,
    title: busy
      ? "An action is already queued for this instance"
      : canStart
        ? "Start this instance"
        : "Start is available for launcher-managed instances"
  };
}

function bindOpenableCardHeader(header, onOpen, options = {}) {
  if (!header || typeof onOpen !== "function") return;
  header.classList.add("dm-card-open-header");
  header.tabIndex = 0;
  header.setAttribute("role", "button");
  header.setAttribute("aria-label", options.ariaLabel || options.title || "Open instance UI");
  if (options.title) header.title = options.title;
  header.addEventListener("click", () => onOpen());
  header.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault?.();
    onOpen();
  });
}

function emptyInstancesStateModel(state = {}) {
  const containers = Array.isArray(state?.containers) ? state.containers : [];
  const remoteInstances = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
  if (containers.length || remoteInstances.length) return null;
  if (!state?.stateLoaded) {
    return {
      kind: "checking",
      message: "Checking Instances..."
    };
  }
  const operationRunning = isBlockingOperationRunning(state);
  return {
    kind: "install_latest",
    title: "No Instances yet",
    detail: "Download Agent Zero and create your first Instance.",
    actionLabel: "Install latest version",
    disabled: operationRunning,
    actionTitle: operationRunning ? "Another operation is running" : "Install latest Agent Zero version"
  };
}

function renderEmptyInstances(list, state = {}) {
  const model = emptyInstancesStateModel(state);
  if (!list || !model) return false;
  list.innerHTML = "";
  if (model.kind === "checking") {
    const empty = document.createElement("div");
    empty.className = "dm-empty";
    empty.textContent = model.message;
    list.appendChild(empty);
    return true;
  }

  const banner = document.createElement("div");
  banner.className = "dm-install-empty";
  const content = document.createElement("div");
  content.className = "dm-install-empty-content";
  const title = document.createElement("h3");
  title.className = "dm-install-empty-title";
  title.textContent = model.title;
  const detail = document.createElement("p");
  detail.className = "dm-install-empty-copy";
  detail.textContent = model.detail;
  const action = document.createElement("button");
  action.className = "button confirm dm-install-empty-action";
  action.type = "button";
  action.disabled = !!model.disabled;
  action.title = model.actionTitle;
  action.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">download</span><span></span>';
  action.querySelector("span:last-child").textContent = model.actionLabel;
  action.addEventListener("click", () => {
    window.dockerManagerActions?.installOrSync?.("latest");
  });
  content.appendChild(title);
  content.appendChild(detail);
  content.appendChild(action);
  banner.appendChild(content);
  list.appendChild(banner);
  return true;
}

const CLONE_WORKSPACE_OPTIONS = Object.freeze([
  {
    id: "auth",
    label: "Auth",
    detail: "Web login, root and RFC passwords."
  },
  {
    id: "secrets",
    label: "Secrets and API keys",
    detail: "Provider keys, secrets.env and OAuth account state."
  },
  {
    id: "providers",
    label: "Provider/model configuration",
    detail: "Model presets and _model_config settings."
  },
  {
    id: "mcp",
    label: "MCPs",
    detail: "Client/server MCP settings and A2A toggle."
  },
  {
    id: "settings",
    label: "Settings and preferences",
    detail: "Timezone, workdir and variables."
  },
  {
    id: "agents",
    label: "Agent profiles",
    detail: "Files under /a0/usr/agents."
  },
  {
    id: "chats",
    label: "Chats",
    detail: "Saved conversations and message files."
  },
  {
    id: "skills",
    label: "Skills",
    detail: "Global user skills in /a0/usr/skills."
  },
  {
    id: "plugins",
    label: "Plugins",
    detail: "Custom plugin files except model and OAuth state."
  },
  {
    id: "projects",
    label: "Projects",
    detail: "Project folders, repositories and project metadata."
  },
  {
    id: "memory",
    label: "Memory and knowledge",
    detail: "Memory, knowledge, schedules and time travel data."
  },
  {
    id: "files",
    label: "Workspace files",
    detail: "Workdir, uploads, downloads and API files."
  }
]);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function remoteInstanceVisualSeed(remote) {
  return remote?.url || remote?.name || remote?.id || "remote";
}

function remoteInstanceStatusModel(remote) {
  const status = String(remote?.health?.status || "").trim().toLowerCase();
  if (status === "online") {
    return {
      className: "status-online",
      label: "Online",
      title: "Remote health check is online"
    };
  }
  if (status === "offline") {
    const error = typeof remote?.health?.error === "string" ? remote.health.error.trim() : "";
    return {
      className: "status-offline",
      label: "Offline",
      title: error ? `Remote health check failed: ${error}` : "Remote health check failed"
    };
  }
  return {
    className: "status-checking",
    label: "Checking",
    title: "Checking remote health"
  };
}

function closeDialog(dialog) {
  if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function computeCardMenuPlacement({
  triggerRect,
  popoverWidth,
  popoverHeight,
  viewportWidth,
  viewportHeight,
  footerHeight = 0,
  edgeGap = 12,
  menuGap = 6
}) {
  const safeTrigger = triggerRect || { top: 0, right: 0, bottom: 0 };
  const triggerTop = Number(safeTrigger.top) || 0;
  const triggerRight = Number(safeTrigger.right) || 0;
  const triggerBottom = Number(safeTrigger.bottom) || 0;
  const safeViewportWidth = Math.max(0, Number(viewportWidth) || 0);
  const safeViewportHeight = Math.max(0, Number(viewportHeight) || 0);
  const safeFooterHeight = Math.max(0, Number(footerHeight) || 0);
  const safePopoverWidth = Math.max(0, Number(popoverWidth) || 0);
  const safePopoverHeight = Math.max(0, Number(popoverHeight) || 0);
  const safeEdgeGap = Math.max(0, Number(edgeGap) || 0);
  const safeMenuGap = Math.max(0, Number(menuGap) || 0);

  const usableTop = safeEdgeGap;
  const usableBottom = Math.max(usableTop, safeViewportHeight - safeFooterHeight - safeEdgeGap);
  const usableHeight = Math.max(0, usableBottom - usableTop);
  const height = Math.min(safePopoverHeight, usableHeight);
  const spaceBelow = Math.max(0, usableBottom - triggerBottom - safeMenuGap);
  const spaceAbove = Math.max(0, triggerTop - usableTop - safeMenuGap);
  const openDown = safePopoverHeight <= spaceBelow
    ? true
    : safePopoverHeight <= spaceAbove
      ? false
      : spaceBelow >= spaceAbove;

  const preferredTop = openDown
    ? triggerBottom + safeMenuGap
    : triggerTop - safeMenuGap - height;
  const top = clamp(preferredTop, usableTop, usableBottom - height);
  const maxLeft = Math.max(safeEdgeGap, safeViewportWidth - safeEdgeGap - safePopoverWidth);
  const left = clamp(triggerRight - safePopoverWidth, safeEdgeGap, maxLeft);

  return {
    openDown,
    top: Math.floor(top),
    left: Math.floor(left),
    maxHeight: Math.floor(height)
  };
}

function resetCardMenuPosition(menu) {
  if (!menu) return;
  menu.classList.remove("open-up", "open-down", "measuring", "settling");
  menu.closest?.(".dm-card")?.classList.remove("menu-open");
  const popover = menu.querySelector(".dm-card-menu-popover");
  if (popover) {
    popover.style.left = "";
    popover.style.top = "";
    popover.style.maxHeight = "";
  }
}

function closeCardMenus(except = null) {
  document.querySelectorAll(".dm-card-menu.open, .dm-card-menu.measuring, .dm-card-menu.settling").forEach((menu) => {
    if (menu === except) return;
    closeCardMenu(menu, menu.querySelector(".dm-card-menu-trigger"));
  });
}

function positionCardMenu(menu) {
  const trigger = menu?.querySelector(".dm-card-menu-trigger");
  const popover = menu?.querySelector(".dm-card-menu-popover");
  if (!trigger || !popover) return false;

  const edgeGap = 12;
  const menuGap = 6;

  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const placement = computeCardMenuPlacement({
    triggerRect,
    popoverWidth: popoverRect.width || popover.scrollWidth || 0,
    popoverHeight: popover.scrollHeight || popoverRect.height || 0,
    viewportWidth,
    viewportHeight,
    footerHeight: 0,
    edgeGap,
    menuGap
  });

  menu.classList.toggle("open-down", placement.openDown);
  menu.classList.toggle("open-up", !placement.openDown);
  popover.style.left = `${placement.left}px`;
  popover.style.top = `${placement.top}px`;
  popover.style.maxHeight = placement.maxHeight ? `${placement.maxHeight}px` : "";
  return true;
}

function positionOpenCardMenus() {
  document.querySelectorAll(".dm-card-menu.open").forEach((menu) => positionCardMenu(menu));
}

function cssPixelValue(value) {
  const number = Number.parseFloat(String(value || ""));
  return Number.isFinite(number) ? number : 0;
}

// A hovered card transform can briefly remap fixed descendants to the card.
function revealSettledCardMenu(menu, attempt = 0) {
  if (!menu?.classList?.contains("settling")) return;
  positionCardMenu(menu);
  const popover = menu.querySelector?.(".dm-card-menu-popover");
  const rect = popover?.getBoundingClientRect?.();
  const settled = rect && Math.abs(rect.left - cssPixelValue(popover.style.left)) < 1 &&
    Math.abs(rect.top - cssPixelValue(popover.style.top)) < 1;
  if (!settled && attempt < 8) {
    window.requestAnimationFrame(() => revealSettledCardMenu(menu, attempt + 1));
    return;
  }
  window.requestAnimationFrame(() => {
    if (!menu?.classList?.contains("settling")) return;
    positionCardMenu(menu);
    menu.classList.remove("settling");
  });
}

function finishOpenCardMenu(menu, trigger, settleBeforeReveal = false) {
  if (!menu?.classList?.contains("measuring")) return;
  positionCardMenu(menu);
  menu.classList.remove("measuring");
  if (settleBeforeReveal) menu.classList.add("settling");
  menu.classList.add("open");
  trigger?.setAttribute("aria-expanded", "true");
  if (settleBeforeReveal) {
    window.requestAnimationFrame(() => revealSettledCardMenu(menu));
  }
}

function openCardMenu(menu, trigger) {
  if (!menu) return;
  const card = menu.closest?.(".dm-card");
  card?.classList.add("menu-open");
  menu.classList.add("measuring");
  positionCardMenu(menu);
  finishOpenCardMenu(menu, trigger, typeof window.requestAnimationFrame === "function");
}

function closeCardMenu(menu, trigger) {
  if (!menu) return;
  menu.classList.remove("open", "measuring");
  resetCardMenuPosition(menu);
  trigger?.setAttribute("aria-expanded", "false");
}

function bindCardMenuDismissal() {
  if (document.body.dataset.dmCardMenuDismissalBound) return;
  document.body.dataset.dmCardMenuDismissalBound = "1";
  document.addEventListener("click", () => closeCardMenus());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeCardMenus();
  });
  window.addEventListener("resize", positionOpenCardMenus);
  document.addEventListener("scroll", positionOpenCardMenus, true);
}

function menuButton(icon, label, onSelect, options = {}) {
  const button = document.createElement("button");
  button.className = `dm-card-menu-item${options.danger ? " danger" : ""}`;
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.disabled = !!options.disabled;
  if (options.title) button.title = options.title;

  const glyph = document.createElement("span");
  glyph.className = "material-symbols-outlined";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = icon;

  const text = document.createElement("span");
  text.textContent = label;

  button.appendChild(glyph);
  button.appendChild(text);
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    closeCardMenus();
    if (button.disabled) return;
    await onSelect?.();
  });
  return button;
}

function createCardMenu(items) {
  const menu = document.createElement("div");
  menu.className = "dm-card-menu";

  const trigger = document.createElement("button");
  trigger.className = "button dm-icon-button dm-card-menu-trigger";
  trigger.type = "button";
  trigger.title = "Instance actions";
  trigger.setAttribute("aria-label", "Instance actions");
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">more_horiz</span>';
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = !menu.classList.contains("open") && !menu.classList.contains("measuring");
    closeCardMenus(menu);
    if (open) {
      openCardMenu(menu, trigger);
    } else {
      closeCardMenu(menu, trigger);
    }
  });

  const popover = document.createElement("div");
  popover.className = "dm-card-menu-popover";
  popover.setAttribute("role", "menu");
  popover.addEventListener("click", (event) => event.stopPropagation());
  items.filter(Boolean).forEach((item) => popover.appendChild(item));

  menu.appendChild(trigger);
  menu.appendChild(popover);
  return menu;
}

function openRenameInstanceDialog({ title, currentName, onRename }) {
  const existing = document.getElementById("renameInstanceDialog");
  if (existing) existing.remove();

  const dialog = document.createElement("div");
  dialog.id = "renameInstanceDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.setAttribute("role", "presentation");

  dialog.innerHTML = `
    <form class="dm-dialog" role="dialog" aria-modal="true" aria-labelledby="renameInstanceTitle">
      <div class="dm-dialog-header">
        <h2 id="renameInstanceTitle" class="dm-dialog-title">${title || "Rename instance"}</h2>
        <button class="button dm-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <div class="dm-dialog-body">
        <div class="dm-field">
          <label for="renameInstanceName">Name</label>
          <input id="renameInstanceName" class="dm-text-input" type="text" maxlength="80" autocomplete="off">
        </div>
      </div>
      <div class="dm-dialog-footer">
        <button class="button" type="button" data-dialog-close>Cancel</button>
        <button class="button confirm" type="submit">Rename</button>
      </div>
    </form>
  `;

  const form = dialog.querySelector("form");
  const input = dialog.querySelector("#renameInstanceName");
  if (input) input.value = currentName || "";

  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextName = String(input?.value || "").trim();
    if (!nextName) {
      window.toastFrontendError?.("Name is required.", "Agent Zero");
      input?.focus();
      return;
    }
    closeDialog(dialog);
    await onRename?.(nextName);
  });

  document.body.appendChild(dialog);
  window.setTimeout(() => {
    input?.focus();
    input?.select?.();
  }, 0);
}

function openInstanceCredentialsDialog({ displayName, credentials = null, onSave, onClear }) {
  const existing = document.getElementById("instanceCredentialsDialog");
  if (existing) existing.remove();

  const saved = credentials?.saved === true;
  const username = String(credentials?.username || "");
  const dialog = document.createElement("div");
  dialog.id = "instanceCredentialsDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.setAttribute("role", "presentation");

  dialog.innerHTML = `
    <form class="dm-dialog" role="dialog" aria-modal="true" aria-labelledby="instanceCredentialsTitle">
      <div class="dm-dialog-header">
        <h2 id="instanceCredentialsTitle" class="dm-dialog-title">Save credentials</h2>
        <button class="button dm-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <div class="dm-dialog-body">
        <p class="dm-dialog-copy">Save credentials for <strong>${escapeHtml(displayName || "this instance")}</strong>.</p>
        <div class="dm-field">
          <label for="instanceCredentialsUsername">Username</label>
          <input id="instanceCredentialsUsername" class="dm-text-input" type="text" maxlength="256" autocomplete="username" value="${escapeHtml(username)}">
        </div>
        <div class="dm-field">
          <label for="instanceCredentialsPassword">Password</label>
          <input id="instanceCredentialsPassword" class="dm-text-input" type="password" maxlength="4096" autocomplete="new-password" placeholder="${saved ? "Enter password to update" : "Password"}">
          <div class="dm-field-hint">${saved ? "A password is already saved. Enter a password here only when saving a replacement." : "The launcher stores this with the operating system's secure storage."}</div>
        </div>
      </div>
      <div class="dm-dialog-footer dm-credentials-dialog-footer">
        <div class="dm-dialog-footer-group">
          <button class="button" type="button" data-dialog-close>Cancel</button>
          ${saved ? '<button class="button" type="button" data-clear-credentials>Clear</button>' : ''}
        </div>
        <button class="button confirm" type="submit">Save</button>
      </div>
    </form>
  `;

  const form = dialog.querySelector("form");
  const usernameInput = dialog.querySelector("#instanceCredentialsUsername");
  const passwordInput = dialog.querySelector("#instanceCredentialsPassword");

  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  dialog.querySelector("[data-clear-credentials]")?.addEventListener("click", async () => {
    closeDialog(dialog);
    await onClear?.();
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextUsername = String(usernameInput?.value || "").trim();
    const nextPassword = String(passwordInput?.value || "").replace(/[\r\n]+/g, " ");
    if (!nextUsername || !nextPassword) {
      window.toastFrontendError?.("Enter both username and password to save credentials.", "Agent Zero");
      (!nextUsername ? usernameInput : passwordInput)?.focus();
      return;
    }
    closeDialog(dialog);
    await onSave?.({ username: nextUsername, password: nextPassword });
  });

  document.body.appendChild(dialog);
  window.setTimeout(() => {
    if (usernameInput && !usernameInput.value) usernameInput.focus();
    else passwordInput?.focus();
  }, 0);
}

function openInstanceColorDialog({ title, currentColor, onSelect }) {
  const existing = document.getElementById("instanceColorDialog");
  if (existing) existing.remove();

  const selectedColor = normalizedInstanceColorId(currentColor);
  const dialog = document.createElement("div");
  dialog.id = "instanceColorDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.setAttribute("role", "presentation");

  const panel = document.createElement("div");
  panel.className = "dm-dialog dm-color-dialog";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "instanceColorTitle");

  const header = document.createElement("div");
  header.className = "dm-dialog-header";
  const heading = document.createElement("h2");
  heading.id = "instanceColorTitle";
  heading.className = "dm-dialog-title";
  heading.textContent = title || "Instance color";
  const close = document.createElement("button");
  close.className = "button dm-dialog-close";
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("click", () => closeDialog(dialog));
  header.appendChild(heading);
  header.appendChild(close);

  const body = document.createElement("div");
  body.className = "dm-dialog-body";
  const swatches = document.createElement("div");
  swatches.className = "dm-color-swatches";

  for (const option of INSTANCE_COLOR_OPTIONS) {
    const colorId = normalizedInstanceColorId(option.id);
    const selected = colorId === selectedColor;
    const button = document.createElement("button");
    button.className = `dm-color-swatch-option${selected ? " is-selected" : ""}`;
    button.type = "button";
    button.setAttribute("aria-pressed", String(selected));
    button.dataset.color = colorId;

    const swatch = document.createElement("span");
    swatch.className = `dm-color-swatch${colorId ? "" : " is-auto"}`;
    swatch.style.setProperty("--dm-swatch-fg", option.fg);
    swatch.style.setProperty("--dm-swatch-bg", option.bg);
    swatch.style.setProperty("--dm-swatch-border", option.border);

    const label = document.createElement("span");
    label.className = "dm-color-swatch-label";
    label.textContent = option.label;

    button.appendChild(swatch);
    button.appendChild(label);
    button.addEventListener("click", async () => {
      closeDialog(dialog);
      await onSelect?.(colorId);
    });
    swatches.appendChild(button);
  }

  body.appendChild(swatches);

  const footer = document.createElement("div");
  footer.className = "dm-dialog-footer";
  const spacer = document.createElement("span");
  const cancel = document.createElement("button");
  cancel.className = "button";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closeDialog(dialog));
  footer.appendChild(spacer);
  footer.appendChild(cancel);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  dialog.appendChild(panel);
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });

  document.body.appendChild(dialog);
  window.setTimeout(() => {
    dialog.querySelector(".dm-color-swatch-option.is-selected")?.focus();
  }, 0);
}

function openCloneInstanceDialog(instance) {
  const existing = document.getElementById("cloneInstanceDialog");
  if (existing) existing.remove();

  const containerId = instance?.containerId || "";
  const displayName = instance?.instanceName || instance?.containerName || "this instance";
  const dialog = document.createElement("div");
  dialog.id = "cloneInstanceDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.setAttribute("role", "presentation");

  const optionRows = CLONE_WORKSPACE_OPTIONS.map((option) => `
    <label class="dm-clone-option">
      <input type="checkbox" name="cloneWorkspaceCategory" value="${escapeHtml(option.id)}" checked>
      <span class="dm-clone-option-copy">
        <span class="dm-clone-option-label">${escapeHtml(option.label)}</span>
        <span class="dm-clone-option-detail">${escapeHtml(option.detail)}</span>
      </span>
    </label>
  `).join("");

  dialog.innerHTML = `
    <form class="dm-dialog dm-clone-dialog" role="dialog" aria-modal="true" aria-labelledby="cloneInstanceTitle">
      <div class="dm-dialog-header">
        <h2 id="cloneInstanceTitle" class="dm-dialog-title">Clone instance</h2>
        <button class="button dm-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <div class="dm-dialog-body">
        <p class="dm-dialog-copy">Create a new instance from <strong>${escapeHtml(displayName)}</strong> with its current /a0/usr workspace. The source pauses during the snapshot; resume any running AI work manually afterward.</p>
        <details class="dm-clone-details">
          <summary class="dm-clone-details-summary">
            <span class="dm-clone-details-label">Workspace copy</span>
            <span class="dm-clone-selection-summary" data-clone-selection-summary>Everything selected</span>
          </summary>
          <div class="dm-clone-details-body">
            <p class="dm-clone-details-copy">Everything is included by default. Clear categories only when you want a leaner clone; clear all to start with an empty /a0/usr.</p>
            <div class="dm-clone-toolbar">
              <button class="button" type="button" data-clone-select-all>Select all</button>
              <button class="button" type="button" data-clone-clear>Clear</button>
            </div>
            <div class="dm-clone-options">
              ${optionRows}
            </div>
          </div>
        </details>
      </div>
      <div class="dm-dialog-footer">
        <button class="button" type="button" data-dialog-close>Cancel</button>
        <button class="button confirm" type="submit" data-clone-submit>Clone</button>
      </div>
    </form>
  `;

  const form = dialog.querySelector("form");
  const boxes = () => [...dialog.querySelectorAll('input[name="cloneWorkspaceCategory"]')];
  const selectionSummary = dialog.querySelector("[data-clone-selection-summary]");
  const updateSelectionSummary = () => {
    if (!selectionSummary) return;
    const categoryBoxes = boxes();
    const selectedCount = categoryBoxes.filter((box) => box.checked).length;
    if (selectedCount === categoryBoxes.length) {
      selectionSummary.textContent = "Everything selected";
    } else if (selectedCount === 0) {
      selectionSummary.textContent = "Empty workspace";
    } else {
      selectionSummary.textContent = `${selectedCount} of ${categoryBoxes.length} selected`;
    }
  };

  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.querySelector("[data-clone-select-all]")?.addEventListener("click", () => {
    boxes().forEach((box) => { box.checked = true; });
    updateSelectionSummary();
  });
  dialog.querySelector("[data-clone-clear]")?.addEventListener("click", () => {
    boxes().forEach((box) => { box.checked = false; });
    updateSelectionSummary();
  });
  boxes().forEach((box) => {
    box.addEventListener("change", updateSelectionSummary);
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = boxes()
      .filter((box) => box.checked)
      .map((box) => box.value);
    closeDialog(dialog);
    await window.dockerManagerActions?.cloneLocalInstance?.(containerId, {
      workspaceCategories: selected
    });
  });

  document.body.appendChild(dialog);
  updateSelectionSummary();
  window.setTimeout(() => {
    dialog.querySelector("[data-clone-submit]")?.focus();
  }, 0);
}

function closeLogsPanel() {
  const panel = document.getElementById("localInstanceLogsPanel");
  if (panel) panel.remove();
}

function logsCopyText(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((evt) => {
      const stream = evt?.stream === "stderr" ? "err" : "out";
      return `${stream} ${String(evt?.line || "")}`;
    })
    .join("\n");
}

function setLogsCopyState(backdrop, text, title = "No logs to copy") {
  if (backdrop) backdrop._dmLogsCopyText = text || "";
  const copyBtn = backdrop?.querySelector("[data-dm-logs-copy]");
  if (!copyBtn) return;
  const hasText = !!text;
  copyBtn.disabled = !hasText;
  copyBtn.title = hasText ? "Copy logs" : title;
  copyBtn.setAttribute("aria-label", copyBtn.title);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection-based copy path.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-1000px";
  textarea.style.top = "-1000px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

async function copyLogs(backdrop) {
  const text = backdrop?._dmLogsCopyText || "";
  if (!text) return;
  try {
    await copyText(text);
    window.toastFrontendSuccess?.("Logs copied.", "Agent Zero", 2, "dm-local-instance-logs");
  } catch {
    window.toastFrontendError?.("Unable to copy logs.", "Agent Zero");
  }
}

function bindLogsPanelDismissal() {
  if (document.body.dataset.dmLogsPanelDismissalBound) return;
  document.body.dataset.dmLogsPanelDismissalBound = "1";
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeLogsPanel();
  });
}

function ensureLogsPanel(c) {
  bindLogsPanelDismissal();
  const containerId = c?.containerId || "";
  const displayName = c?.instanceName || c?.containerName || c?.containerId?.slice(0, 12) || "instance";
  const existing = document.getElementById("localInstanceLogsPanel");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "localInstanceLogsPanel";
  backdrop.className = "dm-logs-backdrop";
  backdrop.setAttribute("role", "presentation");
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) closeLogsPanel();
  });

  const panel = document.createElement("section");
  panel.className = "dm-logs-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "localInstanceLogsTitle");

  const header = document.createElement("div");
  header.className = "dm-logs-header";

  const titleBlock = document.createElement("div");
  titleBlock.className = "dm-logs-title-block";
  const title = document.createElement("h3");
  title.id = "localInstanceLogsTitle";
  title.className = "dm-logs-title";
  title.textContent = "Docker logs";
  const subtitle = document.createElement("div");
  subtitle.className = "dm-logs-subtitle";
  subtitle.textContent = displayName;
  titleBlock.appendChild(title);
  titleBlock.appendChild(subtitle);

  const actions = document.createElement("div");
  actions.className = "dm-logs-actions";
  const copyBtn = document.createElement("button");
  copyBtn.className = "button";
  copyBtn.type = "button";
  copyBtn.disabled = true;
  copyBtn.dataset.dmLogsCopy = "1";
  copyBtn.title = "No logs to copy";
  copyBtn.setAttribute("aria-label", "No logs to copy");
  copyBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">content_copy</span><span>Copy</span>';
  copyBtn.addEventListener("click", () => copyLogs(backdrop));

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "button";
  refreshBtn.type = "button";
  refreshBtn.title = "Refresh logs";
  refreshBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">refresh</span><span>Refresh</span>';
  refreshBtn.addEventListener("click", () => openLogsPanel(c));

  const closeBtn = document.createElement("button");
  closeBtn.className = "button dm-icon-button dm-close-button";
  closeBtn.type = "button";
  closeBtn.title = "Close logs";
  closeBtn.setAttribute("aria-label", "Close logs");
  closeBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">close</span>';
  closeBtn.addEventListener("click", closeLogsPanel);

  actions.appendChild(copyBtn);
  actions.appendChild(refreshBtn);
  actions.appendChild(closeBtn);
  header.appendChild(titleBlock);
  header.appendChild(actions);

  const meta = document.createElement("div");
  meta.className = "dm-logs-meta";
  meta.textContent = containerId ? containerId.slice(0, 12) : "";

  const body = document.createElement("div");
  body.className = "dm-logs-body";
  body.setAttribute("aria-live", "polite");

  panel.appendChild(header);
  panel.appendChild(meta);
  panel.appendChild(body);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  setLogsCopyState(backdrop, "");
  return backdrop;
}

function renderLogsLoading(backdrop) {
  const body = backdrop?.querySelector(".dm-logs-body");
  const meta = backdrop?.querySelector(".dm-logs-meta");
  setLogsCopyState(backdrop, "", "Logs are loading");
  if (meta) meta.textContent = "Loading recent logs...";
  if (!body) return;
  body.innerHTML = "";
  const state = document.createElement("div");
  state.className = "dm-logs-state";
  state.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">progress_activity</span><span>Loading logs...</span>';
  body.appendChild(state);
}

function renderLogsError(backdrop, message) {
  const body = backdrop?.querySelector(".dm-logs-body");
  const meta = backdrop?.querySelector(".dm-logs-meta");
  setLogsCopyState(backdrop, "", "No logs to copy");
  if (meta) meta.textContent = "";
  if (!body) return;
  body.innerHTML = "";
  const state = document.createElement("div");
  state.className = "dm-logs-state error";
  const icon = document.createElement("span");
  icon.className = "material-symbols-outlined";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "error";
  const text = document.createElement("span");
  text.textContent = message || "Unable to load logs.";
  state.appendChild(icon);
  state.appendChild(text);
  body.appendChild(state);
}

function renderLogsResult(backdrop, result) {
  const body = backdrop?.querySelector(".dm-logs-body");
  const meta = backdrop?.querySelector(".dm-logs-meta");
  const lines = Array.isArray(result?.lines) ? result.lines : [];
  const copy = logsCopyText(lines);
  setLogsCopyState(backdrop, copy, "No logs to copy");

  if (meta) {
    const parts = [`${lines.length} line${lines.length === 1 ? "" : "s"}`];
    if (result?.fetchedAt) {
      const d = new Date(result.fetchedAt);
      if (!Number.isNaN(d.getTime())) parts.push(d.toLocaleString());
    }
    meta.textContent = parts.join(" / ");
  }

  if (!body) return;
  body.innerHTML = "";
  if (!lines.length) {
    const state = document.createElement("div");
    state.className = "dm-logs-state";
    state.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">article</span><span>No logs yet.</span>';
    body.appendChild(state);
    return;
  }

  const list = document.createElement("div");
  list.className = "dm-log-lines";
  for (const evt of lines) {
    const row = document.createElement("div");
    row.className = `dm-log-line ${evt?.stream === "stderr" ? "stderr" : "stdout"}`;
    const stream = document.createElement("span");
    stream.className = "dm-log-stream";
    stream.textContent = evt?.stream === "stderr" ? "err" : "out";
    const text = document.createElement("code");
    text.className = "dm-log-text";
    text.textContent = String(evt?.line || "");
    row.appendChild(stream);
    row.appendChild(text);
    list.appendChild(row);
  }
  body.appendChild(list);
  body.scrollTop = body.scrollHeight;
}

async function openLogsPanel(c) {
  const containerId = c?.containerId || "";
  if (!containerId) {
    window.toastFrontendError?.("Instance logs are not available.", "Agent Zero");
    return;
  }
  const seq = logsRequestSeq + 1;
  logsRequestSeq = seq;
  const backdrop = ensureLogsPanel(c);
  renderLogsLoading(backdrop);

  const result = await window.dockerManagerActions?.getLocalInstanceLogs?.(containerId, { maxLines: 500 });
  if (logsRequestSeq !== seq) return;
  if (!result) {
    renderLogsError(backdrop, "Unable to load logs.");
    return;
  }
  renderLogsResult(backdrop, result);
}

function bindActions() {
  bindCardMenuDismissal();
  const createBtn = byId("createLocalInstanceBtn");
  if (createBtn && !createBtn.dataset.bound) {
    createBtn.dataset.bound = "1";
    createBtn.addEventListener("click", () => {
      openCreateLocalInstanceDialog(window.__dmLastState || {});
    });
  }
  const addBtn = byId("addRemoteInstanceBtn");
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = "1";
    addBtn.addEventListener("click", openAddRemoteInstanceDialog);
  }
}

function renderDockerInstance(list, c, state) {
  const operationRunning = isBlockingOperationRunning(state);
  const containerId = c?.containerId || "";
  const backgroundOperation = backgroundOperationForContainer(state, containerId);
  const containerOperationRunning = !!backgroundOperation;
  const displayName = c?.instanceName || c?.containerName || c?.containerId?.slice(0, 12) || "instance";
  const visualBadge = instanceVisualBadge(c);
  const cliHost = localUiUrl(c?.uiUrl);
  const cliInstalled = state?.cli?.installed === true;
  const launcherCredentials = c?.launcherCredentials && typeof c.launcherCredentials === "object" ? c.launcherCredentials : null;
  const card = document.createElement("div");
  card.className = "dm-card";

  const visual = createInstanceVisual(displayName, {
    badge: visualBadge,
    seed: `${displayName}:${visualBadge || containerId}`,
    color: c?.instanceColor || ""
  });

  const body = document.createElement("div");
  body.className = "dm-card-body";
  const title = document.createElement("div");
  title.className = "dm-card-title";
  title.textContent = displayName;
  body.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "dm-card-meta";
  const runtimeSummary = dockerInstanceRuntimeSummary(c);
  if (runtimeSummary || c?.status) {
    const summary = document.createElement("div");
    summary.className = "dm-card-meta-line";
    summary.textContent = runtimeSummary || c.status;
    meta.appendChild(summary);
  }
  if (c?.uiUrl) {
    const url = document.createElement("div");
    url.className = "dm-card-meta-line dm-card-meta-url";
    url.textContent = c.uiUrl;
    meta.appendChild(url);
  }
  if (meta.childNodes.length) body.appendChild(meta);

  const footer = document.createElement("div");
  footer.className = "dm-card-footer";

  const statusEl = document.createElement("span");
  statusEl.className = "status";
  const st = (c?.state || "unknown").toLowerCase();
  if (backgroundOperation) {
    statusEl.classList.add("status-update");
    statusEl.textContent = backgroundOperationLabel(backgroundOperation);
  } else if (st === "running") {
    statusEl.classList.add("status-running");
    statusEl.textContent = "Running";
  } else if (st === "exited" || st === "stopped") {
    statusEl.classList.add("status-exited");
    statusEl.textContent = "Stopped";
  } else {
    statusEl.textContent = c?.state || "Unknown";
  }
  footer.appendChild(statusEl);

  const actions = document.createElement("div");
  actions.className = "dm-card-actions";
  const role = c?.labels?.["a0.launcher.role"] || "";
  const isActiveInstance = String(c?.containerName || "").includes("-active__");
  const isManagedLocalInstance = c?.labels?.["a0.launcher.managed"] === "true" || role === "developer" || role === "clone";
  const isRunning = st === "running";
  const canStartLocalInstance = !isRunning && (isActiveInstance || isManagedLocalInstance);
  const canStopStartingInstance = backgroundOperation?.type === "start" && backgroundOperation.status === "running";
  const powerMenuItem = instancePowerMenuConfig({
    isRunning,
    canStart: canStartLocalInstance,
    canStop: canStopStartingInstance,
    containerId,
    containerOperationRunning
  });
  const openLocalInstanceUi = () => {
    window.dockerManagerActions?.openInstanceUi?.({
      kind: "local",
      containerId: c?.containerId || "",
      title: displayName
    });
  };

  if (isRunning && !containerOperationRunning) {
    bindOpenableCardHeader(visual, openLocalInstanceUi, {
      title: "Open this instance",
      ariaLabel: `Open ${displayName}`
    });
  }

  if (canStopStartingInstance) {
    const stopBtn = document.createElement("button");
    stopBtn.className = "button cancel";
    stopBtn.type = "button";
    stopBtn.textContent = "Stop";
    stopBtn.title = "Stop this starting instance";
    stopBtn.addEventListener("click", () => {
      window.dockerManagerActions?.stopLocalInstance?.(containerId);
    });
    actions.appendChild(stopBtn);
  } else if (isRunning) {
    const openBtn = document.createElement("button");
    openBtn.className = "button confirm";
    openBtn.type = "button";
    openBtn.textContent = "Open UI";
    openBtn.disabled = containerOperationRunning;
    openBtn.title = containerOperationRunning ? "An action is already queued for this instance" : "Open this instance";
    openBtn.addEventListener("click", openLocalInstanceUi);
    actions.appendChild(openBtn);
  } else if (canStartLocalInstance) {
    const startBtn = document.createElement("button");
    startBtn.className = "button confirm";
    startBtn.type = "button";
    startBtn.textContent = "Start";
    startBtn.disabled = containerOperationRunning;
    startBtn.addEventListener("click", () => {
      window.dockerManagerActions?.startLocalInstance?.(containerId);
    });
    actions.appendChild(startBtn);
  }

  const menu = createCardMenu([
    menuButton("edit", "Rename", () => {
      openRenameInstanceDialog({
        title: "Rename instance",
        currentName: displayName,
        onRename: (name) => window.dockerManagerActions?.renameLocalInstance?.(containerId, name)
      });
    }, {
      disabled: !containerId || containerOperationRunning,
      title: "Rename this instance"
    }),
    menuButton("palette", "Color", () => {
      openInstanceColorDialog({
        title: "Instance color",
        currentColor: c?.instanceColor || "",
        onSelect: (color) => window.dockerManagerActions?.setLocalInstanceColor?.(containerId, color)
      });
    }, {
      disabled: !containerId || backgroundOperation?.type === "delete_instance",
      title: "Choose this instance color"
    }),
    menuButton("key", "Save credentials", () => {
      openInstanceCredentialsDialog({
        displayName,
        credentials: launcherCredentials,
        onSave: (credentials) => window.dockerManagerActions?.setLocalInstanceCredentials?.(containerId, credentials),
        onClear: () => window.dockerManagerActions?.clearLocalInstanceCredentials?.(containerId)
      });
    }, {
      disabled: !containerId || backgroundOperation?.type === "delete_instance",
      title: launcherCredentials?.saved
        ? "Update or clear saved credentials"
        : "Save credentials"
    }),
    menuButton("article", "See logs", () => {
      openLogsPanel(c);
    }, {
      disabled: !containerId,
      title: "See recent Docker logs"
    }),
    workspaceStorageFolderAvailable(c) ? menuButton("folder_open", "Open storage folder", () => {
      window.dockerManagerActions?.openLocalInstanceStorageFolder?.(containerId);
    }, {
      disabled: !containerId,
      title: "Open the persistent /a0/usr folder on this computer"
    }) : null,
    menuButton("archive", "Backup /a0/usr", () => {
      window.dockerManagerActions?.backupLocalInstance?.(containerId);
    }, {
      disabled: !containerId || operationRunning || containerOperationRunning,
      title: "Save an Agent Zero backup zip from this instance"
    }),
    menuButton("upload_file", "Restore /a0/usr", async () => {
      if (!window.confirm(`Restore a backup into ${displayName}?\n\nThis writes files into /a0/usr and can overwrite existing files. Restart Agent Zero afterward so restored settings fully load.`)) return;
      await window.dockerManagerActions?.restoreLocalInstance?.(containerId);
    }, {
      disabled: !containerId || operationRunning || containerOperationRunning,
      title: "Restore an Agent Zero backup zip into this instance"
    }),
    workspaceMigrationAvailable(c) ? menuButton("drive_file_move", "Persist a0/usr data", async () => {
      if (!window.confirm(`Create persistent /a0/usr storage for ${displayName}?\n\nThe source container will be paused and resumed during the snapshot. Any running AI work stops and must be resumed manually.\n\nThe existing container will be kept until the persistent replacement starts successfully.`)) return;
      await window.dockerManagerActions?.migrateLocalInstanceStorage?.(containerId);
    }, {
      disabled: !containerId || operationRunning || containerOperationRunning,
      title: "Create persistent /a0/usr storage"
    }) : null,
    menuButton("content_copy", "Clone", () => {
      openCloneInstanceDialog(c);
    }, {
      disabled: !containerId || operationRunning || containerOperationRunning,
      title: "Clone this instance on open ports"
    }),
    menuButton(cliInstalled ? "terminal" : "download", cliInstalled ? "Open A0 CLI" : "Install A0 CLI", () => {
      if (cliInstalled) window.dockerManagerActions?.openCliTerminal?.({ host: cliHost, containerId });
      else window.dockerManagerActions?.installCli?.();
    }, {
      disabled: cliInstalled ? (!isRunning || !cliHost || operationRunning || containerOperationRunning) : operationRunning,
      title: cliInstalled
        ? !isRunning
          ? "Start this instance before opening A0 CLI"
          : cliHost
            ? "Choose a folder and open A0 CLI for this instance"
            : "A0 CLI requires a running local Web UI"
        : "Install A0 CLI on this computer"
    }),
    menuButton(powerMenuItem.icon, powerMenuItem.label, () => {
      if (powerMenuItem.action === "start") {
        window.dockerManagerActions?.startLocalInstance?.(containerId);
        return;
      }
      window.dockerManagerActions?.stopLocalInstance?.(containerId);
    }, {
      disabled: powerMenuItem.disabled,
      title: powerMenuItem.title
    }),
    menuButton("delete", "Delete", async () => {
      const verb = isRunning ? "Stop and delete" : "Delete";
      const detail = isRunning
        ? "This will stop and delete the container. Storage volumes are not removed."
        : "This removes the container. Storage volumes are not removed.";
      if (!window.confirm(`${verb} ${displayName}?\n\n${detail}`)) return;
      await window.dockerManagerActions?.deleteLocalInstance?.(containerId);
    }, {
      danger: true,
      disabled: !containerId || containerOperationRunning,
      title: containerOperationRunning ? "An action is already queued for this instance" : "Delete this container"
    })
  ]);
  actions.appendChild(menu);

  footer.appendChild(actions);

  card.appendChild(visual);
  card.appendChild(body);
  card.appendChild(footer);
  list.appendChild(card);
}

function renderRemoteInstance(list, remote, state) {
  const operationRunning = isBlockingOperationRunning(state);
  const cloneTarget = localCloneTargetForRemote(remote, state?.containers);
  const card = document.createElement("div");
  card.className = "dm-card";

  const visual = createInstanceVisual(remote?.name || "Remote instance", {
    seed: remoteInstanceVisualSeed(remote),
    color: remote?.color || ""
  });

  const body = document.createElement("div");
  body.className = "dm-card-body";
  const title = document.createElement("div");
  title.className = "dm-card-title";
  title.textContent = remote?.name || "Remote instance";
  body.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "dm-card-meta";
  meta.textContent = remote?.url || "";
  body.appendChild(meta);

  const footer = document.createElement("div");
  footer.className = "dm-card-footer";

  const statusEl = document.createElement("span");
  const remoteStatus = remoteInstanceStatusModel(remote);
  statusEl.className = `status ${remoteStatus.className}`;
  statusEl.textContent = remoteStatus.label;
  statusEl.title = remoteStatus.title;
  footer.appendChild(statusEl);

  const actions = document.createElement("div");
  actions.className = "dm-card-actions";
  const openRemoteInstanceUi = () => {
    window.dockerManagerActions?.openInstanceUi?.({ kind: "remote", instanceId: remote?.id || "" });
  };
  bindOpenableCardHeader(visual, openRemoteInstanceUi, {
    title: "Open this remote instance",
    ariaLabel: `Open ${remote?.name || "remote instance"}`
  });

  const openBtn = document.createElement("button");
  openBtn.className = "button confirm";
  openBtn.type = "button";
  openBtn.textContent = "Open UI";
  openBtn.addEventListener("click", openRemoteInstanceUi);
  actions.appendChild(openBtn);

  const menuItems = [];
  menuItems.push(menuButton("edit", "Rename", () => {
    openRenameInstanceDialog({
      title: "Rename remote instance",
      currentName: remote?.name || "Remote instance",
      onRename: (name) => window.dockerManagerActions?.renameRemoteInstance?.(remote?.id || "", name)
    });
  }, {
    disabled: !remote?.id,
    title: "Rename this saved remote instance"
  }));
  menuItems.push(menuButton("palette", "Color", () => {
    openInstanceColorDialog({
      title: "Instance color",
      currentColor: remote?.color || "",
      onSelect: (color) => window.dockerManagerActions?.setRemoteInstanceColor?.(remote?.id || "", color)
    });
  }, {
    disabled: !remote?.id,
    title: "Choose this instance color"
  }));

  if (cloneTarget?.containerId) {
    menuItems.push(menuButton("content_copy", "Clone locally", () => {
      openCloneInstanceDialog({
        ...cloneTarget,
        instanceName: remote?.name || cloneTarget.instanceName || cloneTarget.containerName || "Remote instance"
      });
    }, {
      disabled: operationRunning,
      title: "Clone this local loopback instance on open ports"
    }));
  }

  menuItems.push(menuButton("delete", "Delete", async () => {
    if (!window.confirm(`Delete ${remote?.name || "this remote instance"}?`)) return;
    await window.dockerManagerActions?.deleteRemoteInstance?.(remote?.id || "");
  }, {
    danger: true,
    disabled: !remote?.id,
    title: "Delete this saved remote instance"
  }));

  const menu = createCardMenu(menuItems);
  actions.appendChild(menu);

  footer.appendChild(actions);

  card.appendChild(visual);
  card.appendChild(body);
  card.appendChild(footer);
  list.appendChild(card);
}

let lastLocalRenderKey = "";

function render(state) {
  const list = byId("localList");
  const subtitle = byId("sessionsSubtitle");
  if (!list) return;
  const renderKey = localCardsRenderKey(state);
  if (renderKey === lastLocalRenderKey) return;
  lastLocalRenderKey = renderKey;
  const createBtn = byId("createLocalInstanceBtn");
  if (createBtn) {
    const buttonModel = createLocalInstanceButtonModel(state);
    createBtn.disabled = !!buttonModel.disabled;
    createBtn.title = buttonModel.title || "";
  }
  const containers = Array.isArray(state?.containers) ? state.containers : [];
  const remoteInstances = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];

  if (subtitle) {
    const running = containers.filter(c => c?.state === "running").length;
    const total = containers.length + remoteInstances.length;
    const parts = [`${total} instance${total === 1 ? "" : "s"}`];
    if (running) parts.push(`${running} running`);
    if (remoteInstances.length) parts.push(`${remoteInstances.length} remote`);
    subtitle.textContent = parts.join(", ");
  }

  list.innerHTML = "";
  if (!containers.length && !remoteInstances.length) {
    renderEmptyInstances(list, state);
    return;
  }

  for (const c of containers) {
    renderDockerInstance(list, c, state);
  }
  for (const remote of remoteInstances) {
    renderRemoteInstance(list, remote, state);
  }
}

export {
  bindOpenableCardHeader,
  backgroundOperationLabel,
  computeCardMenuPlacement,
  emptyInstancesStateModel,
  instancePowerMenuConfig,
  remoteInstanceStatusModel,
  dockerInstanceRuntimeSummary,
  instanceVisualBadge,
  isBlockingOperationRunning,
  localCardsRenderKey,
  openCardMenu
};

window.addEventListener("dm:state", (e) => render(e.detail || {}));
bindActions();
if (window.__dmLastState) render(window.__dmLastState);
