import {
  ADVANCED_INSTANCE_MODEL_SLOTS,
  PRIMARY_INSTANCE_MODEL_SLOTS,
  applyInstanceDefaultsToForm,
  bindInstanceDefaultDirtyTracking,
  buildInstanceEnvText,
  clearInstanceDefaultDirty,
  instanceModelRowsHtml,
  normalizeInstanceDefaults,
  readInstanceDefaultsFromForm
} from "../instance-defaults.js";

function byId(id) { return document.getElementById(id); }

function parseOptionalInt(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
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
}

function populateFromState(state) {
  renderModelFields();
  const prefs = state?.portPreferences;
  const instanceDefaults = normalizeInstanceDefaults(state?.instanceDefaults);

  const uiInput = byId("uiPortInput");
  const sshInput = byId("sshPortInput");

  if (uiInput && prefs?.ui != null && !uiInput.dataset.dirty) {
    uiInput.value = prefs.ui;
  }
  if (sshInput && prefs?.ssh != null && !sshInput.dataset.dirty) {
    sshInput.value = prefs.ssh;
  }
  applyInstanceDefaultsToForm(document, "settings", instanceDefaults, { respectDirty: true });
}

function bindActions() {
  renderModelFields();
  const savePortsBtn = byId("savePortsBtn");
  const saveInstanceDefaultsBtn = byId("saveInstanceDefaultsBtn");
  const uiInput = byId("uiPortInput");
  const sshInput = byId("sshPortInput");

  if (uiInput && !uiInput.dataset.bound) {
    uiInput.dataset.bound = "1";
    uiInput.addEventListener("input", () => { uiInput.dataset.dirty = "1"; });
  }
  if (sshInput && !sshInput.dataset.bound) {
    sshInput.dataset.bound = "1";
    sshInput.addEventListener("input", () => { sshInput.dataset.dirty = "1"; });
  }
  bindInstanceDefaultDirtyTracking(document, "settings");

  if (savePortsBtn && !savePortsBtn.dataset.bound) {
    savePortsBtn.dataset.bound = "1";
    savePortsBtn.addEventListener("click", async () => {
      const ui = parseOptionalInt(uiInput?.value);
      const ssh = parseOptionalInt(sshInput?.value);
      const ok = await window.dockerManagerActions?.setPortPreferences?.({ ui, ssh });
      if (ok) {
        if (uiInput) delete uiInput.dataset.dirty;
        if (sshInput) delete sshInput.dataset.dirty;
      }
    });
  }

  if (saveInstanceDefaultsBtn && !saveInstanceDefaultsBtn.dataset.bound) {
    saveInstanceDefaultsBtn.dataset.bound = "1";
    saveInstanceDefaultsBtn.addEventListener("click", async () => {
      const instanceDefaults = readInstanceDefaultsFromForm(document, "settings");
      const envResult = buildInstanceEnvText(instanceDefaults);
      if (!envResult.ok) {
        window.toastFrontendError?.(envResult.message, "Agent Zero");
        return;
      }
      const ok = await window.dockerManagerActions?.setInstanceDefaults?.(instanceDefaults);
      if (ok) clearInstanceDefaultDirty(document, "settings");
    });
  }
}

window.addEventListener("dm:state", (e) => {
  populateFromState(e.detail);
  bindActions();
});

if (window.__dmLastState) {
  populateFromState(window.__dmLastState);
}
bindActions();
