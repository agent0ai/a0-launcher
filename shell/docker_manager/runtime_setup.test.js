const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  chooseBrewPath,
  makeRuntimeSetupPlan,
  sanitizeCommandOutput,
  normalizeDockerHostOverride,
  normalizeRuntimeSetupState,
  dockerOptionsForRuntimeSetup,
  findBrewPath,
  podmanApiSocketHostFromInspect,
  podmanHelperPath,
  readInstalledFormulae,
  readPodmanMachines,
  runProcess,
  runRuntimeSetup,
  runRuntimeSetupStep,
  setupError,
  HOMEBREW_INSTALL_COMMAND,
  HOMEBREW_INSTALL_ARGS,
  MAX_DOCKER_HOST_OVERRIDE_LENGTH,
  DEFAULT_A0_MACHINE_NAME
} = require('./runtime_setup');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makePodmanSetupRunProcess(options = {}) {
  const calls = [];
  const machineName = options.machineName || DEFAULT_A0_MACHINE_NAME;
  const socketPath = options.socketPath || '/tmp/a0-launcher-podman.sock';

  const runProcess = async (command, args = []) => {
    calls.push({ command, args });
    const argv = Array.isArray(args) ? args : [];

    if (command === '/usr/bin/env' && argv.join(' ') === 'bash -lc command -v brew') {
      return { code: 0, stdout: '/opt/homebrew/bin/brew\n', stderr: '' };
    }

    if (String(command).endsWith('/brew') && argv.join(' ') === 'list --formula --quiet') {
      return {
        code: 0,
        stdout: 'docker\ndocker-compose\ndocker-credential-helper\npodman\n',
        stderr: ''
      };
    }

    if (String(command).endsWith('/brew') && argv.join(' ') === '--prefix podman') {
      return { code: 0, stdout: '/opt/homebrew/Cellar/podman/5.0.0\n', stderr: '' };
    }

    if (String(command).endsWith('/podman') && argv.join(' ') === 'machine list --format json') {
      return {
        code: 0,
        stdout: JSON.stringify([{ Name: machineName, Running: false, Rootful: true }]),
        stderr: ''
      };
    }

    if (String(command).endsWith('/podman') && argv[0] === 'machine' && ['start', 'stop'].includes(argv[1])) {
      assert.equal(argv[2], machineName);
      return { code: 0, stdout: '', stderr: '' };
    }

    if (String(command).endsWith('/podman') && argv.join(' ') === `machine inspect ${machineName}`) {
      return {
        code: 0,
        stdout: JSON.stringify([{
          Name: machineName,
          ConnectionInfo: {
            PodmanSocket: {
              Path: socketPath
            }
          }
        }]),
        stderr: ''
      };
    }

    if (command === '/usr/bin/osascript') {
      return { code: 0, stdout: '', stderr: '' };
    }

    throw setupError('UNEXPECTED_COMMAND', `Unexpected command: ${command} ${argv.join(' ')}`);
  };

  runProcess.calls = calls;
  return runProcess;
}

async function waitForFileValue(filePath, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fs.readFile(filePath, 'utf8');
      if (predicate(value)) return value;
    } catch {
      // keep polling until the child writes the marker
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

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
  assert.equal(result.lastSuccessfulSetupAt, '');
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
  assert.equal(result.lastSuccessfulSetupAt, '2026-06-05T00:00:00.000Z');
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

test('runRuntimeSetup persists default socket metadata only after adapter verification succeeds', async () => {
  const runProcess = makePodmanSetupRunProcess();
  const verifyCalls = [];

  const result = await runRuntimeSetup({
    dockerAvailable: false,
    platform: 'darwin',
    runProcess,
    verifyDockerHost: async (dockerHost) => {
      verifyCalls.push(dockerHost);
      assert.equal(dockerHost, '');
    }
  });

  assert.equal(result.runtimeBackend, 'podman');
  assert.equal(result.machineName, DEFAULT_A0_MACHINE_NAME);
  assert.equal(result.dockerHostOverride, '');
  assert.equal(result.usesDefaultDockerSocket, true);
  assert.ok(Number.isFinite(Date.parse(result.lastSuccessfulSetupAt)));
  assert.deepEqual(verifyCalls, ['']);
  assert.equal(runProcess.calls.some((call) => call.args.join(' ') === `machine inspect ${DEFAULT_A0_MACHINE_NAME}`), false);
});

test('runRuntimeSetup persists verified Podman API socket override when default socket fails', async () => {
  const socketPath = '/tmp/a0-launcher-podman-api.sock';
  const runProcess = makePodmanSetupRunProcess({ socketPath });
  const verifyCalls = [];

  const result = await runRuntimeSetup({
    dockerAvailable: false,
    platform: 'darwin',
    runProcess,
    verifyDockerHost: async (dockerHost) => {
      verifyCalls.push(dockerHost);
      if (!dockerHost) {
        throw setupError('VERIFY_FAILED', 'Default socket failed', {
          diagnosticCode: 'DAEMON_UNAVAILABLE'
        });
      }
      assert.equal(dockerHost, `unix://${socketPath}`);
    }
  });

  assert.equal(result.runtimeBackend, 'podman');
  assert.equal(result.machineName, DEFAULT_A0_MACHINE_NAME);
  assert.equal(result.dockerHostOverride, `unix://${socketPath}`);
  assert.equal(result.usesDefaultDockerSocket, false);
  assert.ok(Number.isFinite(Date.parse(result.lastSuccessfulSetupAt)));
  assert.deepEqual(verifyCalls, ['', `unix://${socketPath}`]);
  assert.equal(runProcess.calls.some((call) => call.args.join(' ') === `machine inspect ${DEFAULT_A0_MACHINE_NAME}`), true);
});

test('runRuntimeSetup throws VERIFY_FAILED when default and Podman API socket verification fail', async () => {
  const socketPath = '/tmp/a0-launcher-podman-api.sock';
  const runProcess = makePodmanSetupRunProcess({ socketPath });
  const verifyCalls = [];

  await assert.rejects(
    runRuntimeSetup({
      dockerAvailable: false,
      platform: 'darwin',
      runProcess,
      verifyDockerHost: async (dockerHost) => {
        verifyCalls.push(dockerHost);
        throw setupError('VERIFY_FAILED', 'Socket verification failed', {
          diagnosticCode: dockerHost ? 'ECONNREFUSED' : 'DAEMON_UNAVAILABLE'
        });
      }
    }),
    (error) => {
      assert.equal(error.code, 'VERIFY_FAILED');
      assert.equal(error.details.defaultCode, 'VERIFY_FAILED');
      assert.equal(error.details.overrideCode, 'VERIFY_FAILED');
      return true;
    }
  );

  assert.deepEqual(verifyCalls, ['', `unix://${socketPath}`]);
});

test('runProcess cancellation terminates subprocesses in the spawned process group', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'a0-runprocess-'));
  const marker = path.join(tmp, 'grandchild.pid');
  let grandchildPid = 0;
  let grandchildTerminated = false;

  const grandchildScript = `
    const fs = require('node:fs');
    const marker = process.argv[1];
    process.on('SIGTERM', () => {
      fs.writeFileSync(marker, process.pid + ':term');
      process.exit(0);
    });
    fs.writeFileSync(marker, process.pid + ':ready');
    setInterval(() => {}, 1000);
  `;

  const parentScript = `
    const childProcess = require('node:child_process');
    const marker = process.argv[1];
    const grandchildScript = process.argv[2];
    const child = childProcess.spawn(process.execPath, ['-e', grandchildScript, marker], {
      stdio: 'ignore'
    });
    child.unref();
    setInterval(() => {}, 1000);
  `;

  try {
    const controller = new AbortController();
    const promise = runProcess(process.execPath, ['-e', parentScript, marker, grandchildScript], {
      signal: controller.signal
    });

    const ready = await waitForFileValue(marker, (value) => value.includes(':ready'));
    grandchildPid = Number(ready.split(':')[0]);
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

    controller.abort();

    await assert.rejects(
      promise,
      (error) => {
        assert.equal(error.code, 'SETUP_CANCELED');
        return true;
      }
    );

    if (process.platform !== 'win32') {
      const terminated = await waitForFileValue(marker, (value) => value.includes(':term'));
      assert.equal(Number(terminated.split(':')[0]), grandchildPid);
      grandchildTerminated = true;
    }
  } finally {
    if (grandchildPid > 0 && !grandchildTerminated) {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('findBrewPath passes abort signal to PATH lookup command', async () => {
  const controller = new AbortController();
  const result = await findBrewPath(async (command, args, options) => {
    assert.equal(command, '/usr/bin/env');
    assert.deepEqual(args, ['bash', '-lc', 'command -v brew']);
    assert.equal(options.signal, controller.signal);
    return { code: 0, stdout: '/custom/bin/brew\n', stderr: '' };
  }, {
    pathExists: async () => false,
    signal: controller.signal
  });

  assert.equal(result, '/custom/bin/brew');
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

test('podmanHelperPath passes abort signal to brew prefix lookup', async () => {
  const controller = new AbortController();
  const helperPath = await podmanHelperPath('/opt/homebrew/bin/brew', async (command, args, options) => {
    assert.equal(command, '/opt/homebrew/bin/brew');
    assert.deepEqual(args, ['--prefix', 'podman']);
    assert.equal(options.signal, controller.signal);
    return { code: 0, stdout: '/opt/homebrew/Cellar/podman/5.0.0\n', stderr: '' };
  }, { signal: controller.signal });

  assert.equal(helperPath, '/opt/homebrew/Cellar/podman/5.0.0/bin/podman-mac-helper');
});

test('runRuntimeSetupStep does not resolve brew for steps that do not need it', async () => {
  await runRuntimeSetupStep({ id: 'verify_existing_docker' }, {
    runProcess: async (command) => {
      throw setupError('UNEXPECTED_COMMAND', `Unexpected command: ${command}`);
    }
  });
});

test('install_podman_helper preserves setup cancellation before authorization cancel mapping', async () => {
  const controller = new AbortController();
  await assert.rejects(
    runRuntimeSetupStep({ id: 'install_podman_helper' }, {
      brewPath: '/opt/homebrew/bin/brew',
      plan: { machineName: DEFAULT_A0_MACHINE_NAME },
      signal: controller.signal,
      runProcess: async (command, args, options) => {
        if (command === '/opt/homebrew/bin/brew') {
          assert.deepEqual(args, ['--prefix', 'podman']);
          assert.equal(options.signal, controller.signal);
          return { code: 0, stdout: '/opt/homebrew/Cellar/podman/5.0.0\n', stderr: '' };
        }
        if (command === '/usr/bin/osascript') {
          assert.equal(options.signal, controller.signal);
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

test('podmanApiSocketHostFromInspect derives a normalized Unix Docker host', () => {
  assert.equal(podmanApiSocketHostFromInspect(JSON.stringify([{
    ConnectionInfo: {
      PodmanSocket: {
        Path: '/tmp/a0-launcher-podman-api.sock'
      }
    }
  }])), 'unix:///tmp/a0-launcher-podman-api.sock');
  assert.equal(podmanApiSocketHostFromInspect('not json'), '');
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
