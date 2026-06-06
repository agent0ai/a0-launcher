const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  chooseBrewPath,
  makeRuntimeSetupPlan,
  sanitizeCommandOutput,
  normalizeDockerHostOverride,
  normalizeRuntimeSetupState,
  dockerOptionsForRuntimeSetup,
  readInstalledFormulae,
  readPodmanMachines,
  runRuntimeSetup,
  runRuntimeSetupStep,
  setupError,
  HOMEBREW_INSTALL_COMMAND,
  HOMEBREW_INSTALL_ARGS,
  MAX_DOCKER_HOST_OVERRIDE_LENGTH,
  DEFAULT_A0_MACHINE_NAME
} = require('./runtime_setup');

test('chooseBrewPath prefers explicit Homebrew locations before PATH hits', () => {
  assert.equal(chooseBrewPath({
    exists: (candidate) => candidate === '/opt/homebrew/bin/brew',
    pathLookup: () => '/usr/local/bin/brew'
  }), '/opt/homebrew/bin/brew');
});

test('planner no-ops when Docker is already available', () => {
  const plan = makeRuntimeSetupPlan({
    platform: 'darwin',
    dockerAvailable: true
  });
  assert.deepEqual(plan.steps.map((step) => step.id), ['verify_existing_docker']);
  assert.equal(plan.ready, true);
});

test('planner installs Homebrew and packages on a clean macOS machine', () => {
  const plan = makeRuntimeSetupPlan({
    platform: 'darwin',
    dockerAvailable: false,
    brewPath: '',
    formulae: {},
    podmanMachines: []
  });
  assert.deepEqual(plan.steps.map((step) => step.id), [
    'install_homebrew',
    'install_formulae',
    'init_podman_machine',
    'start_podman_machine',
    'install_podman_helper',
    'restart_podman_machine',
    'set_podman_rootful',
    'verify_runtime'
  ]);
  assert.equal(plan.machineName, DEFAULT_A0_MACHINE_NAME);
});

test('planner halts instead of mutating an active non-A0 Podman machine', () => {
  const plan = makeRuntimeSetupPlan({
    platform: 'darwin',
    dockerAvailable: false,
    brewPath: '/opt/homebrew/bin/brew',
    formulae: { docker: true, 'docker-compose': true, 'docker-credential-helper': true, podman: true },
    podmanMachines: [{ name: 'work-machine', running: true }]
  });
  assert.equal(plan.blocked, true);
  assert.equal(plan.blockCode, 'PODMAN_MACHINE_EXISTS');
});

test('planner blocks when a running non-A0 Podman machine appears after a managed machine', () => {
  const plan = makeRuntimeSetupPlan({
    platform: 'darwin',
    dockerAvailable: false,
    brewPath: '/opt/homebrew/bin/brew',
    formulae: { docker: true, 'docker-compose': true, 'docker-credential-helper': true, podman: true },
    podmanMachines: [
      { name: DEFAULT_A0_MACHINE_NAME, running: true },
      { name: 'work-machine', running: true }
    ]
  });
  assert.equal(plan.blocked, true);
  assert.equal(plan.blockCode, 'PODMAN_MACHINE_EXISTS');
});

test('sanitizeCommandOutput redacts obvious password and token lines', () => {
  const output = 'ok\nPASSWORD=secret\napi_token: abc123\nfinished';
  assert.equal(sanitizeCommandOutput(output), 'ok\n[redacted]\n[redacted]\nfinished');
});

test('Homebrew install step pipes the fetched installer into bash noninteractively', async () => {
  const calls = [];
  await runRuntimeSetupStep({ id: 'install_homebrew' }, {
    brewPath: '/opt/homebrew/bin/brew',
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '', stderr: '' };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, HOMEBREW_INSTALL_COMMAND);
  assert.deepEqual(calls[0].args, HOMEBREW_INSTALL_ARGS);
  assert.equal(calls[0].args[0], '-c');
  assert.match(calls[0].args[1], /^\/usr\/bin\/curl -fsSL https:\/\/raw\.githubusercontent\.com\/Homebrew\/install\/HEAD\/install\.sh \| \/bin\/bash$/);
  assert.doesNotMatch(calls[0].args[1], /^\$\(/);
  assert.equal(calls[0].options.env.NONINTERACTIVE, '1');
});

test('dockerOptionsForRuntimeSetup preserves env fallback unless default socket is persisted', () => {
  assert.deepEqual(dockerOptionsForRuntimeSetup('agent0ai/agent-zero', {}), {
    imageRepo: 'agent0ai/agent-zero'
  });
  assert.deepEqual(dockerOptionsForRuntimeSetup('agent0ai/agent-zero', {
    usesDefaultDockerSocket: true
  }), {
    imageRepo: 'agent0ai/agent-zero',
    dockerHost: ''
  });
  assert.deepEqual(dockerOptionsForRuntimeSetup('agent0ai/agent-zero', {
    dockerHostOverride: 'unix:///tmp/podman.sock',
    usesDefaultDockerSocket: true
  }), {
    imageRepo: 'agent0ai/agent-zero',
    dockerHost: 'unix:///tmp/podman.sock'
  });
});

test('runRuntimeSetup no-ops without probing install tooling when Docker is already available', async () => {
  const progress = [];
  const result = await runRuntimeSetup({
    dockerAvailable: true,
    platform: 'darwin',
    runtimeSetupState: {},
    onProgress: (event) => progress.push(event),
    runProcess: async (command) => {
      throw setupError('UNEXPECTED_COMMAND', `Unexpected command: ${command}`);
    }
  });

  assert.equal(result.runtimeBackend, '');
  assert.equal(result.machineName, '');
  assert.equal(result.dockerHostOverride, '');
  assert.equal(result.usesDefaultDockerSocket, false);
  assert.ok(result.lastSuccessfulSetupAt);
  assert.deepEqual(progress, [{ stepId: 'verify_existing_docker', message: 'Docker is ready' }]);
});

test('runRuntimeSetup preserves explicit default socket metadata on ready no-op', async () => {
  const result = await runRuntimeSetup({
    dockerAvailable: true,
    platform: 'darwin',
    runtimeSetupState: {
      runtimeBackend: 'podman',
      machineName: 'a0-launcher',
      dockerHostOverride: '',
      usesDefaultDockerSocket: true,
      lastSuccessfulSetupAt: '2026-06-05T00:00:00.000Z'
    },
    runProcess: async (command) => {
      throw setupError('UNEXPECTED_COMMAND', `Unexpected command: ${command}`);
    }
  });

  assert.equal(result.runtimeBackend, 'podman');
  assert.equal(result.machineName, 'a0-launcher');
  assert.equal(result.dockerHostOverride, '');
  assert.equal(result.usesDefaultDockerSocket, true);
  assert.ok(result.lastSuccessfulSetupAt);
});

test('runRuntimeSetup rejects unsupported platforms before install-tool probes', async () => {
  await assert.rejects(
    runRuntimeSetup({
      dockerAvailable: false,
      platform: 'linux',
      runProcess: async (command) => {
        throw setupError('UNEXPECTED_COMMAND', `Unexpected command: ${command}`);
      }
    }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_PLATFORM');
      return true;
    }
  );
});

test('runRuntimeSetup rejects pre-canceled setup before install-tool probes', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runRuntimeSetup({
      dockerAvailable: false,
      platform: 'darwin',
      signal: controller.signal,
      runProcess: async (command) => {
        throw setupError('UNEXPECTED_COMMAND', `Unexpected command: ${command}`);
      }
    }),
    (error) => {
      assert.equal(error.code, 'SETUP_CANCELED');
      return true;
    }
  );
});

test('runtime setup inventory probes pass abort signals to fixed commands', async () => {
  const controller = new AbortController();
  const formulae = await readInstalledFormulae('/opt/homebrew/bin/brew', async (command, args, options) => {
    assert.equal(command, '/opt/homebrew/bin/brew');
    assert.deepEqual(args, ['list', '--formula', '--quiet']);
    assert.equal(options.signal, controller.signal);
    return { code: 0, stdout: 'docker\npodman\n', stderr: '' };
  }, { signal: controller.signal });

  assert.equal(formulae.docker, true);
  assert.equal(formulae.podman, true);

  const machines = await readPodmanMachines(async (command, args, options) => {
    assert.equal(command, 'podman');
    assert.deepEqual(args, ['machine', 'list', '--format', 'json']);
    assert.equal(options.signal, controller.signal);
    return { code: 0, stdout: '[{"Name":"a0-launcher","Running":true}]', stderr: '' };
  }, 'podman', { signal: controller.signal });

  assert.deepEqual(machines, [{
    name: 'a0-launcher',
    running: true,
    default: false,
    rootful: false
  }]);
});

test('install_podman_helper preserves setup cancellation before authorization cancel mapping', async () => {
  await assert.rejects(
    runRuntimeSetupStep({ id: 'install_podman_helper' }, {
      brewPath: '/opt/homebrew/bin/brew',
      plan: { machineName: DEFAULT_A0_MACHINE_NAME },
      runProcess: async (command) => {
        if (command === '/opt/homebrew/bin/brew') {
          return { code: 0, stdout: '/opt/homebrew/Cellar/podman/5.0.0\n', stderr: '' };
        }
        if (command === '/usr/bin/osascript') {
          throw setupError('SETUP_CANCELED', 'Runtime setup was canceled', {
            stderr: 'operation canceled'
          });
        }
        throw setupError('UNEXPECTED_COMMAND', `Unexpected command: ${command}`);
      }
    }),
    (error) => {
      assert.equal(error.code, 'SETUP_CANCELED');
      return true;
    }
  );
});

test('normalizeDockerHostOverride accepts only safe Docker host forms', () => {
  assert.equal(normalizeDockerHostOverride(''), '');
  assert.equal(normalizeDockerHostOverride(' /var/run/docker.sock '), '/var/run/docker.sock');
  assert.equal(normalizeDockerHostOverride('unix:///tmp/podman.sock'), 'unix:///tmp/podman.sock');
  assert.equal(normalizeDockerHostOverride('tcp://127.0.0.1:2375'), 'tcp://127.0.0.1:2375');
  assert.equal(normalizeDockerHostOverride('http://localhost:2375'), 'http://localhost:2375');
  assert.equal(normalizeDockerHostOverride('https://localhost:2376'), 'https://localhost:2376');
  assert.equal(normalizeDockerHostOverride('tcp://127.0.0.1:2375/'), 'tcp://127.0.0.1:2375');
  assert.equal(normalizeDockerHostOverride('http://localhost:2375/'), 'http://localhost:2375');
  assert.equal(normalizeDockerHostOverride('https://localhost:2376/'), 'https://localhost:2376');
  assert.equal(normalizeDockerHostOverride('tcp://127.0.0.1:2375/not-used'), '');
  assert.equal(normalizeDockerHostOverride('http://localhost:2375/not-used'), '');
  assert.equal(normalizeDockerHostOverride('https://localhost:2376/not-used'), '');
  assert.equal(normalizeDockerHostOverride('ssh://localhost'), '');
  assert.equal(normalizeDockerHostOverride('ftp://localhost'), '');
  assert.equal(normalizeDockerHostOverride('http://user:pass@localhost:2375'), '');
  assert.equal(normalizeDockerHostOverride('https://user@localhost:2376'), '');
  assert.equal(normalizeDockerHostOverride('http://localhost:2375?token=nope'), '');
  assert.equal(normalizeDockerHostOverride('http://localhost:2375#daemon'), '');
  assert.equal(normalizeDockerHostOverride(`/${'x'.repeat(MAX_DOCKER_HOST_OVERRIDE_LENGTH)}`), '');
  assert.equal(normalizeDockerHostOverride('http://[::1'), '');
});

test('normalizeRuntimeSetupState keeps only safe runtime metadata', () => {
  assert.deepEqual(normalizeRuntimeSetupState({
    runtimeBackend: 'podman',
    machineName: 'a0-launcher',
    dockerHostOverride: 'unix:///tmp/podman.sock',
    usesDefaultDockerSocket: false,
    lastSuccessfulSetupAt: '2026-06-05T00:00:00.000Z',
    password: 'nope'
  }), {
    runtimeBackend: 'podman',
    machineName: 'a0-launcher',
    dockerHostOverride: 'unix:///tmp/podman.sock',
    usesDefaultDockerSocket: false,
    lastSuccessfulSetupAt: '2026-06-05T00:00:00.000Z'
  });
});

test('DockerInterface detection distinguishes omitted Docker host from explicit default', async () => {
  const { DockerInterface } = await import('../docker_adapter/DockerInterface.mjs');
  const originalDockerHost = process.env.DOCKER_HOST;

  try {
    process.env.DOCKER_HOST = 'bad://env-host';

    const omitted = await DockerInterface.detectEnvironment();
    const explicitDefault = await DockerInterface.detectEnvironment({ dockerHost: '', timeoutMs: 250 });

    assert.equal(omitted.dockerHost.raw, 'bad://env-host');
    assert.equal(omitted.dockerHost.kind, 'invalid');
    assert.equal(explicitDefault.dockerHost.raw, '');
    assert.equal(explicitDefault.dockerHost.kind, 'default');
  } finally {
    if (originalDockerHost === undefined) {
      delete process.env.DOCKER_HOST;
    } else {
      process.env.DOCKER_HOST = originalDockerHost;
    }
  }
});
