function byId(id) { return document.getElementById(id); }

function hasLauncherUpdate(state) {
  const meta = state?.meta || {};
  return meta.launcherUpdateAvailable === true ||
    meta.contentUpdateAvailable === true ||
    meta.updateAvailable === true;
}

function isDockerHubRateLimit(progress) {
  const errorCode = typeof progress?.errorCode === "string" ? progress.errorCode : "";
  const message = `${progress?.error || ""} ${progress?.detail || ""} ${progress?.message || ""}`.trim();
  return errorCode === "DOCKER_PULL_RATE_LIMIT" || /docker hub pull limit reached/i.test(message);
}

function progressActionsForState(state) {
  const progress = state?.progress || null;
  if (progress?.status !== "failed") return [];
  if (isDockerHubRateLimit(progress)) {
    return [
      { id: "docker-login", label: "Docker Login", emphasis: "primary" },
      { id: "retry-install", label: "Retry", emphasis: "secondary", disabled: !progress?.targetTag }
    ];
  }
  return [];
}

function render(state) {
  const updateBtn = byId("launcherUpdateBtn");
  const showUpdate = hasLauncherUpdate(state);

  if (updateBtn) {
    updateBtn.classList.toggle("is-hidden", !showUpdate);
    updateBtn.setAttribute("aria-hidden", showUpdate ? "false" : "true");
    updateBtn.tabIndex = showUpdate ? 0 : -1;
  }
}

function bindActions() {
  const refreshBtn = byId("refreshBtn");
  const updateBtn = byId("launcherUpdateBtn");

  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = "1";
    refreshBtn.addEventListener("click", () => window.dockerManagerActions?.refresh?.());
  }
  if (updateBtn && !updateBtn.dataset.bound) {
    updateBtn.dataset.bound = "1";
    updateBtn.addEventListener("click", () => window.dockerManagerActions?.refresh?.());
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("dm:state", (e) => {
    bindActions();
    render(e.detail || {});
  });

  bindActions();
  if (window.__dmLastState) render(window.__dmLastState);
}

export {
  hasLauncherUpdate,
  isDockerHubRateLimit,
  progressActionsForState
};
