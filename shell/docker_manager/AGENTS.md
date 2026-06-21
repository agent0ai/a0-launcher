# AGENTS

## Purpose

`shell/docker_manager/` owns Agent Zero instance orchestration above the generic
Docker adapter.

It turns releases, images, containers, storage volumes, retained instances,
remote instances, settings, and progress into a stable product-level state model
for the renderer.

## Ownership

This scope owns:

- `index.js`: Docker Manager service, state assembly, install/sync/start/stop,
  activation, rollback, retained-instance, remote-instance, per-container clone
  and log inspection, port, storage, developer custom-image runs, runtime setup,
  and progress operations.
- `state_store.js`: persisted launcher state under Electron `userData`,
  including preferences, remote instances, and local instance display names.
- `releases_client.js`: GitHub release discovery for Agent Zero backend
  versions.
- `release_tags.js`: shared validation and ordering for Agent Zero release tags.
- `retention.js`: retained instance pruning policy.
- `errors.js`: stable UI-facing error response and Docker diagnostic mapping.

## Local Contracts

- Docker access must go through `getDocker()` from `shell/docker_adapter`.
- Backend image repo defaults to `agent0ai/agent-zero` and may be overridden by
  `A0_BACKEND_IMAGE_REPO`.
- Backend GitHub repo defaults to `agent0ai/agent-zero` and may be overridden by
  `A0_BACKEND_GITHUB_REPO`.
- Installable tags must be safe tags and limited to semver-like release tags
  (`vX.Y` or `vX.Y.Z`), channel tags (`latest`, `ready`, `testing`), or
  canonical local tags (`local`, `development`, `main`).
- Activation can target installed local builds, but still must reject unsafe tag
  strings.
- Developer custom-image runs may target safe arbitrary Docker image
  repositories and tags. Validate image names, tags, environment variables,
  port mappings, and mounts before Dockerode sees them; label created containers
  with `a0.launcher.role=developer` so the Instances tab can manage them.
- UI URLs should be derived from inspected port bindings and verified where
  practical before opening.
- Containers may be enriched with bounded runtime source metadata from the
  Agent Zero checkout inside the container. Keep the Docker image tag as
  provenance, and expose runtime branch/commit as separate structured state.
- Start, switch, and run flows should give the Agent Zero UI enough time to
  finish a slow first boot before rolling back a newly-created container.
- UI readiness probes should also allow enough time for a local Agent Zero HTTP
  response to produce headers on slower Windows/WSL loopback paths; avoid
  per-attempt timeouts that create false failed starts while the UI is reachable.
- Prefer structured state over renderer-side inference. If the UI needs a
  status, add it to the Docker Manager state shape.
- Runtime diagnostics for the Advanced tab belong in the Docker Manager state
  shape as sanitized `runtimeDiagnostics`, sourced from Docker adapter
  inspection rather than renderer guesses.
- Persist user preferences and remote instances through `state_store.js`; do not
  invent parallel files.
- Local instance display-name overrides are persisted through `state_store.js`
  because Docker labels on existing containers cannot be mutated safely.
- Port preferences are stored as UI and SSH host-port preferences.
- Workspace storage preferences are stored as `mode`, `hostRoot`, and
  `volumePrefix`. The default mode is `host_directory`, default root is
  `~/agent-zero`, and every new launcher-managed local container must mount a
  per-instance workspace at `/a0/usr` unless the user explicitly selects the
  no-volume ephemeral workspace mode for that run.
- Instance defaults are stored as Main, Utility, and Embedding provider/model
  preferences with optional local API keys for new Instances.
- Runtime endpoint selection is stored as a launcher-local Docker endpoint
  preference. It may be set from the setup modal when multiple usable endpoints
  are detected, and all Docker Manager operations should continue through the
  selected endpoint while it remains reachable.
- Retention policy is stored as a retained-instance count.
- Remote instances must normalize and validate URLs before persistence.
- Retained local containers are rollback targets and should keep enough metadata
  for the renderer to display them without re-inspecting every container
  needlessly.
- Storage-volume operations must remain separate from retained-instance
  activation/removal and from container deletion. Deleting an instance must not
  remove its host workspace directory or named volume.
- Host-directory workspace paths may be resolved for the shell-owned
  `Open storage folder` action. Named Docker volumes should stay represented as
  Docker volumes rather than guessed host paths.
- Long-running operations return an operation id and emit progress.
- Image installs may target Docker channel tags (`latest`, `ready`, `testing`)
  in addition to semver releases and local development tags, because first-run
  setup uses `latest` as the default image choice.
- Progress payloads may include `headline`, `detail`, `phase`, `steps`, and
  `indeterminate` in addition to the legacy `message` and numeric progress
  fields. Runtime setup progress uses those fields for the blocking startup
  modal.
- Renderer-visible setup progress copy should use `Setup`, not `Set up`,
  `Set Up`, or `Setting up`; internal identifiers may stay `setup`.
- Progress payloads may include `canCancel`; set it only while a user cancel
  action can actually abort the current operation phase, such as an active image
  pull.
- When a product operation fails for a recoverable reason, progress payloads
  should carry a stable error code so the renderer can show the right recovery
  action without parsing human-readable copy.
- Runtime setup is additive and reuse-first: existing Docker Desktop, native
  Engine, and rootless endpoints are used before Linux Engine provisioning is
  offered.
- Runtime setup may persist a `runtimeSetupResume` marker under the Docker
  Manager state file so reboot-required Windows setup can relaunch once and
  continue when the next step no longer needs elevation.
- Windows RunOnce resume commands must work for both packaged apps and local
  default-app Electron launches. If Electron injects flags before the app path,
  skip those flags and preserve the first non-option app path.
- Windows WSL setup may complete an intermediate step such as feature enablement
  or distro installation. Preserve the follow-up message instead of reporting
  the runtime as ready prematurely.
- Windows WSL setup can continue from distro installation into Docker Engine
  installation when the distro is immediately usable; if Windows requires a
  restart or first-run distro setup, report that as the next step.
- Linux runtime setup may install/start Docker Engine, then report
  `needs_relogin` when docker group access cannot apply to the current desktop
  session yet. Do not introduce CPU, memory, or disk sizing controls for native
  Linux Engine.
- Progress messages should be user-oriented: `Starting selected version`, not
  raw Docker implementation chatter.
- Running an installed image from Installs should create a new launcher-managed
  container with a unique Docker name and open host ports, so repeated runs of
  the same image can coexist.
- Running, active-instance creation, developer custom-image runs, and clones
  should label workspace storage metadata and use Docker `Mounts` for the
  canonical `/a0/usr` mount. Explicit ephemeral runs should still be labeled
  with storage metadata even though they do not receive the mount. Clones must
  receive a fresh workspace rather than reusing the source workspace mount.
- Per-container start/stop/delete/clone/rename actions from the Instances card
  menu still belong in this product layer. Container mutations must target the
  requested container id, return an operation id, refresh state afterward, and
  keep storage-volume deletion separate from container deletion. Rename is a
  fast launcher metadata update and may return synchronously.
- Per-container log inspection belongs in this product layer as a bounded
  read-only snapshot. It may not expose generic Docker commands to the renderer.
- Cloning an instance should snapshot the source container, create a new
  launcher-managed container from that snapshot, and remap published ports to
  Docker-assigned open host ports.
- Persisting `/a0/usr` data for a legacy or intentional ephemeral instance
  should be explicit. Create a persistent replacement, preserve the old
  container until the replacement starts successfully, copy `/a0/usr` through
  the Docker adapter archive path when possible, and include source/replacement
  names in the completion progress payload for the renderer notice.
- Cancellation should be best-effort and explicit about whether the active Docker
  operation can actually stop.
- Destructive flows should require renderer acknowledgement when the active
  instance may be replaced or data may be affected.
- Error responses should pass through `toErrorResponse()` and map common Docker
  diagnostics to useful UI messages.

## Work Guidance

- Keep Docker Manager as the product layer. Low-level Docker quirks belong in
  `shell/docker_adapter`.
- Use helper functions for repeated tag, URL, digest, and port normalization.
- Keep release matching digest-aware so the UI can distinguish installed images
  that match or differ from published releases.
- If a new persisted field is introduced, document its shape here and keep
  migration/default behavior tolerant of older state files.

## Verification

After changes here, run:

```bash
node --check shell/docker_manager/index.js
node --check shell/main.js
git diff --check
```

For changes touching state persistence, also exercise the affected path in a
local launcher run.

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
