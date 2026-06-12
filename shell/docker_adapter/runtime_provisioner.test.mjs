import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { RuntimeProvisioner } from './RuntimeProvisioner.mjs';
import { ColimaRuntime, selectLatestDockerCliAsset } from './impl/ColimaRuntime.mjs';
import { LinuxEngineRuntime } from './impl/LinuxEngineRuntime.mjs';

test('RuntimeProvisioner.forPlatform selects runtime implementations by platform', async () => {
  const managedDir = await mkdtemp(path.join(os.tmpdir(), 'a0-runtime-'));
  try {
    const macRuntime = await RuntimeProvisioner.forPlatform({ managedDir, platform: 'darwin' });
    const linuxRuntime = await RuntimeProvisioner.forPlatform({ managedDir, platform: 'linux' });
    const unsupportedRuntime = await RuntimeProvisioner.forPlatform({ managedDir, platform: 'win32' });

    assert.ok(macRuntime instanceof ColimaRuntime);
    assert.ok(linuxRuntime instanceof LinuxEngineRuntime);
    assert.equal(unsupportedRuntime, null);
  } finally {
    await rm(managedDir, { recursive: true, force: true });
  }
});

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
