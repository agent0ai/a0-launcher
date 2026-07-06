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
  AUTO_LOCALE,
  getLauncherLocalePreference,
  setLauncherLocalePreference,
  t
} from "../i18n.js";

const SETTINGS_TAB_KEY = "dm-settings-active-tab";
const SETTINGS_TABS = ["ports", "workspace", "defaults"];
let settingsSaveInProgress = false;

function byId(id) { return document.getElementById(id); }

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

function compactText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
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

function storageInputs() {
  return [
    byId("workspaceStorageMode"),
    byId("workspaceHostRoot"),
    byId("workspaceHostPathMode"),
    byId("workspaceVolumePrefix")
  ].filter(Boolean);
}

function languageInput() {
  return byId("launcherLanguagePreference");
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

function readLanguagePreference() {
  const value = languageInput()?.value || AUTO_LOCALE;
  return value === "en" || value === "ko" ? value : AUTO_LOCALE;
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
  const language = languageInput();
  const requestedLanguage = readLanguagePreference();
  const instanceDefaults = readInstanceDefaultsFromForm(document, "settings");
  const envResult = buildInstanceEnvText(instanceDefaults);

  settingsSaveInProgress = true;
  setSaveSettingsDisabled(true);
  try {
    const languagePreference = setLauncherLocalePreference(requestedLanguage);
    const languageOk = languagePreference === requestedLanguage;
    const portsOk = (await actions.setPortPreferences?.(readPortPreferences(), { quiet: true })) === true;
    const storageOk = Boolean(await actions.setStoragePreferences?.(readStoragePreferences(), { quiet: true }));
    let defaultsOk = false;

    if (envResult.ok) {
      defaultsOk = await actions.setInstanceDefaults?.(instanceDefaults, { quiet: true }) === true;
    } else {
      window.toastFrontendError?.(envResult.message, "Agent Zero");
    }

    if (languageOk && language) delete language.dataset.dirty;
    if (portsOk) clearPortDirty();
    if (storageOk) storageFields.forEach((input) => { delete input.dataset.dirty; });
    if (defaultsOk) clearInstanceDefaultDirty(document, "settings");

    if (languageOk && portsOk && storageOk && defaultsOk) {
      window.toastFrontendSuccess?.(t("settings.saved"), "Agent Zero");
    } else {
      window.toastFrontendWarning?.(t("settings.savePartial"), "Agent Zero");
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
  const language = languageInput();
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
  if (language && !language.dataset.dirty) language.value = getLauncherLocalePreference();
  if (saveSettingsBtn) saveSettingsBtn.disabled = settingsSaveInProgress || state?.progress?.status === "running";
  syncStoragePreferenceFields();
  applyInstanceDefaultsToForm(document, "settings", instanceDefaults, { respectDirty: true });
}

function bindActions() {
  bindSettingsTabs();
  renderModelFields();
  const saveSettingsBtn = byId("saveSettingsBtn");
  const uiInput = byId("uiPortInput");
  const sshInput = byId("sshPortInput");
  const language = languageInput();
  const storageFields = storageInputs();

  if (uiInput && !uiInput.dataset.bound) {
    uiInput.dataset.bound = "1";
    uiInput.addEventListener("input", () => { uiInput.dataset.dirty = "1"; });
  }
  if (sshInput && !sshInput.dataset.bound) {
    sshInput.dataset.bound = "1";
    sshInput.addEventListener("input", () => { sshInput.dataset.dirty = "1"; });
  }
  if (language && !language.dataset.bound) {
    language.dataset.bound = "1";
    language.addEventListener("change", () => { language.dataset.dirty = "1"; });
  }
  bindInstanceDefaultDirtyTracking(document, "settings");

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
