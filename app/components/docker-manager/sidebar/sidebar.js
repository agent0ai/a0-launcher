const STORAGE_KEY = "dm-active-tab";
const DEFAULT_TAB = "installs";

function getActiveTab() {
  return sessionStorage.getItem(STORAGE_KEY) || DEFAULT_TAB;
}

function setActiveTab(tab) {
  sessionStorage.setItem(STORAGE_KEY, tab);
}

function applyTab(tab) {
  document.querySelectorAll(".dm-nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  document.querySelectorAll(".dm-tab-content").forEach(el => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });
}

function bindNav() {
  document.querySelectorAll(".dm-nav-item").forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      setActiveTab(tab);
      applyTab(tab);
      window.dispatchEvent(new CustomEvent("dm:nav", { detail: { tab } }));
    });
  });
}

function init() {
  bindNav();
  const tab = getActiveTab();
  applyTab(tab);
  window.dispatchEvent(new CustomEvent("dm:nav", { detail: { tab } }));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
