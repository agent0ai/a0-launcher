const assert = require('node:assert/strict');
const { test } = require('node:test');

const dockerManager = require('./index');

const {
  deriveTopology,
  topologyAliasForContainer,
  topologyConnectionHints,
  topologyProbeRequestsForEdge,
  topologyMessagePayload,
  normalizeTopologyMessageResult,
  publicA2aSetupResult,
  topologyRuntimeErrorFromLogLines,
  topologyLatestRunningA2aTaskIdFromLogLines,
  topologyContainerIdsForMessageDirection,
  topologyNodeIdForLocal,
  topologyNodeIdForRemote
} = dockerManager._test;

test('deriveTopology builds local and remote nodes with saved roles and positions', () => {
  const topology = deriveTopology(
    {
      nodes: [
        { id: 'local:abcdef', role: 'coordinator', position: { x: 10, y: 20 } },
        { id: 'remote:remote_1', role: 'worker', position: { x: 30, y: 40 } }
      ],
      edges: [
        { id: 'edge_1', source: 'local:abcdef', target: 'remote:remote_1', mode: 'metadata' }
      ]
    },
    [
      {
        containerId: 'abcdef',
        containerName: 'agent-zero',
        instanceName: 'Local A',
        state: 'running',
        versionTag: 'latest',
        instanceColor: 'green'
      }
    ],
    [
      {
        id: 'remote_1',
        name: 'Remote B',
        url: 'https://a0.example.com/',
        color: 'rose'
      }
    ]
  );

  assert.equal(topology.nodes.length, 2);
  assert.deepEqual(topology.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    role: node.role,
    position: node.position
  })), [
    { id: 'local:abcdef', kind: 'local', label: 'Local A', role: 'coordinator', position: { x: 10, y: 20 } },
    { id: 'remote:remote_1', kind: 'remote', label: 'Remote B', role: 'worker', position: { x: 30, y: 40 } }
  ]);
  assert.equal(topology.edges[0].status, 'metadata');
});

test('deriveTopology marks connected local edges from network attachment state', () => {
  const topology = deriveTopology(
    {
      edges: [
        {
          id: 'edge_1',
          source: 'local:abcdef',
          target: 'local:123456',
          mode: 'local_network',
          connection: { networkName: 'a0-launcher-topology' }
        }
      ]
    },
    [
      { containerId: 'abcdef', containerName: 'a', state: 'running' },
      { containerId: '123456', containerName: 'b', state: 'running' }
    ],
    [],
    {
      network: {
        labels: {
          'a0.launcher.managed': 'true',
          'a0.launcher.role': 'topology-network'
        },
        containers: {
          abcdef: { aliases: ['a0-abcdef'] },
          123456: { aliases: ['a0-123456'] }
        }
      }
    }
  );

  assert.equal(topology.edges[0].status, 'connected');
  assert.equal(topology.edges[0].canConnect, false);
  assert.equal(topology.edges[0].canDisconnect, true);
});

test('deriveTopology keeps missing endpoints visible for stale links', () => {
  const topology = deriveTopology(
    {
      edges: [
        { id: 'edge_1', source: 'local:abcdef', target: 'remote:remote_1', mode: 'metadata' }
      ]
    },
    [],
    []
  );

  assert.equal(topology.nodes.length, 2);
  assert.equal(topology.nodes.every((node) => node.missing === true), true);
  assert.equal(topology.edges[0].status, 'missing_endpoint');
});

test('topology node ids and aliases are deterministic', () => {
  assert.equal(topologyNodeIdForLocal('abcdef'), 'local:abcdef');
  assert.equal(topologyNodeIdForRemote('remote_1'), 'remote:remote_1');
  assert.equal(topologyAliasForContainer('abcdef1234567890'), 'a0-abcdef123456');
});

test('topology connection hints expose copyable internal container URLs without A2A tokens', () => {
  assert.deepEqual(
    topologyConnectionHints('local:abcdef', 'a0-abcdef', 'local:123456', 'a0-123456'),
    [
      {
        nodeId: 'local:abcdef',
        alias: 'a0-abcdef',
        internalUrl: 'http://a0-abcdef/'
      },
      {
        nodeId: 'local:123456',
        alias: 'a0-123456',
        internalUrl: 'http://a0-123456/'
      }
    ]
  );
});

test('topologyProbeRequestsForEdge probes both tokenized A2A agent-card directions', () => {
  const edge = {
    id: 'edge_1',
    source: 'local:abcdef',
    target: 'local:123456',
    mode: 'local_network',
    connection: {
      networkName: 'a0-launcher-topology',
      aliases: {
        'local:abcdef': 'a0-abcdef',
        'local:123456': 'a0-123456'
      },
      hints: [
        { nodeId: 'local:abcdef', alias: 'a0-abcdef', internalUrl: 'http://a0-abcdef/' },
        { nodeId: 'local:123456', alias: 'a0-123456', internalUrl: 'http://a0-123456/' }
      ]
    }
  };
  const requests = topologyProbeRequestsForEdge(edge, {
    endpoints: [
      {
        nodeId: 'local:abcdef',
        a2aUrl: 'http://a0-abcdef/a2a/t-source-token',
        displayUrl: 'http://a0-abcdef/a2a/t-...oken'
      },
      {
        nodeId: 'local:123456',
        a2aUrl: 'http://a0-123456/a2a/t-target-token',
        displayUrl: 'http://a0-123456/a2a/t-...oken'
      }
    ]
  });

  assert.deepEqual(requests, [
    {
      fromNodeId: 'local:abcdef',
      toNodeId: 'local:123456',
      fromContainerId: 'abcdef',
      url: 'http://a0-123456/a2a/t-target-token/.well-known/agent.json',
      displayUrl: 'http://a0-123456/a2a/t-...oken/.well-known/agent.json'
    },
    {
      fromNodeId: 'local:123456',
      toNodeId: 'local:abcdef',
      fromContainerId: '123456',
      url: 'http://a0-abcdef/a2a/t-source-token/.well-known/agent.json',
      displayUrl: 'http://a0-abcdef/a2a/t-...oken/.well-known/agent.json'
    }
  ]);
});

test('topologyProbeRequestsForEdge does not fall back to plain web roots for A2A', () => {
  const requests = topologyProbeRequestsForEdge({
    id: 'edge_1',
    source: 'local:abcdef',
    target: 'local:123456',
    mode: 'local_network',
    connection: {
      networkName: 'a0-launcher-topology',
      aliases: {
        'local:abcdef': 'a0-abcdef',
        'local:123456': 'a0-123456'
      },
      hints: [
        { nodeId: 'local:abcdef', alias: 'a0-abcdef', internalUrl: 'http://a0-abcdef/' },
        { nodeId: 'local:123456', alias: 'a0-123456', internalUrl: 'http://a0-123456/' }
      ]
    }
  });

  assert.deepEqual(requests, []);
});

test('publicA2aSetupResult redacts tokenized A2A URLs', () => {
  const result = publicA2aSetupResult({
    edgeId: 'edge_1',
    preparedAt: '2026-06-24T21:00:00.000Z',
    ok: true,
    endpoints: [
      {
        nodeId: 'local:abcdef',
        alias: 'a0-abcdef',
        a2aUrl: 'http://a0-abcdef/a2a/t-secret-source-token',
        displayUrl: 'http://a0-abcdef/a2a/t-...oken',
        enabled: true
      }
    ]
  });

  assert.deepEqual(result, {
    edgeId: 'edge_1',
    preparedAt: '2026-06-24T21:00:00.000Z',
    ok: true,
    endpoints: [
      {
        nodeId: 'local:abcdef',
        alias: 'a0-abcdef',
        displayUrl: 'http://a0-abcdef/a2a/t-...oken',
        enabled: true
      }
    ]
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-source-token/);
});

test('topologyMessagePayload builds Agent Zero message payloads', () => {
  const payload = topologyMessagePayload('hello from topology', 'ctx-1');

  assert.equal(payload.text, 'hello from topology');
  assert.equal(payload.context, 'ctx-1');
  assert.match(payload.message_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('normalizeTopologyMessageResult extracts response status and context', () => {
  assert.deepEqual(
    normalizeTopologyMessageResult({
      ok: true,
      statusCode: 200,
      elapsedMs: 42,
      responseText: '{"message":"Message received.","context":"ctx-1"}',
      responseJson: {
        message: 'Message received.',
        context: 'ctx-1'
      },
      error: ''
    }),
    {
      ok: true,
      statusCode: 200,
      elapsedMs: 42,
      taskId: '',
      state: '',
      contextId: 'ctx-1',
      pending: false,
      response: 'Message received.',
      responseText: '{"message":"Message received.","context":"ctx-1"}',
      error: ''
    }
  );

  assert.equal(
    normalizeTopologyMessageResult({ ok: false, error: 'CSRF token unavailable' }).error,
    'CSRF token unavailable'
  );
});

test('normalizeTopologyMessageResult extracts A2A task response text', () => {
  assert.deepEqual(
    normalizeTopologyMessageResult({
      ok: true,
      statusCode: 200,
      elapsedMs: 270,
      taskId: 'task-1',
      contextId: 'ctx-1',
      state: 'completed',
      assistantText: 'A2A_OK',
      responseText: '{"result":{"id":"task-1"}}',
      responseJson: { result: { id: 'task-1' } },
      error: ''
    }),
    {
      ok: true,
      statusCode: 200,
      elapsedMs: 270,
      taskId: 'task-1',
      state: 'completed',
      contextId: 'ctx-1',
      pending: false,
      response: 'A2A_OK',
      responseText: '{"result":{"id":"task-1"}}',
      error: ''
    }
  );
});

test('normalizeTopologyMessageResult treats accepted A2A timeout as still running', () => {
  assert.deepEqual(
    normalizeTopologyMessageResult({
      ok: false,
      statusCode: 200,
      elapsedMs: 60000,
      taskId: 'task-2',
      contextId: 'ctx-2',
      state: 'working',
      assistantText: '',
      responseText: '{"result":{"id":"task-2"}}',
      responseJson: { result: { id: 'task-2' } },
      error: 'A2A task timed out'
    }),
    {
      ok: true,
      statusCode: 200,
      elapsedMs: 60000,
      taskId: 'task-2',
      state: 'working',
      contextId: 'ctx-2',
      pending: true,
      response: 'A2A task accepted and still running',
      responseText: '{"result":{"id":"task-2"}}',
      error: ''
    }
  );
});

test('topologyRuntimeErrorFromLogLines extracts target auth failures', () => {
  const error = topologyRuntimeErrorFromLogLines([
    { stream: 'stdout', line: '\u001b[3m[A2A] Processing task task-1 with new temporary context\u001b[0m' },
    { stream: 'stderr', line: 'A0: litellm.AuthenticationError: AuthenticationError: OpenrouterException - {"error":{"message":"No cookie auth credentials found","code":401}}' },
    { stream: 'stdout', line: '\u001b[3m[A2A] Error processing task task-1: litellm.AuthenticationError: AuthenticationError: OpenrouterException - {"error":{"message":"No cookie auth credentials found","code":401}}\u001b[0m' }
  ], 'task-1');

  assert.equal(error, 'Target runtime auth failed: OpenRouter 401: No cookie auth credentials found');
});

test('topologyLatestRunningA2aTaskIdFromLogLines recovers the latest unfinished task', () => {
  const runningTaskId = '22222222-2222-4222-8222-222222222222';
  assert.equal(topologyLatestRunningA2aTaskIdFromLogLines([
    { stream: 'stdout', line: '\u001b[3m[A2A] Processing task 11111111-1111-4111-8111-111111111111 with new temporary context\u001b[0m' },
    { stream: 'stdout', line: '\u001b[3m[A2A] Completed task 11111111-1111-4111-8111-111111111111 and cleaned up context\u001b[0m' },
    { stream: 'stdout', line: `\u001b[3m[A2A] Processing task ${runningTaskId} with new temporary context\u001b[0m` },
    { stream: 'stdout', line: 'A0: Response from tool search_engine' }
  ]), runningTaskId);

  assert.equal(topologyLatestRunningA2aTaskIdFromLogLines([
    { stream: 'stdout', line: `[A2A] Processing task ${runningTaskId} with new temporary context` },
    { stream: 'stdout', line: `[A2A] Error processing task ${runningTaskId}: failed` }
  ]), '');

  assert.equal(topologyLatestRunningA2aTaskIdFromLogLines([
    { stream: 'stdout', line: `2026-06-25T10:00:00.000000000Z [A2A] Processing task 33333333-3333-4333-8333-333333333333 with new temporary context` },
    { stream: 'stdout', line: `2026-06-25T10:02:00.000000000Z [A2A] Processing task ${runningTaskId} with new temporary context` }
  ], '2026-06-25T10:01:00.000Z'), runningTaskId);

  assert.equal(topologyLatestRunningA2aTaskIdFromLogLines([
    { stream: 'stdout', line: `2026-06-25T10:00:00.000000000Z [A2A] Processing task ${runningTaskId} with new temporary context` }
  ], '2026-06-25T10:01:00.000Z'), '');
});

test('topologyContainerIdsForMessageDirection follows reverse edge direction', () => {
  const edge = {
    source: topologyNodeIdForLocal('abcdef'),
    target: topologyNodeIdForLocal('123456'),
    mode: 'local_network'
  };

  assert.deepEqual(
    topologyContainerIdsForMessageDirection(edge, edge.target, edge.source),
    {
      fromContainerId: '123456',
      toContainerId: 'abcdef'
    }
  );
});
