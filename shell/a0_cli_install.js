const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const semver = require('semver');

const A0_CLI_INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/agent0ai/a0-connector/main/install.sh';
const A0_CLI_INSTALL_SCRIPT_URL_WINDOWS = 'https://raw.githubusercontent.com/agent0ai/a0-connector/main/install.ps1';
const A0_CLI_RELEASE_API_URL = 'https://api.github.com/repos/agent0ai/a0-connector/releases/latest';

function normalizeA0CliVersion(value) {
  const match = String(value || '').match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/i);
  return semver.coerce(match?.[1] || '')?.version || '';
}

function shouldInstallA0Cli({ installed = false, supportsGateway = false, currentVersion = '', latestVersion = '' } = {}) {
  if (!installed || !supportsGateway) return true;
  const current = normalizeA0CliVersion(currentVersion);
  const latest = normalizeA0CliVersion(latestVersion);
  return !!latest && (!current || semver.gt(latest, current));
}

function a0CliInstallCommand(platform = process.platform, scriptPath = '') {
  if (platform === 'win32') {
    if (!scriptPath) throw new Error('A downloaded A0 CLI installer is required.');
    return {
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'RemoteSigned',
        '-NonInteractive',
        '-File',
        scriptPath
      ]
    };
  }
  if (platform === 'darwin' || platform === 'linux') {
    const script = [
      'tmp="$(mktemp "${TMPDIR:-/tmp}/a0-cli-install.XXXXXX")" || exit 1',
      'trap \'rm -f "$tmp"\' EXIT INT TERM',
      `if command -v curl >/dev/null 2>&1; then curl -LsSf '${A0_CLI_INSTALL_SCRIPT_URL}' -o "$tmp"`,
      `elif command -v wget >/dev/null 2>&1; then wget -qO "$tmp" '${A0_CLI_INSTALL_SCRIPT_URL}'`,
      'else echo "curl or wget is required to install A0 CLI." >&2; exit 127; fi',
      'sh "$tmp"'
    ].join('; ');
    return { command: 'sh', args: ['-c', script] };
  }
  const error = new Error('Installing A0 CLI is not available on this system.');
  error.code = 'TERMINAL_UNAVAILABLE';
  throw error;
}

async function runA0CliInstaller({ platform = process.platform, spawn = childProcess.spawn, env = process.env, fetch = globalThis.fetch } = {}) {
  let tempDir;
  try {
    let scriptPath = '';
    if (platform === 'win32') {
      const response = await fetch(A0_CLI_INSTALL_SCRIPT_URL_WINDOWS, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`A0 CLI installer download failed (HTTP ${response.status}).`);
      const script = await response.text();
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a0-cli-install-'));
      scriptPath = path.join(tempDir, 'install.ps1');
      await fs.writeFile(scriptPath, script, { encoding: 'utf8', flag: 'wx' });
    }
    const spec = a0CliInstallCommand(platform, scriptPath);
    return await runInstallerCommand(spec, { spawn, env });
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function runInstallerCommand(spec, { spawn, env }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ installed: true });
    };

    let child;
    try {
      child = spawn(spec.command, spec.args, {
        stdio: 'ignore',
        windowsHide: true,
        env
      });
    } catch (error) {
      finish(error);
      return;
    }

    child.once('error', finish);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const error = new Error(`A0 CLI installer exited (${code ?? signal ?? 'unknown'}).`);
      error.code = 'CLI_INSTALL_FAILED';
      finish(error);
    });
  });
}

function runA0CliUpdate(cli, { spawn = childProcess.spawn, env = process.env } = {}) {
  const binary = String(cli || '').trim();
  if (!binary) {
    const error = new Error('A0 CLI was not found.');
    error.code = 'TERMINAL_UNAVAILABLE';
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let output = '';
    let child;
    try {
      child = spawn(binary, ['update'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once('error', reject);
    child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-8192); });
    child.stderr.resume();
    // The CLI exits before its updater. Inherited pipes close after the handoff finishes.
    child.once('close', (code, signal) => {
      if (code === 0 && /(?:^|\r?\n)Update complete\. Run a0\.(?:\r?\n|$)/.test(output)) {
        resolve({ updated: true });
        return;
      }
      const error = new Error(`A0 CLI update did not complete (${code ?? signal ?? 'unknown'}).`);
      error.code = 'CLI_UPDATE_FAILED';
      reject(error);
    });
  });
}

module.exports = {
  A0_CLI_RELEASE_API_URL,
  a0CliInstallCommand,
  normalizeA0CliVersion,
  runA0CliInstaller,
  runA0CliUpdate,
  shouldInstallA0Cli
};
