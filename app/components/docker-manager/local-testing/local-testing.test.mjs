import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.document = {
  body: { dataset: {} },
  addEventListener: () => {},
  getElementById: () => null
};

globalThis.window = {
  __dmLastState: null,
  addEventListener: () => {},
  dockerManagerActions: {}
};

const {
  bindOpenableCardHeader,
  computeCardMenuPlacement,
  instancePowerMenuConfig,
  instanceVisualBadge,
  openCardMenu
} = await import('./local-testing.js');

function fakeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    toggle: (name, force) => {
      const shouldAdd = typeof force === 'boolean' ? force : !values.has(name);
      if (shouldAdd) values.add(name);
      else values.delete(name);
      return shouldAdd;
    },
    contains: (name) => values.has(name)
  };
}

test('channel instance chips include the matched concrete release', () => {
  assert.equal(
    instanceVisualBadge({
      versionTag: 'ready',
      runtimeBranch: 'ready',
      matchedReleaseTag: 'v1.20'
    }),
    'ready · 1.20'
  );

  assert.equal(
    instanceVisualBadge({
      versionTag: 'latest',
      runtimeBranch: 'ready',
      matchedReleaseTag: 'v1.20'
    }),
    'latest · 1.20'
  );
});

test('instance chips still prefer runtime branch without a channel release match', () => {
  assert.equal(
    instanceVisualBadge({
      versionTag: 'v1.19',
      runtimeBranch: 'ready'
    }),
    'ready'
  );
});

test('instance power menu switches between stop and start', () => {
  assert.deepEqual(
    instancePowerMenuConfig({
      isRunning: true,
      canStart: false,
      containerId: 'abc123',
      containerOperationRunning: false
    }),
    {
      action: 'stop',
      icon: 'stop_circle',
      label: 'Stop',
      disabled: false,
      title: 'Stop this instance'
    }
  );

  assert.deepEqual(
    instancePowerMenuConfig({
      isRunning: false,
      canStart: true,
      containerId: 'abc123',
      containerOperationRunning: false
    }),
    {
      action: 'start',
      icon: 'play_arrow',
      label: 'Start',
      disabled: false,
      title: 'Start this instance'
    }
  );
});

test('openable card header binds click and keyboard activation', () => {
  const attrs = {};
  const listeners = new Map();
  let opened = 0;
  let prevented = false;
  const header = {
    classList: fakeClassList(),
    setAttribute: (name, value) => { attrs[name] = String(value); },
    addEventListener: (type, handler) => { listeners.set(type, handler); }
  };

  bindOpenableCardHeader(header, () => { opened += 1; }, {
    title: 'Open this instance',
    ariaLabel: 'Open Main'
  });

  assert.equal(header.classList.contains('dm-card-open-header'), true);
  assert.equal(header.tabIndex, 0);
  assert.equal(header.title, 'Open this instance');
  assert.equal(attrs.role, 'button');
  assert.equal(attrs['aria-label'], 'Open Main');

  listeners.get('click')?.({});
  listeners.get('keydown')?.({ key: 'Enter', preventDefault: () => { prevented = true; } });
  listeners.get('keydown')?.({ key: 'Escape', preventDefault: () => { throw new Error('Escape should not open'); } });

  assert.equal(opened, 2);
  assert.equal(prevented, true);
});

test('card menu placement reserves fixed footer space in short windows', () => {
  const placement = computeCardMenuPlacement({
    triggerRect: { top: 500, right: 590, bottom: 532 },
    popoverWidth: 184,
    popoverHeight: 340,
    viewportWidth: 1024,
    viewportHeight: 650,
    footerHeight: 48
  });

  assert.equal(placement.openDown, false);
  assert.ok(placement.top >= 12);
  assert.ok(placement.top + placement.maxHeight <= 650 - 48 - 12);
});

test('card menu placement clamps horizontal overflow', () => {
  const placement = computeCardMenuPlacement({
    triggerRect: { top: 120, right: 86, bottom: 152 },
    popoverWidth: 220,
    popoverHeight: 180,
    viewportWidth: 260,
    viewportHeight: 520,
    footerHeight: 0
  });

  assert.equal(placement.left, 12);
  assert.ok(placement.left + 220 <= 260 - 12);
});

test('card menu is positioned while hidden before it opens', () => {
  window.innerWidth = 720;
  window.innerHeight = 520;

  const menuClasses = fakeClassList(['dm-card-menu']);
  const cardClasses = fakeClassList(['dm-card']);
  const triggerAttributes = {};
  let measuredWhileHidden = false;

  const trigger = {
    setAttribute: (name, value) => { triggerAttributes[name] = String(value); },
    getBoundingClientRect: () => ({ top: 360, right: 620, bottom: 392 })
  };
  const popover = {
    style: {},
    scrollWidth: 184,
    scrollHeight: 260,
    getBoundingClientRect: () => {
      measuredWhileHidden = true;
      assert.equal(menuClasses.contains('measuring'), true);
      assert.equal(menuClasses.contains('open'), false);
      return { width: 184, height: 260 };
    }
  };
  const card = { classList: cardClasses };
  const menu = {
    classList: menuClasses,
    closest: (selector) => selector === '.dm-card' ? card : null,
    querySelector: (selector) => {
      if (selector === '.dm-card-menu-trigger') return trigger;
      if (selector === '.dm-card-menu-popover') return popover;
      return null;
    }
  };

  openCardMenu(menu, trigger);

  assert.equal(measuredWhileHidden, true);
  assert.equal(menuClasses.contains('measuring'), false);
  assert.equal(menuClasses.contains('open'), true);
  assert.equal(cardClasses.contains('menu-open'), true);
  assert.equal(triggerAttributes['aria-expanded'], 'true');
  assert.match(popover.style.left, /^\d+px$/);
  assert.match(popover.style.top, /^\d+px$/);
  assert.match(popover.style.maxHeight, /^\d+px$/);
});
