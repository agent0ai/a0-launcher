const DEFAULT_IMAGE = "agent0ai/agent-zero";
const DEFAULT_TAG = "latest";
const DEFAULT_PORTS = "0:80";

let lastState = window.__dmLastState || {};
let lastGeneratedCompose = "";
let composeManual = false;

function byId(id) { return document.getElementById(id); }

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === "" || !Number.isFinite(Number(bytes))) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function compactText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function splitImageTag(imageValue, tagValue) {
  let image = compactText(imageValue, DEFAULT_IMAGE);
  let tag = compactText(tagValue, "");
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  let embeddedTag = "";
  if (!tag && lastColon > lastSlash) {
    embeddedTag = image.slice(lastColon + 1).trim();
    image = image.slice(0, lastColon).trim();
  } else if (lastColon > lastSlash) {
    image = image.slice(0, lastColon).trim();
  }
  return {
    image: image || DEFAULT_IMAGE,
    tag: tag || embeddedTag || DEFAULT_TAG
  };
}

function embeddedImageTag(value) {
  const image = compactText(value, "");
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon <= lastSlash) return null;
  return {
    image: image.slice(0, lastColon).trim(),
    tag: image.slice(lastColon + 1).trim()
  };
}

function sanitizeName(value, fallback = "agent-zero-dev") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return cleaned || fallback;
}

function defaultInstanceName(image, tag) {
  const tail = compactText(image, DEFAULT_IMAGE).split("/").filter(Boolean).pop() || "image";
  return sanitizeName(`${tail}-${tag || DEFAULT_TAG}`, "agent-zero-dev");
}

function serviceName(value) {
  return String(value || "agent-zero-dev")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 48) || "agent-zero-dev";
}

function yamlQuote(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function lines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function portTokens(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readForm() {
  const imageInput = byId("advancedImageInput");
  const tagInput = byId("advancedTagInput");
  const pair = splitImageTag(imageInput?.value || DEFAULT_IMAGE, tagInput?.value || "");
  const name = sanitizeName(byId("advancedInstanceNameInput")?.value || defaultInstanceName(pair.image, pair.tag));
  return {
    image: pair.image,
    tag: pair.tag,
    imageRef: `${pair.image}:${pair.tag}`,
    instanceName: name,
    pull: byId("advancedPullToggle")?.checked !== false,
    portsRaw: byId("advancedPortsInput")?.value || DEFAULT_PORTS,
    envRaw: byId("advancedEnvInput")?.value || "",
    mountsRaw: byId("advancedMountsInput")?.value || ""
  };
}

function buildComposeYaml(form) {
  const svc = serviceName(form.instanceName);
  const out = [
    "name: a0-developer",
    "services:",
    `  ${svc}:`,
    `    image: ${yamlQuote(form.imageRef)}`,
    `    container_name: ${yamlQuote(form.instanceName)}`
  ];

  if (form.pull) out.push("    pull_policy: always");

  const ports = portTokens(form.portsRaw || DEFAULT_PORTS);
  if (ports.length) {
    out.push("    ports:");
    for (const port of ports) out.push(`      - ${yamlQuote(port)}`);
  }

  const env = lines(form.envRaw);
  if (env.length) {
    out.push("    environment:");
    for (const entry of env) out.push(`      - ${yamlQuote(entry)}`);
  }

  const mounts = lines(form.mountsRaw);
  if (mounts.length) {
    out.push("    volumes:");
    for (const mount of mounts) out.push(`      - ${yamlQuote(mount)}`);
  }

  return `${out.join("\n")}\n`;
}

function updateComposePreview() {
  const preview = byId("composePreview");
  const nextCompose = buildComposeYaml(readForm());
  if (preview) {
    const canReplace = !composeManual || !preview.value.trim() || preview.value === lastGeneratedCompose;
    if (canReplace) {
      preview.value = nextCompose;
      composeManual = false;
    }
  }
  lastGeneratedCompose = nextCompose;
  updateActionState();
}

function syncDefaultName() {
  const nameInput = byId("advancedInstanceNameInput");
  if (!nameInput || nameInput.dataset.dirty) return;
  const pair = splitImageTag(byId("advancedImageInput")?.value || DEFAULT_IMAGE, byId("advancedTagInput")?.value || "");
  nameInput.value = defaultInstanceName(pair.image, pair.tag);
}

function syncEmbeddedTagFromImage() {
  const imageInput = byId("advancedImageInput");
  const tagInput = byId("advancedTagInput");
  const split = embeddedImageTag(imageInput?.value || "");
  if (!split?.image || !split?.tag || !imageInput || !tagInput || tagInput.dataset.dirty) return;
  imageInput.value = split.image;
  tagInput.value = split.tag;
}

function setInitialFormValues() {
  const imageInput = byId("advancedImageInput");
  const tagInput = byId("advancedTagInput");
  const portsInput = byId("advancedPortsInput");
  const nameInput = byId("advancedInstanceNameInput");

  if (imageInput && !imageInput.value) imageInput.value = DEFAULT_IMAGE;
  if (tagInput && !tagInput.value) tagInput.value = DEFAULT_TAG;
  if (portsInput && !portsInput.value) portsInput.value = DEFAULT_PORTS;
  if (nameInput && !nameInput.value) nameInput.value = defaultInstanceName(DEFAULT_IMAGE, DEFAULT_TAG);
}

function updateActionState() {
  const enabled = byId("developerModeToggle")?.checked === true;
  const stateEl = byId("developerModeState");
  const runBtn = byId("runCustomImageBtn");
  const operationRunning = lastState?.progress?.status === "running";
  if (stateEl) stateEl.textContent = enabled ? "On" : "Off";
  if (runBtn) runBtn.disabled = !enabled || operationRunning;
}

async function copyCompose() {
  const preview = byId("composePreview");
  const text = preview?.value || buildComposeYaml(readForm());
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      preview?.focus();
      preview?.select();
      document.execCommand("copy");
    }
    window.toastFrontendSuccess?.("Compose file copied.", "Agent Zero", 2, "dm-advanced-compose");
  } catch {
    window.toastFrontendError?.("Unable to copy Compose file.", "Agent Zero");
  }
}

function scrollPageBy(deltaY) {
  const scroller = document.scrollingElement || document.documentElement;
  if (!scroller) return false;
  const before = scroller.scrollTop;
  scroller.scrollTop += deltaY;
  return scroller.scrollTop !== before;
}

function bindWheelPassthrough(input) {
  if (!input || input.dataset.dmWheelPassthrough) return;
  input.dataset.dmWheelPassthrough = "1";
  input.addEventListener("wheel", (event) => {
    const maxScrollTop = input.scrollHeight - input.clientHeight;
    if (maxScrollTop <= 1) {
      if (scrollPageBy(event.deltaY)) event.preventDefault();
      return;
    }

    const atTop = input.scrollTop <= 0;
    const atBottom = input.scrollTop >= maxScrollTop - 1;
    if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
      if (scrollPageBy(event.deltaY)) event.preventDefault();
    }
  }, { passive: false });
}

async function runCustomImage() {
  if (byId("developerModeToggle")?.checked !== true) {
    window.toastFrontendWarning?.("Turn on Developer mode before running a custom image.", "Agent Zero");
    return;
  }
  const form = readForm();
  const ok = await window.dockerManagerActions?.runCustomImage?.({
    image: form.image,
    tag: form.tag,
    instanceName: form.instanceName,
    portMappings: form.portsRaw,
    envText: form.envRaw,
    mountsText: form.mountsRaw,
    pull: form.pull
  });
  if (ok === false) updateActionState();
}

function metric(label, value, className = "") {
  const item = document.createElement("div");
  item.className = "sv-storage-item dm-diagnostic-item";
  const labelEl = document.createElement("div");
  labelEl.className = "sv-storage-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.className = `sv-storage-value${className ? ` ${className}` : ""}`;
  valueEl.textContent = value;
  item.appendChild(labelEl);
  item.appendChild(valueEl);
  return item;
}

function renderDiagnostics(state) {
  const box = byId("advancedDiagnostics");
  const env = state?.environment || {};
  const runtime = state?.runtime || {};
  const diagnostic = compactText(env.diagnosticMessage || runtime.detail || state?.error, "No diagnostic message");

  if (box) {
    box.innerHTML = "";
    box.appendChild(metric("Docker", state?.dockerAvailable ? "Ready" : "Unavailable", state?.dockerAvailable ? "is-ok" : "is-warn"));
    box.appendChild(metric("Installs", String((state?.images || []).length || 0)));
    box.appendChild(metric("Instances", String((state?.containers || []).length || 0)));
    box.appendChild(metric("Storage volumes", String((state?.volumes || []).length || 0)));
    box.appendChild(metric("Docker free", fmtBytes(state?.storage?.freeBytes)));
    box.appendChild(metric("Images used", fmtBytes(state?.storage?.usedBytes)));
    box.appendChild(metric("Diagnostic", diagnostic));
  }
}

function renderVolumes(state) {
  const list = byId("advancedVolumesList");
  const subtitle = byId("advancedVolumesSubtitle");
  const volumes = Array.isArray(state?.volumes) ? state.volumes : [];
  if (subtitle) subtitle.textContent = `${volumes.length} volume${volumes.length === 1 ? "" : "s"}`;
  if (!list) return;

  list.innerHTML = "";
  if (!volumes.length) {
    const empty = document.createElement("div");
    empty.className = "sv-subtitle";
    empty.textContent = "No volumes found.";
    list.appendChild(empty);
    return;
  }

  for (const volume of volumes) {
    const row = document.createElement("div");
    row.className = "item";

    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = volume?.name || "volume";
    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = [volume?.driver || "", volume?.mountpoint || ""].filter(Boolean).join(" - ");
    left.appendChild(title);
    left.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "item-actions";
    const remove = document.createElement("button");
    remove.className = "button cancel";
    remove.type = "button";
    remove.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">delete</span><span>Remove</span>';
    remove.addEventListener("click", async () => {
      const name = volume?.name || "";
      if (!name || !window.confirm(`Remove volume ${name}?`)) return;
      await window.dockerManagerActions?.removeVolume?.(name);
    });
    actions.appendChild(remove);

    row.appendChild(left);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function render(state) {
  lastState = state || {};
  const subtitle = byId("advancedSubtitle");
  if (subtitle) {
    const running = (lastState.containers || []).filter((item) => item?.state === "running").length;
    subtitle.textContent = `${running} running, ${(lastState.images || []).length} image${(lastState.images || []).length === 1 ? "" : "s"}`;
  }
  renderDiagnostics(lastState);
  renderVolumes(lastState);
  updateActionState();
}

function bind() {
  if (document.body.dataset.dmAdvancedBound) return;
  document.body.dataset.dmAdvancedBound = "1";
  setInitialFormValues();

  const imageInput = byId("advancedImageInput");
  const tagInput = byId("advancedTagInput");
  const nameInput = byId("advancedInstanceNameInput");

  imageInput?.addEventListener("input", () => {
    syncEmbeddedTagFromImage();
    syncDefaultName();
    updateComposePreview();
  });
  tagInput?.addEventListener("input", () => {
    tagInput.dataset.dirty = "1";
    syncDefaultName();
    updateComposePreview();
  });
  nameInput?.addEventListener("input", () => {
    nameInput.dataset.dirty = "1";
    updateComposePreview();
  });

  [
    byId("advancedPortsInput"),
    byId("advancedEnvInput"),
    byId("advancedMountsInput"),
    byId("advancedPullToggle"),
    byId("developerModeToggle")
  ].forEach((input) => {
    input?.addEventListener("input", updateComposePreview);
    input?.addEventListener("change", updateComposePreview);
  });

  byId("copyComposeBtn")?.addEventListener("click", copyCompose);
  byId("runCustomImageBtn")?.addEventListener("click", runCustomImage);
  byId("advancedPruneVolumesBtn")?.addEventListener("click", async () => {
    if (!window.confirm("Clear unused Docker volumes?")) return;
    await window.dockerManagerActions?.pruneVolumes?.();
  });

  const composePreview = byId("composePreview");
  composePreview?.addEventListener("input", () => {
    composeManual = composePreview.value !== lastGeneratedCompose;
  });

  document.querySelectorAll(".dm-advanced-page textarea").forEach(bindWheelPassthrough);
  updateComposePreview();
}

window.addEventListener("dm:state", (event) => render(event.detail || {}));
bind();
if (window.__dmLastState) render(window.__dmLastState);
