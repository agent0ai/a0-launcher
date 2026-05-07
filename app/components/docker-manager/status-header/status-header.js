function byId(id) { return document.getElementById(id); }

function render(state) {
  const contentVersion = byId("contentVersion");
  const appVersion = byId("appVersion");
  const panel = byId("progressPanel");
  const progressTitle = byId("progressTitle");
  const progressMessage = byId("progressMessage");

  if (contentVersion) contentVersion.textContent = state?.meta?.contentVersion || "";
  if (appVersion) appVersion.textContent = state?.meta?.appVersion || "";

  const progress = state?.progress || null;
  if (!panel || !progress || progress.status !== "running") {
    if (panel) panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");
  if (progressTitle) progressTitle.textContent = progress.type || "operation";
  if (progressMessage) progressMessage.textContent = progress.message || "Working...";
}

function bindActions() {
  const refreshBtn = byId("refreshBtn");
  const homepageBtn = byId("homepageBtn");

  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = "1";
    refreshBtn.addEventListener("click", () => window.dockerManagerActions?.refresh?.());
  }
  if (homepageBtn && !homepageBtn.dataset.bound) {
    homepageBtn.dataset.bound = "1";
    homepageBtn.addEventListener("click", () => window.dockerManagerActions?.openHomepage?.());
  }
}

window.addEventListener("dm:state", (e) => {
  bindActions();
  render(e.detail || {});
});

bindActions();
if (window.__dmLastState) render(window.__dmLastState);
