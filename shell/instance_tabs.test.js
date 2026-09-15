const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  normalizeHttpUrl,
  instanceUiSectionUrl,
  instanceUiSectionScript,
  isAllowedLocalInstanceUrl,
  isAllowedRemoteInstanceUrl,
  isAllowedInstanceTabNavigationUrl,
  makeTabKey,
  webUiLoginRequestForTarget,
  loginCredentialsFromRequest,
  instanceLoginRedirectSucceeded,
  credentialSavePromptDecision,
  instanceTabLoginRecoveryTarget,
  cliCredentialsAllowedForTarget,
  makeTabsSnapshot,
  reorderAttachedInstanceTabs,
  findInstanceTabByWebContents,
  instanceContextMenuActions,
  reloadInstanceWebContents,
  isInstanceTabReloadShortcut,
  embeddedInstanceContentBounds,
  detachedInstanceContentBounds
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

test('instance section URL only appends known Agent Zero anchors', () => {
  assert.equal(
    instanceUiSectionUrl('http://127.0.0.1:32080/', 'self-update'),
    'http://127.0.0.1:32080/#section-self-update'
  );
  assert.equal(
    instanceUiSectionUrl('http://127.0.0.1:32080/#settings', 'self-update'),
    'http://127.0.0.1:32080/#section-self-update'
  );
  assert.equal(
    instanceUiSectionUrl('http://127.0.0.1:32080/', 'advanced'),
    'http://127.0.0.1:32080/'
  );
});

test('instance section script opens only the known self-update modal', () => {
  assert.equal(
    instanceUiSectionScript('self-update').includes('settings/external/self-update-modal.html'),
    true
  );
  assert.equal(instanceUiSectionScript('advanced'), '');
});

test('instance tab navigation stays on the Agent Zero origin', () => {
  const localTab = { kind: 'local', url: 'http://127.0.0.1:32080/' };
  const remoteTab = { kind: 'remote', url: 'https://agent-zero.example.com/' };

  assert.equal(isAllowedInstanceTabNavigationUrl(localTab, 'http://127.0.0.1:32080/#settings'), true);
  assert.equal(isAllowedInstanceTabNavigationUrl(localTab, 'http://127.0.0.1:32080/oauth/callback'), true);
  assert.equal(isAllowedInstanceTabNavigationUrl(remoteTab, 'https://agent-zero.example.com/chats'), true);
  assert.equal(isAllowedInstanceTabNavigationUrl(localTab, 'https://github.com/login/oauth/authorize?client_id=abc'), false);
  assert.equal(isAllowedInstanceTabNavigationUrl(localTab, 'https://agent-zero.trycloudflare.com/'), false);
  assert.equal(isAllowedInstanceTabNavigationUrl(localTab, 'https://token@example.com/'), false);
  assert.equal(isAllowedInstanceTabNavigationUrl(localTab, 'file:///tmp/nope'), false);
  assert.equal(isAllowedInstanceTabNavigationUrl(localTab, 'vscode://file/tmp/nope'), false);
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

test('successful Instance login captures bounded credentials and confirms a same-origin redirect', () => {
  const tab = {
    kind: 'local',
    containerId: 'abc123',
    url: 'http://127.0.0.1:32080/'
  };
  const request = {
    method: 'POST',
    resourceType: 'mainFrame',
    url: 'http://127.0.0.1:32080/login?next=%2F',
    uploadData: [{ bytes: Buffer.from('username=jan&password=secret+pass&next=%2F') }]
  };

  assert.deepEqual(loginCredentialsFromRequest(tab, request), {
    username: 'jan',
    password: 'secret pass'
  });
  assert.equal(instanceLoginRedirectSucceeded(tab, {
    ...request,
    statusCode: 302,
    redirectURL: 'http://127.0.0.1:32080/'
  }), true);
  assert.equal(instanceLoginRedirectSucceeded(tab, {
    ...request,
    statusCode: 302,
    redirectURL: 'https://example.com/'
  }), false);
});

test('credential capture ignores unsuccessful and ineligible login requests', () => {
  const localTab = { kind: 'local', containerId: 'abc123', url: 'http://127.0.0.1:32080/' };
  const insecureRemoteTab = { kind: 'remote', instanceId: 'remote-1', url: 'http://example.com/' };
  const request = {
    method: 'POST',
    resourceType: 'mainFrame',
    url: 'http://127.0.0.1:32080/login',
    uploadData: [{ bytes: Buffer.from('username=jan&password=secret') }]
  };

  assert.equal(loginCredentialsFromRequest(localTab, { ...request, resourceType: 'xhr' }), null);
  assert.equal(loginCredentialsFromRequest(insecureRemoteTab, {
    ...request,
    url: 'http://example.com/login'
  }), null);
  assert.equal(instanceLoginRedirectSucceeded(localTab, {
    ...request,
    statusCode: 200,
    redirectURL: 'http://127.0.0.1:32080/'
  }), false);
});

test('credential prompt accepts only its two exact shell-owned decisions', () => {
  assert.equal(credentialSavePromptDecision('a0-credential-prompt://save'), true);
  assert.equal(credentialSavePromptDecision('a0-credential-prompt://save/'), true);
  assert.equal(credentialSavePromptDecision('a0-credential-prompt://not-now'), false);
  assert.equal(credentialSavePromptDecision('a0-credential-prompt:save'), null);
  assert.equal(credentialSavePromptDecision('a0-credential-prompt://save/path'), null);
  assert.equal(credentialSavePromptDecision('a0-credential-prompt://save?extra=1'), null);
  assert.equal(credentialSavePromptDecision('https://save/'), null);
});

test('credential prompt uses the Launcher surface with no credential surface', () => {
  const source = fs.readFileSync(path.join(__dirname, 'credential_prompt.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, 'credential_prompt.css'), 'utf8');
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /\.\.\/app\/a0ui\/index\.css/);
  assert.match(source, /\.\.\/app\/docker_manager\.css/);
  assert.match(source, /class="dm-dialog"/);
  assert.match(source, /class="button confirm"/);
  assert.match(source, /a0-credential-prompt:\/\/not-now/);
  assert.match(source, /a0-credential-prompt:\/\/save/);
  assert.doesNotMatch(source, /<style|style=|'unsafe-inline'|linear-gradient|Agent Zero Launcher|assets\/icon\.png|<input|ipcRenderer|username|password/i);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}|rgba?\(|color-mix|font-family|font-size|border-radius|padding\s*:/i);
});

test('instance tab login recovery returns to the previous same-origin page', () => {
  assert.equal(
    instanceTabLoginRecoveryTarget(
      { kind: 'local', containerId: 'abc123', url: 'http://127.0.0.1:32080/chats?tab=1#current' },
      'http://127.0.0.1:32080/login'
    ).url,
    'http://127.0.0.1:32080/chats?tab=1#current'
  );
  assert.equal(
    instanceTabLoginRecoveryTarget(
      { kind: 'local', containerId: 'abc123', url: 'http://127.0.0.1:32080/login' },
      'http://127.0.0.1:32080/login'
    ).url,
    'http://127.0.0.1:32080/'
  );
});

test('CLI credential handoff allows local loopback and secure remotes only', () => {
  assert.equal(
    cliCredentialsAllowedForTarget({
      kind: 'local',
      containerId: 'abc123',
      url: 'http://127.0.0.1:32080/'
    }),
    true
  );
  assert.equal(
    cliCredentialsAllowedForTarget({
      kind: 'remote',
      instanceId: 'remote-1',
      url: 'https://agent-zero.example.com/'
    }),
    true
  );
  assert.equal(
    cliCredentialsAllowedForTarget({
      kind: 'remote',
      instanceId: 'remote-1',
      url: 'http://agent-zero.example.test/'
    }),
    false
  );
  assert.equal(
    cliCredentialsAllowedForTarget({
      kind: 'remote',
      instanceId: 'remote-1',
      url: 'https://user:pass@agent-zero.example.com/'
    }),
    false
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
    color: ' ROSE ',
    icon: 'terminal',
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
      canReload: true,
      color: 'rose',
      icon: 'terminal',
      hostAccess: { state: 'disconnected', connected: false }
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
      canReload: true,
      color: '',
      icon: '',
      hostAccess: { state: 'disconnected', connected: false }
    }],
    activeTabId: ''
  });
});

test('makeTabsSnapshot keeps a detached Host access lease available to Instance controls', () => {
  const tabs = new Map();
  tabs.set('tab-1', {
    id: 'tab-1',
    kind: 'local',
    title: 'Research instance',
    url: 'http://127.0.0.1:32080/',
    containerId: 'abc',
    detached: true,
    icon: 'not-an-icon',
    hostAccess: { state: 'connected', connected: true }
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
      canReload: false,
      color: '',
      icon: '',
      detached: true,
      hostAccess: { state: 'connected', connected: true }
    }],
    activeTabId: ''
  });
});

test('reorderAttachedInstanceTabs applies exact attached order without moving detached slots', () => {
  const tabs = new Map([
    ['first', { id: 'first' }],
    ['detached', { id: 'detached', detached: true }],
    ['second', { id: 'second' }],
    ['third', { id: 'third' }]
  ]);

  const reordered = reorderAttachedInstanceTabs(tabs, ['third', 'first', 'second']);
  assert.deepEqual(Array.from(reordered.keys()), ['third', 'detached', 'first', 'second']);
  assert.equal(reorderAttachedInstanceTabs(tabs, ['first', 'first', 'third']), null);
  assert.equal(reorderAttachedInstanceTabs(tabs, ['first', 'missing', 'third']), null);
});

test('Instance tab lookup recognizes embedded page and detached header WebContents', () => {
  const embedded = {};
  const detached = {};
  const tabs = new Map([
    ['embedded', { id: 'embedded', view: { webContents: embedded } }],
    ['detached', { id: 'detached', detachedWindow: { webContents: detached } }]
  ]);

  assert.equal(findInstanceTabByWebContents(tabs, embedded)?.id, 'embedded');
  assert.equal(findInstanceTabByWebContents(tabs, detached)?.id, 'detached');
  assert.equal(findInstanceTabByWebContents(tabs, {}), null);
});

test('Agent Zero pages expose no Launcher Host access controls', () => {
  const rendererPreloadSource = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.equal(fs.existsSync(path.join(__dirname, 'instance_preload.js')), false);
  assert.doesNotMatch(mainSource, /a0LauncherHost|launcher-host:/);
  assert.match(rendererPreloadSource, /reattachInstanceTab/);
  assert.match(rendererPreloadSource, /setDetachedInstanceContentVisible/);
  assert.match(mainSource, /instance-tabs\/detached\.html/);
  assert.match(mainSource, /detachedWindow\.setTitle\(tab\.title\)/);
  assert.match(mainSource, /detachedWindow\.contentView\.addChildView\(tab\.view\)/);
  assert.match(mainSource, /mainWindow\.contentView\.addChildView\(tab\.view\)/);
});

test('embedded Instance bounds convert page zoom and fill the current window', () => {
  const viewport = { x: 0, y: 47.2, width: 1163.64, height: 770.98 };
  for (const [zoom, y] of [[0.9, 42], [1, 47], [1.1, 52], [1.25, 59], [2, 94]]) {
    for (const bounds of [{ width: 1280, height: 900 }, { width: 1920, height: 1080 }]) {
      assert.deepEqual(embeddedInstanceContentBounds(bounds, viewport, zoom), {
        x: 0, y, width: bounds.width, height: bounds.height - y
      });
    }
  }
  assert.deepEqual(embeddedInstanceContentBounds(
    { width: 1280, height: 900 }, { x: 10.4, y: 47.2 }, 1.25
  ), { x: 13, y: 59, width: 1267, height: 841 });
  assert.deepEqual(embeddedInstanceContentBounds(
    { width: 20, height: 30 }, { x: 100, y: 47.2 }, 2
  ), { x: 20, y: 30, width: 0, height: 0 });
});

test('detached Instance content stays below the Launcher header and can hide for modals', () => {
  assert.deepEqual(detachedInstanceContentBounds({ width: 1280, height: 900 }), {
    x: 0,
    y: 47,
    width: 1280,
    height: 853
  });
  assert.deepEqual(detachedInstanceContentBounds({ width: 1280, height: 900 }, false), {
    x: 0,
    y: 0,
    width: 0,
    height: 0
  });
});

test('main-window bounds updates leave detached Instance views to their detached window', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(mainSource, /for \(const tab of instanceTabs\.values\(\)\) \{\s+if \(tab\.detached\) continue;/);
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

test('instance reload bypasses stale HTTP cache', () => {
  let reloads = 0;
  const webContents = {
    isDestroyed: () => false,
    reloadIgnoringCache: () => { reloads += 1; }
  };

  assert.equal(reloadInstanceWebContents(webContents), true);
  assert.equal(reloads, 1);
  assert.equal(reloadInstanceWebContents({ isDestroyed: () => true }), false);
});

test('Instance F5 shortcut accepts only key down', () => {
  assert.equal(isInstanceTabReloadShortcut({ type: 'keyDown', key: 'F5' }), true);
  assert.equal(isInstanceTabReloadShortcut({ type: 'keyUp', key: 'F5' }), false);
  assert.equal(isInstanceTabReloadShortcut({ type: 'keyDown', key: 'r' }), false);
});
