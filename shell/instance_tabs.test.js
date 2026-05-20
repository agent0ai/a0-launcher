const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  normalizeHttpUrl,
  isAllowedLocalInstanceUrl,
  isAllowedRemoteInstanceUrl,
  makeTabKey,
  makeTabsSnapshot
} = require('./instance_tabs');

test('local URLs allow only localhost-style HTTP URLs without credentials', () => {
  assert.equal(isAllowedLocalInstanceUrl('http://127.0.0.1:32080/'), true);
  assert.equal(isAllowedLocalInstanceUrl('http://localhost:8880/'), true);
  assert.equal(isAllowedLocalInstanceUrl('https://[::1]:8880/'), true);
  assert.equal(isAllowedLocalInstanceUrl('https://example.com/'), false);
  assert.equal(isAllowedLocalInstanceUrl('http://user:pass@127.0.0.1:32080/'), false);
  assert.equal(isAllowedLocalInstanceUrl('file:///tmp/index.html'), false);
});

test('remote URLs allow normal HTTP URLs without credentials', () => {
  assert.equal(isAllowedRemoteInstanceUrl('https://example.com/a0'), true);
  assert.equal(isAllowedRemoteInstanceUrl('http://agent-zero.example.test/'), true);
  assert.equal(isAllowedRemoteInstanceUrl('https://token@example.com/'), false);
  assert.equal(isAllowedRemoteInstanceUrl('ftp://example.com/'), false);
});

test('normalizeHttpUrl canonicalizes valid HTTP URLs and rejects invalid values', () => {
  assert.equal(normalizeHttpUrl(' http://127.0.0.1:32080 '), 'http://127.0.0.1:32080/');
  assert.equal(normalizeHttpUrl('not a url'), '');
  assert.equal(normalizeHttpUrl('file:///tmp/nope'), '');
});

test('makeTabKey includes target identity and normalized URL', () => {
  assert.equal(
    makeTabKey({ kind: 'local', containerId: 'abc123', url: 'http://127.0.0.1:32080/' }),
    'local:abc123:http://127.0.0.1:32080/'
  );
  assert.equal(
    makeTabKey({ kind: 'remote', instanceId: 'remote-1', url: 'https://example.com/' }),
    'remote:remote-1:https://example.com/'
  );
});

test('makeTabsSnapshot exposes only sanitized tab fields', () => {
  const tabs = new Map();
  tabs.set('tab-1', {
    id: 'tab-1',
    key: 'local:abc:http://127.0.0.1:32080/',
    kind: 'local',
    title: 'Agent Zero',
    url: 'http://127.0.0.1:32080/',
    containerId: 'abc',
    loading: false,
    canReload: true,
    view: { secret: true }
  });

  assert.deepEqual(makeTabsSnapshot(tabs, 'tab-1'), {
    tabs: [{
      id: 'tab-1',
      kind: 'local',
      title: 'Agent Zero',
      url: 'http://127.0.0.1:32080/',
      containerId: 'abc',
      instanceId: '',
      active: true,
      loading: false,
      canReload: true
    }],
    activeTabId: 'tab-1'
  });
});
