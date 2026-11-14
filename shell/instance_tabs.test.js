const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const {
  normalizeInstanceColor,
  normalizeInstanceFavicon,
  loadInstanceFavicon,
  normalizeInstanceIcon,
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
  instanceTabZoomDelta,
  instanceTabShortcutTarget,
  embeddedInstanceContentBounds,
  detachedInstanceContentBounds
} = require('./instance_tabs');

test('Instance colours allow presets and six-digit RGB hex only', () => {
  assert.equal(normalizeInstanceColor(' Green '), 'green');
  assert.equal(normalizeInstanceColor(' #A1B2C3 '), '#a1b2c3');
  for (const value of ['#fff', '#12345678', '#zzzzzz', 'url(file:///tmp/image)', 'rgb(1,2,3)']) {
    assert.equal(normalizeInstanceColor(value), '');
  }
});

test('favicons accept bounded images from the Instance session and inline SVG', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>\u{1f680}</text></svg>';
  const inline = await loadInstanceFavicon(`data:image/svg+xml,${encodeURIComponent(svg)}`, 'https://example.com', fetch);
  assert.equal(inline, `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  const image = Buffer.from('image');
  const fetchImage = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'include');
    return new Response(image, { headers: { 'content-type': 'image/png' } });
  };
  assert.equal(await loadInstanceFavicon('https://example.com/icon.png', 'https://example.com/a0/', fetchImage),
    `data:image/png;base64,${image.toString('base64')}`);
  let forbiddenRequests = 0;
  const forbiddenFetch = () => { forbiddenRequests += 1; throw Error('Unexpected fetch'); };
  for (const url of ['file:///etc/passwd', 'https://other.example/icon.png',
    'https://user:pass@example.com/icon.png', 'data:text/html,<script>alert(1)</script>']) {
    assert.equal(await loadInstanceFavicon(url, 'https://example.com', forbiddenFetch), '');
  }
  assert.equal(forbiddenRequests, 0);
  for (const response of [
    new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    new Response(new Uint8Array(65537), { headers: { 'content-type': 'image/png' } }),
    new Response('missing', { status: 404, headers: { 'content-type': 'image/png' } })
  ]) assert.equal(await loadInstanceFavicon('https://example.com/icon', 'https://example.com', async () => response), '');
  assert.equal(await loadInstanceFavicon('https://example.com/icon', 'https://example.com', async () => { throw Error('Offline'); }), '');
  assert.equal(normalizeInstanceFavicon('data:text/html;base64,YQ=='), '');
  assert.equal(normalizeInstanceFavicon('https://example.com/icon.png'), '');
  assert.equal(normalizeInstanceIcon('language'), 'language');
  assert.equal(normalizeInstanceIcon('auto_awesome'), 'auto_awesome');
  assert.equal(normalizeInstanceIcon('favorite'), 'favorite');
  const tabs = new Map([['tab', { id: 'tab', icon: 'terminal', favicon: inline }]]);
  assert.equal(makeTabsSnapshot(tabs, 'tab').tabs[0].favicon, inline);
  assert.equal(makeTabsSnapshot(tabs, 'tab').tabs[0].icon, 'terminal');
});

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

test('foreground and restore repaint the attached page without reloading or revealing hidden tabs', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const updates = [];
  const paints = [];
  const makeTab = (id, extra = {}) => ({
    id, canReload: true, ...extra,
    view: {
      setBounds: bounds => updates.push({ id, ...bounds }),
      webContents: { invalidate: () => paints.push(id) }
    }
  });
  const tabs = new Map([
    ['active', makeTab('active')], ['inactive', makeTab('inactive')],
    ['detached', makeTab('detached', { detached: true })]
  ]);
  class Window extends EventEmitter {
    isDestroyed() { return false; }
    getContentBounds() { return { width: 1280, height: 900 }; }
    webContents = { getZoomFactor: () => 1 };
  }
  const context = vm.createContext({
    BrowserWindow: Window, path, __dirname, process, attachWindowDiagnostics: () => {},
    instanceTabs: tabs, activeInstanceTabId: 'active', instanceTabBounds: { x: 0, y: 47 },
    embeddedInstanceContentBounds
  });
  vm.runInContext(
    source.slice(source.indexOf('function createWindow('), source.indexOf('async function playSplashExitAnimation('))
    + source.slice(source.indexOf('function hideInstanceTabView('), source.indexOf('function destroyInstanceTab(')), context
  );
  await context.createWindow('app');
  for (const event of ['focus', 'restore', 'resize']) {
    updates.length = paints.length = 0;
    context.mainWindow.emit(event);
    assert.deepEqual(paints, ['active']);
    assert.deepEqual(updates, [
      { id: 'active', x: 0, y: 47, width: 1280, height: 853 },
      { id: 'inactive', x: 0, y: 0, width: 0, height: 0 }
    ]);
  }
  for (const hiddenState of [
    { instanceTabBounds: null },
    { instanceTabBounds: { x: 0, y: 47 }, activeInstanceTabId: '' }
  ]) {
    Object.assign(context, hiddenState);
    paints.length = 0;
    context.mainWindow.emit('focus');
    assert.deepEqual(paints, []);
  }
});

test('detached windows repaint on focus and restore while respecting modal visibility', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  let bounds;
  let paints = 0;
  class Window extends EventEmitter {
    isDestroyed() { return false; }
    getContentBounds() { return { width: 1280, height: 900 }; }
    webContents = new EventEmitter();
    async loadURL() {}
    setTitle() {}
  }
  const context = vm.createContext({
    BrowserWindow: Window, path, __dirname, process, attachWindowDiagnostics: () => {},
    detachedInstanceContentBounds
  });
  vm.runInContext(source.slice(source.indexOf('function applyDetachedInstanceBounds('),
    source.indexOf('const INSTANCE_CONTEXT_MENU_ITEMS')), context);
  const tab = {
    id: 'detached', title: 'Instance', canReload: true,
    view: { setBounds: value => { bounds = value; }, webContents: { invalidate: () => { paints += 1; } } }
  };
  tab.detachedWindow = await context.openDetachedInstanceWindow(tab);
  for (const event of ['focus', 'restore', 'resize']) {
    const previousPaints = paints;
    tab.detachedWindow.emit(event);
    assert.equal(paints, previousPaints + 1);
    assert.deepEqual(bounds, { x: 0, y: 47, width: 1280, height: 853 });
  }
  tab.detachedContentVisible = false;
  tab.detachedWindow.emit('focus');
  assert.deepEqual(bounds, { x: 0, y: 0, width: 0, height: 0 });
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

test('Instance zoom shortcuts support platform modifiers, plus, minus, numpad, and reset', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const modifier = platform === 'darwin' ? { meta: true } : { control: true };
    const input = (key, extra = {}) => ({ type: 'keyDown', key, ...modifier, ...extra });
    for (const key of ['+', '=']) assert.equal(instanceTabZoomDelta(input(key), platform), 0.5);
    assert.equal(instanceTabZoomDelta(input('+', { shift: true }), platform), 0.5);
    assert.equal(instanceTabZoomDelta(input('-'), platform), -0.5);
    assert.equal(instanceTabZoomDelta(input('Add', { code: 'NumpadAdd' }), platform), 0.5);
    assert.equal(instanceTabZoomDelta(input('Subtract', { code: 'NumpadSubtract' }), platform), -0.5);
    assert.equal(instanceTabZoomDelta(input('0'), platform), 0);
    for (const value of [
      input('+', { type: 'keyUp' }), input('+', { alt: true }), input('0', { shift: true }),
      input('+', { control: true, meta: true }), input('x'),
      input('+', { control: false, meta: false }),
      input('+', platform === 'darwin' ? { control: true, meta: false } : { control: false, meta: true })
    ]) assert.equal(instanceTabZoomDelta(value, platform), null);
  }
});

test('zoom input targets the visible Instance from its page or shell and leaves other surfaces alone', () => {
  const contents = () => Object.assign(new EventEmitter(), {
    zoom: 0,
    isDestroyed: () => false,
    getZoomLevel() { return this.zoom; },
    setZoomLevel(value) { this.zoom = value; }
  });
  const main = contents();
  const active = { id: 'active', view: { webContents: contents() } };
  const inactive = { id: 'inactive', view: { webContents: contents() } };
  const detached = {
    id: 'detached', detached: true, view: { webContents: contents() },
    detachedWindow: { webContents: contents() }
  };
  const unrelated = contents();
  const app = new EventEmitter();
  const context = vm.createContext({
    app, mainWindow: { webContents: main }, activeInstanceTabId: active.id,
    instanceTabs: new Map([active, inactive, detached].map(tab => [tab.id, tab])),
    instanceTabBounds: { x: 0, y: 47 }, findInstanceTabByWebContents,
    instanceTabZoomDelta, instanceTabShortcutTarget, isInstanceTabReloadShortcut
  });
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf("app.on('web-contents-created'"),
    source.indexOf('// App lifecycle')), context);
  for (const wc of [main, active.view.webContents, inactive.view.webContents,
    detached.view.webContents, detached.detachedWindow.webContents, unrelated]) {
    app.emit('web-contents-created', {}, wc);
  }
  const zoom = (wc, key) => {
    let prevented = false;
    wc.emit('before-input-event', { preventDefault: () => { prevented = true; } }, {
      type: 'keyDown', key, control: process.platform !== 'darwin', meta: process.platform === 'darwin'
    });
    return prevented;
  };
  assert.equal(zoom(main, '+'), true);
  assert.equal(active.view.webContents.zoom, 0.5);
  assert.equal(zoom(active.view.webContents, '-'), true);
  assert.equal(active.view.webContents.zoom, 0);
  zoom(main, '+');
  assert.equal(zoom(main, '0'), true);
  assert.equal(active.view.webContents.zoom, 0);
  assert.equal(zoom(detached.detachedWindow.webContents, '+'), true);
  assert.equal(detached.view.webContents.zoom, 0.5);
  assert.equal(zoom(detached.view.webContents, '-'), true);
  assert.equal(detached.view.webContents.zoom, 0);
  assert.equal(main.zoom, 0);
  assert.equal(detached.detachedWindow.webContents.zoom, 0);
  assert.equal(zoom(inactive.view.webContents, '+'), false);
  assert.equal(zoom(unrelated, '+'), false);
  context.instanceTabBounds = null;
  assert.equal(zoom(main, '+'), false);
  assert.equal(zoom(active.view.webContents, '+'), false);
  context.instanceTabBounds = { x: 0, y: 47 };
  active.loading = true;
  assert.equal(zoom(main, '+'), false);
  active.canReload = true;
  assert.equal(zoom(main, '+'), true);
  active.view.webContents.isDestroyed = () => true;
  assert.equal(zoom(main, '+'), false);
  context.activeInstanceTabId = '';
  assert.equal(zoom(main, '+'), false);
  detached.detachedContentVisible = false;
  assert.equal(zoom(detached.detachedWindow.webContents, '+'), false);
});

test('tab shortcuts follow visible order, wrap, and respect platform modifiers', () => {
  const tabs = new Map([
    ['first', { id: 'first' }],
    ['detached', { id: 'detached', detached: true }],
    ['second', { id: 'second' }]
  ]);
  const key = (key, modifiers = {}) => ({ type: 'keyDown', key, ...modifiers });
  for (const platform of ['linux', 'win32', 'darwin']) {
    const modifier = platform === 'darwin' ? { meta: true } : { control: true };
    const target = (input, active = '') => instanceTabShortcutTarget(input, tabs, active, platform);
    assert.equal(target(key('1', modifier), 'second'), '');
    assert.equal(target(key('2', modifier)), 'first');
    assert.equal(target(key('3', modifier)), 'second');
    assert.equal(target(key('9', modifier)), null);
    assert.equal(target(key('&', { ...modifier, code: 'Digit1' })), '');
    assert.equal(target(key('Tab', { control: true })), 'first');
    assert.equal(target(key('Tab', { control: true }), 'second'), '');
    assert.equal(target(key('Tab', { control: true, shift: true })), 'second');
    assert.equal(target(key('Tab', { control: true, shift: true }), 'second'), 'first');
    for (const input of [
      key('2'), key('2', { ...modifier, alt: true }),
      key('2', { ...modifier, shift: true }), key('2', { control: true, meta: true }),
      key('2', platform === 'darwin' ? { control: true } : { meta: true }),
      key('Tab', { meta: true }), { ...key('2', modifier), type: 'keyUp' }
    ]) assert.equal(target(input), null);
  }
  const reordered = reorderAttachedInstanceTabs(tabs, ['second', 'first']);
  assert.equal(instanceTabShortcutTarget(key('2', { control: true }), reordered, '', 'linux'), 'second');
  assert.equal(instanceTabShortcutTarget(key('Tab', { control: true }), new Map(), '', 'linux'), null);
  const many = new Map(Array.from({ length: 10 }, (_, i) => [`tab-${i}`, { id: `tab-${i}` }]));
  assert.equal(instanceTabShortcutTarget(key('9', { control: true }), many, '', 'linux'), 'tab-7');
});

test('remote URL edits close attached and detached surfaces and their gateway leases after saving', async () => {
  let remote = { id: 'remote-1', url: 'https://old.example.com/' };
  const closed = [];
  const stopped = [];
  const tabs = new Map(['attached', 'detached', 'other'].map(id => [id, {
    id, kind: 'remote', instanceId: id === 'other' ? 'remote-2' : remote.id,
    detachedWindow: id === 'detached' ? { isDestroyed: () => false, close: () => closed.push('window') } : null,
    view: { webContents: { isDestroyed: () => false, close: () => closed.push(id) } }
  }]));
  const handlers = new Map();
  const context = vm.createContext({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dockerManager: {
      getRemoteInstance: async () => remote,
      updateRemoteInstance: async (_id, patch) => {
        if (patch.url === 'invalid') throw new Error('Invalid URL');
        remote = { ...remote, ...patch };
        return remote;
      },
      toErrorResponse: error => ({ error: error.message })
    },
    isPlainObject: value => value !== null && typeof value === 'object',
    sanitizeDockerManagerState: value => value,
    instanceTabs: tabs,
    activeInstanceTabId: 'attached',
    mainWindow: null,
    hostGatewaySupervisor: { stop: id => stopped.push(id) },
    hostGatewayLeaseKey: tab => tab.id,
    firstEmbeddedInstanceTabId: () => 'other',
    applyActiveInstanceTabBounds: () => {},
    sendInstanceTabsEvent: () => {},
    getInstanceTabsSnapshot: () => ({})
  });
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  vm.runInContext(
    source.slice(source.indexOf('function destroyInstanceTab('), source.indexOf('function cleanupInstanceTabs('))
    + source.slice(source.indexOf('function closeInstanceTab('), source.indexOf('function reloadInstanceTab('))
    + source.slice(source.indexOf("ipcMain.handle('docker-manager:updateRemoteInstance'"),
      source.indexOf("ipcMain.handle('docker-manager:certificateTrustRestartRequired'")), context
  );
  const update = patch => handlers.get('docker-manager:updateRemoteInstance')({}, { id: remote.id, ...patch });
  await update({ name: 'Renamed', allowUntrustedCertificate: true });
  assert.equal((await update({ url: 'invalid' })).error, 'Invalid URL');
  assert.equal(tabs.size, 3);
  const saved = await update({ url: 'https://new.example.com/' });
  assert.equal(saved.url, 'https://new.example.com/');
  assert.deepEqual([...tabs.keys()], ['other']);
  assert.deepEqual(stopped, ['attached', 'detached']);
  assert.deepEqual(closed, ['attached', 'window', 'detached']);
});

test('remote login rechecks the saved origin and view after awaiting credentials', async () => {
  let url = 'https://old.example.com/';
  let destroyed = false;
  const credentials = { username: 'user', password: 'test-password' };
  const requests = [];
  const manager = {
    getRemoteInstanceCredentials: async () => credentials,
    getRemoteInstance: async () => ({ url })
  };
  const context = vm.createContext({
    dockerManager: manager, webUiLoginRequestForTarget, isAllowedInstanceTabNavigationUrl, cliCredentialsAllowedForTarget,
    credentialsErrorShouldBlockCli: () => true,
    createTabTargetError: (code, message) => Object.assign(new Error(message), { code })
  });
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function remoteInstanceCredentialsForCli('),
    source.indexOf('function openA0CliTerminalWindows(')), context);
  const target = { kind: 'remote', instanceId: 'remote-1', url };
  const wc = {
    isDestroyed: () => destroyed,
    session: { fetch: async (url, options) => { requests.push({ url, options }); return { status: 302 }; } }
  };
  assert.equal((await context.loginInstanceWebUiSession(target, wc)).succeeded, true);
  let releaseCredentials;
  manager.getRemoteInstanceCredentials = () => new Promise(resolve => { releaseCredentials = resolve; });
  const pending = context.loginInstanceWebUiSession(target, wc);
  url = 'https://new.example.com/';
  releaseCredentials(credentials);
  assert.equal((await pending).attempted, false);
  manager.getRemoteInstanceCredentials = async () => credentials;
  await assert.rejects(context.instanceCredentialsForCliTarget(target), { code: 'INSTANCE_CHANGED' });
  destroyed = true;
  assert.equal((await context.loginInstanceWebUiSession({ ...target, url }, wc)).attempted, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://old.example.com/login');
});

test('a gateway cannot start after its tab closes while credentials are loading', async () => {
  const tab = { id: 'tab', kind: 'remote', instanceId: 'remote-1' };
  const tabs = new Map([[tab.id, tab]]);
  let starts = 0;
  const context = vm.createContext({
    instanceTabs: tabs,
    hostAccessIdentity: () => ({ kind: 'remote', id: 'remote-1' }),
    dockerManager: { getHostAccessSettings: async () => ({}) },
    resolveInstanceHostAccess: () => ({ configured: true }),
    pendingComputerUseSetup: new Set(),
    resolveTabHostWorkspace: async () => ({ path: '/test-workspace' }),
    ensureA0CliInstalled: async () => {},
    findA0CliBinary: () => '/test-cli',
    gatewayHostForTab: () => 'https://old.example.com/',
    coreSupportsLauncherGateway: async () => true,
    instanceCredentialsForCliTarget: async () => { tabs.delete(tab.id); return {}; },
    gatewayIdForTab: () => 'gateway',
    hostGatewayLeaseKey: () => tab.id,
    a0CliLaunchEnv: () => ({}),
    os: { hostname: () => 'test-host' },
    hostGatewaySupervisor: { start: () => { starts += 1; } },
    setTabHostAccess: () => {}
  });
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function startHostGatewayForTab('),
    source.indexOf('async function restartHostGatewayForTab(')), context);
  assert.equal(await context.startHostGatewayForTab(tab), null);
  assert.equal(starts, 0);
});
