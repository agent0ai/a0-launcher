const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  chooseBrewPath,
  makeRuntimeSetupPlan,
  sanitizeCommandOutput,
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
