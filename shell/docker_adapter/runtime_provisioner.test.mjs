import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir as mkdirp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DockerInterface } from './DockerInterface.mjs';
import { RuntimeProvisioner } from './RuntimeProvisioner.mjs';
import { ColimaRuntime, selectLatestDockerCliAsset } from './impl/ColimaRuntime.mjs';
import { LinuxEngineRuntime } from './impl/LinuxEngineRuntime.mjs';
import { ensureWindowsWslKeepAlive, stopWindowsWslKeepAlive } from './impl/WindowsWslDockerProxy.mjs';
import { WindowsWslRuntime } from './impl/WindowsWslRuntime.mjs';

test('RuntimeProvisioner.forPlatform selects runtime implementations by platform', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const macRuntime = await RuntimeProvisioner.forPlatform({ managedDir, platform: 'darwin' });
    const linuxRuntime = await RuntimeProvisioner.forPlatform({ managedDir, platform: 'linux' });
    const windowsRuntime = await RuntimeProvisioner.forPlatform({ managedDir, platform: 'win32' });
    const unsupportedRuntime = await RuntimeProvisioner.forPlatform({ managedDir, platform: 'freebsd' });

    assert.ok(macRuntime instanceof ColimaRuntime);
    assert.ok(linuxRuntime instanceof LinuxEngineRuntime);
    assert.ok(windowsRuntime instanceof WindowsWslRuntime);
    assert.equal(unsupportedRuntime, null);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('ColimaRuntime assess asks to start installed Docker Desktop before setup', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const dockerApp = path.join(managedDir, 'Docker.app');
    await mkdirp(dockerApp);
    const runtime = new ColimaRuntime({
      managedDir,
      dockerDesktopAppPaths: [dockerApp],
      runCommand: async () => ({ code: 1, stdout: '', stderr: '' })
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'engine_stopped');
    assert.equal(assessment.mode, 'docker_desktop');
    assert.match(assessment.detail, /Start Docker Desktop/i);
    assert.equal(assessment.manualUrl, undefined);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('WindowsWslRuntime assess directs Windows clients without WSL to runtime install guidance', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const runtime = new WindowsWslRuntime({
      managedDir,
      isWindowsServer: false,
      runCommand: fakeWindowsCommandRunner()
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'not_provisioned');
    assert.equal(assessment.mode, 'wsl_feature');
    assert.equal(assessment.requiresAdmin, true);
    assert.equal(assessment.requiresRestart, true);
    assert.equal(assessment.setupActionLabel, 'Setup Agent Zero');
    assert.match(assessment.detail, /Agent Zero runtime/i);
    assert.match(assessment.manualCommand, /wsl\.exe --install --no-distribution/i);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('WindowsWslRuntime assess detects installed Docker Desktop on Windows clients', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const runtime = new WindowsWslRuntime({
      managedDir,
      isWindowsServer: false,
      runCommand: fakeWindowsCommandRunner({
        dockerDesktopPath: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'
      })
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'engine_stopped');
    assert.equal(assessment.mode, 'docker_desktop');
    assert.match(assessment.detail, /Docker Desktop is installed/i);
    assert.match(assessment.detail, /Start Docker Desktop/i);
    assert.equal(assessment.manualUrl, undefined);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('WindowsWslRuntime assess detects Docker Desktop when WSL2 is incomplete', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const runtime = new WindowsWslRuntime({
      managedDir,
      isWindowsServer: false,
      runCommand: fakeWindowsCommandRunner({
        binaries: ['wsl.exe'],
        dockerDesktopPath: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
        features: {
          'Microsoft-Windows-Subsystem-Linux': 'Enabled',
          VirtualMachinePlatform: 'Disabled'
        }
      })
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'engine_stopped');
    assert.equal(assessment.mode, 'docker_desktop');
    assert.match(assessment.detail, /Docker Desktop is installed/i);
    assert.match(assessment.detail, /Start Docker Desktop/i);
    assert.equal(assessment.manualUrl, undefined);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('WindowsWslRuntime provision requests UAC for WSL feature setup', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  const calls = [];
  const progress = [];
  try {
    const runtime = new WindowsWslRuntime({
      managedDir,
      isWindowsServer: false,
      runCommand: fakeWindowsCommandRunner({ calls })
    });

    const result = await runtime.provision({ onProgress: (message) => progress.push(message) });

    assert.equal(result.state, 'needs_followup');
    assert.match(result.detail, /Restart Windows/i);
    assert.ok(progress.includes('Requesting Windows approval'));
    const elevated = calls.find((call) => call.cmd === 'powershell.exe' && /Start-Process/.test(String(call.args.at(-1))));
    assert.ok(elevated, 'expected an elevated PowerShell launcher');
    assert.match(String(elevated.args.at(-1)), /-Verb RunAs/);
    assert.match(String(elevated.args.at(-1)), /-WindowStyle Hidden/);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('WindowsWslRuntime provision installs Ubuntu when WSL2 has no distro', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  const calls = [];
  const proxyCalls = [];
  try {
    const runtime = new WindowsWslRuntime({
      managedDir,
      isWindowsServer: false,
      ensureProxy: async (options) => {
        proxyCalls.push(options);
      },
      runCommand: fakeWindowsCommandRunner({
        binaries: ['wsl.exe'],
        calls,
        wslRootReady: true,
        features: {
          'Microsoft-Windows-Subsystem-Linux': 'Enabled',
          VirtualMachinePlatform: 'Enabled'
        },
        wslList: '  NAME      STATE           VERSION\n'
      })
    });

    const assessment = await runtime.assess();
    assert.equal(assessment.state, 'not_provisioned');
    assert.equal(assessment.mode, 'wsl_distribution');
    assert.equal(assessment.setupActionLabel, 'Setup Agent Zero');

    const result = await runtime.provision();

    assert.equal(result, undefined);
    const install = calls.find((call) => call.cmd === 'wsl.exe' && call.args?.[0] === '--install');
    assert.deepEqual(install?.args, ['--install', '-d', 'Ubuntu', '--no-launch']);
    assert.ok(calls.some((call) => call.cmd === 'wsl.exe' && /docker-ce docker-ce-cli containerd\.io/.test(String(call.args?.at(-1)))));
    assert.deepEqual(proxyCalls, [{ distro: 'Ubuntu' }]);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('WindowsWslRuntime resumes to distro setup after WSL feature reboot', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const runtime = new WindowsWslRuntime({
      managedDir,
      isWindowsServer: false,
      runCommand: fakeWindowsCommandRunner({
        binaries: ['wsl.exe'],
        wslList: [
          'Default Version: 2',
          'Windows Subsystem for Linux has no installed distributions.',
          'Error code: Wsl/WSL_E_DEFAULT_DISTRO_NOT_FOUND'
        ].join('\n')
      })
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'not_provisioned');
    assert.equal(assessment.mode, 'wsl_distribution');
    assert.equal(assessment.setupActionLabel, 'Setup Agent Zero');
    assert.match(assessment.manualCommand, /wsl\.exe --install -d Ubuntu --no-launch/i);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('WindowsWslRuntime registers installed Ubuntu package as root when WSL install leaves no distro', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  const calls = [];
  const proxyCalls = [];
  try {
    const runtime = new WindowsWslRuntime({
      managedDir,
      isWindowsServer: false,
      ensureProxy: async (options) => {
        proxyCalls.push(options);
      },
      runCommand: fakeWindowsCommandRunner({
        binaries: ['wsl.exe', 'ubuntu.exe'],
        calls,
        features: {
          'Microsoft-Windows-Subsystem-Linux': 'Enabled',
          VirtualMachinePlatform: 'Enabled'
        },
        wslList: 'Windows Subsystem for Linux has no installed distributions.',
        wslRootReady: false,
        ubuntuInstallRootRegisters: true
      })
    });

    await runtime.provision();

    assert.ok(calls.some((call) => call.cmd === 'ubuntu.exe' && call.args?.[0] === 'install' && call.args?.[1] === '--root'));
    assert.ok(calls.some((call) => call.cmd === 'wsl.exe' && /docker-ce docker-ce-cli containerd\.io/.test(String(call.args?.at(-1)))));
    assert.deepEqual(proxyCalls, [{ distro: 'Ubuntu' }]);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('WindowsWslRuntime provision installs Docker Engine inside an existing WSL distro', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  const calls = [];
  const progress = [];
  const proxyCalls = [];
  try {
    const runtime = new WindowsWslRuntime({
      managedDir,
      isWindowsServer: false,
      ensureProxy: async (options) => {
        proxyCalls.push(options);
      },
      runCommand: fakeWindowsCommandRunner({
        binaries: ['wsl.exe'],
        calls,
        features: {
          'Microsoft-Windows-Subsystem-Linux': 'Enabled',
          VirtualMachinePlatform: 'Enabled'
        },
        wslList: '  NAME      STATE           VERSION\n* Ubuntu    Running         2\n',
        wslDockerInstalled: false,
        wslRootReady: true
      })
    });

    const assessment = await runtime.assess();
    assert.equal(assessment.state, 'not_provisioned');
    assert.equal(assessment.mode, 'wsl_engine');
    assert.equal(assessment.setupActionLabel, 'Setup Agent Zero');

    await runtime.provision({ onProgress: (message) => progress.push(message) });

    assert.deepEqual(progress, ['Installing Docker Engine', 'Starting WSL Docker Engine', 'Starting local Docker bridge']);
    const dockerInstall = calls.find((call) => call.cmd === 'wsl.exe' && /docker-ce docker-ce-cli containerd\.io/.test(String(call.args?.at(-1))));
    assert.ok(dockerInstall, 'expected Docker Engine install script');
    assert.match(String(dockerInstall.args.at(-1)), /download\.docker\.com\/linux\/ubuntu/);
    assert.match(String(dockerInstall.args.at(-1)), /apt-get install -y ca-certificates curl python3/);
    assert.deepEqual(proxyCalls, [{ distro: 'Ubuntu' }]);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('WindowsWslRuntime assess detects WSL Docker Engine on Windows clients', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const runtime = new WindowsWslRuntime({
      managedDir,
      isWindowsServer: false,
      runCommand: fakeWindowsCommandRunner({
        binaries: ['wsl.exe'],
        features: {
          'Microsoft-Windows-Subsystem-Linux': 'Enabled',
          VirtualMachinePlatform: 'Enabled'
        },
        wslList: '  NAME      STATE           VERSION\n* Ubuntu    Running         2\n',
        wslDockerInstalled: true,
        wslDockerReady: true
      })
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'engine_stopped');
    assert.equal(assessment.mode, 'wsl_engine');
    assert.equal(assessment.distro, 'Ubuntu');
    assert.match(assessment.detail, /Agent Zero local runtime/i);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('WindowsWslRuntime assess explains WSL setup on Windows Server without features', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const runtime = new WindowsWslRuntime({
      managedDir,
      isWindowsServer: true,
      runCommand: fakeWindowsCommandRunner({
        binaries: ['wsl.exe'],
        features: {
          'Microsoft-Windows-Subsystem-Linux': 'Disabled',
          VirtualMachinePlatform: 'Disabled'
        }
      })
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'manual_install');
    assert.match(assessment.detail, /Docker Desktop is not supported on Windows Server/i);
    assert.match(assessment.detail, /wsl\.exe --install --no-distribution/i);
    assert.match(assessment.manualCommand, /wsl\.exe --install --no-distribution/i);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('WindowsWslRuntime assess calls out nested virtualization when WSL has no distro', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const runtime = new WindowsWslRuntime({
      managedDir,
      isWindowsServer: true,
      runCommand: fakeWindowsCommandRunner({
        binaries: ['wsl.exe'],
        features: {
          'Microsoft-Windows-Subsystem-Linux': 'Enabled',
          VirtualMachinePlatform: 'Enabled'
        },
        wslList: 'Windows Subsystem for Linux has no installed distributions.'
      })
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'manual_install');
    assert.match(assessment.detail, /nested virtualization/i);
    assert.match(assessment.manualUrl, /learn\.microsoft\.com/);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('DockerInterface classifies Windows npipe and loopback WSL endpoints', async () => {
  const dockerDesktop = await DockerInterface.detectEnvironment({
    dockerHost: 'npipe:////./pipe/docker_engine',
    timeoutMs: 250,
    enableWindowsWslProxy: false,
    discoverDockerContexts: false,
    candidateHosts: [],
    dockerodeClass: fakeDockerodeClass()
  });
  assert.equal(dockerDesktop.dockerHost.kind, 'npipe');
  assert.equal(dockerDesktop.dockerHost.socketPath, '//./pipe/docker_engine');
  assert.equal(dockerDesktop.dockerFlavor, 'docker_desktop');

  const wslEngine = await DockerInterface.detectEnvironment({
    dockerHost: 'tcp://127.0.0.1:23750',
    timeoutMs: 250,
    enableWindowsWslProxy: false,
    discoverDockerContexts: false,
    candidateHosts: [],
    dockerodeClass: fakeDockerodeClass()
  });
  assert.equal(wslEngine.dockerHost.kind, 'tcp');
  assert.equal(wslEngine.dockerHost.host, '127.0.0.1');
  assert.equal(wslEngine.dockerHost.port, 23750);
  assert.equal(wslEngine.dockerFlavor, 'wsl_engine');
});

test('DockerInterface prepares the built-in Windows WSL endpoint before probing', async () => {
  const preparedHosts = [];
  let prepared = false;
  class FakeDockerode {
    constructor(options = {}) {
      this.options = options;
    }

    async ping() {
      const tcpHost = this.options.host ? `${this.options.host}:${this.options.port || 2375}` : '';
      if (prepared && tcpHost === '127.0.0.1:23750') return true;
      const error = new Error('Docker endpoint is not reachable');
      error.code = 'ECONNREFUSED';
      throw error;
    }

    async version() {
      return { Version: 'test' };
    }
  }

  const env = await DockerInterface.detectEnvironment({
    platform: 'win32',
    timeoutMs: 250,
    discoverDockerContexts: false,
    candidateHosts: [
      { provider: 'wsl_engine', label: 'Agent Zero local runtime', dockerHost: 'tcp://127.0.0.1:23750', source: 'known_socket' }
    ],
    prepareDockerHost: async (hostInfo) => {
      prepared = true;
      preparedHosts.push(hostInfo.raw);
    },
    dockerodeClass: FakeDockerode
  });

  assert.deepEqual(preparedHosts, ['tcp://127.0.0.1:23750']);
  assert.equal(env.dockerAvailable, true);
  assert.equal(env.dockerFlavor, 'wsl_engine');
  assert.equal(env.runtimeCandidates[0].available, true);
});

test('DockerInterface does not prepare the built-in Windows WSL endpoint when another runtime is reachable', async () => {
  const preparedHosts = [];
  const env = await DockerInterface.detectEnvironment({
    platform: 'win32',
    timeoutMs: 250,
    discoverDockerContexts: false,
    candidateHosts: [
      { provider: 'docker_desktop', label: 'Docker Desktop', dockerHost: 'npipe:////./pipe/docker_engine', source: 'known_socket' },
      { provider: 'wsl_engine', label: 'Agent Zero local runtime', dockerHost: 'tcp://127.0.0.1:23750', source: 'known_socket' }
    ],
    prepareDockerHost: async (hostInfo) => {
      preparedHosts.push(hostInfo.raw);
    },
    dockerodeClass: fakeDockerodeClass(['//./pipe/docker_engine'])
  });

  assert.deepEqual(preparedHosts, []);
  assert.equal(env.dockerAvailable, true);
  assert.equal(env.dockerFlavor, 'docker_desktop');
});

test('DockerInterface selects a single available native endpoint without extra choices', async () => {
  const env = await DockerInterface.detectEnvironment({
    platform: 'linux',
    homeDir: '/home/a0',
    runtimeDir: '/run/user/1000',
    discoverDockerContexts: false,
    candidateHosts: [
      { provider: 'docker_engine', label: 'Docker Engine', dockerHost: 'unix:///var/run/docker.sock' }
    ],
    dockerodeClass: fakeDockerodeClass(['/var/run/docker.sock'])
  });

  assert.equal(env.dockerAvailable, true);
  assert.equal(env.dockerHost.socketPath, '/var/run/docker.sock');
  assert.equal(env.runtimeCandidates.length, 1);
  assert.equal(env.runtimeCandidates[0].available, true);
  assert.equal(env.runtimeCandidates[0].isSelected, true);
});

test('DockerInterface dedupes endpoints and selects the highest-priority reachable runtime', async () => {
  const env = await DockerInterface.detectEnvironment({
    platform: 'darwin',
    homeDir: '/Users/a0',
    discoverDockerContexts: false,
    candidateHosts: [
      { provider: 'orbstack', label: 'OrbStack', dockerHost: 'unix:///Users/a0/.orbstack/run/docker.sock', priority: 50 },
      { provider: 'orbstack', label: 'OrbStack duplicate', dockerHost: 'unix:///Users/a0/.orbstack/run/docker.sock', priority: 70 },
      { provider: 'rancher_desktop', label: 'Rancher Desktop', dockerHost: 'unix:///Users/a0/.rd/docker.sock', priority: 60 }
    ],
    dockerodeClass: fakeDockerodeClass([
      '/Users/a0/.orbstack/run/docker.sock',
      '/Users/a0/.rd/docker.sock'
    ])
  });

  assert.equal(env.dockerAvailable, true);
  assert.equal(env.dockerFlavor, 'orbstack');
  assert.equal(env.runtimeCandidates.length, 2);
  assert.deepEqual(env.runtimeCandidates.filter((candidate) => candidate.available).map((candidate) => candidate.label), [
    'OrbStack',
    'Rancher Desktop'
  ]);
  assert.equal(env.runtimeCandidates.find((candidate) => candidate.label === 'OrbStack')?.isSelected, true);
});

test('DockerInterface falls back when a persisted runtime endpoint is stale', async () => {
  const env = await DockerInterface.detectEnvironment({
    platform: 'linux',
    runtimePreference: {
      id: 'runtime-stale',
      label: 'Old runtime',
      provider: 'docker_engine',
      dockerHost: 'unix:///tmp/missing-docker.sock'
    },
    discoverDockerContexts: false,
    candidateHosts: [
      { provider: 'docker_engine', label: 'Docker Engine', dockerHost: 'unix:///var/run/docker.sock' }
    ],
    dockerodeClass: fakeDockerodeClass(['/var/run/docker.sock'])
  });

  assert.equal(env.dockerAvailable, true);
  assert.equal(env.dockerHost.socketPath, '/var/run/docker.sock');
  assert.equal(env.runtimeCandidates.find((candidate) => candidate.id === 'runtime-stale')?.available, false);
  assert.equal(env.runtimeCandidates.find((candidate) => candidate.label === 'Docker Engine')?.isSelected, true);
});

test('DockerInterface parses Docker context endpoints into provider-labeled candidates', async () => {
  const env = await DockerInterface.detectEnvironment({
    platform: 'darwin',
    homeDir: '/Users/a0',
    candidateHosts: [],
    dockerContexts: [
      {
        Name: 'orbstack',
        Current: true,
        Endpoints: { docker: { Host: 'unix:///Users/a0/.orbstack/run/docker.sock' } }
      },
      {
        Name: 'rancher-desktop',
        Endpoints: { docker: { Host: 'unix:///Users/a0/.rd/docker.sock' } }
      }
    ],
    dockerodeClass: fakeDockerodeClass(['/Users/a0/.orbstack/run/docker.sock'])
  });

  assert.equal(env.dockerAvailable, true);
  assert.deepEqual(env.runtimeCandidates.map((candidate) => candidate.provider), ['orbstack', 'rancher_desktop']);
  assert.equal(env.runtimeCandidates[0].label, 'orbstack (current)');
  assert.equal(env.runtimeCandidates[0].isSelected, true);
  assert.equal(env.runtimeCandidates[1].available, false);
});

test('DockerInterface only accepts Podman when its Docker-compatible API responds', async () => {
  const unavailable = await DockerInterface.detectEnvironment({
    platform: 'linux',
    runtimeDir: '/run/user/1000',
    discoverDockerContexts: false,
    candidateHosts: [
      { provider: 'podman', label: 'Podman', dockerHost: 'unix:///run/user/1000/podman/podman.sock' }
    ],
    dockerodeClass: fakeDockerodeClass()
  });

  assert.equal(unavailable.dockerAvailable, false);
  assert.equal(unavailable.runtimeCandidates[0].provider, 'podman');
  assert.equal(unavailable.runtimeCandidates[0].available, false);

  const available = await DockerInterface.detectEnvironment({
    platform: 'linux',
    runtimeDir: '/run/user/1000',
    discoverDockerContexts: false,
    candidateHosts: [
      { provider: 'podman', label: 'Podman', dockerHost: 'unix:///run/user/1000/podman/podman.sock' }
    ],
    dockerodeClass: fakeDockerodeClass(['/run/user/1000/podman/podman.sock'])
  });

  assert.equal(available.dockerAvailable, true);
  assert.equal(available.dockerFlavor, 'podman');
  assert.equal(available.runtimeCandidates[0].isSelected, true);
});

test('WindowsWslDockerProxy keepalive holds the selected WSL distro open', { skip: process.platform !== 'win32' }, () => {
  stopWindowsWslKeepAlive();
  const calls = [];
  const child = new FakeChildProcess();
  const spawnCommand = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return child;
  };

  try {
    const first = ensureWindowsWslKeepAlive({ distro: 'Ubuntu', spawnCommand });
    const second = ensureWindowsWslKeepAlive({ distro: 'Ubuntu', spawnCommand });

    assert.deepEqual(first, { started: true, reused: false, distro: 'Ubuntu' });
    assert.deepEqual(second, { started: true, reused: true, distro: 'Ubuntu' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'wsl.exe');
    assert.deepEqual(calls[0].args.slice(0, 2), ['-d', 'Ubuntu']);
    assert.ok(calls[0].args.includes('-u'));
    assert.ok(calls[0].args.includes('root'));
    assert.ok(calls[0].args.includes('--exec'));
    assert.ok(calls[0].args.includes('sh'));
    assert.match(calls[0].args.at(-2), /sleep 2147483647/);
    assert.match(calls[0].args.at(-2), /kill "\$sleep_pid"/);
    assert.equal(calls[0].args.at(-1), 'a0-launcher-wsl-keepalive');
    assert.deepEqual(calls[0].options.stdio, 'ignore');
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(child.unrefCalled, true);
  } finally {
    stopWindowsWslKeepAlive();
  }

  assert.equal(child.killed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cmd, 'wsl.exe');
  assert.deepEqual(calls[1].args.slice(0, 2), ['-d', 'Ubuntu']);
  assert.match(calls[1].args.at(-1), /pkill -TERM/);
  assert.match(calls[1].args.at(-1), /a0-launcher-wsl-\[k\]eepalive/);
  assert.deepEqual(calls[1].options.stdio, 'ignore');
  assert.equal(calls[1].options.windowsHide, true);
  assert.equal(calls[1].options.detached, true);
});

function fakeDockerodeClass(availableSocketPaths = []) {
  const available = new Set(availableSocketPaths);
  return class FakeDockerode {
    constructor(options = {}) {
      this.options = options;
    }

    async ping() {
      const socketPath = this.options.socketPath || '';
      const tcpHost = this.options.host ? `${this.options.host}:${this.options.port || 2375}` : '';
      if (available.has(socketPath) || available.has(tcpHost)) return true;
      const error = new Error('Docker endpoint is not reachable');
      error.code = socketPath ? 'ENOENT' : 'ECONNREFUSED';
      throw error;
    }

    async version() {
      return { Version: 'test' };
    }
  };
}

test('selectLatestDockerCliAsset chooses the newest static macOS Docker CLI tarball', () => {
  const html = `
    <a href="docker-29.4.2.tgz">docker-29.4.2.tgz</a>
    <a href="docker-29.4.2-2.tgz">docker-29.4.2-2.tgz</a>
    <a href="docker-29.5.2.tgz">docker-29.5.2.tgz</a>
    <a href="docker-29.5.3.tgz">docker-29.5.3.tgz</a>
    <a href="notes.txt">notes.txt</a>
  `;

  assert.deepEqual(
    selectLatestDockerCliAsset('https://download.docker.com/mac/static/stable/aarch64/', html),
    {
      name: 'docker-29.5.3.tgz',
      version: '29.5.3',
      url: 'https://download.docker.com/mac/static/stable/aarch64/docker-29.5.3.tgz'
    }
  );
});

test('selectLatestDockerCliAsset returns null when the index has no Docker CLI tarballs', () => {
  assert.equal(
    selectLatestDockerCliAsset('https://download.docker.com/mac/static/stable/aarch64/', '<html></html>'),
    null
  );
});

test('LinuxEngineRuntime assess allows passwordless sudo when pkexec is absent', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const runtime = new LinuxEngineRuntime({
      managedDir,
      isRoot: false,
      runCommand: fakeLinuxCommandRunner({
        binaries: ['apt-get'],
        passwordlessSudo: true
      })
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'not_provisioned');
    assert.equal(assessment.packageManager, 'apt');
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('LinuxEngineRuntime assess requires manual install without pkexec or passwordless sudo', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const runtime = new LinuxEngineRuntime({
      managedDir,
      isRoot: false,
      username: 'a0user',
      runCommand: fakeLinuxCommandRunner({
        binaries: ['apt-get'],
        passwordlessSudo: false
      })
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'manual_install');
    assert.equal(assessment.packageManager, 'apt');
    assert.match(assessment.detail, /authentication dialog or passwordless sudo/i);
    assert.match(assessment.manualCommand, /apt-get update/);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('LinuxEngineRuntime provision composes install, start, and docker group access', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  const privilegedScripts = [];
  try {
    const runtime = new LinuxEngineRuntime({
      managedDir,
      isRoot: false,
      username: 'a0user',
      probeNativeSocket: async () => 'EACCES',
      runCommand: fakeLinuxCommandRunner({
        binaries: ['apt-get'],
        passwordlessSudo: true,
        privilegedScripts
      })
    });

    await assert.rejects(
      () => runtime.provision(),
      (error) => error?.code === 'RUNTIME_NEEDS_RELOGIN'
    );

    assert.equal(privilegedScripts.length, 1);
    assert.match(privilegedScripts[0], /apt-get update/);
    assert.match(privilegedScripts[0], /systemctl enable --now docker/);
    assert.doesNotMatch(privilegedScripts[0], /then exit 0/);
    assert.match(privilegedScripts[0], /usermod -aG docker 'a0user'/);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('LinuxEngineRuntime assess offers docker group repair when Docker is installed without access', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const runtime = new LinuxEngineRuntime({
      managedDir,
      isRoot: false,
      username: 'a0user',
      probeNativeSocket: async () => 'EACCES',
      runCommand: fakeLinuxCommandRunner({
        binaries: ['docker'],
        groups: ['a0user'],
        passwordlessSudo: true
      })
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'needs_group_membership');
    assert.match(assessment.detail, /needs Docker access/i);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

test('LinuxEngineRuntime assess reports relogin when docker group membership is already recorded', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const runtime = new LinuxEngineRuntime({
      managedDir,
      isRoot: false,
      username: 'a0user',
      probeNativeSocket: async () => 'EACCES',
      runCommand: fakeLinuxCommandRunner({
        binaries: ['docker'],
        groups: ['a0user', 'docker'],
        passwordlessSudo: true
      })
    });

    const assessment = await runtime.assess();

    assert.equal(assessment.state, 'needs_relogin');
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

function fakeLinuxCommandRunner({ binaries = [], groups = [], passwordlessSudo = false, privilegedScripts = [] } = {}) {
  const present = new Set(binaries);
  return async (cmd, args) => {
    if (cmd === 'sh' && args?.[0] === '-c') {
      const match = String(args[1] || '').match(/^command -v ([A-Za-z0-9_.-]+)$/);
      if (match) {
        const binary = match[1];
        return {
          code: present.has(binary) ? 0 : 1,
          stdout: present.has(binary) ? `/usr/bin/${binary}\n` : '',
          stderr: ''
        };
      }
    }
    if (cmd === 'sudo' && args?.[0] === '-n' && args?.[1] === 'true') {
      return { code: passwordlessSudo ? 0 : 1, stdout: '', stderr: '' };
    }
    if (cmd === 'sudo' && args?.[0] === '-n' && args?.[1] === 'sh' && args?.[2] === '-c') {
      privilegedScripts.push(String(args[3] || ''));
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'id' && args?.[0] === '-nG') {
      return { code: 0, stdout: `${groups.join(' ')}\n`, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
}

class FakeChildProcess extends EventEmitter {
  killed = false;
  unrefCalled = false;

  unref() {
    this.unrefCalled = true;
  }

  kill() {
    this.killed = true;
    this.emit('close', null);
  }
}

function fakeWindowsCommandRunner({
  binaries = [],
  calls = [],
  elevatedExitCode = 0,
  features = {},
  productType = 3,
  wslList = '',
  dockerDesktopPath = '',
  wslInstallDistroCode = 0,
  wslDockerInstallCode = 0,
  wslDockerInstalled = false,
  wslDockerReady = false,
  wslPythonInstalled = true,
  wslRootReady = false,
  ubuntuInstallRootRegisters = false
} = {}) {
  const present = new Set(binaries);
  let ubuntuRootRegistered = false;
  return async (cmd, args) => {
    calls.push({ cmd, args: Array.isArray(args) ? [...args] : args });
    if (cmd === 'where.exe') {
      const binary = args?.[0] || '';
      return {
        code: present.has(binary) ? 0 : 1,
        stdout: present.has(binary) ? `C:\\Windows\\System32\\${binary}\r\n` : '',
        stderr: ''
      };
    }
    if (cmd === 'powershell.exe') {
      const script = String(args?.[args.length - 1] || '');
      if (/Start-Process/.test(script) && /-Verb RunAs/.test(script)) {
        return { code: elevatedExitCode, stdout: '', stderr: '' };
      }
      if (/Win32_OperatingSystem\)\.ProductType/.test(script)) {
        return { code: 0, stdout: `${productType}\r\n`, stderr: '' };
      }
      if (/Docker Desktop\.exe/.test(script)) {
        return { code: 0, stdout: dockerDesktopPath ? `${dockerDesktopPath}\r\n` : '', stderr: '' };
      }
      const featureMatch = script.match(/FeatureName '([^']+)'/);
      if (featureMatch) {
        const state = features[featureMatch[1]] || 'Unknown';
        return { code: 0, stdout: `${state}\r\n`, stderr: '' };
      }
    }
    if (cmd === 'wsl.exe' && args?.[0] === '-l') {
      return { code: 0, stdout: wslList, stderr: '' };
    }
    if (cmd === 'wsl.exe' && args?.[0] === '--install') {
      return { code: wslInstallDistroCode, stdout: '', stderr: '' };
    }
    if (/^ubuntu(2404|2204|2004)?\.exe$/i.test(cmd) && args?.[0] === 'install' && args?.[1] === '--root') {
      if (ubuntuInstallRootRegisters) ubuntuRootRegistered = true;
      return { code: ubuntuInstallRootRegisters ? 0 : 1, stdout: '', stderr: ubuntuInstallRootRegisters ? '' : 'install failed' };
    }
    if (cmd === 'wsl.exe' && args?.includes('--exec')) {
      const script = String(args?.[args.length - 1] || '');
      if (args?.includes('-u') && args?.includes('root')) {
        if (script.trim() === 'true') {
          return { code: wslRootReady || ubuntuRootRegistered ? 0 : 1, stdout: '', stderr: '' };
        }
        if (/docker-ce docker-ce-cli containerd\.io/.test(script)) {
          return { code: wslDockerInstallCode, stdout: '', stderr: '' };
        }
        if (/apt-get install -y python3/.test(script)) {
          return { code: 0, stdout: '', stderr: '' };
        }
        if (/systemctl start docker|service docker start|dockerd >\/tmp\/a0-dockerd\.log/.test(script)) {
          return { code: 0, stdout: '', stderr: '' };
        }
      }
      if (/command -v docker/.test(script)) {
        return { code: wslDockerInstalled ? 0 : 1, stdout: wslDockerInstalled ? '/usr/bin/docker\n' : '', stderr: '' };
      }
      if (/command -v dockerd/.test(script)) {
        return { code: wslDockerInstalled ? 0 : 1, stdout: wslDockerInstalled ? '/usr/bin/dockerd\n' : '', stderr: '' };
      }
      if (/command -v python3/.test(script)) {
        return { code: wslPythonInstalled ? 0 : 1, stdout: wslPythonInstalled ? '/usr/bin/python3\n' : '', stderr: '' };
      }
      if (/docker info/.test(script)) {
        return { code: wslDockerReady ? 0 : 1, stdout: '', stderr: '' };
      }
    }
    return { code: 1, stdout: '', stderr: '' };
  };
}
