function byId(id) {
  return document.getElementById(id);
}

function activeTab(snapshot) {
  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  return tabs.find((tab) => tab?.active) || tabs.find((tab) => tab?.id === snapshot?.activeTabId) || null;
}

function render(snapshot = window.__dmLastInstanceTabs || { tabs: [], activeTabId: "" }) {
  const section = document.querySelector(".dm-instance-tabs");
  const strip = byId("dmInstanceTabStrip");
  const empty = byId("dmInstanceTabEmpty");
  const viewport = byId("dmInstanceTabViewport");
  if (!strip || !viewport) return;

  const tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  const selected = activeTab(snapshot);
  strip.innerHTML = "";

  if (!tabs.length) {
    // No tabs: the overlay collapses out of layout entirely so the launcher
    // shell behind it stays scrollable and clickable.
    if (section) section.classList.remove("has-tabs");
    viewport.classList.remove("has-tab");
    if (empty) empty.classList.remove("hidden");
    window.dockerManagerActions?.syncInstanceTabBounds?.();
    return;
  }

  if (section) section.classList.add("has-tabs");
  viewport.classList.add("has-tab");
  if (empty) empty.classList.add("hidden");

  for (const tab of tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `dm-instance-tab${tab?.id === selected?.id ? " active" : ""}`;
    button.title = tab?.url || "Agent Zero";
    button.addEventListener("click", () => window.dockerManagerActions?.selectInstanceTab?.(tab.id));

    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = tab?.loading ? "progress_activity" : "language";

    const label = document.createElement("span");
    label.className = "dm-instance-tab-title";
    label.textContent = tab?.title || "Agent Zero";

    const close = document.createElement("span");
    close.className = "material-symbols-outlined dm-instance-tab-close";
    close.setAttribute("aria-hidden", "true");
    close.textContent = "close";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      window.dockerManagerActions?.closeInstanceTab?.(tab.id);
    });

    button.appendChild(icon);
    button.appendChild(label);
    button.appendChild(close);
    strip.appendChild(button);
  }

  const controls = document.createElement("div");
  controls.className = "dm-instance-tab-controls";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "button icon-button dm-icon-button";
  reload.title = "Reload";
  reload.setAttribute("aria-label", "Reload active instance UI");
  reload.disabled = !selected;
  reload.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">refresh</span>';
  reload.addEventListener("click", () => window.dockerManagerActions?.reloadInstanceTab?.(selected?.id || ""));

  const detach = document.createElement("button");
  detach.type = "button";
  detach.className = "button icon-button dm-icon-button";
  detach.title = "Detach";
  detach.setAttribute("aria-label", "Detach active instance UI");
  detach.disabled = !selected;
  detach.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>';
  detach.addEventListener("click", () => window.dockerManagerActions?.detachInstanceTab?.(selected?.id || ""));

  controls.appendChild(reload);
  controls.appendChild(detach);
  strip.appendChild(controls);
  window.dockerManagerActions?.syncInstanceTabBounds?.();
}

window.addEventListener("dm:instance-tabs", (event) => render(event.detail));

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => render());
} else {
  render();
}
