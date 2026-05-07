function byId(id) { return document.getElementById(id); }

function parseOptionalInt(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function populateFromState(state) {
  const prefs = state?.portPreferences;
  const policy = state?.retentionPolicy;

  const uiInput = byId("uiPortInput");
  const sshInput = byId("sshPortInput");
  const keepSelect = byId("keepCountSelect");

  if (uiInput && prefs?.ui != null && !uiInput.dataset.dirty) {
    uiInput.value = prefs.ui;
  }
  if (sshInput && prefs?.ssh != null && !sshInput.dataset.dirty) {
    sshInput.value = prefs.ssh;
  }
  if (keepSelect && policy?.keepCount != null && !keepSelect.dataset.dirty) {
    const kc = String(policy.keepCount);
    const opt = keepSelect.querySelector(`option[value="${kc}"]`);
    if (opt) keepSelect.value = kc;
  }
}

function bindActions() {
  const savePortsBtn = byId("savePortsBtn");
  const saveRetentionBtn = byId("saveRetentionBtn");
  const uiInput = byId("uiPortInput");
  const sshInput = byId("sshPortInput");
  const keepSelect = byId("keepCountSelect");

  if (uiInput && !uiInput.dataset.bound) {
    uiInput.dataset.bound = "1";
    uiInput.addEventListener("input", () => { uiInput.dataset.dirty = "1"; });
  }
  if (sshInput && !sshInput.dataset.bound) {
    sshInput.dataset.bound = "1";
    sshInput.addEventListener("input", () => { sshInput.dataset.dirty = "1"; });
  }
  if (keepSelect && !keepSelect.dataset.bound) {
    keepSelect.dataset.bound = "1";
    keepSelect.addEventListener("change", () => { keepSelect.dataset.dirty = "1"; });
  }

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

  if (saveRetentionBtn && !saveRetentionBtn.dataset.bound) {
    saveRetentionBtn.dataset.bound = "1";
    saveRetentionBtn.addEventListener("click", async () => {
      const keepCount = parseOptionalInt(keepSelect?.value) || 1;
      const ok = await window.dockerManagerActions?.setRetentionPolicy?.(keepCount);
      if (ok && keepSelect) delete keepSelect.dataset.dirty;
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
