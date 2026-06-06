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
  activation, rollback, retained-instance, remote-instance, port, storage, and
  progress operations. Runtime setup operation/progress integration belongs
  here; setup planning and command execution belong in `runtime_setup.js`.
- `runtime_setup.js`: macOS runtime setup planning, Homebrew/Podman machine
  selection, fixed setup step modeling, command execution helpers, and sanitized
  command output handling.
- `runtime_setup.test.js`: pure planner and sanitization coverage for runtime
  setup. Tests must not install Homebrew, run Podman, or mutate the host.
- `state_store.js`: persisted launcher state under Electron `userData`.
- `releases_client.js`: GitHub release discovery for Agent Zero backend
  versions.
- `retention.js`: retained instance pruning policy.
- `errors.js`: stable UI-facing error response and Docker diagnostic mapping.

## Local Contracts

- Docker access must go through `getDocker()` from `shell/docker_adapter`.
- Backend image repo defaults to `agent0ai/agent-zero` and may be overridden by
  `A0_BACKEND_IMAGE_REPO`.
- Backend GitHub repo defaults to `agent0ai/agent-zero` and may be overridden by
  `A0_BACKEND_GITHUB_REPO`.
- Installable tags must be safe tags and limited to semver release tags,
  `testing`, or canonical local tags (`local`, `development`, `main`).
- Activation can target installed local builds, but still must reject unsafe tag
  strings.
- UI URLs should be derived from inspected port bindings and verified where
  practical before opening.
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
- Progress messages should be user-oriented: `Starting selected version`, not
  raw Docker implementation chatter.
- Cancellation should be best-effort and explicit about whether the active Docker
  operation can actually stop.
- Destructive flows should require renderer acknowledgement when the active
  instance may be replaced or data may be affected.
- Error responses should pass through `toErrorResponse()` and map common Docker
  diagnostics to useful UI messages.
- macOS runtime setup must stay shell-owned and fixed-step. Renderer code may
  request setup intent through named IPC only; it must never provide arbitrary
  commands or receive unsanitized command output.

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
node --check shell/docker_manager/runtime_setup.js
node --check shell/main.js
node --test shell/docker_manager/runtime_setup.test.js
git diff --check
```

For changes touching state persistence, also exercise the affected path in a
local launcher run.

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
