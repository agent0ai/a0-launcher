import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizedRuntimeGate,
  renderRuntimeGate,
  shouldShowRuntimeGate
} from './runtime-gate.js';

class MiniEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.key = options.key || '';
    this.shiftKey = !!options.shiftKey;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.target = null;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

class MiniClassList {
  constructor(element) {
    this.element = element;
  }

  values() {
    return String(this.element.className || '').split(/\s+/).filter(Boolean);
  }

  write(values) {
    this.element.className = [...new Set(values)].join(' ');
  }

  add(...classes) {
    this.write([...this.values(), ...classes.filter(Boolean)]);
  }

  remove(...classes) {
    const remove = new Set(classes);
    this.write(this.values().filter((item) => !remove.has(item)));
  }

  contains(value) {
    return this.values().includes(value);
  }

  toggle(value, force) {
    const has = this.contains(value);
    const shouldAdd = force === undefined ? !has : !!force;
    if (shouldAdd) this.add(value);
    else this.remove(value);
    return shouldAdd;
  }
}

class MiniElement {
  constructor(tagName, ownerDocument = null) {
    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.id = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.inert = false;
    this.tabIndex = undefined;
    this.listeners = new Map();
    this.classList = new MiniClassList(this);
  }

  appendChild(child) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((item) => item !== child);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name, value) {
    const key = String(name || '');
    const text = String(value);
    this.attributes.set(key, text);
    if (key === 'id') this.id = text;
    if (key === 'class') this.className = text;
    if (key === 'disabled') this.disabled = true;
    if (key === 'hidden') this.hidden = true;
    if (key === 'tabindex') this.tabIndex = Number(text);
  }

  getAttribute(name) {
    return this.attributes.get(String(name || '')) || null;
  }

  removeAttribute(name) {
    const key = String(name || '');
    this.attributes.delete(key);
    if (key === 'disabled') this.disabled = false;
    if (key === 'hidden') this.hidden = false;
  }

  addEventListener(type, handler) {
    const key = String(type || '');
    const list = this.listeners.get(key) || [];
    list.push(handler);
    this.listeners.set(key, list);
  }

  dispatchEvent(event) {
    event.target ||= this;
    const list = this.listeners.get(event.type) || [];
    for (const handler of list) handler(event);
    return !event.defaultPrevented;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const selectors = String(selector || '').split(',').map((item) => item.trim()).filter(Boolean);
    const out = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selectors.some((item) => matches(child, item))) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

class MiniDocument extends MiniElement {
  constructor() {
    super('#document', null);
    this.ownerDocument = this;
    this.activeElement = null;
    this.body = new MiniElement('body', this);
    this.appendChild(this.body);
  }

  createElement(tagName) {
    return new MiniElement(tagName, this);
  }

  getElementById(id) {
    const target = String(id || '');
    return this.find((node) => node.id === target);
  }

  find(predicate) {
    const visit = (node) => {
      if (predicate(node)) return node;
      for (const child of node.children) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this);
  }
}

function matches(element, selector) {
  if (!selector) return false;
  if (selector === 'button:not([disabled])') return element.tagName === 'BUTTON' && !element.disabled;
  if (selector === '[href]') return !!element.getAttribute('href');
  if (selector === 'input' || selector === 'select' || selector === 'textarea') return element.tagName === selector.toUpperCase();
  if (selector === "[tabindex]:not([tabindex='-1'])") return element.tabIndex !== undefined && element.tabIndex !== -1;
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  if (/^[a-z]+$/i.test(selector)) return element.tagName === selector.toUpperCase();
  return false;
}

function installDom() {
  const document = new MiniDocument();
  const page = document.createElement('div');
  page.className = 'dm-page';
  document.body.appendChild(page);
  globalThis.document = document;
  globalThis.window = { __dmLastState: null };
  return document;
}

function buttons(document) {
  return document.querySelectorAll('button');
}

function buttonByText(document, text) {
  return buttons(document).find((button) => button.textContent === text) || null;
}

test('no Docker on Linux shows blocking setup action', () => {
  const document = installDom();
  const state = {
    stateLoaded: true,
    dockerAvailable: false,
    runtime: {
      platform: 'linux',
      state: 'not_provisioned',
      action: 'install',
      canProvision: true,
      detail: 'No container runtime was found.'
    }
  };

  assert.equal(shouldShowRuntimeGate(state), true);
  const model = normalizedRuntimeGate(state);
  assert.equal(model.action.label, 'Continue');

  let setupCount = 0;
  assert.equal(renderRuntimeGate(state, { provisionRuntime: () => { setupCount += 1; } }), true);
  assert.ok(document.getElementById('runtimeSetupDialog'));
  assert.equal(document.querySelector('.dm-page').inert, true);
  buttonByText(document, 'Continue').dispatchEvent(new MiniEvent('click'));
  assert.equal(setupCount, 1);
});

test('Docker Desktop installed but stopped starts Docker Desktop instead of opening an install guide', () => {
  const document = installDom();
  const state = {
    stateLoaded: true,
    dockerAvailable: false,
    runtime: {
      platform: 'darwin',
      mode: 'docker_desktop',
      state: 'engine_stopped',
      action: 'start',
      canProvision: true,
      detail: 'Docker Desktop is installed but not running.'
    }
  };

  const model = normalizedRuntimeGate(state);
  assert.equal(model.action.label, 'Start Docker Desktop');
  assert.equal(buttonByText(document, 'Open Install Guide'), null);

  let setupCount = 0;
  let guideCount = 0;
  renderRuntimeGate(state, {
    provisionRuntime: () => { setupCount += 1; },
    openDockerDownload: () => { guideCount += 1; }
  });
  assert.ok(buttonByText(document, 'Start Docker Desktop'));
  assert.equal(buttonByText(document, 'Open Install Guide'), null);
  buttonByText(document, 'Start Docker Desktop').dispatchEvent(new MiniEvent('click'));
  assert.equal(setupCount, 1);
  assert.equal(guideCount, 0);
});

test('runtime setup progress keeps setup disabled and shows an indeterminate bar', () => {
  const document = installDom();
  const state = {
    stateLoaded: true,
    dockerAvailable: false,
    runtime: { platform: 'linux', state: 'not_provisioned', action: 'install', canProvision: true },
    progress: {
      type: 'runtime_setup',
      status: 'running',
      headline: 'Setup Agent Zero',
      detail: 'Installing Docker Engine',
      phase: 'install_engine',
      indeterminate: true
    }
  };

  const model = normalizedRuntimeGate(state);
  assert.equal(model.action.disabled, true);
  assert.equal(model.indeterminate, true);

  renderRuntimeGate(state, {});
  const primary = buttonByText(document, 'Continue');
  assert.equal(primary.disabled, true);
  assert.ok(document.querySelector('.indeterminate'));
  assert.equal(document.querySelector('.dm-runtime-gate-detail'), null);
  assert.equal(document.querySelector('.sv-progress-head')?.children[0]?.textContent, 'Installing Docker Engine');
  assert.ok(document.querySelector('.dm-runtime-details'));
  assert.equal(document.querySelector('.dm-runtime-details-current'), null);
  assert.equal(document.querySelector('.dm-runtime-step-status'), null);
  const steps = document.querySelectorAll('.dm-runtime-step');
  assert.equal(steps.length, 6);
  assert.ok(steps.some((step) => step.classList.contains('is-running')));
});

test('runtime setup progress estimates remaining minutes from setup phases', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-06-16T12:04:00.000Z');

  try {
    const document = installDom();
    const state = {
      stateLoaded: true,
      dockerAvailable: false,
      runtime: { platform: 'linux', state: 'not_provisioned', action: 'install', canProvision: true },
      progress: {
        type: 'runtime_setup',
        status: 'running',
        startedAt: '2026-06-16T12:00:00.000Z',
        headline: 'Setup Agent Zero',
        detail: 'Installing Docker Engine',
        phase: 'install_engine',
        indeterminate: true
      }
    };

    const model = normalizedRuntimeGate(state);
    assert.equal(model.progressMeta, '~6 min remaining');

    renderRuntimeGate(state, {});
    assert.equal(document.querySelector('.dm-progress-meta')?.textContent, '~6 min remaining');
  } finally {
    Date.now = originalNow;
  }
});

test('completed runtime setup prompts for image download only when no image is installed', () => {
  const document = installDom();
  const state = {
    stateLoaded: true,
    dockerAvailable: true,
    runtime: { platform: 'linux', state: 'ready' },
    versions: [
      { id: 'v1.20', displayVersion: '1.20', channelBadges: ['latest'] },
      { id: 'testing', displayVersion: 'Testing', channelBadges: ['testing'] }
    ],
    progress: {
      opId: 'op-success',
      type: 'runtime_setup',
      status: 'completed',
      headline: 'Setup Agent Zero',
      detail: 'Runtime ready',
      phase: 'ready',
      progress: 100
    }
  };
  window.__dmLastState = state;

  const model = normalizedRuntimeGate(state);
  assert.equal(model.success, true);
  assert.equal(model.headline, 'Runtime Ready');
  assert.equal(model.action.label, 'Download Agent Zero');
  assert.deepEqual(model.setupOptions.map((option) => option.value), ['latest', 'v1.20', 'testing']);

  let installTag = '';
  assert.equal(renderRuntimeGate(state, { installOrSync: (tag) => { installTag = tag; } }), true);
  assert.ok(document.querySelector('.dm-runtime-success'));
  assert.equal(document.querySelector('.dm-runtime-gate-detail')?.textContent, 'Agent Zero can run on this computer now.');
  assert.equal(document.querySelector('.dm-runtime-install-text')?.textContent, 'Download Agent Zero to create your first Instance.');
  assert.equal(document.querySelector('#runtimeSetupTag')?.value, 'latest');
  assert.equal(document.querySelector('#runtimeEndpointChoice'), null);
  assert.equal(buttonByText(document, 'Refresh'), null);
  assert.equal(document.querySelector('.dm-runtime-steps'), null);

  buttonByText(document, 'Download Agent Zero').dispatchEvent(new MiniEvent('click'));
  assert.equal(installTag, 'latest');
  assert.equal(document.getElementById('runtimeSetupDialog'), null);
  assert.equal(document.querySelector('.dm-page').inert, false);
});

test('completed runtime setup runs an already-installed image when no local instance exists', () => {
  const document = installDom();
  const state = {
    stateLoaded: true,
    dockerAvailable: true,
    runtime: { platform: 'win32', state: 'ready' },
    versions: [
      { id: 'latest', displayVersion: 'latest', availability: 'installed' },
      { id: 'v1.20', displayVersion: '1.20', availability: 'installed' }
    ],
    containers: [],
    progress: {
      opId: 'op-success-installed',
      type: 'runtime_setup',
      status: 'completed',
      detail: 'Runtime ready',
      phase: 'ready',
      progress: 100
    }
  };
  window.__dmLastState = state;

  const model = normalizedRuntimeGate(state);
  assert.equal(model.successMode, 'run');
  assert.equal(model.action.label, 'Run Agent Zero');
  assert.deepEqual(model.setupOptions.map((option) => option.value), ['latest', 'v1.20']);

  let runTag = '';
  let runOptions = null;
  renderRuntimeGate(state, {
    activateTag: (tag, options) => {
      runTag = tag;
      runOptions = options;
    }
  });

  assert.equal(document.querySelector('.dm-runtime-install-text')?.textContent, "Agent Zero is already downloaded. Start an Instance when you're ready.");
  buttonByText(document, 'Run Agent Zero').dispatchEvent(new MiniEvent('click'));

  assert.equal(runTag, 'latest');
  assert.deepEqual(runOptions, { dataLossAck: 'proceed_without_backup', portMappings: '0:80' });
  assert.equal(document.getElementById('runtimeSetupDialog'), null);
});

test('completed runtime setup only continues when an instance already exists', () => {
  const document = installDom();
  const state = {
    stateLoaded: true,
    dockerAvailable: true,
    runtime: { platform: 'win32', state: 'ready' },
    versions: [
      { id: 'latest', displayVersion: 'latest', availability: 'installed' }
    ],
    containers: [
      { containerId: 'abc123', containerName: 'a0-inst-agent-zero', role: 'instance' }
    ],
    progress: {
      opId: 'op-success-continue',
      type: 'runtime_setup',
      status: 'completed',
      detail: 'Runtime ready',
      phase: 'ready',
      progress: 100
    }
  };
  window.__dmLastState = state;

  const model = normalizedRuntimeGate(state);
  assert.equal(model.successMode, 'continue');
  assert.equal(model.action.label, 'Continue');

  let ran = false;
  let installed = false;
  renderRuntimeGate(state, {
    activateTag: () => { ran = true; },
    installOrSync: () => { installed = true; }
  });

  assert.equal(document.querySelector('#runtimeSetupTag'), null);
  buttonByText(document, 'Continue').dispatchEvent(new MiniEvent('click'));
  assert.equal(ran, false);
  assert.equal(installed, false);
  assert.equal(document.getElementById('runtimeSetupDialog'), null);
});

test('runtime selector is hidden unless multiple available endpoints exist', () => {
  let document = installDom();
  const base = {
    stateLoaded: true,
    dockerAvailable: true,
    versions: [{ id: 'v1.20' }],
    progress: {
      opId: 'op-runtime-choice',
      type: 'runtime_setup',
      status: 'completed',
      detail: 'Runtime ready',
      phase: 'ready',
      progress: 100
    }
  };

  renderRuntimeGate({
    ...base,
    runtime: { platform: 'linux', state: 'ready', runtimeCandidates: [] }
  }, {});
  assert.equal(document.querySelector('#runtimeEndpointChoice'), null);

  document = installDom();
  renderRuntimeGate({
    ...base,
    runtime: {
      platform: 'linux',
      state: 'ready',
      runtimeCandidates: [
        { id: 'runtime-one', label: 'Docker Engine', available: true, isSelected: true }
      ]
    }
  }, {});
  assert.equal(document.querySelector('#runtimeEndpointChoice'), null);
});

test('runtime selector appears for multiple endpoints and submits before image install', async () => {
  const document = installDom();
  const state = {
    stateLoaded: true,
    dockerAvailable: true,
    runtime: {
      platform: 'darwin',
      state: 'ready',
      selectedRuntimeEndpointId: 'runtime-one',
      runtimeCandidates: [
        { id: 'runtime-one', label: 'OrbStack', available: true, isSelected: true },
        { id: 'runtime-two', label: 'Rancher Desktop', available: true, isSelected: false },
        { id: 'runtime-three', label: 'Podman', available: false, isSelected: false }
      ]
    },
    versions: [
      { id: 'v1.20', displayVersion: '1.20' }
    ],
    progress: {
      opId: 'op-runtime-choice-submit',
      type: 'runtime_setup',
      status: 'completed',
      detail: 'Runtime ready',
      phase: 'ready',
      progress: 100
    }
  };
  window.__dmLastState = state;

  const calls = [];
  renderRuntimeGate(state, {
    selectRuntimeEndpoint: async (id) => {
      calls.push(`select:${id}`);
      return true;
    },
    installOrSync: (tag) => {
      calls.push(`install:${tag}`);
    }
  });

  const selector = document.querySelector('#runtimeEndpointChoice');
  assert.ok(selector);
  assert.equal(selector.value, 'runtime-one');
  assert.deepEqual(selector.querySelectorAll('option').map((option) => option.value), ['runtime-one', 'runtime-two']);

  selector.value = 'runtime-two';
  buttonByText(document, 'Download Agent Zero').dispatchEvent(new MiniEvent('click'));
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls, ['select:runtime-two', 'install:latest']);
  assert.equal(document.getElementById('runtimeSetupDialog'), null);
});

test('manual and relogin states stay blocked with recovery actions', () => {
  let document = installDom();
  const manual = {
    stateLoaded: true,
    dockerAvailable: false,
    runtime: {
      platform: 'linux',
      state: 'manual_install',
      action: 'manual',
      manualUrl: 'https://docs.docker.com/engine/install/ubuntu/',
      detail: 'Install Docker Engine manually.'
    }
  };
  let openedUrl = '';
  renderRuntimeGate(manual, { openDockerDownload: (url) => { openedUrl = url; } });
  buttonByText(document, 'Open Install Guide').dispatchEvent(new MiniEvent('click'));
  assert.equal(openedUrl, manual.runtime.manualUrl);

  document = installDom();
  const relogin = {
    stateLoaded: true,
    dockerAvailable: false,
    runtime: {
      platform: 'linux',
      state: 'needs_relogin',
      action: 'refresh',
      detail: 'Log out and back in once, then return here.'
    }
  };
  let refreshCount = 0;
  renderRuntimeGate(relogin, { refresh: () => { refreshCount += 1; } });
  buttonByText(document, 'Refresh').dispatchEvent(new MiniEvent('click'));
  assert.equal(refreshCount, 1);
  assert.ok(document.getElementById('runtimeSetupDialog'));
});

test('ready state closes the modal and runtime gate cannot be dismissed with Escape or backdrop click', () => {
  const document = installDom();
  const blocked = {
    stateLoaded: true,
    dockerAvailable: false,
    runtime: { platform: 'linux', state: 'not_provisioned', action: 'install', canProvision: true }
  };
  renderRuntimeGate(blocked, {});

  const escape = new MiniEvent('keydown', { key: 'Escape' });
  document.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.ok(document.getElementById('runtimeSetupDialog'));

  const click = new MiniEvent('click');
  document.getElementById('runtimeSetupDialog').dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.ok(document.getElementById('runtimeSetupDialog'));

  const ready = {
    stateLoaded: true,
    dockerAvailable: true,
    runtime: { platform: 'linux', state: 'ready' }
  };
  assert.equal(renderRuntimeGate(ready, {}), false);
  assert.equal(document.getElementById('runtimeSetupDialog'), null);
  assert.equal(document.querySelector('.dm-page').inert, false);
});

test('reachable Docker suppresses stale non-ready runtime assessments', () => {
  const document = installDom();
  const staleRuntime = {
    stateLoaded: true,
    dockerAvailable: true,
    runtime: {
      platform: 'win32',
      state: 'engine_stopped',
      mode: 'wsl_engine',
      action: 'start',
      canProvision: true,
      detail: 'Agent Zero local runtime is ready to start.'
    },
    containers: [
      { containerId: 'abc123', containerName: 'agent-zero-latest', role: 'instance' }
    ]
  };

  assert.equal(shouldShowRuntimeGate(staleRuntime), false);
  assert.equal(renderRuntimeGate(staleRuntime, {}), false);
  assert.equal(document.getElementById('runtimeSetupDialog'), null);
  assert.equal(document.querySelector('.dm-page').inert, false);
});
