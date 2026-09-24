import {
  bindScopeDependency,
  configForTarget as hostAccessConfigForTarget,
  normalizeConfig as normalizeHostAccessConfig,
  readScopes as readHostAccessScopes,
  scopeFieldsHtml as hostAccessScopeFieldsHtml,
  switchLineHtml as hostAccessSwitchLineHtml
} from "./host-access-dialog.js";

function closeDialog(dialog) {
  if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeUrlInput(value) {
  let raw = String(value || "").trim();
  if (!raw) return null;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) raw = `http://${raw}`;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function isHttpsUrlInput(value) {
  return normalizeUrlInput(value)?.protocol === "https:";
}

function certificateTrustForUrl(url, checked) {
  return isHttpsUrlInput(url) && checked === true;
}

function defaultRemoteName(value) {
  const parsed = normalizeUrlInput(value);
  return parsed?.hostname || "";
}

function optionText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function dialogIntroHtml(intro) {
  const text = typeof intro === "string" ? intro.trim() : "";
  return text ? `<p class="dm-dialog-copy">${escapeHtml(text)}</p>` : "";
}

function cleanCredentialValue(value, maxLength) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function remoteCredentialPayload({ username, password, remember } = {}) {
  if (remember !== true) return { ok: true, credentials: null };
  const cleanUsername = cleanCredentialValue(username, 256);
  const cleanPassword = cleanCredentialValue(password, 4096);
  if (!cleanUsername || !cleanPassword) {
    return { ok: false, message: "Enter both username and password to save credentials." };
  }
  return {
    ok: true,
    credentials: { username: cleanUsername, password: cleanPassword }
  };
}

// Saved credentials have three explicit states in Configure: keep them (the
// default), change them, or remove them. The password is never sent to the
// renderer, so keeping them means not touching them at all.
function remoteCredentialEditAction({ saved = false, mode = "keep", username, password, remember } = {}) {
  if (saved) {
    if (mode === "remove") return { ok: true, action: "clear" };
    if (mode !== "change") return { ok: true, action: "keep" };
    const cleanUsername = cleanCredentialValue(username, 256);
    const cleanPassword = cleanCredentialValue(password, 4096);
    if (!cleanUsername || !cleanPassword) {
      return { ok: false, message: "Enter both username and password to save credentials." };
    }
    return { ok: true, action: "save", credentials: { username: cleanUsername, password: cleanPassword } };
  }
  const added = remoteCredentialPayload({ username, password, remember });
  if (!added.ok) return added;
  return added.credentials
    ? { ok: true, action: "save", credentials: added.credentials }
    : { ok: true, action: "none" };
}

function loginFieldHtml(savedCredentials = null) {
  if (!savedCredentials) {
    return `<div class="dm-field">
          <div class="dm-field-label">Login</div>
          <div class="dm-inline-field-grid">
            <input id="remoteAuthLogin" class="dm-text-input" type="text" autocomplete="username" placeholder="Username">
            <input id="remoteAuthPassword" class="dm-text-input" type="password" autocomplete="new-password" placeholder="Password">
          </div>
          <div class="dm-field-hint">Optional. You can also save credentials later from the Instance menu.</div>
          <label class="dm-checkbox-line">
            <input id="remoteRememberCredentials" type="checkbox">
            <span>Save credentials</span>
          </label>
        </div>`;
  }
  const username = String(savedCredentials.username || "");
  const detail = username ? `<small>Username: <b>${escapeHtml(username)}</b></small>` : "";
  return `<div class="dm-field">
          <div class="dm-field-label">Login</div>
          <div class="dm-saved-credentials" data-credentials-view="keep">
            <span class="material-symbols-outlined" aria-hidden="true">key</span>
            <div>
              <strong>Credentials saved</strong>
              ${detail}
            </div>
            <div class="dm-saved-credentials-actions">
              <button class="button" type="button" data-credentials-mode="change">Change</button>
              <button class="button" type="button" data-credentials-mode="remove">Remove</button>
            </div>
          </div>
          <div class="dm-field-hint" data-credentials-view="keep">No need to enter them again.</div>
          <div data-credentials-view="change" hidden>
            <div class="dm-inline-field-grid">
              <input id="remoteAuthLogin" class="dm-text-input" type="text" autocomplete="username" placeholder="Username" value="${escapeHtml(username)}">
              <input id="remoteAuthPassword" class="dm-text-input" type="password" autocomplete="new-password" placeholder="New password">
            </div>
            <div class="dm-saved-credentials-footer">
              <span class="dm-field-hint">Both fields are required.</span>
              <button class="button" type="button" data-credentials-mode="keep">Keep saved</button>
            </div>
          </div>
          <div class="dm-saved-credentials-footer" data-credentials-view="remove" hidden>
            <span class="dm-field-hint">Saved credentials will be removed when you click Save.</span>
            <button class="button" type="button" data-credentials-mode="keep">Undo</button>
          </div>
        </div>`;
}

function sameHostAccessScopes(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    if ((a?.[key] === true) !== (b?.[key] === true)) return false;
  }
  return true;
}

// Saving Host access restarts the Instance's gateway lease, so Configure only
// sends it when something changed, and keeps the fields the form does not show.
function remoteHostAccessEditPayload(current = {}, { connect, folder, scopes } = {}) {
  const wasConnected = current?.configured === true;
  const nextConnected = connect === true;
  const nextFolder = nextConnected ? String(folder || "") : "";
  if (nextConnected && !nextFolder) {
    return { ok: false, message: "Choose a folder for files and commands." };
  }
  const unchanged = nextConnected === wasConnected && (
    !nextConnected
    || (nextFolder === String(current?.folder || "") && sameHostAccessScopes(scopes, current?.scopes))
  );
  if (unchanged) return { ok: true, payload: null };
  return {
    ok: true,
    payload: {
      configured: nextConnected,
      masterEnabled: nextConnected ? (wasConnected ? current?.masterEnabled !== false : true) : false,
      folder: nextFolder,
      scopes,
      browserSelection: String(current?.browserSelection || "")
    }
  };
}

function openRestartToApplyDialog() {
  const existing = document.getElementById("restartToApplyDialog");
  if (existing) existing.remove();

  const dialog = document.createElement("div");
  dialog.id = "restartToApplyDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.setAttribute("role", "presentation");
  dialog.innerHTML = `
    <form class="dm-dialog" role="dialog" aria-modal="true" aria-labelledby="restartToApplyTitle">
      <div class="dm-dialog-header">
        <h2 id="restartToApplyTitle" class="dm-dialog-title">Restart to apply</h2>
        <button class="button dm-dialog-close" type="button" data-dialog-close aria-label="Close">&times;</button>
      </div>
      <div class="dm-dialog-body">
        <p class="dm-dialog-copy">The certificate setting takes effect after the Launcher restarts.</p>
      </div>
      <div class="dm-dialog-footer">
        <button class="button" type="button" data-dialog-close>Later</button>
        <button class="button confirm" type="submit">Restart now</button>
      </div>
    </form>
  `;
  dialog.querySelectorAll("[data-dialog-close]").forEach((button) => {
    button.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  dialog.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    closeDialog(dialog);
    window.dockerManagerActions?.restartLauncher?.();
  });
  document.body.appendChild(dialog);
}

// Chromium keeps the certificate verdict it has already cached for a host, so
// a changed opt-in may apply only after a restart. Ask only when that is so.
async function offerRestartToApply(instanceUrl) {
  const required = await window.dockerManagerActions?.certificateTrustRestartRequired?.(instanceUrl || "");
  if (required === true) openRestartToApplyDialog();
}

// One form for both adding a remote Instance and configuring a saved one.
// `editing` is the saved Instance, or null when adding.
function openRemoteInstanceDialog(options = {}, editing = null) {
  const existing = document.getElementById("remoteInstanceDialog");
  if (existing) existing.remove();

  let completed = false;
  const title = optionText(options.title, editing ? "Configure Instance" : "Add remote Instance");
  const submitLabel = optionText(options.submitLabel, editing ? "Save" : "Add Instance");
  const hostDefaults = normalizeHostAccessConfig(window.__dmLastState?.hostAccess?.defaults, {}, "remote");
  const launcherDefaultFolder = String(window.__dmLastState?.hostAccess?.defaults?.folder || "");
  const editingCredentials = editing?.launcherCredentials?.saved === true ? editing.launcherCredentials : null;
  const editingHostAccess = editing
    ? hostAccessConfigForTarget(window.__dmLastState || {}, { kind: "remote", instanceId: editing.id })
    : null;
  const hostScopes = editingHostAccess ? editingHostAccess.scopes : hostDefaults.scopes;
  const hostFolderValue = editingHostAccess?.folder || launcherDefaultFolder;
  const hostConnected = editingHostAccess?.configured === true;
  const dialog = document.createElement("div");
  dialog.id = "remoteInstanceDialog";
  dialog.className = `dm-dialog-backdrop${options.backdropClass ? ` ${options.backdropClass}` : ""}`;
  dialog.setAttribute("role", "presentation");
  dialog.innerHTML = `
    <form class="dm-dialog" role="dialog" aria-modal="true" aria-labelledby="remoteInstanceTitle">
      <div class="dm-dialog-header">
        <h2 id="remoteInstanceTitle" class="dm-dialog-title">${escapeHtml(title)}</h2>
        <button class="button dm-dialog-close" type="button" data-dialog-close aria-label="Close">&times;</button>
      </div>
      <div class="dm-dialog-body dm-run-instance-body">
        ${dialogIntroHtml(options.intro)}
        <div class="dm-field">
          <label for="remoteInstanceUrl">Instance URL</label>
          <input id="remoteInstanceUrl" class="dm-text-input" type="text" inputmode="url" autocomplete="url" placeholder="https://agent-zero.example.com">
          <div class="dm-field-hint">Use the URL where this Agent Zero Instance is already running. If no protocol is entered, the launcher will use http://.</div>
          <label class="dm-checkbox-line">
            <input id="remoteAllowUntrustedCertificate" type="checkbox" disabled>
            <span>Trust this Instance's certificate</span>
          </label>
          <div class="dm-field-hint">For a self-signed certificate, or one from your own CA. Works only with https. The certificate must still match this address.</div>
        </div>
        <div class="dm-field">
          <label for="remoteInstanceName">Instance name</label>
          <input id="remoteInstanceName" class="dm-text-input" type="text" maxlength="80" autocomplete="off" placeholder="Remote Instance">
          <div class="dm-field-hint">Optional. This is only the friendly name shown in Instances.</div>
        </div>
        ${loginFieldHtml(editingCredentials)}
        <div class="dm-field dm-host-access-setup">
          <div class="dm-field-label">Host access</div>
          ${hostAccessSwitchLineHtml(
            "remoteHostAccessConfigured",
            "Allow this Instance to use this computer",
            "Leave off for no access to this computer. Access works only while this Instance is open with the Launcher, either in a tab or detached window.",
            hostConnected
          )}
          <div data-launcher-host-options hidden>
            ${hostAccessScopeFieldsHtml("remoteHostAccess", hostScopes, {
              compact: true,
              detailsContent: `<div class="dm-field">
                <label for="remoteHostAccessFolder">Folder for files and commands on this computer</label>
                <div class="dm-host-folder-row">
                  <input id="remoteHostAccessFolder" class="dm-text-input" type="text" readonly value="${escapeHtml(hostFolderValue)}" placeholder="Choose a folder on this computer">
                  <button class="button" type="button" data-host-folder>Choose</button>
                </div>
                <div class="dm-field-hint">Agent Zero reads and writes files here. Commands start here but can reach other folders on this computer.</div>
              </div>`
            })}
          </div>
        </div>
      </div>
      <div class="dm-dialog-footer">
        <button class="button" type="button" data-dialog-close>Cancel</button>
        <button class="button confirm" type="submit">${escapeHtml(submitLabel)}</button>
      </div>
    </form>
  `;

  const form = dialog.querySelector("form");
  const urlInput = dialog.querySelector("#remoteInstanceUrl");
  const nameInput = dialog.querySelector("#remoteInstanceName");
  const usernameInput = dialog.querySelector("#remoteAuthLogin");
  const passwordInput = dialog.querySelector("#remoteAuthPassword");
  const rememberInput = dialog.querySelector("#remoteRememberCredentials");
  const certificateTrustInput = dialog.querySelector("#remoteAllowUntrustedCertificate");
  const hostAccessInput = dialog.querySelector("#remoteHostAccessConfigured");
  const hostOptions = dialog.querySelector("[data-launcher-host-options]");
  const hostFolder = dialog.querySelector("#remoteHostAccessFolder");

  const cancel = () => {
    closeDialog(dialog);
    if (!completed) options.onCancel?.();
  };

  const syncCertificateTrust = () => {
    const https = isHttpsUrlInput(urlInput?.value || "");
    if (!certificateTrustInput) return;
    certificateTrustInput.disabled = !https;
    if (!https) certificateTrustInput.checked = false;
  };
  urlInput?.addEventListener("input", () => {
    syncCertificateTrust();
    if (!nameInput || nameInput.dataset.dirty) return;
    nameInput.value = defaultRemoteName(urlInput.value);
  });
  if (editing) {
    if (urlInput) urlInput.value = String(editing.url || "");
    if (nameInput) {
      nameInput.value = String(editing.name || "");
      nameInput.dataset.dirty = "1";
    }
    if (certificateTrustInput) certificateTrustInput.checked = editing.allowUntrustedCertificate === true;
  }
  syncCertificateTrust();
  let credentialMode = "keep";
  const setCredentialMode = (mode) => {
    credentialMode = ["keep", "change", "remove"].includes(mode) ? mode : "keep";
    dialog.querySelectorAll("[data-credentials-view]").forEach((view) => {
      view.hidden = view.dataset.credentialsView !== credentialMode;
    });
    if (credentialMode === "change") window.setTimeout(() => passwordInput?.focus(), 0);
  };
  dialog.querySelectorAll("[data-credentials-mode]").forEach((button) => {
    button.addEventListener("click", () => setCredentialMode(button.dataset.credentialsMode));
  });
  nameInput?.addEventListener("input", () => {
    nameInput.dataset.dirty = "1";
  });
  bindScopeDependency(dialog.querySelector(".dm-host-access-setup"));
  const syncHostChoice = () => {
    const connectLauncher = hostAccessInput?.checked === true;
    if (hostOptions) hostOptions.hidden = !connectLauncher;
  };
  hostAccessInput?.addEventListener("change", syncHostChoice);
  dialog.querySelector("[data-host-folder]")?.addEventListener("click", async () => {
    const result = await window.dockerManagerActions?.chooseHostAccessFolder?.(hostFolder?.value || launcherDefaultFolder);
    if (result?.path && hostFolder) hostFolder.value = result.path;
  });
  syncHostChoice();

  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", cancel);
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) cancel();
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = urlInput?.value || "";
    if (!normalizeUrlInput(url)) {
      window.toastFrontendError?.("Enter a valid Instance URL.", "Agent Zero");
      return;
    }
    if (editing) {
      const instanceId = editing.id || "";
      const credentialAction = remoteCredentialEditAction({
        saved: editingCredentials !== null,
        mode: credentialMode,
        username: usernameInput?.value || "",
        password: passwordInput?.value || "",
        remember: rememberInput?.checked === true
      });
      if (!credentialAction.ok) {
        window.toastFrontendError?.(credentialAction.message, "Agent Zero");
        return;
      }
      const hostAccessEdit = remoteHostAccessEditPayload(editingHostAccess, {
        connect: hostAccessInput?.checked === true,
        folder: hostFolder?.value || "",
        scopes: readHostAccessScopes(dialog.querySelector(".dm-host-access-setup"))
      });
      if (!hostAccessEdit.ok) {
        window.toastFrontendError?.(hostAccessEdit.message, "Agent Zero");
        return;
      }
      const updated = await window.dockerManagerActions?.updateRemoteInstance?.(instanceId, {
        url,
        name: nameInput?.value || "",
        allowUntrustedCertificate: certificateTrustForUrl(url, certificateTrustInput?.checked)
      });
      if (!updated) return;
      if (credentialAction.action === "save") {
        const saved = await window.dockerManagerActions?.setRemoteInstanceCredentials?.(
          instanceId,
          credentialAction.credentials
        );
        if (saved === false) return;
      } else if (credentialAction.action === "clear") {
        const cleared = await window.dockerManagerActions?.clearRemoteInstanceCredentials?.(instanceId);
        if (cleared === false) return;
      }
      if (hostAccessEdit.payload) {
        const hostAccessSaved = await window.dockerManagerActions?.setInstanceHostAccess?.({
          kind: "remote",
          id: instanceId,
          instanceId
        }, hostAccessEdit.payload);
        if (hostAccessSaved === false) return;
      }
      completed = true;
      closeDialog(dialog);
      await offerRestartToApply(updated.url);
      return;
    }
    const credentialResult = remoteCredentialPayload({
      username: usernameInput?.value || "",
      password: passwordInput?.value || "",
      remember: rememberInput?.checked === true
    });
    if (!credentialResult.ok) {
      window.toastFrontendError?.(credentialResult.message, "Agent Zero");
      return;
    }
    const connectLauncher = hostAccessInput?.checked === true;
    if (connectLauncher && !hostFolder?.value) {
      window.toastFrontendError?.("Choose a folder for files and commands.", "Agent Zero");
      return;
    }
    const result = await window.dockerManagerActions?.addRemoteInstance?.({
      url,
      name: nameInput?.value || "",
      allowUntrustedCertificate: certificateTrustForUrl(url, certificateTrustInput?.checked)
    });
    if (!result) return;
    if (credentialResult.credentials) {
      const saved = await window.dockerManagerActions?.setRemoteInstanceCredentials?.(
        result.id || "",
        credentialResult.credentials
      );
      if (saved === false) return;
    }
    const hostAccessSaved = await window.dockerManagerActions?.setInstanceHostAccess?.({
      kind: "remote",
      id: result.id || "",
      instanceId: result.id || ""
    }, {
      configured: connectLauncher,
      masterEnabled: connectLauncher,
      folder: connectLauncher ? hostFolder?.value || "" : "",
      scopes: readHostAccessScopes(dialog.querySelector(".dm-host-access-setup")),
      browserSelection: ""
    });
    if (hostAccessSaved === false) return;
    completed = true;
    closeDialog(dialog);
    await options.onAdded?.(result);
    await offerRestartToApply(result.url);
  });

  document.body.appendChild(dialog);
  window.setTimeout(() => urlInput?.focus(), 0);
}

function openAddRemoteInstanceDialog(options = {}) {
  openRemoteInstanceDialog(options, null);
}

function openConfigureRemoteInstanceDialog(remote) {
  if (!remote?.id) return;
  openRemoteInstanceDialog({}, remote);
}

export {
  certificateTrustForUrl,
  loginFieldHtml,
  remoteCredentialEditAction,
  remoteHostAccessEditPayload,
  remoteCredentialPayload,
  openAddRemoteInstanceDialog,
  openConfigureRemoteInstanceDialog
};
