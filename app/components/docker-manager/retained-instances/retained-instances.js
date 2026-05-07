function byId(id) { return document.getElementById(id); }

function render(state) {
  const list = byId("retainedList");
  if (!list) return;
  const volumes = Array.isArray(state?.volumes) ? state.volumes : [];

  list.innerHTML = "";
  if (!volumes.length) {
    list.innerHTML = '<div class="sv-subtitle">No volumes found.</div>';
    return;
  }

  for (const v of volumes) {
    const row = document.createElement("div");
    row.className = "item";

    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = v?.name || "volume";
    const meta = document.createElement("div");
    meta.className = "item-meta";
    meta.textContent = `${v?.driver || ""}${v?.mountpoint ? ` - ${v.mountpoint}` : ""}`;
    left.appendChild(title);
    left.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "item-actions";
    const remove = document.createElement("button");
    remove.className = "button cancel";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Remove volume ${v?.name}?`)) return;
      await window.dockerManagerActions?.removeVolume?.(v?.name || "");
    });
    actions.appendChild(remove);

    row.appendChild(left);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function bind() {
  const prune = byId("pruneVolumesBtn");
  if (prune && !prune.dataset.bound) {
    prune.dataset.bound = "1";
    prune.addEventListener("click", async () => {
      await window.dockerManagerActions?.pruneVolumes?.();
    });
  }
}

window.addEventListener("dm:state", (e) => {
  bind();
  render(e.detail || {});
});
bind();
if (window.__dmLastState) render(window.__dmLastState);