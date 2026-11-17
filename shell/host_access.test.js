const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  hostAccessInstanceKey,
  hostAccessMatchesGateway,
  normalizeBrowserSelection,
  normalizeHostFolder,
  normalizeHostAccessScopes,
  normalizeHostAccessSettings,
  resolveInstanceHostAccess
} = require('./host_access');

test('local creation defaults enable every scope except Browser without granting access to existing Instances', () => {
  const settings = normalizeHostAccessSettings({});
  assert.equal(settings.defaults.configured, true);
  assert.equal(settings.defaults.masterEnabled, true);
  assert.deepEqual(settings.defaults.scopes, {
    files: true, file_write: true, code_execution: true, computer_use: true, browser: false
  });
  const local = resolveInstanceHostAccess(settings, { kind: 'local', id: 'abc123' });

  assert.equal(local.configured, false);
  assert.equal(local.masterEnabled, false);
  assert.deepEqual(local.scopes, {
    files: true,
    file_write: true,
    code_execution: true,
    browser: false,
    computer_use: false
  });
});

test('Computer Use defaults preserve saved opt-outs and do not expand legacy Instance permissions', () => {
  const settings = normalizeHostAccessSettings({
    defaults: { scopes: { computer_use: false } },
    instances: {
      'local:legacy': { configured: true, scopes: { files: true } },
      'local:enabled': { configured: true, scopes: { computer_use: true } }
    }
  });
  assert.equal(settings.defaults.scopes.computer_use, false);
  assert.equal(settings.instances['local:legacy'].scopes.computer_use, false);
  assert.equal(settings.instances['local:enabled'].scopes.computer_use, true);
  assert.equal(normalizeHostAccessSettings({ instances: {
    'local:legacy': { configured: true }
  } }).instances['local:legacy'].scopes.computer_use, false);
});

test('saved disabled defaults and per-Instance choices survive the new creation default', () => {
  for (const defaults of [{ configured: false }, { masterEnabled: false }]) {
    const settings = normalizeHostAccessSettings({ defaults });
    assert.equal(settings.defaults.configured, false);
    assert.equal(settings.defaults.masterEnabled, false);
  }
  const settings = normalizeHostAccessSettings({ instances: {
    'local:off': { configured: false, masterEnabled: false },
    'local:legacy': { scopes: { files: true } },
    'remote:off': { configured: false, masterEnabled: false },
    'remote:on': { configured: true, masterEnabled: true, folder: '/work' }
  } });
  for (const kind of ['local', 'remote']) {
    assert.equal(resolveInstanceHostAccess(settings, { kind, id: 'off' }).configured, false);
    assert.equal(resolveInstanceHostAccess(settings, { kind, id: 'unknown' }).configured, false);
  }
  assert.equal(resolveInstanceHostAccess(settings, { kind: 'remote', id: 'on' }).configured, true);
  assert.equal(resolveInstanceHostAccess(settings, { kind: 'local', id: 'legacy' }).configured, false);
  assert.equal(resolveInstanceHostAccess(settings, { kind: 'local', id: 'unknown' }, {}).configured, false);
});

test('gateway startup is not gated by legacy onboarding state', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.doesNotMatch(source, /ONBOARDING_REQUIRED/);
  assert.doesNotMatch(source, /!settings\.onboardingComplete/);
});

test('local content prefers the sibling development CLI without overriding A0_CLI_PATH', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const resolver = source.slice(
    source.indexOf('function findA0CliBinary'),
    source.indexOf('function findCompatibleA0CliBinary')
  );
  assert.match(resolver, /const repoRoot = USING_LOCAL_CONTENT \? LOCAL_REPO_DIR : path\.resolve/);
  assert.match(resolver, /const preferredCandidates = USING_LOCAL_CONTENT\s*\? \[siblingBinary, commandBinary\]\s*: \[commandBinary, siblingBinary\]/);
  assert.match(resolver, /process\.env\.A0_CLI_PATH,\s*\.\.\.preferredCandidates/);
});

test('saved remote Instances stay server-side until explicitly configured', () => {
  const settings = normalizeHostAccessSettings({
    onboardingComplete: true,
    defaults: { configured: true, folder: '/home/alessandro/agent-zero' }
  });
  const remote = resolveInstanceHostAccess(settings, { kind: 'remote', id: 'vps-1' });

  assert.equal(remote.configured, false);
  assert.equal(remote.folder, '');
  assert.equal(remote.folderSource, '');
});

test('file write and Code execution follow their permission dependencies', () => {
  assert.deepEqual(normalizeHostAccessScopes({
    files: true,
    file_write: false,
    code_execution: true,
    browser: true,
    computer_use: false
  }), {
    files: true,
    file_write: false,
    code_execution: false,
    browser: true,
    computer_use: false
  });
});

test('legacy Files preferences retain their former read/write meaning', () => {
  assert.equal(normalizeHostAccessScopes({ files: true }).file_write, true);
  assert.equal(normalizeHostAccessScopes({ files: false }).file_write, false);
});

test('host folders reject control-character separators', () => {
  assert.equal(normalizeHostFolder('/home/user\0/escape'), '');
  assert.equal(normalizeHostFolder('/home/user\n/escape'), '');
});

test('legacy local CDP selections migrate to automatic detection', () => {
  assert.equal(
    normalizeBrowserSelection('ws://localhost:9222/devtools/browser/old-guid'),
    ''
  );
  assert.equal(normalizeBrowserSelection('chrome-cdp'), 'chrome-cdp');
  assert.equal(normalizeBrowserSelection('safari:default'), 'safari:default');
  assert.equal(
    normalizeBrowserSelection('ws://browser.example:9222/devtools/browser/custom'),
    'ws://browser.example:9222/devtools/browser/custom'
  );
});

test('instance settings and bind-mounted workspace resolve deterministically', () => {
  const settings = normalizeHostAccessSettings({
    defaults: { folder: '/home/default' },
    instances: {
      'local:abc123': {
        configured: true,
        folder: '/home/saved',
        scopes: { files: true, file_write: true, code_execution: false, browser: false, computer_use: true }
      }
    }
  });
  const local = resolveInstanceHostAccess(settings, {
    kind: 'local',
    id: 'abc123',
    folder: '/home/instance/usr'
  });

  assert.equal(hostAccessInstanceKey('local', 'abc123'), 'local:abc123');
  assert.equal(local.folder, '/home/instance/usr');
  assert.equal(local.folderSource, 'instance_workspace');
  assert.equal(local.scopes.code_execution, false);
});

test('saved Instance choices win, then the current tab, then local defaults', () => {
  const settings = normalizeHostAccessSettings({
    defaults: {
      configured: false,
      scopes: { browser: false, computer_use: false }
    },
    instances: {
      'local:saved': {
        configured: true,
        scopes: { browser: true, computer_use: true }
      }
    }
  });
  const staleTab = {
    configured: false,
    scopes: { browser: false, computer_use: false }
  };
  const currentTab = {
    configured: true,
    scopes: { browser: true, computer_use: true }
  };

  assert.equal(resolveInstanceHostAccess(settings, { kind: 'local', id: 'saved' }, staleTab).configured, true);
  assert.equal(resolveInstanceHostAccess(settings, { kind: 'local', id: 'current' }, currentTab).configured, true);
  assert.equal(resolveInstanceHostAccess(settings, { kind: 'local', id: 'default' }).configured, false);
});

test('empty or stale gateway snapshots do not match saved permission switches', () => {
  const saved = {
    masterEnabled: true,
    scopes: {
      files: true,
      file_write: true,
      code_execution: true,
      browser: true,
      computer_use: true
    }
  };

  assert.equal(hostAccessMatchesGateway(saved, { master_enabled: true, scopes: {} }), false);
  assert.equal(hostAccessMatchesGateway(saved, {
    master_enabled: true,
    scopes: { ...saved.scopes }
  }), true);
});
