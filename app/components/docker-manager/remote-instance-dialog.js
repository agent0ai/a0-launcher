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

function openAddRemoteInstanceDialog(options = {}) {
  const existing = document.getElementById("remoteInstanceDialog");
  if (existing) existing.remove();

  let completed = false;
  const title = optionText(options.title, "Add remote Instance");
  const submitLabel = optionText(options.submitLabel, "Add Instance");
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
      <div class="dm-dialog-body">
        ${dialogIntroHtml(options.intro)}
        <div class="dm-field">
          <label for="remoteInstanceUrl">Instance URL</label>
          <input id="remoteInstanceUrl" class="dm-text-input" type="text" inputmode="url" autocomplete="url" placeholder="https://agent-zero.example.com">
          <div class="dm-field-hint">Use the URL where this Agent Zero Instance is already running. If no protocol is entered, the launcher will use http://.</div>
        </div>
        <div class="dm-field">
          <label for="remoteInstanceName">Display name</label>
          <input id="remoteInstanceName" class="dm-text-input" type="text" maxlength="80" autocomplete="off" placeholder="Remote Instance">
          <div class="dm-field-hint">Optional. This is only the friendly name shown in Instances.</div>
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

  const cancel = () => {
    closeDialog(dialog);
    if (!completed) options.onCancel?.();
  };

  urlInput?.addEventListener("input", () => {
    if (!nameInput || nameInput.dataset.dirty) return;
    nameInput.value = defaultRemoteName(urlInput.value);
  });
  nameInput?.addEventListener("input", () => {
    nameInput.dataset.dirty = "1";
  });

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
    const result = await window.dockerManagerActions?.addRemoteInstance?.({
      url,
      name: nameInput?.value || ""
    });
    if (!result) return;
    completed = true;
    closeDialog(dialog);
    await options.onAdded?.(result);
  });

  document.body.appendChild(dialog);
  window.setTimeout(() => urlInput?.focus(), 0);
}

export {
  openAddRemoteInstanceDialog
};
