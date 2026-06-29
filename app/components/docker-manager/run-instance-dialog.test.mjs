import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  authEnvLinesFromValues,
  createLocalInstanceButtonModel,
  installedVersionChoices,
  mergeGeneratedEnvText
} = await import('./run-instance-dialog.js');

test('installed version choices include runnable installed versions and local images only', () => {
  const choices = installedVersionChoices({
    versions: [
      { id: 'ready', displayVersion: 'ready', availability: 'update_available' },
      { id: 'latest', displayVersion: 'latest', availability: 'installed' },
      { id: 'v2.0', displayVersion: '2.0', availability: 'available' },
      { id: 'v1.20', displayVersion: '1.20', availability: 'available', differsFromPublished: true },
      { id: 'v1.19', displayVersion: '1.19', availability: 'installing' },
      { id: 'testing', displayVersion: 'testing', availability: 'installed' }
    ],
    images: [
      { tag: 'main', imageRef: 'agent0ai/agent-zero:main' },
      { imageRef: 'agent0ai/agent-zero:local' },
      { tag: 'latest', imageRef: 'agent0ai/agent-zero:latest' }
    ]
  });

  assert.deepEqual(choices.map((choice) => choice.tag), [
    'latest',
    'ready',
    'v1.20',
    'local',
    'main'
  ]);
});

test('create local instance button model explains disabled states', () => {
  assert.deepEqual(createLocalInstanceButtonModel({ versions: [] }), {
    disabled: true,
    title: 'Install a version before creating a local Instance'
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
    title: 'Create a local Instance from an installed version'
  });

  assert.deepEqual(createLocalInstanceButtonModel({
    versions: [{ id: 'latest', availability: 'installed' }]
  }), {
    disabled: false,
    title: 'Create a local Instance from an installed version'
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
