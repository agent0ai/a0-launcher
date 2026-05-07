const { net } = require('electron');
const semver = require('semver');

const stateStore = require('./state_store');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function isoToMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : NaN;
}

function isSemverTag(tag) {
  const t = (tag || '').trim();
  if (!t.startsWith('v')) return false;
  return !!semver.valid(t.slice(1));
}

function extractNextLink(linkHeaderValue) {
  const v = (linkHeaderValue || '').trim();
  if (!v) return '';
  const parts = v.split(',');
  for (const p of parts) {
    const s = p.trim();
    if (!/rel=\"next\"/.test(s)) continue;
    const m = s.match(/<([^>]+)>/);
    if (m && m[1]) return m[1];
  }
  return '';
}

async function fetchAllReleases(githubRepo) {
  const repo = (githubRepo || '').trim();
  if (!repo) {
    const err = new Error('githubRepo is required');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  /** @type {any[]} */
  const releases = [];

  let url = `https://api.github.com/repos/${repo}/releases?per_page=100&page=1`;
  let pages = 0;

  while (url) {
    if (pages > 50) {
      const err = new Error('Aborting GitHub releases pagination after excessive pages');
      err.code = 'GITHUB_PAGINATION_ERROR';
      throw err;
    }
    pages += 1;

    const res = await net.fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'A0-Launcher'
      }
    });

    if (!res.ok) {
      const err = new Error(`GitHub API error: ${res.status} ${res.statusText}`);
      err.code = 'GITHUB_API_ERROR';
      err.details = { status: res.status };
      throw err;
    }

    const json = await res.json();
    if (Array.isArray(json)) releases.push(...json);

    const link = res.headers.get('link');
    url = extractNextLink(link);
  }

  return releases;
}

function normalizeOfficialReleases(rawReleases) {
  const out = [];
  for (const r of rawReleases || []) {
    if (!r || typeof r !== 'object') continue;
    if (r.draft) continue;
    if (r.prerelease) continue;

    const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : '';
    if (!isSemverTag(tag)) continue;

    out.push({
      tag,
      publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
      isPrerelease: false,
      releaseUrl: typeof r.html_url === 'string' ? r.html_url : null
    });
  }

  out.sort((a, b) => semver.rcompare(a.tag.slice(1), b.tag.slice(1)));
  return out;
}

async function listOfficialReleases(options = {}) {
  const githubRepo = (options.githubRepo || '').trim();
  const forceRefresh = !!options.forceRefresh;

  const cachePath = stateStore.releasesCacheFile();
  const cached = await stateStore.readJson(cachePath, null);

  const cachedRepo = cached && typeof cached.githubRepo === 'string' ? cached.githubRepo : '';
  const cachedFetchedAt = cached && typeof cached.fetchedAt === 'string' ? cached.fetchedAt : '';
  const cachedFetchedAtMs = isoToMs(cachedFetchedAt);
  const cacheFresh =
    !forceRefresh &&
    cachedRepo === githubRepo &&
    Number.isFinite(cachedFetchedAtMs) &&
    Date.now() - cachedFetchedAtMs < CACHE_TTL_MS;

  if (cacheFresh && Array.isArray(cached?.releases)) {
    return { releases: cached.releases, offline: false, lastSyncedAt: cachedFetchedAt || null };
  }

  try {
    const raw = await fetchAllReleases(githubRepo);
    const releases = normalizeOfficialReleases(raw);
    const fetchedAt = nowIso();
    await stateStore.writeJson(cachePath, {
      githubRepo,
      fetchedAt,
      releases
    });
    return { releases, offline: false, lastSyncedAt: fetchedAt };
  } catch (error) {
    if (cachedRepo === githubRepo && Array.isArray(cached?.releases) && cachedFetchedAt) {
      return { releases: cached.releases, offline: true, lastSyncedAt: cachedFetchedAt };
    }
    throw error;
  }
}

module.exports = {
  listOfficialReleases
};


