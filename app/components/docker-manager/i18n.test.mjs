import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyLauncherTranslations,
  getLauncherLocale,
  getLauncherLocalePreference,
  setLauncherLocalePreference,
  t
} from './i18n.js';

class MiniElement {
  constructor(attributes = {}, children = []) {
    this.nodeType = 1;
    this.attributes = new Map(Object.entries(attributes));
    this.children = children;
    this.textContent = '';
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  matches(selector) {
    return selector.split(',').some((part) => {
      const attr = part.trim().match(/^\[([^\]]+)\]$/)?.[1];
      return attr ? this.hasAttribute(attr) : false;
    });
  }

  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      if (node.matches?.(selector)) out.push(node);
      for (const child of node.children || []) visit(child);
    };
    for (const child of this.children) visit(child);
    return out;
  }
}

test('getLauncherLocale uses supported Korean browser locales', () => {
  assert.equal(getLauncherLocale(['fr-FR', 'ko-KR', 'en-US']), 'ko');
});

test('t falls back to English for unsupported locales and missing keys', () => {
  assert.equal(t('remote.add.title', {}, 'fr'), 'Add remote Instance');
  assert.equal(t('missing.key', {}, 'ko'), 'missing.key');
});

test('launcher locale preference can force or clear the stored locale', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };

  assert.equal(setLauncherLocalePreference('ko'), 'ko');
  assert.equal(getLauncherLocalePreference(), 'ko');
  assert.equal(getLauncherLocale(), 'ko');

  assert.equal(setLauncherLocalePreference('auto'), 'auto');
  assert.equal(getLauncherLocalePreference(), 'auto');
  assert.equal(getLauncherLocale(['en-US']), 'en');

  delete globalThis.localStorage;
});

test('applyLauncherTranslations updates text and accessibility attributes', () => {
  const label = new MiniElement({ 'data-i18n': 'instances.addRemote' });
  const button = new MiniElement({
    'data-i18n-title': 'instances.createLocalTitle',
    'data-i18n-aria-label': 'instanceTabs.reloadActive'
  });
  const input = new MiniElement({ 'data-i18n-placeholder': 'remote.name.placeholder' });
  const root = new MiniElement({}, [label, button, input]);

  applyLauncherTranslations(root, 'ko');

  assert.equal(label.textContent, '원격 인스턴스 추가');
  assert.equal(button.getAttribute('title'), '로컬 인스턴스를 만들기 전에 버전을 설치하세요');
  assert.equal(button.getAttribute('aria-label'), '활성 인스턴스 UI 새로고침');
  assert.equal(input.getAttribute('placeholder'), '원격 인스턴스');
});
