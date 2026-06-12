/**
 * Windows runtime assessment for Docker Desktop and WSL-backed Docker Engine.
 *
 * DockerInterface probing runs before this class is consulted. This provisioner
 * does not install a runtime yet; it gives Windows Server hosts a precise
 * Docker Desktop/WSL2/nested-virtualization diagnostic instead of a generic
 * Docker Desktop download path.
 */

import { RuntimeProvisioner, makeError, run } from '../RuntimeProvisioner.mjs';

const WSL_GUIDE_URL = 'https://learn.microsoft.com/windows/wsl/install-on-server';
const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/';

export class WindowsWslRuntime extends RuntimeProvisioner {
  constructor(options = {}) {
    super(options);
    this._runCommand = typeof options.runCommand === 'function' ? options.runCommand : run;
    this._isWindowsServerOverride = typeof options.isWindowsServer === 'boolean' ? options.isWindowsServer : null;
  }

  async assess() {
    const isServer = await this.#isWindowsServer();
    if (!isServer) {
      return {
        state: 'manual_install',
        detail: 'Install Docker Desktop or configure a Docker-compatible endpoint, then return here.',
        manualUrl: DOCKER_DESKTOP_URL
      };
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
    throw makeError('RUNTIME_UNSUPPORTED', assessment.detail, {
      manualUrl: assessment.manualUrl,
      manualCommand: assessment.manualCommand
    });
  }

  async start() {
    const assessment = await this.assess();
    throw makeError('RUNTIME_UNSUPPORTED', assessment.detail, {
      manualUrl: assessment.manualUrl,
      manualCommand: assessment.manualCommand
    });
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
