function byId(id) { return document.getElementById(id); }

function render(state) {
  const contentVersion = byId("contentVersion");
  const appVersion = byId("appVersion");
  const panel = byId("progressPanel");
  const progressTitle = byId("progressTitle");
  const progressMessage = byId("progressMessage");
  const banner = byId("statusBanner");

  if (contentVersion) contentVersion.textContent = state?.meta?.contentVersion || "";
  if (appVersion) appVersion.textContent = state?.meta?.appVersion || "";

  if (banner) {
    const message = String(state?.banner?.message || "").trim();
    const type = ["error", "success", "warning", "info"].includes(state?.banner?.type)
      ? state.banner.type
      : "info";
    banner.classList.remove("info", "error", "success", "warning");
    if (message) {
      banner.textContent = message;
      banner.classList.add(type);
      banner.classList.remove("hidden");
      banner.setAttribute("role", type === "error" ? "alert" : "status");
    } else {
      banner.textContent = "";
      banner.classList.add("hidden");
      banner.setAttribute("role", "status");
    }
  }

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
