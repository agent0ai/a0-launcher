import assert from 'node:assert/strict';
import { test } from 'node:test';

class MiniCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
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

  contains(value) {
    return this.values().includes(value);
  }

  toggle(value, force) {
    const has = this.contains(value);
    const shouldAdd = force === undefined ? !has : !!force;
    if (shouldAdd) this.write([...this.values(), value]);
    else this.write(this.values().filter((item) => item !== value));
    return shouldAdd;
  }
}

class MiniElement {
  constructor(tab, className = '') {
    this.dataset = { tab };
    this.className = className;
    this.classList = new MiniClassList(this);
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || [];
    for (const handler of list) handler(event);
  }
}

class MiniWindow {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatchEvent(event) {
    const list = this.listeners.get(event.type) || [];
    for (const handler of list) handler(event);
  }
}

function installDom() {
  const navItems = [
    new MiniElement('installs', 'dm-nav-item active'),
    new MiniElement('sessions', 'dm-nav-item'),
    new MiniElement('advanced', 'dm-nav-item')
  ];
  const panels = [
    new MiniElement('installs', 'dm-tab-content active'),
    new MiniElement('sessions', 'dm-tab-content'),
    new MiniElement('advanced', 'dm-tab-content')
  ];
  const storage = new Map();

  globalThis.CustomEvent = MiniCustomEvent;
  globalThis.sessionStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value))
  };
  globalThis.document = {
    readyState: 'loading',
    addEventListener: () => {},
    querySelectorAll: (selector) => {
      if (selector === '.dm-nav-item') return navItems;
      if (selector === '.dm-tab-content') return panels;
      return [];
    }
  };
  globalThis.window = new MiniWindow();

  return { navItems, panels, storage };
}

const dom = installDom();
const { NAVIGATE_EVENT, bindProgrammaticNavigation, navigateToTab } = await import('./sidebar.js');

test('navigateToTab updates the visible tab and publishes navigation detail', () => {
  const events = [];
  window.addEventListener('dm:nav', (event) => events.push(event.detail));

  const tab = navigateToTab('sessions', { userInitiated: false, source: 'run-completed' });

  assert.equal(tab, 'sessions');
  assert.equal(dom.storage.get('dm-active-tab'), 'sessions');
  assert.equal(dom.navItems[0].classList.contains('active'), false);
  assert.equal(dom.navItems[1].classList.contains('active'), true);
  assert.equal(dom.panels[0].classList.contains('active'), false);
  assert.equal(dom.panels[1].classList.contains('active'), true);
  assert.deepEqual(events.at(-1), {
    tab: 'sessions',
    userInitiated: false,
    source: 'run-completed'
  });
});

test('programmatic navigation requests use the same tab path', () => {
  const events = [];
  window.addEventListener('dm:nav', (event) => events.push(event.detail));
  bindProgrammaticNavigation();

  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, {
    detail: { tab: 'advanced', source: 'test' }
  }));

  assert.equal(dom.storage.get('dm-active-tab'), 'advanced');
  assert.equal(dom.navItems[2].classList.contains('active'), true);
  assert.equal(dom.panels[2].classList.contains('active'), true);
  assert.deepEqual(events.at(-1), {
    tab: 'advanced',
    userInitiated: false,
    source: 'test'
  });
});
