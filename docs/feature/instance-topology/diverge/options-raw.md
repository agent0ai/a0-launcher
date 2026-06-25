# Instance Topology Brainstorm

## HMW Question

How might we help users confidently shape multiple Agent Zero Instances into a
working collaboration map while keeping container networking explicit,
recoverable, and understandable?

## SCAMPER Options

### Option 1: Network Fabric

**Core idea**: Users draw links between Instance nodes, then choose `Connect locally`
to place local Docker Instances on a launcher-managed network and receive stable
internal A2A endpoint hints.
**Key mechanism**: A topology canvas is backed by persisted graph metadata and
named Docker Manager intents for user-defined bridge network creation,
connect/disconnect, aliases, and handoff copy.
**Key assumption**: Users want the canvas to control real local reachability, but
they still prefer to finish A2A setup inside Agent Zero.
**SCAMPER origin**: Substitute.
**Closest competitor**: Docker Desktop network view plus n8n-style node linking.

### Option 2: Instance Workspace

**Core idea**: The topology page merges the Instances list, clone flow, remote
Instance creation, and Open UI access into one spatial workspace.
**Key mechanism**: Existing Instance cards become compact graph nodes with a side
inspector that reuses current card actions and create dialogs.
**Key assumption**: Users will understand and manage multi-Instance systems
better when the topology page replaces, not supplements, repeated list
navigation.
**SCAMPER origin**: Combine.
**Closest competitor**: Docker Desktop containers view combined with Miro-style
diagramming.

### Option 3: Service Map

**Core idea**: Users see a topology that feels like an infrastructure service
map: healthy Instances, remote endpoints, network groups, and readiness status.
**Key mechanism**: The graph uses runtime inventory, Docker network inspection,
and status overlays rather than workflow-editor affordances.
**Key assumption**: Users primarily need confidence about what is reachable and
running before they need rich graph editing.
**SCAMPER origin**: Adapt.
**Closest competitor**: Datadog service maps or Kubernetes Lens topology views.

### Option 4: Collaboration Studio

**Core idea**: The topology page makes agent collaboration the primary object,
with roles, directional handoffs, and A2A endpoint guidance emphasized on every
edge.
**Key mechanism**: Each node carries a role label and each edge carries a
communication mode, endpoint hint, and setup checklist.
**Key assumption**: The main user value is not Docker networking itself, but
feeling in control of a multi-agent collaboration.
**SCAMPER origin**: Modify/Magnify.
**Closest competitor**: LangGraph Studio or crew/workflow builders.

### Option 5: Shareable Blueprint

**Core idea**: Users design a topology that can be saved, exported, imported, or
used as a repeatable blueprint for future Agent Zero setups.
**Key mechanism**: Persist graph nodes, edges, role labels, layout, and optional
local Docker network bindings separately from live container state.
**Key assumption**: Users will want to reuse and exchange multi-Instance
patterns, not only configure the current machine.
**SCAMPER origin**: Put to other use.
**Closest competitor**: Docker Compose files or Terraform diagrams.

### Option 6: Connect Wizard

**Core idea**: Users never manipulate networks directly; the topology page offers
a focused wizard that asks which Instances should communicate and then shows the
resulting map.
**Key mechanism**: The graph is generated from wizard selections, with simple
undo/disconnect actions and no freeform canvas editing in v1.
**Key assumption**: A guided path prevents topology mistakes better than a
general graph editor.
**SCAMPER origin**: Eliminate.
**Closest competitor**: Docker Compose setup wizards.

### Option 7: Discovery First

**Core idea**: The launcher discovers existing local Docker networks and Agent
Zero endpoints first, then invites users to name, group, or connect what is
already there.
**Key mechanism**: The topology starts as a read-only discovered graph and
progressively unlocks create/connect actions.
**Key assumption**: Users are more likely to trust a topology that reflects real
state before it lets them change that state.
**SCAMPER origin**: Reverse.
**Closest competitor**: Network discovery diagrams in infrastructure tools.

## Crazy 8s Supplements

### Option 8: Mission Board

**Core idea**: Users create a mission and attach Instances as workers, reviewers,
or observers; the topology is generated from those collaboration roles.
**Key mechanism**: Role templates define recommended nodes, edges, labels, and
A2A setup hints.
**Key assumption**: Users think in terms of outcomes and delegated work more
than networks.
**SCAMPER origin**: Crazy 8s supplement.
**Closest competitor**: CrewAI-style crew builders.

### Option 9: Edge Checklist

**Core idea**: Users draw edges freely, but each edge becomes a checklist card:
network connected, endpoint reachable, A2A configured, last verified.
**Key mechanism**: Edge state is richer than node state, turning communication
readiness into the main workflow.
**Key assumption**: The hardest part is knowing whether a link actually works,
not creating the nodes.
**SCAMPER origin**: Crazy 8s supplement.
**Closest competitor**: CI status checks for dependency graphs.

### Option 10: Sandbox Lab

**Core idea**: Users can create temporary topology experiments with disposable
Instances and tear them down as a group.
**Key mechanism**: The graph owns a scoped lab network, lab Instances, and a
single cleanup action that preserves regular launcher Instances.
**Key assumption**: Users will explore multi-agent patterns safely if cleanup is
obvious and bounded.
**SCAMPER origin**: Crazy 8s supplement.
**Closest competitor**: Ephemeral development environments.

## Curated 6

### Curated Option 1: Network Fabric

**Different mechanism?** Yes: direct graph-to-Docker network operations.
**Different user assumption?** Users want visible topology to control real local
reachability.
**Different cost/effort profile?** Medium-high: requires Docker network
orchestration, persistence, UI, and handoff states.

### Curated Option 2: Instance Workspace

**Different mechanism?** Yes: spatial replacement for the current Instances
management surface.
**Different user assumption?** Users prefer one workspace for create, inspect,
open, and connect.
**Different cost/effort profile?** High: broad UI integration and potential
overlap with existing tabs.

### Curated Option 3: Service Map

**Different mechanism?** Yes: discovered operational topology with constrained
actions.
**Different user assumption?** Users need truth and status before editing.
**Different cost/effort profile?** Medium: strong read model, lighter write
surface.

### Curated Option 4: Collaboration Studio

**Different mechanism?** Yes: role/edge semantics drive A2A handoff, not just
container networking.
**Different user assumption?** Users are designing agent collaboration rather
than Docker topology.
**Different cost/effort profile?** Medium: mostly renderer and metadata in v1,
with Docker connect actions added carefully.

### Curated Option 5: Connect Wizard

**Different mechanism?** Yes: guided selections create the map rather than
freeform editing.
**Different user assumption?** Users want safety and fewer topology decisions.
**Different cost/effort profile?** Low-medium: simpler UI, less expressive.

### Curated Option 6: Edge Checklist

**Different mechanism?** Yes: edge readiness checklist is the primary workflow.
**Different user assumption?** Users need proof that a communication path is
ready.
**Different cost/effort profile?** Medium: requires edge state model, network
inspection, endpoint hints, and later verification hooks.

## Eliminated Options

- **Shareable Blueprint**: Kept as a later capability, but merged into the
  persistence model behind Network Fabric and Collaboration Studio for v1.
- **Discovery First**: Important behavior, but best treated as the empty/loading
  state of Service Map rather than a separate product direction.
- **Mission Board**: Useful future template layer, but too far from the
  requested topology/control surface for v1.
- **Sandbox Lab**: Valuable for experimentation, but creates a separate lifecycle
  model and teardown semantics that should not be coupled to the first topology
  release.
