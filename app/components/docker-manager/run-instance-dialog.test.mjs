import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const {
  authEnvLinesFromValues,
  channelPullDefault,
  channelPullOperationType,
  createLocalInstanceButtonModel,
  directWorkspaceFolder,
  installedVersionChoices,
  isChannelVersionChoice,
  mergeGeneratedEnvText,
  storageFieldVisibility,
  storageOverrideFromChoice
} = await import('./run-instance-dialog.js');

test('version choices pin channels, include installed versions and hide testing', () => {
  const choices = installedVersionChoices({
    versions: [
      { id: 'ready', displayVersion: 'ready', availability: 'available', installability: 'installable' },
      { id: 'latest', displayVersion: 'latest', availability: 'installed' },
      { id: 'v2.0', displayVersion: '2.0', availability: 'available' },
      { id: 'v3', displayVersion: 'v3', availability: 'available', installability: 'installable' },
      { id: 'v1.20', displayVersion: '1.20', availability: 'available', differsFromPublished: true },
      { id: 'v1.19', displayVersion: '1.19', availability: 'installing' },
      { id: 'testing', displayVersion: 'testing', availability: 'installed' },
      { id: 'main', displayVersion: 'main', availability: 'installed' },
      { id: 'local', displayVersion: 'local', availability: 'installed' }
    ],
    images: [
      { tag: 'main', imageRef: 'agent0ai/agent-zero:main' },
      { imageRef: 'agent0ai/agent-zero:local' },
      { tag: 'latest', imageRef: 'agent0ai/agent-zero:latest' },
      { tag: 'latest', imageRef: 'my-agent-zero:latest', imageRepo: 'my-agent-zero', isBackendImage: false }
    ]
  });

  assert.deepEqual(choices.map((choice) => choice.tag), [
    'latest',
    'ready',
    'v3',
    'v1.20',
    'local',
    'main'
  ]);
  assert.equal(choices.some((choice) => choice.imageRef === 'my-agent-zero:latest'), false);
});

test('channel pull defaults on for every channel choice', () => {
  assert.equal(isChannelVersionChoice({ tag: 'latest' }), true);
  assert.equal(isChannelVersionChoice({ tag: 'v2.0' }), false);
  assert.equal(channelPullDefault({ tag: 'v3', availability: 'available' }), true);
  assert.equal(channelPullDefault({ tag: 'v3', isBackendImage: false }), false);
  assert.equal(channelPullDefault({ tag: 'v2.0', availability: 'installed' }), false);
  assert.equal(channelPullDefault({ tag: 'latest', availability: 'available' }), true);
  assert.equal(channelPullDefault({ tag: 'ready', availability: 'installed', differsFromPublished: true }), true);
  assert.equal(channelPullDefault({
    tag: 'latest',
    availability: 'installed',
    matchedReleaseTag: 'v1.9',
    publishedReleaseTag: 'v1.10'
  }), true);
  assert.equal(channelPullDefault({
    tag: 'latest',
    availability: 'installed',
    matchedReleaseTag: 'v1.10',
    publishedReleaseTag: 'v1.10'
  }), true);
});

test('channel pulls install missing images and update existing images', () => {
  assert.equal(channelPullOperationType({ tag: 'latest', availability: 'available' }), 'install');
  assert.equal(channelPullOperationType({ tag: 'latest', availability: 'installed' }), 'update');
});

test('create local instance button model explains disabled states', () => {
  assert.deepEqual(createLocalInstanceButtonModel({ versions: [] }), {
    disabled: true,
    title: 'Agent Zero versions are not ready yet'
  });

  assert.deepEqual(createLocalInstanceButtonModel({
    versions: [{ id: 'latest', availability: 'installed' }],
    progress: { status: 'running' }
  }), {
    disabled: true,
    title: 'Another operation is running'
  });

  assert.deepEqual(createLocalInstanceButtonModel({
    versions: [{ id: 'latest', availability: 'installed' }],
    progress: { status: 'running', presentation: 'toast' }
  }), {
    disabled: false,
    title: 'Create a local Instance'
  });

  assert.deepEqual(createLocalInstanceButtonModel({
    versions: [{ id: 'latest', availability: 'installed' }]
  }), {
    disabled: false,
    title: 'Create a local Instance'
  });
});

test('auth environment helpers clean values and preserve explicit advanced overrides', () => {
  assert.deepEqual(authEnvLinesFromValues({
    username: ' dev ',
    password: 'line one\nline two'
  }), [
    'AUTH_LOGIN=dev',
    'AUTH_PASSWORD=line one line two'
  ]);

  assert.equal(
    mergeGeneratedEnvText([
      'AUTH_LOGIN=dev',
      'AUTH_PASSWORD=secret'
    ], 'AUTH_PASSWORD=manual\nAPI_KEY_OPENAI=sk-test'),
    'AUTH_LOGIN=dev\n\nAUTH_PASSWORD=manual\nAPI_KEY_OPENAI=sk-test'
  );
});

test('workspace storage choices map to explicit mount behavior', () => {
  assert.deepEqual(storageOverrideFromChoice('host_directory_exact'), {
    storageMode: 'host_directory',
    hostPathMode: 'exact'
  });
  assert.deepEqual(storageOverrideFromChoice('host_directory'), {
    storageMode: 'host_directory',
    hostPathMode: 'per_instance'
  });
  assert.deepEqual(storageOverrideFromChoice('named_volume'), {
    storageMode: 'named_volume'
  });
});

test('workspace storage choices expose only their relevant fields', () => {
  assert.deepEqual(storageFieldVisibility(''), {
    hostRoot: false,
    volumeName: false
  });
  assert.deepEqual(storageFieldVisibility('host_directory'), {
    hostRoot: false,
    volumeName: false
  });
  assert.deepEqual(storageFieldVisibility('host_directory_exact'), {
    hostRoot: true,
    volumeName: false
  });
  assert.deepEqual(storageFieldVisibility('named_volume'), {
    hostRoot: false,
    volumeName: true
  });
});

test('direct workspace folder defaults to the instance name under the root', () => {
  assert.equal(directWorkspaceFolder('', 'Personal'), '~/agent-zero/Personal');
  assert.equal(directWorkspaceFolder('/mnt/workspaces', 'Personal'), '/mnt/workspaces/Personal');
  assert.equal(directWorkspaceFolder('~/agent-zero', 'personal2'), '~/agent-zero/personal2');
  assert.equal(directWorkspaceFolder('~/agent-zero/', 'Personal/Two'), '~/agent-zero/Personal-Two');
});

test('advanced options are collapsed by default', async () => {
  const source = await readFile(new URL('./run-instance-dialog.js', import.meta.url), 'utf8');
  assert.match(source, /<details class="dm-advanced">/);
  assert.doesNotMatch(source, /<details class="dm-advanced" open>/);
});

test('local Instance setup inherits Host access defaults and hides its options while off', async () => {
  const source = await readFile(new URL('./run-instance-dialog.js', import.meta.url), 'utf8');
  assert.match(source, /"Allow this Instance to use this computer"/);
  assert.match(source, /hostAccessDefaults\.configured && hostAccessDefaults\.masterEnabled/);
  assert.match(source, /data-launcher-host-options/);
  assert.match(source, /hostAccessOptions\.hidden = !hostAccessEnabled/);
  assert.match(source, /Local folder for files and commands/);
  assert.match(source, /Using this Instance's workspace/);
  assert.match(source, /syncHostAccessFolder/);
  assert.match(source, /Commands can also reach other folders/i);
  assert.match(source, /masterEnabled: hostAccessConfiguredInput\?\.checked === true/);
});
