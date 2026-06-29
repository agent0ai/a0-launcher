const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  normalizeHttpUrl,
  isAllowedLocalInstanceUrl,
  isAllowedRemoteInstanceUrl,
  makeTabKey,
  webUiLoginRequestForTarget,
  makeTabsSnapshot
} = require('./instance_tabs');

test('local URLs allow only localhost-style HTTP URLs without credentials', () => {
  assert.equal(isAllowedLocalInstanceUrl('http://127.0.0.1:32080/'), true);
  assert.equal(isAllowedLocalInstanceUrl('http://localhost:8880/'), true);
  assert.equal(isAllowedLocalInstanceUrl('http://localhost:65535/'), true);
  assert.equal(isAllowedLocalInstanceUrl('http://localhost:0/'), false);
  assert.equal(isAllowedLocalInstanceUrl('http://localhost:65536/'), false);
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

test('makeTabKey uses stable identity before URL fallback', () => {
  assert.equal(
    makeTabKey({ kind: 'local', containerId: 'abc123', url: 'http://127.0.0.1:32080/' }),
    'local:abc123'
  );
  assert.equal(
    makeTabKey({ kind: 'remote', instanceId: 'remote-1', url: 'https://example.com/' }),
    'remote:remote-1'
  );
  assert.equal(
    makeTabKey({ kind: 'local', url: 'http://127.0.0.1:32080/' }),
    'local:http://127.0.0.1:32080/'
  );
});

test('web UI login request posts local credentials to same-origin login route', () => {
  const request = webUiLoginRequestForTarget(
    {
      kind: 'local',
      containerId: 'abc123',
      url: 'http://127.0.0.1:32080/plugins/tool?next=nope#section'
    },
    { username: ' jan ', password: 'secret pass' }
  );

  assert.equal(request.url, 'http://127.0.0.1:32080/login');
  assert.equal(request.body, 'username=jan&password=secret+pass&next=%2Fplugins%2Ftool%3Fnext%3Dnope');
});

test('web UI login request ignores remote or incomplete credential targets', () => {
  assert.equal(
    webUiLoginRequestForTarget(
      { kind: 'remote', instanceId: 'remote-1', url: 'https://example.com/' },
      { username: 'jan', password: 'secret' }
    ),
    null
  );
  assert.equal(
    webUiLoginRequestForTarget(
      { kind: 'local', containerId: 'abc123', url: 'http://127.0.0.1:32080/' },
      { username: 'jan', password: '' }
    ),
    null
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

test('makeTabsSnapshot supports launcher home with no active instance tab', () => {
  const tabs = new Map();
  tabs.set('tab-1', {
    id: 'tab-1',
    kind: 'local',
    title: 'Research instance',
    url: 'http://127.0.0.1:32080/',
    containerId: 'abc',
    loading: false,
    canReload: true
  });

  assert.deepEqual(makeTabsSnapshot(tabs, ''), {
    tabs: [{
      id: 'tab-1',
      kind: 'local',
      title: 'Research instance',
      url: 'http://127.0.0.1:32080/',
      containerId: 'abc',
      instanceId: '',
      active: false,
      loading: false,
      canReload: true
    }],
    activeTabId: ''
  });
});
