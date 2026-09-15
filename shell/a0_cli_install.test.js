const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const { test } = require('node:test');

const {
  a0CliInstallCommand,
  normalizeA0CliVersion,
  runA0CliInstaller,
  runA0CliUpdate,
  shouldInstallA0Cli
} = require('./a0_cli_install');

test('CLI install policy covers missing, incompatible, and newer releases', () => {
  assert.equal(normalizeA0CliVersion('a0 2.5'), '2.5.0');
  assert.equal(shouldInstallA0Cli({ installed: false }), true);
  assert.equal(shouldInstallA0Cli({ installed: true, supportsGateway: false }), true);
  assert.equal(shouldInstallA0Cli({
    installed: true,
    supportsGateway: true,
    currentVersion: '2.5',
    latestVersion: 'v2.6'
  }), true);
  assert.equal(shouldInstallA0Cli({
    installed: true,
    supportsGateway: true,
    currentVersion: '2.5',
    latestVersion: 'v2.5'
  }), false);
  assert.equal(shouldInstallA0Cli({
    installed: true,
    supportsGateway: true,
    latestVersion: 'v2.5'
  }), true);
  assert.equal(shouldInstallA0Cli({ installed: true, supportsGateway: true }), false);
});

test('CLI installer uses the official fixed script on every supported platform', () => {
  const linux = a0CliInstallCommand('linux');
  assert.equal(linux.command, 'sh');
  assert.match(linux.args.at(-1), /agent0ai\/a0-connector\/main\/install\.sh/);
  assert.match(linux.args.at(-1), /curl/);
  assert.match(linux.args.at(-1), /wget/);

  const scriptPath = "C:\\Users\\Test User's è\\install.ps1";
  const windows = a0CliInstallCommand('win32', scriptPath);
  assert.equal(windows.command, 'powershell.exe');
  assert.equal(windows.args.at(-1), scriptPath);
  assert.ok(windows.args.includes('-File'));
  assert.ok(windows.args.includes('RemoteSigned'));
  assert.doesNotMatch(windows.args.join(' '), /Bypass|-Command|\biex\b|https:/i);
  assert.throws(() => a0CliInstallCommand('win32'), /downloaded/);

  assert.throws(() => a0CliInstallCommand('freebsd'), { code: 'TERMINAL_UNAVAILABLE' });
});

test('CLI installer waits for completion and reports failure', async () => {
  let child;
  let spawnOptions;
  const spawn = (_command, _args, options) => {
    spawnOptions = options;
    child = new EventEmitter();
    child.unref = () => { child.unrefCalled = true; };
    return child;
  };

  const installed = runA0CliInstaller({ platform: 'linux', spawn, env: { PATH: '/usr/bin' } });
  child.emit('exit', 0, null);
  assert.deepEqual(await installed, { installed: true });
  assert.equal(child.unrefCalled, undefined);
  assert.equal(spawnOptions.detached, undefined);
  assert.equal(spawnOptions.windowsHide, true);
  assert.equal(spawnOptions.stdio, 'ignore');

  const failed = runA0CliInstaller({ platform: 'linux', spawn });
  child.emit('exit', 7, null);
  await assert.rejects(failed, { code: 'CLI_INSTALL_FAILED' });
});

test('CLI updater runs a0 update and reports failure', async () => {
  let child;
  let spawned;
  const spawn = (command, args, options) => {
    spawned = { command, args, options };
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
  };

  const updated = runA0CliUpdate('/usr/bin/a0', { spawn, env: { PATH: '/usr/bin' } });
  let completed = false;
  updated.then(() => { completed = true; });
  child.emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(completed, false);
  child.stdout.write('Update complete. ');
  child.stdout.write('Run a0.\r\n');
  child.emit('close', 0, null);
  assert.deepEqual(await updated, { updated: true });
  assert.deepEqual(spawned.args, ['update']);
  assert.equal(spawned.command, '/usr/bin/a0');
  assert.deepEqual(spawned.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(spawned.options.windowsHide, true);

  const failed = runA0CliUpdate('/usr/bin/a0', { spawn });
  child.emit('close', 7, null);
  await assert.rejects(failed, { code: 'CLI_UPDATE_FAILED' });
  const handoffFailed = runA0CliUpdate('/usr/bin/a0', { spawn });
  child.stdout.write('Handing off update to a separate process.\n');
  child.emit('close', 0, null);
  await assert.rejects(handoffFailed, { code: 'CLI_UPDATE_FAILED' });
  await assert.rejects(runA0CliUpdate('', { spawn }), { code: 'TERMINAL_UNAVAILABLE' });
});

test('Windows installer downloads before spawning and cleans up on success and failure', async () => {
  for (const outcome of [0, 7, 'spawn-error']) {
    let downloadedPath;
    const install = runA0CliInstaller({
      platform: 'win32',
      fetch: async (url) => {
        assert.equal(url, 'https://raw.githubusercontent.com/agent0ai/a0-connector/main/install.ps1');
        return { ok: true, text: async () => 'exit 0\n' };
      },
      spawn: (_command, args) => {
        downloadedPath = args.at(-1);
        assert.equal(fs.readFileSync(downloadedPath, 'utf8'), 'exit 0\n');
        if (outcome === 'spawn-error') throw new Error('spawn failed');
        const child = new EventEmitter();
        process.nextTick(() => child.emit('exit', outcome, null));
        return child;
      }
    });
    if (outcome === 0) assert.deepEqual(await install, { installed: true });
    else await assert.rejects(install);
    assert.equal(fs.existsSync(path.dirname(downloadedPath)), false);
  }
  await assert.rejects(runA0CliInstaller({
    platform: 'win32',
    fetch: async () => ({ ok: false, status: 503 }),
    spawn: () => assert.fail('Download failure must not execute anything')
  }), /HTTP 503/);
});

test('Windows runs a downloaded script and propagates its exit status', { skip: process.platform !== 'win32' }, async () => {
  for (const code of [0, 7]) {
    const install = runA0CliInstaller({ fetch: async () => ({ ok: true, text: async () => `exit ${code}\n` }) });
    if (code === 0) assert.deepEqual(await install, { installed: true });
    else await assert.rejects(install, { code: 'CLI_INSTALL_FAILED' });
  }
});

test('startup updates compatible installations and reserves the installer for missing or incompatible CLIs', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('function ensureA0CliInstalled(');
  const end = source.indexOf('\nfunction a0CliSupportsOption(', start);
  for (const scenario of [
    { installed: false, gateway: false, expected: 'install' },
    { installed: true, gateway: false, expected: 'install' },
    { installed: true, gateway: true, expected: 'update' },
    { installed: true, gateway: true, current: '2.6', expected: '' },
    { installed: true, gateway: true, current: '2.7', expected: '' },
    { installed: true, gateway: true, latest: '', expected: '' },
    { installed: true, gateway: true, current: '2.6', force: true, expected: 'update' },
    { installed: true, gateway: true, fail: true, expected: 'update' }
  ]) {
    const calls = [];
    let maintained = false;
    const context = vm.createContext({
      a0CliEnsurePromise: null, a0CliEnsureState: 'idle', a0CliResolvedBinary: '',
      existingFilePath: (value) => value,
      setA0CliEnsureState: () => {},
      findA0CliCommandBinary: () => scenario.installed || maintained ? '/bin/a0' : '',
      a0CliSupportsGateway: () => scenario.gateway || maintained,
      readA0CliVersion: () => scenario.current || '2.5',
      fetchLatestA0CliVersion: async () => scenario.latest ?? '2.6',
      shouldInstallA0Cli,
      findCompatibleA0CliBinary: () => scenario.gateway || maintained ? '/bin/a0' : '',
      runA0CliInstaller: async () => { calls.push('install'); maintained = true; },
      runA0CliUpdate: async (cli) => {
        assert.equal(cli, '/bin/a0');
        calls.push('update');
        if (scenario.fail) throw new Error('update failed');
        maintained = true;
      },
      net: { fetch() {} }, console: { warn() {} }
    });
    vm.runInContext(source.slice(start, end), context);
    assert.equal(await context.ensureA0CliInstalled({ force: scenario.force }), '/bin/a0');
    assert.deepEqual(calls, scenario.expected ? [scenario.expected] : []);
  }
});
