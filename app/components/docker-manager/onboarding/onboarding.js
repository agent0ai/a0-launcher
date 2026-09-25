import { byId } from "../component-utils.js";
function runtimeMessage(runtime, fallback) {
  const detail = typeof runtime?.detail === "string" ? runtime.detail.trim() : "";
  if (runtime?.state === "manual_install" && Array.isArray(runtime.manualPackages) && runtime.manualPackages.length) {
    return `${detail || "Install Docker packages manually, then refresh."} Packages: ${runtime.manualPackages.join(", ")}.`;
  }
  return detail || fallback;
}

function isDockerDesktopRuntime(runtime) {
  return runtime?.mode === "docker_desktop" || runtime?.dockerFlavor === "docker_desktop";
}

function isDockerDesktopStopped(runtime) {
  return isDockerDesktopRuntime(runtime) && runtime?.state === "engine_stopped";
}

function setupActionButtonLabel(value = "") {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label || label === "Setup Agent Zero" || label === "Continue Setup") return "Continue";
  return label;
}

function titleForRuntime(runtime) {
  if (isDockerDesktopStopped(runtime)) return "Docker Desktop is not running";
  if (isDockerDesktopRuntime(runtime)) return "Docker Desktop Setup";
  return "Agent Zero Setup";
}

function actionForRuntime(runtime) {
  const openGuide = () => window.dockerManagerActions?.openDockerDownload?.(runtime?.manualUrl || "");
  if (!runtime || typeof runtime !== "object") {
    return { label: "Continue", handler: () => window.dockerManagerActions?.provisionRuntime?.() };
  }
  if (runtime.canProvision && runtime.action === "start") {
    return {
      label: isDockerDesktopRuntime(runtime) ? "Start Docker Desktop" : "Continue",
      handler: () => window.dockerManagerActions?.provisionRuntime?.()
    };
  }
  if (runtime.canProvision && runtime.action === "install") {
    const label = setupActionButtonLabel(runtime.setupActionLabel);
    return { label, handler: () => window.dockerManagerActions?.provisionRuntime?.() };
  }
  if (isDockerDesktopStopped(runtime)) {
    return { label: "Start Docker Desktop", handler: () => window.dockerManagerActions?.provisionRuntime?.() };
  }
  if (runtime.action === "refresh" || runtime.state === "needs_relogin") {
    return { label: "Refresh", handler: () => window.dockerManagerActions?.refresh?.() };
  }
  return { label: "Open Install Guide", handler: openGuide };
}

function render(state) {
  const panel = byId("onboardingPanel");
  const title = byId("onboardingTitle");
  const message = byId("onboardingMessage");
  const actionBtn = byId("onboardingActionBtn");
  if (!panel) return;

  const hasData = (Array.isArray(state?.images) && state.images.length > 0)
    || (Array.isArray(state?.containers) && state.containers.length > 0);
  if (state?.dockerAvailable || hasData) {
    panel.classList.add("hidden");
    panel.classList.remove("sv-onboarding-warning");
    return;
  }

  panel.classList.remove("hidden");
  const runtime = state?.runtime || null;
  panel.classList.toggle("sv-onboarding-warning", isDockerDesktopStopped(runtime));
  if (title) title.textContent = titleForRuntime(runtime);
  const fallback = state?.error || state?.environment?.diagnosticMessage || "Agent Zero needs local Setup to finish before it can start.";
  const detail = runtimeMessage(runtime, fallback);
  if (message) message.textContent = detail;

  if (actionBtn) {
    const action = actionForRuntime(runtime);
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = action.label;
    actionBtn.disabled = state?.progress?.status === "running";
    actionBtn.onclick = () => action.handler();
    if (runtime?.state === "needs_relogin") {
      actionBtn.classList.remove("confirm");
    } else {
      actionBtn.classList.add("confirm");
    }
  }
}

window.addEventListener("dm:state", (e) => render(e.detail || {}));
if (window.__dmLastState) render(window.__dmLastState);
