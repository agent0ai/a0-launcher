import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  authKeysForRegistry,
  dockerBasicHeaderFromAuthConfig,
  registryFromImageRef,
  resolveDockerAuthConfigForImage,
  resolveDockerAuthConfigForRegistry
} from './impl/DockerAuthConfig.mjs';
import { DockerHubRegistry } from './impl/DockerHubRegistry.mjs';
import { DockerodeDocker } from './impl/DockerodeDocker.mjs';

function b64(value) {
  return Buffer.from(value).toString('base64');
}

test('Docker Hub image refs use Docker Hub credential keys', () => {
  assert.equal(registryFromImageRef('agent0ai/agent-zero:latest'), 'docker.io');
  assert.deepEqual(authKeysForRegistry('docker.io').slice(0, 2), [
    'https://index.docker.io/v1/',
    'https://index.docker.io/v1'
  ]);
});

test('inline Docker Hub auth becomes Dockerode authconfig and basic header', async () => {
  const dockerConfig = {
    auths: {
      'https://index.docker.io/v1/': {
        auth: b64('octavia:secret-token')
      }
    }
  };

  const authConfig = await resolveDockerAuthConfigForImage('agent0ai/agent-zero:latest', { dockerConfig });

  assert.deepEqual(authConfig, {
    username: 'octavia',
    password: 'secret-token',
    serveraddress: 'https://index.docker.io/v1/'
  });
  assert.equal(dockerBasicHeaderFromAuthConfig(authConfig), `Basic ${b64('octavia:secret-token')}`);
});

test('credential helper auth is used when inline auth is absent', async () => {
  const calls = [];
  const dockerConfig = {
    auths: {
      'https://index.docker.io/v1/': {}
    },
    credsStore: 'desktop'
  };

  const authConfig = await resolveDockerAuthConfigForImage('agent0ai/agent-zero:latest', {
    dockerConfig,
    runCredentialHelper: async (helperName, serveraddress) => {
      calls.push({ helperName, serveraddress });
      return { Username: 'octavia', Secret: 'from-helper' };
    }
  });

  assert.deepEqual(calls, [{ helperName: 'desktop', serveraddress: 'https://index.docker.io/v1/' }]);
  assert.deepEqual(authConfig, {
    username: 'octavia',
    password: 'from-helper',
    serveraddress: 'https://index.docker.io/v1/'
  });
});

test('unsafe credential helper names are ignored', async () => {
  let callCount = 0;
  const dockerConfig = {
    auths: {
      'docker.io': {}
    },
    credHelpers: {
      'docker.io': '../not-a-helper'
    }
  };

  const authConfig = await resolveDockerAuthConfigForRegistry('docker.io', {
    dockerConfig,
    runCredentialHelper: async () => {
      callCount += 1;
      return { Username: 'octavia', Secret: 'nope' };
    }
  });

  assert.equal(callCount, 0);
  assert.equal(authConfig, null);
});

test('custom registry inline auth uses the registry server address', async () => {
  const dockerConfig = {
    auths: {
      'registry.example.test': {
        auth: b64('robot:secret')
      }
    }
  };

  const authConfig = await resolveDockerAuthConfigForImage('registry.example.test/team/app:v1', { dockerConfig });

  assert.deepEqual(authConfig, {
    username: 'robot',
    password: 'secret',
    serveraddress: 'registry.example.test'
  });
});

test('pullImage passes Docker CLI authconfig to Dockerode', async (t) => {
  const dockerConfigDir = await mkdtemp(path.join(os.tmpdir(), 'a0-docker-config-'));
  const previousDockerConfig = process.env.DOCKER_CONFIG;

  t.after(async () => {
    if (previousDockerConfig === undefined) {
      delete process.env.DOCKER_CONFIG;
    } else {
      process.env.DOCKER_CONFIG = previousDockerConfig;
    }
    await rm(dockerConfigDir, { recursive: true, force: true });
  });

  process.env.DOCKER_CONFIG = dockerConfigDir;
  await writeFile(path.join(dockerConfigDir, 'config.json'), JSON.stringify({
    auths: {
      'https://index.docker.io/v1/': {
        auth: b64('octavia:secret-token')
      }
    }
  }));

  const docker = new DockerodeDocker();
  docker.getRemoteLayerSizes = async () => null;

  let pullOptions = null;
  docker.docker = {
    pull: (_ref, options, callback) => {
      pullOptions = options;
      callback(null, {});
    },
    modem: {
      followProgress: (_stream, done) => done(null)
    }
  };

  const result = await docker.pullImage('agent0ai/agent-zero:latest');

  assert.equal(result.status, 'completed');
  assert.deepEqual(pullOptions?.authconfig, {
    username: 'octavia',
    password: 'secret-token',
    serveraddress: 'https://index.docker.io/v1/'
  });
});

test('Docker Hub token cache separates anonymous and authenticated requests', async (t) => {
  const dockerConfigDir = await mkdtemp(path.join(os.tmpdir(), 'a0-docker-config-'));
  const previousDockerConfig = process.env.DOCKER_CONFIG;
  const previousFetch = globalThis.fetch;
  const calls = [];

  t.after(async () => {
    if (previousDockerConfig === undefined) {
      delete process.env.DOCKER_CONFIG;
    } else {
      process.env.DOCKER_CONFIG = previousDockerConfig;
    }
    globalThis.fetch = previousFetch;
    await rm(dockerConfigDir, { recursive: true, force: true });
  });

  process.env.DOCKER_CONFIG = dockerConfigDir;
  globalThis.fetch = async (url, options = {}) => {
    const headers = options.headers || {};
    calls.push({
      url: String(url),
      authorization: headers.Authorization || headers.authorization || null
    });

    if (String(url).includes('auth.docker.io/token')) {
      const authenticated = !!(headers.Authorization || headers.authorization);
      return new Response(JSON.stringify({
        token: authenticated ? 'auth-token' : 'anon-token',
        expires_in: 3600
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ tags: ['latest'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const registry = new DockerHubRegistry();
  await registry.listTags('agent0ai/agent-zero');

  await writeFile(path.join(dockerConfigDir, 'config.json'), JSON.stringify({
    auths: {
      'https://index.docker.io/v1/': {
        auth: b64('octavia:secret-token')
      }
    }
  }));

  await registry.listTags('agent0ai/agent-zero');

  const tokenCalls = calls.filter((call) => call.url.includes('auth.docker.io/token'));
  const tagCalls = calls.filter((call) => call.url.includes('/tags/list'));

  assert.equal(tokenCalls.length, 2);
  assert.equal(tokenCalls[0].authorization, null);
  assert.equal(tokenCalls[1].authorization, `Basic ${b64('octavia:secret-token')}`);
  assert.equal(tagCalls[0].authorization, 'Bearer anon-token');
  assert.equal(tagCalls[1].authorization, 'Bearer auth-token');
});
