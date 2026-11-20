const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a0-launcher-catalog-'));
const electronPath = require.resolve('electron');
const previousElectron = require.cache[electronPath];
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { getPath: () => testRoot }, safeStorage: null }
};
const adapter = require('../docker_adapter/getDocker');
const releasesClient = require('./releases_client');
const stateStore = require('./state_store');
const managerPath = require.resolve('./index');

after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
  delete require.cache[managerPath];
  if (previousElectron) require.cache[electronPath] = previousElectron;
  else delete require.cache[electronPath];
});

test('release catalog works without Docker and preserves cached/offline and reachable-runtime behavior', async (t) => {
  const { RuntimeProvisioner } = await import('../docker_adapter/RuntimeProvisioner.mjs');
  t.mock.method(RuntimeProvisioner, 'forPlatform', async () => ({
    assess: async () => ({ state: 'not_provisioned', mode: 'wsl_feature', detail: 'Finish local Agent Zero runtime Setup.' })
  }));
  t.mock.method(stateStore, 'readRemoteInstances', async () => [{ id: 'remote-test', name: 'Remote', url: 'http://127.0.0.1:1' }]);
  t.mock.method(stateStore, 'readRemoteInstanceCredentialsMetadata', async () => ({ 'remote-test': { saved: true, username: 'alice' } }));
  const releaseRequests = [];
  let scenario;
  t.mock.method(releasesClient, 'listOfficialReleases', async (options) => {
    releaseRequests.push(options);
    if (scenario === 'offline-empty') throw new Error('GitHub unavailable');
    return {
      releases: [{ tag: 'v2.0', publishedAt: '2026-06-24T12:00:00Z' }],
      offline: scenario === 'offline-cached',
      lastSyncedAt: '2026-06-24T12:00:00Z'
    };
  });
  const localCalls = [];
  const docker = {
    getEnvironment: async () => ({ dockerAvailable: scenario === 'ready' }),
    getRuntimeDiagnostics: async () => ({ reachable: scenario === 'diagnostic-ready' }),
    listLocalImages: async () => { localCalls.push('images'); return [{ tag: 'latest', imageId: 'local-image' }]; },
    listContainers: async () => { localCalls.push('containers'); return []; },
    listRemoteTags: async () => ['latest', 'ready', 'v3', 'testing', 'v2.0'],
    getRemoteDigest: async () => ({ exists: true, digest: 'sha256:published' }),
    getRemoteTagMetadata: async () => ({ exists: true, updatedAt: '2026-06-24T12:00:00Z' }),
    getRemoteLayerSizes: async () => { throw Object.assign(new Error('Stop warmup'), { code: 'REGISTRY_RATE_LIMIT' }); }
  };
  t.mock.method(adapter, 'getDocker', async () => docker);
  t.mock.method(console, 'error', () => {});
  delete require.cache[managerPath];
  const manager = require('./index');

  assert.equal(manager.assertTagAllowedForInstall('v3'), 'v3');
  assert.throws(() => manager.assertTagAllowedForInstall('v4'), { code: 'TAG_NOT_ALLOWED' });

  for (scenario of ['missing', 'offline-cached', 'offline-empty', 'ready', 'diagnostic-ready']) {
    for (const forceRefresh of [false, true]) {
      localCalls.length = 0;
      const state = await manager.refreshDockerManager({ forceRefresh });
      const available = scenario === 'ready' || scenario === 'diagnostic-ready';
      assert.equal(releaseRequests.at(-1).forceRefresh, forceRefresh);
      assert.equal(state.versions.some((entry) => entry.id === 'v2.0'), scenario !== 'offline-empty');
      assert.equal(state.offline, scenario.startsWith('offline'));
      assert.equal(state.lastSyncedAt, scenario === 'offline-empty' ? null : '2026-06-24T12:00:00Z');
      assert.equal(state.versions.find((entry) => entry.id === 'latest').availability, available ? 'installed' : 'available');
      const v3 = state.versions.find((entry) => entry.id === 'v3');
      assert.equal(v3?.category, 'official_release');
      assert.equal(v3?.installability, 'installable');
      assert.equal(v3?.updatedAt, '2026-06-24T12:00:00.000Z');
      assert.deepEqual(localCalls, available ? ['images', 'containers'] : []);
      assert.equal(state.runtime.state, available ? 'ready' : 'not_provisioned');
      assert.equal(state.remoteInstances[0].launcherCredentials.username, 'alice');
    }
  }
  assert.equal(releaseRequests.length, 10);
});
