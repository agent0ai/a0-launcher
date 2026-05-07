function byId(id) { return document.getElementById(id); }

function fmtDate(v) {
  if (!v) return "";
  const n = Date.parse(v);
  if (!Number.isFinite(n)) return String(v);
  try { return new Date(n).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch { return String(v); }
}

function fmtSize(bytes) {
  if (!bytes || !Number.isFinite(Number(bytes))) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = Number(bytes);
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function sanitizeName(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned || "agent-zero";
}

function defaultInstanceName(tag) {
  return sanitizeName(`agent-zero-${tag || "instance"}`).slice(0, 64);
}

function normalizeInstalledEntries(state) {
  const versions = Array.isArray(state?.versions) ? state.versions : [];
  const installed = versions
    .filter((v) => v?.availability && v.availability !== "available")
    .map((v) => ({
      tag: v.id,
      title: v.displayVersion || v.id,
      category: v.category,
      availability: v.availability,
      installability: v.installability || null,
      badges: Array.isArray(v.channelBadges) ? v.channelBadges : [],
      isActive: !!v.isActive,
      activeState: v.activeState || null,
      publishedAt: v.publishedAt || null,
      sizeBytes: v.sizeBytes || null,
      matchHint: v.matchHint || "",
      digestHint: v.digestHint || ""
    }));

  if (installed.length) return installed;

  const images = Array.isArray(state?.images) ? state.images : [];
  return images.map((img) => ({
    tag: img?.tag || img?.imageRef || "unknown",
    title: img?.tag || img?.imageRef || "unknown",
    imageRef: img?.imageRef || "",
    availability: "installed",
    isActive: !!img?.isActive,
    publishedAt: img?.createdAt || null,
    sizeBytes: img?.size || img?.sizeBytes || null
  }));
}

function hasDifferentActive(state, tag) {
  const versions = Array.isArray(state?.versions) ? state.versions : [];
  return versions.some((v) => v?.isActive && v?.id !== tag);
}

function closeDialog(dialog) {
  if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
}

function openActivateDialog(entry, state) {
  const existing = document.getElementById("activateInstanceDialog");
  if (existing) existing.remove();

  const tag = entry?.tag || "";
  const requiresAck = hasDifferentActive(state, tag);
  const dialog = document.createElement("div");
  dialog.id = "activateInstanceDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.setAttribute("role", "presentation");

  dialog.innerHTML = `
    <form class="dm-dialog" role="dialog" aria-modal="true" aria-labelledby="activateInstanceTitle">
      <div class="dm-dialog-header">
        <h2 id="activateInstanceTitle" class="dm-dialog-title">Activate instance</h2>
        <button class="button dm-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <div class="dm-dialog-body">
        <div class="dm-field">
          <label for="activateInstanceName">Instance name</label>
          <input id="activateInstanceName" class="dm-text-input" type="text" maxlength="64" autocomplete="off">
          <div class="dm-field-hint">A friendly name shown in the launcher. The managed Docker name stays stable so rollback keeps working.</div>
        </div>
        <details class="dm-advanced">
          <summary>Advanced</summary>
          <div class="dm-advanced-body">
            <div class="dm-field">
              <label for="activatePortMappings">Port mapping</label>
              <textarea id="activatePortMappings" class="dm-textarea" spellcheck="false"></textarea>
              <div class="dm-field-hint">Use Docker-style host:container mappings. <strong>0:80</strong> lets Docker choose an open local host port for the Agent Zero UI.</div>
            </div>
            <div class="dm-field">
              <label for="activateEnvVars">Environment variables</label>
              <textarea id="activateEnvVars" class="dm-textarea" spellcheck="false" placeholder="A0_SET_chat_model_provider=anthropic&#10;A0_SET_chat_model_name=claude-3-5-sonnet-20241022"></textarea>
              <div class="dm-field-hint">Agent Zero supports <strong>A0_SET_&lt;setting_name&gt;=&lt;value&gt;</strong> for initial defaults. Saved settings still take precedence, and restart is required for changes.</div>
            </div>
          </div>
        </details>
        <div id="activateAckField" class="dm-field ${requiresAck ? "" : "hidden"}">
          <div class="dm-field-label">Current instance</div>
          <label class="dm-radio-line"><input type="radio" name="dataLossAck" value="has_backup"> I have a backup</label>
          <label class="dm-radio-line"><input type="radio" name="dataLossAck" value="proceed_without_backup"> Proceed without backup</label>
          <div class="dm-field-hint">The current active instance will be stopped and retained as a rollback target when possible.</div>
        </div>
      </div>
      <div class="dm-dialog-footer">
        <button class="button" type="button" data-dialog-close>Cancel</button>
        <button class="button confirm" type="submit">Activate</button>
      </div>
    </form>
  `;

  const form = dialog.querySelector("form");
  const nameInput = dialog.querySelector("#activateInstanceName");
  const portInput = dialog.querySelector("#activatePortMappings");
  const envInput = dialog.querySelector("#activateEnvVars");
  if (nameInput) nameInput.value = defaultInstanceName(tag);
  if (portInput) portInput.value = "0:80";

  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selectedAck = dialog.querySelector('input[name="dataLossAck"]:checked')?.value || "";
    if (requiresAck && !selectedAck) {
      window.toastFrontendError?.("Choose how to proceed with the current active instance.", "Agent Zero");
      return;
    }
    const options = {
      instanceName: nameInput?.value || "",
      portMappings: portInput?.value || "0:80",
      envText: envInput?.value || "",
      dataLossAck: selectedAck || "proceed_without_backup"
    };
    closeDialog(dialog);
    await window.dockerManagerActions?.activateTag?.(tag, options);
  });

  document.body.appendChild(dialog);
  window.setTimeout(() => nameInput?.focus(), 0);
}

function render(state) {
  const subtitle = byId("officialSubtitle");
  const list = byId("officialList");
  if (!list) return;

  const entries = normalizeInstalledEntries(state);
  if (subtitle) subtitle.textContent = `${entries.length} install${entries.length === 1 ? "" : "s"} detected`;

  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = '<div class="dm-empty">No installs found. Pull or install an Agent Zero image to get started.</div>';
    return;
  }

  for (const entry of entries) {
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
    title.textContent = entry.title;
    for (const badgeName of entry.badges || []) {
      const badge = document.createElement("span");
      badge.className = `badge badge-${badgeName}`;
      badge.textContent = badgeName;
      title.appendChild(badge);
    }
    if (entry.category === "local_build") {
      const badge = document.createElement("span");
      badge.className = "badge badge-canonical";
      badge.textContent = "local";
      title.appendChild(badge);
    }
    body.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "dm-card-meta";
    const parts = [];
    if (entry.imageRef) parts.push(entry.imageRef);
    if (entry.publishedAt) parts.push("Created " + fmtDate(entry.publishedAt));
    if (entry.sizeBytes) parts.push(fmtSize(entry.sizeBytes));
    if (entry.matchHint) parts.push(entry.matchHint);
    meta.textContent = parts.join(" · ");
    body.appendChild(meta);

    const footer = document.createElement("div");
    footer.className = "dm-card-footer";

    const statusEl = document.createElement("span");
    statusEl.className = "status";
    if (entry.isActive) {
      statusEl.classList.add("status-active");
      statusEl.textContent = entry.activeState === "running" ? "Running" : "Active";
    } else {
      statusEl.classList.add("status-installed");
      statusEl.textContent = entry.availability === "installing" ? "Working" : "Installed";
    }
    footer.appendChild(statusEl);

    const actions = document.createElement("div");
    actions.className = "dm-card-actions";

    if (!entry.isActive && entry.availability !== "installing") {
      const activateBtn = document.createElement("button");
      activateBtn.className = "button confirm";
      activateBtn.type = "button";
      activateBtn.textContent = "Activate";
      activateBtn.addEventListener("click", () => openActivateDialog(entry, state));
      actions.appendChild(activateBtn);
    }

    footer.appendChild(actions);

    card.appendChild(visual);
    card.appendChild(body);
    card.appendChild(footer);
    list.appendChild(card);
  }
}

window.addEventListener("dm:state", (e) => render(e.detail || {}));
if (window.__dmLastState) render(window.__dmLastState);
