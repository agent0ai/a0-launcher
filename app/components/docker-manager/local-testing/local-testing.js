function byId(id) { return document.getElementById(id); }

function fmtUptime(started) {
  if (!started) return "";
  const ms = Date.now() - Date.parse(started);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

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

function closeDialog(dialog) {
  if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
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
  const addBtn = byId("addRemoteInstanceBtn");
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = "1";
    addBtn.addEventListener("click", openAddRemoteInstanceDialog);
  }
}

function renderDockerInstance(list, c, state) {
  const operationRunning = state?.progress?.status === "running";
  const card = document.createElement("div");
  card.className = "dm-card";

  const visual = document.createElement("div");
  visual.className = "dm-card-visual";
  const logo = document.createElement("img");
  logo.className = "dm-card-logo";
  logo.src = "assets/darkSymbol.svg";
  logo.alt = "Agent Zero";
  visual.appendChild(logo);

  const body = document.createElement("div");
  body.className = "dm-card-body";
  const title = document.createElement("div");
  title.className = "dm-card-title";
  title.textContent = c?.instanceName || c?.containerName || c?.containerId?.slice(0, 12) || "instance";
  body.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "dm-card-meta";
  const parts = [];
  if (c?.imageRef) parts.push(c.imageRef);
  if (c?.uiUrl) parts.push(c.uiUrl);
  const startedAt = c?.startedAt || c?.createdAt;
  if (c?.state === "running" && startedAt) {
    const up = fmtUptime(startedAt);
    if (up) parts.push("Up " + up);
  }
  if (c?.status) parts.push(c.status);
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

  if (st === "running") {
    const openBtn = document.createElement("button");
    openBtn.className = "button confirm";
    openBtn.type = "button";
    openBtn.textContent = "Open UI";
    openBtn.addEventListener("click", () => {
      window.dockerManagerActions?.openUi?.(c?.containerId || "");
    });
    actions.appendChild(openBtn);

    if (isActiveInstance) {
      const stopBtn = document.createElement("button");
      stopBtn.className = "button cancel";
      stopBtn.type = "button";
      stopBtn.textContent = "Stop";
      stopBtn.disabled = operationRunning;
      stopBtn.addEventListener("click", () => {
        window.dockerManagerActions?.stopActive?.();
      });
      actions.appendChild(stopBtn);
    }
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

  footer.appendChild(actions);

  card.appendChild(visual);
  card.appendChild(body);
  card.appendChild(footer);
  list.appendChild(card);
}

function renderRemoteInstance(list, remote) {
  const card = document.createElement("div");
  card.className = "dm-card";

  const visual = document.createElement("div");
  visual.className = "dm-card-visual";
  const logo = document.createElement("img");
  logo.className = "dm-card-logo";
  logo.src = "assets/darkSymbol.svg";
  logo.alt = "Agent Zero";
  visual.appendChild(logo);

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
    window.dockerManagerActions?.openRemoteInstance?.(remote?.id || "");
  });
  actions.appendChild(openBtn);

  const removeBtn = document.createElement("button");
  removeBtn.className = "button cancel";
  removeBtn.type = "button";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => {
    window.dockerManagerActions?.deleteRemoteInstance?.(remote?.id || "");
  });
  actions.appendChild(removeBtn);

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
    list.innerHTML = '<div class="dm-empty">No instances found. Activate an install or add a remote instance.</div>';
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
