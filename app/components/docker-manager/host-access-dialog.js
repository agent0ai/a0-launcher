import { escapeHtml } from "./component-utils.js";

const SCOPE_FIELDS = Object.freeze([
  { key: "files", icon: "folder_open", label: "Files read", hint: "Open files in the folder below." },
  { key: "file_write", icon: "edit_document", label: "Files write", hint: "Create and change files there." },
  { key: "code_execution", icon: "terminal", label: "Code execution", hint: "Run terminal commands on this computer." },
  { key: "browser", icon: "language", label: "Use my Browser", hint: "Work in a supported browser profile." },
  { key: "computer_use", icon: "computer", label: "Computer Use", hint: "See and control apps on this computer." }
]);

const CAPABILITY_STATUS_LABELS = Object.freeze({
  ready: "Ready",
  active: "Active",
  disabled: "Off",
  unsupported: "Not available",
  "relaunch required": "Browser restart needed",
  interactive: "Ask each time",
  persistent: "Ready",
  allow: "Ready",
  arming: "Waiting for permission",
  "approval required": "Permission needed",
  "rearm required": "Permission needed",
  "restart required": "Restart needed",
  error: "Needs attention"
});

const ARMABLE_COMPUTER_USE_STATUSES = new Set([
  "approval required",
  "rearm required",
  "restart required",
  "error"
]);

function normalizeScopes(value = {}) {
  const scopes = {
    files: value?.files !== false,
    file_write: typeof value?.file_write === "boolean" ? value.file_write : value?.files !== false,
    code_execution: value?.code_execution !== false,
    browser: value?.browser === true,
    computer_use: value?.computer_use === true
  };
  if (!scopes.files) scopes.file_write = false;
  if (!scopes.file_write) scopes.code_execution = false;
  return scopes;
}

function normalizeConfig(value = {}, fallback = {}, kind = "local") {
  const local = kind !== "remote";
  const configured = typeof value?.configured === "boolean"
    ? value.configured
    : local && fallback?.configured === true;
  return {
    configured,
    masterEnabled: typeof value?.masterEnabled === "boolean"
      ? value.masterEnabled
      : typeof fallback?.masterEnabled === "boolean"
        ? fallback.masterEnabled
        : configured,
    folder: String(value?.folder || (local ? fallback?.folder : "") || ""),
    folderSource: String(value?.folderSource || ""),
    scopes: normalizeScopes(value?.scopes || fallback?.scopes),
    browserSelection: String(value?.browserSelection || (local ? fallback?.browserSelection : "") || "")
  };
}

function instanceKey(target = {}) {
  const kind = target?.kind === "remote" ? "remote" : "local";
  const id = kind === "remote" ? target?.instanceId || target?.id : target?.containerId || target?.id;
  return id ? `${kind}:${id}` : "";
}

function configForTarget(state = {}, target = {}) {
  const hostAccess = state?.hostAccess || {};
  const defaults = normalizeConfig(hostAccess?.defaults, {}, "local");
  const key = instanceKey(target);
  const saved = key ? hostAccess?.instances?.[key] : null;
  const runtimeConfig = target?.hostAccess?.config;
  const config = normalizeConfig(saved || runtimeConfig, defaults, target?.kind);
  if (target?.kind === "remote" && !config.folder) config.folder = defaults.folder;
  return config;
}

function scopeFieldsHtml(prefix, scopes, { compact = false, masterContent = "", detailsContent = "" } = {}) {
  const fields = `<fieldset class="dm-host-access-scopes${compact ? " compact" : ""}" aria-label="Host permissions">
      ${SCOPE_FIELDS.map(({ key, icon, label, hint }) => `
        <label class="dm-host-access-scope">
          <span class="material-symbols-outlined dm-host-access-scope-icon" aria-hidden="true">${escapeHtml(icon)}</span>
          <span class="dm-host-access-scope-copy">
            <strong>${escapeHtml(label)}</strong>
            <small>${escapeHtml(hint)}</small>
          </span>
          <span class="dm-host-access-switch">
            <input id="${prefix}-${key}" data-host-scope="${key}" type="checkbox"${scopes[key] ? " checked" : ""}>
            <span class="dm-host-access-toggler" aria-hidden="true"></span>
          </span>
        </label>
      `).join("")}
    </fieldset>`;
  return `<details class="dm-advanced dm-host-access-permissions">
    <summary>Host permissions <span data-host-scope-summary>${scopeSummaryText(scopes)}</span></summary>
    ${masterContent}
    ${fields}
    ${detailsContent}
  </details>`;
}

function scopeSummaryText(scopes, enabled = true) {
  if (!enabled) return "Host access off";
  const permissions = [
    ["Read", scopes.files],
    ["Write", scopes.file_write],
    ["Code", scopes.code_execution],
    ["Browser", scopes.browser],
    ["Computer Use", scopes.computer_use]
  ];
  const on = permissions.filter(([, active]) => active).map(([label]) => label);
  const off = permissions.filter(([, active]) => !active).map(([label]) => label);
  return [on.length ? `On: ${on.join(", ")}` : "", off.length ? `Off: ${off.join(", ")}` : ""].filter(Boolean).join(" · ");
}

function syncScopeDependency(root) {
  const files = root.querySelector('[data-host-scope="files"]');
  const write = root.querySelector('[data-host-scope="file_write"]');
  const code = root.querySelector('[data-host-scope="code_execution"]');
  if (!files || !write || !code) return;
  if (!files.checked) write.checked = false;
  if (!write.checked) code.checked = false;
  write.disabled = !files.checked;
  code.disabled = !write.checked;
  const summary = root.querySelector("[data-host-scope-summary]");
  if (summary) summary.textContent = scopeSummaryText(readScopes(root));
}

function bindScopeDependency(root) {
  if (!root) return;
  root.querySelectorAll("[data-host-scope]").forEach((input) => {
    input.addEventListener("change", () => syncScopeDependency(root));
  });
  syncScopeDependency(root);
}

function bindHostAccessState(root, { configuredSelector = "" } = {}) {
  if (!root) return;
  const configured = configuredSelector ? root.querySelector(configuredSelector) : null;
  const scopes = root.querySelector(".dm-host-access-scopes");
  const sync = () => {
    const configuredOn = !configured || configured.checked;
    if (scopes) scopes.disabled = !configuredOn;
    root.querySelectorAll("[data-host-config-control]").forEach((control) => {
      control.disabled = !configuredOn || control.dataset.hostLocked === "true";
    });
    syncScopeDependency(root);
    const summary = root.querySelector("[data-host-scope-summary]");
    if (summary) summary.textContent = scopeSummaryText(readScopes(root), configuredOn);
  };
  configured?.addEventListener("change", sync);
  sync();
  return sync;
}

function switchLineHtml(id, label, hint, checked) {
  return `<label class="dm-host-access-switch-line" for="${escapeHtml(id)}">
    <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(hint)}</small></span>
    <span class="dm-host-access-switch">
      <input id="${escapeHtml(id)}" type="checkbox"${checked ? " checked" : ""}>
      <span class="dm-host-access-toggler" aria-hidden="true"></span>
    </span>
  </label>`;
}

function readScopes(root) {
  const scopes = {};
  for (const { key } of SCOPE_FIELDS) {
    scopes[key] = root.querySelector(`[data-host-scope="${key}"]`)?.checked === true;
  }
  if (!scopes.files) scopes.file_write = false;
  if (!scopes.file_write) scopes.code_execution = false;
  return scopes;
}

async function chooseFolder(input) {
  const result = await window.dockerManagerActions?.chooseHostAccessFolder?.(input?.value || "");
  if (result?.path && input) input.value = result.path;
  return result;
}

function statusLabel(value) {
  const state = String(value || "disconnected");
  return {
    connecting: "Connecting",
    connected: "Connected",
    paused: "Paused",
    needs_action: "Needs action",
    error: "Error",
    disconnected: "Disconnected"
  }[state] || "Disconnected";
}

function normalizeCapabilityStatus(value) {
  return String(value || "").trim().toLowerCase().replaceAll("_", " ");
}

function capabilityStatusLabel(value, fallback) {
  return CAPABILITY_STATUS_LABELS[normalizeCapabilityStatus(value)] || fallback;
}

function computerUseNeedsArm(value) {
  return ARMABLE_COMPUTER_USE_STATUSES.has(normalizeCapabilityStatus(value));
}

function gatewaySupportsComputerUseSetup(gateway = {}) {
  return Array.isArray(gateway?.features) && gateway.features.includes("computer_use_setup_v1");
}

function capabilityReadinessLabel(allowed, capability = {}, { computerUse = false, setupSupported = false } = {}) {
  if (!allowed) return "Not allowed";
  if (computerUse) {
    const setupState = normalizeCapabilityStatus(capability?.setup?.state);
    if (setupState === "ready") return "Allowed · Ready";
    if (setupState === "checking") return "Allowed · Checking";
    if (["accessibility required", "screen recording required", "restart required", "error"].includes(setupState)) {
      return "Allowed · Setup needed";
    }
    if (setupSupported && (!setupState || setupState === "unknown")) return "Allowed · Checking";
  }
  const status = normalizeCapabilityStatus(capability?.status);
  return ["ready", "active", "persistent", "allow"].includes(status)
    ? "Allowed · Ready"
    : status === "arming"
      ? "Allowed · Checking"
      : "Allowed · Setup needed";
}

function computerUseSetupState(config = {}, runtime = {}) {
  const gateway = runtime?.gateway || {};
  const computer = gateway?.status?.computer_use || {};
  const allowed = config.configured === true && config.masterEnabled !== false && config.scopes?.computer_use === true;
  const setupSupported = gatewaySupportsComputerUseSetup(gateway);
  const macosBackend = String(computer?.backend_family || computer?.backend_id || "").toLowerCase() === "macos";
  const setupState = normalizeCapabilityStatus(computer?.setup?.state);
  const updateRequired = allowed && macosBackend && !setupSupported;
  const checkingMessage = macosBackend ? "Checking macOS permissions…" : "Checking Computer Use…";
  const actionLabel = setupState === "accessibility required"
    ? "Open Accessibility Settings"
    : setupState === "screen recording required"
      ? "Allow Screen Recording"
      : "Check Computer Use";
  return {
    allowed,
    computer,
    setupSupported,
    setupState,
    label: updateRequired
      ? "Allowed · Setup needed"
      : capabilityReadinessLabel(allowed, computer, { computerUse: true, setupSupported }),
    canSetup: allowed && setupSupported && setupState !== "ready" && setupState !== "checking",
    actionLabel,
    checkingMessage,
    prompt: ["accessibility required", "screen recording required"].includes(setupState),
    restartRequired: allowed && setupState === "restart required",
    message: updateRequired
      ? "Update A0 CLI to finish Computer Use setup."
      : String(computer?.setup?.message || computer?.message || computer?.last_error || "")
  };
}

function rawBrowserSupportMessage(browser = {}) {
  return String(browser?.message || browser?.support_reason || browser?.last_error || "").trim();
}

function browserSupportNeedsRepair(browser = {}) {
  return browser?.can_repair === true || [browser?.message, browser?.support_reason, browser?.last_error]
    .some((value) => /Python Playwright is not installed|Browser support is incomplete/i.test(String(value || "")));
}

function browserSetupAvailable(browser = {}) {
  return browser?.can_prepare === true || browserSupportNeedsRepair(browser);
}

function browserSupportMessage(browser = {}) {
  const message = rawBrowserSupportMessage(browser);
  if (browserSupportNeedsRepair(browser)) {
    return "Browser support needs repair. Choose Set up browser.";
  }
  return message;
}

function browserSupportDetail(allowed, browser = {}) {
  if (!allowed) return "";
  return browserSupportMessage(browser)
    || capabilityStatusLabel(browser?.status, "We'll look for a supported browser when you connect.");
}

function browserRelatedMessage(value) {
  return /\b(browser|chromium|chrome|playwright|webdriver|safari|edge|brave|opera|vivaldi)\b/i.test(String(value || ""));
}

function hostAccessActionMessage(config = {}, runtime = {}) {
  const gateway = runtime?.gateway || {};
  const browser = gateway?.status?.browser || {};
  const state = String(runtime?.state || "disconnected");
  const configured = config.configured === true && config.masterEnabled !== false;
  const browserAllowed = configured && config.scopes?.browser === true;
  const computerSetup = computerUseSetupState(config, runtime);
  const messages = [];
  const runtimeMessage = String(runtime?.message || "").trim();
  const ignoredDisabledBrowserMessage = !browserAllowed && browserRelatedMessage(runtimeMessage);
  const add = (value) => {
    const raw = String(value || "").trim();
    const message = browserSupportNeedsRepair({ message: raw })
      ? browserSupportMessage({ message: raw })
      : raw;
    if (message && !messages.includes(message)) messages.push(message);
  };

  if (!ignoredDisabledBrowserMessage) add(runtimeMessage);
  const browserStatus = normalizeCapabilityStatus(browser?.status);
  if (
    browserAllowed &&
    browserStatus &&
    !["ready", "active", "persistent", "allow"].includes(browserStatus)
  ) {
    add(browserSupportMessage(browser));
    if (!messages.length && state === "needs_action") {
      add("Set up the selected browser to finish Browser access.");
    }
  }
  if (computerSetup.allowed && computerSetup.setupState !== "ready") {
    add(computerSetup.message);
    if (computerSetup.setupState === "checking") add(computerSetup.checkingMessage);
    if (!messages.length && state === "needs_action") add("Finish Computer Use setup below.");
  }
  if (!messages.length && state === "needs_action" && !ignoredDisabledBrowserMessage) {
    add("Finish the required Host access setup below.");
  }
  if (!messages.length && state === "error") add("Host access could not connect. Retry to check again.");
  return messages.join(" ");
}

function browserOptions(browser = {}, selected = "") {
  const options = [{ value: "", label: "Automatic detection" }];
  for (const candidate of Array.isArray(browser?.available_browsers) ? browser.available_browsers : []) {
    const value = String(candidate?.browser_id || candidate?.id || candidate?.cdp_endpoint || "");
    if (!value || options.some((entry) => entry.value === value)) continue;
    const label = String(candidate?.browser_label || candidate?.label || candidate?.profile_label || candidate?.browser_family || value);
    options.push({ value, label });
  }
  if (selected && !options.some((entry) => entry.value === selected)) {
    options.push({ value: selected, label: selected });
  }
  return options.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
}

function browserSetupHint(browser = {}) {
  const available = Array.isArray(browser?.available_browsers) ? browser.available_browsers : [];
  const selected = browser?.browser_family || browser?.browser_id
    || (available.length === 1 ? available[0]?.family || available[0]?.browser_family || available[0]?.id || available[0]?.browser_id : "");
  if (/^safari(?::|$)/i.test(String(selected || ""))) {
    return "In Safari > Settings > Advanced, turn on ‘Show features for web developers’. Then open Developer, turn on ‘Allow remote automation’, and click Set up browser again.";
  }
  const hasDebuggingEndpoint = Boolean(String(browser?.cdp_endpoint || "").trim())
    || available.some((candidate) => Boolean(String(candidate?.cdp_endpoint || "").trim()));
  if (!hasDebuggingEndpoint && available.length === 0) {
    return "Install Chrome, Chromium, Edge, Brave, Opera, or Vivaldi on this computer, then click Set up browser again.";
  }
  return hasDebuggingEndpoint
    ? ""
    : "Open Chrome or Chromium at chrome://inspect/#remote-debugging, Edge at edge://inspect/#remote-debugging, or Opera at opera://inspect/#remote-debugging. Brave and Vivaldi are supported too. Turn on ‘Allow remote debugging for this browser instance,’ then click Set up browser again.";
}

function watchBrowserSetupFailure(tabId) {
  let timeoutId = 0;
  const stop = () => {
    window.clearTimeout(timeoutId);
    window.removeEventListener("dm:state", onState);
  };
  const onState = (event) => {
    const tab = event?.detail?.instanceTabs?.tabs?.find((candidate) => candidate?.id === tabId);
    if (tab?.hostAccess?.code !== "GATEWAY_COMMAND_FAILED") return;
    window.toastFrontendInfo?.(browserSetupHint(), "Set up browser", 12, "dm-host-browser-setup");
    stop();
  };
  window.addEventListener("dm:state", onState);
  timeoutId = window.setTimeout(stop, 30000);
}

function closeDialog(dialog) {
  dialog?.__hostAccessCleanup?.();
  dialog?.remove();
  window.dockerManagerActions?.syncInstanceTabBounds?.();
}

function openHostAccessDialog(tab, state = window.__dmLastState || {}) {
  if (!instanceKey(tab)) return false;
  closeDialog(document.getElementById("hostAccessDialog"));
  const config = configForTarget(state, tab);
  const runtime = tab.hostAccess || {};
  const gateway = runtime.gateway || {};
  const details = gateway.status || {};
  let browser = details.browser || {};
  const computer = details.computer_use || {};
  const stateName = String(runtime.state || "disconnected");
  const reconnectAvailable = runtime.suppressed === true;
  const disconnectAvailable = !reconnectAvailable && (runtime.connected === true || stateName === "connecting");
  const disconnectedWithoutTab = !tab.id && stateName === "disconnected";
  const configured = config.configured && config.masterEnabled;
  const browserAllowed = configured && config.scopes.browser === true;
  let computerSetup = computerUseSetupState(config, runtime);
  const actionMessage = hostAccessActionMessage(config, runtime);
  const browserReadiness = capabilityReadinessLabel(browserAllowed, browser);
  const browserDetail = browserSupportDetail(browserAllowed, browser);
  const canArmComputer = !computerSetup.setupSupported && computerUseNeedsArm(computer.status);
  const connectionLabel = disconnectedWithoutTab && configured ? "Ready to connect" : statusLabel(stateName);
  const connectionDetail = disconnectedWithoutTab
    ? configured ? "Open this Instance in a Launcher tab to connect." : "Host access is off."
    : runtime.hostLabel || gateway.host_label || "This computer";
  const connectionAction = reconnectAvailable
    ? '<button class="button confirm dm-host-access-connection-action" type="button" data-reconnect>Reconnect</button>'
    : disconnectAvailable
      ? '<button class="button dm-host-access-connection-action" type="button" data-disconnect>Disconnect</button>'
      : "";
  const compatibility = runtime.code === "CLI_UPDATE_REQUIRED"
    ? "Launcher setup needs attention"
    : ["CORE_UPDATE_REQUIRED", "CONTRACT_MISMATCH", "PLUGIN_MISSING"].includes(runtime.code)
      ? "Update Launcher or Agent Zero to use Host access"
      : runtime.code === "AUTH_REQUIRED"
        ? "Sign in to this Instance"
        : stateName === "connected" || stateName === "paused" || stateName === "needs_action"
          ? "Ready"
          : "Checked when you connect";
  const folderLocked = config.folderSource === "instance_workspace";
  const dialog = document.createElement("div");
  dialog.id = "hostAccessDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.innerHTML = `
    <form class="dm-dialog dm-host-access-dialog" role="dialog" aria-modal="true" aria-labelledby="hostAccessDialogTitle">
      <div class="dm-dialog-header">
        <div>
          <div class="dm-host-access-kicker">${escapeHtml(tab.title || "Agent Zero")}</div>
          <h2 id="hostAccessDialogTitle" class="dm-dialog-title">Host access</h2>
        </div>
        <button class="button dm-dialog-close" type="button" data-close aria-label="Close">×</button>
      </div>
      <div class="dm-dialog-body">
        <div class="dm-host-access-summary">
          <span class="dm-host-status-dot ${escapeHtml(stateName)}" aria-hidden="true"></span>
          <div><strong data-host-connection-label>${escapeHtml(connectionLabel)}</strong><small data-host-connection-detail>${escapeHtml(connectionDetail)}</small></div>
          ${connectionAction}
        </div>
        <div class="dm-host-access-notice ${stateName === "error" ? "error" : ""}" data-host-action-notice${actionMessage ? "" : " hidden"}>${escapeHtml(actionMessage)}</div>
        ${scopeFieldsHtml("hostAccessInstance", config.scopes, {
          masterContent: switchLineHtml(
            "hostAccessConfigured",
            "All permissions",
            "Master switch",
            configured
          ),
          detailsContent: `<div class="dm-field">
            <label for="hostAccessFolder">Folder for files and commands</label>
            <div class="dm-host-folder-row">
              <input id="hostAccessFolder" class="dm-text-input" type="text" readonly value="${escapeHtml(config.folder)}" placeholder="Choose a folder on this computer" data-host-config-control data-host-locked="${folderLocked}">
              <button class="button" type="button" data-choose-folder data-host-config-control data-host-locked="${folderLocked}"${folderLocked ? " disabled" : ""}>Choose</button>
            </div>
            <div class="dm-field-hint">${folderLocked ? "Using this Instance's workspace. Agent Zero reads and writes files here. Commands start here but can reach other folders on this computer." : "Agent Zero reads and writes files here. Commands start here but can reach other folders on this computer."}</div>
          </div>`
        })}
        <details class="dm-advanced dm-host-access-advanced">
          <summary>Advanced settings <span>Browser and connection details</span></summary>
          <div class="dm-advanced-body">
            <div class="dm-field">
              <label for="hostAccessBrowser">Browser to use</label>
              <select id="hostAccessBrowser" class="dm-select" data-host-config-control>${browserOptions(browser, config.browserSelection)}</select>
              <div class="dm-field-hint" data-browser-support-message${browserDetail ? "" : " hidden"}>${escapeHtml(browserDetail)}</div>
            </div>
            <div class="dm-host-access-diagnostics">
              <div><span>Connection</span><strong>${escapeHtml(compatibility)}</strong></div>
              <div><span>Browser</span><strong data-browser-readiness>${escapeHtml(browserReadiness)}</strong></div>
              <div><span>Computer Use</span><strong data-computer-use-readiness>${escapeHtml(computerSetup.label)}</strong></div>
            </div>
          </div>
        </details>
      </div>
      <div class="dm-dialog-footer dm-host-access-footer">
        <div class="dm-dialog-footer-group">
          ${runtime.retryable || ["error", "needs_action"].includes(stateName) ? '<button class="button" type="button" data-retry>Retry</button>' : ""}
          <button class="button" type="button" data-prepare-browser${browserAllowed && browserSetupAvailable(browser) ? "" : " hidden"}>Set up browser</button>
          <button class="button" type="button" data-setup-computer${computerSetup.canSetup && !computerSetup.restartRequired ? "" : " hidden"}>${escapeHtml(computerSetup.actionLabel)}</button>
          <button class="button confirm" type="button" data-restart-computer${computerSetup.restartRequired ? "" : " hidden"}>Restart Launcher</button>
          ${canArmComputer ? '<button class="button" type="button" data-rearm>Allow Computer Use</button>' : ""}
        </div>
        <div class="dm-dialog-footer-group">
          <button class="button" type="button" data-close>Cancel</button>
          <button class="button confirm" type="submit">Save</button>
        </div>
      </div>
    </form>`;
  const folder = dialog.querySelector("#hostAccessFolder");
  bindScopeDependency(dialog);
  bindHostAccessState(dialog, {
    configuredSelector: "#hostAccessConfigured"
  });
  const configuredInput = dialog.querySelector("#hostAccessConfigured");
  const browserInput = dialog.querySelector('[data-host-scope="browser"]');
  const browserLabel = dialog.querySelector("[data-browser-readiness]");
  const browserSupport = dialog.querySelector("[data-browser-support-message]");
  const browserSetupButton = dialog.querySelector("[data-prepare-browser]");
  const browserAllowedInForm = () => configuredInput?.checked === true && browserInput?.checked === true;
  const syncBrowserPresentation = () => {
    const allowed = browserAllowedInForm();
    const detail = browserSupportDetail(allowed, browser);
    if (browserLabel) browserLabel.textContent = capabilityReadinessLabel(allowed, browser);
    if (browserSupport) {
      browserSupport.textContent = detail;
      browserSupport.hidden = !detail;
    }
    if (browserSetupButton) {
      browserSetupButton.hidden = !(allowed && browserSetupAvailable(browser));
    }
  };
  configuredInput?.addEventListener("change", syncBrowserPresentation);
  browserInput?.addEventListener("change", syncBrowserPresentation);
  syncBrowserPresentation();
  if (disconnectedWithoutTab) {
    const syncConnectionCopy = () => {
      const enabled = configuredInput?.checked === true;
      dialog.querySelector("[data-host-connection-label]").textContent = enabled ? "Ready to connect" : "Disconnected";
      dialog.querySelector("[data-host-connection-detail]").textContent = enabled
        ? "Open this Instance in a Launcher tab to connect."
        : "Host access is off.";
    };
    configuredInput?.addEventListener("change", syncConnectionCopy);
    syncConnectionCopy();
  }
  dialog.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeDialog(dialog)));
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  dialog.querySelector("[data-choose-folder]")?.addEventListener("click", () => chooseFolder(folder));
  dialog.querySelector("[data-disconnect]")?.addEventListener("click", async () => {
    if (await window.dockerManagerActions?.hostGatewayCommand?.(tab.id, "disconnect") !== false) closeDialog(dialog);
  });
  dialog.querySelector("[data-reconnect]")?.addEventListener("click", async () => {
    if (await window.dockerManagerActions?.hostGatewayCommand?.(tab.id, "reconnect") !== false) closeDialog(dialog);
  });
  dialog.querySelector("[data-retry]")?.addEventListener("click", () => window.dockerManagerActions?.retryHostGateway?.(tab.id));
  dialog.querySelector("[data-prepare-browser]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const hint = browserSetupHint(browser);
    if (hint) window.toastFrontendInfo?.(hint, "Set up browser", 12, "dm-host-browser-setup");
    else watchBrowserSetupFailure(tab.id);
    const repairing = browserSupportNeedsRepair(browser);
    if (repairing) {
      button.disabled = true;
      const notice = dialog.querySelector("[data-host-action-notice]");
      if (notice) {
        notice.textContent = "Installing browser support…";
        notice.hidden = false;
      }
    }
    await window.dockerManagerActions?.hostGatewayCommand?.(tab.id, "prepare_browser");
    if (dialog.isConnected) button.disabled = false;
  });
  dialog.querySelector("[data-rearm]")?.addEventListener("click", () => window.dockerManagerActions?.hostGatewayCommand?.(tab.id, "rearm_computer_use"));
  dialog.querySelector("[data-setup-computer]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.hidden = true;
    const readiness = dialog.querySelector("[data-computer-use-readiness]");
    const notice = dialog.querySelector("[data-host-action-notice]");
    if (readiness) readiness.textContent = "Allowed · Checking";
    if (notice) {
      notice.textContent = computerSetup.checkingMessage;
      notice.hidden = false;
    }
    const result = await window.dockerManagerActions?.hostGatewayCommand?.(
      tab.id,
      "setup_computer_use",
      { prompt: computerSetup.prompt }
    );
    if (result === false && dialog.isConnected) {
      button.disabled = false;
      button.hidden = false;
    }
  });
  dialog.querySelector("[data-restart-computer]")?.addEventListener("click", () => {
    window.dockerManagerActions?.hostGatewayCommand?.(tab.id, "restart_computer_use");
  });
  dialog.querySelector("form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const enabled = configuredInput?.checked === true;
    const saved = await window.dockerManagerActions?.setInstanceHostAccess?.(tab, {
      configured: enabled,
      masterEnabled: enabled,
      folder: folder?.value || "",
      scopes: readScopes(dialog),
      browserSelection: dialog.querySelector("#hostAccessBrowser")?.value || ""
    });
    if (saved !== false) closeDialog(dialog);
  });
  document.body.appendChild(dialog);
  const onState = (event) => {
    if (!dialog.isConnected) return;
    const nextState = event?.detail || {};
    const nextTab = nextState?.instanceTabs?.tabs?.find((candidate) => candidate?.id === tab.id);
    if (!nextTab) return;
    const nextConfig = configForTarget(nextState, nextTab);
    const nextRuntime = nextTab.hostAccess || {};
    const nextGateway = nextRuntime.gateway || {};
    const nextBrowser = nextGateway.status?.browser || {};
    browser = nextBrowser;
    const nextComputerSetup = computerUseSetupState(nextConfig, nextRuntime);
    computerSetup = nextComputerSetup;
    const nextActionMessage = hostAccessActionMessage(nextConfig, nextRuntime);
    const nextStateName = String(nextRuntime.state || "disconnected");
    const computerLabel = dialog.querySelector("[data-computer-use-readiness]");
    const connectionLabelElement = dialog.querySelector("[data-host-connection-label]");
    const connectionDetailElement = dialog.querySelector("[data-host-connection-detail]");
    const statusDot = dialog.querySelector(".dm-host-status-dot");
    const notice = dialog.querySelector("[data-host-action-notice]");
    const setupButton = dialog.querySelector("[data-setup-computer]");
    const restartButton = dialog.querySelector("[data-restart-computer]");
    if (computerLabel) computerLabel.textContent = nextComputerSetup.label;
    if (connectionLabelElement) connectionLabelElement.textContent = statusLabel(nextStateName);
    if (connectionDetailElement) {
      connectionDetailElement.textContent = nextRuntime.hostLabel || nextGateway.host_label || "This computer";
    }
    if (statusDot) statusDot.className = `dm-host-status-dot ${nextStateName}`;
    syncBrowserPresentation();
    if (notice) {
      notice.textContent = nextActionMessage;
      notice.hidden = !nextActionMessage;
      notice.classList?.toggle("error", nextStateName === "error");
    }
    if (setupButton) {
      setupButton.textContent = nextComputerSetup.actionLabel;
      setupButton.hidden = !nextComputerSetup.canSetup || nextComputerSetup.restartRequired;
      setupButton.disabled = nextComputerSetup.setupState === "checking";
    }
    if (restartButton) restartButton.hidden = !nextComputerSetup.restartRequired;
  };
  window.addEventListener("dm:state", onState);
  dialog.__hostAccessCleanup = () => window.removeEventListener("dm:state", onState);
  window.dockerManagerActions?.hideInstanceTabView?.();
  window.setTimeout(() => dialog.querySelector("#hostAccessConfigured")?.focus(), 0);
  return true;
}

export {
  browserSetupAvailable,
  browserSupportDetail,
  browserSupportMessage,
  configForTarget,
  capabilityStatusLabel,
  capabilityReadinessLabel,
  computerUseNeedsArm,
  computerUseSetupState,
  hostAccessActionMessage,
  gatewaySupportsComputerUseSetup,
  normalizeConfig,
  normalizeScopes,
  openHostAccessDialog,
  readScopes,
  scopeFieldsHtml,
  bindScopeDependency,
  bindHostAccessState,
  browserSetupHint,
  watchBrowserSetupFailure,
  switchLineHtml
};
