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
  selection, fixed setup step modeling, fixed command execution, native
  authorization script construction, Dockerode-backed setup verification,
  launcher-owned socket fallback selection, and sanitized command output
  handling.
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
- Runtime setup metadata is stored as top-level `runtimeSetup` with only
  sanitized fields: `runtimeBackend`, `machineName`, `dockerHostOverride`,
  `usesDefaultDockerSocket`, and `lastSuccessfulSetupAt`.
- `dockerHostOverride` accepts an empty value, Unix socket paths, `unix:`
  socket URLs, and root-only `tcp:`, `http:`, or `https:` daemon URLs. Network
  daemon URLs must not persist ignored path, query, fragment, or credential
  components.
- When runtime setup persists `usesDefaultDockerSocket: true` with an empty
  `dockerHostOverride`, Docker Manager must pass an explicit empty `dockerHost`
  to the adapter so the default socket is used instead of `process.env.DOCKER_HOST`.
  If no runtime setup/default-socket state is saved, preserve the environment
  fallback.
- Runtime setup success must be verified through the Docker adapter/Dockerode
  before metadata is persisted. After Podman setup steps complete, verify the
  default Docker socket first. If that fails, derive the selected Podman
  machine API socket from `podman machine inspect`, verify that socket through
  the adapter, and persist the sanitized `dockerHostOverride` only after that
  verification succeeds. If both paths fail, fail setup with `VERIFY_FAILED`.
- A runtime setup no-op because Docker is already available must preserve the
  existing runtime metadata as-is, including `lastSuccessfulSetupAt`. It must
  not infer or persist `usesDefaultDockerSocket: true` unless setup actually
  selected or verified the default socket.
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
- Runtime setup runs as `_currentOperation` with `type: "runtime_setup"`.
  `index.js` owns the operation id, abort controller, progress forwarding,
  setup result persistence, and Docker Manager refresh after setup.
- Runtime setup progress may include only user-facing `message`, stable
  `setupStep`, and stable `setupCode` strings. Raw stdout/stderr stays inside
  `runtime_setup.js` after redaction.
- Runtime setup must check for pre-canceled, Docker-ready, and unsupported
  platform cases before probing Homebrew, package formulae, or Podman machines.
  Probe commands that do run must receive the operation abort signal.
- Runtime setup must re-check cancellation after final Dockerode verification,
  after Podman socket derivation, and before persisting successful metadata or
  marking the operation completed.
- Runtime setup steps must resolve Homebrew-derived command paths lazily and
  only for steps that need them; step-time `findBrewPath` and
  `brew --prefix podman` calls must receive the operation abort signal.
- Runtime setup package installation may treat a Homebrew install failure as
  successful only after re-reading installed formulae and confirming every
  required formula is present. This covers Homebrew link/shadow conflicts that
  leave the formulae installed but return a failing install command.
- After installing the Podman macOS helper, runtime setup must best-effort run
  `docker context use default` so an existing Docker Desktop context does not
  keep the user-facing Docker CLI pointed at `~/.docker/run/docker.sock` while
  `/var/run/docker.sock` points to Podman. This context step must not block
  setup if the Docker CLI cannot switch context; final runtime readiness is
  still determined by Dockerode verification.
- Runtime setup command execution must terminate the command tree on
  cancellation. On non-Windows platforms, fixed setup commands run in a detached
  process group and abort sends `SIGTERM` to the negative process id so
  subprocesses such as the Homebrew `curl | /bin/bash` pipeline do not continue
  after cancellation. On Windows, cancellation remains a best-effort direct
  child termination because the macOS setup path is the target runtime.
- The runtime setup command graph is fixed: Homebrew install uses `/bin/bash`
  with `-c "/usr/bin/curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash"`
  and `NONINTERACTIVE=1`; package and machine work uses Homebrew and Podman
  commands selected by the setup plan; native authorization uses
  `/usr/bin/osascript -e <script>` with the helper path derived from
  `brew --prefix podman`; Docker CLI context selection uses
  `docker context use default` when possible; final runtime verification uses
  the Docker adapter/Dockerode instead of the Docker CLI.
- Runtime setup must not collect or store sudo passwords. It must not stop,
  rootful-toggle, or otherwise mutate an active external Podman machine; the
  planner blocks that case with `PODMAN_MACHINE_EXISTS`.

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
node --check shell/preload.js
node --test shell/docker_manager/runtime_setup.test.js
git diff --check
```

For changes touching state persistence, also exercise the affected path in a
local launcher run.

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
