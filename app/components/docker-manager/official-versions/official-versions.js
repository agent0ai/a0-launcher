import { createVersionVisual } from "../card-visuals.js";

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

function parseReleaseTagParts(tag) {
  const normalized = String(tag || "").trim().replace(/^v/, "");
  const match = normalized.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0)
  };
}

function isLatestEntry(entry) {
  return entry?.tag === "latest";
}

function isReadyEntry(entry) {
  return entry?.tag === "ready";
}

function isPinnedChannelEntry(entry) {
  return isLatestEntry(entry) || isReadyEntry(entry);
}

function isTestingEntry(entry) {
  return entry?.tag === "testing";
}

function isHiddenEntry(entry) {
  return isTestingEntry(entry);
}

function isReleaseTag(entry) {
  return !!parseReleaseTagParts(entry?.tag);
}

function compareReleaseTags(a, b) {
  const aParts = parseReleaseTagParts(a);
  const bParts = parseReleaseTagParts(b);
  if (!aParts && !bParts) return 0;
  if (!aParts) return 1;
  if (!bParts) return -1;

  if (aParts.major !== bParts.major) return bParts.major - aParts.major;
  if (aParts.minor !== bParts.minor) return bParts.minor - aParts.minor;
  if (aParts.patch !== bParts.patch) return bParts.patch - aParts.patch;
  return 0;
}

function normalizeDate(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? t : null;
}

function orderedEntries(entries) {
  return [...entries].sort((left, right) => {
    const leftLatest = isLatestEntry(left);
    const rightLatest = isLatestEntry(right);
    if (leftLatest && !rightLatest) return -1;
    if (!leftLatest && rightLatest) return 1;

    const leftReady = isReadyEntry(left);
    const rightReady = isReadyEntry(right);
    if (leftReady && !rightReady) return -1;
    if (!leftReady && rightReady) return 1;

    const leftTesting = isTestingEntry(left);
    const rightTesting = isTestingEntry(right);
    if (leftTesting && !rightTesting) return 1;
    if (!leftTesting && rightTesting) return -1;

    const leftIsRelease = isReleaseTag(left);
    const rightIsRelease = isReleaseTag(right);
    if (leftIsRelease && rightIsRelease) {
      const tagCompare = compareReleaseTags(left.tag, right.tag);
      if (tagCompare !== 0) return tagCompare;
      const leftDate = normalizeDate(left.publishedAt);
      const rightDate = normalizeDate(right.publishedAt);
      if (leftDate !== null && rightDate !== null && leftDate !== rightDate) return rightDate - leftDate;
      if (leftDate !== null && rightDate === null) return -1;
      if (leftDate === null && rightDate !== null) return 1;
      return (left.tag || "").localeCompare(right.tag || "", undefined, { numeric: true, sensitivity: "base" });
    }
    if (leftIsRelease && !rightIsRelease) return -1;
    if (!leftIsRelease && rightIsRelease) return 1;

    const leftDate = normalizeDate(left.publishedAt);
    const rightDate = normalizeDate(right.publishedAt);
    if (leftDate !== null && rightDate !== null && leftDate !== rightDate) return rightDate - leftDate;
    if (leftDate !== null && rightDate === null) return -1;
    if (leftDate === null && rightDate !== null) return 1;

    return (left.tag || "").localeCompare(right.tag || "", undefined, { numeric: true, sensitivity: "base" });
  });
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

function normalizeVersionEntries(state) {
  const versions = Array.isArray(state?.versions) ? state.versions : [];
  const images = Array.isArray(state?.images) ? state.images : [];
  if (versions.length) {
    const entries = versions.map((v) => ({
      tag: v?.id || "",
      title: v?.displayVersion || v?.id || "unknown",
      category: v?.category || "",
      availability: v?.availability || "available",
      installability: v?.installability || null,
      badges: Array.isArray(v?.channelBadges) ? v.channelBadges : [],
      isActive: !!v?.isActive,
      activeState: v?.activeState || null,
      publishedAt: v?.publishedAt || null,
      sizeBytes: v?.sizeBytes || null,
      matchHint: v?.matchHint || "",
      digestHint: v?.digestHint || "",
      differsFromPublished: !!v?.differsFromPublished
    })).filter((entry) => entry.tag);

    const knownTags = new Set(entries.map((entry) => entry.tag));
    for (const img of images) {
      const tag = img?.tag || img?.imageRef || "";
      if (!tag || knownTags.has(tag)) continue;
      knownTags.add(tag);
      entries.push({
        tag,
        title: tag,
        imageRef: img?.imageRef || "",
        category: "local_build",
        availability: "installed",
        isActive: !!img?.isActive,
        publishedAt: img?.createdAt || null,
        sizeBytes: img?.size || img?.sizeBytes || null,
        badges: []
      });
    }

    return entries;
  }

  return images.map((img) => ({
    tag: img?.tag || img?.imageRef || "unknown",
    title: img?.tag || img?.imageRef || "unknown",
    imageRef: img?.imageRef || "",
    availability: "installed",
    isActive: !!img?.isActive,
    publishedAt: img?.createdAt || null,
    sizeBytes: img?.size || img?.sizeBytes || null,
    badges: []
  }));
}

function statusForEntry(entry) {
  if (entry.isActive) {
    return {
      className: "status-active",
      label: entry.activeState === "running" ? "Running" : "Active"
    };
  }

  if (entry.availability === "installing") {
    return { className: "status-installed", label: "Working" };
  }

  if (entry.availability === "update_available" || entry.differsFromPublished) {
    return { className: "status-update", label: "Update available" };
  }

  if (entry.availability === "installed") {
    return { className: "status-installed", label: "Installed" };
  }

  if (entry.installability === "not_yet_available") {
    return { className: "status-unavailable", label: "Not ready" };
  }

  return { className: "status-available", label: "Available" };
}

function actionForEntry(entry, state) {
  if (entry.isActive || entry.availability === "installing") return null;

  if (entry.availability === "installed" || entry.availability === "update_available" || entry.differsFromPublished) {
    return {
      label: entry.availability === "update_available" || entry.differsFromPublished ? "Update" : "Run",
      className: "button confirm",
      handler: () => {
        if (entry.availability === "update_available" || entry.differsFromPublished) {
          window.dockerManagerActions?.installOrSync?.(entry.tag);
          return;
        }
        openActivateDialog(entry, state);
      }
    };
  }

  if (entry.installability === "not_yet_available") {
    return {
      label: "Not ready",
      className: "button",
      disabled: true,
      handler: () => {}
    };
  }

  return {
    label: "Install",
    className: "button confirm",
    handler: () => window.dockerManagerActions?.installOrSync?.(entry.tag)
  };
}

function isAwaitingFirstInventory(state, entries) {
  return !state?.stateLoaded || (!!state?.loading && !entries.length);
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
        <h2 id="activateInstanceTitle" class="dm-dialog-title">Run instance</h2>
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
        <button class="button confirm" type="submit">Run</button>
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

  const entries = orderedEntries(normalizeVersionEntries(state).filter((entry) => !isHiddenEntry(entry)));
  const installedCount = entries.filter((entry) => entry.availability && entry.availability !== "available").length;
  const availableCount = entries.filter((entry) => entry.availability === "available").length;
  const awaitingFirstInventory = isAwaitingFirstInventory(state, entries);
  if (subtitle) {
    subtitle.textContent = awaitingFirstInventory
      ? "Checking installs..."
      : entries.length
      ? `${installedCount} installed · ${availableCount} available`
      : "0 installs detected";
  }

  list.innerHTML = "";
  if (awaitingFirstInventory) {
    list.innerHTML = '<div class="dm-empty">Checking Agent Zero releases...</div>';
    return;
  }

  if (!entries.length) {
    list.innerHTML = '<div class="dm-empty">No versions found. Refresh to try again.</div>';
    return;
  }

  for (const entry of entries) {
    const card = document.createElement("div");
    card.className = isPinnedChannelEntry(entry) ? "dm-card dm-card-highlight" : "dm-card";

    const visual = createVersionVisual(entry.title || entry.tag, { seed: entry.tag || entry.title });

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
    if (entry.publishedAt) {
      parts.push(`${entry.imageRef ? "Created" : "Released"} ${fmtDate(entry.publishedAt)}`);
    }
    if (entry.sizeBytes) parts.push(fmtSize(entry.sizeBytes));
    if (isReadyEntry(entry)) parts.push("Development image with alpha features under test");
    if (entry.matchHint) parts.push(entry.matchHint);
    if (entry.digestHint) parts.push(entry.digestHint);
    meta.textContent = parts.join(" · ");
    body.appendChild(meta);

    const footer = document.createElement("div");
    footer.className = "dm-card-footer";

    const statusEl = document.createElement("span");
    statusEl.className = "status";
    const status = statusForEntry(entry);
    statusEl.classList.add(status.className);
    statusEl.textContent = status.label;
    footer.appendChild(statusEl);

    const actions = document.createElement("div");
    actions.className = "dm-card-actions";

    const action = actionForEntry(entry, state);
    if (action) {
      const actionBtn = document.createElement("button");
      actionBtn.className = action.className;
      actionBtn.type = "button";
      actionBtn.textContent = action.label;
      actionBtn.disabled = !!action.disabled;
      actionBtn.addEventListener("click", action.handler);
      actions.appendChild(actionBtn);
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
