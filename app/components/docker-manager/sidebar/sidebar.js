const STORAGE_KEY = "dm-active-tab";
const DEFAULT_TAB = "installs";
const VALID_TABS = new Set(["installs", "sessions", "topology", "advanced", "settings"]);
const NAVIGATE_EVENT = "dm:navigate";

let programmaticNavigationBound = false;

function validTab(tab) {
  return VALID_TABS.has(tab) ? tab : DEFAULT_TAB;
}

function getActiveTab() {
  const tab = sessionStorage.getItem(STORAGE_KEY) || DEFAULT_TAB;
  return validTab(tab);
}

function setActiveTab(tab) {
  const activeTab = validTab(tab);
  sessionStorage.setItem(STORAGE_KEY, activeTab);
  return activeTab;
}

function applyTab(tab) {
  const activeTab = validTab(tab);
  document.querySelectorAll(".dm-nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === activeTab);
  });

  document.querySelectorAll(".dm-tab-content").forEach(el => {
    el.classList.toggle("active", el.dataset.tab === activeTab);
  });
}

function navigateToTab(tab, options = {}) {
  const activeTab = setActiveTab(tab);
  applyTab(activeTab);
  window.dispatchEvent(new CustomEvent("dm:nav", {
    detail: {
      tab: activeTab,
      userInitiated: options?.userInitiated === true,
      source: options?.source || ""
    }
  }));
  return activeTab;
}

function bindProgrammaticNavigation() {
  if (programmaticNavigationBound) return;
  programmaticNavigationBound = true;
  window.addEventListener(NAVIGATE_EVENT, (event) => {
    const detail = event?.detail && typeof event.detail === "object" ? event.detail : {};
    navigateToTab(detail.tab || "", {
      userInitiated: detail.userInitiated === true,
      source: detail.source || "programmatic"
    });
  });
}

function bindNav() {
  document.querySelectorAll(".dm-nav-item").forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      navigateToTab(btn.dataset.tab, { userInitiated: true, source: "sidebar" });
    });
  });
}

function init() {
  bindProgrammaticNavigation();
  bindNav();
  navigateToTab(getActiveTab(), { userInitiated: false, source: "initial" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

export {
  NAVIGATE_EVENT,
  bindProgrammaticNavigation,
  navigateToTab
};
