import { createVersionVisual } from "../card-visuals.js";

function byId(id) { return document.getElementById(id); }

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

function tagFromImageRef(value) {
  const raw = String(value || "").trim();
  if (!raw || !raw.includes(":")) return "";
  return raw.slice(raw.lastIndexOf(":") + 1);
}

function dockerInstanceVisualValue(c) {
  return c?.versionTag ||
    c?.labels?.["a0.launcher.versionTag"] ||
    c?.tag ||
    tagFromImageRef(c?.imageRef) ||
    c?.instanceName ||
    c?.containerName ||
    "Instance";
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
  const visualValue = dockerInstanceVisualValue(c);
  const cliHost = localUiUrl(c?.uiUrl);
  const card = document.createElement("div");
  card.className = "dm-card";

  const visual = createVersionVisual(visualValue, {
    seed: visualValue
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
  const isActiveInstance = c?.labels?.["a0.launcher.role"] === "active" || String(c?.containerName || "").includes("-active__");
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
  }

  const menu = createCardMenu([
    menuButton("terminal", "Open A0 CLI", () => {
      window.dockerManagerActions?.openCliTerminal?.(cliHost);
    }, {
      disabled: !isRunning || !cliHost || operationRunning,
      title: !isRunning
        ? "Start this instance before opening A0 CLI"
        : cliHost
          ? "Open A0 CLI for this instance"
          : "A0 CLI requires a running local Web UI"
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

function renderRemoteInstance(list, remote) {
  const card = document.createElement("div");
  card.className = "dm-card";

  const visual = createVersionVisual("Remote", {
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

  const menu = createCardMenu([
    menuButton("delete", "Delete", async () => {
      if (!window.confirm(`Delete ${remote?.name || "this remote instance"}?`)) return;
      await window.dockerManagerActions?.deleteRemoteInstance?.(remote?.id || "");
    }, {
      danger: true,
      disabled: !remote?.id,
      title: "Delete this saved remote instance"
    })
  ]);
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
    renderRemoteInstance(list, remote);
  }
}

window.addEventListener("dm:state", (e) => render(e.detail || {}));
bindActions();
if (window.__dmLastState) render(window.__dmLastState);
