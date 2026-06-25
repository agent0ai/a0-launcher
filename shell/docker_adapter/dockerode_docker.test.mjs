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

function tarArchiveForEntries(entries) {
  const parts = [];
  for (const entry of entries) {
    const name = entry.name;
    const data = Buffer.from(entry.text || '', 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8');
    header.write(data.length.toString(8), 124, 11, 'ascii');
    header[156] = entry.type === 'directory' ? '5'.charCodeAt(0) : '0'.charCodeAt(0);
    parts.push(header);
    parts.push(data);
    parts.push(Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
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

test('probeHttpFromContainer executes a bounded HTTP probe inside the container', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  const calls = [];
  docker.docker = {
    getContainer: (containerId) => {
      assert.equal(containerId, 'source-id');
      return {
        exec: (options, callback) => {
          calls.push(['exec', options.Cmd.slice(0, 4), options.AttachStdout, options.AttachStderr, options.Tty]);
          callback(null, {
            start: (startOptions, startCallback) => {
              calls.push(['start', startOptions]);
              startCallback(null, Readable.from([
                '{"reachable":true,"statusCode":200,"elapsedMs":42,"error":""}\n'
              ]));
            },
            inspect: async () => ({ ExitCode: 0 })
          });
        }
      };
    }
  };

  const result = await docker.probeHttpFromContainer('source-id', 'http://a0-target/', { timeoutMs: 2500 });

  assert.deepEqual(result, {
    reachable: true,
    statusCode: 200,
    elapsedMs: 42,
    error: '',
    exitCode: 0,
    timedOut: false
  });
  assert.equal(calls[0][0], 'exec');
  assert.equal(calls[0][1][0], '/bin/sh');
  assert.equal(calls[0][1][1], '-lc');
  assert.equal(calls[0][1][3], 'a0-http-probe');
  assert.deepEqual(calls[1], ['start', { Detach: false, Tty: false }]);
});

test('postJsonWithCsrfFromContainer executes a bounded CSRF JSON post inside the container', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  const calls = [];
  docker.docker = {
    getContainer: (containerId) => {
      assert.equal(containerId, 'source-id');
      return {
        exec: (options, callback) => {
          calls.push(['exec', options.Cmd, options.AttachStdout, options.AttachStderr, options.Tty]);
          callback(null, {
            start: (startOptions, startCallback) => {
              calls.push(['start', startOptions]);
              startCallback(null, Readable.from([
                '{"ok":true,"statusCode":200,"elapsedMs":33,"responseText":"{\\"message\\":\\"Message received.\\",\\"context\\":\\"ctx-1\\"}","responseJson":{"message":"Message received.","context":"ctx-1"},"error":""}\n'
              ]));
            },
            inspect: async () => ({ ExitCode: 0 })
          });
        }
      };
    }
  };

  const result = await docker.postJsonWithCsrfFromContainer(
    'source-id',
    'http://a0-target/',
    '/api/message_async',
    { text: 'hello', context: '', message_id: 'msg-1' },
    { csrfPath: '/api/csrf_token', origin: 'http://localhost', timeoutMs: 2500 }
  );

  assert.deepEqual(result, {
    ok: true,
    statusCode: 200,
    elapsedMs: 33,
    responseText: '{"message":"Message received.","context":"ctx-1"}',
    responseJson: { message: 'Message received.', context: 'ctx-1' },
    error: '',
    exitCode: 0
  });
  assert.equal(calls[0][0], 'exec');
  assert.equal(calls[0][1][0], '/bin/sh');
  assert.equal(calls[0][1][1], '-lc');
  assert.equal(calls[0][1][3], 'a0-json-post');
  assert.equal(calls[0][1][4], 'http://a0-target/');
  assert.equal(calls[0][1][5], '/api/message_async');
  assert.equal(JSON.parse(Buffer.from(calls[0][1][6], 'base64').toString('utf8')).text, 'hello');
  assert.equal(calls[0][1][7], '/api/csrf_token');
  assert.equal(calls[0][1][8], 'http://localhost');
  assert.equal(calls[0][1][9], '2500');
  assert.deepEqual(calls[1], ['start', { Detach: false, Tty: false }]);
});

test('sendA2aMessageFromContainer executes a bounded A2A JSON-RPC message inside the container', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  const calls = [];
  docker.docker = {
    getContainer: (containerId) => {
      assert.equal(containerId, 'source-id');
      return {
        exec: (options, callback) => {
          calls.push(['exec', options.Cmd, options.AttachStdout, options.AttachStderr, options.Tty]);
          callback(null, {
            start: (startOptions, startCallback) => {
              calls.push(['start', startOptions]);
              startCallback(null, Readable.from([
                '{"ok":true,"statusCode":200,"elapsedMs":270,"taskId":"task-1","contextId":"ctx-1","state":"completed","assistantText":"A2A_OK","responseText":"{\\"result\\":{\\"id\\":\\"task-1\\"}}","responseJson":{"result":{"id":"task-1"}},"error":""}\n'
              ]));
            },
            inspect: async () => ({ ExitCode: 0 })
          });
        }
      };
    }
  };

  const result = await docker.sendA2aMessageFromContainer(
    'source-id',
    'http://a0-target/a2a/t-token',
    'hello over a2a',
    { timeoutMs: 30000, waitMs: 60000, pollIntervalMs: 2000 }
  );

  assert.deepEqual(result, {
    ok: true,
    statusCode: 200,
    elapsedMs: 270,
    taskId: 'task-1',
    contextId: 'ctx-1',
    state: 'completed',
    assistantText: 'A2A_OK',
    responseText: '{"result":{"id":"task-1"}}',
    responseJson: { result: { id: 'task-1' } },
    error: '',
    pending: false,
    exitCode: 0
  });
  assert.equal(calls[0][0], 'exec');
  assert.equal(calls[0][1][0], '/bin/sh');
  assert.equal(calls[0][1][1], '-lc');
  assert.match(calls[0][1][2], /"messageId": message_id/);
  assert.match(calls[0][1][2], /"acceptedOutputModes": \["application\/json", "text\/plain"\]/);
  assert.match(calls[0][1][2], /"blocking": False/);
  assert.equal(calls[0][1][3], 'a0-a2a-message');
  assert.equal(calls[0][1][4], 'http://a0-target/a2a/t-token');
  assert.equal(Buffer.from(calls[0][1][5], 'base64').toString('utf8'), 'hello over a2a');
  assert.equal(calls[0][1][6], '30000');
  assert.equal(calls[0][1][7], '60000');
  assert.equal(calls[0][1][8], '2000');
  assert.deepEqual(calls[1], ['start', { Detach: false, Tty: false }]);
});

test('sendA2aMessageFromContainer preserves accepted A2A tasks that are still running', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  docker.docker = {
    getContainer: () => ({
      exec: (_options, callback) => {
        callback(null, {
          start: (_startOptions, startCallback) => {
            startCallback(null, Readable.from([
              '{"ok":true,"statusCode":200,"elapsedMs":180000,"taskId":"task-2","contextId":"ctx-2","state":"working","assistantText":"","responseText":"{\\"result\\":{\\"id\\":\\"task-2\\"}}","responseJson":{"result":{"id":"task-2"}},"error":"","pending":true}\n'
            ]));
          },
          inspect: async () => ({ ExitCode: 0 })
        });
      }
    })
  };

  const result = await docker.sendA2aMessageFromContainer(
    'source-id',
    'http://a0-target/a2a/t-token',
    'long task'
  );

  assert.equal(result.ok, true);
  assert.equal(result.taskId, 'task-2');
  assert.equal(result.state, 'working');
  assert.equal(result.pending, true);
  assert.equal(result.error, '');
});

test('pollA2aTaskFromContainer executes bounded A2A task polling inside the container', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  const calls = [];
  docker.docker = {
    getContainer: (containerId) => {
      assert.equal(containerId, 'source-id');
      return {
        exec: (options, callback) => {
          calls.push(['exec', options.Cmd, options.AttachStdout, options.AttachStderr, options.Tty]);
          callback(null, {
            start: (startOptions, startCallback) => {
              calls.push(['start', startOptions]);
              startCallback(null, Readable.from([
                '{"ok":true,"statusCode":200,"elapsedMs":1000,"taskId":"task-2","contextId":"ctx-2","state":"completed","assistantText":"RECOVERED_A2A_OK","responseText":"{\\"result\\":{\\"id\\":\\"task-2\\"}}","responseJson":{"result":{"id":"task-2"}},"error":"","pending":false}\n'
              ]));
            },
            inspect: async () => ({ ExitCode: 0 })
          });
        }
      };
    }
  };

  const result = await docker.pollA2aTaskFromContainer(
    'source-id',
    'http://a0-target/a2a/t-token',
    'task-2',
    { timeoutMs: 30000, waitMs: 120000, pollIntervalMs: 2000 }
  );

  assert.equal(result.ok, true);
  assert.equal(result.taskId, 'task-2');
  assert.equal(result.state, 'completed');
  assert.equal(result.assistantText, 'RECOVERED_A2A_OK');
  assert.equal(result.pending, false);
  assert.equal(calls[0][0], 'exec');
  assert.equal(calls[0][1][3], 'a0-a2a-task-poll');
  assert.equal(calls[0][1][4], 'http://a0-target/a2a/t-token');
  assert.equal(calls[0][1][5], 'task-2');
  assert.equal(calls[0][1][6], '30000');
  assert.equal(calls[0][1][7], '120000');
  assert.equal(calls[0][1][8], '2000');
  assert.deepEqual(calls[1], ['start', { Detach: false, Tty: false }]);
});

test('sendA2aMessageFromContainer redacts tokenized A2A URLs from adapter errors', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  docker.docker = {
    getContainer: () => ({
      exec: (_options, callback) => {
        callback(new Error('exec failed'));
      }
    })
  };

  await assert.rejects(
    () => docker.sendA2aMessageFromContainer(
      'source-id',
      'http://a0-target/a2a/t-secret-token-value',
      'hello over a2a'
    ),
    (error) => {
      assert.equal(error.name, 'DockerInterfaceError');
      assert.equal(error.details.agentUrl, 'http://a0-target/a2a/t-...');
      assert.doesNotMatch(JSON.stringify(error.details), /secret-token-value/);
      return true;
    }
  );
});

test('removeLocalImage preserves Docker in-use protection unless force is explicit', async () => {
  const calls = [];
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  docker.docker = {
    getImage: (imageRef) => ({
      remove: (options, callback) => {
        calls.push([imageRef, options]);
        callback(null);
      }
    })
  };

  await docker.removeLocalImage('agent0ai/agent-zero:latest');
  await docker.removeLocalImage('agent0ai/agent-zero:latest', { force: true });

  assert.deepEqual(calls, [
    ['agent0ai/agent-zero:latest', { force: false }],
    ['agent0ai/agent-zero:latest', { force: true }]
  ]);
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

test('writeContainerTextFile writes generated text archive to the parent path', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  const calls = [];
  docker.docker = {
    getContainer: (containerId) => {
      assert.equal(containerId, 'target-id');
      return {
        putArchive: (stream, options, callback) => {
          calls.push(['putArchive', options, typeof stream?.on === 'function']);
          callback(null, {});
        }
      };
    }
  };

  const result = await docker.writeContainerTextFile('target-id', '/a0/usr/.env', 'AUTH_LOGIN=dev1\n');

  assert.deepEqual(result, { written: true });
  assert.deepEqual(calls, [
    ['putArchive', { path: '/a0/usr' }, true]
  ]);
});

test('ensureContainerDirectory writes a directory archive to the parent path', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  const calls = [];
  docker.docker = {
    getContainer: (containerId) => {
      assert.equal(containerId, 'target-id');
      return {
        putArchive: (stream, options, callback) => {
          calls.push(['putArchive', options, typeof stream?.on === 'function']);
          callback(null, {});
        }
      };
    }
  };

  const result = await docker.ensureContainerDirectory('target-id', '/a0/usr/plugins');

  assert.deepEqual(result, { created: true });
  assert.deepEqual(calls, [
    ['putArchive', { path: '/a0/usr' }, true]
  ]);
});

test('ensureNetwork creates a labeled network when it is missing', async () => {
  const calls = [];
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  docker.docker = {
    getNetwork: (name) => ({
      inspect: async () => {
        calls.push(['inspect', name]);
        const error = new Error('not found');
        error.statusCode = 404;
        throw error;
      }
    }),
    createNetwork: async (options) => {
      calls.push(['create', options]);
      return {
        inspect: async () => ({
          Id: 'network-id',
          Name: options.Name,
          Driver: options.Driver,
          Labels: options.Labels,
          Containers: {}
        })
      };
    }
  };

  const network = await docker.ensureNetwork('a0-launcher-topology', {
    driver: 'bridge',
    labels: { 'a0.launcher.managed': 'true' }
  });

  assert.equal(network.created, true);
  assert.equal(network.name, 'a0-launcher-topology');
  assert.deepEqual(calls, [
    ['inspect', 'a0-launcher-topology'],
    ['create', {
      Name: 'a0-launcher-topology',
      Driver: 'bridge',
      Labels: { 'a0.launcher.managed': 'true' }
    }]
  ]);
});

test('ensureNetwork rejects an existing network without required labels', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  docker.docker = {
    getNetwork: () => ({
      inspect: async () => ({
        Id: 'network-id',
        Name: 'a0-launcher-topology',
        Driver: 'bridge',
        Labels: {},
        Containers: {}
      })
    })
  };

  await assert.rejects(
    () => docker.ensureNetwork('a0-launcher-topology', {
      labels: { 'a0.launcher.managed': 'true' }
    }),
    { code: 'NETWORK_CONFLICT' }
  );
});

test('connectContainerToNetwork sends aliases through EndpointConfig', async () => {
  const calls = [];
  const inspect = {
    Id: 'network-id',
    Name: 'a0-launcher-topology',
    Driver: 'bridge',
    Labels: { 'a0.launcher.managed': 'true' },
    Containers: {}
  };
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  docker.docker = {
    getNetwork: (name) => ({
      inspect: async () => inspect,
      connect: async (payload) => {
        calls.push([name, payload]);
        inspect.Containers[payload.Container] = {
          Name: 'agent-zero',
          EndpointID: 'endpoint-id',
          Aliases: payload.EndpointConfig.Aliases
        };
      }
    })
  };

  const result = await docker.connectContainerToNetwork('a0-launcher-topology', 'abcdef', {
    aliases: ['a0-abcdef']
  });

  assert.equal(result.connected, true);
  assert.deepEqual(calls, [
    ['a0-launcher-topology', {
      Container: 'abcdef',
      EndpointConfig: { Aliases: ['a0-abcdef'] }
    }]
  ]);
});

test('disconnectContainerFromNetwork is idempotent when the container is absent', async () => {
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  docker.docker = {
    getNetwork: () => ({
      inspect: async () => ({
        Id: 'network-id',
        Name: 'a0-launcher-topology',
        Driver: 'bridge',
        Labels: {},
        Containers: {}
      }),
      disconnect: async () => {
        throw new Error('should not disconnect');
      }
    })
  };

  const result = await docker.disconnectContainerFromNetwork('a0-launcher-topology', 'abcdef');

  assert.deepEqual(result, { disconnected: false, missingNetwork: false });
});

test('listContainerDirectory returns immediate archive children', async () => {
  const archive = Readable.from(tarArchiveForEntries([
    { name: 'plugins/', type: 'directory' },
    { name: 'plugins/_model_config/', type: 'directory' },
    { name: 'plugins/_model_config/config.json', text: '{}' },
    { name: 'plugins/custom_plugin/', type: 'directory' },
    { name: 'plugins/AGENTS.md', text: 'docs' }
  ]));
  const docker = new DockerodeDocker({ imageRepo: 'agent0ai/agent-zero' });
  docker.docker = {
    getContainer: (containerId) => {
      assert.equal(containerId, 'source-id');
      return {
        getArchive: (options, callback) => {
          assert.deepEqual(options, { path: '/a0/usr/plugins' });
          callback(null, archive);
        }
      };
    }
  };

  const result = await docker.listContainerDirectory('source-id', '/a0/usr/plugins');

  assert.deepEqual(result, [
    { name: '_model_config', type: 'directory' },
    { name: 'AGENTS.md', type: 'file' },
    { name: 'custom_plugin', type: 'directory' }
  ]);
});
