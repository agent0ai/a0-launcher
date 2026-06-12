function byId(id) { return document.getElementById(id); }

function runtimeMessage(runtime, fallback) {
  const detail = typeof runtime?.detail === "string" ? runtime.detail.trim() : "";
  if (runtime?.state === "manual_install" && Array.isArray(runtime.manualPackages) && runtime.manualPackages.length) {
    return `${detail || "Install Docker packages manually, then refresh."} Packages: ${runtime.manualPackages.join(", ")}.`;
  }
  return detail || fallback;
}

function actionForRuntime(runtime) {
  if (!runtime || typeof runtime !== "object") {
    return { label: "Download Docker", handler: () => window.dockerManagerActions?.openDockerDownload?.() };
  }
  if (runtime.canProvision && runtime.action === "start") {
    return { label: "Start Docker", handler: () => window.dockerManagerActions?.provisionRuntime?.() };
  }
  if (runtime.canProvision && runtime.action === "install") {
    return { label: "Set Up Docker Engine", handler: () => window.dockerManagerActions?.provisionRuntime?.() };
  }
  if (runtime.action === "refresh" || runtime.state === "needs_relogin") {
    return { label: "Refresh", handler: () => window.dockerManagerActions?.refresh?.() };
  }
  return { label: "Open Install Guide", handler: () => window.dockerManagerActions?.openDockerDownload?.() };
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
    return;
  }

  panel.classList.remove("hidden");
  const runtime = state?.runtime || null;
  if (title) title.textContent = runtime?.state === "engine_stopped" ? "Docker is installed" : "Docker setup";
  const fallback = state?.error || state?.environment?.diagnosticMessage || "Docker is not available. Install Docker Desktop or Docker Engine and start it.";
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
