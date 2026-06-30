const DEFAULT_IMAGE = "agent0ai/agent-zero";
const DEFAULT_TAG = "latest";
const DEFAULT_PORTS = "0:80";
const ADVANCED_TAB_KEY = "dm-advanced-active-tab";
const ADVANCED_TABS = ["developer", "diagnostics", "storage"];

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

function validAdvancedTab(tab) {
  return ADVANCED_TABS.includes(tab) ? tab : "developer";
}

function getAdvancedTab() {
  try {
    return validAdvancedTab(sessionStorage.getItem(ADVANCED_TAB_KEY));
  } catch {
    return "developer";
  }
}

function setStoredAdvancedTab(tab) {
  try {
    sessionStorage.setItem(ADVANCED_TAB_KEY, validAdvancedTab(tab));
  } catch {
    // Session storage may be unavailable in constrained browser contexts.
  }
}

function applyAdvancedTab(tab, { persist = true, focus = false } = {}) {
  const activeTab = validAdvancedTab(tab);
  if (persist) setStoredAdvancedTab(activeTab);

  document.querySelectorAll(".dm-advanced-tab").forEach((button) => {
    const selected = button.dataset.advancedTab === activeTab;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  });

  document.querySelectorAll(".dm-advanced-tab-panel").forEach((panel) => {
    const selected = panel.dataset.advancedPanel === activeTab;
    panel.classList.toggle("is-active", selected);
    panel.hidden = !selected;
  });
}

function bindAdvancedTabs() {
  const buttons = Array.from(document.querySelectorAll(".dm-advanced-tab"));
  if (!buttons.length) return;

  buttons.forEach((button, index) => {
    if (button.dataset.dmTabBound) return;
    button.dataset.dmTabBound = "1";
    button.addEventListener("click", () => applyAdvancedTab(button.dataset.advancedTab));
    button.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const nextIndex = (index + step + buttons.length) % buttons.length;
      applyAdvancedTab(buttons[nextIndex]?.dataset.advancedTab, { focus: true });
    });
  });

  applyAdvancedTab(getAdvancedTab(), { persist: false });
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

function scrollPanelBy(input, deltaY) {
  const scroller = input?.closest?.(".dm-advanced-tab-panel");
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
      if (scrollPanelBy(input, event.deltaY)) event.preventDefault();
      return;
    }

    const atTop = input.scrollTop <= 0;
    const atBottom = input.scrollTop >= maxScrollTop - 1;
    if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
      if (scrollPanelBy(input, event.deltaY)) event.preventDefault();
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

function displayText(value, fallback = "Unknown") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function yesNo(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Unknown";
}

function formatDockerFlavor(value) {
  const flavor = String(value || "").trim();
  const labels = {
    docker_desktop: "Docker Desktop",
    docker_engine: "Docker Engine",
    colima: "Colima",
    orbstack: "OrbStack",
    rancher_desktop: "Rancher Desktop",
    podman: "Podman",
    wsl_engine: "Agent Zero local runtime",
    unknown: "Docker runtime"
  };
  return labels[flavor] || displayText(flavor, "Docker runtime");
}

function formatHost(value, fallback = "Default Docker host") {
  const text = String(value || "").trim();
  return text || fallback;
}

function formatRuntimeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.floor(n)) : "Unknown";
}

function formatCpuCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "Unknown";
  return `${Math.floor(n)} CPU${Math.floor(n) === 1 ? "" : "s"}`;
}

function joinList(value, fallback = "None reported") {
  const items = Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
  return items.length ? items.join(", ") : fallback;
}

function diagnosticRow(label, value, className = "") {
  const row = document.createElement("div");
  row.className = "dm-diagnostic-row";
  const labelEl = document.createElement("div");
  labelEl.className = "dm-diagnostic-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.className = `dm-diagnostic-value${className ? ` ${className}` : ""}`;
  valueEl.textContent = displayText(value);
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  return row;
}

function diagnosticSection(title, rows) {
  const section = document.createElement("section");
  section.className = "dm-diagnostic-section";
  const heading = document.createElement("h4");
  heading.className = "dm-diagnostic-heading";
  heading.textContent = title;
  const list = document.createElement("div");
  list.className = "dm-diagnostic-rows";
  for (const row of rows) {
    if (!row || row.length < 2) continue;
    list.appendChild(diagnosticRow(row[0], row[1], row[2] || ""));
  }
  section.appendChild(heading);
  section.appendChild(list);
  return section;
}

function renderRuntimeSummary(box, state, diagnostic) {
  const runtimeDiagnostics = state?.runtimeDiagnostics || {};
  const runtime = state?.runtime || {};
  const env = state?.environment || {};
  const available = state?.dockerAvailable || runtimeDiagnostics.reachable === true;
  const summary = document.createElement("div");
  summary.className = "dm-diagnostic-summary";

  const dot = document.createElement("span");
  dot.className = `dm-diagnostic-dot ${available ? "is-ok" : "is-warn"}`;
  dot.setAttribute("aria-hidden", "true");

  const copy = document.createElement("div");
  const title = document.createElement("div");
  title.className = "dm-diagnostic-summary-title";
  title.textContent = available ? "Docker runtime is reachable" : "Docker runtime is unavailable";
  const detail = document.createElement("div");
  detail.className = "sv-subtitle";
  detail.textContent = diagnostic;
  copy.appendChild(title);
  copy.appendChild(detail);

  const meta = document.createElement("div");
  meta.className = "dm-diagnostic-summary-meta";
  meta.textContent = [
    formatDockerFlavor(runtimeDiagnostics.dockerFlavor || runtime.dockerFlavor || env.dockerFlavor),
    displayText(runtimeDiagnostics.serverVersion || env.daemonVersion, "")
  ].filter(Boolean).join(" - ");

  summary.appendChild(dot);
  summary.appendChild(copy);
  summary.appendChild(meta);
  box.appendChild(summary);
}

function renderDiagnostics(state) {
  const box = byId("advancedDiagnostics");
  const env = state?.environment || {};
  const runtime = state?.runtime || {};
  const runtimeDiagnostics = state?.runtimeDiagnostics || {};
  const diagnostic = compactText(
    runtimeDiagnostics.diagnosticMessage || env.diagnosticMessage || runtime.detail || state?.error,
    "No diagnostic message"
  );

  if (!box) return;
  box.innerHTML = "";
  renderRuntimeSummary(box, state, diagnostic);
  box.appendChild(diagnosticSection("Engine", [
    ["Endpoint", formatHost(runtimeDiagnostics.dockerHost || runtime.dockerHost || env.dockerHost?.raw)],
    ["Server version", runtimeDiagnostics.serverVersion || env.daemonVersion],
    ["API version", runtimeDiagnostics.apiVersion],
    ["Operating system", runtimeDiagnostics.operatingSystem || runtimeDiagnostics.os],
    ["Architecture", runtimeDiagnostics.arch || env.arch],
    ["Kernel", runtimeDiagnostics.kernelVersion],
    ["Docker root", runtimeDiagnostics.dockerRootDir]
  ]));
  box.appendChild(diagnosticSection("Configuration", [
    ["Storage driver", runtimeDiagnostics.storageDriver],
    ["Cgroup", [runtimeDiagnostics.cgroupDriver, runtimeDiagnostics.cgroupVersion].filter(Boolean).join(" / ")],
    ["Logging driver", runtimeDiagnostics.loggingDriver],
    ["Rootless", yesNo(runtimeDiagnostics.rootless)],
    ["Live restore", yesNo(runtimeDiagnostics.liveRestoreEnabled)],
    ["Security", joinList(runtimeDiagnostics.securityOptions)]
  ]));
  box.appendChild(diagnosticSection("Resources", [
    ["Containers", [
      `${formatRuntimeCount(runtimeDiagnostics.containers?.running)} running`,
      `${formatRuntimeCount(runtimeDiagnostics.containers?.paused)} paused`,
      `${formatRuntimeCount(runtimeDiagnostics.containers?.stopped)} stopped`
    ].join(" / ")],
    ["Images", formatRuntimeCount(runtimeDiagnostics.images ?? (state?.images || []).length)],
    ["CPUs", formatCpuCount(runtimeDiagnostics.cpus)],
    ["Memory", fmtBytes(runtimeDiagnostics.memoryBytes)],
    ["Docker free", fmtBytes(state?.storage?.freeBytes)],
    ["Images used", fmtBytes(state?.storage?.usedBytes)]
  ]));
  box.appendChild(diagnosticSection("Launcher Inventory", [
    ["Installs", String((state?.images || []).length || 0)],
    ["Instances", String((state?.containers || []).length || 0)],
    ["Storage volumes", String((state?.volumes || []).length || 0)]
  ]));

  const warnings = Array.isArray(runtimeDiagnostics.warnings) ? runtimeDiagnostics.warnings : [];
  if (warnings.length) {
    box.appendChild(diagnosticSection("Warnings", warnings.map((warning) => ["Docker", warning])));
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

function currentStoragePreferences(state) {
  const prefs = state?.storagePreferences && typeof state.storagePreferences === "object" ? state.storagePreferences : {};
  return {
    mode: prefs.mode === "named_volume" ? "named_volume" : "host_directory",
    hostRoot: compactText(prefs.hostRoot, "~/agent-zero"),
    hostPathMode: prefs.hostPathMode === "exact" ? "exact" : "per_instance",
    volumePrefix: compactText(prefs.volumePrefix, "a0-launcher")
  };
}

function renderStoragePreferences(state) {
  const prefs = currentStoragePreferences(state);
  const mode = byId("workspaceStorageMode");
  const hostRoot = byId("workspaceHostRoot");
  const hostPathMode = byId("workspaceHostPathMode");
  const volumePrefix = byId("workspaceVolumePrefix");
  const save = byId("saveWorkspaceStorageBtn");
  const operationRunning = state?.progress?.status === "running";

  if (mode && !mode.dataset.dirty) mode.value = prefs.mode;
  if (hostRoot && !hostRoot.dataset.dirty) hostRoot.value = prefs.hostRoot;
  if (hostPathMode && !hostPathMode.dataset.dirty) hostPathMode.value = prefs.hostPathMode;
  if (volumePrefix && !volumePrefix.dataset.dirty) volumePrefix.value = prefs.volumePrefix;
  if (save) save.disabled = operationRunning;
}

async function saveStoragePreferences() {
  const payload = {
    mode: byId("workspaceStorageMode")?.value || "host_directory",
    hostRoot: byId("workspaceHostRoot")?.value || "~/agent-zero",
    hostPathMode: byId("workspaceHostPathMode")?.value || "per_instance",
    volumePrefix: byId("workspaceVolumePrefix")?.value || "a0-launcher"
  };
  const saved = await window.dockerManagerActions?.setStoragePreferences?.(payload);
  if (!saved) return;
  ["workspaceStorageMode", "workspaceHostRoot", "workspaceHostPathMode", "workspaceVolumePrefix"].forEach((id) => {
    const input = byId(id);
    if (input) delete input.dataset.dirty;
  });
}

function render(state) {
  lastState = state || {};
  const subtitle = byId("advancedSubtitle");
  if (subtitle) {
    const running = (lastState.containers || []).filter((item) => item?.state === "running").length;
    subtitle.textContent = `${running} running, ${(lastState.images || []).length} image${(lastState.images || []).length === 1 ? "" : "s"}`;
  }
  renderStoragePreferences(lastState);
  renderDiagnostics(lastState);
  renderVolumes(lastState);
  updateActionState();
}

function bind() {
  if (document.body.dataset.dmAdvancedBound) return;
  document.body.dataset.dmAdvancedBound = "1";
  setInitialFormValues();
  bindAdvancedTabs();

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
  byId("saveWorkspaceStorageBtn")?.addEventListener("click", saveStoragePreferences);
  [
    byId("workspaceStorageMode"),
    byId("workspaceHostRoot"),
    byId("workspaceHostPathMode"),
    byId("workspaceVolumePrefix")
  ].forEach((input) => {
    input?.addEventListener("input", () => { input.dataset.dirty = "1"; });
    input?.addEventListener("change", () => { input.dataset.dirty = "1"; });
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
