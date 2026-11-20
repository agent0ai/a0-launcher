const VISIBLE_CHANNEL_TAGS = ["latest", "ready", "v3"];

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
  return entry?.isBackendImage !== false && entry?.tag === "latest";
}

function channelOrder(entry) {
  const index = entry?.isBackendImage === false ? -1 : VISIBLE_CHANNEL_TAGS.indexOf(entry?.tag);
  return index < 0 ? VISIBLE_CHANNEL_TAGS.length : index;
}

function isVisibleChannelEntry(entry) {
  return channelOrder(entry) < VISIBLE_CHANNEL_TAGS.length;
}

function compareVisibleChannels(left, right) {
  return channelOrder(left) - channelOrder(right);
}

function isTestingEntry(entry) {
  return entry?.isBackendImage !== false && entry?.tag === "testing";
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

export {
  parseReleaseTagParts,
  isLatestEntry,
  isVisibleChannelEntry,
  compareVisibleChannels,
  isTestingEntry,
  compareReleaseTags,
  normalizeDate
};
