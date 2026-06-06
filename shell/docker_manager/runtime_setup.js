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
const MAX_DOCKER_HOST_OVERRIDE_LENGTH = 2048;
const HOMEBREW_INSTALL_COMMAND = '/bin/bash';
const HOMEBREW_INSTALL_ARGS = Object.freeze([
  '-c',
  '/usr/bin/curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash'
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

function normalizeDockerHostOverride(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > MAX_DOCKER_HOST_OVERRIDE_LENGTH) return '';
  if (raw.startsWith('/')) return raw;

  try {
    const parsed = new URL(raw);
    const protocol = (parsed.protocol || '').toLowerCase();
    if (!['unix:', 'tcp:', 'http:', 'https:'].includes(protocol)) return '';
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return '';

    if (protocol === 'tcp:' || protocol === 'http:' || protocol === 'https:') {
      if (parsed.pathname && parsed.pathname !== '/') return '';
      return `${protocol}//${parsed.host}`;
    }

    return raw;
  } catch {
    return '';
  }
}

function normalizeRuntimeSetupState(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const lastSuccessfulSetupAt = typeof input.lastSuccessfulSetupAt === 'string'
    ? input.lastSuccessfulSetupAt.trim()
    : '';

  return {
    runtimeBackend: input.runtimeBackend === 'podman' ? 'podman' : '',
    machineName: normalizeMachineName(input.machineName),
    dockerHostOverride: normalizeDockerHostOverride(input.dockerHostOverride),
    usesDefaultDockerSocket: !!input.usesDefaultDockerSocket,
    lastSuccessfulSetupAt: Number.isFinite(Date.parse(lastSuccessfulSetupAt)) ? lastSuccessfulSetupAt : ''
  };
}

function dockerOptionsForRuntimeSetup(imageRepo, runtimeSetupState = {}) {
  const options = { imageRepo };
  const runtime = normalizeRuntimeSetupState(runtimeSetupState);
  if (runtime.dockerHostOverride) {
    options.dockerHost = runtime.dockerHostOverride;
  } else if (runtime.usesDefaultDockerSocket) {
    options.dockerHost = '';
  }
  return options;
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
  const activeExternal = list.find((machine) => (
    machine.running &&
    machine.name !== DEFAULT_A0_MACHINE_NAME &&
    machine.name !== DEFAULT_PODMAN_MACHINE_NAME
  ));

  if (activeExternal) {
    return { blocked: true, blockCode: 'PODMAN_MACHINE_EXISTS', machineName: activeExternal.name };
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
    .map((line) => (/(password|passwd|token|secret|credential)\s*[:=]/i.test(line) ? '[redacted]' : line))
    .join('\n')
    .trim();
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function commandOutputLines(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function runProcess(command, args = [], options = {}) {
  const cmd = String(command || '').trim();
  const argv = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  const signal = options.signal || null;
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();

  if (!cmd) {
    return Promise.reject(setupError('COMMAND_NOT_CONFIGURED', 'Runtime setup command is not configured'));
  }

  if (signal?.aborted) {
    return Promise.reject(setupError('SETUP_CANCELED', 'Runtime setup was canceled'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
      fn(value);
    };

    let child;
    let abortListener = null;
    try {
      child = childProcess.spawn(cmd, argv, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(setupError('COMMAND_FAILED', `${cmd} failed`, {
        message: error?.message || String(error),
        stdout: '',
        stderr: ''
      }));
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    if (signal) {
      abortListener = () => {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }

    child.on('error', (error) => {
      const result = {
        code: null,
        stdout: sanitizeCommandOutput(stdout),
        stderr: sanitizeCommandOutput(stderr),
        message: error?.message || String(error)
      };
      done(reject, setupError(signal?.aborted ? 'SETUP_CANCELED' : 'COMMAND_FAILED', `${cmd} failed`, result));
    });

    child.on('close', (code) => {
      const result = {
        code,
        stdout: sanitizeCommandOutput(stdout),
        stderr: sanitizeCommandOutput(stderr)
      };
      if (signal?.aborted) {
        done(reject, setupError('SETUP_CANCELED', 'Runtime setup was canceled', result));
        return;
      }
      if (code === 0) {
        done(resolve, result);
      } else {
        done(reject, setupError('COMMAND_FAILED', `${cmd} failed`, result));
      }
    });
  });
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
  const brew = String(brewPath || '').trim();
  if (!brew) return {};

  const result = await run(brew, ['list', '--formula', '--quiet']);
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

function brewBinDir(brewPath) {
  const brew = String(brewPath || '').trim();
  return brew ? path.dirname(brew) : '';
}

function runtimeCommandPath(brewPath, commandName) {
  const binDir = brewBinDir(brewPath);
  return binDir ? path.join(binDir, commandName) : commandName;
}

function runtimeProcessEnv(brewPath) {
  const binDir = brewBinDir(brewPath);
  if (!binDir) return process.env;
  const currentPath = process.env.PATH || '';
  return {
    ...process.env,
    PATH: currentPath ? `${binDir}${path.delimiter}${currentPath}` : binDir
  };
}

async function readPodmanMachines(run = runProcess, podmanPath = 'podman') {
  try {
    const result = await run(podmanPath, ['machine', 'list', '--format', 'json']);
    return parsePodmanMachineList(result.stdout);
  } catch {
    return [];
  }
}

async function collectRuntimeSetupContext(options = {}) {
  const run = options.runProcess || runProcess;
  const brewPath = await findBrewPath(run);
  const formulae = await readInstalledFormulae(brewPath, run).catch(() => ({}));
  const podmanPath = formulae.podman ? runtimeCommandPath(brewPath, 'podman') : 'podman';
  const podmanMachines = await readPodmanMachines(run, podmanPath);

  return {
    platform: options.platform || process.platform,
    dockerAvailable: !!options.dockerAvailable,
    brewPath,
    formulae,
    podmanMachines
  };
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function makeAuthorizationScript(helperPath) {
  return `do shell script ${JSON.stringify(`${shellQuote(helperPath)} install`)} with administrator privileges`;
}

async function podmanHelperPath(brewPath, run = runProcess) {
  const brew = String(brewPath || '').trim();
  if (!brew) {
    throw setupError('BREW_NOT_FOUND', 'Homebrew was not found');
  }

  const result = await run(brew, ['--prefix', 'podman']);
  const prefix = commandOutputLines(result.stdout)[0] || '';
  if (!prefix) {
    throw setupError('PODMAN_INSTALL_FAILED', 'Podman helper path was not found');
  }
  return path.join(prefix, 'bin', 'podman-mac-helper');
}

function commandFailureForStep(error, code, message) {
  if (error?.code === 'SETUP_CANCELED') return error;
  return setupError(code, message, {
    ...(error?.details && typeof error.details === 'object' ? error.details : {}),
    causeCode: error?.code || ''
  });
}

async function runRuntimeSetupStep(step, context = {}) {
  const run = context.runProcess || runProcess;
  const machineName = context.plan?.machineName || DEFAULT_A0_MACHINE_NAME;
  const signal = context.signal;
  const brewPath = context.brewPath || await findBrewPath(run);
  const podmanPath = runtimeCommandPath(brewPath, 'podman');
  const dockerPath = runtimeCommandPath(brewPath, 'docker');
  const env = runtimeProcessEnv(brewPath);

  switch (step?.id) {
    case 'verify_existing_docker':
      return null;

    case 'install_homebrew':
      return run(HOMEBREW_INSTALL_COMMAND, HOMEBREW_INSTALL_ARGS, {
        env: { ...process.env, NONINTERACTIVE: '1' },
        signal
      }).catch((error) => {
        throw commandFailureForStep(error, 'HOMEBREW_INSTALL_FAILED', 'Homebrew installation failed');
      });

    case 'install_formulae': {
      const activeBrewPath = brewPath || await findBrewPath(run);
      if (!activeBrewPath) {
        throw setupError('BREW_NOT_FOUND', 'Homebrew was not found after installation');
      }

      const missing = missingFormulae(context.formulae);
      if (!missing.length) return null;
      return run(activeBrewPath, ['install', ...missing], { env, signal }).catch((error) => {
        throw commandFailureForStep(error, 'PACKAGE_INSTALL_FAILED', 'Runtime package installation failed');
      });
    }

    case 'init_podman_machine':
      return run(podmanPath, ['machine', 'init', machineName], { env, signal }).catch((error) => {
        throw commandFailureForStep(error, 'PODMAN_MACHINE_FAILED', 'Podman machine initialization failed');
      });

    case 'start_podman_machine':
      return run(podmanPath, ['machine', 'start', machineName], { env, signal }).catch((error) => {
        throw commandFailureForStep(error, 'PODMAN_MACHINE_FAILED', 'Podman machine start failed');
      });

    case 'install_podman_helper': {
      const helperPath = await podmanHelperPath(brewPath, run);
      return run('/usr/bin/osascript', ['-e', makeAuthorizationScript(helperPath)], { signal }).catch((error) => {
        if (error?.code === 'SETUP_CANCELED') throw error;
        const text = `${error?.message || ''}\n${error?.details?.stdout || ''}\n${error?.details?.stderr || ''}`;
        if (/cancel/i.test(text)) {
          throw setupError('AUTHORIZATION_CANCELED', 'Runtime setup needs one admin approval', error?.details || {});
        }
        throw commandFailureForStep(error, 'PODMAN_HELPER_FAILED', 'Podman Docker compatibility helper failed');
      });
    }

    case 'restart_podman_machine':
      await run(podmanPath, ['machine', 'stop', machineName], { env, signal }).catch(() => null);
      return run(podmanPath, ['machine', 'start', machineName], { env, signal }).catch((error) => {
        throw commandFailureForStep(error, 'PODMAN_MACHINE_FAILED', 'Podman machine restart failed');
      });

    case 'set_podman_rootful':
      await run(podmanPath, ['machine', 'stop', machineName], { env, signal }).catch(() => null);
      await run(podmanPath, ['machine', 'set', '--rootful', machineName], { env, signal }).catch((error) => {
        throw commandFailureForStep(error, 'ROOTFUL_SWITCH_FAILED', 'Podman rootful configuration failed');
      });
      return run(podmanPath, ['machine', 'start', machineName], { env, signal }).catch((error) => {
        throw commandFailureForStep(error, 'PODMAN_MACHINE_FAILED', 'Podman machine start failed');
      });

    case 'verify_runtime':
      return run(dockerPath, ['version', '--format', '{{.Server.Version}}'], { env, signal }).catch((error) => {
        throw commandFailureForStep(error, 'VERIFY_FAILED', 'Runtime verification failed');
      });

    default:
      throw setupError('UNKNOWN_SETUP_STEP', `Unknown runtime setup step: ${step?.id || ''}`);
  }
}

async function runRuntimeSetup(options = {}) {
  const signal = options.signal;
  const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const run = options.runProcess || runProcess;
  const existingRuntimeSetup = normalizeRuntimeSetupState(options.runtimeSetupState);
  const context = await collectRuntimeSetupContext({
    dockerAvailable: !!options.dockerAvailable,
    platform: options.platform,
    runProcess: run
  });
  const plan = makeRuntimeSetupPlan(context);

  if (plan.blocked) {
    const message = plan.blockCode === 'UNSUPPORTED_PLATFORM'
      ? 'Runtime setup is only available on macOS'
      : 'Runtime setup needs confirmation before changing an existing Podman machine';
    throw setupError(
      plan.blockCode,
      message,
      { machineName: plan.machineName }
    );
  }

  for (const step of plan.steps) {
    if (signal?.aborted) {
      throw setupError('SETUP_CANCELED', 'Runtime setup was canceled');
    }

    report({ stepId: step.id, message: step.label });
    await runRuntimeSetupStep(step, { ...context, plan, signal, runProcess: run });
  }

  return normalizeRuntimeSetupState({
    runtimeBackend: plan.ready ? existingRuntimeSetup.runtimeBackend : 'podman',
    machineName: plan.ready ? existingRuntimeSetup.machineName : plan.machineName,
    dockerHostOverride: plan.ready ? existingRuntimeSetup.dockerHostOverride : '',
    usesDefaultDockerSocket: plan.ready
      ? (existingRuntimeSetup.usesDefaultDockerSocket || !existingRuntimeSetup.dockerHostOverride)
      : true,
    lastSuccessfulSetupAt: new Date().toISOString()
  });
}

module.exports = {
  DEFAULT_A0_MACHINE_NAME,
  DEFAULT_PODMAN_MACHINE_NAME,
  HOMEBREW_INSTALL_ARGS,
  HOMEBREW_INSTALL_COMMAND,
  MAX_DOCKER_HOST_OVERRIDE_LENGTH,
  REQUIRED_FORMULAE,
  chooseBrewPath,
  choosePodmanMachine,
  collectRuntimeSetupContext,
  commandOutputLines,
  dockerOptionsForRuntimeSetup,
  findBrewPath,
  makeRuntimeSetupPlan,
  makeAuthorizationScript,
  missingFormulae,
  normalizeDockerHostOverride,
  normalizeMachines,
  normalizeRuntimeSetupState,
  parsePodmanMachineList,
  pathExists,
  podmanHelperPath,
  readInstalledFormulae,
  readPodmanMachines,
  runProcess,
  runRuntimeSetup,
  runRuntimeSetupStep,
  sanitizeCommandOutput,
  setupError
};
