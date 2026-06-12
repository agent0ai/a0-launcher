const semver = require('semver');

function normalizeReleaseTagVersion(tag) {
  const t = (tag || '').trim();
  if (!t.startsWith('v')) return null;

  const raw = t.slice(1);
  if (!/^\d+\.\d+(\.\d+)?$/.test(raw)) return null;

  const version = /^\d+\.\d+$/.test(raw) ? `${raw}.0` : raw;
  return semver.valid(version);
}

function isSemverReleaseTag(tag) {
  return !!normalizeReleaseTagVersion(tag);
}

function compareReleaseTagsDescending(a, b) {
  const av = normalizeReleaseTagVersion(a);
  const bv = normalizeReleaseTagVersion(b);
  if (av && bv) return semver.rcompare(av, bv);
  if (av) return -1;
  if (bv) return 1;
  return String(b || '').localeCompare(String(a || ''));
}

module.exports = {
  normalizeReleaseTagVersion,
  isSemverReleaseTag,
  compareReleaseTagsDescending
};
