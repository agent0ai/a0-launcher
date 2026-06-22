import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizedOperationDialog,
  renderOperationDialog,
  shouldShowOperationDialog
} from './operation-modal.js';

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

test('running install shows centered operation modal with cancel action', () => {
  const document = installDom();
  const state = {
    progress: {
      opId: 'op-install',
      type: 'install',
      status: 'running',
      message: 'Downloading',
      canCancel: true
    }
  };

  const model = normalizedOperationDialog(state);
  assert.equal(model.headline, 'Installing Agent Zero');
  assert.equal(model.primary?.disabled, true);
  assert.equal(model.secondary?.label, 'Cancel download');
  assert.equal(shouldShowOperationDialog(state), true);

  let canceled = '';
  renderOperationDialog(state, { cancelOperation: (opId) => { canceled = opId; } });
  assert.ok(document.getElementById('operationProgressDialog'));
  assert.equal(document.querySelector('.dm-page').inert, true);
  assert.ok(document.querySelector('.dm-setup-showcase'));
  assert.equal(document.querySelector('.dm-setup-showcase-count'), null);
  assert.ok(document.querySelector('.dm-operation-dialog').classList.contains('has-setup-showcase'));
  assert.equal(document.querySelector('.dm-operation-detail'), null);
  assert.equal(document.querySelector('.dm-operation-phase')?.textContent, 'Downloading');
  const cancelButton = buttonByText(document, 'Cancel download');

  renderOperationDialog({
    progress: {
      ...state.progress,
      progress: 42,
      downloadProgress: 42
    }
  }, { cancelOperation: (opId) => { canceled = opId; } });

  assert.equal(buttonByText(document, 'Cancel download'), cancelButton);
  cancelButton.dispatchEvent(new MiniEvent('click'));
  assert.equal(canceled, 'op-install');
});

test('running image pull shows a minute-level ETA near the percentage', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-06-16T12:05:00.000Z');

  try {
    const document = installDom();
    const state = {
      progress: {
        opId: 'op-install-eta',
        type: 'install',
        status: 'running',
        startedAt: '2026-06-16T12:00:00.000Z',
        message: 'Downloading',
        progress: 50,
        downloadProgress: 50,
        canCancel: true
      }
    };

    const model = normalizedOperationDialog(state);
    assert.equal(model.progressMeta, '50% · ~5 min remaining');

    renderOperationDialog(state, {});
    assert.equal(document.querySelector('.dm-operation-percent')?.textContent, '50% · ~5 min remaining');
  } finally {
    Date.now = originalNow;
  }
});

test('install availability check stays compact before image pull starts', () => {
  const document = installDom();
  const state = {
    progress: {
      opId: 'op-install-check',
      type: 'install',
      status: 'running',
      message: 'Checking availability',
      canCancel: false
    }
  };

  renderOperationDialog(state, {});

  assert.ok(document.getElementById('operationProgressDialog'));
  assert.equal(document.querySelector('.dm-setup-showcase'), null);
  assert.equal(document.querySelector('.dm-operation-dialog').classList.contains('has-setup-showcase'), false);
});

test('first image pull asks for models, first Instance details, then optional A0 CLI install', async () => {
  const document = installDom();
  const state = {
    containers: [],
    cli: { installed: false, command: '' },
    progress: {
      opId: 'op-first-install',
      type: 'install',
      status: 'running',
      targetTag: 'latest',
      message: 'Downloading',
      progress: 18,
      downloadProgress: 18,
      canCancel: true
    }
  };

  let skipped = '';
  let confirmed = null;
  let installCliCalls = 0;
  renderOperationDialog(state, {
    skipFirstInstanceSetup: ({ opId }) => { skipped = opId; },
    installCli: () => { installCliCalls += 1; },
    confirmFirstInstanceSetup: (payload) => {
      confirmed = payload;
      return true;
    }
  });

  assert.ok(document.querySelector('.dm-first-instance-setup'));
  assert.equal(document.querySelector('.dm-setup-showcase'), null);
  assert.ok(document.querySelector('.dm-operation-dialog').classList.contains('has-first-instance-setup'));
  assert.equal(document.querySelector('.dm-first-instance-title')?.textContent, 'Choose Instance defaults');
  assert.equal(document.querySelector('.dm-first-instance-step-run')?.classList.contains('hidden'), true);
  assert.ok(buttonByText(document, 'Skip'));

  buttonByText(document, 'Continue').dispatchEvent(new MiniEvent('click'));

  assert.equal(document.querySelector('.dm-first-instance-title')?.textContent, 'Start your first Instance');
  assert.equal(document.querySelector('.dm-first-instance-step-models')?.classList.contains('hidden'), true);
  assert.equal(document.querySelector('.dm-first-instance-step-run')?.classList.contains('hidden'), false);
  assert.ok(document.getElementById('firstSetupRunInstance'));
  assert.ok(document.getElementById('firstSetupInstanceName'));
  const storageMode = document.getElementById('firstSetupStorageMode');
  const storageWarning = document.querySelector('.dm-first-instance-storage-warning');
  assert.ok(storageMode);
  assert.equal(storageMode.value, 'host_directory');
  assert.ok(storageWarning?.classList.contains('hidden'));
  storageMode.value = 'ephemeral';
  storageMode.dispatchEvent(new MiniEvent('change'));
  assert.equal(storageWarning?.classList.contains('hidden'), false);
  assert.equal(buttonByText(document, 'Show slideshow'), null);
  assert.ok(buttonByText(document, 'Skip'));
  assert.ok(buttonByText(document, '< Back to model configuration'));
  assert.equal(document.getElementById('firstSetupRunInstance').parentNode.children[1]?.textContent, 'Start my first Instance when the download finishes');

  buttonByText(document, 'Continue').dispatchEvent(new MiniEvent('click'));
  await Promise.resolve();

  assert.equal(skipped, '');
  assert.equal(confirmed?.opId, 'op-first-install');
  assert.equal(confirmed?.runFirstInstance, false);
  assert.equal(confirmed?.storageMode, 'ephemeral');
  assert.equal(document.querySelector('.dm-first-instance-title')?.textContent, 'Install A0 CLI');
  assert.equal(document.querySelector('.dm-first-instance-step-run')?.classList.contains('hidden'), true);
  assert.equal(document.querySelector('.dm-first-instance-step-cli')?.classList.contains('hidden'), false);
  assert.ok(buttonByText(document, 'Install A0 CLI'));
  assert.ok(buttonByText(document, '< Back to first Instance'));
  buttonByText(document, 'Install A0 CLI').dispatchEvent(new MiniEvent('click'));
  assert.equal(installCliCalls, 1);

  buttonByText(document, 'Show slideshow').dispatchEvent(new MiniEvent('click'));

  assert.equal(document.querySelector('.dm-first-instance-setup'), null);
  assert.ok(document.querySelector('.dm-setup-showcase'));
  assert.ok(document.querySelector('.dm-operation-dialog').classList.contains('has-setup-showcase'));
});

test('first image pull setup can be skipped without configuring defaults', async () => {
  const document = installDom();
  const state = {
    containers: [],
    progress: {
      opId: 'op-first-install-skip',
      type: 'install',
      status: 'running',
      targetTag: 'latest',
      message: 'Downloading',
      progress: 18,
      downloadProgress: 18,
      canCancel: true
    }
  };

  let skipped = '';
  let confirmed = null;
  renderOperationDialog(state, {
    skipFirstInstanceSetup: ({ opId }) => { skipped = opId; },
    confirmFirstInstanceSetup: (payload) => {
      confirmed = payload;
      return true;
    }
  });

  buttonByText(document, 'Skip').dispatchEvent(new MiniEvent('click'));
  await Promise.resolve();

  assert.equal(skipped, 'op-first-install-skip');
  assert.equal(confirmed, null);
  assert.equal(document.querySelector('.dm-first-instance-setup'), null);
  assert.ok(document.querySelector('.dm-setup-showcase'));
});

test('running operation without cancel support shows no cancel action', () => {
  installDom();
  const state = {
    progress: {
      opId: 'op-install',
      type: 'install',
      status: 'running',
      message: 'Checking availability',
      canCancel: false
    }
  };

  const model = normalizedOperationDialog(state);
  assert.equal(model.primary?.label, 'Installing Agent Zero');
  assert.equal(model.secondary, null);
});

test('running clone operation shows source-specific headline', () => {
  installDom();
  const state = {
    progress: {
      opId: 'op-clone',
      type: 'clone_instance',
      status: 'running',
      headline: 'Cloning agent-zero-latest',
      message: 'Snapshotting container',
      canCancel: false
    }
  };

  const model = normalizedOperationDialog(state);
  assert.equal(model.headline, 'Cloning agent-zero-latest');
  assert.equal(model.primary?.label, 'Cloning agent-zero-latest');
  assert.equal(model.detail, 'Snapshotting container');
});

test('workspace persistence operation uses persistence wording', () => {
  installDom();
  const model = normalizedOperationDialog({
    progress: {
      opId: 'op-persist',
      type: 'migrate_workspace',
      status: 'running',
      message: 'Creating persistent replacement',
      canCancel: false
    }
  });

  assert.equal(model.headline, 'Persisting /a0/usr data');
  assert.equal(model.primary?.label, 'Persisting /a0/usr data');
  assert.equal(model.detail, 'Creating persistent replacement');
});

test('rate-limited install failure shows docker login and retry actions in modal', () => {
  const document = installDom();
  const state = {
    progress: {
      opId: 'op-fail',
      type: 'install',
      status: 'failed',
      errorCode: 'DOCKER_PULL_RATE_LIMIT',
      error: 'Docker Hub pull limit reached. Sign in to Docker or try again later.',
      targetTag: 'v1.20',
      finishedAt: '2026-06-16T12:00:00.000Z'
    }
  };
  window.__dmLastState = state;

  let loginCount = 0;
  let retryTag = '';
  renderOperationDialog(state, {
    openDockerLoginTerminal: () => { loginCount += 1; },
    retryInstall: (tag) => { retryTag = tag; }
  });

  buttonByText(document, 'Docker Login').dispatchEvent(new MiniEvent('click'));
  assert.equal(loginCount, 1);
  buttonByText(document, 'Retry').dispatchEvent(new MiniEvent('click'));
  assert.equal(retryTag, 'v1.20');
});

test('generic failed operation can be dismissed and completed operations do not show the modal', () => {
  const document = installDom();
  const failed = {
    progress: {
      opId: 'op-stop',
      type: 'stop',
      status: 'failed',
      message: 'Stopping',
      error: 'The runtime could not be started.',
      finishedAt: '2026-06-16T12:00:00.000Z'
    }
  };

  renderOperationDialog(failed, {});
  assert.ok(buttonByText(document, 'Close'));
  assert.equal(document.querySelector('.dm-operation-phase')?.textContent, 'The runtime could not be started.');
  buttonByText(document, 'Close').dispatchEvent(new MiniEvent('click'));
  assert.equal(document.getElementById('operationProgressDialog'), null);

  const completed = {
    progress: {
      opId: 'op-done',
      type: 'install',
      status: 'completed'
    }
  };
  assert.equal(shouldShowOperationDialog(completed), false);
});
