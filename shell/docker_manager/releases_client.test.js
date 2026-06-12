const assert = require('node:assert/strict');
const { test } = require('node:test');

const { normalizeOfficialReleases } = require('./releases_client');

test('official release normalization includes current two-part tags', () => {
  const releases = normalizeOfficialReleases([
    { tag_name: 'v0.9.8', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' },
    { tag_name: 'v1.20', draft: false, prerelease: false, published_at: '2026-06-04T00:00:00Z' },
    { tag_name: 'latest', draft: false, prerelease: false, published_at: '2026-06-05T00:00:00Z' },
    { tag_name: 'v1.21', draft: true, prerelease: false, published_at: '2026-06-06T00:00:00Z' },
    { tag_name: 'v1.19', draft: false, prerelease: true, published_at: '2026-06-03T00:00:00Z' }
  ]);

  assert.deepEqual(releases.map((r) => r.tag), ['v1.20', 'v0.9.8']);
});
