# Instance Topology Design

Date: 2026-06-24

## Goal

Add a separate **Topology** page to the A0 Launcher where users can arrange
Agent Zero Instances as nodes, connect them with edges, and safely turn
local-to-local edges into real Docker reachability. The launcher should help
users build a collaboration map without hiding Docker-side consequences or
silently mutating Agent Zero runtime configuration.

## Approved Direction

Use **Choice A: Hybrid Topology Workspace**.

The first version is a topology/control surface:

- Show local and remote Instances as graph nodes.
- Let users create new nodes through explicit Fresh Instance, Clone selected
  Instance, or Add remote Instance choices.
- Let users save intended edges between nodes.
- For local-to-local edges, offer explicit `Connect locally` and `Disconnect`
  actions that use launcher-managed Docker networking.
- For connected local edges, show stable internal aliases and A2A setup handoff
  hints.
- For remote edges, save metadata only and avoid implying the launcher can
  mutate a remote host.

## Library Decision

Use **Cytoscape.js** for v1.

Rationale:

- The launcher renderer is static HTML, CSS, and ES modules served through the
  Electron shell. It is not React-based.
- Cytoscape.js is a plain JavaScript graph/network visualization library with
  interaction, layouts, styling, and graph operations that match topology work.
- React Flow is strong for React workflow editors with custom React component
  nodes, rich handles, and React-owned state, but adopting it here would add a
  React stack only for this page.

Implementation should vendor Cytoscape.js into a local renderer-visible path
instead of loading it from a CDN. No React dependency should be added for this
feature.

References reviewed:

- Cytoscape.js documentation: https://js.cytoscape.org/
- React Flow documentation: https://reactflow.dev/
- Docker networking overview: https://docs.docker.com/engine/network/
- Agent Zero MCP and A2A integration docs:
  https://www.agent-zero.ai/p/docs/mcp-a2a/

## Product UX

The **Topology** tab appears beside Installs, Instances, Advanced, and Settings.
It opens directly into the usable graph workspace, not a landing page.

Primary layout:

- Center: Cytoscape canvas with pan, zoom, drag, select, fit view, and compact
  node/edge status styling.
- Top toolbar: `New node`, `Connect`, `Disconnect`, `Fit`, and `Refresh`.
- Right inspector: selected node or selected edge details, available actions,
  and A2A handoff hints.

Node behavior:

- Existing local Docker Instances appear automatically.
- Existing saved remote Instances appear automatically.
- Running local nodes show `Open UI`, status, color identity, runtime label, and
  local URL.
- Stopped local nodes show `Start`.
- Remote nodes show `Open UI` and the saved URL, but no Docker mutation
  controls.
- Node colors reuse existing bounded Instance color metadata.
- Each node may have a short user-editable role label, such as `Planner` or
  `Reviewer`, stored only as launcher topology metadata.

New node behavior:

- `New node` opens a compact create dialog.
- The dialog offers Fresh Instance, Clone selected Instance, and Add remote
  Instance.
- Fresh Instance reuses the existing installed-image run path.
- Clone selected Instance reuses the existing clone path and `/a0/usr` category
  selection behavior.
- Add remote Instance reuses the existing remote Instance dialog.
- The topology page must not guess which of those three actions the user meant.

Edge behavior:

- Creating an edge first saves an intended link.
- A local-to-local edge inspector offers `Connect locally`.
- A connected local edge shows the Docker network name, stable aliases, and
  copyable A2A endpoint hints.
- A remote edge remains metadata-only in v1 and shows handoff guidance rather
  than connection controls.
- Unsupported combinations should be explicit and calm, not hidden.

Empty state:

- When no Instances exist, the topology page should invite the user to create a
  Fresh Instance or add a remote Instance.
- Copy should stay short and task-oriented.
- No mandatory walkthrough.

First success:

- When a local edge becomes connected, the inspector shows `Local network ready`
  and the A2A handoff hints.

## Architecture

Renderer:

- Add `app/components/docker-manager/topology/`.
- Add a Topology tab entry to the sidebar and app tab content.
- Keep component scripts idempotent and state-driven.
- Read state from `dm:state` and `window.__dmLastState`.
- Invoke behavior only through named `window.dockerManagerActions`.
- Keep topology styles in `app/docker_manager.css` unless a new component-local
  pattern is already established.

Renderer coordination:

- Extend `app/components/docker-manager/docker-manager-store.js` with
  `topology`.
- Extend the snapshot in `app/docker_manager.js` to include topology state.
- Add actions such as:
  - `saveTopologyLayout`
  - `createTopologyEdge`
  - `deleteTopologyEdge`
  - `connectTopologyEdge`
  - `disconnectTopologyEdge`
  - `setTopologyNodeRole`

Preload and shell:

- Add named preload methods under `window.dockerManagerAPI`.
- Add matching validated IPC handlers in `shell/main.js`.
- Do not expose raw Docker networks, Docker commands, shell commands, or file
  paths to the renderer.

Docker Manager:

- Persist topology metadata in `shell/docker_manager/state_store.js`.
- Assemble renderer-visible topology state in `shell/docker_manager/index.js`.
- Own all Docker network creation, connect, disconnect, alias calculation, and
  state refresh behavior.
- Return stable `{ code, message }` error responses through existing error
  response helpers.

## State Model

Persist a `topology` object under the Docker Manager state file.

Shape:

```json
{
  "topology": {
    "version": 1,
    "nodes": {
      "local:<containerId>": {
        "id": "local:<containerId>",
        "kind": "local",
        "refId": "<containerId>",
        "x": 120,
        "y": 80,
        "role": "Planner"
      },
      "remote:<remoteId>": {
        "id": "remote:<remoteId>",
        "kind": "remote",
        "refId": "<remoteId>",
        "x": 420,
        "y": 120,
        "role": "Reviewer"
      }
    },
    "edges": {
      "edge_<id>": {
        "id": "edge_<id>",
        "source": "local:<containerId>",
        "target": "local:<containerId>",
        "mode": "a2a",
        "label": "",
        "status": "intended",
        "networkId": "",
        "aliases": {}
      }
    },
    "updatedAt": "2026-06-24T00:00:00.000Z"
  }
}
```

Derived state:

- The live Docker inventory and saved remote Instances remain authoritative for
  what Instances exist.
- Saved topology metadata owns layout, user-created edges, role labels, edge
  labels, and connection metadata.
- If an Instance exists with no saved node, the renderer shows it using an
  auto-layout position.
- When the user drags a node, the renderer saves its position.
- Deleted local Instance nodes should be cleaned up automatically.
- Deleted remote Instance nodes should follow the saved remote Instance
  lifecycle.

Validation:

- Node IDs use `local:<containerId>` or `remote:<remoteId>`.
- Local references must match known local Instance IDs before live Docker
  operations.
- Remote references must match saved remote Instance IDs.
- Role labels, edge labels, and alias strings are ASCII-normalized and bounded.
- Layout coordinates are finite numbers within practical canvas bounds.

## Docker Network Behavior

Use a launcher-managed user-defined bridge network for v1 topology connections.

Initial policy:

- Create or reuse one default topology network for the launcher workspace.
- Use a predictable name such as `a0-launcher-topology`.
- Add launcher labels to the network so future cleanup and inspection can
  distinguish it from user-created Docker networks.
- Do not attach containers to arbitrary user networks from the topology page in
  v1.

Connect locally:

- Accept only a saved edge whose source and target are local nodes.
- Ensure the topology network exists.
- Connect both containers to the network if needed.
- Assign stable network aliases derived from launcher-safe Instance identifiers.
- Persist edge connection metadata and refresh Docker Manager state.
- Surface aliases and internal HTTP URLs in the edge inspector.

Disconnect:

- Remove edge connection metadata.
- If no remaining connected edge needs a container on the topology network,
  disconnect that container from the topology network.
- Do not stop or delete containers.
- Do not remove workspaces, Storage volumes, or host directories.
- Do not remove the topology network while any topology edge or container still
  depends on it.

Agent Zero runtime config:

- Do not write Agent Zero A2A, MCP, or `/a0/usr` configuration in v1.
- The launcher provides reachability and handoff hints only.
- Users complete A2A setup inside Agent Zero using the displayed internal
  endpoint details.

## Security And Boundaries

- Docker access remains behind IPC and `shell/docker_manager`.
- Renderer code calls only `window.dockerManagerActions`.
- Preload exposes named, narrow methods only.
- IPC bodies are validated in `shell/main.js` before reaching Docker Manager.
- Remote Instance URLs are normalized and never mutated by topology connect
  operations.
- External links stay fixed or validated before shell opening.
- Electron window security remains `contextIsolation: true`,
  `nodeIntegration: false`, and `sandbox: true`.

## Error Handling

Required visible states:

- Loading topology
- Empty topology
- Unplaced discovered Instances
- Edge intended but not connected
- Edge connecting
- Edge connected
- Edge disconnecting
- Unsupported remote edge
- Docker unavailable
- Docker network create/connect/disconnect failure
- Missing source or target Instance

Error copy should explain what happened and the next recovery action. Avoid raw
Docker jargon unless it is necessary for the user to fix the issue.

## Tests And Verification

Add focused tests for:

- Topology state normalization in `state_store.js`.
- Deleted/missing local or remote reference cleanup behavior.
- Local-only connect/disconnect validation.
- Docker Manager topology network creation/reuse behavior.
- Stable alias generation.
- IPC input validation in `shell/main.js` where practical.
- Renderer action facade behavior for topology operations where practical.

Manual verification:

- Start the launcher with local content.
- Open the Topology tab with no Instances.
- Add a remote Instance node.
- Create or run a local Instance node.
- Drag nodes and verify layout persists after refresh.
- Create local-to-local intended edge.
- Connect locally and verify the inspector shows network-ready status and A2A
  handoff hints.
- Disconnect and verify containers are not stopped or deleted.
- Verify remote edges remain metadata-only.

Commands:

```bash
node --check shell/main.js
node --check shell/preload.js
node --check shell/docker_manager/index.js
node --check shell/docker_manager/state_store.js
node --check app/docker_manager.js
node --test shell/instance_tabs.test.js
git diff --check
```

For visible UI changes:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```

## Deferred Work

- Automatic Agent Zero `/a0/usr` A2A or MCP config writes.
- Remote host networking changes.
- Mission templates and role automation.
- Export/import topology blueprints.
- Group teardown or sandbox lab lifecycle.
- Advanced user-selected Docker networks.
- React Flow or broader React migration.
- Runtime verification that an A2A request succeeds end-to-end.

## DOX Updates Needed During Implementation

When implementing this design, update:

- `app/AGENTS.md`
- `app/components/docker-manager/AGENTS.md`
- `shell/AGENTS.md`
- `shell/docker_manager/AGENTS.md`

If `app/components/docker-manager/topology/` grows a substantial local contract,
add a child `AGENTS.md` there and update parent indexes in the same change.
