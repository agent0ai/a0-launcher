import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeTopologyNodeIdsFromTabs,
  activityEventsFromLogs,
  edgeStatusLabel,
  graphElementsFromState,
  installedRunnableVersions,
  topologyStructureKey,
  topologyState
} from './topology-model.js';

test('graphElementsFromState maps topology nodes and edges to Cytoscape elements', () => {
  const state = {
    topology: {
      nodes: [
        {
          id: 'local:abcdef',
          kind: 'local',
          label: 'Local A',
          role: 'coordinator',
          position: { x: 10, y: 20 },
          instanceColor: 'green',
          state: 'running',
          versionTag: 'latest'
        },
        {
          id: 'remote:remote_1',
          kind: 'remote',
          label: 'Remote B',
          role: 'worker',
          url: 'https://a0.example.com/'
        }
      ],
      edges: [
        {
          id: 'edge_1',
          source: 'local:abcdef',
          target: 'remote:remote_1',
          mode: 'metadata',
          status: 'metadata',
          label: 'Reference link'
        }
      ]
    }
  };

  const elements = graphElementsFromState(state);

  assert.equal(elements.length, 3);
  assert.deepEqual(elements[0].position, { x: 10, y: 20 });
  assert.equal(elements[0].data.label, 'Local A');
  assert.equal(elements[0].data.subtitle, 'running - latest');
  assert.equal(elements[1].classes.includes('remote-node'), true);
  assert.equal(elements[2].data.label, 'Reference');
});

test('edgeStatusLabel names connection states', () => {
  assert.equal(edgeStatusLabel({ status: 'connected' }), 'Connected');
  assert.equal(edgeStatusLabel({ status: 'missing_network' }), 'Network missing');
  assert.equal(edgeStatusLabel({ mode: 'local_network' }), 'Ready');
});

test('topologyState and installedRunnableVersions normalize optional state', () => {
  assert.deepEqual(topologyState({}).nodes, []);
  assert.deepEqual(installedRunnableVersions({
    versions: [
      { id: 'latest', displayVersion: 'Latest', availability: 'installed' },
      { id: 'v1', displayVersion: '1.0', availability: 'available' },
      { id: 'custom', displayVersion: 'custom', availability: 'update_available' }
    ]
  }).map((version) => version.id), ['latest', 'custom']);
});

test('topologyStructureKey ignores layout and status-only refresh changes', () => {
  const base = {
    nodes: [
      { id: 'local:a', kind: 'local', label: 'A', position: { x: 10, y: 20 } },
      { id: 'local:b', kind: 'local', label: 'B', position: { x: 80, y: 30 } }
    ],
    edges: [
      { id: 'edge_1', source: 'local:a', target: 'local:b', mode: 'local_network', status: 'ready' }
    ]
  };
  const moved = {
    nodes: [
      { id: 'local:a', kind: 'local', label: 'A', position: { x: 250, y: 180 } },
      { id: 'local:b', kind: 'local', label: 'B', position: { x: 420, y: 210 } }
    ],
    edges: [
      { id: 'edge_1', source: 'local:a', target: 'local:b', mode: 'local_network', status: 'connected' }
    ]
  };
  const added = {
    ...base,
    nodes: [...base.nodes, { id: 'remote:r1', kind: 'remote', label: 'R1' }]
  };

  assert.equal(topologyStructureKey(base), topologyStructureKey(moved));
  assert.notEqual(topologyStructureKey(base), topologyStructureKey(added));
});

test('activeTopologyNodeIdsFromTabs maps open instance tabs to topology nodes', () => {
  assert.deepEqual(activeTopologyNodeIdsFromTabs({
    instanceTabs: {
      activeTabId: 'tab-2',
      tabs: [
        { id: 'tab-1', kind: 'local', containerId: 'abcdef', active: false, loading: false },
        { id: 'tab-2', kind: 'remote', instanceId: 'remote_1', active: false, loading: true },
        { id: 'tab-3', kind: 'local', containerId: 'abcdef', active: false, loading: true },
        { id: 'tab-4', kind: 'unknown', containerId: 'ignored', active: true }
      ]
    }
  }), [
    { nodeId: 'local:abcdef', active: false, loading: true },
    { nodeId: 'remote:remote_1', active: true, loading: true }
  ]);
});

test('activityEventsFromLogs distills recent Agent Zero runtime activity', () => {
  const events = activityEventsFromLogs({
    lines: [
      { line: '2026-06-25T12:00:00.000Z [A2A] Processing task 11111111-1111-4111-8111-111111111111' },
      { line: "2026-06-25T12:00:01.000Z [38;2;0;0;255mA0: Using tool 'search_engine'[0m" },
      { line: "2026-06-25T12:00:02.000Z A0: Response from tool 'search_engine'" },
      { line: "2026-06-25T12:00:03.000Z A0: Code: print('done')" },
      { line: '2026-06-25 12:00:03,500 INFO reaped unknown pid 1914 (exit status 0)' },
      { line: '2026-06-25T12:00:03.750Z "tool_args": {' },
      { line: '2026-06-25T12:00:04.000Z Info: Detected shell prompt, returning output early.' },
      { line: '2026-06-25T12:00:05.000Z [A2A] Completed task 11111111-1111-4111-8111-111111111111' }
    ]
  }, 6);

  assert.deepEqual(events.map((event) => [event.kind, event.title, event.detail]), [
    ['done', 'A2A task completed', '11111111'],
    ['shell', 'Shell ready', ''],
    ['code', 'Executing code', "print('done')"],
    ['response', 'Tool response', 'search_engine'],
    ['tool', 'Using tool', 'search_engine'],
    ['a2a', 'A2A task started', '11111111']
  ]);
  assert.equal(events[0].time, '12:00:05');
  assert.equal(events[4].full, "A0: Using tool 'search_engine'");
});
