function byId(id) { return document.getElementById(id); }

function render(state) {
  const images = byId("storageUsed");
  const containers = byId("storageFree");
  const volumes = byId("storageEstimate");
  const installs = Array.isArray(state?.versions) && state.versions.length
    ? state.versions.filter((v) => v?.availability && v.availability !== "available").length
    : (state?.images || []).length || 0;
  if (images) images.textContent = String(installs);
  if (containers) containers.textContent = String((state?.containers || []).length || 0);
  if (volumes) volumes.textContent = String((state?.volumes || []).length || 0);
}

window.addEventListener("dm:state", (e) => render(e.detail || {}));
if (window.__dmLastState) render(window.__dmLastState);
