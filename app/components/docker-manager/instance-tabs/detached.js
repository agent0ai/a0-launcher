import { instanceColorTone, createInstanceIcon } from "../card-visuals.js";
import { openHostAccessDialog } from "../host-access-dialog.js";
import { openInstanceAppearanceDialog } from "../instance-appearance-dialog.js";

const api = window.dockerManagerAPI;
const tabId = new URLSearchParams(window.location.search).get("tabId") || "";
let namesCollapsed = false;
let tab = null;

function isError(value) {
  return Boolean(value && typeof value === "object" && typeof value.message === "string");
}

function hostStatusLabel(state) {
  return state === "connected" ? "Host access connected" : "Host access disconnected";
}

function render(snapshot) {
  tab = (Array.isArray(snapshot?.tabs) ? snapshot.tabs : []).find((candidate) => candidate?.id === tabId) || null;
  if (!tab) return;
  window.__dmLastState = { instanceTabs: snapshot };

  const title = tab.title || "Agent Zero";
  const state = String(tab.hostAccess?.state || "disconnected");
  const name = document.getElementById("detachedInstanceName");
  const icon = document.getElementById("detachedInstanceIcon");
  const host = document.getElementById("detachedHostAccess");
  if (name) name.textContent = title;
  document.getElementById("detachedInstanceLoading")?.classList.toggle("hidden", !tab.loading || tab.canReload);
  if (icon) {
    icon.title = `Change ${title} Colour/Icon`;
    icon.setAttribute("aria-label", icon.title);
    icon.replaceChildren(createInstanceIcon(tab));
    icon.style.removeProperty("color");
    icon.style.removeProperty("background-color");
    const tone = instanceColorTone(tab.color);
    if (tone && !tab.loading) {
      icon.style.color = tone.fg;
      if (icon.querySelector("img")) icon.style.backgroundColor = tone.bg;
    }
  }
  if (host) {
    host.classList.toggle("connected", state === "connected");
    host.title = hostStatusLabel(state);
    host.setAttribute("aria-label", `${hostStatusLabel(state)}. Open settings.`);
  }
}

window.dockerManagerActions = {
  chooseInstanceIcon: () => api?.chooseInstanceIcon?.(),
  chooseHostAccessFolder: (defaultPath) => api?.chooseHostAccessFolder?.(defaultPath),
  async setInstanceHostAccess(target, config) {
    const id = target?.kind === "remote" ? target?.instanceId : target?.containerId;
    const result = await api?.setInstanceHostAccess?.({ tabId: target?.id, kind: target?.kind, id }, config);
    return isError(result) ? false : result;
  },
  async retryHostGateway(id) {
    const result = await api?.retryHostGateway?.(id);
    return !isError(result);
  },
  async hostGatewayCommand(id, action) {
    const result = await api?.hostGatewayCommand?.(id, action);
    return isError(result) ? false : result;
  },
  async setLocalInstanceAppearance(containerId, appearance) {
    const result = await api?.setLocalInstanceAppearance?.(containerId, appearance);
    return isError(result) ? false : result;
  },
  async setRemoteInstanceAppearance(instanceId, appearance) {
    const result = await api?.setRemoteInstanceAppearance?.(instanceId, appearance);
    return isError(result) ? false : result;
  },
  hideInstanceTabView: () => api?.setDetachedInstanceContentVisible?.(tabId, false),
  syncInstanceTabBounds: () => api?.setDetachedInstanceContentVisible?.(tabId, true)
};

document.getElementById("detachedHostAccess")?.addEventListener("click", () => {
  if (tab) openHostAccessDialog(tab, window.__dmLastState || {});
});

document.getElementById("detachedInstanceIcon")?.addEventListener("click", () => {
  if (!tab) return;
  const title = tab.title || "Agent Zero";
  openInstanceAppearanceDialog({
    title: `${title} Colour/Icon`,
    currentColor: tab.color || "",
    currentIcon: tab.icon || "",
    favicon: tab.favicon,
    onSave: (appearance) => tab.kind === "remote"
      ? window.dockerManagerActions.setRemoteInstanceAppearance(tab.instanceId || "", appearance)
      : window.dockerManagerActions.setLocalInstanceAppearance(tab.containerId || "", appearance)
  });
});

document.getElementById("detachedCollapse")?.addEventListener("click", (event) => {
  namesCollapsed = !namesCollapsed;
  document.querySelector(".dm-detached-instance-tabs")?.classList.toggle("names-collapsed", namesCollapsed);
  const button = event.currentTarget;
  button.title = namesCollapsed ? "Show tab name" : "Hide tab name";
  button.setAttribute("aria-label", button.title);
  button.querySelector(".material-symbols-outlined").textContent = namesCollapsed ? "label" : "label_off";
});

document.getElementById("detachedReload")?.addEventListener("click", () => api?.reloadInstanceTab?.(tabId));
document.getElementById("detachedReattach")?.addEventListener("click", () => api?.reattachInstanceTab?.(tabId));

api?.onInstanceTabsChange?.(render);
api?.getInstanceTabs?.().then((snapshot) => {
  if (!isError(snapshot)) render(snapshot);
});
