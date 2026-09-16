const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a0-launcher-state-store-'));
const electronPath = require.resolve('electron');
const previousElectronModule = require.cache[electronPath];
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => testRoot },
    safeStorage: null
  }
};
const stateStorePath = require.resolve('./state_store');
delete require.cache[stateStorePath];
const stateStore = require('./state_store');

after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
  delete require.cache[stateStorePath];
  if (previousElectronModule) require.cache[electronPath] = previousElectronModule;
  else delete require.cache[electronPath];
});

function settings(portPreferences, hostRoot) {
  return {
    portPreferences,
    storagePreferences: {
      mode: 'host_directory',
      hostRoot,
      hostPathMode: 'per_instance',
      volumePrefix: 'a0-launcher'
    },
    instanceDefaults: {
      models: {
        Main: { provider: 'openrouter', model: 'openai/gpt-5', apiKey: '' },
        Utility: { provider: 'openrouter', model: '', apiKey: '' },
        Embedding: { provider: 'huggingface', model: '', apiKey: '' }
      }
    },
    hostAccess: {
      onboardingComplete: true,
      defaults: {
        configured: false,
        masterEnabled: false,
        folder: '',
        scopes: {
          files: true,
          file_write: true,
          code_execution: true,
          browser: false,
          computer_use: false
        }
      }
    },
    a0Tag: {
      version: 1,
      enabled: true,
      instanceKey: 'local:abc123',
      defaultProfile: 'developer'
    }
  };
}

test('onboarding persists local intent and completion across reloads and stale concurrent writes', async () => {
  await stateStore.writeJson(stateStore.stateFile(), {});
  assert.equal(await stateStore.readOnboarding(), 'new');
  assert.equal(await stateStore.writeOnboarding('local'), 'local');
  const stale = await stateStore.readJson(stateStore.stateFile(), {});
  assert.equal(await stateStore.readOnboarding(), 'local');
  assert.equal(await stateStore.readOnboarding({ containers: [{ containerId: 'first-instance' }] }), 'complete');
  await Promise.all([
    stateStore.writeJson(stateStore.stateFile(), { ...stale, portPreferences: { ui: 7777, ssh: 55022 } }),
    stateStore.writeOnboarding('local')
  ]);
  delete require.cache[stateStorePath];
  const reloaded = require('./state_store');
  assert.equal(await reloaded.readOnboarding({ containers: [], remoteInstances: [] }), 'complete');
  assert.equal((await reloaded.readJson(reloaded.stateFile(), {})).onboarding, 'complete');
});

test('onboarding recognizes remote and legacy Instance evidence without a running runtime', async () => {
  const reset = (state) => fs.writeFileSync(stateStore.stateFile(), JSON.stringify(state));
  for (const state of [
    { remoteInstances: [{ id: 'remote-1', name: 'VPS', url: 'https://a0.example.com/' }] },
    { localInstanceNames: { 'abcdef123456': 'My Agent Zero' } },
    { hostAccess: { instances: { 'local:abcdef123456': { configured: true } } } }
  ]) {
    reset(state);
    assert.equal(await stateStore.readOnboarding(), 'complete');
    assert.equal((await stateStore.readJson(stateStore.stateFile(), {})).onboarding, 'complete');
  }
  reset({ hostAccess: { onboardingComplete: true }, runtimeEndpointPreference: { id: 'docker' } });
  assert.equal(await stateStore.readOnboarding(), 'new');
  reset({ runtimeSetupResume: { pending: true } });
  assert.equal(await stateStore.readOnboarding(), 'local');
  reset({});
  await stateStore.writeRuntimeIdentityCache({ entries: { 'local:previous-instance': { runtimeSource: { branch: 'ready' } } } });
  assert.equal(await stateStore.readOnboarding(), 'complete');
  await stateStore.writeRuntimeIdentityCache({ entries: {} });
  reset({});
  const remote = await stateStore.writeRemoteInstance({ name: 'VPS', url: 'https://a0.example.com/' });
  await stateStore.deleteRemoteInstance(remote.id);
  assert.equal(await stateStore.readOnboarding(), 'complete');
  reset({});
});

test('unreadable onboarding state is an error, never a new-install signal', async () => {
  fs.writeFileSync(stateStore.stateFile(), '{broken');
  await assert.rejects(stateStore.readOnboarding());
  fs.writeFileSync(stateStore.stateFile(), '{}');
});

test('Settings write preserves the previous port pair when duplicate ports are rejected', async () => {
  const first = await stateStore.writeSettings(settings({ ui: 7777, ssh: 55022 }, '/tmp/first'));
  assert.deepEqual(first.saved, {
    portPreferences: true,
    storagePreferences: true,
    instanceDefaults: true,
    hostAccess: true,
    a0Tag: true
  });

  const partial = await stateStore.writeSettings(settings({ ui: 6000, ssh: 6000 }, '/tmp/second'));
  assert.equal(partial.saved.portPreferences, false);
  assert.deepEqual(partial.portPreferences, { ui: 7777, ssh: 55022 });
  assert.equal(partial.storagePreferences.hostRoot, '/tmp/second');

  const persisted = JSON.parse(fs.readFileSync(stateStore.stateFile(), 'utf8'));
  assert.deepEqual(persisted.portPreferences, { ui: 7777, ssh: 55022 });
  assert.equal(persisted.storagePreferences.hostRoot, '/tmp/second');
  assert.equal(persisted.instanceDefaults.models.Main.model, 'openai/gpt-5');
  assert.equal(persisted.hostAccess.onboardingComplete, true);
  assert.deepEqual(persisted.a0Tag, {
    version: 1,
    enabled: true,
    instanceKey: 'local:abc123',
    defaultProfile: 'developer'
  });
});

test('A0 Tag defaults off and an incomplete enabled section does not block other Settings', async () => {
  assert.deepEqual(stateStore.normalizeA0TagSettings(null), stateStore.DEFAULT_A0_TAG_SETTINGS);
  assert.deepEqual(stateStore.normalizeA0TagSettings({
    enabled: true,
    instanceKey: 'remote:remote-1',
    defaultProfile: 'Graphic_Designer'
  }), {
    version: 1,
    enabled: true,
    instanceKey: 'remote:remote-1',
    defaultProfile: 'Graphic_Designer'
  });

  await stateStore.writeSettings(settings({ ui: 7001, ssh: 55022 }, '/tmp/a0-tag-baseline'));
  const incomplete = settings({ ui: 7000, ssh: 55022 }, '/tmp/third');
  incomplete.a0Tag = { enabled: true, instanceKey: 'local:abc123', defaultProfile: '' };
  const saved = await stateStore.writeSettings(incomplete);

  assert.equal(saved.saved.a0Tag, false);
  assert.equal(saved.storagePreferences.hostRoot, '/tmp/third');
  assert.equal(saved.a0Tag.defaultProfile, 'developer');
});

test('local and remote appearance retain uploaded images and explicit Globe, or reset to Favicon', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const id = 'abcdef123456';
  const remote = await stateStore.writeRemoteInstance({ name: 'Icons', url: 'https://icons.example.com/' });
  for (const icon of ['language', image, '']) {
    await stateStore.writeLocalInstanceAppearance(id, { icon });
    await stateStore.writeRemoteInstance({ ...remote, icon });
    assert.equal((await stateStore.readLocalInstanceIcons())[id] || '', icon);
    assert.equal((await stateStore.readRemoteInstances()).find((item) => item.id === remote.id).icon || '', icon);
  }
  for (const color of ['#A1B2C3', 'green', '']) {
    await stateStore.writeLocalInstanceAppearance(id, { color });
    await stateStore.writeRemoteInstance({ ...remote, color });
    assert.equal((await stateStore.readLocalInstanceColors())[id] || '', color.toLowerCase());
    assert.equal((await stateStore.readRemoteInstances()).find((item) => item.id === remote.id).color || '', color.toLowerCase());
  }
});
