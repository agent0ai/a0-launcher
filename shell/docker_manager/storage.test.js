const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { test } = require('node:test');
const tarStream = require('tar-stream');
const yauzl = require('yauzl');

const dockerManager = require('./index');

const {
  WORKSPACE_MOUNT_TARGET,
  resolveWorkspaceStorage,
  applyWorkspaceStorage,
  windowsPathToWslMountSource,
  dockerMountSourceForHostPath,
  workspaceStorageFromInspect,
  workspaceHostPathFromInspect,
  waitForUiReachable,
  parsePortMappings,
  settlePortMappings,
  replacementPortMappingsFromInspect,
  buildCloneCreateOptions,
  normalizeCloneWorkspaceSelection,
  selectedCloneWorkspaceCategoryIds,
  cloneWorkspaceSelectionIsAll,
  filterEnvTextForClone,
  filterSettingsJsonForClone,
  copySelectedWorkspaceData,
  workspaceTarEntryFromBackupEntry,
  buildAgentZeroBackupMetadata,
  createAgentZeroBackupZip,
  restoreAgentZeroBackupZip
} = dockerManager._test;

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'a0-launcher-storage-'));
}

function listenLocalServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function makeTarStream(entries) {
  const pack = tarStream.pack();
  for (const entry of entries) {
    const data = Buffer.from(entry.text || '', 'utf8');
    await new Promise((resolve, reject) => {
      const header = {
        name: entry.name,
        type: entry.type || 'file',
        mode: entry.mode || 0o644,
        mtime: entry.mtime || new Date('2026-06-23T10:00:00.000Z')
      };
      if (entry.type === 'directory') {
        pack.entry(header, (error) => (error ? reject(error) : resolve()));
      } else {
        pack.entry(header, data, (error) => (error ? reject(error) : resolve()));
      }
    });
  }
  pack.finalize();
  return pack;
}

function readZipEntries(filePath) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openError, zipfile) => {
      if (openError) {
        reject(openError);
        return;
      }
      zipfile.on('entry', (entry) => {
        const name = String(entry?.fileName || '');
        if (!name || name.endsWith('/')) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          stream.once('error', reject);
          stream.once('end', () => {
            entries.set(name, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.once('error', reject);
      zipfile.once('end', () => resolve(entries));
      zipfile.readEntry();
    });
  });
}

function collectTarEntries(stream) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const extract = tarStream.extract();
    extract.on('entry', (header, entryStream, next) => {
      const chunks = [];
      entryStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      entryStream.once('error', reject);
      entryStream.once('end', () => {
        entries.push({
          name: header.name,
          type: header.type,
          text: Buffer.concat(chunks).toString('utf8')
        });
        next();
      });
    });
    extract.once('error', reject);
    extract.once('finish', () => resolve(entries));
    stream.pipe(extract);
  });
}

test('UI readiness wait retries while a published port is still warming up', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    res.on('error', () => {});
    hits += 1;
    if (hits === 1) {
      const timer = setTimeout(() => {
        if (!res.destroyed && !res.writableEnded) res.end('late');
      }, 180);
      if (typeof timer.unref === 'function') timer.unref();
      return;
    }
    res.statusCode = 200;
    res.end('ok');
  });
  const address = await listenLocalServer(server);

  try {
    const fakeDocker = {
      async inspectContainer(containerId) {
        assert.equal(containerId, 'container-1');
        return {
          NetworkSettings: {
            Ports: {
              '80/tcp': [{ HostPort: String(address.port) }]
            }
          }
        };
      }
    };

    const result = await waitForUiReachable(fakeDocker, 'container-1', {
      timeoutMs: 1500,
      intervalMs: 30,
      attemptTimeoutMs: 90
    });

    assert.equal(result.ok, true);
    assert.equal(result.uiUrl, `http://127.0.0.1:${address.port}/`);
    assert.ok(hits >= 2);
  } finally {
    await closeServer(server);
  }
});

test('dynamic port mappings are settled before Docker container creation', async () => {
  const allocatorReservations = [];
  let nextPort = 32100;
  const mappings = await settlePortMappings(parsePortMappings('0:80, 55022:22'), {
    allocateHostPort: async (reserved) => {
      allocatorReservations.push([...reserved].sort((a, b) => a - b));
      return nextPort++;
    }
  });

  assert.deepEqual(mappings.map((mapping) => ({
    hostPort: mapping.hostPort,
    containerPort: mapping.containerPort,
    key: mapping.key,
    hostIp: mapping.hostIp
  })), [
    { hostPort: 32100, containerPort: 80, key: '80/tcp', hostIp: '127.0.0.1' },
    { hostPort: 55022, containerPort: 22, key: '22/tcp', hostIp: '127.0.0.1' }
  ]);
  assert.deepEqual(allocatorReservations, [[55022]]);
});

test('replacement port mappings prefer settled Docker network ports', () => {
  const runningDynamic = {
    HostConfig: {
      PortBindings: {
        '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }]
      }
    },
    NetworkSettings: {
      Ports: {
        '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '32769' }],
        '22/tcp': null
      }
    }
  };

  assert.deepEqual(replacementPortMappingsFromInspect(runningDynamic), [
    { hostPort: 32769, containerPort: 80, key: '80/tcp', hostIp: '127.0.0.1' }
  ]);

  const stoppedExplicit = {
    HostConfig: {
      PortBindings: {
        '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '32080' }]
      }
    },
    NetworkSettings: { Ports: {} }
  };

  assert.deepEqual(replacementPortMappingsFromInspect(stoppedExplicit), [
    { hostPort: 32080, containerPort: 80, key: '80/tcp', hostIp: '127.0.0.1' }
  ]);
});

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

test('Windows WSL runtime bind mounts use WSL-visible sources while labels keep host paths', () => {
  const hostPath = 'C:\\Users\\Ada Lovelace\\agent-zero\\a0-inst-agent-zero-latest\\usr';
  const fakeWslDocker = {
    env: {
      dockerFlavor: 'wsl_engine',
      dockerHost: { kind: 'tcp', host: '127.0.0.1', port: 23750 }
    }
  };
  const storage = {
    mode: 'host_directory',
    target: WORKSPACE_MOUNT_TARGET,
    persistent: true,
    legacy: false,
    hostPath,
    mount: {
      Type: 'bind',
      Source: hostPath,
      Target: WORKSPACE_MOUNT_TARGET
    }
  };
  const createOptions = { Labels: {}, HostConfig: {} };

  applyWorkspaceStorage(createOptions, storage, { docker: fakeWslDocker });

  assert.equal(windowsPathToWslMountSource(hostPath), '/mnt/c/Users/Ada Lovelace/agent-zero/a0-inst-agent-zero-latest/usr');
  assert.equal(dockerMountSourceForHostPath(hostPath, fakeWslDocker), '/mnt/c/Users/Ada Lovelace/agent-zero/a0-inst-agent-zero-latest/usr');
  assert.equal(createOptions.HostConfig.Mounts[0].Source, '/mnt/c/Users/Ada Lovelace/agent-zero/a0-inst-agent-zero-latest/usr');
  assert.equal(createOptions.HostConfig.Mounts[0].Target, WORKSPACE_MOUNT_TARGET);
  assert.equal(createOptions.Labels['a0.launcher.storage.hostPath'], hostPath);
});

test('non-WSL runtimes keep host-directory bind mount sources unchanged', () => {
  const hostPath = 'C:\\Users\\Ada\\agent-zero\\a0-inst\\usr';
  const fakeDesktopDocker = {
    env: {
      dockerFlavor: 'docker_desktop',
      dockerHost: { kind: 'npipe', socketPath: '//./pipe/docker_engine' }
    }
  };
  const storage = {
    mode: 'host_directory',
    target: WORKSPACE_MOUNT_TARGET,
    persistent: true,
    hostPath,
    mount: {
      Type: 'bind',
      Source: hostPath,
      Target: WORKSPACE_MOUNT_TARGET
    }
  };
  const createOptions = { Labels: {}, HostConfig: {} };

  applyWorkspaceStorage(createOptions, storage, { docker: fakeDesktopDocker });

  assert.equal(dockerMountSourceForHostPath(hostPath, fakeDesktopDocker), hostPath);
  assert.equal(createOptions.HostConfig.Mounts[0].Source, hostPath);
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

test('normalized storage overrides preserve explicit ephemeral mode', async () => {
  const storage = await resolveWorkspaceStorage({
    preferences: { mode: 'host_directory', hostRoot: '~/agent-zero', volumePrefix: 'a0-launcher' },
    override: { mode: 'ephemeral' },
    instanceName: 'Agent Zero',
    containerName: 'a0-inst-agent-zero-normalized-ephemeral'
  });

  assert.equal(storage.mode, 'ephemeral');
  assert.equal(storage.persistent, false);
  assert.equal(storage.mount, undefined);
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

  assert.equal(workspaceHostPathFromInspect(bindInspect), path.resolve('/tmp/a0/usr'));
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
    {
      containerName: 'a0-inst-main-clone-test',
      allocateHostPort: async () => 32123
    }
  );

  assert.equal(options.Labels['a0.launcher.role'], 'clone');
  assert.equal(options.Labels['a0.launcher.storage.mode'], 'host_directory');
  assert.equal(options.HostConfig.Mounts.length, 1);
  assert.equal(options.HostConfig.Mounts[0].Target, WORKSPACE_MOUNT_TARGET);
  assert.equal(options.HostConfig.Mounts[0].Source, path.join(root, 'a0-inst-main-clone-test', 'usr'));
  assert.deepEqual(options.HostConfig.Binds, ['/old/other:/a0/other:rw']);
  assert.equal(options.HostConfig.PortBindings['80/tcp'][0].HostPort, '32123');
  assert.equal(options.Labels['a0.launcher.port.map'], '32123:80');
  assert.equal(options.Labels['a0.launcher.port.ui'], '32123');
  assert.equal(options.Labels['a0.launcher.cloneWorkspaceFull'], 'true');
});

test('migration replacement preserves a running source container settled port', async () => {
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
      ExposedPorts: { '80/tcp': {} }
    },
    HostConfig: {
      PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] }
    },
    NetworkSettings: {
      Ports: {
        '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '32769' }]
      }
    }
  };

  const options = await buildCloneCreateOptions(
    inspect,
    'container-id',
    'a0-launcher-clone:clone-test',
    { mode: 'host_directory', hostRoot: root, volumePrefix: 'a0-launcher' },
    {
      role: 'instance',
      instanceName: 'Main',
      containerName: 'a0-inst-main-persistent',
      migrationSource: true,
      preserveSettledPorts: true,
      allocateHostPort: async () => {
        throw new Error('settled source port should not need allocation');
      }
    }
  );

  assert.equal(options.HostConfig.PortBindings['80/tcp'][0].HostPort, '32769');
  assert.equal(options.Labels['a0.launcher.port.map'], '32769:80');
  assert.equal(options.Labels['a0.launcher.port.ui'], '32769');
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

test('launcher backup metadata matches Agent Zero core /a0/usr backup shape', () => {
  const metadata = buildAgentZeroBackupMetadata({
    filePath: '/tmp/agent-zero-backup-main.zip',
    sourceName: 'Main',
    files: [
      {
        path: '/a0/usr/settings.json',
        size: 42,
        modified: '2026-06-23T10:00:00.000Z',
        type: 'file'
      }
    ]
  });

  assert.equal(metadata.backup_name, 'agent-zero-backup-main');
  assert.deepEqual(metadata.include_patterns, ['/a0/usr/**']);
  assert.deepEqual(metadata.backup_config.include_patterns, ['/a0/usr/**']);
  assert.equal(metadata.environment_info.agent_zero_root, '/a0');
  assert.equal(metadata.environment_info.working_directory, '/a0');
  assert.equal(metadata.system_info.source, 'Agent Zero Launcher');
  assert.equal(metadata.system_info.source_instance, 'Main');
  assert.equal(metadata.total_files, 1);
  assert.equal(metadata.backup_size, 42);
});

test('launcher restore maps only backup entries under the Agent Zero usr path', () => {
  assert.equal(
    workspaceTarEntryFromBackupEntry('a0/usr/settings.json', {
      environment_info: { agent_zero_root: '/a0' }
    }),
    'usr/settings.json'
  );
  assert.equal(
    workspaceTarEntryFromBackupEntry('/a0/usr/plugins/custom/plugin.yaml', {
      environment_info: { agent_zero_root: '/a0' }
    }),
    'usr/plugins/custom/plugin.yaml'
  );
  assert.equal(
    workspaceTarEntryFromBackupEntry('home/ada/a0/usr/chats/session.json', {
      environment_info: { agent_zero_root: '/home/ada/a0' }
    }),
    'usr/chats/session.json'
  );
  assert.equal(workspaceTarEntryFromBackupEntry('usr/workdir/readme.md', {}), 'usr/workdir/readme.md');
  assert.equal(workspaceTarEntryFromBackupEntry('metadata.json', {}), '');
  assert.equal(workspaceTarEntryFromBackupEntry('a0/data/not-workspace.txt', { environment_info: { agent_zero_root: '/a0' } }), '');
  assert.equal(workspaceTarEntryFromBackupEntry('../a0/usr/escape.txt', { environment_info: { agent_zero_root: '/a0' } }), '');
});

test('launcher backup zip exports and restores the Agent Zero usr archive shape', async () => {
  const root = await tempRoot();
  const backupPath = path.join(root, 'agent-zero-backup-main.zip');
  const fakeBackupDocker = {
    async getContainerPathArchive(containerId, sourcePath) {
      assert.equal(containerId, 'source-id');
      assert.equal(sourcePath, '/a0/usr');
      return await makeTarStream([
        { name: 'usr/', type: 'directory' },
        { name: 'usr/settings.json', text: '{"ok":true}\n' },
        { name: 'usr/plugins/custom/plugin.yaml', text: 'name: custom\n' },
        { name: 'tmp/outside.txt', text: 'ignore me\n' }
      ]);
    }
  };

  const backup = await createAgentZeroBackupZip(fakeBackupDocker, 'source-id', backupPath, { sourceName: 'Main' });
  const zipEntries = await readZipEntries(backupPath);
  const metadata = JSON.parse(zipEntries.get('metadata.json').toString('utf8'));

  assert.equal(backup.fileCount, 2);
  assert.equal(metadata.environment_info.agent_zero_root, '/a0');
  assert.deepEqual([...zipEntries.keys()].sort(), [
    'a0/usr/plugins/custom/plugin.yaml',
    'a0/usr/settings.json',
    'metadata.json'
  ]);
  assert.equal(zipEntries.get('a0/usr/settings.json').toString('utf8'), '{"ok":true}\n');

  let importedEntries = [];
  const fakeRestoreDocker = {
    async putContainerPathArchive(containerId, targetPath, archiveStream) {
      assert.equal(containerId, 'target-id');
      assert.equal(targetPath, '/a0');
      importedEntries = await collectTarEntries(archiveStream);
      return { imported: true };
    }
  };

  const restore = await restoreAgentZeroBackupZip(fakeRestoreDocker, 'target-id', backupPath);
  assert.equal(restore.restoredFiles, 2);
  assert.equal(restore.restoredBytes, Buffer.byteLength('{"ok":true}\n') + Buffer.byteLength('name: custom\n'));
  assert.deepEqual(importedEntries, [
    { name: 'usr/settings.json', type: 'file', text: '{"ok":true}\n' },
    { name: 'usr/plugins/custom/plugin.yaml', type: 'file', text: 'name: custom\n' }
  ]);
});
