const path = require('node:path');

const PREFIX = 'a0-svc';

function sanitizeNamePart(value) {
  const v = (value || '').trim();
  if (!v) return 'unknown';
  // Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]; keep ASCII only.
  const cleaned = v
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return cleaned || 'unknown';
}

function repoSlug(imageRepo) {
  return sanitizeNamePart((imageRepo || '').replace(/\//g, '-'));
}

function getActiveContainerName(imageRepo) {
  return `${PREFIX}-active__${repoSlug(imageRepo)}`;
}

function getRetainedContainerPrefix(imageRepo) {
  return `${PREFIX}-retained__${repoSlug(imageRepo)}__`;
}

function isoToCompactTimestamp(iso) {
  const d = new Date(iso || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${y}${m}${day}T${hh}${mm}${ss}Z`;
}

function compactTimestampToIso(ts) {
  const t = (ts || '').trim();
  if (!/^\d{8}T\d{6}Z$/.test(t)) return '';
  const y = t.slice(0, 4);
  const m = t.slice(4, 6);
  const d = t.slice(6, 8);
  const hh = t.slice(9, 11);
  const mm = t.slice(11, 13);
  const ss = t.slice(13, 15);
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
}

function makeRetainedContainerName(imageRepo, tag, retainedAtIso) {
  const ts = isoToCompactTimestamp(retainedAtIso || Date.now());
  const tagSlug = sanitizeNamePart(tag);
  return `${PREFIX}-retained__${repoSlug(imageRepo)}__${ts}__${tagSlug}`;
}

function parseRetainedContainerName(containerName) {
  const name = (containerName || '').trim();
  if (!name.startsWith(`${PREFIX}-retained__`)) return null;

  // Format: a0-svc-retained__<repoSlug>__<ts>__<tagSlug>
  const parts = name.split('__');
  if (parts.length < 4) return null;

  const ts = parts[2] || '';
  const retainedAt = compactTimestampToIso(ts);
  if (!retainedAt) return null;

  const tag = parts.slice(3).join('__');
  if (!tag) return null;

  return { tag, retainedAt };
}

function isManagedContainerName(containerName) {
  const name = (containerName || '').trim();
  return name.startsWith(`${PREFIX}-active__`) || name.startsWith(`${PREFIX}-retained__`);
}

module.exports = {
  sanitizeNamePart,
  repoSlug,
  getActiveContainerName,
  getRetainedContainerPrefix,
  makeRetainedContainerName,
  parseRetainedContainerName,
  isManagedContainerName,

  // Convenience: stable on-disk paths for future storage/reporting use.
  pathJoin: path.join
};


