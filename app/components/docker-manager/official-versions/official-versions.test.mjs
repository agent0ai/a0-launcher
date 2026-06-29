import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.document = {
  getElementById: () => null
};

globalThis.window = {
  __dmLastState: null,
  addEventListener: () => {},
  dockerManagerActions: {}
};

const {
  actionForEntry,
  actionsForEntry,
  buildInstallCatalogModel,
  canRemoveEntry,
  defaultInstanceName,
  displayDateForEntry,
  filterInstallEntries,
  installCardsRenderKey,
  isInstalledEntry,
  metaPartsForEntry,
  releaseMatchBadgeLabel,
  statusForEntry
} = await import('./official-versions.js');

test('installed active entries still expose Run for additional instances', () => {
  const action = actionForEntry({
    tag: 'latest',
    availability: 'installed',
    isActive: true,
    activeState: 'running'
  }, {});

  assert.equal(action?.label, 'Run');
  assert.equal(action?.disabled, undefined);
});

test('update-ready install entries keep Run and expose Update separately', () => {
  const actions = actionsForEntry({
    tag: 'ready',
    availability: 'update_available'
  }, {});

  assert.deepEqual(actions.map((action) => action.label), ['Run', 'Update']);
  assert.equal(actions[0].className, 'button confirm');
  assert.equal(actions[1].className, 'button');
});

test('update-ready install entries do not render a duplicate status chip', () => {
  assert.equal(statusForEntry({
    tag: 'ready',
    availability: 'update_available'
  }), null);

  assert.deepEqual(statusForEntry({
    tag: 'latest',
    availability: 'installed'
  }), {
    className: 'status-installed',
    label: 'Installed'
  });
});

test('update action uses background install update flow', () => {
  let updatedTag = '';
  globalThis.window.dockerManagerActions = {
    updateInstall: (tag) => { updatedTag = tag; }
  };

  const actions = actionsForEntry({
    tag: 'latest',
    availability: 'update_available'
  }, {});
  actions.find((action) => action.label === 'Update')?.handler();

  assert.equal(updatedTag, 'latest');
});

test('toast progress does not change the Install card render key', () => {
  const baseState = {
    stateLoaded: true,
    loading: false,
    versions: [{ id: 'latest', displayVersion: 'latest', availability: 'installed' }],
    images: []
  };

  assert.equal(
    installCardsRenderKey({ ...baseState, progress: { status: 'running', presentation: 'toast', progress: 12 } }),
    installCardsRenderKey({ ...baseState, progress: { status: 'running', presentation: 'toast', progress: 47 } })
  );
  assert.notEqual(
    installCardsRenderKey(baseState),
    installCardsRenderKey({ ...baseState, versions: [{ id: 'latest', displayVersion: 'latest', availability: 'update_available' }] })
  );
});

test('running operations still suppress install card actions', () => {
  const action = actionForEntry({
    tag: 'latest',
    availability: 'installing',
    isActive: true
  }, {});

  assert.equal(action, null);
});

test('installed and differing install cards can expose remove control', () => {
  assert.equal(canRemoveEntry({ availability: 'installed' }), true);
  assert.equal(canRemoveEntry({ availability: 'update_available' }), true);
  assert.equal(canRemoveEntry({ availability: 'available' }), false);
  assert.equal(canRemoveEntry({ availability: 'installing' }), false);
  assert.equal(canRemoveEntry({ availability: 'available', differsFromPublished: true }), true);
});

test('installed filter keeps local or in-progress installs only', () => {
  const entries = [
    { tag: 'latest', availability: 'installed' },
    { tag: 'ready', availability: 'update_available' },
    { tag: 'v2.0', availability: 'available' },
    { tag: 'v1.20', availability: 'available', differsFromPublished: true },
    { tag: 'v1.19', availability: 'installing' },
    { tag: 'v0.9', availability: 'available', isActive: true }
  ];

  assert.equal(isInstalledEntry(entries[0]), true);
  assert.equal(isInstalledEntry(entries[2]), false);
  assert.deepEqual(filterInstallEntries(entries, 'installed').map((entry) => entry.tag), [
    'latest',
    'ready',
    'v1.20',
    'v1.19',
    'v0.9'
  ]);
  assert.deepEqual(filterInstallEntries(entries, 'all').map((entry) => entry.tag), entries.map((entry) => entry.tag));
});

test('default run names increment when same-tag instances exist', () => {
  const name = defaultInstanceName('latest', {
    containers: [
      { instanceName: 'agent-zero-latest' },
      { instanceName: 'agent-zero-latest-2' }
    ]
  });

  assert.equal(name, 'agent-zero-latest-3');
});

test('release match badge labels omit leading v', () => {
  assert.equal(releaseMatchBadgeLabel('v1.20'), '1.20');
  assert.equal(releaseMatchBadgeLabel('ready'), 'ready');
});

test('channel install cards display update dates from channel metadata or matched releases', () => {
  const entries = [
    { tag: 'latest', title: 'latest', matchedReleaseTag: 'v2.0' },
    { tag: 'ready', title: 'ready', updatedAt: '2026-06-25T12:44:56.141Z' },
    { tag: 'v2.0', title: '2.0', publishedAt: '2026-06-24T12:00:00Z', badges: ['latest'] }
  ];

  assert.deepEqual(displayDateForEntry(entries[0], entries), {
    label: 'Released',
    value: '2026-06-24T12:00:00Z'
  });
  assert.deepEqual(displayDateForEntry(entries[1], entries), {
    label: 'Updated',
    value: '2026-06-25T12:44:56.141Z'
  });
  assert.deepEqual(displayDateForEntry(entries[2], entries), {
    label: 'Released',
    value: '2026-06-24T12:00:00Z'
  });
});

test('channel install card meta keeps only date and size', () => {
  const entries = [
    {
      tag: 'ready',
      title: 'ready',
      updatedAt: '2026-06-25T12:44:56.141Z',
      sizeBytes: 12348030976,
      matchHint: 'Differs from published ready',
      digestHint: 'Published: 648b9703656b / Local: dea8d7301edd'
    }
  ];

  assert.deepEqual(metaPartsForEntry(entries[0], entries), [
    'Updated Jun 25, 2026',
    '11.5 GB'
  ]);
});

test('install catalog groups numbered versions by major and collapses older majors by default', () => {
  const model = buildInstallCatalogModel([
    { tag: 'v1.20', title: '1.20' },
    { tag: 'ready', title: 'ready' },
    { tag: 'v0.9', title: '0.9' },
    { tag: 'v2.0', title: '2.0' },
    { tag: 'latest', title: 'latest' },
    { tag: 'v1.19', title: '1.19' }
  ]);

  assert.deepEqual(model.channels.map((entry) => entry.tag), ['latest', 'ready']);
  assert.deepEqual(model.groups.map((group) => group.major), [2, 1, 0]);
  assert.deepEqual(model.groups.map((group) => group.defaultOpen), [true, false, false]);
  assert.deepEqual(model.groups[1].entries.map((entry) => entry.tag), ['v1.20', 'v1.19']);
});
