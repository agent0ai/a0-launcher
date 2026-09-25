/**
 * macOS Docker runtime provisioner.
 *
 * Colima runs a Docker-compatible daemon without Docker Desktop. The launcher
 * uses a dedicated `a0` profile and connects dockerode directly to its Unix
 * socket, so no `/var/run/docker.sock` symlink is required. Colima still
 * checks for a Docker CLI during startup, so a launcher-owned static client is
 * installed when the host does not already provide one.
 */

import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  RuntimeProvisioner,
  downloadVerified,
  fetchJson,
  fetchText,
  makeError,
  pathExists,
  run,
  sleep,
  tail,
  sha256FromSumText
} from '../RuntimeProvisioner.mjs';

const PROFILE = 'a0';
const COLIMA_RELEASE_API = 'https://api.github.com/repos/abiosoft/colima/releases/latest';
const LIMA_RELEASE_API = 'https://api.github.com/repos/lima-vm/lima/releases/latest';
const DOCKER_STATIC_BASE = 'https://download.docker.com/mac/static/stable';
const DOCKER_DESKTOP_SOCKET = path.join(os.homedir(), '.docker', 'run', 'docker.sock');
const DOCKER_DESKTOP_APP_PATHS = Object.freeze([
  '/Applications/Docker.app',
  path.join(os.homedir(), 'Applications', 'Docker.app')
]);

const PROGRESS_MAP = Object.freeze([
  [/download/i, 'Downloading runtime components'],
  [/provision|prepar/i, 'Preparing the runtime'],
  [/creating|starting|boot/i, 'Starting the runtime'],
  [/runtime:\s*docker/i, 'Starting Docker Engine']
]);

export class ColimaRuntime extends RuntimeProvisioner {
  constructor(options = {}) {
    super(options);
    this.binDir = path.join(this.managedDir, 'bin');
    this._colimaBin = null;
    this._dockerBin = null;
    this._runCommand = typeof options.runCommand === 'function' ? options.runCommand : run;
    this._dockerDesktopAppPaths = Array.isArray(options.dockerDesktopAppPaths)
      ? options.dockerDesktopAppPaths.filter((item) => typeof item === 'string' && item.trim())
      : DOCKER_DESKTOP_APP_PATHS;
  }

  async assess() {
    const bin = await this.findColimaBinary();
    if (bin) {
      const status = await this.status();
      if (status.exists && status.running) {
        return { state: 'ready', detail: 'Runtime is running.' };
      }
      if (status.exists && !status.running) {
        return { state: 'engine_stopped', mode: 'colima', detail: 'The Agent Zero runtime is installed but not running.' };
      }
    }

    if (await this.#dockerDesktopInstalled()) {
      return this.#dockerDesktopStoppedAssessment();
    }

    if (!bin) {
      return {
        state: 'not_provisioned',
        mode: 'colima',
        detail: 'Finish local Agent Zero runtime Setup.'
      };
    }

    return {
      state: 'not_provisioned',
      mode: 'colima',
      detail: 'Colima is installed. Continue to prepare Agent Zero.'
    };
  }

  async assessDockerDesktop() {
    return await this.#dockerDesktopInstalled() ? this.#dockerDesktopStoppedAssessment() : null;
  }

  async provision(options = {}) {
    await this.ensureBinaries(options);
    const bin = await this.findColimaBinary();
    if (!bin) throw makeError('RUNTIME_NOT_PROVISIONED', 'Colima is not available.');

    options.onProgress?.('Starting the runtime');
    const result = await this._runCommand(bin, ['start', PROFILE, '--runtime', 'docker'], {
      timeoutMs: 20 * 60 * 1000,
      signal: options.signal,
      env: this.#env(),
      onLine: (line) => {
        for (const [pattern, message] of PROGRESS_MAP) {
          if (pattern.test(line)) {
            options.onProgress?.(message, null, 'start_runtime');
            return;
          }
        }
      }
    });

    if (result.code !== 0) {
      throw makeError('RUNTIME_START_FAILED', 'The runtime could not be started.', {
        stderr: tail(result.stderr || result.stdout)
      });
    }

    options.onProgress?.('Checking Docker Engine', null, 'verify_runtime');
    const ready = await this.#waitForSocket({ signal: options.signal });
    if (!ready) {
      throw makeError('RUNTIME_START_FAILED', 'The runtime started, but Docker did not become reachable.');
    }

    options.onProgress?.('Runtime ready', 100);
    return { endpoint: this.endpoint() };
  }

  async start(options = {}) {
    if (options.mode === 'docker_desktop') {
      return await this.#startDockerDesktop(options);
    }
    const assessment = await this.assess();
    if (assessment?.mode === 'docker_desktop') {
      return await this.#startDockerDesktop(options);
    }
    return await this.provision(options);
  }

  async status() {
    const bin = await this.findColimaBinary();
    if (!bin) return { exists: false, running: false };

    const result = await this._runCommand(bin, ['list', '--json'], {
      timeoutMs: 15000,
      env: this.#env()
    }).catch(() => null);
    if (!result || result.code !== 0) return { exists: false, running: false };

    const rows = parseColimaJsonRows(result.stdout);
    const match = rows.find((row) => row?.name === PROFILE) || null;
    if (!match) return { exists: false, running: false };

    return {
      exists: true,
      running: String(match.status || '').toLowerCase() === 'running',
      raw: match
    };
  }

  endpoint() {
    const socketPath = path.join(os.homedir(), '.colima', PROFILE, 'docker.sock');
    return {
      kind: 'unix',
      socketPath,
      dockerHost: `unix://${socketPath}`
    };
  }

  async findColimaBinary() {
    if (this._colimaBin) return this._colimaBin;
    const candidates = [
      '/opt/homebrew/bin/colima',
      '/usr/local/bin/colima',
      path.join(this.binDir, 'colima'),
      'colima'
    ];

    for (const candidate of candidates) {
      try {
        const result = await this._runCommand(candidate, ['version'], {
          timeoutMs: 8000,
          env: this.#env()
        });
        if (result.code === 0) {
          this._colimaBin = candidate;
          return candidate;
        }
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  async findDockerBinary() {
    if (this._dockerBin) return this._dockerBin;
    const candidates = [
      '/opt/homebrew/bin/docker',
      '/usr/local/bin/docker',
      path.join(this.binDir, 'docker'),
      'docker'
    ];

    for (const candidate of candidates) {
      try {
        const result = await this._runCommand(candidate, ['--version'], {
          timeoutMs: 8000,
          env: this.#env()
        });
        if (result.code === 0) {
          this._dockerBin = candidate;
          return candidate;
        }
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  async ensureBinaries(options = {}) {
    await fsp.mkdir(this.binDir, { recursive: true });
    options.onProgress?.('Finding runtime components');

    await this.#ensureDockerClient(options);

    const existing = await this.findColimaBinary();
    if (existing && !isManagedPath(existing, this.binDir)) return;

    const colimaPath = path.join(this.binDir, 'colima');
    const limactlPath = path.join(this.binDir, 'limactl');
    if (await pathExists(colimaPath) && await pathExists(limactlPath)) {
      this._colimaBin = colimaPath;
      return;
    }

    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const [colimaRelease, limaRelease] = await Promise.all([
      fetchJson(COLIMA_RELEASE_API, options),
      fetchJson(LIMA_RELEASE_API, options)
    ]);

    const colimaAsset = findAsset(colimaRelease, new RegExp(`^colima-Darwin-${arch}$`));
    const colimaShaAsset = findAsset(colimaRelease, new RegExp(`^colima-Darwin-${arch}\\.sha256sum$`));

    const limaVersion = String(limaRelease?.tag_name || '').replace(/^v/, '');
    const limaAssetName = `lima-${limaVersion}-Darwin-${arch}.tar.gz`;
    const limaGuestAssetName = `lima-additional-guestagents-${limaVersion}-Darwin-${arch}.tar.gz`;
    const limaAsset = findAsset(limaRelease, new RegExp(`^${escapeRe(limaAssetName)}$`));
    const limaGuestAsset = findAsset(limaRelease, new RegExp(`^${escapeRe(limaGuestAssetName)}$`));
    const limaShaAsset = findAsset(limaRelease, /^SHA256SUMS$/);

    if (!colimaAsset || !limaAsset || !limaGuestAsset || !limaShaAsset) {
      throw makeError('RUNTIME_PROVISION_FAILED', 'Could not find the required runtime release assets.');
    }

    options.onProgress?.('Downloading runtime components');
    const [colimaShaText, limaShaText] = await Promise.all([
      colimaShaAsset ? fetchText(colimaShaAsset.browser_download_url, options) : Promise.resolve(''),
      fetchText(limaShaAsset.browser_download_url, options)
    ]);

    const colimaSha = sha256FromSumText(colimaShaText, colimaAsset.name);
    const limaSha = sha256FromSumText(limaShaText, limaAsset.name);
    const limaGuestSha = sha256FromSumText(limaShaText, limaGuestAsset.name);
    if (!colimaSha || !limaSha || !limaGuestSha) {
      throw makeError('RUNTIME_PROVISION_FAILED', 'Could not verify runtime component checksums.');
    }

    await downloadVerified(colimaAsset.browser_download_url, colimaPath, colimaSha, options);
    await fsp.chmod(colimaPath, 0o755);

    const limaTarPath = path.join(this.managedDir, limaAsset.name);
    const limaGuestTarPath = path.join(this.managedDir, limaGuestAsset.name);
    await downloadVerified(limaAsset.browser_download_url, limaTarPath, limaSha, options);
    await downloadVerified(limaGuestAsset.browser_download_url, limaGuestTarPath, limaGuestSha, options);

    options.onProgress?.('Installing runtime components');
    await this.#extractTar(limaTarPath, options);
    await this.#extractTar(limaGuestTarPath, options);
    await fsp.rm(limaTarPath, { force: true });
    await fsp.rm(limaGuestTarPath, { force: true });

    this._colimaBin = colimaPath;
  }

  async #ensureDockerClient(options = {}) {
    const existing = await this.findDockerBinary();
    if (existing) return existing;

    const dockerPath = path.join(this.binDir, 'docker');
    const dockerArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const indexUrl = `${DOCKER_STATIC_BASE}/${dockerArch}/`;
    const asset = await latestDockerCliAsset(indexUrl, options);
    if (!asset) {
      throw makeError('RUNTIME_PROVISION_FAILED', 'Could not find a Docker CLI release asset.');
    }

    const tarPath = path.join(this.managedDir, asset.name);
    const extractDir = path.join(this.managedDir, `docker-cli-${process.pid}-${Date.now()}`);

    options.onProgress?.('Downloading Docker client', null, 'prepare_client');
    // Docker's static macOS index does not publish checksum sidecars.
    await downloadVerified(asset.url, tarPath, '', options);

    options.onProgress?.('Installing Docker client', null, 'prepare_client');
    await fsp.mkdir(extractDir, { recursive: true });
    try {
      const result = await this._runCommand('/usr/bin/tar', ['-xzf', tarPath, '-C', extractDir, 'docker/docker'], {
        timeoutMs: 120000,
        signal: options.signal,
        env: this.#env()
      });
      if (result.code !== 0) {
        throw makeError('RUNTIME_PROVISION_FAILED', 'Could not install the Docker client.', {
          stderr: tail(result.stderr || result.stdout)
        });
      }

      await fsp.copyFile(path.join(extractDir, 'docker', 'docker'), dockerPath);
      await fsp.chmod(dockerPath, 0o755);
      this._dockerBin = dockerPath;
      return dockerPath;
    } finally {
      await fsp.rm(tarPath, { force: true }).catch(() => {});
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #extractTar(tarPath, options = {}) {
    const result = await this._runCommand('/usr/bin/tar', ['-xzf', tarPath, '-C', this.managedDir], {
      timeoutMs: 120000,
      signal: options.signal,
      env: this.#env()
    });
    if (result.code !== 0) {
      throw makeError('RUNTIME_PROVISION_FAILED', 'Could not install runtime components.', {
        stderr: tail(result.stderr || result.stdout)
      });
    }
  }

  async #waitForSocket(options = {}) {
    const socketPath = options.socketPath || this.endpoint().socketPath;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(1000, Number(options.timeoutMs))
      : 60000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (options.signal?.aborted) throw makeError('ABORTED', 'Runtime start aborted');
      if (await canConnectSocket(socketPath)) return true;
      await sleep(700);
    }
    return false;
  }

  #env() {
    return {
      ...process.env,
      PATH: `${this.binDir}:${process.env.PATH || ''}`
    };
  }

  async #dockerDesktopInstalled() {
    for (const appPath of this._dockerDesktopAppPaths) {
      try {
        const stat = await fsp.stat(appPath);
        if (stat.isDirectory()) return true;
      } catch {
        // try next candidate
      }
    }
    return false;
  }

  #dockerDesktopStoppedAssessment() {
    return {
      state: 'engine_stopped',
      mode: 'docker_desktop',
      detail: 'Docker Desktop is installed but not running. Start Docker Desktop, wait until it finishes starting, then return here.'
    };
  }

  #dockerDesktopEndpoint() {
    return {
      kind: 'unix',
      socketPath: DOCKER_DESKTOP_SOCKET,
      dockerHost: `unix://${DOCKER_DESKTOP_SOCKET}`
    };
  }

  async #startDockerDesktop(options = {}) {
    options.onProgress?.('Starting Docker Desktop');
    const result = await this._runCommand('/usr/bin/open', ['-a', 'Docker'], {
      timeoutMs: 30000,
      signal: options.signal,
      env: this.#env()
    });

    if (result.code !== 0) {
      throw makeError('RUNTIME_START_FAILED', 'Docker Desktop could not be started.', {
        stderr: tail(result.stderr || result.stdout)
      });
    }

    const endpoint = this.#dockerDesktopEndpoint();
    options.onProgress?.('Waiting for Docker Desktop');
    const ready = await this.#waitForSocket({
      socketPath: endpoint.socketPath,
      signal: options.signal,
      timeoutMs: 120000
    });
    if (!ready) {
      throw makeError('RUNTIME_START_FAILED', 'Docker Desktop started, but Docker did not become reachable.');
    }

    options.onProgress?.('Runtime ready', 100);
    return { endpoint };
  }
}

function parseColimaJsonRows(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Colima has emitted newline-delimited JSON in some versions.
  }

  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // ignore non-JSON noise
    }
  }
  return rows;
}

function findAsset(release, pattern) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((asset) => pattern.test(String(asset?.name || ''))) || null;
}

async function latestDockerCliAsset(indexUrl, options = {}) {
  const html = await fetchText(indexUrl, options);
  return selectLatestDockerCliAsset(indexUrl, html);
}

export function selectLatestDockerCliAsset(indexUrl, html) {
  const assets = [];
  const pattern = /href="(docker-([0-9]+(?:\.[0-9]+){2}(?:-[0-9]+)?)\.tgz)"/g;
  for (;;) {
    const match = pattern.exec(html);
    if (!match) break;
    assets.push({ name: match[1], version: match[2], url: new URL(match[1], indexUrl).toString() });
  }
  assets.sort((a, b) => compareVersionLike(a.version, b.version));
  return assets[assets.length - 1] || null;
}

function isManagedPath(candidate, binDir) {
  const resolved = path.resolve(candidate);
  const managed = path.resolve(binDir);
  return resolved === path.join(managed, path.basename(resolved));
}

function escapeRe(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareVersionLike(left, right) {
  const a = String(left || '').split(/[.-]/).map((value) => Number.parseInt(value, 10) || 0);
  const b = String(right || '').split(/[.-]/).map((value) => Number.parseInt(value, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

async function canConnectSocket(socketPath) {
  const net = await import('node:net');
  return await new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });
    const finish = (ok) => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    socket.setTimeout(1200);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
