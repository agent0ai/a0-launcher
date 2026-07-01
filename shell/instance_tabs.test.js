const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  normalizeHttpUrl,
  isAllowedLocalInstanceUrl,
  isAllowedRemoteInstanceUrl,
  isAllowedInstanceTabNavigationUrl,
  makeTabKey,
  webUiLoginRequestForTarget,
  makeTabsSnapshot,
  instanceContextMenuActions
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

test('instance tab navigation allows credential-free HTTP URLs', () => {
  assert.equal(isAllowedInstanceTabNavigationUrl('https://github.com/login/oauth/authorize?client_id=abc'), true);
  assert.equal(isAllowedInstanceTabNavigationUrl('https://agent-zero.trycloudflare.com/'), true);
  assert.equal(isAllowedInstanceTabNavigationUrl('http://127.0.0.1:32080/oauth/callback'), true);
  assert.equal(isAllowedInstanceTabNavigationUrl('https://token@example.com/'), false);
  assert.equal(isAllowedInstanceTabNavigationUrl('file:///tmp/nope'), false);
  assert.equal(isAllowedInstanceTabNavigationUrl('vscode://file/tmp/nope'), false);
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

test('web UI login request posts secure remote credentials to same-origin login route', () => {
  const request = webUiLoginRequestForTarget(
    {
      kind: 'remote',
      instanceId: 'remote-1',
      url: 'https://agent-zero.example.com/plugins/tool?next=nope#section'
    },
    { username: ' jan ', password: 'secret pass' }
  );

  assert.equal(request.url, 'https://agent-zero.example.com/login');
  assert.equal(request.body, 'username=jan&password=secret+pass&next=%2Fplugins%2Ftool%3Fnext%3Dnope');
});

test('web UI login request ignores unsafe remote or incomplete credential targets', () => {
  assert.equal(
    webUiLoginRequestForTarget(
      { kind: 'remote', instanceId: 'remote-1', url: 'http://agent-zero.example.test/' },
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

test('instance context menu exposes copy for selected page text', () => {
  assert.deepEqual(
    instanceContextMenuActions({
      selectionText: "Hello! I'm Agent Zero",
      editFlags: { canCopy: true, canSelectAll: true }
    }),
    ['copy', 'separator', 'selectAll']
  );
});

test('instance context menu exposes editable text actions from Electron flags', () => {
  assert.deepEqual(
    instanceContextMenuActions({
      isEditable: true,
      editFlags: {
        canUndo: true,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canDelete: true,
        canSelectAll: true
      }
    }),
    ['undo', 'separator', 'cut', 'copy', 'paste', 'delete', 'separator', 'selectAll']
  );
});

test('instance context menu stays quiet when no edit action applies', () => {
  assert.deepEqual(instanceContextMenuActions({ editFlags: {} }), []);
});
