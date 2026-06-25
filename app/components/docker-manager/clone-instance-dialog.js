const CLONE_WORKSPACE_OPTIONS = Object.freeze([
  { id: "auth", label: "Auth", detail: "Web login, root and RFC passwords." },
  { id: "secrets", label: "Secrets and API keys", detail: "Provider keys, secrets.env and OAuth account state." },
  { id: "providers", label: "Provider/model configuration", detail: "Model presets and _model_config settings." },
  { id: "mcp", label: "MCPs", detail: "Client/server MCP settings and A2A toggle." },
  { id: "settings", label: "Settings and preferences", detail: "Timezone, workdir and variables." },
  { id: "agents", label: "Agent profiles", detail: "Files under /a0/usr/agents." },
  { id: "chats", label: "Chats", detail: "Saved conversations and message files." },
  { id: "skills", label: "Skills", detail: "Global user skills in /a0/usr/skills." },
  { id: "plugins", label: "Plugins", detail: "Custom plugin files except model and OAuth state." },
  { id: "projects", label: "Projects", detail: "Project folders, repositories and project metadata." },
  { id: "memory", label: "Memory and knowledge", detail: "Memory, knowledge, schedules and time travel data." },
  { id: "files", label: "Workspace files", detail: "Workdir, uploads, downloads and API files." }
]);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function closeDialog(dialog) {
  if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
}

function openCloneInstanceDialog(instance) {
  const existing = document.getElementById("cloneInstanceDialog");
  if (existing) existing.remove();

  const containerId = instance?.containerId || "";
  const displayName = instance?.instanceName || instance?.containerName || "this instance";
  const dialog = document.createElement("div");
  dialog.id = "cloneInstanceDialog";
  dialog.className = "dm-dialog-backdrop";
  dialog.setAttribute("role", "presentation");

  const optionRows = CLONE_WORKSPACE_OPTIONS.map((option) => `
    <label class="dm-clone-option">
      <input type="checkbox" name="cloneWorkspaceCategory" value="${escapeHtml(option.id)}" checked>
      <span class="dm-clone-option-copy">
        <span class="dm-clone-option-label">${escapeHtml(option.label)}</span>
        <span class="dm-clone-option-detail">${escapeHtml(option.detail)}</span>
      </span>
    </label>
  `).join("");

  dialog.innerHTML = `
    <form class="dm-dialog dm-clone-dialog" role="dialog" aria-modal="true" aria-labelledby="cloneInstanceTitle">
      <div class="dm-dialog-header">
        <h2 id="cloneInstanceTitle" class="dm-dialog-title">Clone instance</h2>
        <button class="button dm-dialog-close" type="button" data-dialog-close aria-label="Close">×</button>
      </div>
      <div class="dm-dialog-body">
        <p class="dm-dialog-copy">Create a new instance from <strong>${escapeHtml(displayName)}</strong> with its current /a0/usr workspace. The source pauses during the snapshot; resume any running AI work manually afterward.</p>
        <details class="dm-clone-details">
          <summary class="dm-clone-details-summary">
            <span class="dm-clone-details-label">Workspace copy</span>
            <span class="dm-clone-selection-summary" data-clone-selection-summary>Everything selected</span>
          </summary>
          <div class="dm-clone-details-body">
            <p class="dm-clone-details-copy">Everything is included by default. Clear categories only when you want a leaner clone; clear all to start with an empty /a0/usr.</p>
            <div class="dm-clone-toolbar">
              <button class="button" type="button" data-clone-select-all>Select all</button>
              <button class="button" type="button" data-clone-clear>Clear</button>
            </div>
            <div class="dm-clone-options">
              ${optionRows}
            </div>
          </div>
        </details>
      </div>
      <div class="dm-dialog-footer">
        <button class="button" type="button" data-dialog-close>Cancel</button>
        <button class="button confirm" type="submit" data-clone-submit>Clone</button>
      </div>
    </form>
  `;

  const form = dialog.querySelector("form");
  const boxes = () => [...dialog.querySelectorAll('input[name="cloneWorkspaceCategory"]')];
  const selectionSummary = dialog.querySelector("[data-clone-selection-summary]");
  const updateSelectionSummary = () => {
    if (!selectionSummary) return;
    const categoryBoxes = boxes();
    const selectedCount = categoryBoxes.filter((box) => box.checked).length;
    if (selectedCount === categoryBoxes.length) {
      selectionSummary.textContent = "Everything selected";
    } else if (selectedCount === 0) {
      selectionSummary.textContent = "Empty workspace";
    } else {
      selectionSummary.textContent = `${selectedCount} of ${categoryBoxes.length} selected`;
    }
  };

  dialog.querySelectorAll("[data-dialog-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeDialog(dialog));
  });
  dialog.querySelector("[data-clone-select-all]")?.addEventListener("click", () => {
    boxes().forEach((box) => { box.checked = true; });
    updateSelectionSummary();
  });
  dialog.querySelector("[data-clone-clear]")?.addEventListener("click", () => {
    boxes().forEach((box) => { box.checked = false; });
    updateSelectionSummary();
  });
  boxes().forEach((box) => {
    box.addEventListener("change", updateSelectionSummary);
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = boxes()
      .filter((box) => box.checked)
      .map((box) => box.value);
    closeDialog(dialog);
    await window.dockerManagerActions?.cloneLocalInstance?.(containerId, {
      workspaceCategories: selected
    });
  });

  document.body.appendChild(dialog);
  updateSelectionSummary();
  window.setTimeout(() => {
    dialog.querySelector("[data-clone-submit]")?.focus();
  }, 0);
}

export {
  CLONE_WORKSPACE_OPTIONS,
  openCloneInstanceDialog
};
