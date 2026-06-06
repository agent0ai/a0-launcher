function byId(id) { return document.getElementById(id); }

function setupProgress(state) {
  const progress = state?.progress || null;
  return progress?.type === "runtime_setup" && progress.status === "running" ? progress : null;
}

function bindButton(button, actionName) {
  if (!button || button.dataset.bound) return;
  button.dataset.bound = "1";
  button.addEventListener("click", () => window.dockerManagerActions?.[actionName]?.());
}

function render(state) {
  const panel = byId("onboardingPanel");
  const title = byId("onboardingTitle");
  const message = byId("onboardingMessage");
  const detail = byId("onboardingDetail");
  const actionBtn = byId("onboardingActionBtn");
  const fallbackBtn = byId("onboardingFallbackBtn");
  const cancelBtn = byId("onboardingCancelBtn");
  if (!panel) return;

  const hasData = (Array.isArray(state?.images) && state.images.length > 0)
    || (Array.isArray(state?.containers) && state.containers.length > 0);
  if (state?.dockerAvailable || hasData) {
    panel.classList.add("hidden");
    return;
  }

  const progress = setupProgress(state);
  panel.classList.remove("hidden");
  if (title) title.textContent = "Runtime setup";
  if (message) {
    message.textContent = progress
      ? (progress.message || "Setting up the required runtime.")
      : (state?.error || state?.environment?.diagnosticMessage || "Set up the required runtime to run Agent Zero locally.");
  }
  if (detail) {
    detail.classList.add("hidden");
    detail.textContent = "";
  }

  if (actionBtn) {
    actionBtn.classList.toggle("hidden", !!progress);
    actionBtn.textContent = "Set up runtime";
    bindButton(actionBtn, "startRuntimeSetup");
  }
  if (fallbackBtn) {
    fallbackBtn.classList.remove("hidden");
    bindButton(fallbackBtn, "openDockerDownload");
  }
  if (cancelBtn) {
    cancelBtn.classList.toggle("hidden", !progress);
    bindButton(cancelBtn, "cancelCurrentOperation");
  }
}

window.addEventListener("dm:state", (e) => render(e.detail || {}));
if (window.__dmLastState) render(window.__dmLastState);
