import {
  ADVANCED_INSTANCE_MODEL_SLOTS,
  PRIMARY_INSTANCE_MODEL_SLOTS,
  applyInstanceDefaultsToForm,
  bindInstanceDefaultDirtyTracking,
  bindInstanceDefaultProviderPlaceholderSync,
  buildInstanceEnvText,
  clearInstanceDefaultDirty,
  instanceModelRowsHtml,
  normalizeInstanceDefaults,
  readInstanceDefaultsFromForm
} from "../instance-defaults.js";
import {
  bindHostAccessState,
  bindScopeDependency,
  normalizeConfig as normalizeHostAccessConfig,
  readScopes as readHostAccessScopes,
  scopeFieldsHtml as hostAccessScopeFieldsHtml,
  switchLineHtml as hostAccessSwitchLineHtml
} from "../host-access-dialog.js";
import { byId, compactText } from "../component-utils.js";

const SETTINGS_TAB_KEY = "dm-settings-active-tab";
const SETTINGS_TABS = ["ports", "workspace", "defaults", "a0-tag"];
const HOST_ACCESS_SCOPE_KEYS = ["files", "file_write", "code_execution", "browser", "computer_use"];
let settingsSaveInProgress = false;
let syncHostAccessDefaults = null;
let a0TagProfilesKey = "";

function validSettingsTab(tab) {
  return SETTINGS_TABS.includes(tab) ? tab : "ports";
}

function getSettingsTab() {
  try {
    return validSettingsTab(sessionStorage.getItem(SETTINGS_TAB_KEY));
  } catch {
    return "ports";
  }
}

function setStoredSettingsTab(tab) {
  try {
    sessionStorage.setItem(SETTINGS_TAB_KEY, validSettingsTab(tab));
  } catch {
    // Session storage may be unavailable in constrained browser contexts.
  }
}

function applySettingsTab(tab, { persist = true, focus = false } = {}) {
  const activeTab = validSettingsTab(tab);
  if (persist) setStoredSettingsTab(activeTab);

  document.querySelectorAll(".dm-settings-tab").forEach((button) => {
    const selected = button.dataset.settingsTab === activeTab;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  });

  document.querySelectorAll(".dm-settings-tab-panel").forEach((panel) => {
    const selected = panel.dataset.settingsPanel === activeTab;
    panel.classList.toggle("is-active", selected);
    panel.hidden = !selected;
  });
}

function bindSettingsTabs() {
  const buttons = Array.from(document.querySelectorAll(".dm-settings-tab"));
  if (!buttons.length) return;

  buttons.forEach((button, index) => {
    if (button.dataset.dmTabBound) return;
    button.dataset.dmTabBound = "1";
    button.addEventListener("click", () => applySettingsTab(button.dataset.settingsTab));
    button.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const nextIndex = (index + step + buttons.length) % buttons.length;
      applySettingsTab(buttons[nextIndex]?.dataset.settingsTab, { focus: true });
    });
  });

  applySettingsTab(getSettingsTab(), { persist: false });
}

function parseOptionalInt(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function currentStoragePreferences(state) {
  const prefs = state?.storagePreferences && typeof state.storagePreferences === "object" ? state.storagePreferences : {};
  return {
    mode: prefs.mode === "named_volume" ? "named_volume" : "host_directory",
    hostRoot: compactText(prefs.hostRoot, "~/agent-zero"),
    hostPathMode: prefs.hostPathMode === "exact" ? "exact" : "per_instance",
    volumePrefix: compactText(prefs.volumePrefix, "a0-launcher")
  };
}

function currentA0Tag(state) {
  const tag = state?.a0Tag && typeof state.a0Tag === "object" ? state.a0Tag : {};
  const config = tag.config && typeof tag.config === "object" ? tag.config : tag;
  return {
    enabled: config.enabled === true,
    instanceKey: String(config.instanceKey || ""),
    defaultProfile: String(config.defaultProfile || "")
  };
}

function a0TagInstances(state = {}) {
  const items = [];
  for (const instance of Array.isArray(state?.containers) ? state.containers : []) {
    const id = String(instance?.containerId || "");
    if (!id) continue;
    items.push({
      key: `local:${id}`,
      label: String(instance?.instanceName || instance?.containerName || "Local Instance")
    });
  }
  for (const instance of Array.isArray(state?.remoteInstances) ? state.remoteInstances : []) {
    const id = String(instance?.id || "");
    if (!id) continue;
    items.push({ key: `remote:${id}`, label: String(instance?.name || "Remote Instance") });
  }
  return items;
}

function replaceSelectOptions(select, placeholder, items, selectedValue, showTagKey = false) {
  if (!select || typeof document.createElement !== "function") return;
  select.replaceChildren?.();
  const add = (value, label) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild?.(option);
  };
  add("", placeholder);
  for (const item of items) {
    const key = String(item.key || "");
    const label = String(item.label || key);
    add(key, showTagKey && key && label !== key ? `${label} · @a0.${key}` : label);
  }
  if (selectedValue && !items.some((item) => item.key === selectedValue)) {
    add(selectedValue, `${selectedValue} (unavailable)`);
  }
  select.value = selectedValue || "";
}

function populateA0TagFields(state = {}) {
  const config = currentA0Tag(state);
  const tag = state?.a0Tag && typeof state.a0Tag === "object" ? state.a0Tag : {};
  const enabled = byId("a0TagEnabled");
  const instance = byId("a0TagInstance");
  const profile = byId("a0TagProfile");
  const status = byId("a0TagStatus");
  if (enabled && !enabled.dataset.dirty) enabled.checked = config.enabled;
  if (instance && !instance.dataset.dirty) {
    replaceSelectOptions(instance, "Choose an Instance", a0TagInstances(state), config.instanceKey);
  }
  if (profile && !profile.dataset.dirty) {
    const profiles = Array.isArray(tag.profiles) ? tag.profiles : [];
    replaceSelectOptions(
      profile,
      config.instanceKey ? "Open the selected Instance to load profiles" : "Choose an Instance first",
      profiles,
      config.defaultProfile,
      true
    );
  }
  if (status) status.textContent = String(tag.message || (config.enabled ? "Waiting for the selected Instance" : "Disabled"));
}

function readA0TagSettings() {
  return {
    version: 1,
    enabled: byId("a0TagEnabled")?.checked === true,
    instanceKey: byId("a0TagInstance")?.value || "",
    defaultProfile: byId("a0TagProfile")?.value || ""
  };
}

async function loadA0TagProfiles() {
  const key = byId("a0TagInstance")?.value || "";
  if (!key || key === a0TagProfilesKey) return;
  a0TagProfilesKey = key;
  const result = await window.dockerManagerActions?.getA0TagProfiles?.(key);
  if (!result) {
    a0TagProfilesKey = "";
    return;
  }
  if ((byId("a0TagInstance")?.value || "") !== key) return;
  const profile = byId("a0TagProfile");
  const selected = profile?.value || result.defaultProfile || "";
  replaceSelectOptions(
    profile,
    "Choose a profile",
    Array.isArray(result.profiles) ? result.profiles : [],
    selected,
    true
  );
}

function syncStoragePreferenceFields() {
  const mode = byId("workspaceStorageMode")?.value || "host_directory";
  const host = mode === "host_directory";
  const hostRootRow = byId("workspaceHostRootRow");
  const hostPathModeRow = byId("workspaceHostPathModeRow");
  const volumePrefixRow = byId("workspaceVolumePrefixRow");

  if (hostRootRow) hostRootRow.hidden = !host;
  if (hostPathModeRow) hostPathModeRow.hidden = !host;
  if (volumePrefixRow) volumePrefixRow.hidden = host;
}

function renderModelFields() {
  const primary = byId("settingsPrimaryModels");
  const advanced = byId("settingsAdvancedModels");
  if (primary && !primary.dataset.rendered) {
    primary.innerHTML = instanceModelRowsHtml(PRIMARY_INSTANCE_MODEL_SLOTS, null, "settings");
    primary.dataset.rendered = "1";
  }
  if (advanced && !advanced.dataset.rendered) {
    advanced.innerHTML = instanceModelRowsHtml(ADVANCED_INSTANCE_MODEL_SLOTS, null, "settings");
    advanced.dataset.rendered = "1";
  }
  bindInstanceDefaultProviderPlaceholderSync(document, "settings");
}

function renderHostAccessFields(state = window.__dmLastState || {}) {
  const root = byId("settingsHostAccessDefaults");
  if (!root || root.dataset.rendered) return;
  const defaults = normalizeHostAccessConfig(state?.hostAccess?.defaults, {}, "local");
  const enabled = defaults.configured && defaults.masterEnabled;
  root.innerHTML = `
    <div class="dm-field-label">Host access</div>
    <div class="dm-field-hint">Used when you create a local Instance. You can still change Host access for each Instance.</div>
    ${hostAccessSwitchLineHtml(
      "settingsHostAccessConfigured",
      "Allow new Instances to use this computer",
      "New Instances can use this computer while open with the Launcher, either in a tab or detached window.",
      enabled
    )}
    ${hostAccessScopeFieldsHtml("settingsHostAccess", defaults.scopes, {
      compact: true,
      detailsContent: `<div class="dm-field">
        <label for="settingsHostAccessFolder">Default folder for files and commands <span class="dm-optional">optional</span></label>
        <div class="dm-host-folder-row">
          <input id="settingsHostAccessFolder" class="dm-text-input" type="text" readonly placeholder="Choose a fallback folder" data-host-config-control>
          <button class="button" type="button" data-host-folder data-host-config-control>Choose</button>
        </div>
        <div class="dm-field-hint">Used when an Instance has no workspace on this computer. Agent Zero reads and writes files here. Commands start here but can reach other folders.</div>
      </div>`
    })}`;
  root.dataset.rendered = "1";
  const folder = byId("settingsHostAccessFolder");
  if (folder) folder.value = defaults.folder;
  bindScopeDependency(root);
  syncHostAccessDefaults = bindHostAccessState(root, {
    configuredSelector: "#settingsHostAccessConfigured"
  });
  root.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => { input.dataset.dirty = "1"; });
    input.addEventListener("change", () => { input.dataset.dirty = "1"; });
  });
  root.querySelector("[data-host-folder]")?.addEventListener("click", async () => {
    const result = await window.dockerManagerActions?.chooseHostAccessFolder?.(folder?.value || "");
    if (result?.path && folder) {
      folder.value = result.path;
      folder.dataset.dirty = "1";
    }
  });
}

function populateHostAccessFields(state = {}) {
  renderHostAccessFields(state);
  const root = byId("settingsHostAccessDefaults");
  if (!root) return;
  const defaults = normalizeHostAccessConfig(state?.hostAccess?.defaults, {}, "local");
  const configured = byId("settingsHostAccessConfigured");
  const folder = byId("settingsHostAccessFolder");
  if (configured && !configured.dataset.dirty) {
    configured.checked = defaults.configured && defaults.masterEnabled;
  }
  for (const key of HOST_ACCESS_SCOPE_KEYS) {
    const input = root.querySelector(`[data-host-scope="${key}"]`);
    if (input && !input.dataset.dirty) input.checked = defaults.scopes[key] === true;
  }
  if (folder && !folder.dataset.dirty) folder.value = defaults.folder;
  syncHostAccessDefaults?.();
}

function hostAccessInputs() {
  return Array.from(byId("settingsHostAccessDefaults")?.querySelectorAll("input") || []);
}

function storageInputs() {
  return [
    byId("workspaceStorageMode"),
    byId("workspaceHostRoot"),
    byId("workspaceHostPathMode"),
    byId("workspaceVolumePrefix")
  ].filter(Boolean);
}

function readPortPreferences() {
  return {
    ui: parseOptionalInt(byId("uiPortInput")?.value),
    ssh: parseOptionalInt(byId("sshPortInput")?.value)
  };
}

function readStoragePreferences() {
  return {
    mode: byId("workspaceStorageMode")?.value || "host_directory",
    hostRoot: byId("workspaceHostRoot")?.value || "~/agent-zero",
    hostPathMode: byId("workspaceHostPathMode")?.value || "per_instance",
    volumePrefix: byId("workspaceVolumePrefix")?.value || "a0-launcher"
  };
}

function readHostAccessDefaults() {
  const root = byId("settingsHostAccessDefaults");
  const enabled = byId("settingsHostAccessConfigured")?.checked === true;
  const current = normalizeHostAccessConfig(window.__dmLastState?.hostAccess?.defaults, {}, "local");
  return {
    configured: enabled,
    masterEnabled: enabled,
    folder: byId("settingsHostAccessFolder")?.value || "",
    scopes: readHostAccessScopes(root),
    browserSelection: current.browserSelection
  };
}

function clearPortDirty() {
  delete byId("uiPortInput")?.dataset.dirty;
  delete byId("sshPortInput")?.dataset.dirty;
}

function setSaveSettingsDisabled(disabled) {
  const saveBtn = byId("saveSettingsBtn");
  if (saveBtn) saveBtn.disabled = !!disabled;
}

async function saveAllSettings() {
  if (settingsSaveInProgress) return;
  const actions = window.dockerManagerActions || {};
  const storageFields = storageInputs();
  const hostFields = hostAccessInputs();
  const instanceDefaults = readInstanceDefaultsFromForm(document, "settings");
  const hostAccessDefaults = readHostAccessDefaults();
  const a0Tag = readA0TagSettings();
  const envResult = buildInstanceEnvText(instanceDefaults);

  settingsSaveInProgress = true;
  setSaveSettingsDisabled(true);
  try {
    const portPreferences = readPortPreferences();
    const storagePreferences = readStoragePreferences();
    let portsOk = false;
    let storageOk = false;
    let hostAccessOk = false;
    let defaultsOk = false;
    let a0TagOk = false;

    if (envResult.ok && typeof actions.saveSettings === "function") {
      const saved = await actions.saveSettings({
        portPreferences,
        storagePreferences,
        instanceDefaults,
        hostAccess: {
          onboardingComplete: true,
          defaults: hostAccessDefaults
        },
        a0Tag
      });
      portsOk = saved?.portPreferences === true;
      storageOk = saved?.storagePreferences === true;
      hostAccessOk = saved?.hostAccess === true;
      defaultsOk = saved?.instanceDefaults === true;
      a0TagOk = saved?.a0Tag === true;
    } else {
      portsOk = (await actions.setPortPreferences?.(portPreferences, { quiet: true })) === true;
      storageOk = Boolean(await actions.setStoragePreferences?.(storagePreferences, { quiet: true }));
      hostAccessOk = await actions.setHostAccessSettings?.({
        onboardingComplete: true,
        defaults: hostAccessDefaults
      }) === true;
      if (envResult.ok) {
        defaultsOk = await actions.setInstanceDefaults?.(instanceDefaults, { quiet: true }) === true;
      } else {
        window.toastFrontendError?.(envResult.message, "Agent Zero");
      }
    }

    if (portsOk) clearPortDirty();
    if (storageOk) storageFields.forEach((input) => { delete input.dataset.dirty; });
    if (hostAccessOk) hostFields.forEach((input) => { delete input.dataset.dirty; });
    if (defaultsOk) clearInstanceDefaultDirty(document, "settings");
    if (a0TagOk) {
      for (const input of [byId("a0TagEnabled"), byId("a0TagInstance"), byId("a0TagProfile")]) {
        if (input) delete input.dataset.dirty;
      }
    }

    if (portsOk && storageOk && hostAccessOk && defaultsOk && a0TagOk) {
      window.toastFrontendSuccess?.("Settings saved.", "Agent Zero");
    } else {
      window.toastFrontendWarning?.("Some settings could not be saved.", "Agent Zero");
    }
  } finally {
    settingsSaveInProgress = false;
    setSaveSettingsDisabled(false);
  }
}

function populateFromState(state) {
  renderModelFields();
  const prefs = state?.portPreferences;
  const storagePrefs = currentStoragePreferences(state);
  const instanceDefaults = normalizeInstanceDefaults(state?.instanceDefaults);

  const uiInput = byId("uiPortInput");
  const sshInput = byId("sshPortInput");
  const storageMode = byId("workspaceStorageMode");
  const hostRoot = byId("workspaceHostRoot");
  const hostPathMode = byId("workspaceHostPathMode");
  const volumePrefix = byId("workspaceVolumePrefix");
  const saveSettingsBtn = byId("saveSettingsBtn");

  if (uiInput && prefs?.ui != null && !uiInput.dataset.dirty) {
    uiInput.value = prefs.ui;
  }
  if (sshInput && prefs?.ssh != null && !sshInput.dataset.dirty) {
    sshInput.value = prefs.ssh;
  }
  if (storageMode && !storageMode.dataset.dirty) storageMode.value = storagePrefs.mode;
  if (hostRoot && !hostRoot.dataset.dirty) hostRoot.value = storagePrefs.hostRoot;
  if (hostPathMode && !hostPathMode.dataset.dirty) hostPathMode.value = storagePrefs.hostPathMode;
  if (volumePrefix && !volumePrefix.dataset.dirty) volumePrefix.value = storagePrefs.volumePrefix;
  if (saveSettingsBtn) saveSettingsBtn.disabled = settingsSaveInProgress || state?.progress?.status === "running";
  syncStoragePreferenceFields();
  populateHostAccessFields(state);
  populateA0TagFields(state);
  applyInstanceDefaultsToForm(document, "settings", instanceDefaults, { respectDirty: true });
  if (currentA0Tag(state).instanceKey && state?.a0Tag?.status === "ready") void loadA0TagProfiles();
}

function bindActions() {
  bindSettingsTabs();
  renderModelFields();
  renderHostAccessFields();
  const saveSettingsBtn = byId("saveSettingsBtn");
  const uiInput = byId("uiPortInput");
  const sshInput = byId("sshPortInput");
  const storageFields = storageInputs();
  const a0TagEnabled = byId("a0TagEnabled");
  const a0TagInstance = byId("a0TagInstance");
  const a0TagProfile = byId("a0TagProfile");

  if (uiInput && !uiInput.dataset.bound) {
    uiInput.dataset.bound = "1";
    uiInput.addEventListener("input", () => { uiInput.dataset.dirty = "1"; });
  }
  if (sshInput && !sshInput.dataset.bound) {
    sshInput.dataset.bound = "1";
    sshInput.addEventListener("input", () => { sshInput.dataset.dirty = "1"; });
  }
  bindInstanceDefaultDirtyTracking(document, "settings");

  for (const input of [a0TagEnabled, a0TagInstance, a0TagProfile]) {
    if (!input || input.dataset.bound) continue;
    input.dataset.bound = "1";
    input.addEventListener("change", () => {
      input.dataset.dirty = "1";
      if (input === a0TagInstance) {
        a0TagProfilesKey = "";
        if (a0TagProfile) {
          a0TagProfile.dataset.dirty = "1";
          a0TagProfile.value = "";
        }
      }
      if (input !== a0TagProfile) void loadA0TagProfiles();
    });
  }

  storageFields.forEach((input) => {
    if (input.dataset.bound) return;
    input.dataset.bound = "1";
    input.addEventListener("input", () => { input.dataset.dirty = "1"; });
    input.addEventListener("change", () => {
      input.dataset.dirty = "1";
      syncStoragePreferenceFields();
    });
  });

  if (saveSettingsBtn && !saveSettingsBtn.dataset.bound) {
    saveSettingsBtn.dataset.bound = "1";
    saveSettingsBtn.addEventListener("click", saveAllSettings);
  }
}

export {
  saveAllSettings
};

window.addEventListener("dm:state", (e) => {
  populateFromState(e.detail);
  bindActions();
});

if (window.__dmLastState) {
  populateFromState(window.__dmLastState);
}
bindActions();
