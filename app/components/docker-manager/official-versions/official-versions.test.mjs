import assert from 'node:assert/strict';
import { test } from 'node:test';
import { versionVisualLabel } from '../card-visuals.js';

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
  normalizeVersionEntries,
  metaPartsForEntry,
  releaseMatchBadgeLabel,
  statusForEntry
} = await import('./official-versions.js');

test('Version cards ignore unrelated Docker images', () => {
  assert.deepEqual(
    normalizeVersionEntries({
      versions: [{ id: 'latest', displayVersion: 'latest', availability: 'installed' }],
      images: [
        { imageRef: 'mcp/sqlite-mcp-server:latest', tag: 'latest', isBackendImage: false },
        { imageRef: 'surrealdb/surrealdb:v2', tag: 'v2', isBackendImage: false }
      ]
    }).map((entry) => entry.tag),
    ['latest']
  );
});

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

test('update-ready version entries expose only Run', () => {
  const actions = actionsForEntry({
    tag: 'ready',
    availability: 'update_available'
  }, {});

  assert.deepEqual(actions.map((action) => action.label), ['Run']);
  assert.equal(actions[0].className, 'button confirm');
});

test('update-ready version entries do not render a duplicate status chip', () => {
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

test('toast progress does not change the Version card render key', () => {
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

test('running operations still suppress version card actions', () => {
  const action = actionForEntry({
    tag: 'latest',
    availability: 'installing',
    isActive: true
  }, {});

  assert.equal(action, null);
});

test('version cards offer Runtime Setup until Docker becomes reachable', () => {
  const unavailable = { dockerAvailable: false, runtime: { state: 'not_provisioned' } };
  for (const availability of ['available', 'installed']) {
    assert.equal(actionForEntry({ tag: 'latest', availability }, unavailable).label, 'Runtime Setup');
    assert.equal(actionForEntry({ tag: 'latest', availability }, { ...unavailable, dockerAvailable: true }).label,
      availability === 'installed' ? 'Run' : 'Install');
  }
  assert.notEqual(installCardsRenderKey(unavailable), installCardsRenderKey({ ...unavailable, dockerAvailable: true }));
  assert.equal(actionForEntry({ tag: 'latest', availability: 'available' }, { ...unavailable, runtime: { state: 'ready' } }).label, 'Install');
});

test('installed and differing version cards can expose remove control', () => {
  assert.equal(canRemoveEntry({ availability: 'installed' }), true);
  assert.equal(canRemoveEntry({ availability: 'update_available' }), true);
  assert.equal(canRemoveEntry({ availability: 'available' }), false);
  assert.equal(canRemoveEntry({ availability: 'installing' }), false);
  assert.equal(canRemoveEntry({ availability: 'available', differsFromPublished: true }), true);
  assert.equal(canRemoveEntry({ availability: 'installed', isBackendImage: false }), false);
});

test('installed filter keeps local or in-progress versions only', () => {
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

test('default run names use Docker-like random pairs', () => {
  assert.equal(defaultInstanceName('latest', {}, () => 0), 'brave-ada');
});

test('default run names avoid existing random pairs', () => {
  const name = defaultInstanceName('latest', {
    containers: [
      { instanceName: 'brave-ada' }
    ]
  }, () => 0);

  assert.equal(name, 'brave-bohr');
});

test('release match badge labels omit leading v', () => {
  assert.equal(releaseMatchBadgeLabel('v1.20'), '1.20');
  assert.equal(releaseMatchBadgeLabel('ready'), 'ready');
});

test('channel version cards display update dates from channel metadata or matched releases', () => {
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

test('channel version card meta keeps only date and size', () => {
  const updatedAt = '2026-06-25T12:44:56.141Z';
  const entries = [
    {
      tag: 'ready',
      title: 'ready',
      updatedAt,
      sizeBytes: 12348030976,
      matchHint: 'Differs from published ready',
      digestHint: 'Published: 648b9703656b / Local: dea8d7301edd'
    }
  ];

  assert.deepEqual(metaPartsForEntry(entries[0], entries), [
    `Updated ${new Date(updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`,
    '11.5 GB'
  ]);
});

test('version catalog pins v3 and collapses numbered version groups by default', () => {
  const model = buildInstallCatalogModel([
    { tag: 'v1.20', title: '1.20' },
    { tag: 'v3', title: 'v3', availability: 'available' },
    { tag: 'ready', title: 'ready' },
    { tag: 'v0.9', title: '0.9' },
    { tag: 'v2.0', title: '2.0' },
    { tag: 'latest', title: 'latest' },
    { tag: 'v1.19', title: '1.19' }
  ]);

  assert.deepEqual(model.channels.map((entry) => entry.tag), ['latest', 'ready', 'v3']);
  assert.equal(actionForEntry(model.channels[2], { dockerAvailable: true }).label, 'Install');
  assert.equal(versionVisualLabel(model.channels[2].title), 'v3');
  assert.equal(versionVisualLabel('v3.1'), '3.1');
  assert.deepEqual(model.groups.map((group) => group.major), [2, 1, 0]);
  assert.deepEqual(model.groups.map((group) => group.defaultOpen), [false, false, false]);
  assert.deepEqual(model.groups[1].entries.map((entry) => entry.tag), ['v1.20', 'v1.19']);
});
