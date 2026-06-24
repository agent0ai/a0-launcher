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

const { computeCardMenuPlacement, instanceVisualBadge } = await import('./local-testing.js');

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
