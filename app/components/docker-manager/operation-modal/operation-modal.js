import { progressActionsForState } from "../status-header/status-header.js";

const OPERATION_DIALOG_ID = "operationProgressDialog";

let blockingKeyHandlerDocument = null;
let dismissedOperationKey = "";

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function percentValue(progress) {
  if (progress === null || progress === undefined || progress === "") return null;
  const value = Number(progress);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function operationKey(progress = null) {
  const opId = asText(progress?.opId);
  const status = asText(progress?.status);
  const finishedAt = asText(progress?.finishedAt);
  return `${opId}:${status}:${finishedAt}`;
}

function operationHeadline(progress = null) {
  const status = asText(progress?.status);
  const type = asText(progress?.type) || "operation";
  const labels = {
    install: { running: "Installing Agent Zero", failed: "Install failed", canceled: "Install canceled" },
    update: { running: "Updating Agent Zero", failed: "Update failed", canceled: "Update canceled" },
    activate: { running: "Running Agent Zero", failed: "Run failed", canceled: "Run canceled" },
    rollback: { running: "Rolling back Agent Zero", failed: "Rollback failed", canceled: "Rollback canceled" },
    start: { running: "Starting Agent Zero", failed: "Start failed", canceled: "Start canceled" },
    stop: { running: "Stopping Agent Zero", failed: "Stop failed", canceled: "Stop canceled" },
    delete_instance: { running: "Deleting Agent Zero instance", failed: "Delete failed", canceled: "Delete canceled" },
    operation: { running: "Working on Agent Zero", failed: "Operation failed", canceled: "Operation canceled" }
  };
  const entry = labels[type] || labels.operation;

  if (status === "failed") return entry.failed;
  if (status === "canceled") return entry.canceled;
  return entry.running;
}

function operationDetail(progress = null) {
  const status = asText(progress?.status);
  if (status === "failed") return asText(progress?.error) || asText(progress?.detail) || asText(progress?.message) || "Operation failed.";
  if (status === "canceled") return asText(progress?.error) || asText(progress?.detail) || asText(progress?.message) || "Operation canceled.";
  return asText(progress?.detail) || asText(progress?.message) || "Working...";
}

function runningAction(progress = null) {
  if (!asText(progress?.opId)) {
    return { primary: { kind: "wait", label: operationHeadline(progress), disabled: true }, secondary: null };
  }
  return {
    primary: { kind: "wait", label: operationHeadline(progress), disabled: true },
    secondary: { kind: "cancel", label: "Cancel", disabled: false }
  };
}

function completedActions(state = {}) {
  const actions = progressActionsForState(state);
  if (actions.length) {
    const [primary, secondary] = actions;
    return {
      primary: primary ? { kind: primary.id, label: primary.label, disabled: !!primary.disabled } : null,
      secondary: secondary ? { kind: secondary.id, label: secondary.label, disabled: !!secondary.disabled } : null
    };
  }
  return {
    primary: { kind: "close", label: "Close", disabled: false },
    secondary: null
  };
}

function operationActions(state = {}) {
  const progress = state?.progress || null;
  const status = asText(progress?.status);
  if (status === "running") return runningAction(progress);
  if (status === "failed" || status === "canceled") return completedActions(state);
  return { primary: null, secondary: null };
}

function shouldShowOperationDialog(state = {}) {
  const progress = state?.progress || null;
  const status = asText(progress?.status);
  if (!progress || progress.type === "runtime_setup") return false;
  if (status === "running") return true;
  if ((status === "failed" || status === "canceled") && dismissedOperationKey !== operationKey(progress)) return true;
  return false;
}

function normalizedOperationDialog(state = {}) {
  const progress = state?.progress || null;
  const numericProgress = percentValue(progress?.progress);
  const status = asText(progress?.status) || "idle";
  const indeterminate = progress?.indeterminate === true || (status === "running" && numericProgress === null);
  const actions = operationActions(state);
  return {
    headline: operationHeadline(progress),
    detail: operationDetail(progress),
    progress: numericProgress,
    indeterminate,
    phase: asText(progress?.phase) || asText(progress?.message) || operationDetail(progress),
    primary: actions.primary,
    secondary: actions.secondary
  };
}

function makeButton(label, className, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.disabled = !!disabled;
  return button;
}

function renderProgress(model, parent) {
  const block = document.createElement("div");
  block.className = "sv-progress-block dm-runtime-progress";

  const head = document.createElement("div");
  head.className = "sv-progress-head";

  const phase = document.createElement("span");
  phase.textContent = model.phase;

  const percent = document.createElement("span");
  percent.textContent = model.indeterminate || model.progress === null ? "" : `${Math.round(model.progress)}%`;

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

function setPageBlocked(blocked) {
  const page = document.querySelector(".dm-page");
  if (!page) return;
  if ("inert" in page) page.inert = !!blocked;
  if (blocked) page.setAttribute("aria-hidden", "true");
  else page.removeAttribute("aria-hidden");
}

function hasOtherBlockingDialog() {
  return !!document.getElementById("runtimeSetupDialog");
}

function focusableWithin(root) {
  return Array.from(root.querySelectorAll("button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"))
    .filter((el) => !el.hidden);
}

function focusFirstControl(root) {
  const control = root.querySelector("button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
  const target = control || root.querySelector(".dm-operation-dialog");
  target?.focus?.();
}

function blockModalKeyboard(event) {
  const root = document.getElementById(OPERATION_DIALOG_ID);
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

function removeOperationDialog() {
  const existing = document.getElementById(OPERATION_DIALOG_ID);
  if (existing) existing.remove();
  if (!hasOtherBlockingDialog()) setPageBlocked(false);
}

function dismissOperation(state = {}) {
  dismissedOperationKey = operationKey(state?.progress);
  removeOperationDialog();
}

function runAction(kind, state, actions) {
  if (!kind) return;
  if (kind === "cancel") {
    actions?.cancelOperation?.(state?.progress?.opId || "");
    return;
  }
  if (kind === "docker-login") {
    actions?.openDockerLoginTerminal?.();
    return;
  }
  if (kind === "retry-install") {
    actions?.retryInstall?.(state?.progress?.targetTag || "");
    dismissOperation(state);
    return;
  }
  if (kind === "close") {
    dismissOperation(state);
  }
}

function renderOperationDialog(state = {}, actions = {}) {
  if (!shouldShowOperationDialog(state)) {
    removeOperationDialog();
    return false;
  }

  bindBlockingKeys();
  setPageBlocked(true);

  const model = normalizedOperationDialog(state);
  const existing = document.getElementById(OPERATION_DIALOG_ID);
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = OPERATION_DIALOG_ID;
  backdrop.className = "dm-dialog-backdrop dm-operation-backdrop";
  backdrop.setAttribute("role", "presentation");
  backdrop.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  const dialog = document.createElement("div");
  dialog.className = "dm-dialog dm-operation-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "operationDialogTitle");
  dialog.tabIndex = -1;
  dialog.addEventListener("click", (event) => event.stopPropagation());

  const header = document.createElement("div");
  header.className = "dm-dialog-header";
  const title = document.createElement("h2");
  title.id = "operationDialogTitle";
  title.className = "dm-dialog-title";
  title.textContent = model.headline;
  header.appendChild(title);

  const body = document.createElement("div");
  body.className = "dm-dialog-body";
  const detail = document.createElement("div");
  detail.className = "dm-runtime-gate-detail";
  detail.textContent = model.detail;
  body.appendChild(detail);
  renderProgress(model, body);

  const footer = document.createElement("div");
  footer.className = "dm-dialog-footer";

  const secondaryWrap = document.createElement("div");
  secondaryWrap.className = "dm-runtime-gate-secondary";
  const primaryWrap = document.createElement("div");
  primaryWrap.className = "dm-runtime-gate-primary";

  if (model.secondary) {
    const secondary = makeButton(model.secondary.label, "button", model.secondary.disabled);
    secondary.dataset.operationAction = model.secondary.kind;
    secondary.addEventListener("click", () => runAction(model.secondary.kind, state, actions));
    secondaryWrap.appendChild(secondary);
  }

  if (model.primary) {
    const primaryClass = model.primary.kind === "wait" ? "button confirm" : "button confirm";
    const primary = makeButton(model.primary.label, primaryClass, model.primary.disabled);
    primary.dataset.operationAction = model.primary.kind;
    primary.addEventListener("click", () => runAction(model.primary.kind, state, actions));
    primaryWrap.appendChild(primary);
  }

  footer.appendChild(secondaryWrap);
  footer.appendChild(primaryWrap);
  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(footer);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  focusFirstControl(backdrop);
  return true;
}

export {
  OPERATION_DIALOG_ID,
  normalizedOperationDialog,
  renderOperationDialog,
  shouldShowOperationDialog
};
