const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  chooseBrewPath,
  makeRuntimeSetupPlan,
  sanitizeCommandOutput,
  normalizeDockerHostOverride,
  normalizeRuntimeSetupState,
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
