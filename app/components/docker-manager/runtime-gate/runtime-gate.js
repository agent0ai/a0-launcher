import { estimatedProgressFromSteps, percentValue, progressMetaText } from "../progress-eta.js";
import { asText, focusableWithin, makeButton, setPageBlocked } from "../component-utils.js";
import { openAddRemoteInstanceDialog } from "../remote-instance-dialog.js";
import { openCreateLocalInstanceDialog } from "../run-instance-dialog.js";

const RUNTIME_GATE_ID = "runtimeSetupDialog";

const RUNTIME_STEPS = Object.freeze({
  linux: Object.freeze([
    ["check_runtime", "Checking Docker Engine"],
    ["authorization", "Requesting system authorization"],
    ["install_engine", "Installing Docker Engine"],
    ["start_engine", "Starting Docker Engine"],
    ["check_access", "Checking Docker access"],
    ["ready", "Runtime ready"]
  ]),
  windows_wsl: Object.freeze([
    ["check_runtime", "Checking Windows runtime"],
    ["windows_approval", "Requesting Windows approval"],
    ["enable_wsl", "Enabling WSL features"],
    ["follow_up", "Waiting for restart or follow-up"],
    ["install_ubuntu", "Installing Ubuntu"],
    ["prepare_ubuntu", "Preparing Ubuntu"],
    ["install_engine", "Installing Docker Engine in WSL"],
    ["start_wsl_engine", "Starting Docker Engine in WSL"],
    ["start_bridge", "Starting local Docker bridge"],
    ["ready", "Runtime ready"]
  ]),
  docker_desktop: Object.freeze([
    ["desktop_stopped", "Docker Desktop is installed but not running"],
    ["start_desktop", "Starting Docker Desktop"],
    ["wait_desktop", "Waiting for Docker Desktop"],
    ["ready", "Runtime ready"]
  ]),
  macos_colima: Object.freeze([
    ["find_components", "Finding runtime components"],
    ["prepare_client", "Preparing Docker client"],
    ["download_components", "Downloading runtime components"],
    ["install_components", "Installing runtime components"],
    ["start_runtime", "Starting Agent Zero runtime"],
    ["verify_runtime", "Checking Docker Engine"],
    ["ready", "Runtime ready"]
  ]),
  generic: Object.freeze([
    ["check_runtime", "Checking runtime"],
    ["setup_runtime", "Runtime Setup"],
    ["ready", "Runtime ready"]
  ])
});

let blockingKeyHandlerDocument = null;
let acknowledgedRuntimeSetupKey = "";
let requestedSetupDocument = null;
let setupHandedOffDocument = null;

function isDockerDesktopRuntime(runtime) {
  return runtime?.mode === "docker_desktop" || runtime?.dockerFlavor === "docker_desktop";
}

function isDockerDesktopStopped(runtime) {
  return isDockerDesktopRuntime(runtime) && runtime?.state === "engine_stopped";
}

function setupActionButtonLabel(value = "") {
  const label = asText(value);
  if (!label || label === "Setup Agent Zero" || label === "Continue Setup") return "Continue";
  return label;
}

function runtimeKind(runtime = null) {
  const mode = asText(runtime?.mode);
  if (mode === "docker_desktop" || runtime?.dockerFlavor === "docker_desktop") return "docker_desktop";
  if (["wsl_feature", "wsl_distribution", "wsl_engine", "wsl_bridge_dependency"].includes(mode)) return "windows_wsl";
  if (mode === "colima") return "macos_colima";
  if (runtime?.platform === "win32") return "windows_wsl";
  if (runtime?.platform === "darwin") return "macos_colima";
  if (runtime?.platform === "linux" || runtime?.packageManager) return "linux";
  return "generic";
}

function phaseForRuntime(runtime = null) {
  if (isDockerDesktopStopped(runtime)) return "desktop_stopped";
  if (runtime?.state === "needs_relogin" || runtime?.state === "needs_group_membership") return "check_access";
  if (runtime?.state === "manual_install" || runtime?.state === "unsupported") return "check_runtime";
  if (runtime?.mode === "wsl_distribution") return "install_ubuntu";
  if (runtime?.mode === "wsl_bridge_dependency") return "start_bridge";
  if (runtime?.state === "engine_stopped" && runtimeKind(runtime) === "macos_colima") return "start_runtime";
  if (runtime?.state === "engine_stopped") return runtimeKind(runtime) === "windows_wsl" ? "start_wsl_engine" : "start_engine";
  return "check_runtime";
}

function normalizeSteps(steps = []) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((step) => step && typeof step === "object" && typeof step.label === "string")
    .map((step) => ({
      id: asText(step.id),
      label: step.label,
      status: asText(step.status) || "pending"
    }));
}

function decorateSteps(kind, phase, status = "idle") {
  const stepSet = RUNTIME_STEPS[kind] || RUNTIME_STEPS.generic;
  const activeIndex = Math.max(0, stepSet.findIndex(([id]) => id === phase));
  return stepSet.map(([id, label], index) => {
    let stepStatus = "pending";
    if (status === "completed" || phase === "ready") {
      stepStatus = "done";
    } else if (status === "failed") {
      stepStatus = index < activeIndex ? "done" : index === activeIndex ? "failed" : "pending";
    } else if (status === "canceled") {
      stepStatus = index < activeIndex ? "done" : index === activeIndex ? "canceled" : "pending";
    } else if (index < activeIndex) {
      stepStatus = "done";
    } else if (index === activeIndex) {
      stepStatus = status === "idle" ? "current" : "running";
    }
    return { id, label, status: stepStatus };
  });
}

function headlineForRuntime(runtime, progress = null) {
  const headline = asText(progress?.headline);
  if (headline) return headline;
  if (isDockerDesktopStopped(runtime)) return "Docker Desktop is not running";
  if (runtime?.state === "manual_install" || runtime?.state === "unsupported") return "Manual Runtime Setup Needed";
  if (runtime?.state === "needs_relogin") return "Finish Docker Access Setup";
  return "Setup Agent Zero";
}

function detailForRuntime(runtime, progress = null) {
  if (progress?.status === "failed" && asText(progress?.error)) return asText(progress.error);
  const detail = asText(progress?.detail) || asText(progress?.message);
  if (detail) return detail;
  if (runtime?.state === "manual_install" && Array.isArray(runtime.manualPackages) && runtime.manualPackages.length) {
    const base = asText(runtime.detail) || "Install Docker packages manually, then refresh.";
    return `${base} Packages: ${runtime.manualPackages.join(", ")}.`;
  }
  return asText(runtime?.detail) || "Agent Zero needs a local container runtime before the launcher can continue.";
}

function actionForRuntime(runtime, progress = null) {
  const status = asText(progress?.status);
  if (isRuntimeSetupSuccess({ dockerAvailable: false, runtime, progress })) {
    return { kind: "complete", label: "Continue" };
  }

  if (progress?.type === "runtime_setup" && status === "running") {
    return { kind: "wait", label: "Continue", disabled: true };
  }

  if (!runtime || typeof runtime !== "object") {
    return { kind: "setup", label: "Continue" };
  }

  if (runtime.canProvision && runtime.action === "start") {
    return {
      kind: "setup",
      label: isDockerDesktopRuntime(runtime) ? "Start Docker Desktop" : "Continue"
    };
  }

  if (runtime.canProvision && runtime.action === "install") {
    const label = setupActionButtonLabel(runtime.setupActionLabel);
    return { kind: "setup", label };
  }

  if (runtime.action === "refresh" || runtime.state === "needs_relogin") {
    return { kind: "refresh", label: "Refresh" };
  }

  if ((runtime.state === "manual_install" || runtime.state === "unsupported") && asText(runtime.manualUrl)) {
    return { kind: "guide", label: "Open Install Guide" };
  }

  return { kind: "refresh", label: "Refresh" };
}

function addSetupOption(out, seen, tag, label = "") {
  const value = asText(tag);
  if (!value || seen.has(value)) return;
  seen.add(value);
  out.push({ value, label: asText(label) || value });
}

function setupTagOptions(state = {}) {
  const out = [];
  const seen = new Set();
  addSetupOption(out, seen, "latest", "latest");

  const versions = Array.isArray(state?.versions) ? state.versions : [];
  for (const version of versions) {
    const tag = asText(version?.id);
    if (!tag || tag === "testing") continue;
    const unavailable = version?.availability === "available" && version?.installability === "not_yet_available";
    if (unavailable) continue;
    addSetupOption(out, seen, tag, tag);
  }

  return out;
}

function versionIsInstalled(version = null) {
  if (!version || typeof version !== "object") return false;
  const availability = asText(version.availability);
  return (
    availability === "installed" ||
    availability === "update_available" ||
    version.isActive === true ||
    version.differsFromPublished === true
  );
}

function installedTagOptions(state = {}) {
  const out = [];
  const seen = new Set();
  const versions = Array.isArray(state?.versions) ? state.versions : [];
  const hasInstalledVersion = versions.some((version) => versionIsInstalled(version));

  if (hasInstalledVersion) addSetupOption(out, seen, "latest", "latest");

  for (const version of versions) {
    const tag = asText(version?.id);
    if (!tag || tag === "testing" || !versionIsInstalled(version)) continue;
    addSetupOption(out, seen, tag, tag);
  }

  return out;
}

function hasInstalledAgentZeroImage(state = {}) {
  const versions = Array.isArray(state?.versions) ? state.versions : [];
  return versions.some((version) => versionIsInstalled(version));
}

function hasLocalInstances(state = {}) {
  const containers = Array.isArray(state?.containers) ? state.containers : [];
  return containers.some((container) => {
    const name = asText(container?.containerName);
    const role = asText(container?.role) || asText(container?.labels?.["a0.launcher.role"]);
    if (role === "retained") return false;
    return !!(container?.containerId || name);
  });
}

function hasRemoteInstances(state = {}) {
  const remoteInstances = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
  return remoteInstances.some((remote) => asText(remote?.id) && asText(remote?.url));
}

function successModeForState(state = {}) {
  if (!hasInstalledAgentZeroImage(state)) return "install";
  if (!hasLocalInstances(state)) return "run";
  return "continue";
}

function successTextForMode(mode) {
  if (mode === "install") return "Download Agent Zero to create your first Instance.";
  if (mode === "run") return "Agent Zero is already downloaded. Start an Instance when you're ready.";
  return "Agent Zero is ready on this computer.";
}

function successActionForMode(mode) {
  if (mode === "install") return { kind: "install_image", label: "Download Agent Zero" };
  if (mode === "run") return { kind: "run_image", label: "Run Agent Zero" };
  return { kind: "continue", label: "Continue" };
}

function runtimeEndpointOptions(state = {}) {
  const candidates = Array.isArray(state?.runtime?.runtimeCandidates)
    ? state.runtime.runtimeCandidates
    : Array.isArray(state?.environment?.runtimeCandidates) ? state.environment.runtimeCandidates : [];
  const out = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const id = asText(candidate?.id);
    const daemonId = asText(candidate?.daemonId);
    const startable = candidate?.available === false &&
      candidate?.startable === true &&
      candidate?.provider === "docker_desktop" &&
      candidate?.state === "engine_stopped";
    const identity = candidate?.available === true && daemonId
      ? `daemon:${daemonId}`
      : startable ? "stopped:docker_desktop" : "";
    if (!id || !identity || seen.has(identity)) continue;
    seen.add(identity);
    out.push({
      id,
      label: `${asText(candidate?.label) || "Container runtime"}${startable ? " (stopped)" : ""}`,
      startable,
      isSelected: candidate?.isSelected === true || id === asText(state?.runtime?.selectedRuntimeEndpointId)
    });
  }

  return out.length >= 2 ? out : [];
}

function isRuntimeReady(state = {}) {
  return !!state?.stateLoaded && (!!state?.dockerAvailable || state?.runtime?.state === "ready");
}

function runtimeSetupKey(progress = null) {
  return asText(progress?.opId) || asText(progress?.finishedAt) || "runtime-setup-complete";
}

function isRuntimeSetupSuccess(state = {}) {
  const progress = state?.progress || null;
  if (progress?.type !== "runtime_setup" || progress?.status !== "completed") return false;
  if (progress?.phase === "ready") return true;
  if (state?.dockerAvailable || state?.runtime?.state === "ready") return true;
  return /runtime ready/i.test(asText(progress?.detail) || asText(progress?.message));
}

function shouldShowRuntimeSuccess(state = {}) {
  if (!isRuntimeSetupSuccess(state)) return false;
  return acknowledgedRuntimeSetupKey !== runtimeSetupKey(state.progress);
}

function shouldChooseRuntime(state = {}) {
  const candidates = Array.isArray(state?.runtime?.runtimeCandidates)
    ? state.runtime.runtimeCandidates
    : Array.isArray(state?.environment?.runtimeCandidates) ? state.environment.runtimeCandidates : [];
  return !(state?.progress?.type === "runtime_setup" && ["running", "failed"].includes(state.progress.status)) &&
    isRuntimeReady(state) &&
    runtimeEndpointOptions(state).length >= 2 &&
    !candidates.some((candidate) => candidate?.source === "preference");
}

function shouldShowRuntimeGate(state = {}) {
  if (!state?.stateLoaded) return false;
  if (requestedSetupDocument && requestedSetupDocument === globalThis.document) return true;
  if (!["new", "local", "complete"].includes(state.onboarding)) return false;
  if (state.onboarding === "complete" || hasRemoteInstances(state) || hasLocalInstances(state)) return false;
  if (state.onboarding === "new") return true;
  if (setupHandedOffDocument && setupHandedOffDocument === globalThis.document) return false;
  if (state?.progress?.type === "runtime_setup" && state.progress.status === "running") return true;
  if (state?.progress?.type === "runtime_setup" && state.progress.status === "failed") {
    return acknowledgedRuntimeSetupKey !== runtimeSetupKey(state.progress);
  }
  if (shouldChooseRuntime(state)) return true;
  if (shouldShowRuntimeSuccess(state)) return true;
  if (isRuntimeReady(state)) return acknowledgedRuntimeSetupKey !== runtimeSetupKey(state.progress);
  return !isRuntimeReady(state);
}

function normalizedRuntimeGate(state = {}) {
  const runtime = state?.runtime || null;
  const progress = state?.progress?.type === "runtime_setup" ? state.progress : null;
  const kind = runtimeKind(runtime);
  const success = shouldShowRuntimeSuccess(state) || shouldChooseRuntime(state)
    || (isRuntimeReady(state) && progress?.status !== "running" && progress?.status !== "failed");
  const runtimeOptions = runtimeEndpointOptions(state);
  const failedWithReadyRuntime = progress?.status === "failed" && isRuntimeReady(state);
  const setupFlow = success || failedWithReadyRuntime;
  const rawStatus = asText(progress?.status) || "idle";
  const completedButStillBlocked = rawStatus === "completed" && !success && !isRuntimeReady(state);
  const status = completedButStillBlocked ? "idle" : rawStatus;
  const phase = asText(progress?.phase) || phaseForRuntime(runtime);
  const numericProgress = success ? 100 : completedButStillBlocked ? null : percentValue(progress?.progress);
  const indeterminate = !completedButStillBlocked && (progress?.indeterminate === true || (progress?.type === "runtime_setup" && status === "running" && numericProgress === null));
  const steps = completedButStillBlocked ? [] : normalizeSteps(progress?.steps);
  const renderedSteps = steps.length ? steps : decorateSteps(kind, phase, status);
  const successMode = setupFlow ? (state.onboarding === "complete" ? "continue" : successModeForState(state)) : "";
  const setupOptions = setupFlow
    ? successMode === "run" ? installedTagOptions(state) : successMode === "install" ? setupTagOptions(state) : []
    : [];

  return {
    headline: success ? "Runtime Ready" : headlineForRuntime(runtime, progress),
    detail: success ? "Agent Zero can run on this computer now." : detailForRuntime(runtime, progress),
    showDetail: success || status !== "running",
    phase,
    status: success ? "completed" : status,
    progress: numericProgress,
    indeterminate: success ? false : indeterminate,
    progressMeta: progressMetaText({
      progress: numericProgress,
      indeterminate: success ? false : indeterminate,
      startedAt: progress?.startedAt,
      status,
      fallbackProgress: estimatedProgressFromSteps(renderedSteps)
    }),
    steps: renderedSteps,
    success,
    setupFlow,
    successMode,
    setupText: setupFlow ? successTextForMode(successMode) : "",
    setupOptions,
    setupTag: setupOptions.some((option) => option.value === "latest") ? "latest" : (setupOptions[0]?.value || "latest"),
    runtimeOptions: setupFlow ? runtimeOptions : [],
    runtimeEndpointId: asText(state?.runtime?.selectedRuntimeEndpointId),
    action: setupFlow ? successActionForMode(successMode) : actionForRuntime(runtime, progress)
  };
}

function appendText(parent, className, text) {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function renderProgress(model, parent) {
  const block = document.createElement("div");
  block.className = "sv-progress-block dm-runtime-progress";

  const head = document.createElement("div");
  head.className = "sv-progress-head";

  const phase = document.createElement("span");
  phase.className = "dm-runtime-phase";
  const activeStep = model.steps.find((step) => ["running", "current", "failed", "canceled"].includes(step.status));
  phase.textContent = model.showDetail ? (activeStep?.label || model.detail) : (model.detail || activeStep?.label);

  const percent = document.createElement("span");
  percent.className = "dm-runtime-progress-meta dm-progress-meta";
  percent.textContent = model.progressMeta;

  head.appendChild(phase);
  head.appendChild(percent);

  const track = document.createElement("div");
  track.className = "sv-progress-track";

  const fill = document.createElement("div");
  fill.className = `sv-progress-fill${model.indeterminate ? " indeterminate" : ""}`;
  fill.style.width = model.indeterminate ? "" : `${model.progress === null ? 0 : model.progress}%`;

  track.appendChild(fill);
  block.appendChild(head);
  block.appendChild(track);
  parent.appendChild(block);
}

function runtimeStepIcon(status) {
  if (status === "done") return "check";
  if (status === "failed") return "error";
  if (status === "canceled") return "block";
  if (status === "running" || status === "current") return "progress_activity";
  return "radio_button_unchecked";
}

function renderRuntimeDetails(model, parent) {
  if (model.success || !Array.isArray(model.steps) || !model.steps.length) return;

  const details = document.createElement("details");
  details.className = "dm-runtime-details";

  const summary = document.createElement("summary");
  summary.className = "dm-runtime-details-summary";

  const label = document.createElement("span");
  label.textContent = "See more";
  summary.appendChild(label);
  details.appendChild(summary);

  const steps = document.createElement("div");
  steps.className = "dm-runtime-steps";
  steps.setAttribute("role", "list");
  steps.setAttribute("aria-label", "Runtime setup phases");

  for (const step of model.steps) {
    const status = asText(step.status) || "pending";
    const item = document.createElement("span");
    item.className = `dm-runtime-step is-${status}`;
    item.setAttribute("role", "listitem");

    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined dm-runtime-step-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = runtimeStepIcon(status);
    item.appendChild(icon);

    const text = document.createElement("span");
    text.className = "dm-runtime-step-label";
    text.textContent = step.label;
    item.appendChild(text);

    steps.appendChild(item);
  }

  details.appendChild(steps);
  parent.appendChild(details);
}

function renderSuccess(model, parent) {
  if (!model.success) return;
  const row = document.createElement("div");
  row.className = "dm-runtime-success";

  const icon = document.createElement("span");
  icon.className = "material-symbols-outlined dm-runtime-success-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "check_circle";

  const text = document.createElement("span");
  text.textContent = "Runtime ready";

  row.appendChild(icon);
  row.appendChild(text);
  parent.appendChild(row);
}

function renderRuntimeChoice(model, parent, selectedEndpointId = "") {
  const options = Array.isArray(model.runtimeOptions) ? model.runtimeOptions : [];
  if (options.length < 2) return null;

  const selected = options.some((option) => option.id === selectedEndpointId)
    ? selectedEndpointId
    : (options.find((option) => option.isSelected)?.id || model.runtimeEndpointId || options[0].id);

  const field = document.createElement("div");
  field.className = "dm-field";

  const label = document.createElement("label");
  label.setAttribute("for", "runtimeEndpointChoice");
  label.textContent = "Run Agent Zero with";
  field.appendChild(label);

  const select = document.createElement("select");
  select.id = "runtimeEndpointChoice";
  select.className = "dm-select";
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.id;
    el.textContent = option.label;
    if (option.id === selected) el.selected = true;
    select.appendChild(el);
  }
  select.value = selected;
  field.appendChild(select);
  parent.appendChild(field);
  return select;
}

function renderSetupChoice(model, parent, selectedTag = "") {
  if (!model.setupFlow || model.successMode === "continue") return null;

  const options = Array.isArray(model.setupOptions) && model.setupOptions.length
    ? model.setupOptions
    : [{ value: "latest", label: "latest" }];
  const selected = options.some((option) => option.value === selectedTag)
    ? selectedTag
    : model.setupTag || options[0].value;

  const wrap = document.createElement("div");
  wrap.className = "dm-runtime-install-choice";

  const text = document.createElement("div");
  text.className = "dm-runtime-install-text";
  text.textContent = model.setupText || "Choose an Agent Zero image.";
  wrap.appendChild(text);

  const field = document.createElement("div");
  field.className = "dm-field";

  const label = document.createElement("label");
  label.setAttribute("for", "runtimeSetupTag");
  label.textContent = "Agent Zero image";
  field.appendChild(label);

  const select = document.createElement("select");
  select.id = "runtimeSetupTag";
  select.className = "dm-select";
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    if (option.value === selected) el.selected = true;
    select.appendChild(el);
  }
  select.value = selected;
  field.appendChild(select);
  wrap.appendChild(field);
  parent.appendChild(wrap);
  return select;
}

function renderSetupOption(parent, { titleText, detailText, action, iconText, labelText }) {
  const wrap = document.createElement("div");
  wrap.className = "dm-runtime-remote-option";

  const copy = document.createElement("div");
  copy.className = "dm-runtime-remote-copy";

  const title = document.createElement("div");
  title.className = "dm-runtime-remote-title";
  title.textContent = titleText;

  const detail = document.createElement("div");
  detail.className = "dm-runtime-remote-detail";
  detail.textContent = detailText;

  copy.appendChild(title);
  copy.appendChild(detail);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "button";
  button.dataset.runtimeAction = action;

  const icon = document.createElement("span");
  icon.className = "material-symbols-outlined";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = iconText;

  const label = document.createElement("span");
  label.textContent = labelText;

  button.appendChild(icon);
  button.appendChild(label);
  wrap.appendChild(copy);
  wrap.appendChild(button);
  parent.appendChild(wrap);
  return button;
}

function hasOtherBlockingDialog() {
  return !!document.getElementById("operationProgressDialog");
}

function focusFirstControl(root) {
  const control = root.querySelector("button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
  const target = control || root.querySelector(".dm-runtime-gate");
  target?.focus?.();
}

function blockModalKeyboard(event) {
  const root = document.getElementById(RUNTIME_GATE_ID);
  if (!root) return;

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (event.key !== "Tab") return;
  const controls = focusableWithin(root);
  if (!controls.length) {
    event.preventDefault();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function bindBlockingKeys() {
  if (blockingKeyHandlerDocument === document) return;
  document.addEventListener("keydown", blockModalKeyboard, true);
  blockingKeyHandlerDocument = document;
}

function openRemoteInstanceSetup(actions = {}, state = {}) {
  removeRuntimeGate();
  openAddRemoteInstanceDialog({
    title: "Add remote Instance",
    submitLabel: "Add Instance",
    intro: "Connect this launcher to Agent Zero already running on a VPS or another URL. You can set up a local Instance later.",
    onCancel: () => {
      renderRuntimeGate(window.__dmLastState || state, actions);
    },
    onAdded: async (remote) => {
      const instanceId = asText(remote?.id);
      if (instanceId) {
        await actions?.openInstanceUi?.({
          kind: "remote",
          instanceId,
          title: asText(remote?.name) || "Remote Instance"
        });
      }
    }
  });
}

async function runAction(action, runtime, actions, root = null) {
  if (!action || action.disabled) return;
  if (action.kind === "setup") {
    actions?.provisionRuntime?.();
  } else if (action.kind === "refresh") {
    actions?.refresh?.();
  } else if (action.kind === "guide" && asText(runtime?.manualUrl)) {
    actions?.openDockerDownload?.(runtime.manualUrl);
  } else if (action.kind === "install_image" || action.kind === "run_image" || action.kind === "continue") {
    const state = typeof window !== "undefined" ? window.__dmLastState || {} : {};
    const selectedTag = asText(root?.querySelector?.("#runtimeSetupTag")?.value) || "latest";
    const selectedEndpointId = asText(root?.querySelector?.("#runtimeEndpointChoice")?.value);
    if (selectedEndpointId && typeof actions?.selectRuntimeEndpoint === "function") {
      const result = await actions.selectRuntimeEndpoint(selectedEndpointId);
      if (result === false || asText(result?.opId)) return;
    }
    acknowledgedRuntimeSetupKey = runtimeSetupKey(state.progress);
    setupHandedOffDocument = document;
    requestedSetupDocument = null;
    removeRuntimeGate();
    if (action.kind === "install_image" || action.kind === "run_image") {
      openCreateLocalInstanceDialog(state, { selectedTag });
    }
  }
}

function removeRuntimeGate() {
  const existing = document.getElementById(RUNTIME_GATE_ID);
  if (existing) existing.remove();
  if (!hasOtherBlockingDialog()) setPageBlocked(false);
}

function openRuntimeSetup(state = {}, actions = {}) {
  requestedSetupDocument = document;
  renderRuntimeGate(state, actions);
}

function renderRuntimeGate(state = {}, actions = {}) {
  if (document.getElementById("remoteInstanceDialog") || document.getElementById("activateInstanceDialog")) return false;
  if (!shouldShowRuntimeGate(state)) {
    removeRuntimeGate();
    return false;
  }

  bindBlockingKeys();
  setPageBlocked(true);

  const runtime = state?.runtime || null;
  const existing = document.getElementById(RUNTIME_GATE_ID);
  const previousSetupTag = asText(existing?.querySelector?.("#runtimeSetupTag")?.value);
  const previousRuntimeEndpointId = asText(existing?.querySelector?.("#runtimeEndpointChoice")?.value);
  const model = normalizedRuntimeGate(state);
  const welcome = state.onboarding === "new" && requestedSetupDocument !== document;
  const runningKey = model.status === "running" ? asText(state.progress?.opId) : "";
  const stepItems = existing?.querySelectorAll(".dm-runtime-step");
  if (runningKey && existing?.dataset.runningKey === runningKey && stepItems.length === model.steps.length) {
    existing.querySelector(".dm-dialog-title").textContent = model.headline;
    existing.querySelector(".dm-runtime-phase").textContent = model.detail;
    existing.querySelector(".dm-runtime-progress-meta").textContent = model.progressMeta;
    const fill = existing.querySelector(".sv-progress-fill");
    fill.className = `sv-progress-fill${model.indeterminate ? " indeterminate" : ""}`;
    fill.style.width = model.indeterminate ? "" : `${model.progress ?? 0}%`;
    model.steps.forEach((step, index) => {
      const item = stepItems[index];
      item.className = `dm-runtime-step is-${step.status}`;
      item.querySelector(".dm-runtime-step-icon").textContent = runtimeStepIcon(step.status);
      item.querySelector(".dm-runtime-step-label").textContent = step.label;
    });
    return true;
  }
  const detailsOpen = existing?.querySelector(".dm-runtime-details")?.open ?? true;
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = RUNTIME_GATE_ID;
  backdrop.dataset.runningKey = runningKey;
  backdrop.className = "dm-dialog-backdrop dm-runtime-gate-backdrop";
  backdrop.setAttribute("role", "presentation");
  backdrop.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  const dialog = document.createElement("div");
  dialog.className = "dm-dialog dm-runtime-gate";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "runtimeGateTitle");
  dialog.tabIndex = -1;
  dialog.addEventListener("click", (event) => event.stopPropagation());

  const header = document.createElement("div");
  header.className = "dm-dialog-header";

  const title = document.createElement("h2");
  title.id = "runtimeGateTitle";
  title.className = "dm-dialog-title";
  title.textContent = welcome ? "Welcome to Agent Zero" : model.headline;
  header.appendChild(title);

  const body = document.createElement("div");
  body.className = "dm-dialog-body";
  let runtimeChoice = null;
  if (welcome) {
    const remote = renderSetupOption(body, {
      titleText: "Agent Zero is already hosted?",
      detailText: "Add its URL and use the launcher without local setup.",
      action: "add_remote_instance", iconText: "add_link", labelText: "Add remote Instance"
    });
    remote.addEventListener("click", () => openRemoteInstanceSetup(actions, state));
    const local = renderSetupOption(body, {
      titleText: "Run Agent Zero on this computer",
      detailText: "Set up a local runtime and create your first Instance.",
      action: "choose_local", iconText: "computer", labelText: "Setup local Instance"
    });
    local.addEventListener("click", async () => {
      local.disabled = true;
      try { await actions?.beginLocalSetup?.(); }
      finally { local.disabled = false; }
    });
  } else {
    if (model.showDetail) appendText(body, "dm-runtime-gate-detail", model.detail);
    renderSuccess(model, body);
    runtimeChoice = renderRuntimeChoice(model, body, previousRuntimeEndpointId);
    renderSetupChoice(model, body, previousSetupTag);
  }
  if (!welcome && !model.success) {
    renderProgress(model, body);
    renderRuntimeDetails(model, body);
    const details = body.querySelector(".dm-runtime-details");
    if (details) details.open = detailsOpen;
  }

  const footer = document.createElement("div");
  footer.className = "dm-dialog-footer";
  footer.hidden = welcome;

  const secondary = document.createElement("div");
  secondary.className = "dm-runtime-gate-secondary";
  const primaryWrap = document.createElement("div");
  primaryWrap.className = "dm-runtime-gate-primary";

  if (requestedSetupDocument === document && model.status !== "running") {
    const close = makeButton("Close", "button");
    close.addEventListener("click", () => {
      requestedSetupDocument = null;
      removeRuntimeGate();
    });
    secondary.appendChild(close);
  }

  if (!["refresh", "wait", "install_image", "run_image", "continue"].includes(model.action.kind)) {
    const refresh = makeButton("Refresh", "button", false);
    refresh.dataset.runtimeAction = "refresh";
    refresh.addEventListener("click", () => actions?.refresh?.());
    secondary.appendChild(refresh);
  }

  const primary = makeButton(model.action.label, "button confirm", model.action.disabled);
  primary.dataset.runtimeAction = model.action.kind;
  primary.addEventListener("click", () => { void runAction(model.action, runtime, actions, backdrop); });
  const updatePrimaryLabel = () => {
    const selected = model.runtimeOptions.find((option) => option.id === runtimeChoice?.value);
    primary.textContent = selected?.startable ? "Start Docker Desktop" : model.action.label;
  };
  runtimeChoice?.addEventListener("change", updatePrimaryLabel);
  updatePrimaryLabel();
  primaryWrap.appendChild(primary);

  footer.appendChild(secondary);
  footer.appendChild(primaryWrap);
  dialog.appendChild(header);
  dialog.appendChild(body);
  if (!welcome) dialog.appendChild(footer);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  focusFirstControl(backdrop);
  return true;
}

export {
  RUNTIME_GATE_ID,
  RUNTIME_STEPS,
  actionForRuntime,
  isRuntimeReady,
  installedTagOptions,
  hasInstalledAgentZeroImage,
  normalizedRuntimeGate,
  openRuntimeSetup,
  renderRuntimeGate,
  shouldShowRuntimeGate,
  runtimeKind
};
