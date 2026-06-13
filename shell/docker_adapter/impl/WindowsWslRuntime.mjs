/**
 * Windows runtime assessment for Docker Desktop and WSL-backed Docker Engine.
 *
 * DockerInterface probing runs before this class is consulted. This provisioner
 * can start Docker Desktop when it is installed, or start an already-installed
 * WSL Docker Engine behind a Windows loopback bridge. Windows client WSL setup
 * is explicit and goes through a user-approved UAC prompt when Windows features
 * need administrator rights.
 */

import { RuntimeProvisioner, makeError, run } from '../RuntimeProvisioner.mjs';
import { ensureWindowsWslDockerProxy } from './WindowsWslDockerProxy.mjs';

const WSL_GUIDE_URL = 'https://learn.microsoft.com/windows/wsl/install-on-server';
const WSL_INSTALL_URL = 'https://learn.microsoft.com/windows/wsl/install';
const DOCKER_ENGINE_UBUNTU_URL = 'https://docs.docker.com/engine/install/ubuntu/';
const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/';
const WSL_DOCKER_HOST = 'tcp://127.0.0.1:23750';
const DEFAULT_WSL_DISTRO = 'Ubuntu';

export class WindowsWslRuntime extends RuntimeProvisioner {
  constructor(options = {}) {
    super(options);
    this._runCommand = typeof options.runCommand === 'function' ? options.runCommand : run;
    this._ensureProxy = typeof options.ensureProxy === 'function' ? options.ensureProxy : ensureWindowsWslDockerProxy;
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

    const distroList = await this.#wslList();
    const wslUsable = this.#wslListShowsUsableFeatures(distroList);
    const wslFeature = await this.#optionalFeatureState('Microsoft-Windows-Subsystem-Linux');
    const vmPlatform = await this.#optionalFeatureState('VirtualMachinePlatform');
    if (!wslUsable && (wslFeature !== 'Enabled' || vmPlatform !== 'Enabled')) {
      return {
        state: 'manual_install',
        detail: 'Docker Desktop is not supported on Windows Server. Enable WSL2 with wsl.exe --install --no-distribution, restart Windows, then provide a Linux-container Docker Engine endpoint.',
        manualCommand: 'wsl.exe --install --no-distribution',
        manualUrl: WSL_GUIDE_URL
      };
    }

    if (/WSL_E_DEFAULT_DISTRO_NOT_FOUND|has no installed distributions|no installed distributions|non ha distribuzioni installate/i.test(distroList)) {
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

  async provision(options = {}) {
    const assessment = await this.assess();
    if (assessment?.mode === 'wsl_feature' && assessment.state === 'not_provisioned') {
      return await this.#installWslFeatures(options);
    }
    if (assessment?.mode === 'wsl_distribution' && assessment.state === 'not_provisioned') {
      return await this.#installWslDistribution(options);
    }
    if (assessment?.mode === 'wsl_engine' && assessment.state === 'not_provisioned') {
      await this.#installAndStartWslDocker(assessment.distro, options);
      return;
    }
    if (assessment?.mode === 'wsl_bridge_dependency' && assessment.state === 'not_provisioned') {
      await this.#installWslBridgeDependencies(assessment.distro, options);
      await this.#configureAndStartWslDocker(assessment.distro);
      await this._ensureProxy({ distro: assessment.distro });
      return;
    }
    if (assessment?.mode === 'wsl_engine' && assessment.state === 'engine_stopped') {
      options.onProgress?.('Starting WSL Docker Engine');
      await this.#configureAndStartWslDocker(assessment.distro);
      await this._ensureProxy({ distro: assessment.distro });
      return;
    }
    if (assessment?.mode === 'docker_desktop' && assessment.state === 'engine_stopped') {
      options.onProgress?.('Starting Docker Desktop');
      await this.#startDockerDesktop();
      return;
    }
    throw makeError('RUNTIME_UNSUPPORTED', assessment.detail, this.#manualDetails(assessment));
  }

  async start(options = {}) {
    const assessment = await this.assess();
    if (assessment?.mode === 'wsl_engine') {
      options.onProgress?.('Starting WSL Docker Engine');
      await this.#configureAndStartWslDocker(assessment.distro);
      await this._ensureProxy({ distro: assessment.distro });
      return;
    }
    if (assessment?.mode === 'docker_desktop') {
      options.onProgress?.('Starting Docker Desktop');
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
      return this.#wslFeatureSetupAssessment('Set up the local Agent Zero runtime. Windows may ask for approval and may require a restart.');
    }

    const distroList = await this.#wslList();
    const distros = this.#parseWslDistros(distroList);
    const distro = this.#selectWslDistro(distros);
    if (!distro) {
      const wslUsable = this.#wslListShowsUsableFeatures(distroList);
      const wslFeature = await this.#optionalFeatureState('Microsoft-Windows-Subsystem-Linux');
      const vmPlatform = await this.#optionalFeatureState('VirtualMachinePlatform');
      if (!wslUsable && (wslFeature !== 'Enabled' || vmPlatform !== 'Enabled')) {
        if (dockerDesktopInstalled) return this.#dockerDesktopStoppedAssessment();
        return this.#wslFeatureSetupAssessment('Set up the local Agent Zero runtime. Windows may ask for approval and may require a restart.');
      }
      if (dockerDesktopInstalled) return this.#dockerDesktopStoppedAssessment();
      return {
        state: 'not_provisioned',
        mode: 'wsl_distribution',
        detail: 'Finish setting up the local Agent Zero runtime.',
        manualCommand: `wsl.exe --install -d ${DEFAULT_WSL_DISTRO} --no-launch`,
        manualUrl: WSL_INSTALL_URL,
        setupActionLabel: 'Set Up Agent Zero'
      };
    }

    const hasDocker = await this.#wslCommandOk(distro.name, 'command -v docker >/dev/null 2>&1');
    const hasDockerd = await this.#wslCommandOk(distro.name, 'command -v dockerd >/dev/null 2>&1');
    if (!hasDocker || !hasDockerd) {
      if (dockerDesktopInstalled) return this.#dockerDesktopStoppedAssessment();
      return {
        state: 'not_provisioned',
        mode: 'wsl_engine',
        distro: distro.name,
        detail: 'Finish setting up the local Agent Zero runtime.',
        manualUrl: DOCKER_ENGINE_UBUNTU_URL,
        setupActionLabel: 'Set Up Agent Zero'
      };
    }

    const hasPython = await this.#wslCommandOk(distro.name, 'command -v python3 >/dev/null 2>&1');
    if (!hasPython) {
      return {
        state: 'not_provisioned',
        mode: 'wsl_bridge_dependency',
        distro: distro.name,
        detail: 'Finish setting up the local Agent Zero runtime.',
        manualCommand: 'sudo apt-get update && sudo apt-get install -y python3',
        manualUrl: DOCKER_ENGINE_UBUNTU_URL,
        setupActionLabel: 'Set Up Agent Zero'
      };
    }

    const dockerReady = await this.#wslRootCommandOk(distro.name, 'docker info >/dev/null 2>&1');
    if (dockerReady) {
      return {
        state: 'engine_stopped',
        mode: 'wsl_engine',
        distro: distro.name,
        detail: 'Agent Zero local runtime is ready to start.'
      };
    }

    return {
      state: 'engine_stopped',
      mode: 'wsl_engine',
      distro: distro.name,
      detail: 'Agent Zero local runtime is installed but needs to be started.'
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

  #wslFeatureSetupAssessment(detail) {
    return {
      state: 'not_provisioned',
      mode: 'wsl_feature',
      detail,
      manualCommand: 'wsl.exe --install --no-distribution',
      manualUrl: WSL_INSTALL_URL,
      requiresAdmin: true,
      requiresRestart: true,
      setupActionLabel: 'Set Up Agent Zero'
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

  #parseWslDistros(text) {
    const distros = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || /^NAME\s+STATE\s+VERSION$/i.test(line)) continue;
      if (/^(default\s+(distribution|version)|distribuzione\s+predefinita|versione\s+predefinita)\s*:/i.test(line)) continue;
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

  async #wslDistros() {
    return this.#parseWslDistros(await this.#wslList());
  }

  #wslListShowsUsableFeatures(text) {
    const value = String(text || '');
    if (/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED/i.test(value)) return false;
    if (/WSL_E_DEFAULT_DISTRO_NOT_FOUND/i.test(value)) return true;
    if (/has no installed distributions|no installed distributions/i.test(value)) return true;
    if (/non ha distribuzioni installate/i.test(value)) return true;
    if (/^\s*\*?\s*NAME\s+STATE\s+VERSION\b/im.test(value)) return true;
    return false;
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

  async #wslRootCommandOk(distro, script) {
    const result = await this.#wslRootSh(distro, script, { timeoutMs: 15000 }).catch(() => ({ code: 1 }));
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
    const result = await this.#wslRootSh(distro, script, { timeoutMs: 120000 });
    if (result.code !== 0) {
      throw makeError('RUNTIME_START_FAILED', 'Could not start Docker Engine inside WSL.', {
        distro,
        exitCode: result.code,
        stdout: cleanCommandText(result.stdout),
        stderr: cleanCommandText(result.stderr)
      });
    }
  }

  async #installWslFeatures(options = {}) {
    options.onProgress?.('Requesting Windows approval');
    const script = [
      '$ErrorActionPreference = "Stop"',
      'wsl.exe --install --no-distribution',
      'if ($LASTEXITCODE -ne 0) { wsl.exe --install --no-distribution --web-download }',
      'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      'wsl.exe --set-default-version 2',
      'exit $LASTEXITCODE'
    ].join('\n');
    await this.#runElevatedPowerShell(script, {
      timeoutMs: options.timeoutMs || 20 * 60 * 1000,
      signal: options.signal
    });
    return {
      state: 'needs_followup',
      detail: 'Agent Zero setup was started. Restart Windows if prompted, then return here to continue.'
    };
  }

  async #installWslDistribution(options = {}) {
    options.onProgress?.(`Installing ${DEFAULT_WSL_DISTRO}`);
    let result = await this._runCommand(
      'wsl.exe',
      ['--install', '-d', DEFAULT_WSL_DISTRO, '--no-launch'],
      { timeoutMs: options.timeoutMs || 20 * 60 * 1000, signal: options.signal }
    );
    if (result.code !== 0) {
      result = await this._runCommand(
        'wsl.exe',
        ['--install', '-d', DEFAULT_WSL_DISTRO, '--no-launch', '--web-download'],
        { timeoutMs: options.timeoutMs || 20 * 60 * 1000, signal: options.signal }
      );
    }
    if (result.code !== 0) {
      throw makeError('RUNTIME_PROVISION_FAILED', `Could not install ${DEFAULT_WSL_DISTRO} for WSL.`, {
        exitCode: result.code,
        stdout: cleanCommandText(result.stdout),
        stderr: cleanCommandText(result.stderr)
      });
    }
    let distroReady = await this.#wslRootCommandOk(DEFAULT_WSL_DISTRO, 'true');
    if (!distroReady && await this.#registerUbuntuPackageAsRoot(options)) {
      distroReady = await this.#wslRootCommandOk(DEFAULT_WSL_DISTRO, 'true');
    }
    if (!distroReady) {
      return {
        state: 'needs_followup',
        detail: 'Agent Zero setup was started. If Windows asks for a restart or a first-run setup window opens, complete that and return here.'
      };
    }
    await this.#installAndStartWslDocker(DEFAULT_WSL_DISTRO, options);
    return;
  }

  async #registerUbuntuPackageAsRoot(options = {}) {
    const launcher = await this.#ubuntuLauncherBinary();
    if (!launcher) return false;
    options.onProgress?.(`Preparing ${DEFAULT_WSL_DISTRO}`);
    const result = await this._runCommand(
      launcher,
      ['install', '--root'],
      { timeoutMs: Math.min(options.timeoutMs || 5 * 60 * 1000, 5 * 60 * 1000), signal: options.signal }
    ).catch((error) => ({
      code: -1,
      stdout: '',
      stderr: error?.message || String(error)
    }));
    if (result.code === 0) return true;
    const output = cleanCommandText(`${result.stdout || ''}\n${result.stderr || ''}`);
    return /already installed|gi[aà]\s+installato/i.test(output);
  }

  async #ubuntuLauncherBinary() {
    for (const binary of ['ubuntu.exe', 'ubuntu2404.exe', 'ubuntu2204.exe', 'ubuntu2004.exe']) {
      if (await this.#binaryExists(binary)) return binary;
    }
    return '';
  }

  async #installAndStartWslDocker(distro, options = {}) {
    options.onProgress?.('Installing Docker Engine');
    await this.#installDockerEngineInWsl(distro, options);
    options.onProgress?.('Starting WSL Docker Engine');
    await this.#configureAndStartWslDocker(distro);
    await this._ensureProxy({ distro });
  }

  async #installDockerEngineInWsl(distro, options = {}) {
    const script = [
      'set -eu',
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update',
      'apt-get install -y ca-certificates curl python3',
      'for pkg in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do apt-get remove -y "$pkg" >/dev/null 2>&1 || true; done',
      'install -m 0755 -d /etc/apt/keyrings',
      'curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc',
      'chmod a+r /etc/apt/keyrings/docker.asc',
      '. /etc/os-release',
      'codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"',
      'if [ -z "$codename" ]; then echo "Could not determine Ubuntu codename" >&2; exit 1; fi',
      'arch="$(dpkg --print-architecture)"',
      'cat > /etc/apt/sources.list.d/docker.sources <<EOF',
      'Types: deb',
      'URIs: https://download.docker.com/linux/ubuntu',
      'Suites: ${codename}',
      'Components: stable',
      'Architectures: ${arch}',
      'Signed-By: /etc/apt/keyrings/docker.asc',
      'EOF',
      'apt-get update',
      'apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin'
    ].join('\n');
    const result = await this.#wslRootSh(distro, script, {
      timeoutMs: options.timeoutMs || 20 * 60 * 1000,
      signal: options.signal
    });
    if (result.code !== 0) {
      throw makeError('RUNTIME_PROVISION_FAILED', 'Could not install Docker Engine inside WSL.', {
        distro,
        exitCode: result.code,
        stdout: cleanCommandText(result.stdout),
        stderr: cleanCommandText(result.stderr)
      });
    }
  }

  async #installWslBridgeDependencies(distro, options = {}) {
    options.onProgress?.('Installing bridge dependency');
    const result = await this.#wslRootSh(distro, 'set -eu\nexport DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get install -y python3', {
      timeoutMs: options.timeoutMs || 10 * 60 * 1000,
      signal: options.signal
    });
    if (result.code !== 0) {
      throw makeError('RUNTIME_PROVISION_FAILED', 'Could not install WSL bridge dependencies.', {
        distro,
        exitCode: result.code,
        stdout: cleanCommandText(result.stdout),
        stderr: cleanCommandText(result.stderr)
      });
    }
    return {
      state: 'needs_followup',
      detail: 'Agent Zero setup is almost done. Continue setup to start the local runtime.'
    };
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

  async #runElevatedPowerShell(script, options = {}) {
    const encodedCommand = Buffer.from(String(script || ''), 'utf16le').toString('base64');
    const launcher = [
      '$ErrorActionPreference = "Stop"',
      `$argsList = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${encodedCommand}')`,
      '$p = Start-Process -FilePath "powershell.exe" -ArgumentList $argsList -Verb RunAs -WindowStyle Hidden -Wait -PassThru',
      'if ($null -ne $p.ExitCode) { exit $p.ExitCode }'
    ].join('; ');
    const result = await this.#powershell(launcher, {
      timeoutMs: options.timeoutMs || 20 * 60 * 1000,
      signal: options.signal
    });
    if (result.code !== 0) {
      throw makeError('RUNTIME_PROVISION_FAILED', 'Windows WSL setup did not complete.', {
        exitCode: result.code,
        stdout: cleanCommandText(result.stdout),
        stderr: cleanCommandText(result.stderr)
      });
    }
  }

  async #wslSh(distro, script, options = {}) {
    const args = [];
    const selected = String(distro || '').trim();
    if (selected) args.push('-d', selected);
    args.push('--exec', 'sh', '-lc', script);
    return await this._runCommand('wsl.exe', args, { timeoutMs: options.timeoutMs || 15000, signal: options.signal });
  }

  async #wslRootSh(distro, script, options = {}) {
    const args = [];
    const selected = String(distro || '').trim();
    if (selected) args.push('-d', selected);
    args.push('-u', 'root', '--exec', 'sh', '-lc', script);
    return await this._runCommand('wsl.exe', args, { timeoutMs: options.timeoutMs || 120000, signal: options.signal });
  }

  #manualDetails(assessment) {
    return {
      manualUrl: assessment?.manualUrl,
      manualCommand: assessment?.manualCommand,
      distro: assessment?.distro
    };
  }

  async #powershell(script, options = {}) {
    return await this._runCommand(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: options.timeoutMs || 15000, signal: options.signal }
    );
  }
}

export const WINDOWS_WSL_GUIDE_URL = WSL_GUIDE_URL;
export const WINDOWS_DOCKER_DESKTOP_URL = DOCKER_DESKTOP_URL;

function cleanCommandText(value) {
  return String(value || '').replace(/\0/g, '');
}
