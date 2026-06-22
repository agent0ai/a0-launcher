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
  buildCloneCreateOptions,
  normalizeCloneWorkspaceSelection,
  selectedCloneWorkspaceCategoryIds,
  cloneWorkspaceSelectionIsAll,
  filterEnvTextForClone,
  filterSettingsJsonForClone,
  copySelectedWorkspaceData
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
  assert.equal(options.Labels['a0.launcher.cloneWorkspaceFull'], 'true');
});

test('clone workspace selection defaults to the full Agent Zero backup scope', () => {
  const selection = normalizeCloneWorkspaceSelection(null);

  assert.equal(cloneWorkspaceSelectionIsAll(selection), true);
  assert.deepEqual(selectedCloneWorkspaceCategoryIds(selection), [
    'auth',
    'secrets',
    'providers',
    'mcp',
    'settings',
    'agents',
    'chats',
    'skills',
    'plugins',
    'projects',
    'memory',
    'files'
  ]);
});

test('clone workspace selection can intentionally create an empty workspace', () => {
  const selection = normalizeCloneWorkspaceSelection(false);

  assert.equal(cloneWorkspaceSelectionIsAll(selection), false);
  assert.deepEqual(selectedCloneWorkspaceCategoryIds(selection), []);
});

test('clone env filtering separates auth from API keys for partial clones', () => {
  const envText = [
    'AUTH_LOGIN=dev1',
    'AUTH_PASSWORD=secret',
    'API_KEY_OPENAI=sk-test',
    'GITHUB_PAT_TOKEN=ghp-test',
    'DEFAULT_USER_TIMEZONE=Europe/Rome',
    'A0_PERSISTENT_RUNTIME_ID=runtime-id',
    ''
  ].join('\n');

  assert.equal(
    filterEnvTextForClone(envText, normalizeCloneWorkspaceSelection(['auth'])),
    'AUTH_LOGIN=dev1\nAUTH_PASSWORD=secret\n'
  );
  assert.equal(
    filterEnvTextForClone(envText, normalizeCloneWorkspaceSelection(['secrets'])),
    'API_KEY_OPENAI=sk-test\nGITHUB_PAT_TOKEN=ghp-test\n'
  );
  assert.equal(
    filterEnvTextForClone(envText, normalizeCloneWorkspaceSelection(['settings'])),
    'DEFAULT_USER_TIMEZONE=Europe/Rome\n'
  );
});

test('clone settings filtering keeps only selected category fields', () => {
  const source = JSON.stringify({
    version: 'v1',
    mcp_servers: '{"mcpServers":{}}',
    mcp_server_enabled: true,
    timezone: 'Europe/Rome',
    workdir_path: '/a0/usr/workdir',
    auth_login: 'should-not-copy',
    auth_password: 'should-copy-with-auth',
    root_password: 'root-secret',
    rfc_password: 'rfc-secret',
    api_keys: { openai: 'should-not-copy' },
    secrets: 'should-copy-with-secrets',
    mcp_server_token: 'mcp-token-secret'
  });

  const filtered = JSON.parse(filterSettingsJsonForClone(source, normalizeCloneWorkspaceSelection(['mcp', 'settings'])));

  assert.equal(filtered.version, 'v1');
  assert.equal(filtered.mcp_server_enabled, true);
  assert.equal(filtered.timezone, 'Europe/Rome');
  assert.equal(filtered.workdir_path, '/a0/usr/workdir');
  assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'auth_login'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'api_keys'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(filtered, 'secrets'), false);

  const authFiltered = JSON.parse(filterSettingsJsonForClone(source, normalizeCloneWorkspaceSelection(['auth'])));
  assert.equal(authFiltered.auth_password, 'should-copy-with-auth');
  assert.equal(authFiltered.root_password, 'root-secret');
  assert.equal(authFiltered.rfc_password, 'rfc-secret');
  assert.equal(Object.prototype.hasOwnProperty.call(authFiltered, 'api_keys'), false);

  const secretFiltered = JSON.parse(filterSettingsJsonForClone(source, normalizeCloneWorkspaceSelection(['secrets'])));
  assert.deepEqual(secretFiltered.api_keys, { openai: 'should-not-copy' });
  assert.equal(secretFiltered.secrets, 'should-copy-with-secrets');
  assert.equal(secretFiltered.mcp_server_token, 'mcp-token-secret');
  assert.equal(Object.prototype.hasOwnProperty.call(secretFiltered, 'auth_password'), false);
});

test('agent profiles clone separately from workspace files', async () => {
  const calls = [];
  const fakeDocker = {
    async copyContainerPathToContainer(_sourceId, sourcePath, _targetId, targetPath) {
      calls.push(['copy', sourcePath, targetPath]);
      return { copied: true };
    }
  };

  await copySelectedWorkspaceData(
    fakeDocker,
    'source-id',
    'target-id',
    normalizeCloneWorkspaceSelection(['files'])
  );

  assert.ok(calls.some((call) => call[1] === '/a0/usr/workdir'));
  assert.ok(calls.some((call) => call[1] === '/a0/usr/api'));
  assert.equal(calls.some((call) => call[1] === '/a0/usr/agents'), false);

  calls.length = 0;
  await copySelectedWorkspaceData(
    fakeDocker,
    'source-id',
    'target-id',
    normalizeCloneWorkspaceSelection(['agents'])
  );

  assert.deepEqual(calls, [
    ['copy', '/a0/usr/agents', '/a0/usr']
  ]);
});

test('auth-only clone copies auth settings without provider or MCP categories', async () => {
  const writes = [];
  const fakeDocker = {
    async readContainerTextFile(_containerId, filePath) {
      if (filePath.endsWith('/.env')) return 'AUTH_LOGIN=dev1\nAPI_KEY_OPENAI=sk-test\n';
      if (filePath.endsWith('/settings.json')) {
        return JSON.stringify({
          version: 'v1',
          auth_login: 'dev1',
          auth_password: 'secret',
          litellm_global_kwargs: { provider: 'openai' },
          mcp_servers: '{"mcpServers":{}}'
        });
      }
      return null;
    },
    async writeContainerTextFile(_containerId, filePath, text) {
      writes.push([filePath, text]);
      return { written: true };
    },
    async copyContainerPathToContainer() {
      return { copied: true };
    }
  };

  await copySelectedWorkspaceData(
    fakeDocker,
    'source-id',
    'target-id',
    normalizeCloneWorkspaceSelection(['auth'])
  );

  assert.deepEqual(writes, [
    ['/a0/usr/.env', 'AUTH_LOGIN=dev1\n'],
    ['/a0/usr/settings.json', '{\n    "version": "v1",\n    "auth_login": "dev1",\n    "auth_password": "secret"\n}\n']
  ]);
});

test('selected clone workspace copy filters shared files and reserved plugin state', async () => {
  const calls = [];
  const fakeDocker = {
    async readContainerTextFile(_containerId, filePath) {
      if (filePath.endsWith('/.env')) {
        return 'AUTH_LOGIN=dev1\nAUTH_PASSWORD=secret\nAPI_KEY_OPENAI=sk-test\nA0_PERSISTENT_RUNTIME_ID=runtime-id\n';
      }
      if (filePath.endsWith('/settings.json')) {
        return JSON.stringify({
          version: 'v1',
          mcp_servers: '{"mcpServers":{}}',
          timezone: 'Europe/Rome',
          auth_login: 'blank'
        });
      }
      return null;
    },
    async writeContainerTextFile(_containerId, filePath, text) {
      calls.push(['write', filePath, text]);
      return { written: true };
    },
    async ensureContainerDirectory(_containerId, directoryPath) {
      calls.push(['mkdir', directoryPath]);
      return { created: true };
    },
    async listContainerDirectory(_containerId, directoryPath) {
      calls.push(['list', directoryPath]);
      return [
        { name: '_model_config', type: 'directory' },
        { name: '_oauth', type: 'directory' },
        { name: 'custom_plugin', type: 'directory' },
        { name: 'AGENTS.md', type: 'file' }
      ];
    },
    async copyContainerPathToContainer(_sourceId, sourcePath, _targetId, targetPath) {
      calls.push(['copy', sourcePath, targetPath]);
      return { copied: true };
    }
  };

  const result = await copySelectedWorkspaceData(
    fakeDocker,
    'source-id',
    'target-id',
    normalizeCloneWorkspaceSelection(['auth', 'providers', 'mcp', 'plugins'])
  );

  assert.equal(result.fullWorkspace, false);
  assert.equal(result.copied, true);
  assert.deepEqual(calls.filter((call) => call[0] === 'write'), [
    ['write', '/a0/usr/.env', 'AUTH_LOGIN=dev1\nAUTH_PASSWORD=secret\n'],
    ['write', '/a0/usr/settings.json', '{\n    "version": "v1",\n    "auth_login": "blank",\n    "mcp_servers": "{\\"mcpServers\\":{}}"\n}\n']
  ]);
  assert.ok(calls.some((call) => call[0] === 'copy' && call[1] === '/a0/usr/plugins/_model_config'));
  assert.equal(calls.some((call) => call[0] === 'copy' && call[1] === '/a0/usr/plugins/_oauth'), false);
  assert.ok(calls.some((call) => call[0] === 'copy' && call[1] === '/a0/usr/plugins/custom_plugin'));
});
