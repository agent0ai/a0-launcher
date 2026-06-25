import {
  INSTANCE_COLOR_OPTIONS,
  createInstanceVisual,
  normalizedInstanceColorId
} from "../card-visuals.js";
import { openCloneInstanceDialog } from "../clone-instance-dialog.js";
import { openAddRemoteInstanceDialog } from "../remote-instance-dialog.js";

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

function instanceVisualBadge(c) {
  const imageTag = imageTagForContainer(c);
  const matchedReleaseTag = releaseTagLabel(c?.matchedReleaseTag);
  if ((imageTag === "latest" || imageTag === "ready") && matchedReleaseTag) {
    return `${imageTag} · ${matchedReleaseTag}`;
  }
  return runtimeBranch(c) || imageTag;
}

function dockerInstanceRuntimeSummary(c) {
  const branch = runtimeBranch(c);
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
  if (operation.type === "start") return queued ? "Queued start" : "Starting";
  if (operation.type === "stop") return queued ? "Queued stop" : "Stopping";
  if (operation.type === "delete_instance") return queued ? "Queued delete" : "Deleting";
  return queued ? "Queued" : "Working";
}

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

function fixedResourceFooterHeight() {
  const footer = document.querySelector?.(".dm-resource-footer");
  const rect = footer?.getBoundingClientRect?.();
  return rect?.height ? Math.ceil(rect.height) : 0;
}

function resetCardMenuPosition(menu) {
  if (!menu) return;
  menu.classList.remove("open-up", "open-down");
  menu.closest?.(".dm-card")?.classList.remove("menu-open");
  const popover = menu.querySelector(".dm-card-menu-popover");
  if (popover) {
    popover.style.left = "";
    popover.style.top = "";
    popover.style.maxHeight = "";
  }
}

function closeCardMenus(except = null) {
  document.querySelectorAll(".dm-card-menu.open").forEach((menu) => {
    if (menu === except) return;
    menu.classList.remove("open");
    resetCardMenuPosition(menu);
    menu.querySelector(".dm-card-menu-trigger")?.setAttribute("aria-expanded", "false");
  });
}

function positionCardMenu(menu) {
  const trigger = menu?.querySelector(".dm-card-menu-trigger");
  const popover = menu?.querySelector(".dm-card-menu-popover");
  if (!trigger || !popover) return;

  const edgeGap = 12;
  const menuGap = 6;
  popover.style.left = "";
  popover.style.top = "";
  popover.style.maxHeight = "";

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
    footerHeight: fixedResourceFooterHeight(),
    edgeGap,
    menuGap
  });

  menu.classList.toggle("open-down", placement.openDown);
  menu.classList.toggle("open-up", !placement.openDown);
  popover.style.left = `${placement.left}px`;
  popover.style.top = `${placement.top}px`;
  popover.style.maxHeight = placement.maxHeight ? `${placement.maxHeight}px` : "";
}

function positionOpenCardMenus() {
  document.querySelectorAll(".dm-card-menu.open").forEach((menu) => positionCardMenu(menu));
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
    const open = !menu.classList.contains("open");
    closeCardMenus(menu);
    menu.classList.toggle("open", open);
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      menu.closest?.(".dm-card")?.classList.add("menu-open");
      positionCardMenu(menu);
    } else {
      resetCardMenuPosition(menu);
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
  const addBtn = byId("addRemoteInstanceBtn");
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = "1";
    addBtn.addEventListener("click", openAddRemoteInstanceDialog);
  }
}

function renderDockerInstance(list, c, state) {
  const operationRunning = state?.progress?.status === "running";
  const containerId = c?.containerId || "";
  const backgroundOperation = backgroundOperationForContainer(state, containerId);
  const containerOperationRunning = !!backgroundOperation;
  const displayName = c?.instanceName || c?.containerName || c?.containerId?.slice(0, 12) || "instance";
  const visualBadge = instanceVisualBadge(c);
  const cliHost = localUiUrl(c?.uiUrl);
  const cliInstalled = state?.cli?.installed === true;
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

  if (isRunning) {
    const openBtn = document.createElement("button");
    openBtn.className = "button confirm";
    openBtn.type = "button";
    openBtn.textContent = "Open UI";
    openBtn.disabled = containerOperationRunning;
    openBtn.title = containerOperationRunning ? "An action is already queued for this instance" : "Open this instance";
    openBtn.addEventListener("click", () => {
      window.dockerManagerActions?.openInstanceUi?.({
        kind: "local",
        containerId: c?.containerId || "",
        title: displayName
      });
    });
    actions.appendChild(openBtn);
  } else if (isActiveInstance) {
    const startBtn = document.createElement("button");
    startBtn.className = "button confirm";
    startBtn.type = "button";
    startBtn.textContent = "Start";
    startBtn.disabled = containerOperationRunning;
    startBtn.addEventListener("click", () => {
      window.dockerManagerActions?.startLocalInstance?.(containerId);
    });
    actions.appendChild(startBtn);
  } else if (isManagedLocalInstance) {
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
      if (cliInstalled) window.dockerManagerActions?.openCliTerminal?.(cliHost);
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
    menuButton("stop_circle", "Stop", () => {
      window.dockerManagerActions?.stopLocalInstance?.(containerId);
    }, {
      disabled: !isRunning || !containerId || containerOperationRunning,
      title: containerOperationRunning ? "An action is already queued for this instance" : isRunning ? "Stop this instance" : "Instance is not running"
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
  const operationRunning = state?.progress?.status === "running";
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
  statusEl.className = "status status-remote";
  statusEl.textContent = "Remote";
  footer.appendChild(statusEl);

  const actions = document.createElement("div");
  actions.className = "dm-card-actions";

  const openBtn = document.createElement("button");
  openBtn.className = "button confirm";
  openBtn.type = "button";
  openBtn.textContent = "Open UI";
  openBtn.addEventListener("click", () => {
    window.dockerManagerActions?.openInstanceUi?.({ kind: "remote", instanceId: remote?.id || "" });
  });
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

function render(state) {
  const list = byId("localList");
  const subtitle = byId("sessionsSubtitle");
  if (!list) return;
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
    list.innerHTML = '<div class="dm-empty">No Instances found. Run an install or add a remote Instance.</div>';
    return;
  }

  for (const c of containers) {
    renderDockerInstance(list, c, state);
  }
  for (const remote of remoteInstances) {
    renderRemoteInstance(list, remote, state);
  }
}

export { computeCardMenuPlacement, instanceVisualBadge };

window.addEventListener("dm:state", (e) => render(e.detail || {}));
bindActions();
if (window.__dmLastState) render(window.__dmLastState);
