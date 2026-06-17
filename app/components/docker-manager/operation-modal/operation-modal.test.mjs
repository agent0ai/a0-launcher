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
      error: 'The runtime could not be started.',
      finishedAt: '2026-06-16T12:00:00.000Z'
    }
  };

  renderOperationDialog(failed, {});
  assert.ok(buttonByText(document, 'Close'));
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
