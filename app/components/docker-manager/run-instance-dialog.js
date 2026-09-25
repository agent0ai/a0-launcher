import {
  ADVANCED_INSTANCE_MODEL_SLOTS,
  PRIMARY_INSTANCE_MODEL_SLOTS,
  bindInstanceDefaultProviderPlaceholderSync,
  buildInstanceEnvText,
  defaultInstanceName,
  envKeyFromLine,
  instanceModelRowsHtml,
  normalizeInstanceDefaults,
  readInstanceDefaultsFromForm
} from "./instance-defaults.js";
import {
  bindHostAccessState,
  bindScopeDependency,
  normalizeConfig as normalizeHostAccessConfig,
  readScopes as readHostAccessScopes,
  scopeFieldsHtml as hostAccessScopeFieldsHtml,
  switchLineHtml as hostAccessSwitchLineHtml
} from "./host-access-dialog.js";
import { closeDialog, escapeHtml } from "./component-utils.js";
import { progressPresentedAsToast } from "./progress-eta.js";
import { compareReleaseTags, isLatestEntry, isReadyEntry, isTestingEntry, normalizeDate } from "./release-entries.js";

function escapeAttribute(value) {
  return escapeHtml(value);
}

function cleanEnvValue(value, maxLength = 4096) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function mergeGeneratedEnvText(generatedLines, userText) {
  const userLines = String(userText || "").split(/\r?\n/);
  const userKeys = new Set(userLines.map(envKeyFromLine).filter(Boolean));
  const generated = (Array.isArray(generatedLines) ? generatedLines : [])
    .filter((line) => line && !userKeys.has(envKeyFromLine(line)));
  const userBlock = userLines.join("\n").trim();
  if (!generated.length) return userBlock;
  if (!userBlock) return generated.join("\n");
  return `${generated.join("\n")}\n\n${userBlock}`;
}

function authEnvLinesFromValues(values = {}) {
  const username = cleanEnvValue(values.username, 256);
  const password = cleanEnvValue(values.password, 4096);
  const lines = [];
  if (username) lines.push(`AUTH_LOGIN=${username}`);
  if (password) lines.push(`AUTH_PASSWORD=${password}`);
  return lines;
}

function storageOverrideFromChoice(value) {
  const choice = String(value || "").trim();
  if (choice === "host_directory_exact") {
    return { storageMode: "host_directory", hostPathMode: "exact" };
  }
  if (choice === "host_directory") {
    return { storageMode: "host_directory", hostPathMode: "per_instance" };
  }
  if (choice === "named_volume") {
    return { storageMode: "named_volume" };
  }
  return null;
}

function storageFieldVisibility(value) {
  const choice = String(value || "").trim();
  return {
    hostRoot: choice === "host_directory_exact",
    volumeName: choice === "named_volume"
  };
}

function cleanFolderSegment(value, fallback = "agent-zero") {
  return String(value || "")
    .trim()
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\\/]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 80) || fallback;
}

function directWorkspaceFolder(root, instanceName) {
  const base = String(root || "~/agent-zero").trim().replace(/[\\/]+$/g, "") || "~/agent-zero";
  return `${base}/${cleanFolderSegment(instanceName)}`;
}

function isChannelVersionChoice(entry = {}) {
  return isLatestEntry(entry) || isReadyEntry(entry);
}

function isInstalledRunEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.availability === "installing") return false;
  return !!entry.isActive ||
    entry.availability === "installed" ||
    entry.availability === "update_available" ||
    !!entry.differsFromPublished;
}

function installedVersionSort(left, right) {
  const leftLatest = isLatestEntry(left);
  const rightLatest = isLatestEntry(right);
  if (leftLatest && !rightLatest) return -1;
  if (!leftLatest && rightLatest) return 1;

  const leftReady = isReadyEntry(left);
  const rightReady = isReadyEntry(right);
  if (leftReady && !rightReady) return -1;
  if (!leftReady && rightReady) return 1;

  const tagCompare = compareReleaseTags(left?.tag, right?.tag);
  if (tagCompare !== 0) return tagCompare;

  const leftDate = normalizeDate(left?.publishedAt || left?.updatedAt || left?.createdAt);
  const rightDate = normalizeDate(right?.publishedAt || right?.updatedAt || right?.createdAt);
  if (leftDate !== null && rightDate !== null && leftDate !== rightDate) return rightDate - leftDate;
  if (leftDate !== null && rightDate === null) return -1;
  if (leftDate === null && rightDate !== null) return 1;

  return String(left?.tag || "").localeCompare(String(right?.tag || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function normalizeVersionChoice(entry = {}) {
  const tag = String(entry.tag || entry.id || "").trim();
  if (!tag) return null;
  return {
    tag,
    title: String(entry.title || entry.displayVersion || tag),
    availability: entry.availability || "installed",
    category: entry.category || "",
    isActive: !!entry.isActive,
    differsFromPublished: !!entry.differsFromPublished,
    installability: entry.installability || null,
    matchedReleaseTag: entry.matchedReleaseTag || "",
    publishedReleaseTag: entry.publishedReleaseTag || "",
    publishedAt: entry.publishedAt || null,
    updatedAt: entry.updatedAt || null,
    createdAt: entry.createdAt || null,
    imageRef: entry.imageRef || "",
    imageRepo: entry.imageRepo || "",
    isBackendImage: entry.isBackendImage !== false
  };
}

function installedVersionChoices(state = {}) {
  const choices = [];
  const seen = new Set();
  const addChoice = (entry) => {
    const choice = normalizeVersionChoice(entry);
    const key = choice?.isBackendImage === false ? choice.imageRef : choice?.tag;
    if (!choice || !key || seen.has(key) || isTestingEntry(choice)) return;
    if (choice.availability === "installing") return;
    if (isChannelVersionChoice(choice)) {
      if (choice.installability === "not_yet_available") return;
    } else if (!isInstalledRunEntry(choice)) {
      return;
    }
    seen.add(key);
    choices.push(choice);
  };

  const versions = Array.isArray(state?.versions) ? state.versions : [];
  for (const version of versions) {
    addChoice({
      tag: version?.id || "",
      title: version?.displayVersion || version?.id || "",
      availability: version?.availability || "available",
      category: version?.category || "",
      isActive: !!version?.isActive,
      differsFromPublished: !!version?.differsFromPublished,
      installability: version?.installability || null,
      matchedReleaseTag: version?.matchedReleaseTag || "",
      publishedReleaseTag: version?.publishedReleaseTag || "",
      publishedAt: version?.publishedAt || null,
      updatedAt: version?.updatedAt || null
    });
  }

  return choices.sort(installedVersionSort);
}

function createLocalInstanceButtonModel(state = {}) {
  const choices = installedVersionChoices(state);
  const operationRunning = state?.progress?.status === "running" && !progressPresentedAsToast(state.progress);
  if (!choices.length) {
    return {
      disabled: true,
      title: "Agent Zero versions are not ready yet"
    };
  }
  if (operationRunning) {
    return {
      disabled: true,
      title: "Another operation is running"
    };
  }
  return {
    disabled: false,
    title: "Create a local Instance"
  };
}

function versionOptionsHtml(choices, selectedTag) {
  return choices.map((choice) => {
    const value = choice.isBackendImage === false ? choice.imageRef : choice.tag;
    const label = choice.imageRef && choice.category === "local_build"
      ? `${choice.title} - local`
      : choice.title;
    return `<option value="${escapeAttribute(value)}"${choice.tag === selectedTag || value === selectedTag ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
}

function selectedChoiceFromDialog(dialog, fallbackEntry, choices = []) {
  const select = dialog?.querySelector?.("#activateInstanceVersion");
  const selectedTag = String(select?.value || "").trim();
  if (!selectedTag) return fallbackEntry || null;
  const found = (Array.isArray(choices) ? choices : []).find((choice) =>
    (choice?.isBackendImage === false ? choice?.imageRef : choice?.tag) === selectedTag
  );
  if (found) return found;
  return {
    ...(fallbackEntry || {}),
    tag: selectedTag,
    title: select?.selectedOptions?.[0]?.textContent || selectedTag
  };
}

function channelPullDefault(choice = null) {
  return isChannelVersionChoice(choice);
}

function channelPullOperationType(choice = null) {
  return isInstalledRunEntry(choice) ? "update" : "install";
}

function openRunInstanceDialog({ entry, state, versionChoices = null, includeVersionPicker = false, title = "Run instance", submitLabel = "Run", selectedTag = "" } = {}) {
  const existing = document.getElementById("activateInstanceDialog");
  if (existing) existing.remove();

  const choices = Array.isArray(versionChoices) && versionChoices.length
    ? versionChoices
    : entry?.tag
      ? [entry]
      : [];
  const selectedEntry = selectedTag ? choices.find((choice) => choice?.tag === selectedTag) : null;
  const initialEntry = selectedEntry || (entry?.tag ? entry : choices[0] || null);
  const initialTag = initialEntry?.tag || "";
  if (!initialTag) {
    window.toastFrontendError?.("Choose an installed version before creating an Instance.", "Agent Zero");
    return false;
  }

  const instanceDefaults = normalizeInstanceDefaults(state?.instanceDefaults);
  const hostAccessDefaults = normalizeHostAccessConfig(state?.hostAccess?.defaults, {}, "local");
  const dialog = document.createElement("div");
  dialog.id = "activateInstanceDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.setAttribute("role", "presentation");

  const versionField = includeVersionPicker ? `
        <div class="dm-field">
          <label for="activateInstanceVersion">Select version</label>
          <select id="activateInstanceVersion" class="dm-select">
            ${versionOptionsHtml(choices, initialTag)}
          </select>
          <div class="dm-field-hint">Choose a channel tag or an installed version.</div>
          <label id="activateChannelPullField" class="dm-checkbox-line dm-channel-pull-field hidden">
            <input id="activatePullChannel" type="checkbox">
            <span id="activatePullChannelLabel">Pull updates</span>
          </label>
          <div id="activateChannelPullHint" class="dm-field-hint hidden"></div>
        </div>
  ` : "";

  dialog.innerHTML = `
    <form class="dm-dialog" role="dialog" aria-modal="true" aria-labelledby="activateInstanceTitle">
      <div class="dm-dialog-header">
        <h2 id="activateInstanceTitle" class="dm-dialog-title">${escapeHtml(title)}</h2>
        <button class="button dm-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <div class="dm-dialog-body dm-run-instance-body">
        ${versionField}
        <div class="dm-field">
          <label for="activateInstanceName">Instance name</label>
          <input id="activateInstanceName" class="dm-text-input" type="text" maxlength="64" autocomplete="off">
          <div class="dm-field-hint">A friendly name shown in the launcher. The managed Docker name stays stable so rollback keeps working.</div>
        </div>
        <div class="dm-field">
          <div class="dm-field-label">Login</div>
          <div class="dm-inline-field-grid">
            <input id="activateAuthLogin" class="dm-text-input" type="text" autocomplete="username" placeholder="Username">
            <input id="activateAuthPassword" class="dm-text-input" type="password" autocomplete="new-password" placeholder="Password">
          </div>
          <div class="dm-field-hint">Optional. Leave blank to use Agent Zero defaults or finish login setup in the Web UI.</div>
          <label class="dm-checkbox-line">
            <input id="activateRememberCredentials" type="checkbox">
            <span>Save credentials</span>
          </label>
        </div>
        <div class="dm-field dm-host-access-setup">
          <div class="dm-field-label">Host access</div>
          ${hostAccessSwitchLineHtml(
            "activateHostAccessConfigured",
            "Allow this Instance to use this computer",
            "Access stays on with the Launcher while this Instance is open, either in a tab or detached window.",
            hostAccessDefaults.configured && hostAccessDefaults.masterEnabled
          )}
          <div data-launcher-host-options>
            ${hostAccessScopeFieldsHtml("activateHostAccess", hostAccessDefaults.scopes, {
              compact: true,
              detailsContent: `<div class="dm-field">
                <label for="activateHostAccessFolder">Folder for files and commands</label>
                <div class="dm-host-folder-row">
                  <input id="activateHostAccessFolder" class="dm-text-input" type="text" readonly value="${escapeAttribute(hostAccessDefaults.folder)}" placeholder="Choose a folder on this computer" data-host-config-control>
                  <button class="button" type="button" data-host-folder data-host-config-control>Choose</button>
                </div>
                <div id="activateHostAccessFolderHint" class="dm-field-hint">Using this Instance's workspace. Agent Zero reads and writes files here. Commands start here but can reach other folders on this computer.</div>
              </div>`
            })}
          </div>
        </div>
        <details class="dm-advanced">
          <summary>Advanced</summary>
          <div class="dm-advanced-body">
            <div class="dm-field dm-model-defaults">
              <div class="dm-field-label">Choose your models</div>
              <div class="dm-model-grid">
                ${instanceModelRowsHtml([...PRIMARY_INSTANCE_MODEL_SLOTS, ...ADVANCED_INSTANCE_MODEL_SLOTS], instanceDefaults, "activate")}
              </div>
              <div class="dm-field-hint">Using a subscription-based provider? Leave the defaults and connect the subscription during onboarding in the Agent Zero Web UI.</div>
            </div>
            <div class="dm-field">
              <label for="activatePortMappings">Port mapping</label>
              <textarea id="activatePortMappings" class="dm-textarea" spellcheck="false"></textarea>
              <div class="dm-field-hint">Use Docker-style host:container mappings. <strong>0:80</strong> lets Docker choose an open local host port for the Agent Zero UI.</div>
            </div>
            <div class="dm-field">
              <label for="activateStorageMode">Workspace storage</label>
              <select id="activateStorageMode" class="dm-text-input">
                <option value="host_directory">Create folder named after Instance</option>
                <option value="host_directory_exact">Choose custom folder</option>
                <option value="named_volume">Named Docker volume</option>
              </select>
            </div>
            <div id="activateStorageHostRootField" class="dm-field" hidden>
              <label for="activateStorageHostRoot">Folder</label>
              <input id="activateStorageHostRoot" class="dm-text-input" type="text" autocomplete="off" placeholder="~/agent-zero">
            </div>
            <div id="activateStorageVolumeNameField" class="dm-field" hidden>
              <label for="activateStorageVolumeName">Volume name</label>
              <input id="activateStorageVolumeName" class="dm-text-input" type="text" autocomplete="off" placeholder="optional exact Docker volume name">
            </div>
            <div class="dm-field">
              <label for="activateEnvVars">Environment variables</label>
              <textarea id="activateEnvVars" class="dm-textarea" spellcheck="false" placeholder="A0_SET__model_config__chat_model__provider=openrouter&#10;A0_SET__model_config__chat_model__name=openai/gpt-5.6-terra&#10;API_KEY_OPENROUTER=sk-..."></textarea>
              <div class="dm-field-hint">Agent Zero supports <strong>A0_SET_&lt;setting_name&gt;=&lt;value&gt;</strong> for initial defaults. Saved settings still take precedence, and restart is required for changes.</div>
            </div>
          </div>
        </details>
      </div>
      <div class="dm-dialog-footer">
        <button class="button" type="button" data-dialog-close>Cancel</button>
        <button class="button confirm" type="submit">${escapeHtml(submitLabel)}</button>
      </div>
    </form>
  `;

  const form = dialog.querySelector("form");
  const versionInput = dialog.querySelector("#activateInstanceVersion");
  const channelPullField = dialog.querySelector("#activateChannelPullField");
  const channelPullInput = dialog.querySelector("#activatePullChannel");
  const channelPullLabel = dialog.querySelector("#activatePullChannelLabel");
  const channelPullHint = dialog.querySelector("#activateChannelPullHint");
  const nameInput = dialog.querySelector("#activateInstanceName");
  const portInput = dialog.querySelector("#activatePortMappings");
  const storageModeInput = dialog.querySelector("#activateStorageMode");
  const storageHostRootInput = dialog.querySelector("#activateStorageHostRoot");
  const storageVolumeNameInput = dialog.querySelector("#activateStorageVolumeName");
  const envInput = dialog.querySelector("#activateEnvVars");
  const hostAccessConfiguredInput = dialog.querySelector("#activateHostAccessConfigured");
  const hostAccessOptions = dialog.querySelector("[data-launcher-host-options]");
  const hostAccessFolderInput = dialog.querySelector("#activateHostAccessFolder");
  const hostAccessFolderButton = dialog.querySelector("[data-host-folder]");
  const hostAccessFolderHint = dialog.querySelector("#activateHostAccessFolderHint");
  let nameDirty = false;
  let storageHostDirty = false;
  const defaultHostRoot = state?.storagePreferences?.hostRoot || "~/agent-zero";
  let hostAccessFallbackFolder = hostAccessDefaults.folder;
  let lastChannelPullTag = "";

  bindInstanceDefaultProviderPlaceholderSync(dialog, "activate");
  bindScopeDependency(dialog.querySelector(".dm-host-access-setup"));
  bindHostAccessState(dialog.querySelector(".dm-host-access-setup"), {
    configuredSelector: "#activateHostAccessConfigured"
  });
  hostAccessFolderButton?.addEventListener("click", async () => {
    const selected = await window.dockerManagerActions?.chooseHostAccessFolder?.(hostAccessFolderInput?.value || "");
    if (selected?.path && hostAccessFolderInput) {
      hostAccessFallbackFolder = selected.path;
      hostAccessFolderInput.value = selected.path;
    }
  });
  if (nameInput) nameInput.value = defaultInstanceName(initialTag, state);
  if (portInput) portInput.value = "0:80";
  if (storageHostRootInput) storageHostRootInput.value = directWorkspaceFolder(defaultHostRoot, nameInput?.value || "");
  const syncHostAccessFolder = () => {
    const hostAccessEnabled = hostAccessConfiguredInput?.checked === true;
    const usesWorkspace = storageModeInput?.value !== "named_volume";
    if (hostAccessOptions) hostAccessOptions.hidden = !hostAccessEnabled;
    if (hostAccessFolderInput) {
      hostAccessFolderInput.value = usesWorkspace
        ? storageModeInput?.value === "host_directory_exact"
          ? storageHostRootInput?.value || ""
          : directWorkspaceFolder(defaultHostRoot, nameInput?.value || "")
        : hostAccessFallbackFolder;
      hostAccessFolderInput.disabled = !hostAccessEnabled;
    }
    if (hostAccessFolderButton) {
      hostAccessFolderButton.disabled = usesWorkspace || !hostAccessEnabled;
    }
    if (hostAccessFolderHint) {
      hostAccessFolderHint.textContent = usesWorkspace
        ? "Using this Instance's workspace. Agent Zero reads and writes files here. Commands start here but can reach other folders on this computer."
        : "Agent Zero reads and writes files here. Commands start here but can reach other folders on this computer.";
    }
  };
  const syncStorageFields = () => {
    const visibility = storageFieldVisibility(storageModeInput?.value);
    const hostField = dialog.querySelector("#activateStorageHostRootField");
    const volumeField = dialog.querySelector("#activateStorageVolumeNameField");
    if (hostField) hostField.hidden = !visibility.hostRoot;
    if (volumeField) volumeField.hidden = !visibility.volumeName;
    if (!storageHostDirty && storageHostRootInput) {
      storageHostRootInput.value = directWorkspaceFolder(defaultHostRoot, nameInput?.value || "");
    }
    syncHostAccessFolder();
  };
  storageHostRootInput?.addEventListener("input", () => {
    storageHostDirty = true;
    syncHostAccessFolder();
  });
  hostAccessConfiguredInput?.addEventListener("change", syncHostAccessFolder);
  storageModeInput?.addEventListener("change", syncStorageFields);
  syncStorageFields();
  const syncChannelPull = () => {
    const choice = selectedChoiceFromDialog(dialog, initialEntry, choices);
    const tag = choice?.tag || "";
    const isChannel = isChannelVersionChoice(choice);
    if (channelPullField) channelPullField.classList.toggle("hidden", !isChannel);
    if (channelPullHint) channelPullHint.classList.toggle("hidden", !isChannel);
    if (!isChannel) {
      lastChannelPullTag = "";
      return;
    }
    if (channelPullLabel) channelPullLabel.textContent = `Pull updates from ${tag}`;
    if (channelPullHint) {
      channelPullHint.textContent = isInstalledRunEntry(choice)
        ? `Run the installed ${tag} image, or pull the channel tag before creating this Instance.`
        : `The ${tag} image is not installed yet. Pull it before creating this Instance.`;
    }
    if (channelPullInput && lastChannelPullTag !== tag) {
      channelPullInput.checked = channelPullDefault(choice);
      lastChannelPullTag = tag;
    }
  };
  syncChannelPull();
  nameInput?.addEventListener("input", () => {
    nameDirty = true;
    if (!storageHostDirty) syncStorageFields();
    else syncHostAccessFolder();
  });
  versionInput?.addEventListener("change", () => {
    const choice = selectedChoiceFromDialog(dialog, initialEntry, choices);
    if (nameInput && !nameDirty) nameInput.value = defaultInstanceName(choice?.tag || versionInput.value, state);
    if (!storageHostDirty) syncStorageFields();
    else syncHostAccessFolder();
    syncChannelPull();
  });

  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selectedEntry = selectedChoiceFromDialog(dialog, initialEntry, choices);
    const tag = selectedEntry?.tag || "";
    if (!tag) {
      window.toastFrontendError?.("Choose an installed version before creating an Instance.", "Agent Zero");
      return;
    }
    const shouldPullChannel = isChannelVersionChoice(selectedEntry) && channelPullInput?.checked === true;
    if (isChannelVersionChoice(selectedEntry) && !shouldPullChannel && !isInstalledRunEntry(selectedEntry)) {
      window.toastFrontendError?.(`Pull ${tag} before creating this Instance.`, "Agent Zero");
      return;
    }
    const instanceDefaults = readInstanceDefaultsFromForm(dialog, "activate");
    const envResult = buildInstanceEnvText(instanceDefaults, envInput?.value || "");
    if (!envResult.ok) {
      window.toastFrontendError?.(envResult.message, "Agent Zero");
      return;
    }
    const username = cleanEnvValue(dialog.querySelector("#activateAuthLogin")?.value || "", 256);
    const password = cleanEnvValue(dialog.querySelector("#activateAuthPassword")?.value || "", 4096);
    const rememberCredentials = dialog.querySelector("#activateRememberCredentials")?.checked === true;
    if (rememberCredentials && (!username || !password)) {
      window.toastFrontendError?.("Enter both username and password to save credentials.", "Agent Zero");
      return;
    }
    const envText = mergeGeneratedEnvText(authEnvLinesFromValues({ username, password }), envResult.value || "");
    const options = {
      imageRef: selectedEntry?.imageRef || "",
      instanceName: nameInput?.value || "",
      portMappings: portInput?.value || "0:80",
      envText,
      dataLossAck: "proceed_without_backup"
    };
    options.hostAccess = {
      configured: hostAccessConfiguredInput?.checked === true,
      masterEnabled: hostAccessConfiguredInput?.checked === true,
      folder: hostAccessFolderInput?.value || "",
      scopes: readHostAccessScopes(dialog.querySelector(".dm-host-access-setup")),
      browserSelection: hostAccessDefaults.browserSelection
    };
    if (rememberCredentials) {
      options.credentials = { username, password, remember: true };
    }
    const storageOverride = storageOverrideFromChoice(storageModeInput?.value);
    if (storageOverride) {
      options.storageMode = storageOverride.storageMode;
      if (storageOverride.hostPathMode) options.hostPathMode = storageOverride.hostPathMode;
      options.hostRoot = storageModeInput?.value === "host_directory_exact" ? storageHostRootInput?.value || "" : "";
      options.volumeName = storageModeInput?.value === "named_volume" ? storageVolumeNameInput?.value || "" : "";
    }
    if (options.hostAccess.configured && options.storageMode === "named_volume" && !options.hostAccess.folder) {
      window.toastFrontendError?.("Choose a folder for files and commands.", "Agent Zero");
      return;
    }
    const defaultsSaved = await window.dockerManagerActions?.setInstanceDefaults?.(instanceDefaults, { quiet: true });
    if (defaultsSaved === false) return;
    closeDialog(dialog);
    if (shouldPullChannel) {
      await window.dockerManagerActions?.runAfterPull?.(tag, options, channelPullOperationType(selectedEntry));
    } else {
      await window.dockerManagerActions?.activateTag?.(tag, options);
    }
  });

  document.body.appendChild(dialog);
  window.setTimeout(() => nameInput?.focus(), 0);
  return true;
}

function openCreateLocalInstanceDialog(state = {}, options = {}) {
  const selectedTag = String(options?.selectedTag || "").trim();
  let choices = installedVersionChoices(state);
  if (selectedTag && !choices.some((choice) => choice.tag === selectedTag)) {
    const selectedChoice = normalizeVersionChoice({
      tag: selectedTag,
      title: selectedTag,
      availability: "available"
    });
    if (selectedChoice && isChannelVersionChoice(selectedChoice)) choices = [selectedChoice, ...choices];
  }
  if (!choices.length) {
    window.toastFrontendError?.("Agent Zero versions are not ready yet.", "Agent Zero");
    return false;
  }
  const entry = selectedTag ? choices.find((choice) => choice.tag === selectedTag) || choices[0] : choices[0];
  return openRunInstanceDialog({
    entry,
    state,
    versionChoices: choices,
    includeVersionPicker: true,
    selectedTag,
    title: "Create local Instance",
    submitLabel: "Create"
  });
}

export {
  authEnvLinesFromValues,
  channelPullDefault,
  channelPullOperationType,
  createLocalInstanceButtonModel,
  directWorkspaceFolder,
  installedVersionChoices,
  isChannelVersionChoice,
  mergeGeneratedEnvText,
  openCreateLocalInstanceDialog,
  openRunInstanceDialog,
  storageFieldVisibility,
  storageOverrideFromChoice
};
