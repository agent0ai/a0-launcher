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
  activation, rollback, retained-instance, remote-instance, port, storage,
  runtime setup, and progress operations.
- `state_store.js`: persisted launcher state under Electron `userData`.
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
  (`vX.Y` or `vX.Y.Z`), `testing`, or canonical local tags (`local`,
  `development`, `main`).
- Activation can target installed local builds, but still must reject unsafe tag
  strings.
- UI URLs should be derived from inspected port bindings and verified where
  practical before opening.
- Start, switch, and activation flows should give the Agent Zero UI enough time
  to finish a slow first boot before rolling back a newly-created container.
- Prefer structured state over renderer-side inference. If the UI needs a
  status, add it to the Docker Manager state shape.
- Persist user preferences and remote instances through `state_store.js`; do not
  invent parallel files.
- Port preferences are stored as UI and SSH host-port preferences.
- Retention policy is stored as a retained-instance count.
- Remote instances must normalize and validate URLs before persistence.
- Retained local containers are rollback targets and should keep enough metadata
  for the renderer to display them without re-inspecting every container
  needlessly.
- Storage-volume operations must remain separate from retained-instance
  activation/removal.
- Long-running operations return an operation id and emit progress.
- Runtime setup is additive and reuse-first: existing Docker Desktop, native
  Engine, and rootless endpoints are used before Linux Engine provisioning is
  offered.
- Runtime setup may persist a `runtimeSetupResume` marker under the Docker
  Manager state file so reboot-required Windows setup can relaunch once and
  continue when the next step no longer needs elevation.
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
