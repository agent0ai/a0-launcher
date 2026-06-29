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
  backgroundOperationLabel,
  computeCardMenuPlacement,
  emptyInstancesStateModel,
  instancePowerMenuConfig,
  isBlockingOperationRunning,
  remoteInstanceStatusModel,
  instanceVisualBadge,
  localCardsRenderKey,
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

test('background operation labels use running progress messages', () => {
  assert.equal(
    backgroundOperationLabel({ type: 'start', status: 'running', message: 'Waiting for UI' }),
    'Waiting for UI'
  );
  assert.equal(
    backgroundOperationLabel({ type: 'start', status: 'queued', message: 'Waiting for UI' }),
    'Queued start'
  );
  assert.equal(
    backgroundOperationLabel({ type: 'start', status: 'running', message: '' }),
    'Starting'
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

test('empty Instances state offers latest install after first inventory', () => {
  assert.deepEqual(
    emptyInstancesStateModel({ stateLoaded: false, loading: true, containers: [], remoteInstances: [] }),
    {
      kind: 'checking',
      message: 'Checking Instances...'
    }
  );

  assert.deepEqual(
    emptyInstancesStateModel({ stateLoaded: true, loading: false, containers: [], remoteInstances: [] }),
    {
      kind: 'install_latest',
      title: 'No Instances yet',
      detail: 'Download Agent Zero and create your first Instance.',
      actionLabel: 'Install latest version',
      disabled: false,
      actionTitle: 'Install latest Agent Zero version'
    }
  );

  assert.equal(
    emptyInstancesStateModel({ stateLoaded: true, containers: [{ containerId: 'abc' }], remoteInstances: [] }),
    null
  );
  assert.equal(
    emptyInstancesStateModel({ stateLoaded: true, containers: [], remoteInstances: [{ id: 'remote' }] }),
    null
  );
  assert.equal(
    emptyInstancesStateModel({
      stateLoaded: true,
      containers: [],
      remoteInstances: [],
      progress: { status: 'running' }
    }).disabled,
    true
  );
  assert.equal(
    emptyInstancesStateModel({
      stateLoaded: true,
      containers: [],
      remoteInstances: [],
      progress: { status: 'running', presentation: 'toast' }
    }).disabled,
    false
  );
});

test('toast progress does not change the Instance card render key', () => {
  const baseState = {
    stateLoaded: true,
    loading: false,
    containers: [{ containerId: 'abc', state: 'running', instanceName: 'Main' }],
    remoteInstances: [],
    backgroundOperations: [],
    cli: { installed: true, command: 'a0' }
  };

  assert.equal(
    isBlockingOperationRunning({ progress: { status: 'running', presentation: 'toast' } }),
    false
  );
  assert.equal(
    isBlockingOperationRunning({ progress: { status: 'running' } }),
    true
  );
  assert.equal(
    localCardsRenderKey({ ...baseState, progress: { status: 'running', presentation: 'toast', progress: 10 } }),
    localCardsRenderKey({ ...baseState, progress: { status: 'running', presentation: 'toast', progress: 80 } })
  );
  assert.notEqual(
    localCardsRenderKey(baseState),
    localCardsRenderKey({ ...baseState, progress: { status: 'running' } })
  );
});

test('remote instance status labels health states', () => {
  assert.deepEqual(remoteInstanceStatusModel({ health: { status: 'online' } }), {
    className: 'status-online',
    label: 'Online',
    title: 'Remote health check is online'
  });
  assert.equal(remoteInstanceStatusModel({ health: { status: 'offline', error: 'ECONNREFUSED' } }).label, 'Offline');
  assert.equal(remoteInstanceStatusModel({ health: { status: 'checking' } }).label, 'Checking');
  assert.equal(remoteInstanceStatusModel({}).label, 'Checking');
});

test('card menu placement reserves fixed bottom chrome in short windows', () => {
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

test('card menu stays hidden until fixed coordinates settle', () => {
  window.innerWidth = 720;
  window.innerHeight = 520;

  const scheduledFrames = [];
  window.requestAnimationFrame = (callback) => {
    scheduledFrames.push(callback);
    return scheduledFrames.length;
  };

  try {
    const menuClasses = fakeClassList(['dm-card-menu']);
    const cardClasses = fakeClassList(['dm-card']);
    const triggerAttributes = {};
    const trigger = {
      setAttribute: (name, value) => { triggerAttributes[name] = String(value); },
      getBoundingClientRect: () => ({ top: 360, right: 620, bottom: 392 })
    };
    let settlingReads = 0;
    const popover = {
      style: {},
      scrollWidth: 184,
      scrollHeight: 260,
      getBoundingClientRect: () => {
        const left = Number.parseFloat(popover.style.left) || 0;
        const top = Number.parseFloat(popover.style.top) || 0;
        if (menuClasses.contains('settling')) {
          settlingReads += 1;
          if (settlingReads <= 2) return { left: left + 17, top: top - 211, width: 184, height: 260 };
          return { left, top, width: 184, height: 260 };
        }
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

    assert.equal(menuClasses.contains('measuring'), false);
    assert.equal(menuClasses.contains('settling'), true);
    assert.equal(menuClasses.contains('open'), true);
    assert.equal(cardClasses.contains('menu-open'), true);
    assert.equal(triggerAttributes['aria-expanded'], 'true');
    assert.equal(scheduledFrames.length, 1);

    scheduledFrames.shift()();

    assert.equal(menuClasses.contains('settling'), true);
    assert.equal(menuClasses.contains('open'), true);
    assert.equal(scheduledFrames.length, 1);

    scheduledFrames.shift()();

    assert.equal(menuClasses.contains('settling'), true);
    assert.equal(menuClasses.contains('open'), true);
    assert.equal(scheduledFrames.length, 1);

    scheduledFrames.shift()();

    assert.equal(menuClasses.contains('settling'), false);
    assert.equal(menuClasses.contains('measuring'), false);
    assert.equal(menuClasses.contains('open'), true);
    assert.equal(triggerAttributes['aria-expanded'], 'true');
  } finally {
    delete window.requestAnimationFrame;
  }
});
