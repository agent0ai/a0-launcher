const DEFAULT_A0_MACHINE_NAME = 'a0-launcher';
const DEFAULT_PODMAN_MACHINE_NAME = 'podman-machine-default';
const REQUIRED_FORMULAE = Object.freeze([
  'docker',
  'docker-compose',
  'docker-credential-helper',
  'podman'
]);
const MAX_DOCKER_HOST_OVERRIDE_LENGTH = 2048;

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
    .map((line) => (/password|passwd|token|secret|credential/i.test(line) ? '[redacted]' : line))
    .join('\n')
    .trim();
}

module.exports = {
  DEFAULT_A0_MACHINE_NAME,
  DEFAULT_PODMAN_MACHINE_NAME,
  MAX_DOCKER_HOST_OVERRIDE_LENGTH,
  REQUIRED_FORMULAE,
  chooseBrewPath,
  choosePodmanMachine,
  makeRuntimeSetupPlan,
  missingFormulae,
  normalizeDockerHostOverride,
  normalizeMachines,
  normalizeRuntimeSetupState,
  sanitizeCommandOutput,
  setupError
};
