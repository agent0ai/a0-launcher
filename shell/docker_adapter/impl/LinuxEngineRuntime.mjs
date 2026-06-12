/**
 * Linux Docker Engine provisioner.
 *
 * Reuse-first: DockerInterface probing runs before this class is consulted.
 * This class repairs stopped native Engine installs or installs Engine through
 * the host package manager when nothing usable exists.
 */

import os from 'node:os';
import { RuntimeProvisioner, makeError, run } from '../RuntimeProvisioner.mjs';

const MANUAL_PACKAGES = Object.freeze(['docker', 'containerd', 'runc', 'iptables', 'docker-cli']);

const PACKAGE_MANAGERS = Object.freeze([
  {
    id: 'apt',
    probe: 'apt-get',
    install: 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io'
  },
  {
    id: 'dnf',
    probe: 'dnf',
    install: 'dnf install -y moby-engine || dnf install -y docker'
  },
  {
    id: 'pacman',
    probe: 'pacman',
    install: 'pacman -Sy --noconfirm docker'
  },
  {
    id: 'zypper',
    probe: 'zypper',
    install: 'zypper --non-interactive install docker'
  },
  { id: 'yast', probe: 'yast', manual: true },
  { id: 'rpm', probe: 'rpm', manual: true }
]);

export class LinuxEngineRuntime extends RuntimeProvisioner {
  constructor(options = {}) {
    super(options);
    this._packageManager = undefined;
    this._runCommand = typeof options.runCommand === 'function' ? options.runCommand : run;
    this._isRootOverride = typeof options.isRoot === 'boolean' ? options.isRoot : null;
    this._usernameOverride = typeof options.username === 'string' ? options.username : '';
    this._probeNativeSocket = typeof options.probeNativeSocket === 'function' ? options.probeNativeSocket : null;
  }

  async assess() {
    const dockerPresent = await this.#binaryExists('docker');
    const dockerdPresent = await this.#binaryExists('dockerd');

    if (dockerPresent || dockerdPresent) {
      const socket = await this.#probeNativeSocket();
      if (socket === 'OK') {
        return { state: 'ready', detail: 'Docker Engine is ready.' };
      }
      if (socket === 'EACCES') {
        if (!(await this.#userBelongsToDockerGroup())) {
          if (await this.#canRunPrivilegedSetup()) {
            return {
              state: 'needs_group_membership',
              detail: 'Docker is installed, but your user needs Docker access. The launcher can update access, then you will need to log out and back in once.'
            };
          }
          return {
            state: 'manual_install',
            manualPackages: [],
            manualCommand: `sudo usermod -aG docker '${this.#username()}'`,
            detail: 'Docker is installed, but your user is not in the docker group. Add your user to docker, log out and back in, then return here.'
          };
        }
        return {
          state: 'needs_relogin',
          detail: 'Docker is installed, but this desktop session cannot access it yet. Log out and back in once, then return here.'
        };
      }
      return {
        state: 'engine_stopped',
        detail: 'Docker is installed but the service is not running. The launcher can start it for you.'
      };
    }

    const pm = await this.#detectPackageManager();
    if (!pm) {
      return {
        state: 'unsupported',
        detail: 'No supported Linux package manager was found. Install Docker Engine manually, then return here.'
      };
    }

    if (pm.manual) {
      return {
        state: 'manual_install',
        packageManager: pm.id,
        manualPackages: [...MANUAL_PACKAGES],
        detail: `This system uses ${pm.id}. Install the required Docker packages manually, then return here.`
      };
    }

    if (!(await this.#canRunPrivilegedSetup())) {
      return {
        state: 'manual_install',
        packageManager: pm.id,
        manualPackages: [...MANUAL_PACKAGES],
        manualCommand: this.#installScript(pm),
        detail: 'Automatic setup needs a system authentication dialog or passwordless sudo. Install Docker Engine manually, then return here.'
      };
    }

    return {
      state: 'not_provisioned',
      packageManager: pm.id,
      detail: 'No container runtime was found. The launcher can install Docker Engine for this system.'
    };
  }

  async provision(options = {}) {
    const assessment = await this.assess();

    if (assessment.state === 'ready') {
      return { endpoint: this.endpoint() };
    }

    if (assessment.state === 'engine_stopped') {
      await this.start(options);
      return { endpoint: this.endpoint() };
    }

    if (assessment.state === 'needs_group_membership') {
      options.onProgress?.('Updating Docker access');
      const updated = await this.#runPrivileged(this.#dockerGroupScript(), {
        timeoutMs: 120000,
        signal: options.signal
      });

      if (updated.code === 126 || updated.code === 127) {
        throw makeError('RUNTIME_AUTH_DECLINED', 'Authentication was cancelled.');
      }
      if (updated.code !== 0) {
        throw makeError('RUNTIME_PROVISION_FAILED', 'Docker access could not be updated.', {
          stderr: tail(updated.stderr || updated.stdout)
        });
      }

      throw makeError(
        'RUNTIME_NEEDS_RELOGIN',
        'Docker access was updated. Log out and back in once so your user gains access, then return here.'
      );
    }

    if (assessment.state === 'needs_relogin') {
      throw makeError('RUNTIME_NEEDS_RELOGIN', assessment.detail);
    }

    if (assessment.state === 'manual_install') {
      throw makeError('RUNTIME_MANUAL_INSTALL', assessment.detail, {
        packageManager: assessment.packageManager,
        packages: assessment.manualPackages,
        manualCommand: assessment.manualCommand
      });
    }

    if (assessment.state === 'unsupported') {
      throw makeError('RUNTIME_UNSUPPORTED', assessment.detail);
    }

    const pm = await this.#detectPackageManager();
    if (!pm || pm.manual || !pm.install) {
      throw makeError('RUNTIME_UNSUPPORTED', 'Automatic setup is not available on this system.');
    }

    options.onProgress?.('Installing Docker Engine');
    const install = await this.#runPrivileged(this.#installScript(pm), {
      timeoutMs: 15 * 60 * 1000,
      signal: options.signal,
      onLine: (line) => {
        if (/install|unpack|setting up|download|fetch/i.test(line)) {
          options.onProgress?.('Installing Docker Engine');
        }
      }
    });

    if (install.code === 126 || install.code === 127) {
      throw makeError('RUNTIME_AUTH_DECLINED', 'Authentication was cancelled.');
    }
    if (install.code !== 0) {
      throw makeError('RUNTIME_PROVISION_FAILED', 'Docker Engine could not be installed.', {
        stderr: tail(install.stderr || install.stdout)
      });
    }

    const socket = await this.#waitForNativeSocket(options.signal);
    if (socket === 'EACCES') {
      throw makeError(
        'RUNTIME_NEEDS_RELOGIN',
        'Docker is installed and running. Log out and back in once so your user gains access, then return here.'
      );
    }
    if (socket !== 'OK') {
      throw makeError('RUNTIME_START_FAILED', 'Docker Engine was installed, but the daemon is not reachable yet.');
    }

    options.onProgress?.('Runtime ready', 100);
    return { endpoint: this.endpoint() };
  }

  async start(options = {}) {
    options.onProgress?.('Starting Docker Engine');
    const started = await this.#runPrivileged(this.#startScript(), {
      timeoutMs: 120000,
      signal: options.signal
    });

    if (started.code === 126 || started.code === 127) {
      throw makeError('RUNTIME_AUTH_DECLINED', 'Authentication was cancelled.');
    }
    if (started.code !== 0) {
      throw makeError('RUNTIME_START_FAILED', 'Docker Engine could not be started.', {
        stderr: tail(started.stderr || started.stdout)
      });
    }

    const socket = await this.#waitForNativeSocket(options.signal);
    if (socket === 'EACCES') {
      throw makeError(
        'RUNTIME_NEEDS_RELOGIN',
        'Docker is running, but this desktop session cannot access it yet. Log out and back in once, then return here.'
      );
    }
    if (socket !== 'OK') {
      throw makeError('RUNTIME_START_FAILED', 'Docker Engine did not become reachable.');
    }

    options.onProgress?.('Runtime ready', 100);
  }

  async status() {
    const socket = await this.#probeNativeSocket();
    return {
      exists: socket !== 'ENOENT',
      running: socket === 'OK',
      needsRelogin: socket === 'EACCES'
    };
  }

  endpoint() {
    return {
      kind: 'unix',
      socketPath: '/var/run/docker.sock',
      dockerHost: 'unix:///var/run/docker.sock'
    };
  }

  async #detectPackageManager() {
    if (this._packageManager !== undefined) return this._packageManager;
    for (const pm of PACKAGE_MANAGERS) {
      if (await this.#binaryExists(pm.probe)) {
        this._packageManager = pm;
        return pm;
      }
    }
    this._packageManager = null;
    return null;
  }

  async #binaryExists(name) {
    const safe = String(name || '').replace(/[^A-Za-z0-9_.-]/g, '');
    if (!safe) return false;
    try {
      const result = await this._runCommand('sh', ['-c', `command -v ${safe}`], { timeoutMs: 5000 });
      return result.code === 0 && !!result.stdout.trim();
    } catch {
      return false;
    }
  }

  #installScript(pm) {
    return `${pm.install} && ${this.#startScript()} && ${this.#dockerGroupScript()}`;
  }

  #startScript() {
    return 'if command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker; then true; elif command -v service >/dev/null 2>&1; then service docker start; else exit 1; fi';
  }

  #dockerGroupScript() {
    if (this.#isRoot()) return 'true';
    const user = this.#username();
    return `if getent group docker >/dev/null 2>&1; then usermod -aG docker '${user}'; fi`;
  }

  async #runPrivileged(script, options = {}) {
    if (this.#isRoot()) {
      return await this._runCommand('sh', ['-c', script], options);
    }
    if (await this.#binaryExists('pkexec')) {
      return await this._runCommand('pkexec', ['sh', '-c', script], options);
    }
    if (await this.#canUsePasswordlessSudo()) {
      return await this._runCommand('sudo', ['-n', 'sh', '-c', script], options);
    }
    throw makeError(
      'RUNTIME_MANUAL_INSTALL',
      'Automatic setup needs a system authentication dialog or passwordless sudo.'
    );
  }

  async #probeNativeSocket() {
    if (this._probeNativeSocket) {
      return await this._probeNativeSocket();
    }
    const net = await import('node:net');
    return await new Promise((resolve) => {
      const socket = net.connect({ path: '/var/run/docker.sock' });
      const finish = (value) => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        resolve(value);
      };
      socket.setTimeout(1500);
      socket.once('connect', () => finish('OK'));
      socket.once('timeout', () => finish('ECONNREFUSED'));
      socket.once('error', (error) => {
        const code = error?.code || '';
        if (code === 'EACCES' || code === 'EPERM') finish('EACCES');
        else if (code === 'ENOENT') finish('ENOENT');
        else finish('ECONNREFUSED');
      });
    });
  }

  async #waitForNativeSocket(signal, timeoutMs = 90000) {
    const startedAt = Date.now();
    let last = 'ENOENT';

    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) throw makeError('ABORTED', 'Runtime start aborted');
      last = await this.#probeNativeSocket();
      if (last === 'OK' || last === 'EACCES') return last;
      await sleep(1000);
    }

    return last;
  }

  #isRoot() {
    if (this._isRootOverride !== null) return this._isRootOverride;
    return typeof process.getuid === 'function' && process.getuid() === 0;
  }

  async #canRunPrivilegedSetup() {
    if (this.#isRoot()) return true;
    if (await this.#binaryExists('pkexec')) return true;
    return await this.#canUsePasswordlessSudo();
  }

  async #canUsePasswordlessSudo() {
    try {
      const result = await this._runCommand('sudo', ['-n', 'true'], { timeoutMs: 5000 });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async #userBelongsToDockerGroup() {
    try {
      const result = await this._runCommand('id', ['-nG', this.#username()], { timeoutMs: 5000 });
      if (result.code !== 0) return false;
      return String(result.stdout || '').split(/\s+/).includes('docker');
    } catch {
      return false;
    }
  }

  #username() {
    const user = (this._usernameOverride || process.env.SUDO_USER || os.userInfo().username || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(user)) {
      throw makeError('INVALID_USERNAME', 'Refusing to run privileged setup for an unusual username.');
    }
    return user;
  }
}

function tail(value, limit = 1200) {
  return String(value || '').slice(-limit);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
