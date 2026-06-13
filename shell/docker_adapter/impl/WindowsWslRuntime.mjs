/**
 * Windows runtime assessment for Docker Desktop and WSL-backed Docker Engine.
 *
 * DockerInterface probing runs before this class is consulted. This provisioner
 * can start Docker Desktop when it is installed, or start an already-installed
 * WSL Docker Engine behind a Windows loopback bridge. It does not silently
 * enable Windows features, install WSL distros, or install Docker Engine.
 */

import { RuntimeProvisioner, makeError, run } from '../RuntimeProvisioner.mjs';
import { ensureWindowsWslDockerProxy } from './WindowsWslDockerProxy.mjs';

const WSL_GUIDE_URL = 'https://learn.microsoft.com/windows/wsl/install-on-server';
const WSL_INSTALL_URL = 'https://learn.microsoft.com/windows/wsl/install';
const DOCKER_ENGINE_UBUNTU_URL = 'https://docs.docker.com/engine/install/ubuntu/';
const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/';
const WSL_DOCKER_HOST = 'tcp://127.0.0.1:23750';

export class WindowsWslRuntime extends RuntimeProvisioner {
  constructor(options = {}) {
    super(options);
    this._runCommand = typeof options.runCommand === 'function' ? options.runCommand : run;
    this._isWindowsServerOverride = typeof options.isWindowsServer === 'boolean' ? options.isWindowsServer : null;
  }

  async assess() {
    const isServer = await this.#isWindowsServer();
    if (!isServer) {
      return await this.#assessWindowsClient();
    }

    const wslPresent = await this.#binaryExists('wsl.exe');
    if (!wslPresent) {
      return {
        state: 'manual_install',
        detail: 'Docker Desktop is not supported on Windows Server. Install WSL2 with nested virtualization support, then provide a Linux-container Docker Engine endpoint.',
        manualUrl: WSL_GUIDE_URL
      };
    }

    const wslFeature = await this.#optionalFeatureState('Microsoft-Windows-Subsystem-Linux');
    const vmPlatform = await this.#optionalFeatureState('VirtualMachinePlatform');
    if (wslFeature !== 'Enabled' || vmPlatform !== 'Enabled') {
      return {
        state: 'manual_install',
        detail: 'Docker Desktop is not supported on Windows Server. Enable WSL2 with wsl.exe --install --no-distribution, restart Windows, then provide a Linux-container Docker Engine endpoint.',
        manualCommand: 'wsl.exe --install --no-distribution',
        manualUrl: WSL_GUIDE_URL
      };
    }

    const distroList = await this.#wslList();
    if (/has no installed distributions|no installed distributions/i.test(distroList)) {
      return {
        state: 'manual_install',
        detail: 'WSL2 is enabled, but no Linux Docker Engine is available yet. Install a WSL distro with Docker Engine. If WSL2 cannot start, this VM needs nested virtualization or Hyper-V support from the host provider.',
        manualUrl: WSL_GUIDE_URL
      };
    }

    return {
      state: 'manual_install',
      detail: 'A WSL distro is installed, but no Windows Docker endpoint is reachable yet. Start Docker Engine in WSL and expose it through a local Docker endpoint, then refresh.',
      manualUrl: WSL_GUIDE_URL
    };
  }

  async provision() {
    const assessment = await this.assess();
    if (assessment?.mode === 'wsl_engine' && (assessment.state === 'engine_stopped' || assessment.state === 'not_provisioned')) {
      await this.#configureAndStartWslDocker(assessment.distro);
      await ensureWindowsWslDockerProxy({ distro: assessment.distro });
      return;
    }
    if (assessment?.mode === 'docker_desktop' && assessment.state === 'engine_stopped') {
      await this.#startDockerDesktop();
      return;
    }
    throw makeError('RUNTIME_UNSUPPORTED', assessment.detail, this.#manualDetails(assessment));
  }

  async start() {
    const assessment = await this.assess();
    if (assessment?.mode === 'wsl_engine') {
      await this.#configureAndStartWslDocker(assessment.distro);
      await ensureWindowsWslDockerProxy({ distro: assessment.distro });
      return;
    }
    if (assessment?.mode === 'docker_desktop') {
      await this.#startDockerDesktop();
      return;
    }
    throw makeError('RUNTIME_UNSUPPORTED', assessment.detail, this.#manualDetails(assessment));
  }

  async status() {
    return {
      exists: await this.#binaryExists('wsl.exe'),
      running: false,
      needsRelogin: false
    };
  }

  endpoint() {
    return {
      kind: 'tcp',
      host: '127.0.0.1',
      port: 23750,
      dockerHost: 'tcp://127.0.0.1:23750'
    };
  }

  async #assessWindowsClient() {
    const dockerDesktopPath = await this.#dockerDesktopPath();
    const dockerDesktopInstalled = Boolean(dockerDesktopPath);
    const wslPresent = await this.#binaryExists('wsl.exe');

    if (!wslPresent) {
      if (dockerDesktopInstalled) return this.#dockerDesktopStoppedAssessment();
      return {
        state: 'manual_install',
        detail: 'Install Docker Desktop, or install WSL2 with a Linux distro and Docker Engine. WSL feature installation may require administrator approval and a Windows restart.',
        manualCommand: 'wsl.exe --install --no-distribution',
        manualUrl: WSL_INSTALL_URL
      };
    }

    const wslFeature = await this.#optionalFeatureState('Microsoft-Windows-Subsystem-Linux');
    const vmPlatform = await this.#optionalFeatureState('VirtualMachinePlatform');
    if (wslFeature !== 'Enabled' || vmPlatform !== 'Enabled') {
      if (dockerDesktopInstalled) return this.#dockerDesktopStoppedAssessment();
      return {
        state: 'manual_install',
        detail: 'WSL2 is not fully enabled. Enable WSL and VirtualMachinePlatform, restart Windows if requested, then install a Linux distro and Docker Engine.',
        manualCommand: 'wsl.exe --install --no-distribution',
        manualUrl: WSL_INSTALL_URL
      };
    }

    const distros = await this.#wslDistros();
    const distro = this.#selectWslDistro(distros);
    if (!distro) {
      if (dockerDesktopInstalled) return this.#dockerDesktopStoppedAssessment();
      return {
        state: 'manual_install',
        detail: 'WSL2 is enabled, but no Linux distro is installed. Install Ubuntu, then install Docker Engine inside WSL.',
        manualCommand: 'wsl.exe --install -d Ubuntu',
        manualUrl: WSL_INSTALL_URL
      };
    }

    const hasDocker = await this.#wslCommandOk(distro.name, 'command -v docker >/dev/null 2>&1');
    const hasDockerd = await this.#wslCommandOk(distro.name, 'command -v dockerd >/dev/null 2>&1');
    if (!hasDocker || !hasDockerd) {
      if (dockerDesktopInstalled) return this.#dockerDesktopStoppedAssessment();
      return {
        state: 'manual_install',
        mode: 'wsl_engine',
        distro: distro.name,
        detail: `WSL2 distro '${distro.name}' is available, but Docker Engine is not installed there. Install Docker Engine in WSL, then return here.`,
        manualUrl: DOCKER_ENGINE_UBUNTU_URL
      };
    }

    const hasPython = await this.#wslCommandOk(distro.name, 'command -v python3 >/dev/null 2>&1');
    if (!hasPython) {
      return {
        state: 'manual_install',
        mode: 'wsl_engine',
        distro: distro.name,
        detail: `WSL2 distro '${distro.name}' has Docker Engine, but python3 is required for the Windows loopback bridge.`,
        manualCommand: 'sudo apt-get update && sudo apt-get install -y python3',
        manualUrl: DOCKER_ENGINE_UBUNTU_URL
      };
    }

    const dockerReady = await this.#wslCommandOk(distro.name, 'docker info >/dev/null 2>&1');
    if (dockerReady) {
      return {
        state: 'engine_stopped',
        mode: 'wsl_engine',
        distro: distro.name,
        detail: `WSL Docker Engine is running in '${distro.name}'. Start the local loopback bridge at ${WSL_DOCKER_HOST}.`
      };
    }

    return {
      state: 'engine_stopped',
      mode: 'wsl_engine',
      distro: distro.name,
      detail: `Docker Engine is installed in WSL distro '${distro.name}', but it is not running or needs endpoint repair. The launcher can start it and expose a Windows loopback bridge at ${WSL_DOCKER_HOST}.`
    };
  }

  #dockerDesktopStoppedAssessment() {
    return {
      state: 'engine_stopped',
      mode: 'docker_desktop',
      detail: 'Docker Desktop is installed but its Docker endpoint is not reachable. Start Docker Desktop, or install WSL2 and Docker Engine for a Docker-Desktop-free runtime.',
      manualUrl: DOCKER_DESKTOP_URL
    };
  }

  async #binaryExists(binary) {
    const result = await this._runCommand('where.exe', [binary], { timeoutMs: 5000 }).catch(() => ({ code: 1 }));
    return result.code === 0;
  }

  async #isWindowsServer() {
    if (this._isWindowsServerOverride !== null) return this._isWindowsServerOverride;
    const script = '(Get-CimInstance Win32_OperatingSystem).ProductType';
    const result = await this.#powershell(script);
    const productType = Number(String(result.stdout || '').trim());
    return Number.isFinite(productType) && productType !== 1;
  }

  async #optionalFeatureState(name) {
    const safeName = String(name || '').replace(/'/g, "''");
    const script = `try { (Get-WindowsOptionalFeature -Online -FeatureName '${safeName}' -ErrorAction Stop).State } catch { 'Unknown' }`;
    const result = await this.#powershell(script);
    return String(result.stdout || '').trim() || 'Unknown';
  }

  async #wslList() {
    const result = await this._runCommand('wsl.exe', ['-l', '-v'], { timeoutMs: 15000 }).catch((error) => ({
      code: -1,
      stdout: '',
      stderr: error?.message || String(error)
    }));
    return cleanCommandText(`${result.stdout || ''}\n${result.stderr || ''}`);
  }

  async #wslDistros() {
    const text = await this.#wslList();
    const distros = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^NAME\s+STATE\s+VERSION$/i.test(line)) continue;
      const defaultDistro = line.startsWith('*');
      const clean = line.replace(/^\*\s*/, '').trim();
      const parts = clean.split(/\s+/);
      if (parts.length < 3) continue;
      const version = Number(parts.pop());
      const state = parts.pop();
      const name = parts.join(' ');
      if (!name || !Number.isFinite(version)) continue;
      distros.push({ name, state, version, default: defaultDistro });
    }
    return distros;
  }

  #selectWslDistro(distros) {
    const wsl2 = (distros || []).filter((d) => d.version === 2);
    return (
      wsl2.find((d) => d.default) ||
      wsl2.find((d) => /^Ubuntu$/i.test(d.name)) ||
      wsl2.find((d) => /^Ubuntu/i.test(d.name)) ||
      wsl2[0] ||
      null
    );
  }

  async #wslCommandOk(distro, script) {
    const result = await this.#wslSh(distro, script, { timeoutMs: 15000 }).catch(() => ({ code: 1 }));
    return result.code === 0;
  }

  async #configureAndStartWslDocker(distro) {
    const script = [
      'set -eu',
      'if docker info >/dev/null 2>&1; then exit 0; fi',
      'if command -v systemctl >/dev/null 2>&1 && [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ]; then',
      '  systemctl reset-failed docker || true',
      '  systemctl start docker || systemctl restart docker',
      'elif command -v service >/dev/null 2>&1; then',
      '  service docker start || service docker restart',
      'else',
      '  dockerd >/tmp/a0-dockerd.log 2>&1 &',
      'fi',
      'docker info >/dev/null 2>&1'
    ].join('\n');
    await this.#wslRootSh(distro, script, { timeoutMs: 120000 });
  }

  async #dockerDesktopPath() {
    const script = [
      '$paths = @(',
      '  (Join-Path $env:ProgramFiles "Docker\\Docker\\Docker Desktop.exe")',
      ')',
      'if (${env:ProgramFiles(x86)}) { $paths += (Join-Path ${env:ProgramFiles(x86)} "Docker\\Docker\\Docker Desktop.exe") }',
      '$found = $paths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1',
      'if ($found) { $found }'
    ].join('; ');
    const result = await this.#powershell(script).catch(() => ({ code: 1, stdout: '' }));
    return result.code === 0 ? String(result.stdout || '').trim() : '';
  }

  async #startDockerDesktop() {
    const desktopPath = await this.#dockerDesktopPath();
    const command = desktopPath
      ? `Start-Process -LiteralPath '${desktopPath.replace(/'/g, "''")}'`
      : "Start-Process 'docker-desktop:'";
    await this.#powershell(command);
  }

  async #wslSh(distro, script, options = {}) {
    const args = [];
    const selected = String(distro || '').trim();
    if (selected) args.push('-d', selected);
    args.push('--exec', 'sh', '-lc', script);
    return await this._runCommand('wsl.exe', args, { timeoutMs: options.timeoutMs || 15000 });
  }

  async #wslRootSh(distro, script, options = {}) {
    const args = [];
    const selected = String(distro || '').trim();
    if (selected) args.push('-d', selected);
    args.push('-u', 'root', '--exec', 'sh', '-lc', script);
    return await this._runCommand('wsl.exe', args, { timeoutMs: options.timeoutMs || 120000 });
  }

  #manualDetails(assessment) {
    return {
      manualUrl: assessment?.manualUrl,
      manualCommand: assessment?.manualCommand,
      distro: assessment?.distro
    };
  }

  async #powershell(script) {
    return await this._runCommand(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: 15000 }
    );
  }
}

export const WINDOWS_WSL_GUIDE_URL = WSL_GUIDE_URL;
export const WINDOWS_DOCKER_DESKTOP_URL = DOCKER_DESKTOP_URL;

function cleanCommandText(value) {
  return String(value || '').replace(/\0/g, '');
}
