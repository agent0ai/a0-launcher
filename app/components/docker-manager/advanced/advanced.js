import { defaultInstanceName } from "../instance-defaults.js";
import { byId, compactText } from "../component-utils.js";

const DEFAULT_IMAGE = "agent0ai/agent-zero";
const DEFAULT_TAG = "latest";
const DEFAULT_PORTS = "0:80";
const ADVANCED_TAB_KEY = "dm-advanced-active-tab";
const ADVANCED_TABS = ["developer", "diagnostics", "storage"];

let lastState = window.__dmLastState || {};
let developerEditor = null;
let editorChangeMuted = false;
let editorRetryTimer = 0;
let activeFileName = "";
let lastDeveloperProgressKey = "";
let project = { token: "", name: "", files: [], warnings: [] };

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
    tag: normalizeTagForImage(image || DEFAULT_IMAGE, tag || embeddedTag || DEFAULT_TAG)
  };
}

function normalizeTagForImage(image, tag) {
  const text = compactText(tag, DEFAULT_TAG);
  if (compactText(image, DEFAULT_IMAGE).toLowerCase() === DEFAULT_IMAGE && /^\d+\.\d+(?:\.\d+)?$/.test(text)) return `v${text}`;
  return text;
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
  if (activeTab === "developer") window.setTimeout(() => developerEditor?.resize?.(), 0);
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

function readImagePair() {
  const imageInput = byId("advancedImageInput");
  const tagInput = byId("advancedTagInput");
  const imageValue = imageInput?.value || DEFAULT_IMAGE;
  const tagValue = embeddedImageTag(imageValue)?.tag && tagInput?.dataset.dirty !== "1" ? "" : tagInput?.value || "";
  return splitImageTag(imageValue, tagValue);
}

function readQuickRunForm() {
  const pair = readImagePair();
  const name = sanitizeName(byId("advancedInstanceNameInput")?.value || defaultInstanceName(pair.tag, lastState));
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

function syncDefaultName() {
  const nameInput = byId("advancedInstanceNameInput");
  if (!nameInput || nameInput.dataset.dirty) return;
  const pair = readImagePair();
  nameInput.value = defaultInstanceName(pair.tag, lastState);
}

function syncEmbeddedTagFromImage() {
  const imageInput = byId("advancedImageInput");
  const tagInput = byId("advancedTagInput");
  const split = embeddedImageTag(imageInput?.value || "");
  if (!split?.image || !split?.tag || !imageInput || !tagInput || tagInput.dataset.dirty) return;
  imageInput.value = split.image;
  tagInput.value = normalizeTagForImage(split.image, split.tag);
}

function setInitialFormValues() {
  const imageInput = byId("advancedImageInput");
  const tagInput = byId("advancedTagInput");
  const portsInput = byId("advancedPortsInput");
  const nameInput = byId("advancedInstanceNameInput");

  if (imageInput && !imageInput.value) imageInput.value = DEFAULT_IMAGE;
  if (tagInput && !tagInput.value) tagInput.value = DEFAULT_TAG;
  if (portsInput && !portsInput.value) portsInput.value = DEFAULT_PORTS;
  if (nameInput && !nameInput.value) nameInput.value = defaultInstanceName(DEFAULT_TAG, lastState);
}

function developerFileKind(name) {
  const value = String(name || "").trim();
  if (/\.ya?ml$/i.test(value)) return "compose";
  if (/^(?:Dockerfile|Containerfile)(?:[._-][A-Za-z0-9_-]+)*$/i.test(value)) return "dockerfile";
  if (value === ".dockerignore") return "dockerignore";
  if (value === ".env.example") return "env_example";
  return "";
}

function activeFile() {
  return project.files.find((file) => file.name === activeFileName) || null;
}

function composeFile() {
  const active = activeFile();
  return active?.kind === "compose" ? active : project.files.find((file) => file.kind === "compose") || null;
}

function syncActiveFileFromEditor() {
  const file = activeFile();
  if (file && developerEditor) file.content = developerEditor.getValue();
}

function fileIsDirty(file) {
  return !!file && file.content !== file.savedContent;
}

function hasDirtyFiles() {
  syncActiveFileFromEditor();
  return project.files.some(fileIsDirty);
}

function editorMode(file) {
  if (file?.kind === "compose") return "ace/mode/yaml";
  if (file?.kind === "dockerfile") return "ace/mode/dockerfile";
  if (file?.kind === "dockerignore") return "ace/mode/gitignore";
  if (file?.kind === "env_example") return "ace/mode/sh";
  return "ace/mode/text";
}

function initDeveloperEditor() {
  if (developerEditor) return true;
  if (!window.ace || !byId("developerEditor")) {
    window.clearTimeout(editorRetryTimer);
    editorRetryTimer = window.setTimeout(initDeveloperEditor, 50);
    return false;
  }
  window.ace.config.set("basePath", "a0ui/vendor/ace-min");
  developerEditor = window.ace.edit("developerEditor");
  developerEditor.setTheme("ace/theme/github_dark");
  developerEditor.setOptions({
    fontSize: "13px",
    showPrintMargin: false,
    tabSize: 2,
    useSoftTabs: true,
    wrap: false
  });
  developerEditor.session.setUseWorker(false);
  developerEditor.on("change", () => {
    if (editorChangeMuted) return;
    const file = activeFile();
    if (!file) return;
    file.content = developerEditor.getValue();
    renderFileTabs();
    updateActionState();
  });
  developerEditor.commands.addCommand({
    name: "saveDeveloperFile",
    bindKey: { win: "Ctrl-S", mac: "Command-S" },
    exec: () => { void saveActiveDeveloperFile(); }
  });
  renderDeveloperEditor();
  return true;
}

function setOutput(text, tone = "") {
  const output = byId("developerOutputText");
  if (output) {
    output.textContent = String(text || "");
    output.classList.toggle("is-error", tone === "error");
  }
}

function renderFileTabs() {
  const tabs = byId("developerFileTabs");
  if (!tabs) return;
  tabs.innerHTML = "";
  for (const file of project.files) {
    const button = document.createElement("button");
    const selected = file.name === activeFileName;
    button.type = "button";
    button.className = `dm-developer-file-tab${selected ? " is-active" : ""}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.title = file.name;
    const name = document.createElement("span");
    name.textContent = file.name;
    button.appendChild(name);
    if (fileIsDirty(file)) {
      const dirty = document.createElement("span");
      dirty.className = "dm-developer-file-dirty";
      dirty.textContent = "●";
      dirty.setAttribute("aria-label", "Unsaved");
      button.appendChild(dirty);
    }
    button.addEventListener("click", () => setActiveDeveloperFile(file.name));
    tabs.appendChild(button);
  }
}

function renderDeveloperEditor() {
  const file = activeFile();
  const editorEl = byId("developerEditor");
  const empty = byId("developerEditorEmpty");
  if (empty) empty.hidden = !!file;
  if (editorEl) editorEl.hidden = !file;
  if (!developerEditor || !file) return;
  editorChangeMuted = true;
  developerEditor.session.setMode(editorMode(file));
  developerEditor.setValue(file.content, -1);
  developerEditor.clearSelection();
  editorChangeMuted = false;
  window.setTimeout(() => developerEditor.resize(), 0);
}

function setActiveDeveloperFile(fileName) {
  syncActiveFileFromEditor();
  activeFileName = project.files.some((file) => file.name === fileName) ? fileName : "";
  renderFileTabs();
  renderDeveloperEditor();
  updateActionState();
}

function defaultDeveloperImageTag() {
  const name = String(project.name || "a0-developer")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "") || "a0-developer";
  return `${name}:latest`;
}

function renderProject() {
  const summary = byId("developerProjectSummary");
  if (summary) {
    summary.textContent = project.token
      ? `${project.name} · ${project.files.length} file${project.files.length === 1 ? "" : "s"}`
      : "Open a project folder or create a Docker file";
  }
  const tagInput = byId("developerImageTagInput");
  if (tagInput && tagInput.dataset.project !== project.token) {
    tagInput.value = defaultDeveloperImageTag();
    tagInput.dataset.project = project.token;
  }
  renderFileTabs();
  renderDeveloperEditor();
  updateActionState();
}

function loadProject(result) {
  const files = Array.isArray(result?.files) ? result.files : [];
  project = {
    token: typeof result?.token === "string" ? result.token : "",
    name: typeof result?.name === "string" ? result.name : "",
    files: files.map((file) => {
      const content = typeof file?.content === "string" ? file.content : "";
      return {
        name: String(file?.name || ""),
        kind: developerFileKind(file?.name),
        content,
        savedContent: content
      };
    }).filter((file) => file.name && file.kind),
    warnings: Array.isArray(result?.warnings) ? result.warnings : []
  };
  activeFileName = project.files.some((file) => file.name === result?.selectedFile)
    ? result.selectedFile
    : project.files[0]?.name || "";
  renderProject();
  if (project.warnings.length) setOutput(project.warnings.join("\n"), "error");
  else setOutput(project.files.length ? "Project opened." : "Project folder opened. Create a Docker file to begin.");
}

function updateActionState() {
  const operationRunning = lastState?.progress?.status === "running";
  const file = activeFile();
  const compose = composeFile();
  const actionable = file?.kind === "compose" || file?.kind === "dockerfile";
  const setDisabled = (id, disabled) => { const button = byId(id); if (button) button.disabled = !!disabled; };
  const setVisible = (id, visible) => { const button = byId(id); if (button) button.hidden = !visible; };
  setDisabled("runCustomImageBtn", operationRunning);
  setVisible("saveDeveloperFileBtn", !!project.token && !!file && fileIsDirty(file));
  setDisabled("saveDeveloperFileBtn", operationRunning);
  setVisible("exportDeveloperFileBtn", !!file);
  setDisabled("exportDeveloperFileBtn", operationRunning);
  for (const id of ["validateDeveloperProjectBtn", "buildDeveloperProjectBtn"]) {
    setVisible(id, !!project.token && actionable);
    setDisabled(id, operationRunning);
  }
  for (const id of ["upDeveloperProjectBtn", "stopDeveloperProjectBtn", "logsDeveloperProjectBtn", "downDeveloperProjectBtn"]) {
    setVisible(id, !!project.token && !!compose);
    setDisabled(id, operationRunning);
  }
  const tagField = byId("developerImageTagField");
  if (tagField) tagField.hidden = file?.kind !== "dockerfile";
  const context = byId("developerActionContext");
  if (context) context.textContent = project.token ? `Build context: ${project.name}` : "Project root is the build context";
}

async function openDeveloperProject(mode = "folder") {
  if (hasDirtyFiles() && !window.confirm("Discard unsaved Docker project changes?")) return false;
  const result = await window.dockerManagerActions?.openDeveloperProject?.(mode);
  if (!result || result.canceled) return false;
  loadProject(result);
  return true;
}

async function createDeveloperFile(kind) {
  if (!project.token && !(await openDeveloperProject("folder"))) return;
  const name = kind === "compose" ? "compose.yaml" : "Dockerfile";
  const existing = project.files.find((file) => file.name === name);
  if (existing) return setActiveDeveloperFile(existing.name);
  const content = kind === "compose"
    ? buildComposeYaml(readQuickRunForm())
    : `FROM ${DEFAULT_IMAGE}:${DEFAULT_TAG}\n\n# Add image customizations here.\n`;
  project.files.push({ name, kind, content, savedContent: null });
  setActiveDeveloperFile(name);
  setOutput(`${name} created. Save it before running Docker.`);
}

async function saveDeveloperFile(file) {
  if (!project.token || !file) return false;
  if (file.name === activeFileName) syncActiveFileFromEditor();
  if (!fileIsDirty(file)) return true;
  const result = await window.dockerManagerActions?.saveDeveloperProjectFile?.({
    projectToken: project.token,
    fileName: file.name,
    content: file.content
  });
  if (!result) return false;
  file.savedContent = file.content;
  renderFileTabs();
  updateActionState();
  return true;
}

async function saveActiveDeveloperFile() {
  const file = activeFile();
  if (!(await saveDeveloperFile(file))) return false;
  window.toastFrontendSuccess?.(`${file.name} saved.`, "Docker workspace", 2, "dm-developer-save");
  return true;
}

async function saveDirtyDeveloperFiles() {
  syncActiveFileFromEditor();
  for (const file of project.files.filter(fileIsDirty)) {
    if (!(await saveDeveloperFile(file))) return false;
  }
  return true;
}

async function exportActiveDeveloperFile() {
  syncActiveFileFromEditor();
  const file = activeFile();
  if (!file) return;
  const result = await window.dockerManagerActions?.exportDeveloperFile?.({ fileName: file.name, content: file.content });
  if (!result || result.canceled) return;
  window.toastFrontendSuccess?.(`${result.name || file.name} exported.`, "Docker workspace", 2, "dm-developer-export");
}

function actionFile(action) {
  if (["up", "stop", "down", "logs"].includes(action)) return composeFile();
  const file = activeFile();
  return file?.kind === "compose" || file?.kind === "dockerfile" ? file : null;
}

async function inspectDeveloperProject(action) {
  const file = actionFile(action);
  if (!file || !(await saveDirtyDeveloperFiles())) return;
  setOutput(action === "logs" ? "Loading logs..." : `Validating ${file.name}...`);
  const result = await window.dockerManagerActions?.inspectDeveloperProject?.({
    projectToken: project.token,
    fileName: file.name,
    action
  });
  if (!result) {
    setOutput(`${action === "logs" ? "Log request" : "Validation"} failed.`, "error");
    return;
  }
  setOutput(result.output);
}

function confirmDeveloperAction(action) {
  if (action === "build") {
    return window.confirm(`Build ${project.name}? Dockerfiles can run commands and send this project folder to the selected Docker runtime.`);
  }
  if (action === "up") {
    return window.confirm(`Start ${project.name}? Compose can access host paths and use the permissions declared in the project.`);
  }
  if (action === "down") {
    return window.confirm(`Take ${project.name} down? Project containers and networks will be removed. Storage volumes are kept.`);
  }
  return true;
}

async function runDeveloperProject(action) {
  const file = actionFile(action);
  if (!file || !confirmDeveloperAction(action) || !(await saveDirtyDeveloperFiles())) return;
  const result = await window.dockerManagerActions?.runDeveloperProject?.({
    projectToken: project.token,
    fileName: file.name,
    action,
    imageTag: byId("developerImageTagInput")?.value || ""
  });
  if (!result?.opId) {
    setOutput("Docker project action was not started.", "error");
    return;
  }
  setOutput(`${action === "build" ? "Build" : action === "up" ? "Start" : action === "stop" ? "Stop" : "Take down"} requested.`);
}

function renderDeveloperProgress(state) {
  const progress = state?.progress;
  if (progress?.type !== "developer_project" || !progress?.opId) return;
  const key = `${progress.opId}:${progress.status}:${progress.developerOutput || progress.detail || progress.message || ""}`;
  if (key === lastDeveloperProgressKey) return;
  lastDeveloperProgressKey = key;
  const tone = progress.status === "failed" ? "error" : "";
  setOutput(progress.developerOutput || progress.detail || progress.message || "Working...", tone);
}

async function runCustomImage() {
  const form = readQuickRunForm();
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
    ["Versions", String((state?.images || []).length || 0)],
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

function render(state) {
  lastState = state || {};
  const subtitle = byId("advancedSubtitle");
  if (subtitle) {
    const running = (lastState.containers || []).filter((item) => item?.state === "running").length;
    subtitle.textContent = `${running} running, ${(lastState.images || []).length} image${(lastState.images || []).length === 1 ? "" : "s"}`;
  }
  renderDiagnostics(lastState);
  renderVolumes(lastState);
  renderDeveloperProgress(lastState);
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
  });
  tagInput?.addEventListener("input", () => {
    tagInput.dataset.dirty = "1";
    const pair = readImagePair();
    if (tagInput.value.trim() && tagInput.value !== pair.tag) tagInput.value = pair.tag;
    syncDefaultName();
  });
  nameInput?.addEventListener("input", () => {
    nameInput.dataset.dirty = "1";
  });

  byId("newComposeBtn")?.addEventListener("click", () => {
    document.querySelector(".dm-developer-new-file")?.removeAttribute("open");
    void createDeveloperFile("compose");
  });
  byId("newDockerfileBtn")?.addEventListener("click", () => {
    document.querySelector(".dm-developer-new-file")?.removeAttribute("open");
    void createDeveloperFile("dockerfile");
  });
  byId("openDeveloperProjectBtn")?.addEventListener("click", () => { void openDeveloperProject("folder"); });
  byId("openDeveloperFileBtn")?.addEventListener("click", () => { void openDeveloperProject("file"); });
  byId("saveDeveloperFileBtn")?.addEventListener("click", () => { void saveActiveDeveloperFile(); });
  byId("exportDeveloperFileBtn")?.addEventListener("click", () => { void exportActiveDeveloperFile(); });
  byId("validateDeveloperProjectBtn")?.addEventListener("click", () => { void inspectDeveloperProject("validate"); });
  byId("buildDeveloperProjectBtn")?.addEventListener("click", () => { void runDeveloperProject("build"); });
  byId("upDeveloperProjectBtn")?.addEventListener("click", () => { void runDeveloperProject("up"); });
  byId("stopDeveloperProjectBtn")?.addEventListener("click", () => { void runDeveloperProject("stop"); });
  byId("logsDeveloperProjectBtn")?.addEventListener("click", () => { void inspectDeveloperProject("logs"); });
  byId("downDeveloperProjectBtn")?.addEventListener("click", () => { void runDeveloperProject("down"); });
  byId("runCustomImageBtn")?.addEventListener("click", runCustomImage);
  byId("advancedPruneVolumesBtn")?.addEventListener("click", async () => {
    if (!window.confirm("Clear unused Docker volumes?")) return;
    await window.dockerManagerActions?.pruneVolumes?.();
  });
  window.addEventListener("resize", () => developerEditor?.resize?.());
  window.addEventListener("beforeunload", (event) => {
    if (!hasDirtyFiles()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  initDeveloperEditor();
  renderProject();
}

window.addEventListener("dm:state", (event) => render(event.detail || {}));
bind();
if (window.__dmLastState) render(window.__dmLastState);
