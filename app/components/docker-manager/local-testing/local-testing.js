import { createInstanceVisual } from "../card-visuals.js";

function byId(id) { return document.getElementById(id); }

let logsRequestSeq = 0;

function normalizeUrlInput(value) {
  let raw = String(value || "").trim();
  if (!raw) return null;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) raw = `http://${raw}`;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function defaultRemoteName(value) {
  const parsed = normalizeUrlInput(value);
  return parsed?.hostname || "";
}

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

function dockerInstanceRuntimeSummary(c) {
  const branch = runtimeBranch(c);
  const shortCommit = runtimeShortCommit(c);
  if (branch && shortCommit) return `${branch} @ ${shortCommit}`;
  return branch || shortCommit || "";
}

function workspaceStorageSummary(c) {
  const storage = c?.workspaceStorage || null;
  if (!storage) return "";
  if (storage.legacy || storage.mode === "legacy_ephemeral") {
    return storage.migrationAvailable ? "Legacy ephemeral workspace - migration available" : "Legacy ephemeral workspace";
  }
  if (storage.mode === "ephemeral" || storage.persistent === false) {
    return storage.migrationAvailable ? "Ephemeral workspace - migration available" : "Ephemeral workspace";
  }
  if (storage.mode === "named_volume") return "Named volume workspace";
  if (storage.mode === "host_directory") return "Persistent workspace";
  if (storage.mode === "custom_mount") return "Custom workspace mount";
  return storage.persistent ? "Persistent workspace" : "";
}

function workspaceMigrationAvailable(c) {
  const storage = c?.workspaceStorage || null;
  return !!(storage && (storage.migrationAvailable || storage.legacy || storage.persistent === false));
}

function workspaceStorageFolderAvailable(c) {
  const storage = c?.workspaceStorage || null;
  return !!(storage?.persistent && typeof storage.hostPath === "string" && storage.hostPath.trim());
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

function closeDialog(dialog) {
  if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
}

function closeCardMenus(except = null) {
  document.querySelectorAll(".dm-card-menu.open").forEach((menu) => {
    if (menu === except) return;
    menu.classList.remove("open");
    menu.querySelector(".dm-card-menu-trigger")?.setAttribute("aria-expanded", "false");
  });
}

function bindCardMenuDismissal() {
  if (document.body.dataset.dmCardMenuDismissalBound) return;
  document.body.dataset.dmCardMenuDismissalBound = "1";
  document.addEventListener("click", () => closeCardMenus());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeCardMenus();
  });
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

function openAddRemoteInstanceDialog() {
  const existing = document.getElementById("remoteInstanceDialog");
  if (existing) existing.remove();

  const dialog = document.createElement("div");
  dialog.id = "remoteInstanceDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.setAttribute("role", "presentation");
  dialog.innerHTML = `
    <form class="dm-dialog" role="dialog" aria-modal="true" aria-labelledby="remoteInstanceTitle">
      <div class="dm-dialog-header">
        <h2 id="remoteInstanceTitle" class="dm-dialog-title">Add remote instance</h2>
        <button class="button dm-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <div class="dm-dialog-body">
        <div class="dm-field">
          <label for="remoteInstanceUrl">Instance URL</label>
          <input id="remoteInstanceUrl" class="dm-text-input" type="text" inputmode="url" autocomplete="url" placeholder="https://agent-zero.example.com">
          <div class="dm-field-hint">Use the URL where this Agent Zero instance is already running. If no protocol is entered, the launcher will use http://.</div>
        </div>
        <div class="dm-field">
          <label for="remoteInstanceName">Display name</label>
          <input id="remoteInstanceName" class="dm-text-input" type="text" maxlength="80" autocomplete="off" placeholder="Remote instance">
          <div class="dm-field-hint">Optional. This is only the friendly name shown in Instances.</div>
        </div>
      </div>
      <div class="dm-dialog-footer">
        <button class="button" type="button" data-dialog-close>Cancel</button>
        <button class="button confirm" type="submit">Add instance</button>
      </div>
    </form>
  `;

  const form = dialog.querySelector("form");
  const urlInput = dialog.querySelector("#remoteInstanceUrl");
  const nameInput = dialog.querySelector("#remoteInstanceName");

  urlInput?.addEventListener("input", () => {
    if (!nameInput || nameInput.dataset.dirty) return;
    nameInput.value = defaultRemoteName(urlInput.value);
  });
  nameInput?.addEventListener("input", () => {
    nameInput.dataset.dirty = "1";
  });

  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = urlInput?.value || "";
    if (!normalizeUrlInput(url)) {
      window.toastFrontendError?.("Enter a valid instance URL.", "Agent Zero");
      return;
    }
    const ok = await window.dockerManagerActions?.addRemoteInstance?.({
      url,
      name: nameInput?.value || ""
    });
    if (ok) closeDialog(dialog);
  });

  document.body.appendChild(dialog);
  window.setTimeout(() => urlInput?.focus(), 0);
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
        <p class="dm-dialog-copy">Choose the /a0/usr data to copy into the new workspace for <strong>${escapeHtml(displayName)}</strong>. Clearing every option creates a clone with a fresh empty /a0/usr workspace. Cloning pauses and resumes the source container during the snapshot; any running AI work stops and must be resumed manually.</p>
        <div class="dm-clone-toolbar">
          <button class="button" type="button" data-clone-select-all>Select all</button>
          <button class="button" type="button" data-clone-clear>Clear</button>
        </div>
        <div class="dm-clone-options">
          ${optionRows}
        </div>
      </div>
      <div class="dm-dialog-footer">
        <button class="button" type="button" data-dialog-close>Cancel</button>
        <button class="button confirm" type="submit">Clone</button>
      </div>
    </form>
  `;

  const form = dialog.querySelector("form");
  const boxes = () => [...dialog.querySelectorAll('input[name="cloneWorkspaceCategory"]')];

  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.querySelector("[data-clone-select-all]")?.addEventListener("click", () => {
    boxes().forEach((box) => { box.checked = true; });
  });
  dialog.querySelector("[data-clone-clear]")?.addEventListener("click", () => {
    boxes().forEach((box) => { box.checked = false; });
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
  window.setTimeout(() => {
    boxes()[0]?.focus();
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
  closeBtn.className = "button dm-icon-button";
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
  const displayName = c?.instanceName || c?.containerName || c?.containerId?.slice(0, 12) || "instance";
  const imageTag = imageTagForContainer(c);
  const cliHost = localUiUrl(c?.uiUrl);
  const cliInstalled = state?.cli?.installed === true;
  const card = document.createElement("div");
  card.className = "dm-card";

  const visual = createInstanceVisual(displayName, {
    badge: imageTag,
    seed: `${displayName}:${imageTag || containerId}`
  });

  const body = document.createElement("div");
  body.className = "dm-card-body";
  const title = document.createElement("div");
  title.className = "dm-card-title";
  title.textContent = displayName;
  body.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "dm-card-meta";
  const parts = [];
  const runtimeSummary = dockerInstanceRuntimeSummary(c);
  if (runtimeSummary) {
    parts.push(runtimeSummary);
    if (imageTag && imageTag !== runtimeBranch(c)) parts.push(`image ${imageTag}`);
  }
  const workspaceSummary = workspaceStorageSummary(c);
  if (workspaceSummary) parts.push(workspaceSummary);
  if (c?.uiUrl) parts.push(c.uiUrl);
  else if (c?.status) parts.push(c.status);
  meta.textContent = parts.join(" \u00B7 ");
  body.appendChild(meta);

  const footer = document.createElement("div");
  footer.className = "dm-card-footer";

  const statusEl = document.createElement("span");
  statusEl.className = "status";
  const st = (c?.state || "unknown").toLowerCase();
  if (st === "running") {
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
    startBtn.disabled = operationRunning;
    startBtn.addEventListener("click", () => {
      window.dockerManagerActions?.startActive?.();
    });
    actions.appendChild(startBtn);
  } else if (isManagedLocalInstance) {
    const startBtn = document.createElement("button");
    startBtn.className = "button confirm";
    startBtn.type = "button";
    startBtn.textContent = "Start";
    startBtn.disabled = operationRunning;
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
      disabled: !containerId || operationRunning,
      title: "Rename this instance"
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
    workspaceMigrationAvailable(c) ? menuButton("drive_file_move", "Persist a0/usr data", async () => {
      if (!window.confirm(`Create persistent /a0/usr storage for ${displayName}?\n\nThe source container will be paused and resumed during the snapshot. Any running AI work stops and must be resumed manually.\n\nThe existing container will be kept until the persistent replacement starts successfully.`)) return;
      await window.dockerManagerActions?.migrateLocalInstanceStorage?.(containerId);
    }, {
      disabled: !containerId || operationRunning,
      title: "Create persistent /a0/usr storage"
    }) : null,
    menuButton("content_copy", "Clone", () => {
      openCloneInstanceDialog(c);
    }, {
      disabled: !containerId || operationRunning,
      title: "Clone this instance on open ports"
    }),
    menuButton(cliInstalled ? "terminal" : "download", cliInstalled ? "Open A0 CLI" : "Install A0 CLI", () => {
      if (cliInstalled) window.dockerManagerActions?.openCliTerminal?.(cliHost);
      else window.dockerManagerActions?.installCli?.();
    }, {
      disabled: cliInstalled ? (!isRunning || !cliHost || operationRunning) : operationRunning,
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
      disabled: !isRunning || !containerId || operationRunning,
      title: isRunning ? "Stop this instance" : "Instance is not running"
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
      disabled: !containerId || operationRunning,
      title: "Delete this container"
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
    seed: remoteInstanceVisualSeed(remote)
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
    list.innerHTML = '<div class="dm-empty">No instances found. Run an install or add a remote instance.</div>';
    return;
  }

  for (const c of containers) {
    renderDockerInstance(list, c, state);
  }
  for (const remote of remoteInstances) {
    renderRemoteInstance(list, remote, state);
  }
}

window.addEventListener("dm:state", (e) => render(e.detail || {}));
bindActions();
if (window.__dmLastState) render(window.__dmLastState);
