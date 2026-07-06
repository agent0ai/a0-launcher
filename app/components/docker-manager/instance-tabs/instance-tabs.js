import { LOCALE_CHANGED_EVENT, t } from "../i18n.js";

function byId(id) {
  return document.getElementById(id);
}

function activeTab(snapshot) {
  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  return tabs.find((tab) => tab?.active) || tabs.find((tab) => tab?.id === snapshot?.activeTabId) || null;
}

function instanceTabsFromState(state) {
  const snapshot = state?.instanceTabs && typeof state.instanceTabs === "object" ? state.instanceTabs : state;
  return snapshot && typeof snapshot === "object" ? snapshot : { tabs: [], activeTabId: "" };
}

function render(state = window.__dmLastState || { instanceTabs: { tabs: [], activeTabId: "" } }) {
  const snapshot = instanceTabsFromState(state);
  const section = document.querySelector(".dm-instance-tabs");
  const strip = byId("dmInstanceTabStrip");
  const empty = byId("dmInstanceTabEmpty");
  const viewport = byId("dmInstanceTabViewport");
  if (!strip || !viewport) return;

  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  const selected = activeTab(snapshot);
  const homeActive = !selected;
  strip.innerHTML = "";

  if (!tabs.length) {
    // No tabs: the overlay collapses out of layout entirely so the launcher
    // shell behind it stays scrollable and clickable.
    if (section) section.classList.remove("has-tabs");
    if (section) section.classList.remove("home-active");
    document.body.classList.remove("dm-instance-home-active");
    viewport.classList.remove("has-tab");
    if (empty) empty.classList.remove("hidden");
    window.dockerManagerActions?.syncInstanceTabBounds?.();
    return;
  }

  if (section) section.classList.add("has-tabs");
  if (section) section.classList.toggle("home-active", homeActive);
  document.body.classList.toggle("dm-instance-home-active", homeActive);
  viewport.classList.toggle("has-tab", !homeActive);
  if (empty) empty.classList.add("hidden");

  const home = document.createElement("button");
  home.type = "button";
  home.className = `dm-instance-tab dm-instance-home-tab${homeActive ? " active" : ""}`;
  home.title = t("common.launcher");
  home.setAttribute("aria-label", t("instanceTabs.showLauncher"));
  home.addEventListener("click", () => window.dockerManagerActions?.selectInstanceHome?.());

  const homeIcon = document.createElement("span");
  homeIcon.className = "material-symbols-outlined";
  homeIcon.setAttribute("aria-hidden", "true");
  homeIcon.textContent = "home";

  const homeLabel = document.createElement("span");
  homeLabel.className = "dm-instance-tab-title";
  homeLabel.textContent = t("common.launcher");

  home.appendChild(homeIcon);
  home.appendChild(homeLabel);
  strip.appendChild(home);

  for (const tab of tabs) {
    const tabTitle = tab?.title || "Agent Zero";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `dm-instance-tab${tab?.id === selected?.id ? " active" : ""}`;
    button.title = tabTitle;
    button.setAttribute("aria-label", tabTitle);
    button.addEventListener("click", () => window.dockerManagerActions?.selectInstanceTab?.(tab.id));

    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = tab?.loading ? "progress_activity" : "language";

    const copy = document.createElement("span");
    copy.className = "dm-instance-tab-copy";

    const label = document.createElement("span");
    label.className = "dm-instance-tab-title";
    label.textContent = tabTitle;

    const close = document.createElement("span");
    close.className = "material-symbols-outlined dm-instance-tab-close";
    close.setAttribute("aria-hidden", "true");
    close.textContent = "close";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      window.dockerManagerActions?.closeInstanceTab?.(tab.id);
    });

    button.appendChild(icon);
    copy.appendChild(label);
    button.appendChild(copy);
    button.appendChild(close);
    strip.appendChild(button);
  }

  const controls = document.createElement("div");
  controls.className = "dm-instance-tab-controls";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "button icon-button dm-icon-button";
  reload.title = t("common.reload");
  reload.setAttribute("aria-label", t("instanceTabs.reloadActive"));
  reload.disabled = !selected;
  reload.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">refresh</span>';
  reload.addEventListener("click", () => window.dockerManagerActions?.reloadInstanceTab?.(selected?.id || ""));

  const detach = document.createElement("button");
  detach.type = "button";
  detach.className = "button icon-button dm-icon-button";
  detach.title = t("common.detach");
  detach.setAttribute("aria-label", t("instanceTabs.detachActive"));
  detach.disabled = !selected;
  detach.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>';
  detach.addEventListener("click", () => window.dockerManagerActions?.detachInstanceTab?.(selected?.id || ""));

  controls.appendChild(reload);
  controls.appendChild(detach);
  strip.appendChild(controls);
  if (!homeActive) window.dockerManagerActions?.syncInstanceTabBounds?.();
}

window.addEventListener("dm:state", (event) => render(event.detail));
window.addEventListener(LOCALE_CHANGED_EVENT, () => render());

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => render());
} else {
  render();
}
