import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const {
  bindHostAccessState,
  bindScopeDependency,
  browserSetupAvailable,
  browserSetupHint,
  browserSelectionPresentation,
  browserSupportDetail,
  browserSupportMessage,
  capabilityReadinessLabel,
  capabilityStatusLabel,
  computerUseNeedsArm,
  computerUseSetupState,
  configForTarget,
  hostAccessActionMessage,
  normalizeConfig,
  normalizeScopes,
  scopeFieldsHtml,
  watchBrowserSetupFailure
} = await import('./host-access-dialog.js');

test('scope dependency binding tolerates non-parsing test and fallback DOMs', () => {
  assert.doesNotThrow(() => bindScopeDependency(null));
});

test('scope binding keeps the permission summary current', () => {
  const controls = Object.fromEntries(Object.entries({
    files: true,
    file_write: true,
    code_execution: true,
    browser: false,
    computer_use: false
  }).map(([key, checked]) => [key, {
    checked,
    addEventListener(_type, listener) { this.change = listener; }
  }]));
  const summary = {};
  const configured = {
    checked: false,
    addEventListener(_type, listener) { this.change = listener; }
  };
  const scopes = {};
  const root = {
    querySelector(selector) {
      if (selector === '[data-host-scope-summary]') return summary;
      if (selector === '#hostAccessConfigured') return configured;
      if (selector === '.dm-host-access-scopes') return scopes;
      return controls[selector.match(/data-host-scope="([^"]+)"/)?.[1]] || null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-host-config-control]') return [];
      const fields = Object.values(controls);
      return selector.endsWith(':checked') ? fields.filter((field) => field.checked) : fields;
    }
  };

  bindScopeDependency(root);
  controls.browser.checked = true;
  controls.browser.change();
  assert.equal(summary.textContent, 'On: Read, Write, Code, Browser · Off: Computer Use');

  bindHostAccessState(root, { configuredSelector: '#hostAccessConfigured' });
  assert.equal(scopes.disabled, true);
  assert.equal(summary.textContent, 'Host access off');
  configured.checked = true;
  configured.change();
  assert.equal(summary.textContent, 'On: Read, Write, Code, Browser · Off: Computer Use');
});

test('local Host access inherits defaults while remote Host access stays off with a folder prefill', () => {
  const state = {
    hostAccess: {
      defaults: {
        configured: true,
        masterEnabled: true,
        folder: '/home/user/agent-zero',
        scopes: { files: true, file_write: true, code_execution: true, browser: true, computer_use: true }
      },
      instances: {}
    }
  };

  assert.equal(configForTarget(state, { kind: 'local', containerId: 'abc' }).configured, true);
  assert.equal(configForTarget(state, { kind: 'remote', instanceId: 'vps' }).configured, false);
  assert.equal(configForTarget(state, { kind: 'remote', instanceId: 'vps' }).folder, '/home/user/agent-zero');
});

test('saved Instance choices win over stale runtime gateway configuration', () => {
  const saved = {
    configured: true,
    masterEnabled: true,
    scopes: { files: true, file_write: true, code_execution: true, browser: true, computer_use: true }
  };
  const state = {
    hostAccess: {
      defaults: { configured: false, masterEnabled: false },
      instances: { 'local:abc': saved }
    }
  };
  const config = configForTarget(state, {
    kind: 'local',
    containerId: 'abc',
    hostAccess: {
      config: {
        configured: false,
        masterEnabled: false,
        scopes: { files: false, file_write: false, code_execution: false, browser: false, computer_use: false }
      }
    }
  });

  assert.equal(config.configured, true);
  assert.equal(config.scopes.browser, true);
  assert.equal(config.scopes.computer_use, true);
});

test('File write controls Code execution without hiding file reads', () => {
  assert.deepEqual(normalizeScopes({
    files: true,
    file_write: false,
    code_execution: true,
    browser: false,
    computer_use: true
  }), {
    files: true,
    file_write: false,
    code_execution: false,
    browser: false,
    computer_use: true
  });
  assert.equal(normalizeConfig({}, {}, 'local').configured, false);
  assert.equal(normalizeConfig({}, {}, 'local').masterEnabled, false);
  assert.equal(normalizeConfig({}, {}, 'remote').configured, false);
});

test('Host permissions use one collapsed native disclosure', () => {
  const html = scopeFieldsHtml('host', {
    files: true,
    file_write: true,
    code_execution: true,
    browser: false,
    computer_use: false
  }, {
    masterContent: '<label data-master>All permissions</label>',
    detailsContent: '<div data-folder>Folder</div>'
  });
  assert.match(html, /<details class="dm-advanced dm-host-access-permissions">/);
  assert.match(html, /<summary>Host permissions <span data-host-scope-summary>On: Read, Write, Code · Off: Browser, Computer Use<\/span><\/summary>/);
  assert.match(html, /<label data-master>[\s\S]*<fieldset[\s\S]*<div data-folder>Folder<\/div>\s*<\/details>/);
  assert.equal(html.match(/dm-host-access-toggler/g)?.length, 5);
  assert.doesNotMatch(html, /<details[^>]* open/);
});

test('Host access uses per-Instance opt-in without a duplicate global onboarding dialog', async () => {
  const source = await readFile(new URL('./host-access-dialog.js', import.meta.url), 'utf8');
  const rendererSource = await readFile(new URL('../../docker_manager.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /hostAccessOnboarding|openHostAccessOnboarding/);
  assert.doesNotMatch(rendererSource, /maybeOpenHostAccessOnboarding/);
});

test('Advanced Host access details start collapsed with a short summary', async () => {
  const source = await readFile(new URL('./host-access-dialog.js', import.meta.url), 'utf8');
  assert.match(source, /<details class="dm-advanced dm-host-access-advanced">/);
  assert.match(source, /<summary>Advanced settings <span>Browser and connection details<\/span><\/summary>/);
  assert.match(source, /dm-host-access-advanced[\s\S]*Browser to use[\s\S]*dm-host-access-diagnostics/);
  assert.doesNotMatch(source, /<details[^>]*dm-host-access-advanced[^>]* open/);
});

test('Host access keeps its master switch inside Host permissions', async () => {
  const source = await readFile(new URL('./host-access-dialog.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /hostAccessMaster|Host access active/);
  assert.doesNotMatch(source, /Allow this Instance to use this computer/);
  assert.match(source, /masterContent: switchLineHtml\(\s*"hostAccessConfigured",\s*"All permissions",\s*"Master switch"/);
  assert.match(source, /configured: enabled,\s+masterEnabled: enabled/);
});

test('Host access settings can open from a saved Instance without a live tab', async () => {
  const source = await readFile(new URL('./host-access-dialog.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!instanceKey\(tab\)\) return false/);
  assert.doesNotMatch(source, /if \(!tab\?\.id\) return false/);
  assert.match(source, /disconnectedWithoutTab && configured \? "Ready to connect"/);
  assert.match(source, /Open this Instance in a Launcher tab to connect\./);
  assert.match(source, /enabled \? "Ready to connect" : "Disconnected"/);
});

test('Host capability statuses are human labels and arm only when actionable', () => {
  assert.equal(capabilityStatusLabel('ready', 'Unknown'), 'Ready');
  assert.equal(capabilityStatusLabel('persistent', 'Unknown'), 'Ready');
  assert.equal(computerUseNeedsArm('persistent'), false);
  assert.equal(computerUseNeedsArm('rearm required'), true);
  assert.equal(computerUseNeedsArm('approval_required'), true);
  assert.equal(computerUseNeedsArm('unsupported'), false);
  assert.equal(capabilityReadinessLabel(false, { status: 'ready' }), 'Not allowed');
  assert.equal(capabilityReadinessLabel(true, { status: 'ready' }), 'Allowed · Ready');
  assert.equal(capabilityReadinessLabel(true, { status: 'disabled' }), 'Allowed · Setup needed');
});

test('Computer Use readiness stays separate from the saved permission choice', () => {
  const config = {
    configured: true,
    masterEnabled: true,
    scopes: { computer_use: true }
  };
  const setupNeeded = computerUseSetupState(config, {
    gateway: {
      features: ['computer_use_setup_v1'],
      status: {
        computer_use: {
          status: 'approval required',
          setup: {
            state: 'accessibility_required',
            accessibility: 'required',
            screen_recording: 'unknown'
          }
        }
      }
    }
  });
  const ready = computerUseSetupState(config, {
    gateway: {
      features: ['computer_use_setup_v1'],
      status: { computer_use: { setup: { state: 'ready' } } }
    }
  });
  const checking = computerUseSetupState(config, {
    gateway: {
      features: ['computer_use_setup_v1'],
      status: { computer_use: { backend_family: 'windows', setup: { state: 'checking' } } }
    }
  });
  const checkingMacos = computerUseSetupState(config, {
    gateway: {
      features: ['computer_use_setup_v1'],
      status: { computer_use: { backend_family: 'macos', setup: { state: 'checking' } } }
    }
  });

  assert.equal(setupNeeded.allowed, true);
  assert.equal(setupNeeded.label, 'Allowed · Setup needed');
  assert.equal(setupNeeded.canSetup, true);
  assert.equal(setupNeeded.actionLabel, 'Open Accessibility Settings');
  assert.equal(setupNeeded.prompt, true);
  assert.equal(checking.label, 'Allowed · Checking');
  assert.equal(checking.canSetup, false);
  assert.equal(checking.checkingMessage, 'Checking Computer Use…');
  assert.equal(checkingMacos.checkingMessage, 'Checking macOS permissions…');
  assert.equal(ready.label, 'Allowed · Ready');
  assert.equal(ready.canSetup, false);
  assert.equal(ready.prompt, false);
});

test('Needs action shows the actual capability reason', () => {
  const config = {
    configured: true,
    masterEnabled: true,
    scopes: { browser: true, computer_use: true }
  };
  assert.equal(hostAccessActionMessage(config, {
    state: 'needs_action',
    gateway: {
      features: ['computer_use_setup_v1'],
      status: {
        browser: {
          status: 'relaunch_required',
          message: 'Close Chrome before preparing this profile.'
        },
        computer_use: { setup: { state: 'ready' } }
      }
    }
  }), 'Close Chrome before preparing this profile.');
  assert.equal(hostAccessActionMessage(config, {
    state: 'needs_action',
    gateway: {
      features: ['computer_use_setup_v1'],
      status: {
        browser: { status: 'ready' },
        computer_use: {
          setup: {
            state: 'accessibility_required',
            message: 'Allow Agent Zero Launcher in macOS Accessibility settings.'
          }
        }
      }
    }
  }), 'Allow Agent Zero Launcher in macOS Accessibility settings.');
  assert.equal(hostAccessActionMessage(config, { state: 'needs_action' }), 'Finish Computer Use setup below.');
  assert.equal(hostAccessActionMessage(config, {
    state: 'connected',
    gateway: {
      features: ['computer_use_setup_v1'],
      status: {
        browser: { status: 'ready' },
        computer_use: { backend_family: 'windows', setup: { state: 'checking' } }
      }
    }
  }), 'Checking Computer Use…');
});

test('Missing host Playwright becomes a Launcher repair action', () => {
  const legacy = {
    support_reason: 'Python Playwright is not installed in the A0 CLI host environment (/tmp/python). Run /browser repair.'
  };
  const current = {
    support_reason: 'Browser support is incomplete in the A0 CLI host environment (/tmp/python). Use the current Browser setup action.'
  };

  assert.equal(browserSupportMessage(legacy), 'Browser support needs repair. Choose Set up browser.');
  assert.equal(browserSupportMessage(current), 'Browser support needs repair. Choose Set up browser.');
  assert.equal(browserSupportMessage({ message: 'Close Chrome before continuing.' }), 'Close Chrome before continuing.');
  assert.equal(browserSetupAvailable({ can_prepare: false, can_repair: true }), true);
  assert.equal(browserSetupAvailable({ can_prepare: false, support_reason: legacy.support_reason }), true);
  assert.equal(browserSetupAvailable({ can_prepare: false }), false);
});

test('Browser diagnostics stay hidden while Use my Browser is off', () => {
  const browser = {
    status: 'unsupported',
    support_reason: 'No installed Chromium-family browser profile was detected.'
  };
  const disabledConfig = {
    configured: true,
    masterEnabled: true,
    scopes: { browser: false, computer_use: false }
  };

  assert.equal(browserSupportDetail(false, browser), '');
  assert.equal(browserSupportDetail(true, browser), browser.support_reason);
  assert.equal(hostAccessActionMessage(disabledConfig, {
    state: 'needs_action',
    message: browser.support_reason,
    gateway: { status: { browser } }
  }), '');
});

test('Browser setup explains how to enable remote debugging when no endpoint is open', () => {
  const hint = browserSetupHint({
    available_browsers: [{ label: 'Google Chrome - Default', cdp_endpoint: '' }]
  });

  assert.match(hint, /Chrome or Chromium at chrome:\/\/inspect\/#remote-debugging/);
  assert.match(hint, /Edge at edge:\/\/inspect\/#remote-debugging/);
  assert.match(hint, /Opera at opera:\/\/inspect\/#remote-debugging/);
  assert.match(hint, /Brave and Vivaldi are supported too/);
  assert.match(hint, /Allow remote debugging for this browser instance/);
  assert.equal(browserSetupHint({ cdp_endpoint: 'ws://localhost:9222/devtools/browser/test' }), '');
  assert.equal(browserSetupHint({
    available_browsers: [{ cdp_endpoint: 'ws://localhost:9333/devtools/browser/test' }]
  }), '');
  assert.match(browserSetupHint({ available_browsers: [] }), /Install Chrome, Chromium, Edge, Brave, Opera, or Vivaldi/);
  assert.match(browserSetupHint({
    browser_family: 'safari',
    browser_id: 'safari:default',
    available_browsers: [{ family: 'safari', id: 'safari:default' }]
  }), /Safari > Settings > Advanced.*Show features for web developers.*Developer.*Allow remote automation/);
});

test('Controlled profiles use automatic setup independently of personal Chrome debugging', () => {
  for (const browser of [
    { browser_family: 'chrome-a0' },
    { browser_id: 'edge-a0:default' },
    { available_browsers: [{ family: 'brave-a0' }] },
    { browser_family: 'chrome-a0', available_browsers: [{ cdp_endpoint: 'ws://localhost:9222/devtools/browser/personal' }] }
  ]) {
    const hint = browserSetupHint(browser);
    assert.match(hint, /separate browser profile and connects automatically/);
    assert.doesNotMatch(hint, /Turn on|chrome:\/\/inspect/);
  }
  assert.match(browserSetupHint({
    browser_family: 'edge',
    available_browsers: [{ cdp_endpoint: 'ws://localhost:9222/devtools/browser/personal' }]
  }), /Allow remote debugging/);
});

test('A changed browser never inherits the saved profiles failure or readiness', () => {
  const failed = { status: 'unsupported', support_reason: 'Default profile blocked' };
  const pending = browserSelectionPresentation('chrome:default', 'chrome-a0:default', failed, true);
  assert.equal(pending.pending, true);
  assert.equal(pending.readiness, 'Not applied');
  assert.equal(pending.saveLabel, 'Save and connect');
  assert.doesNotMatch(pending.detail, /Default profile blocked/);
  assert.match(pending.detail, /previous selection/);
  const refreshed = browserSelectionPresentation('chrome:default', 'chrome-a0:default', { status: 'ready' }, true);
  assert.equal(refreshed.readiness, 'Not applied');
  const saved = browserSelectionPresentation('chrome-a0:default', 'chrome-a0:default', { status: 'ready' }, true);
  assert.equal(saved.pending, false);
  assert.equal(saved.readiness, 'Allowed · Ready');
  const reverted = browserSelectionPresentation('chrome:default', 'chrome:default', failed, true);
  assert.equal(reverted.pending, false);
  assert.equal(reverted.detail, 'Default profile blocked');
});

test('Browser setup preserves the actual failure for a controlled profile', () => {
  let stateListener;
  let toast;
  let removed = false;
  const originalWindow = globalThis.window;
  globalThis.window = {
    addEventListener(type, listener) {
      if (type === 'dm:state') stateListener = listener;
    },
    removeEventListener(type, listener) {
      if (type === 'dm:state' && listener === stateListener) removed = true;
    },
    setTimeout() { return 1; },
    clearTimeout() {},
    toastFrontendInfo(...args) { toast = args; }
  };

  try {
    watchBrowserSetupFailure('instance-tab-1', { browser_family: 'chrome-a0' });
    stateListener({
      detail: {
        instanceTabs: {
          tabs: [{ id: 'instance-tab-1', hostAccess: {
            code: 'GATEWAY_COMMAND_FAILED', message: 'The selected profile is still locked.'
          } }]
        }
      }
    });
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }

  assert.equal(toast[0], 'The selected profile is still locked.');
  assert.deepEqual(toast.slice(1), ['Set up browser', 12, 'dm-host-browser-setup']);
  assert.equal(removed, true);
});

test('Host access UI uses five friendly permissions and visible action reasons', async () => {
  const source = await readFile(new URL('./host-access-dialog.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Host access works only while the current Instance is open/i);
  assert.match(source, /data-host-action-notice/);
  assert.match(source, /Files read/);
  assert.match(source, /Files write/);
  assert.match(source, /Use my Browser/);
  assert.match(source, /Commands start here but can reach other folders/i);
  assert.match(source, /Folder for files and commands/);
  assert.match(source, /Launcher setup needs attention/);
  assert.match(source, /data-browser-readiness/);
  assert.match(source, /data-computer-use-readiness/);
  assert.match(source, /Allowed · Setup needed/);
  assert.doesNotMatch(source, /data-install-cli/);
  assert.doesNotMatch(source, /2\.5 or newer/);
  assert.doesNotMatch(source, /Personal browser/);
  assert.match(source, /candidate\?\.browser_id \|\| candidate\?\.id/);
  assert.match(source, /candidate\?\.browser_label \|\| candidate\?\.label/);
  assert.match(source, /notice\.textContent = computerSetup\.checkingMessage/);
});

test('Host access settings temporarily hide the active Instance view without selecting Launcher home', async () => {
  const dialogSource = await readFile(new URL('./host-access-dialog.js', import.meta.url), 'utf8');
  const tabsSource = await readFile(new URL('./instance-tabs/instance-tabs.js', import.meta.url), 'utf8');
  const detachedSource = await readFile(new URL('./instance-tabs/detached.js', import.meta.url), 'utf8');
  const rendererSource = await readFile(new URL('../../docker_manager.js', import.meta.url), 'utf8');
  assert.match(dialogSource, /hideInstanceTabView\?\.\(\)/);
  assert.match(dialogSource, /syncInstanceTabBounds\?\.\(\)/);
  assert.match(tabsSource, /openHostAccessDialog\(tab, window\.__dmLastState \|\| state\)/);
  assert.match(detachedSource, /openHostAccessDialog\(tab, window\.__dmLastState/);
  assert.doesNotMatch(rendererSource, /dm:open-host-access/);
});

test('Instance headers own Host access, name collapse, and detached reattach controls', async () => {
  const dialogSource = await readFile(new URL('./host-access-dialog.js', import.meta.url), 'utf8');
  const tabsSource = await readFile(new URL('./instance-tabs/instance-tabs.js', import.meta.url), 'utf8');
  const detachedHtml = await readFile(new URL('./instance-tabs/detached.html', import.meta.url), 'utf8');

  assert.match(tabsSource, /dm-instance-tab-host/);
  assert.match(tabsSource, /hostState === "connected"/);
  assert.match(tabsSource, /Hide tab names/);
  assert.doesNotMatch(tabsSource, /dm-host-status-dot/);
  assert.match(dialogSource, /data-disconnect>Disconnect/);
  assert.match(dialogSource, /data-reconnect>Reconnect/);
  assert.match(dialogSource, /dm-host-access-summary[\s\S]*\$\{connectionAction\}/);
  assert.match(dialogSource, /hostGatewayCommand\?\.\(tab\.id, "disconnect"\)/);
  assert.match(dialogSource, /hostGatewayCommand\?\.\(tab\.id, "reconnect"\)/);
  assert.match(detachedHtml, /detachedInstanceName/);
  assert.match(detachedHtml, /detachedInstanceIcon/);
  assert.match(detachedHtml, /detachedHostAccess/);
  assert.match(detachedHtml, /detachedReattach/);
});
