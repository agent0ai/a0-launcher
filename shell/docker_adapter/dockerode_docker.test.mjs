import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { DockerodeDocker } from './impl/DockerodeDocker.mjs';

function tarArchiveForFile(name, text) {
  const data = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8');
  header.write(data.length.toString(8), 124, 11, 'ascii');
  header[156] = '0'.charCodeAt(0);

  const paddedSize = Math.ceil(data.length / 512) * 512;
  return Buffer.concat([
    header,
    data,
    Buffer.alloc(paddedSize - data.length),
    Buffer.alloc(1024)
  ]);
}

test('listContainers formats UI URLs from selected public host port', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  docker.docker = {
    listContainers: async () => [
      {
        Id: 'container-id',
        Image: 'agent0ai/agent-zero:latest',
        Names: ['/agent-zero-latest'],
        Labels: {},
        State: 'running',
        Status: 'Up 2 minutes',
        Created: 1781760000,
        Ports: [
          { PrivatePort: 22, PublicPort: 32222, Type: 'tcp', IP: '127.0.0.1' },
          { PrivatePort: 80, PublicPort: 32080, Type: 'tcp', IP: '127.0.0.1' }
        ]
      }
    ]
  };

  const [container] = await docker.listContainers('agent0ai/agent-zero');

  assert.equal(container.uiUrl, 'http://127.0.0.1:32080/');
  assert.deepEqual(container.ports, [
    { privatePort: 22, publicPort: 32222, type: 'tcp', ip: '127.0.0.1' },
    { privatePort: 80, publicPort: 32080, type: 'tcp', ip: '127.0.0.1' }
  ]);
});

test('readContainerTextFile extracts text from a Docker archive', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  docker.docker = {
    getContainer: (containerId) => {
      assert.equal(containerId, 'container-id');
      return {
        getArchive: (options, callback) => {
          assert.deepEqual(options, { path: '/a0/.git/HEAD' });
          callback(null, Readable.from(tarArchiveForFile('HEAD', 'ref: refs/heads/ready\n')));
        }
      };
    }
  };

  const text = await docker.readContainerTextFile('container-id', '/a0/.git/HEAD', { maxBytes: 8192 });

  assert.equal(text, 'ref: refs/heads/ready\n');
});

test('readContainerTextFile returns null for missing paths', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  docker.docker = {
    getContainer: () => ({
      getArchive: (_options, callback) => {
        callback({ statusCode: 404 });
      }
    })
  };

  const text = await docker.readContainerTextFile('container-id', '/a0/.git/HEAD', { maxBytes: 8192 });

  assert.equal(text, null);
});

test('copyContainerPathToContainer streams a container archive into another container', async () => {
  const archive = Readable.from(tarArchiveForFile('usr/marker.txt', 'hello'));
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  const calls = [];
  docker.docker = {
    getContainer: (containerId) => {
      if (containerId === 'source-id') {
        return {
          getArchive: (options, callback) => {
            calls.push(['getArchive', options]);
            callback(null, archive);
          }
        };
      }
      if (containerId === 'target-id') {
        return {
          putArchive: (stream, options, callback) => {
            calls.push(['putArchive', options, stream === archive]);
            callback(null, {});
          }
        };
      }
      throw new Error(`unexpected container ${containerId}`);
    }
  };

  const result = await docker.copyContainerPathToContainer('source-id', '/a0/usr', 'target-id', '/a0');

  assert.deepEqual(result, { copied: true });
  assert.deepEqual(calls, [
    ['getArchive', { path: '/a0/usr' }],
    ['putArchive', { path: '/a0' }, true]
  ]);
});
