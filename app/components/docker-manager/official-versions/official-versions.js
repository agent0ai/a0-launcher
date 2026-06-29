import { createVersionVisual } from "../card-visuals.js";
import { defaultInstanceName } from "../instance-defaults.js";
import { openRunInstanceDialog } from "../run-instance-dialog.js";

function byId(id) { return document.getElementById(id); }

function fmtDate(v) {
  if (!v) return "";
  const n = Date.parse(v);
  if (!Number.isFinite(n)) return String(v);
  try { return new Date(n).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch { return String(v); }
}

function fmtSize(bytes) {
  if (!bytes || !Number.isFinite(Number(bytes))) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = Number(bytes);
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
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

function isLatestEntry(entry) {
  return entry?.tag === "latest";
}

function isReadyEntry(entry) {
  return entry?.tag === "ready";
}

function isPinnedChannelEntry(entry) {
  return isLatestEntry(entry) || isReadyEntry(entry);
}

function isTestingEntry(entry) {
  return entry?.tag === "testing";
}

function isHiddenEntry(entry) {
  return isTestingEntry(entry);
}

function isInstalledEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  return !!entry.isActive ||
    entry.availability === "installed" ||
    entry.availability === "update_available" ||
    entry.availability === "installing" ||
    !!entry.differsFromPublished;
}

function normalizeInstallFilter(value) {
  return value === "installed" ? "installed" : "all";
}

function filterInstallEntries(entries, filter = "all") {
  const source = Array.isArray(entries) ? entries : [];
  if (normalizeInstallFilter(filter) !== "installed") return source;
  return source.filter((entry) => isInstalledEntry(entry));
}

function releaseMatchBadgeLabel(tag) {
  return String(tag || "").trim().replace(/^v(?=\d)/i, "");
}

function isReleaseTag(entry) {
  return !!parseReleaseTagParts(entry?.tag);
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

function orderedEntries(entries) {
  return [...entries].sort((left, right) => {
    const leftLatest = isLatestEntry(left);
    const rightLatest = isLatestEntry(right);
    if (leftLatest && !rightLatest) return -1;
    if (!leftLatest && rightLatest) return 1;

    const leftReady = isReadyEntry(left);
    const rightReady = isReadyEntry(right);
    if (leftReady && !rightReady) return -1;
    if (!leftReady && rightReady) return 1;

    const leftTesting = isTestingEntry(left);
    const rightTesting = isTestingEntry(right);
    if (leftTesting && !rightTesting) return 1;
    if (!leftTesting && rightTesting) return -1;

    const leftIsRelease = isReleaseTag(left);
    const rightIsRelease = isReleaseTag(right);
    if (leftIsRelease && rightIsRelease) {
      const tagCompare = compareReleaseTags(left.tag, right.tag);
      if (tagCompare !== 0) return tagCompare;
      const leftDate = normalizeDate(left.publishedAt);
      const rightDate = normalizeDate(right.publishedAt);
      if (leftDate !== null && rightDate !== null && leftDate !== rightDate) return rightDate - leftDate;
      if (leftDate !== null && rightDate === null) return -1;
      if (leftDate === null && rightDate !== null) return 1;
      return (left.tag || "").localeCompare(right.tag || "", undefined, { numeric: true, sensitivity: "base" });
    }
    if (leftIsRelease && !rightIsRelease) return -1;
    if (!leftIsRelease && rightIsRelease) return 1;

    const leftDate = normalizeDate(left.publishedAt);
    const rightDate = normalizeDate(right.publishedAt);
    if (leftDate !== null && rightDate !== null && leftDate !== rightDate) return rightDate - leftDate;
    if (leftDate !== null && rightDate === null) return -1;
    if (leftDate === null && rightDate !== null) return 1;

    return (left.tag || "").localeCompare(right.tag || "", undefined, { numeric: true, sensitivity: "base" });
  });
}

function latestReleaseEntry(entries) {
  const releases = (Array.isArray(entries) ? entries : []).filter((entry) => isReleaseTag(entry));
  return releases.find((entry) => Array.isArray(entry.badges) && entry.badges.includes("latest")) || releases[0] || null;
}

function displayDateForEntry(entry, entries = []) {
  if (!entry) return null;
  if (isPinnedChannelEntry(entry)) {
    if (entry.updatedAt) return { label: "Updated", value: entry.updatedAt };

    const releaseTag = entry.matchedReleaseTag || (isLatestEntry(entry) ? latestReleaseEntry(entries)?.tag : "");
    if (releaseTag) {
      const release = (Array.isArray(entries) ? entries : []).find((candidate) => candidate?.tag === releaseTag);
      if (release?.publishedAt) return { label: "Released", value: release.publishedAt };
    }
  }

  if (entry.publishedAt) {
    return { label: entry.imageRef ? "Created" : "Released", value: entry.publishedAt };
  }

  return null;
}

function metaPartsForEntry(entry, entries = []) {
  const parts = [];
  const date = displayDateForEntry(entry, entries);
  if (date?.value) parts.push(`${date.label} ${fmtDate(date.value)}`);
  if (entry?.sizeBytes) parts.push(fmtSize(entry.sizeBytes));

  if (isPinnedChannelEntry(entry)) return parts;

  if (entry?.imageRef) parts.unshift(entry.imageRef);
  if (isReadyEntry(entry)) parts.push("Development image with alpha features under test");
  if (entry?.matchHint) parts.push(entry.matchHint);
  if (entry?.digestHint) parts.push(entry.digestHint);
  return parts;
}

function buildInstallCatalogModel(entries) {
  const ordered = orderedEntries(Array.isArray(entries) ? entries : []);
  const channels = [];
  const other = [];
  const majorGroups = new Map();

  for (const entry of ordered) {
    if (isPinnedChannelEntry(entry)) {
      channels.push(entry);
      continue;
    }

    const parts = parseReleaseTagParts(entry?.tag);
    if (parts) {
      if (!majorGroups.has(parts.major)) majorGroups.set(parts.major, []);
      majorGroups.get(parts.major).push(entry);
      continue;
    }

    other.push(entry);
  }

  const groups = [...majorGroups.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([major, groupEntries], index) => ({
      major,
      title: `${major}.x`,
      entries: groupEntries,
      defaultOpen: index === 0
    }));

  return {
    entries: ordered,
    channels,
    groups,
    other
  };
}

function normalizeVersionEntries(state) {
  const versions = Array.isArray(state?.versions) ? state.versions : [];
  const images = Array.isArray(state?.images) ? state.images : [];
  if (versions.length) {
    const entries = versions.map((v) => ({
      tag: v?.id || "",
      title: v?.displayVersion || v?.id || "unknown",
      category: v?.category || "",
      availability: v?.availability || "available",
      installability: v?.installability || null,
      badges: Array.isArray(v?.channelBadges) ? v.channelBadges : [],
      isActive: !!v?.isActive,
      activeState: v?.activeState || null,
      publishedAt: v?.publishedAt || null,
      sizeBytes: v?.sizeBytes || null,
      matchHint: v?.matchHint || "",
      matchedReleaseTag: v?.matchedReleaseTag || "",
      digestHint: v?.digestHint || "",
      differsFromPublished: !!v?.differsFromPublished,
      updatedAt: v?.updatedAt || null
    })).filter((entry) => entry.tag);

    const knownTags = new Set(entries.map((entry) => entry.tag));
    for (const img of images) {
      const tag = img?.tag || img?.imageRef || "";
      if (!tag || knownTags.has(tag)) continue;
      knownTags.add(tag);
      entries.push({
        tag,
        title: tag,
        imageRef: img?.imageRef || "",
        category: "local_build",
        availability: "installed",
        isActive: !!img?.isActive,
        publishedAt: img?.createdAt || null,
        updatedAt: null,
        sizeBytes: img?.size || img?.sizeBytes || null,
        badges: []
      });
    }

    return entries;
  }

  return images.map((img) => ({
    tag: img?.tag || img?.imageRef || "unknown",
    title: img?.tag || img?.imageRef || "unknown",
    imageRef: img?.imageRef || "",
    availability: "installed",
    isActive: !!img?.isActive,
    publishedAt: img?.createdAt || null,
    updatedAt: null,
    sizeBytes: img?.size || img?.sizeBytes || null,
    badges: []
  }));
}

function statusForEntry(entry) {
  if (entry.isActive) {
    return {
      className: "status-active",
      label: entry.activeState === "running" ? "Running" : "Active"
    };
  }

  if (entry.availability === "installing") {
    return { className: "status-installed", label: "Working" };
  }

  if (entry.availability === "update_available" || entry.differsFromPublished) {
    return null;
  }

  if (entry.availability === "installed") {
    return { className: "status-installed", label: "Installed" };
  }

  if (entry.installability === "not_yet_available") {
    return { className: "status-unavailable", label: "Not ready" };
  }

  return { className: "status-available", label: "Available" };
}

function actionForEntry(entry, state) {
  return actionsForEntry(entry, state)[0] || null;
}

function actionsForEntry(entry, state) {
  if (entry.availability === "installing") return [];

  if (entry.availability === "installed" || entry.availability === "update_available" || entry.differsFromPublished) {
    const actions = [
      {
        label: "Run",
        className: "button confirm",
        handler: () => openRunInstanceDialog({ entry, state })
      }
    ];

    if (entry.availability === "update_available" || entry.differsFromPublished) {
      actions.push({
        label: "Update",
        className: "button",
        handler: () => window.dockerManagerActions?.updateInstall?.(entry.tag)
      });
    }

    return actions;
  }

  if (entry.installability === "not_yet_available") {
    return [{
      label: "Not ready",
      className: "button",
      disabled: true,
      handler: () => {}
    }];
  }

  return [{
    label: "Install",
    className: "button confirm",
    handler: () => window.dockerManagerActions?.installOrSync?.(entry.tag)
  }];
}

function canRemoveEntry(entry) {
  if (!entry || entry.availability === "installing") return false;
  return entry.availability === "installed" || entry.availability === "update_available" || !!entry.differsFromPublished;
}

function confirmRemoveInstall(entry) {
  const label = entry?.title || entry?.tag || "this install";
  return window.confirm(
    `Remove ${label} from Installs?\n\nDocker will refuse if any Instance still uses this image. Delete those Instances first, then remove the install.`
  );
}

function isAwaitingFirstInventory(state, entries) {
  return !state?.stateLoaded || (!!state?.loading && !entries.length);
}

const versionGroupOpenState = new Map();
let currentInstallFilter = "all";
let lastInstallRenderKey = "";

function installCardsRenderKey(state = {}, filter = currentInstallFilter) {
  return JSON.stringify({
    loading: !!state?.loading,
    stateLoaded: !!state?.stateLoaded,
    filter: normalizeInstallFilter(filter),
    images: Array.isArray(state?.images) ? state.images : [],
    versions: Array.isArray(state?.versions) ? state.versions : []
  });
}

function setInstallFilter(value) {
  const next = normalizeInstallFilter(value);
  if (currentInstallFilter === next) return;
  currentInstallFilter = next;
  render(window.__dmLastState || {});
}

function syncInstallFilterControls() {
  const filter = byId("officialInstallFilter");
  if (!filter) return;
  filter.querySelectorAll("[data-install-filter]").forEach((button) => {
    const selected = normalizeInstallFilter(button.dataset.installFilter) === currentInstallFilter;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function bindInstallFilterControls() {
  const filter = byId("officialInstallFilter");
  if (!filter || filter.dataset.bound === "true") return;
  filter.dataset.bound = "true";
  filter.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-install-filter]");
    if (!button || !filter.contains(button)) return;
    setInstallFilter(button.dataset.installFilter);
  });
}

function renderEntryCard(entry, state, entries) {
  const card = document.createElement("div");
  card.className = isPinnedChannelEntry(entry) ? "dm-card dm-card-highlight" : "dm-card";

  const visual = createVersionVisual(entry.title || entry.tag, { seed: entry.tag || entry.title });

  const body = document.createElement("div");
  body.className = "dm-card-body";
  const title = document.createElement("div");
  title.className = "dm-card-title";
  title.textContent = entry.title;
  for (const badgeName of entry.badges || []) {
    const badge = document.createElement("span");
    badge.className = `badge badge-${badgeName}`;
    badge.textContent = badgeName;
    title.appendChild(badge);
  }
  if (entry.category === "local_build") {
    const badge = document.createElement("span");
    badge.className = "badge badge-canonical";
    badge.textContent = "local";
    title.appendChild(badge);
  }
  if (isPinnedChannelEntry(entry) && entry.matchedReleaseTag) {
    const badge = document.createElement("span");
    badge.className = "badge badge-release-match";
    badge.textContent = releaseMatchBadgeLabel(entry.matchedReleaseTag);
    title.appendChild(badge);
  }
  body.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "dm-card-meta";
  const parts = metaPartsForEntry(entry, entries);
  meta.textContent = parts.join(" · ");
  body.appendChild(meta);

  const footer = document.createElement("div");
  footer.className = "dm-card-footer";

  const status = statusForEntry(entry);
  if (status) {
    const statusEl = document.createElement("span");
    statusEl.className = "status";
    statusEl.classList.add(status.className);
    statusEl.textContent = status.label;
    footer.appendChild(statusEl);
  }

  const actions = document.createElement("div");
  actions.className = "dm-card-actions";

  const cardActions = actionsForEntry(entry, state) || [];
  for (const action of cardActions) {
    const actionBtn = document.createElement("button");
    actionBtn.className = action.className;
    actionBtn.type = "button";
    actionBtn.textContent = action.label;
    actionBtn.disabled = !!action.disabled;
    actionBtn.addEventListener("click", action.handler);
    actions.appendChild(actionBtn);
  }

  if (canRemoveEntry(entry)) {
    const removeBtn = document.createElement("button");
    removeBtn.className = "button cancel dm-icon-button";
    removeBtn.type = "button";
    removeBtn.title = "Remove install";
    removeBtn.setAttribute("aria-label", `Remove ${entry.title || entry.tag} install`);
    removeBtn.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">delete</span>';
    removeBtn.addEventListener("click", () => {
      if (!confirmRemoveInstall(entry)) return;
      window.dockerManagerActions?.removeInstalledImage?.(entry.tag);
    });
    actions.appendChild(removeBtn);
  }

  footer.appendChild(actions);

  card.appendChild(visual);
  card.appendChild(body);
  card.appendChild(footer);
  return card;
}

function appendVersionGroup(list, group, state, entries) {
  const key = `major:${group.major}`;
  const details = document.createElement("details");
  details.className = "dm-version-group";
  const storedOpen = versionGroupOpenState.get(key);
  details.open = typeof storedOpen === "boolean" ? storedOpen : group.defaultOpen;

  const summary = document.createElement("summary");
  summary.className = "dm-version-group-summary";

  const title = document.createElement("span");
  title.className = "dm-version-group-title";
  title.textContent = group.title;
  summary.appendChild(title);

  const count = document.createElement("span");
  count.className = "dm-version-group-count";
  count.textContent = `${group.entries.length} ${group.entries.length === 1 ? "version" : "versions"}`;
  summary.appendChild(count);

  const icon = document.createElement("span");
  icon.className = "material-symbols-outlined dm-version-group-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "expand_more";
  summary.appendChild(icon);

  const groupGrid = document.createElement("div");
  groupGrid.className = "dm-cards-grid dm-version-group-grid";
  for (const entry of group.entries) {
    groupGrid.appendChild(renderEntryCard(entry, state, entries));
  }

  details.addEventListener("toggle", () => {
    versionGroupOpenState.set(key, details.open);
  });

  details.appendChild(summary);
  details.appendChild(groupGrid);
  list.appendChild(details);
}

function render(state) {
  const subtitle = byId("officialSubtitle");
  const list = byId("officialList");
  if (!list) return;
  const renderKey = installCardsRenderKey(state);
  if (renderKey === lastInstallRenderKey) return;
  lastInstallRenderKey = renderKey;

  bindInstallFilterControls();
  syncInstallFilterControls();

  const allEntries = orderedEntries(normalizeVersionEntries(state).filter((entry) => !isHiddenEntry(entry)));
  const filteredEntries = filterInstallEntries(allEntries, currentInstallFilter);
  const catalog = buildInstallCatalogModel(filteredEntries);
  const entries = catalog.entries;
  const installedCount = allEntries.filter((entry) => isInstalledEntry(entry)).length;
  const availableCount = allEntries.filter((entry) => entry.availability === "available").length;
  const awaitingFirstInventory = isAwaitingFirstInventory(state, allEntries);
  if (subtitle) {
    subtitle.textContent = awaitingFirstInventory
      ? "Checking installs..."
      : allEntries.length
      ? `${installedCount} installed · ${availableCount} available`
      : "0 installs detected";
  }

  list.innerHTML = "";
  if (awaitingFirstInventory) {
    list.innerHTML = '<div class="dm-empty">Checking Agent Zero releases...</div>';
    return;
  }

  if (!entries.length) {
    list.innerHTML = currentInstallFilter === "installed"
      ? '<div class="dm-empty">No installed versions found.</div>'
      : '<div class="dm-empty">No versions found. Refresh to try again.</div>';
    return;
  }

  for (const entry of catalog.channels) {
    list.appendChild(renderEntryCard(entry, state, entries));
  }

  for (const group of catalog.groups) {
    appendVersionGroup(list, group, state, entries);
  }

  for (const entry of catalog.other) {
    list.appendChild(renderEntryCard(entry, state, entries));
  }
}

export {
  actionForEntry,
  actionsForEntry,
  buildInstallCatalogModel,
  canRemoveEntry,
  defaultInstanceName,
  displayDateForEntry,
  filterInstallEntries,
  installCardsRenderKey,
  isInstalledEntry,
  metaPartsForEntry,
  releaseMatchBadgeLabel,
  statusForEntry
};

window.addEventListener("dm:state", (e) => render(e.detail || {}));
if (window.__dmLastState) render(window.__dmLastState);
