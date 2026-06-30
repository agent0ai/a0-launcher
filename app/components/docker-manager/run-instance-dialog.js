import {
  ADVANCED_INSTANCE_MODEL_SLOTS,
  PRIMARY_INSTANCE_MODEL_SLOTS,
  bindInstanceDefaultProviderPlaceholderSync,
  buildInstanceEnvText,
  defaultInstanceName,
  instanceModelRowsHtml,
  normalizeInstanceDefaults,
  readInstanceDefaultsFromForm
} from "./instance-defaults.js";

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

function escapeAttribute(value) {
  return escapeHtml(value);
}

function cleanEnvValue(value, maxLength = 4096) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function envKeyFromLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return "";
  const idx = trimmed.indexOf("=");
  return idx > 0 ? trimmed.slice(0, idx).trim() : "";
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

function parseReleaseTagParts(tag) {
  const normalized = String(tag || "").trim().replace(/^v/, "");
  const match = normalized.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0)
  };
}

function compareReleaseTags(a, b) {
  const aParts = parseReleaseTagParts(a);
  const bParts = parseReleaseTagParts(b);
  if (!aParts && !bParts) return 0;
  if (!aParts) return 1;
  if (!bParts) return -1;
  if (aParts.major !== bParts.major) return bParts.major - aParts.major;
  if (aParts.minor !== bParts.minor) return bParts.minor - aParts.minor;
  if (aParts.patch !== bParts.patch) return bParts.patch - aParts.patch;
  return 0;
}

function normalizeDate(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? t : null;
}

function tagFromImageRef(value) {
  const raw = String(value || "").trim();
  if (!raw || !raw.includes(":")) return "";
  return raw.slice(raw.lastIndexOf(":") + 1);
}

function isLatestEntry(entry) {
  return entry?.tag === "latest";
}

function isReadyEntry(entry) {
  return entry?.tag === "ready";
}

function isTestingEntry(entry) {
  return entry?.tag === "testing";
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
    publishedAt: entry.publishedAt || null,
    updatedAt: entry.updatedAt || null,
    createdAt: entry.createdAt || null,
    imageRef: entry.imageRef || ""
  };
}

function installedVersionChoices(state = {}) {
  const choices = [];
  const seen = new Set();
  const addChoice = (entry) => {
    const choice = normalizeVersionChoice(entry);
    if (!choice || seen.has(choice.tag) || isTestingEntry(choice)) return;
    if (!isInstalledRunEntry(choice)) return;
    seen.add(choice.tag);
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
      publishedAt: version?.publishedAt || null,
      updatedAt: version?.updatedAt || null
    });
  }

  const images = Array.isArray(state?.images) ? state.images : [];
  for (const image of images) {
    const tag = String(image?.tag || tagFromImageRef(image?.imageRef) || "").trim();
    addChoice({
      tag,
      title: tag || image?.imageRef || "",
      availability: "installed",
      category: image?.category || "local_build",
      isActive: !!image?.isActive,
      imageRef: image?.imageRef || "",
      createdAt: image?.createdAt || null
    });
  }

  return choices.sort(installedVersionSort);
}

function progressPresentedAsToast(progress = null) {
  return typeof progress?.presentation === "string" && progress.presentation.trim() === "toast";
}

function createLocalInstanceButtonModel(state = {}) {
  const choices = installedVersionChoices(state);
  const operationRunning = state?.progress?.status === "running" && !progressPresentedAsToast(state.progress);
  if (!choices.length) {
    return {
      disabled: true,
      title: "Install a version before creating a local Instance"
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
    title: "Create a local Instance from an installed version"
  };
}

function versionOptionsHtml(choices, selectedTag) {
  return choices.map((choice) => {
    const label = choice.imageRef && choice.category === "local_build"
      ? `${choice.title} - local`
      : choice.title;
    return `<option value="${escapeAttribute(choice.tag)}"${choice.tag === selectedTag ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
}

function selectedChoiceFromDialog(dialog, fallbackEntry) {
  const select = dialog?.querySelector?.("#activateInstanceVersion");
  const selectedTag = String(select?.value || "").trim();
  if (!selectedTag) return fallbackEntry || null;
  return {
    ...(fallbackEntry || {}),
    tag: selectedTag,
    title: select?.selectedOptions?.[0]?.textContent || selectedTag
  };
}

function openRunInstanceDialog({ entry, state, versionChoices = null, includeVersionPicker = false, title = "Run instance", submitLabel = "Run" } = {}) {
  const existing = document.getElementById("activateInstanceDialog");
  if (existing) existing.remove();

  const choices = Array.isArray(versionChoices) && versionChoices.length
    ? versionChoices
    : entry?.tag
      ? [entry]
      : [];
  const initialEntry = entry?.tag ? entry : choices[0] || null;
  const initialTag = initialEntry?.tag || "";
  if (!initialTag) {
    window.toastFrontendError?.("Choose an installed version before creating an Instance.", "Agent Zero");
    return false;
  }

  const instanceDefaults = normalizeInstanceDefaults(state?.instanceDefaults);
  const dialog = document.createElement("div");
  dialog.id = "activateInstanceDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.setAttribute("role", "presentation");

  const versionField = includeVersionPicker ? `
        <div class="dm-field">
          <label for="activateInstanceVersion">Installed version</label>
          <select id="activateInstanceVersion" class="dm-select">
            ${versionOptionsHtml(choices, initialTag)}
          </select>
          <div class="dm-field-hint">Only installed Agent Zero images are shown.</div>
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
        <div class="dm-field dm-model-defaults">
          <div class="dm-field-label">Choose your models</div>
          <div class="dm-model-grid">
            ${instanceModelRowsHtml(PRIMARY_INSTANCE_MODEL_SLOTS, instanceDefaults, "activate")}
          </div>
          <div class="dm-field-hint">Using a subscription-based provider? Leave the defaults and connect the subscription during onboarding in the Agent Zero Web UI.</div>
        </div>
        <details class="dm-advanced">
          <summary>Advanced</summary>
          <div class="dm-advanced-body">
            <div class="dm-field dm-model-defaults">
              <div class="dm-field-label">Embedding model</div>
              <div class="dm-model-grid">
                ${instanceModelRowsHtml(ADVANCED_INSTANCE_MODEL_SLOTS, instanceDefaults, "activate")}
              </div>
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
              <textarea id="activateEnvVars" class="dm-textarea" spellcheck="false" placeholder="A0_SET__model_config__chat_model__provider=openrouter&#10;A0_SET__model_config__chat_model__name=anthropic/claude-sonnet-4.6&#10;API_KEY_OPENROUTER=sk-..."></textarea>
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
  const nameInput = dialog.querySelector("#activateInstanceName");
  const portInput = dialog.querySelector("#activatePortMappings");
  const storageModeInput = dialog.querySelector("#activateStorageMode");
  const storageHostRootInput = dialog.querySelector("#activateStorageHostRoot");
  const storageVolumeNameInput = dialog.querySelector("#activateStorageVolumeName");
  const envInput = dialog.querySelector("#activateEnvVars");
  let nameDirty = false;
  let storageHostDirty = false;
  const defaultHostRoot = state?.storagePreferences?.hostRoot || "~/agent-zero";

  bindInstanceDefaultProviderPlaceholderSync(dialog, "activate");
  if (nameInput) nameInput.value = defaultInstanceName(initialTag, state);
  if (portInput) portInput.value = "0:80";
  if (storageHostRootInput) storageHostRootInput.value = directWorkspaceFolder(defaultHostRoot, nameInput?.value || "");
  const syncStorageFields = () => {
    const visibility = storageFieldVisibility(storageModeInput?.value);
    const hostField = dialog.querySelector("#activateStorageHostRootField");
    const volumeField = dialog.querySelector("#activateStorageVolumeNameField");
    if (hostField) hostField.hidden = !visibility.hostRoot;
    if (volumeField) volumeField.hidden = !visibility.volumeName;
    if (!storageHostDirty && storageHostRootInput) {
      storageHostRootInput.value = directWorkspaceFolder(defaultHostRoot, nameInput?.value || "");
    }
  };
  storageHostRootInput?.addEventListener("input", () => { storageHostDirty = true; });
  storageModeInput?.addEventListener("change", syncStorageFields);
  syncStorageFields();
  nameInput?.addEventListener("input", () => {
    nameDirty = true;
    if (!storageHostDirty) syncStorageFields();
  });
  versionInput?.addEventListener("change", () => {
    if (!nameInput || nameDirty) return;
    nameInput.value = defaultInstanceName(versionInput.value, state);
    if (!storageHostDirty) syncStorageFields();
  });

  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selectedEntry = selectedChoiceFromDialog(dialog, initialEntry);
    const tag = selectedEntry?.tag || "";
    if (!tag) {
      window.toastFrontendError?.("Choose an installed version before creating an Instance.", "Agent Zero");
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
      instanceName: nameInput?.value || "",
      portMappings: portInput?.value || "0:80",
      envText,
      dataLossAck: "proceed_without_backup"
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
    const defaultsSaved = await window.dockerManagerActions?.setInstanceDefaults?.(instanceDefaults, { quiet: true });
    if (defaultsSaved === false) return;
    closeDialog(dialog);
    await window.dockerManagerActions?.activateTag?.(tag, options);
  });

  document.body.appendChild(dialog);
  window.setTimeout(() => nameInput?.focus(), 0);
  return true;
}

function openCreateLocalInstanceDialog(state = {}) {
  const choices = installedVersionChoices(state);
  if (!choices.length) {
    window.toastFrontendError?.("Install a version before creating a local Instance.", "Agent Zero");
    return false;
  }
  return openRunInstanceDialog({
    entry: choices[0],
    state,
    versionChoices: choices,
    includeVersionPicker: true,
    title: "Create local Instance",
    submitLabel: "Create"
  });
}

export {
  authEnvLinesFromValues,
  createLocalInstanceButtonModel,
  directWorkspaceFolder,
  installedVersionChoices,
  mergeGeneratedEnvText,
  openCreateLocalInstanceDialog,
  openRunInstanceDialog,
  storageFieldVisibility,
  storageOverrideFromChoice
};
