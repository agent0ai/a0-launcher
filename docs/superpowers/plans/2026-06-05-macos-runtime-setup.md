# macOS Runtime Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an integrated macOS runtime setup assistant that installs Homebrew when needed, configures Docker CLI compatibility through Podman, and keeps Docker Desktop as a fallback.

**Architecture:** A new shell-owned runtime setup module performs detection, planning, command execution, and sanitized status reporting. `shell/docker_manager/index.js` wraps it in the existing operation/progress model, while the renderer only sees named preload actions and state.

**Tech Stack:** Electron main/preload IPC, CommonJS shell modules, existing Dockerode adapter, Node child processes, vanilla renderer ES modules, `node:test`.

---

## File Structure

- Create `shell/docker_manager/runtime_setup.js`
  - Owns setup step planning, command execution helpers, macOS detection, Homebrew/Podman command sequence, and native authorization command construction.
  - Exports pure helpers for unit tests and `runRuntimeSetup(options)` for the Docker Manager.
- Create `shell/docker_manager/runtime_setup.test.js`
  - Tests the planner and command sanitization without installing anything.
- Modify `shell/docker_manager/state_store.js`
  - Adds `readRuntimeSetup()` and `writeRuntimeSetup()` for durable runtime metadata.
- Modify `shell/docker_adapter/DockerInterface.mjs`
  - Allows `dockerHost` to be passed into singleton construction and environment detection.
  - Uses keyed singleton state so a newly persisted Docker host override can take effect without app restart.
- Modify `shell/docker_adapter/impl/DockerodeDocker.mjs`
  - Keeps `getEnvironment()` aligned with the instance Docker host.
- Modify `shell/docker_manager/index.js`
  - Adds `startRuntimeSetup()`, `getRuntimeSetupState()`, and `openRuntimeSetupFallback()`.
  - Reuses `_currentOperation` with `type: "runtime_setup"`.
  - Passes persisted Docker host override into `getDocker()`.
- Modify `shell/main.js`
  - Adds IPC handlers and extends progress sanitization with setup code fields.
- Modify `shell/preload.js`
  - Exposes named runtime setup methods.
- Modify `app/components/docker-manager/docker-manager-store.js`
  - Adds `runtimeSetup` to renderer state.
- Modify `app/docker_manager.js`
  - Adds action facade methods and applies runtime setup progress.
- Modify `app/components/docker-manager/onboarding/index.html`
  - Adds primary setup, fallback, and cancel controls.
- Modify `app/components/docker-manager/onboarding/onboarding.js`
  - Renders setup state and calls action facade methods.
- Modify `app/docker_manager.css`
  - Adds small setup panel styles if existing button row styles are insufficient.
- Modify `shell/docker_manager/AGENTS.md`, `shell/docker_adapter/AGENTS.md`, `shell/AGENTS.md`, `app/AGENTS.md`, and `app/components/docker-manager/AGENTS.md`
  - Documents the new setup contracts closest to the code.
- Modify `docs/AGENTS.md`
  - Documents `superpowers/plans/`.

## Task 1: Runtime Setup Planner And Tests

**Files:**
- Create: `shell/docker_manager/runtime_setup.js`
- Create: `shell/docker_manager/runtime_setup.test.js`
- Modify: `shell/docker_manager/AGENTS.md`

- [ ] **Step 1: Add failing planner tests**

Create `shell/docker_manager/runtime_setup.test.js` with tests covering the pure planning cases:

```js
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

test('sanitizeCommandOutput redacts obvious password and token lines', () => {
  const output = 'ok\nPASSWORD=secret\napi_token: abc123\nfinished';
  assert.equal(sanitizeCommandOutput(output), 'ok\n[redacted]\n[redacted]\nfinished');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test shell/docker_manager/runtime_setup.test.js
```

Expected: FAIL because `runtime_setup.js` does not exist yet.

- [ ] **Step 3: Implement the pure planner helpers**

Create `shell/docker_manager/runtime_setup.js` with:

```js
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_A0_MACHINE_NAME = 'a0-launcher';
const DEFAULT_PODMAN_MACHINE_NAME = 'podman-machine-default';
const REQUIRED_FORMULAE = Object.freeze([
  'docker',
  'docker-compose',
  'docker-credential-helper',
  'podman'
]);

function setupError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

function normalizeMachineName(value) {
  const name = String(value || '').trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(name) ? name : '';
}

function chooseBrewPath(options = {}) {
  const exists = typeof options.exists === 'function' ? options.exists : () => false;
  const pathLookup = typeof options.pathLookup === 'function' ? options.pathLookup : () => '';
  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (exists(candidate)) return candidate;
  }
  return String(pathLookup('brew') || '').trim();
}

function installedFormulae(formulae = {}) {
  const input = formulae && typeof formulae === 'object' ? formulae : {};
  return REQUIRED_FORMULAE.filter((name) => !!input[name]);
}

function missingFormulae(formulae = {}) {
  const installed = new Set(installedFormulae(formulae));
  return REQUIRED_FORMULAE.filter((name) => !installed.has(name));
}

function normalizeMachines(machines = []) {
  if (!Array.isArray(machines)) return [];
  return machines
    .map((machine) => ({
      name: normalizeMachineName(machine?.name),
      running: !!machine?.running,
      default: !!machine?.default,
      rootful: !!machine?.rootful
    }))
    .filter((machine) => machine.name);
}

function choosePodmanMachine(machines = []) {
  const list = normalizeMachines(machines);
  const active = list.find((machine) => machine.running);
  if (active && active.name !== DEFAULT_A0_MACHINE_NAME && active.name !== DEFAULT_PODMAN_MACHINE_NAME) {
    return { blocked: true, blockCode: 'PODMAN_MACHINE_EXISTS', machineName: active.name };
  }
  const a0 = list.find((machine) => machine.name === DEFAULT_A0_MACHINE_NAME);
  if (a0) return { machineName: a0.name, existing: true, rootful: a0.rootful };
  const def = list.find((machine) => machine.name === DEFAULT_PODMAN_MACHINE_NAME);
  if (def) return { machineName: def.name, existing: true, rootful: def.rootful };
  return { machineName: DEFAULT_A0_MACHINE_NAME, existing: false, rootful: false };
}

function makeRuntimeSetupPlan(context = {}) {
  const platform = context.platform || process.platform;
  if (context.dockerAvailable) {
    return {
      ready: true,
      machineName: '',
      steps: [{ id: 'verify_existing_docker', label: 'Docker is ready' }]
    };
  }
  if (platform !== 'darwin') {
    return {
      blocked: true,
      blockCode: 'UNSUPPORTED_PLATFORM',
      machineName: '',
      steps: []
    };
  }

  const steps = [];
  if (!context.brewPath) {
    steps.push({ id: 'install_homebrew', label: 'Installing Homebrew' });
  }
  if (missingFormulae(context.formulae).length > 0) {
    steps.push({ id: 'install_formulae', label: 'Installing runtime tools' });
  }

  const machine = choosePodmanMachine(context.podmanMachines);
  if (machine.blocked) {
    return {
      blocked: true,
      blockCode: machine.blockCode,
      machineName: machine.machineName,
      steps
    };
  }

  if (!machine.existing) {
    steps.push({ id: 'init_podman_machine', label: 'Creating runtime machine' });
  }
  steps.push({ id: 'start_podman_machine', label: 'Starting runtime machine' });
  steps.push({ id: 'install_podman_helper', label: 'Enabling Docker compatibility' });
  steps.push({ id: 'restart_podman_machine', label: 'Restarting runtime machine' });
  if (!machine.rootful) {
    steps.push({ id: 'set_podman_rootful', label: 'Configuring runtime mode' });
  }
  steps.push({ id: 'verify_runtime', label: 'Verifying runtime' });

  return {
    ready: false,
    blocked: false,
    blockCode: '',
    machineName: machine.machineName,
    steps
  };
}

function sanitizeCommandOutput(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => /password|passwd|token|secret|credential/i.test(line) ? '[redacted]' : line)
    .join('\n')
    .trim();
}

module.exports = {
  DEFAULT_A0_MACHINE_NAME,
  DEFAULT_PODMAN_MACHINE_NAME,
  REQUIRED_FORMULAE,
  chooseBrewPath,
  choosePodmanMachine,
  makeRuntimeSetupPlan,
  missingFormulae,
  normalizeMachines,
  sanitizeCommandOutput,
  setupError
};
```

- [ ] **Step 4: Run planner tests**

Run:

```bash
node --test shell/docker_manager/runtime_setup.test.js
```

Expected: PASS.

- [ ] **Step 5: Update Docker Manager docs**

Add `runtime_setup.js` and `runtime_setup.test.js` to `shell/docker_manager/AGENTS.md` ownership and testing sections. Document that the module owns macOS runtime setup planning and command execution, but `index.js` owns operation/progress integration.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add shell/docker_manager/runtime_setup.js shell/docker_manager/runtime_setup.test.js shell/docker_manager/AGENTS.md
git commit -m "feat: add runtime setup planner"
```

## Task 2: Docker Host Override And Runtime Metadata

**Files:**
- Modify: `shell/docker_manager/state_store.js`
- Modify: `shell/docker_adapter/DockerInterface.mjs`
- Modify: `shell/docker_adapter/impl/DockerodeDocker.mjs`
- Modify: `shell/docker_adapter/AGENTS.md`

- [ ] **Step 1: Add focused tests to runtime setup test file**

Extend `shell/docker_manager/runtime_setup.test.js` with tests for metadata normalization:

```js
const {
  normalizeRuntimeSetupState
} = require('./runtime_setup');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test shell/docker_manager/runtime_setup.test.js
```

Expected: FAIL because `normalizeRuntimeSetupState` is not exported yet.

- [ ] **Step 3: Implement metadata normalization and persistence**

Add to `shell/docker_manager/runtime_setup.js`:

```js
function normalizeDockerHostOverride(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 2048) return '';
  if (raw.startsWith('/')) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'unix:' && parsed.protocol !== 'tcp:' && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return raw;
  } catch {
    return '';
  }
}

function normalizeRuntimeSetupState(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const runtimeBackend = input.runtimeBackend === 'podman' ? 'podman' : '';
  const machineName = normalizeMachineName(input.machineName);
  const dockerHostOverride = normalizeDockerHostOverride(input.dockerHostOverride);
  const usesDefaultDockerSocket = !!input.usesDefaultDockerSocket;
  const lastSuccessfulSetupAt = Number.isFinite(Date.parse(input.lastSuccessfulSetupAt || ''))
    ? input.lastSuccessfulSetupAt
    : '';
  return {
    runtimeBackend,
    machineName,
    dockerHostOverride,
    usesDefaultDockerSocket,
    lastSuccessfulSetupAt
  };
}
```

Export `normalizeRuntimeSetupState`.

Add to `shell/docker_manager/state_store.js`:

```js
function normalizeRuntimeSetupForStore(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    runtimeBackend: input.runtimeBackend === 'podman' ? 'podman' : '',
    machineName: typeof input.machineName === 'string' ? input.machineName.trim().slice(0, 80) : '',
    dockerHostOverride: typeof input.dockerHostOverride === 'string' ? input.dockerHostOverride.trim().slice(0, 2048) : '',
    usesDefaultDockerSocket: !!input.usesDefaultDockerSocket,
    lastSuccessfulSetupAt: Number.isFinite(Date.parse(input.lastSuccessfulSetupAt || '')) ? input.lastSuccessfulSetupAt : ''
  };
}

async function readRuntimeSetup() {
  const state = await readJson(stateFile(), {});
  return normalizeRuntimeSetupForStore(state?.runtimeSetup);
}

async function writeRuntimeSetup(runtimeSetup) {
  const state = await readJson(stateFile(), {});
  const next = normalizeRuntimeSetupForStore(runtimeSetup);
  await writeJson(stateFile(), { ...state, runtimeSetup: next, updatedAt: new Date().toISOString() });
  return next;
}
```

Export `readRuntimeSetup` and `writeRuntimeSetup`.

- [ ] **Step 4: Allow Docker adapter host override**

In `shell/docker_adapter/DockerInterface.mjs`:

- Add `@property {string=} dockerHost` to `DockerInterfaceOptions`.
- Replace the singleton fields with key-aware storage:

```js
static #instanceKey = '';
static #instance = null;
static #instancePromise = null;

static #makeInstanceKey(options = {}) {
  return JSON.stringify({
    imageRepo: (options?.imageRepo || 'agent0ai/agent-zero').trim(),
    dockerHost: (options?.dockerHost || '').trim()
  });
}
```

- In `static get(options = {})`, compute the key and rebuild if it changes:

```js
const key = this.#makeInstanceKey(options);
if (this.#instance && this.#instanceKey === key) return this.#instance;
if (this.#instancePromise && this.#instanceKey === key) return this.#instancePromise;
this.#instanceKey = key;
this.#instancePromise = (async () => {
  const env = await this.detectEnvironment({ dockerHost: options?.dockerHost });
  const { DockerodeDocker } = await import('./impl/DockerodeDocker.mjs');
  const instance = new DockerodeDocker({
    env,
    imageRepo: options?.imageRepo,
    dockerHost: options?.dockerHost
  });
  this.#instance = instance;
  return instance;
})()
```

- Update the `catch` branch to clear `#instanceKey` with `#instance`.

In `shell/docker_adapter/impl/DockerodeDocker.mjs`, store `options.dockerHost` and make `getEnvironment()` use it:

```js
this.dockerHost = (options?.dockerHost || '').trim();

async getEnvironment() {
  return DockerInterface.detectEnvironment({ dockerHost: this.dockerHost });
}
```

- [ ] **Step 5: Run tests and syntax checks**

Run:

```bash
node --test shell/docker_manager/runtime_setup.test.js
node -e "import('./shell/docker_adapter/DockerInterface.mjs')"
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Update Docker adapter docs**

Update `shell/docker_adapter/AGENTS.md` to document that `DockerInterface.get({ dockerHost })` is keyed by image repo and Docker host so runtime setup overrides can take effect.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add shell/docker_manager/runtime_setup.js shell/docker_manager/runtime_setup.test.js shell/docker_manager/state_store.js shell/docker_adapter/DockerInterface.mjs shell/docker_adapter/impl/DockerodeDocker.mjs shell/docker_adapter/AGENTS.md
git commit -m "feat: persist runtime setup metadata"
```

## Task 3: Runtime Setup Execution And Shell IPC

**Files:**
- Modify: `shell/docker_manager/runtime_setup.js`
- Modify: `shell/docker_manager/index.js`
- Modify: `shell/main.js`
- Modify: `shell/preload.js`
- Modify: `shell/AGENTS.md`
- Modify: `shell/docker_manager/AGENTS.md`

- [ ] **Step 1: Add executor API to runtime setup module**

Extend `shell/docker_manager/runtime_setup.js` with these exported functions:

```js
async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runProcess(command, args = [], options = {}) {
  const signal = options.signal;
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    if (signal) {
      signal.addEventListener('abort', () => {
        try { child.kill('SIGTERM'); } catch {}
      }, { once: true });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { code, stdout: sanitizeCommandOutput(stdout), stderr: sanitizeCommandOutput(stderr) };
      if (code === 0) resolve(result);
      else reject(setupError('COMMAND_FAILED', `${command} failed`, result));
    });
  });
}

async function runRuntimeSetup(options = {}) {
  const signal = options.signal;
  const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const dockerAvailable = !!options.dockerAvailable;
  const context = await collectRuntimeSetupContext({ dockerAvailable, signal });
  const plan = makeRuntimeSetupPlan(context);
  if (plan.blocked) throw setupError(plan.blockCode, 'Runtime setup needs confirmation before changing an existing Podman machine', { machineName: plan.machineName });
  for (const step of plan.steps) {
    if (signal?.aborted) throw setupError('SETUP_CANCELED', 'Runtime setup was canceled');
    report({ stepId: step.id, message: step.label });
    await runRuntimeSetupStep(step, { ...context, plan, signal, report });
  }
  return {
    runtimeBackend: 'podman',
    machineName: plan.machineName,
    dockerHostOverride: '',
    usesDefaultDockerSocket: true,
    lastSuccessfulSetupAt: new Date().toISOString()
  };
}
```

`collectRuntimeSetupContext()` and `runRuntimeSetupStep()` should execute only fixed commands:

```js
const HOMEBREW_INSTALL_COMMAND = '/bin/bash';
const HOMEBREW_INSTALL_ARGS = ['-c', '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'];

function commandOutputLines(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function findBrewPath(run = runProcess) {
  const opt = '/opt/homebrew/bin/brew';
  const usr = '/usr/local/bin/brew';
  if (await pathExists(opt)) return opt;
  if (await pathExists(usr)) return usr;
  try {
    const found = await run('/usr/bin/env', ['bash', '-lc', 'command -v brew']);
    return commandOutputLines(found.stdout)[0] || '';
  } catch {
    return '';
  }
}

async function readInstalledFormulae(brewPath, run = runProcess) {
  if (!brewPath) return {};
  const result = await run(brewPath, ['list', '--formula', '--quiet']);
  const installed = new Set(commandOutputLines(result.stdout));
  return Object.fromEntries(REQUIRED_FORMULAE.map((name) => [name, installed.has(name)]));
}

function parsePodmanMachineList(stdout) {
  try {
    const parsed = JSON.parse(stdout || '[]');
    const list = Array.isArray(parsed) ? parsed : [];
    return list.map((machine) => ({
      name: machine.Name || machine.NameOrDefault || machine.name || '',
      running: machine.Running === true || machine.LastUp === true || machine.Running === 'true',
      default: machine.Default === true || machine.Default === 'true',
      rootful: machine.Rootful === true || machine.Rootful === 'true'
    }));
  } catch {
    return [];
  }
}

async function readPodmanMachines(run = runProcess) {
  try {
    const result = await run('podman', ['machine', 'list', '--format', 'json']);
    return parsePodmanMachineList(result.stdout);
  } catch {
    return [];
  }
}

async function collectRuntimeSetupContext(options = {}) {
  const run = options.runProcess || runProcess;
  const brewPath = await findBrewPath(run);
  const formulae = await readInstalledFormulae(brewPath, run).catch(() => ({}));
  const podmanMachines = await readPodmanMachines(run);
  return {
    platform: process.platform,
    dockerAvailable: !!options.dockerAvailable,
    brewPath,
    formulae,
    podmanMachines
  };
}
```

For Homebrew, call with `env: { ...process.env, NONINTERACTIVE: '1' }`.

For native authorization, use `/usr/bin/osascript` to invoke an admin prompt for the fixed helper path:

```js
function makeAuthorizationScript(helperPath) {
  return `do shell script ${JSON.stringify(`${helperPath} install`)} with administrator privileges`;
}

async function podmanHelperPath(brewPath, run = runProcess) {
  const result = await run(brewPath, ['--prefix', 'podman']);
  const prefix = commandOutputLines(result.stdout)[0] || '';
  if (!prefix) throw setupError('PODMAN_INSTALL_FAILED', 'Podman helper path was not found');
  return path.join(prefix, 'bin', 'podman-mac-helper');
}

async function runRuntimeSetupStep(step, context = {}) {
  const run = context.runProcess || runProcess;
  const machineName = context.plan?.machineName || DEFAULT_A0_MACHINE_NAME;
  const brewPath = context.brewPath || await findBrewPath(run);

  switch (step.id) {
    case 'verify_existing_docker':
      return null;
    case 'install_homebrew':
      return run(HOMEBREW_INSTALL_COMMAND, HOMEBREW_INSTALL_ARGS, {
        env: { ...process.env, NONINTERACTIVE: '1' },
        signal: context.signal
      });
    case 'install_formulae': {
      const activeBrewPath = brewPath || await findBrewPath(run);
      return run(activeBrewPath, ['install', ...missingFormulae(context.formulae)], { signal: context.signal });
    }
    case 'init_podman_machine':
      return run('podman', ['machine', 'init', machineName], { signal: context.signal });
    case 'start_podman_machine':
      return run('podman', ['machine', 'start', machineName], { signal: context.signal });
    case 'install_podman_helper': {
      const helperPath = await podmanHelperPath(brewPath, run);
      return run('/usr/bin/osascript', ['-e', makeAuthorizationScript(helperPath)], { signal: context.signal });
    }
    case 'restart_podman_machine':
      await run('podman', ['machine', 'stop', machineName], { signal: context.signal }).catch(() => null);
      return run('podman', ['machine', 'start', machineName], { signal: context.signal });
    case 'set_podman_rootful':
      await run('podman', ['machine', 'stop', machineName], { signal: context.signal }).catch(() => null);
      await run('podman', ['machine', 'set', '--rootful', machineName], { signal: context.signal });
      return run('podman', ['machine', 'start', machineName], { signal: context.signal });
    case 'verify_runtime':
      return run('docker', ['version', '--format', '{{.Server.Version}}'], { signal: context.signal });
    default:
      throw setupError('UNKNOWN_SETUP_STEP', `Unknown runtime setup step: ${step.id}`);
  }
}
```

- [ ] **Step 2: Wire Docker Manager operation**

In `shell/docker_manager/index.js`:

- Require `runtime_setup`.
- Add helper:

```js
function mapRuntimeSetupErrorToMessage(error) {
  switch (error?.code) {
    case 'PODMAN_MACHINE_EXISTS':
      return 'A Podman machine is already running. Runtime setup needs confirmation before changing it.';
    case 'SETUP_CANCELED':
      return 'Runtime setup was canceled.';
    case 'COMMAND_FAILED':
      return 'Runtime setup failed. Retry setup or use Docker Desktop.';
    default:
      return error?.message || 'Runtime setup failed.';
  }
}

async function getDockerForManager() {
  const runtimeSetup = await stateStore.readRuntimeSetup();
  return getDocker({
    imageRepo: getBackendImageRepo(),
    dockerHost: runtimeSetup.dockerHostOverride || undefined
  });
}
```

- Replace new runtime setup paths with this helper first; broader replacement can be limited to inventory and state building in this task.
- Add:

```js
async function getRuntimeSetupState() {
  return stateStore.readRuntimeSetup();
}

async function startRuntimeSetup() {
  const opId = beginOperation('runtime_setup', null);
  const controller = new AbortController();
  _abortControllers.set(opId, controller);

  (async () => {
    try {
      updateOperationProgress({ message: 'Checking runtime', progress: null });
      const inventory = await getDockerInventory().catch(() => ({ dockerAvailable: false }));
      const result = await runtimeSetup.runRuntimeSetup({
        dockerAvailable: !!inventory?.dockerAvailable,
        signal: controller.signal,
        onProgress: (progress) => updateOperationProgress({
          message: progress?.message || 'Setting up runtime',
          setupStep: progress?.stepId || ''
        })
      });
      const saved = await stateStore.writeRuntimeSetup(result);
      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Runtime ready', setupCode: '' });
      await refreshDockerManager({ forceRefresh: true }).catch(() => {});
      return saved;
    } catch (error) {
      const code = error?.code || 'RUNTIME_SETUP_FAILED';
      const message = mapRuntimeSetupErrorToMessage(error);
      finishOperation(controller.signal.aborted ? 'canceled' : 'failed', message);
      updateOperationProgress({ setupCode: code, message, error: message });
    } finally {
      _abortControllers.delete(opId);
    }
  })().catch((error) => {
    logDockerManagerError('startRuntimeSetup.unhandled', error, { opId });
  });

  return { opId };
}

async function openRuntimeSetupFallback() {
  return { started: false, fallback: 'docker_desktop' };
}
```

- Export these functions.

- [ ] **Step 3: Add IPC and preload methods**

In `shell/main.js`, add handlers:

```js
ipcMain.handle('docker-manager:getRuntimeSetupState', async () => {
  try {
    return await dockerManager.getRuntimeSetupState();
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:startRuntimeSetup', async () => {
  try {
    const accepted = await dockerManager.startRuntimeSetup();
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Runtime setup did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});
```

Keep `installDocker` as the Docker Desktop fallback.

Extend `sanitizeDockerManagerProgress(progress)`:

```js
if (typeof progress.setupStep === 'string') out.setupStep = progress.setupStep;
if (typeof progress.setupCode === 'string') out.setupCode = progress.setupCode;
```

In `shell/preload.js`, expose:

```js
getRuntimeSetupState: () => ipcRenderer.invoke('docker-manager:getRuntimeSetupState'),
startRuntimeSetup: () => ipcRenderer.invoke('docker-manager:startRuntimeSetup'),
```

- [ ] **Step 4: Run syntax checks**

Run:

```bash
node --check shell/docker_manager/runtime_setup.js
node --check shell/docker_manager/index.js
node --check shell/main.js
node --check shell/preload.js
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Update shell docs**

Update `shell/AGENTS.md` and `shell/docker_manager/AGENTS.md` with the new runtime setup IPC and shell-owned privilege contract.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add shell/docker_manager/runtime_setup.js shell/docker_manager/index.js shell/main.js shell/preload.js shell/AGENTS.md shell/docker_manager/AGENTS.md
git commit -m "feat: wire macos runtime setup"
```

## Task 4: Renderer Runtime Setup Onboarding

**Files:**
- Modify: `app/components/docker-manager/docker-manager-store.js`
- Modify: `app/docker_manager.js`
- Modify: `app/components/docker-manager/onboarding/index.html`
- Modify: `app/components/docker-manager/onboarding/onboarding.js`
- Modify: `app/docker_manager.css`
- Modify: `app/AGENTS.md`
- Modify: `app/components/docker-manager/AGENTS.md`

- [ ] **Step 1: Add renderer state**

In `app/components/docker-manager/docker-manager-store.js`, add:

```js
runtimeSetup: {
  runtimeBackend: "",
  machineName: "",
  dockerHostOverride: "",
  usesDefaultDockerSocket: false,
  lastSuccessfulSetupAt: ""
},
```

- [ ] **Step 2: Add actions to renderer coordinator**

In `app/docker_manager.js`, include `runtimeSetup` in `snapshot()` and update `refresh()` to load it:

```js
const [inventory, state, runtimeSetup] = await Promise.all([
  typeof api.getInventory === "function" ? api.getInventory() : null,
  typeof api.getState === "function" ? api.getState() : null,
  typeof api.getRuntimeSetupState === "function" ? api.getRuntimeSetupState() : null
]);

if (!isErrorResponse(runtimeSetup) && runtimeSetup && typeof runtimeSetup === "object") {
  store.runtimeSetup = runtimeSetup;
}
```

Add actions:

```js
async function startRuntimeSetup() {
  const api = window.dockerManagerAPI;
  if (!api || typeof api.startRuntimeSetup !== "function") return;
  try {
    const res = await api.startRuntimeSetup();
    if (isErrorResponse(res)) {
      setBanner("error", res.message);
      return;
    }
    setBanner("info", "Runtime setup started.");
  } catch (e) {
    setBanner("error", e?.message || "Unable to start runtime setup");
  }
}

async function cancelCurrentOperation() {
  const api = window.dockerManagerAPI;
  const opId = store.progress?.opId || "";
  if (!api || !opId || typeof api.cancel !== "function") return;
  const res = await api.cancel(opId);
  if (isErrorResponse(res)) setBanner("error", res.message);
}
```

Expose both through `window.dockerManagerActions`.

- [ ] **Step 3: Update onboarding markup**

Replace `app/components/docker-manager/onboarding/index.html` body content with:

```html
<body>
  <section id="onboardingPanel" class="section sv-card hidden">
    <h2 id="onboardingTitle" class="section-title sv-section-heading">Runtime setup</h2>
    <p id="onboardingMessage" class="sv-onboarding-message"></p>
    <div id="onboardingDetail" class="dm-runtime-detail hidden"></div>
    <div class="sv-row-end dm-runtime-actions">
      <button id="onboardingFallbackBtn" class="button cancel hidden" type="button">Download Docker Desktop</button>
      <button id="onboardingCancelBtn" class="button cancel hidden" type="button">Cancel</button>
      <button id="onboardingActionBtn" class="button confirm hidden" type="button">Set up runtime</button>
    </div>
  </section>
  <script type="module" src="components/docker-manager/onboarding/onboarding.js"></script>
</body>
```

- [ ] **Step 4: Update onboarding rendering**

In `app/components/docker-manager/onboarding/onboarding.js`, render based on setup progress:

```js
function setupProgress(state) {
  const progress = state?.progress || null;
  return progress?.type === "runtime_setup" && progress.status === "running" ? progress : null;
}

function render(state) {
  const panel = byId("onboardingPanel");
  const title = byId("onboardingTitle");
  const message = byId("onboardingMessage");
  const detail = byId("onboardingDetail");
  const actionBtn = byId("onboardingActionBtn");
  const fallbackBtn = byId("onboardingFallbackBtn");
  const cancelBtn = byId("onboardingCancelBtn");
  if (!panel) return;

  const hasData = (Array.isArray(state?.images) && state.images.length > 0)
    || (Array.isArray(state?.containers) && state.containers.length > 0);
  if (state?.dockerAvailable || hasData) {
    panel.classList.add("hidden");
    return;
  }

  const progress = setupProgress(state);
  panel.classList.remove("hidden");
  if (title) title.textContent = "Runtime setup";
  if (message) {
    message.textContent = progress
      ? (progress.message || "Setting up the required runtime.")
      : (state?.error || state?.environment?.diagnosticMessage || "Set up the required runtime to run Agent Zero locally.");
  }
  if (detail) {
    detail.classList.toggle("hidden", !progress?.setupStep);
    detail.textContent = progress?.setupStep ? `Step: ${progress.setupStep}` : "";
  }
  if (actionBtn) {
    actionBtn.classList.toggle("hidden", !!progress);
    actionBtn.textContent = "Set up runtime";
  }
  if (fallbackBtn) fallbackBtn.classList.remove("hidden");
  if (cancelBtn) cancelBtn.classList.toggle("hidden", !progress);
}
```

Bind buttons to `startRuntimeSetup`, `openDockerDownload`, and `cancelCurrentOperation`.

- [ ] **Step 5: Add minimal styles**

In `app/docker_manager.css`, near onboarding styles add:

```css
.dm-runtime-actions {
  gap: 0.5rem;
  flex-wrap: wrap;
}

.dm-runtime-detail {
  color: var(--color-text-muted);
  font-size: 0.84rem;
  margin-top: 0.35rem;
}
```

- [ ] **Step 6: Run renderer syntax checks**

Run:

```bash
node --check app/docker_manager.js
node --check app/components/docker-manager/onboarding/onboarding.js
git diff --check
```

Expected: PASS.

- [ ] **Step 7: Update renderer docs**

Update `app/AGENTS.md` and `app/components/docker-manager/AGENTS.md` to document that onboarding owns runtime setup UI and Docker Desktop fallback, while Docker mechanics remain shell-owned.

- [ ] **Step 8: Commit Task 4**

Run:

```bash
git add app/components/docker-manager/docker-manager-store.js app/docker_manager.js app/components/docker-manager/onboarding/index.html app/components/docker-manager/onboarding/onboarding.js app/docker_manager.css app/AGENTS.md app/components/docker-manager/AGENTS.md
git commit -m "feat: add runtime setup onboarding"
```

## Task 5: Verification, Code Simplifier, And Final Review

**Files:**
- Modify only files touched in Tasks 1-4 if simplification finds safe improvements.

- [ ] **Step 1: Run full static verification**

Run:

```bash
node --test shell/docker_manager/runtime_setup.test.js
node -e "import('./shell/docker_adapter/DockerInterface.mjs')"
node --check shell/main.js
node --check shell/preload.js
node --check shell/docker_manager/index.js
node --check shell/docker_manager/runtime_setup.js
node --check app/docker_manager.js
node --check app/components/docker-manager/onboarding/onboarding.js
git diff --check
```

Expected: PASS.

- [ ] **Step 2: Run CodeRabbit if implementation is non-trivial**

Run:

```bash
coderabbit --prompt-only -t uncommitted
```

If CodeRabbit is unavailable or canceled, record that in the final report and continue with manual review.

- [ ] **Step 3: Apply code-simplifier pass**

Use the local `code-simplifier` skill on recently touched files only. Preserve behavior and tests. Focus on:

- reducing nested conditionals in `runtime_setup.js`
- keeping command definitions fixed and explicit
- removing redundant renderer state checks
- keeping setup copy concise

- [ ] **Step 4: Re-run verification**

Run the full static verification command from Step 1 again.

- [ ] **Step 5: Commit simplification if it changed code**

If the simplifier changed files, commit them:

```bash
git add shell/docker_manager shell/docker_adapter shell/main.js shell/preload.js app docs
git commit -m "refactor: simplify runtime setup code"
```

Stage only intended files. Do not stage `.DS_Store`, `.agents/`, `.claude/`, or `skills-lock.json`.

- [ ] **Step 6: Final branch review**

Run:

```bash
git status --short
git log --oneline -5
```

Confirm only known unrelated untracked local files remain.
