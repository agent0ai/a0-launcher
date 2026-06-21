const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { test } = require('node:test');

const dockerManager = require('./index');

const {
  WORKSPACE_MOUNT_TARGET,
  resolveWorkspaceStorage,
  applyWorkspaceStorage,
  workspaceStorageFromInspect,
  workspaceHostPathFromInspect,
  buildCloneCreateOptions
} = dockerManager._test;

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'a0-launcher-storage-'));
}

test('host directory workspace storage creates a per-container /a0/usr mount and labels', async () => {
  const root = await tempRoot();
  const storage = await resolveWorkspaceStorage({
    preferences: { mode: 'host_directory', hostRoot: root, volumePrefix: 'a0-launcher' },
    instanceName: 'Agent Zero',
    containerName: 'a0-inst-agent-zero-abc123'
  });
  const createOptions = { Labels: {}, HostConfig: {} };

  applyWorkspaceStorage(createOptions, storage);

  assert.equal(storage.mode, 'host_directory');
  assert.equal(storage.target, WORKSPACE_MOUNT_TARGET);
  assert.equal(storage.hostPath, path.join(root, 'a0-inst-agent-zero-abc123', 'usr'));
  assert.equal(createOptions.HostConfig.Mounts[0].Type, 'bind');
  assert.equal(createOptions.HostConfig.Mounts[0].Target, WORKSPACE_MOUNT_TARGET);
  assert.equal(createOptions.Labels['a0.launcher.storage.mode'], 'host_directory');
  assert.equal(createOptions.Labels['a0.launcher.storage.persistent'], 'true');
});

test('named volume workspace storage uses the configured prefix', async () => {
  const storage = await resolveWorkspaceStorage({
    preferences: { mode: 'named_volume', hostRoot: '~/agent-zero', volumePrefix: 'a0-test' },
    instanceName: 'Agent Zero',
    containerName: 'a0-inst-agent-zero-xyz789'
  });

  assert.equal(storage.mode, 'named_volume');
  assert.equal(storage.volumeName, 'a0-test-a0-inst-agent-zero-xyz789-usr');
  assert.deepEqual(storage.mount, {
    Type: 'volume',
    Source: storage.volumeName,
    Target: WORKSPACE_MOUNT_TARGET
  });
});

test('ephemeral workspace storage labels the container without a /a0/usr mount', async () => {
  const storage = await resolveWorkspaceStorage({
    preferences: { mode: 'host_directory', hostRoot: '~/agent-zero', volumePrefix: 'a0-launcher' },
    override: { storageMode: 'ephemeral' },
    instanceName: 'Agent Zero',
    containerName: 'a0-inst-agent-zero-ephemeral'
  });
  const createOptions = { Labels: {}, HostConfig: {} };

  applyWorkspaceStorage(createOptions, storage);

  assert.equal(storage.mode, 'ephemeral');
  assert.equal(storage.target, WORKSPACE_MOUNT_TARGET);
  assert.equal(storage.persistent, false);
  assert.equal(createOptions.HostConfig.Mounts, undefined);
  assert.equal(createOptions.Labels['a0.launcher.storage.mode'], 'ephemeral');
  assert.equal(createOptions.Labels['a0.launcher.storage.persistent'], 'false');

  const detected = workspaceStorageFromInspect({
    Config: { Labels: createOptions.Labels },
    Mounts: []
  });
  assert.equal(detected.mode, 'ephemeral');
  assert.equal(detected.persistent, false);
  assert.equal(detected.legacy, false);
  assert.equal(detected.migrationAvailable, true);
});

test('workspace storage detection distinguishes legacy and persistent containers', () => {
  const legacy = workspaceStorageFromInspect({ Config: { Labels: {} }, Mounts: [] });
  assert.equal(legacy.mode, 'legacy_ephemeral');
  assert.equal(legacy.persistent, false);
  assert.equal(legacy.migrationAvailable, true);

  const persistent = workspaceStorageFromInspect({
    Config: { Labels: {} },
    Mounts: [{ Type: 'bind', Source: '/tmp/a0/usr', Destination: WORKSPACE_MOUNT_TARGET }]
  });
  assert.equal(persistent.mode, 'host_directory');
  assert.equal(persistent.persistent, true);
  assert.equal(persistent.hostPath, '/tmp/a0/usr');
});

test('workspace host folder resolver only returns persistent bind paths', () => {
  const bindInspect = {
    Config: { Labels: {} },
    Mounts: [{ Type: 'bind', Source: '/tmp/a0/usr', Destination: WORKSPACE_MOUNT_TARGET }]
  };
  const volumeInspect = {
    Config: { Labels: {} },
    Mounts: [{ Type: 'volume', Name: 'a0-volume', Source: '/var/lib/docker/volumes/a0-volume/_data', Destination: WORKSPACE_MOUNT_TARGET }]
  };
  const ephemeralInspect = { Config: { Labels: {} }, Mounts: [] };

  assert.equal(workspaceHostPathFromInspect(bindInspect), '/tmp/a0/usr');
  assert.equal(workspaceHostPathFromInspect(volumeInspect), '');
  assert.equal(workspaceHostPathFromInspect(ephemeralInspect), '');
});

test('clone create options replace source workspace mounts with a fresh workspace', async () => {
  const root = await tempRoot();
  const inspect = {
    Name: '/a0-inst-main',
    Config: {
      Image: 'agent0ai/agent-zero:latest',
      Labels: {
        'a0.launcher.managed': 'true',
        'a0.launcher.role': 'instance',
        'a0.launcher.instanceName': 'Main'
      },
      Env: ['A0_TEST=1'],
      ExposedPorts: { '80/tcp': {} }
    },
    HostConfig: {
      PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '32080' }] },
      Mounts: [{ Type: 'bind', Source: '/old/usr', Target: WORKSPACE_MOUNT_TARGET }],
      Binds: ['/old/other:/a0/other:rw', '/old/usr:/a0/usr:rw']
    }
  };

  const options = await buildCloneCreateOptions(
    inspect,
    'container-id',
    'a0-launcher-clone:clone-test',
    { mode: 'host_directory', hostRoot: root, volumePrefix: 'a0-launcher' },
    { containerName: 'a0-inst-main-clone-test' }
  );

  assert.equal(options.Labels['a0.launcher.role'], 'clone');
  assert.equal(options.Labels['a0.launcher.storage.mode'], 'host_directory');
  assert.equal(options.HostConfig.Mounts.length, 1);
  assert.equal(options.HostConfig.Mounts[0].Target, WORKSPACE_MOUNT_TARGET);
  assert.equal(options.HostConfig.Mounts[0].Source, path.join(root, 'a0-inst-main-clone-test', 'usr'));
  assert.deepEqual(options.HostConfig.Binds, ['/old/other:/a0/other:rw']);
  assert.equal(options.HostConfig.PortBindings['80/tcp'][0].HostPort, '0');
});
