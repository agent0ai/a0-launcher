const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  compareReleaseTagsDescending,
  isSemverReleaseTag,
  normalizeReleaseTagVersion
} = require('./release_tags');

test('release tag validation accepts current two-part and historical three-part tags', () => {
  assert.equal(isSemverReleaseTag('v1.20'), true);
  assert.equal(normalizeReleaseTagVersion('v1.20'), '1.20.0');
  assert.equal(isSemverReleaseTag('v0.9.8'), true);
  assert.equal(normalizeReleaseTagVersion('v0.9.8'), '0.9.8');
});

test('release tag validation rejects unsafe or unsupported version shapes', () => {
  assert.equal(isSemverReleaseTag('latest'), false);
  assert.equal(isSemverReleaseTag('testing'), false);
  assert.equal(isSemverReleaseTag('v1'), false);
  assert.equal(isSemverReleaseTag('1.20'), false);
  assert.equal(isSemverReleaseTag('v1.20.0-beta'), false);
  assert.equal(isSemverReleaseTag('v1.20/evil'), false);
});

test('release tag comparison sorts two-part releases above older three-part releases', () => {
  const tags = ['v0.9.8', 'v1.19', 'v1.20', 'v1.20.1'];
  tags.sort(compareReleaseTagsDescending);

  assert.deepEqual(tags, ['v1.20.1', 'v1.20', 'v1.19', 'v0.9.8']);
});
