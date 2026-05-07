function byId(id) { return document.getElementById(id); }

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
  if (title) title.textContent = "Docker required";
  const detail = state?.error || state?.environment?.diagnosticMessage || "Docker is not available. Install Docker Desktop (or Docker Engine) and start it.";
  if (message) message.textContent = detail;

  if (actionBtn) {
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = "Download Docker";
    if (!actionBtn.dataset.bound) {
      actionBtn.dataset.bound = "1";
      actionBtn.addEventListener("click", () => window.dockerManagerActions?.openDockerDownload?.());
    }
  }
}

window.addEventListener("dm:state", (e) => render(e.detail || {}));
if (window.__dmLastState) render(window.__dmLastState);