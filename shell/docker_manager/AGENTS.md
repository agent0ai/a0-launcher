# AGENTS

## Purpose

`shell/docker_manager/` owns Agent Zero instance orchestration above the generic
Docker adapter.

It turns releases, images, containers, storage volumes, retained instances,
remote instances, settings, and progress into a stable product-level state model
for the renderer.

## Ownership

This scope owns:

- `index.js`: Docker Manager service, state assembly,
  install/sync/start/stop/restart, activation, rollback, retained-instance,
  remote-instance, per-container clone and log inspection, port, storage,
  developer custom-image and Docker project runs, runtime setup, and progress
  operations.
- `state_store.js`: persisted launcher state under Electron `userData`,
  including preferences, remote instances, local instance display names, and
  local instance colour/icon overrides, plus Launcher Host access defaults and
  per-Instance configuration, and the A0 Tag opt-in/Instance/profile choice.
- `releases_client.js`: GitHub release discovery for Agent Zero backend
  versions.
- `release_tags.js`: shared validation and ordering for Agent Zero release tags.
- `retention.js`: retained instance pruning policy.
- `errors.js`: stable UI-facing error response and Docker diagnostic mapping.
- `progress.js`: runtime checklist phases and shared image-pull phase progress.

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
- Once an image inventory is scoped to its repository, activation must identify
  the local image by tag, not Docker's presentation-specific image reference.
- Developer custom-image runs may target safe arbitrary Docker image
  repositories and tags. Validate image names, tags, environment variables,
  port mappings, and mounts before Dockerode sees them; label created containers
  with `a0.launcher.role=developer` so the Instances tab can manage them.
- Developer project actions accept only shell-resolved dedicated project roots
  and regular root files. Compose actions are fixed to Validate, Build, Up,
  Stop, Logs, and Down; Dockerfile actions are fixed to Validate and Build.
  Long-running actions use normal progress/cancellation, bound output to 12 KB,
  and Down must not remove storage volumes.
- Runtime-wide local image discovery remains available for Advanced developer
  controls, while normal Create local Instance choices use only Agent Zero
  releases and local Agent Zero builds.
- UI URLs should be derived from inspected port bindings and verified where
  practical before opening.
- Local and saved remote Instances use the same bounded `/api/health` Git
  metadata for runtime identity. Cache the last valid identity by stable
  Instance ID so stopped or temporarily offline Instances retain their
  last-seen version; replace it only after a later successful health response.
  A local Instance without health metadata may show the bounded branch from
  `/a0/.git/HEAD`, but health-derived and cached `R v...` identity remains
  preferred. Keep Docker image tags as separate fallback provenance.
- Channel-tagged images and containers may expose `matchedReleaseTag` when the
  local tag can be tied to a concrete semver release through digest matching or
  local evidence for the current `latest` release tag. For containers, channel
  release labels must respect the container's actual image id so older stopped
  `ready`/`latest` Instances do not inherit a newer repulled channel version.
  Channel Version entries may also expose optional `publishedReleaseTag` and
  `updatedAt` metadata derived from cached Docker Hub tag metadata.
- Start, switch, and run flows should give the Agent Zero UI enough time to
  finish a slow first boot before rolling back a newly-created container.
- New managed Instance run progress should mark `uiReady: true` only after the
  UI readiness probe succeeds. If a created Instance is kept after a readiness
  timeout, leave the completed progress marked not ready so renderer handoffs do
  not fire early.
- Direct `Open UI` resolution may use a shorter bounded wait than start/run
  flows so a fresh running container can finish warming up before showing an
  error.
- UI readiness probes should also allow enough time for a local Agent Zero HTTP
  response to produce headers on slower Windows/WSL loopback paths; avoid
  per-attempt timeouts that create false failed starts while the UI is reachable.
- Running an installed image as a new managed Instance should not delete the
  container merely because the UI readiness probe timed out after the container
  started. Keep the Instance visible and report that Agent Zero is still
  starting; rollback cleanup remains appropriate for update/switch replacement
  flows that must restore a previous active Instance.
- Prefer structured state over renderer-side inference. If the UI needs a
  status, add it to the Docker Manager state shape.
- Docker Manager may log a de-duplicated Instance inventory snapshot for
  diagnostics. Keep it bounded to container identity, image/version/runtime
  fields, UI URL, and managed-label booleans; do not log environment variables,
  credentials, or full container inspect payloads.
- Runtime diagnostics for the Advanced tab belong in the Docker Manager state
  shape as sanitized `runtimeDiagnostics`, sourced from Docker adapter
  inspection rather than renderer guesses.
- Persist user preferences and remote instances through `state_store.js`; do not
  invent parallel files.
- Persist Launcher `onboarding` as `local` or `complete` in that same state
  file. Missing state is `new` unless saved Instance metadata, Host access
  Instance records, health identity history, or discovered Instances establish
  an existing installation. A pending runtime resume implies local intent.
  Merely installed Docker and the legacy Host access onboarding flag do not
  establish completion. Completion survives removal of Instances/images and
  unavailable runtimes; expose it in state and inventory. State-file writes
  serialize and atomically replace the file, preserving the furthest onboarding
  state even when another settings writer read an older snapshot. Read failures
  must remain errors, not new-install signals.
- The Settings page persists port, workspace storage, Instance defaults, Host
  access defaults, and A0 Tag through one combined state-store write and
  cached-state publication. Duplicate ports keep the previous valid port pair
  while the other Settings sections save and report their own success.
- A0 Tag persists only `{ version: 1, enabled, instanceKey, defaultProfile }`.
  Missing state defaults to disabled, malformed fields normalize empty, and an
  incomplete enabled section preserves the previous valid A0 Tag value while
  unrelated Settings sections save. Profiles are discovered live. Shortcut
  registration, status, target/context/result data, and child PIDs are never
  persisted.
- Host access persistence lives in `state_store.js`: compatibility-only
  onboarding state, local defaults, optional default folder, per-Instance
  configured/master state, five permission scopes, browser selection, and the
  stable Launcher installation ID. Child PIDs, connection status, and permission
  readiness are runtime-only. Local records use container IDs and remote records
  use saved remote Instance IDs.
- A local bind mount backing `/a0/usr` is the authoritative Host access folder.
  This includes development containers that bind the whole `/a0` runtime: map
  their host source's `usr` child unless a more specific `/a0/usr` mount masks
  it. Named-volume, ephemeral, and remote Instances require an explicit native
  host folder, prefilled from the Launcher default when available. Remote
  Instances otherwise default to their remote machine and do not acquire
  Launcher host access implicitly.
- Local instance display-name and Colour/Icon overrides are persisted through
  `state_store.js` because Docker labels on existing containers cannot be
  mutated safely. Local colours and icons are stored as container-id keyed
  `localInstanceColors` and `localInstanceIcons` maps. Colours accept preset IDs
  or normalized six-digit RGB hex; icons accept known IDs or bounded image data
  URLs. Use the shared shell normalizers and save image copies into the existing
  state file, never source file paths.
  Empty icon IDs select the live page favicon; `language` explicitly selects
  Globe. Existing nonempty custom icon choices remain authoritative. Live favicon
  image data belongs only to shell tab state and must not enter persistence.
- Optional local and saved remote Instance login credentials are persisted
  through `state_store.js` as id-keyed, Electron-safe-storage encrypted password
  records. The renderer may receive only saved-credential metadata such as saved
  state and username; decrypted passwords must stay in the shell process and be
  used only for explicit local CLI launch, Web UI login, or save/clear
  operations.
- Port preferences are stored as UI and SSH host-port preferences.
- Host-port requests using `0` must be settled to explicit host ports before
  Docker container creation so a container's published port remains stable
  across later starts, deletions of other containers, and new runs. New normal
  launcher-managed local Instances publish on `0.0.0.0` for LAN access.
  Developer/custom-image runs and replacement flows should preserve their
  explicit or inspected host bindings; clones still receive fresh explicit open
  ports so they can run beside the source.
- Workspace storage preferences are stored as `mode`, `hostRoot`,
  `hostPathMode`, and `volumePrefix`. The default mode is `host_directory`,
  default root is `~/agent-zero`, and the default path mode creates a
  per-instance workspace at `/a0/usr` using the Instance name as the host
  folder, with a numeric suffix only when that folder already exists. Exact
  path mode mounts the selected host folder directly at `/a0/usr`. A new
  launcher-managed local container should skip persistent storage only when the
  user explicitly selects the no-volume ephemeral workspace mode for that run.
- Windows WSL Engine bind mounts should keep the Windows host path in launcher
  labels and state, but send Docker a WSL-visible `/mnt/<drive>/...` source path
  for the actual container mount.
- Instance defaults are stored as Main, Utility, and Embedding provider/model
  preferences with optional local API keys for new Instances.
- Runtime endpoint selection is stored as a launcher-local Docker endpoint
  preference. It may be set from the setup modal when multiple usable endpoints
  are detected, and all Docker Manager operations should continue through the
  selected endpoint while it remains reachable.
- If that preference is unavailable, use another reachable endpoint without
  overwriting it. Explicitly selecting, starting, or provisioning an endpoint
  replaces the preference after the endpoint is confirmed reachable.
- When another daemon is reachable, an installed stopped Docker Desktop may be
  exposed as a startable runtime candidate. Selecting it should reuse the
  runtime setup operation, verify its exact endpoint, and only then replace the
  preference; startup failure must leave the fallback and prior preference
  intact.
- Retention policy is stored as a retained-instance count.
- Remote instances must normalize and validate URLs before persistence. Their
  optional saved `color` and `icon` fields use the same bounded choices as local
  Instance appearance overrides. The optional saved `allowUntrustedCertificate`
  flag is stored only when it is exactly `true`, survives rename and appearance
  edits, and is removed with the remote Instance record. Optional saved remote
  Instance credentials are keyed by remote Instance id and removed when that
  remote Instance is deleted.
  Every published state, including the one built while the Docker runtime is
  unavailable, carries the saved remote Instance credential metadata (saved
  flag, username, time; never the password).
  The health probe of a remote Instance that opted in to an untrusted
  certificate runs with `rejectUnauthorized: false` and judges the socket with
  the certificate rule in `shell/remote_certificate_trust.js` instead. It opens
  its own connection each time (`agent: false`): a reused keep-alive socket no
  longer exposes the peer certificate. Every other probe keeps Node's default
  verification.
  Remote instance online/offline status is transient renderer state from a
  bounded `/api/health` probe and must not be persisted into saved remote
  instance records. Only the sanitized last-seen runtime identity is cached.
- Retained local containers are rollback targets and should keep enough metadata
  for the renderer to display them without re-inspecting every container
  needlessly.
- Storage-volume operations must remain separate from retained-instance
  activation/removal and from container deletion. Deleting an instance must not
  remove its host workspace directory or named volume unless the renderer sends
  an explicit storage-removal option from the deletion dialog.
- Explicit host-workspace deletion removes the Instance container first, then
  empties root-owned bind-mount contents through Docker using the Instance's
  existing image before removing the empty host directory. If storage cleanup
  fails, finish Instance metadata and clone-image cleanup and report that the
  Instance was deleted while its folder remains.
- Host-directory workspace paths may be resolved for the shell-owned
  `Open storage folder` action. Named Docker volumes should stay represented as
  Docker volumes rather than guessed host paths.
- A host repository bind at `/a0` exposes its nested `/a0/usr` as persistent
  custom storage for folder opening, but it is not launcher-owned storage and
  must never be offered for deletion with the Instance.
- Long-running operations return an operation id and emit progress.
- Concurrent state refreshes are newest-wins. Before publishing a refreshed
  state, reapply the latest cached local and remote runtime identity so an older
  Docker/image snapshot cannot make an Instance disappear or replace a
  health-confirmed version with image provenance.
- Image installs may target Docker channel tags (`latest`, `ready`, `testing`)
  in addition to semver releases and local development tags, because first-run
  setup uses `latest` as the default image choice.
- Successful Agent Zero image pulls may clean up the previous local image id for
  the same tag, but only through non-forced Docker image removal. If Docker says
  the old image is still referenced by any container or another tag, keep it.
- Image removal from Versions must validate the tag, target a locally installed
  Agent Zero image, and call Docker image removal without force. If Docker
  reports the image is still used by a container, return a stable UI error
  instead of deleting related Instances or storage.
- Progress payloads may include `headline`, `detail`, `phase`, `steps`, and
  `indeterminate` in addition to the legacy `message` and numeric progress
  fields. Runtime setup progress uses those fields for the blocking startup
  modal.
- Runtime callbacks may supply an explicit phase as their third argument so
  nested Colima download/start logs stay on their owning checklist step. Keep
  failure on the last active step. Image-pull progress uses the current phase's
  percentage plus `progressStartedAt` and `progressStartValue` for an ETA based
  only on work observed since that phase became visible.
  Numeric-only runtime download callbacks retain their current detail and phase;
  a new stage without a percentage clears the previous download percentage.
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
- If Docker diagnostics or inventory operations prove an endpoint is usable
  after a pessimistic availability probe, normalize the runtime state to ready
  before exposing it to the renderer.
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
- Running an installed Version from Versions should create a new launcher-managed
  container with a unique Docker name and open host ports, so repeated runs of
  the same image can coexist.
- Running, active-instance creation, developer custom-image runs, and clones
  should label workspace storage metadata and use Docker `Mounts` for the
  canonical `/a0/usr` mount. Explicit ephemeral runs should still be labeled
  with storage metadata even though they do not receive the mount. Clones must
  receive a fresh workspace rather than reusing the source workspace mount.
- Per-container start/stop/restart/delete/clone/rename/appearance actions from the
  Instances card menu still belong in this product layer. Container mutations must target
  the requested container id, return an operation id, refresh state afterward,
  and keep storage-volume deletion separate from container deletion. Rename and
  Colour/Icon selection are fast launcher metadata updates and may return
  synchronously.
- Synchronous launcher-only metadata updates, including Settings, local
  Instance identity, credentials, and saved remote Instance edits, should patch
  and emit the cached product state after persistence. Do not rebuild Docker,
  GitHub, or registry-derived state when the operation cannot have changed it;
  remote health probing may continue asynchronously from the patched record.
- Local instance card start/stop/restart/delete actions run through an in-memory
  per-container background queue and do not occupy the global Docker Manager
  operation slot. They return `{ opId, queued: true, background: true }`, publish
  `backgroundOperations` in state, and keep heavier flows such as install,
  clone, migration, activation, update, rollback, and developer runs on the
  single global progress operation.
- Per-container log inspection belongs in this product layer as a bounded
  read-only snapshot. It may not expose generic Docker commands to the renderer.
- Per-container Backup and Restore belong in this product layer. Backup should
  copy `/a0/usr` from the selected container into a core-compatible `.zip` with
  metadata; Restore should accept that backup shape, map only workspace entries
  back into `/a0/usr`, and report progress as a long-running operation.
- Cloning an instance should reuse the source container's configured image
  reference, falling back to its image ID, remap published ports to
  Docker-assigned open host ports, and copy the
  selected `/a0/usr` workspace categories into fresh storage. Do not commit the
  source container into a clone-only image. With all categories selected, clone
  should copy the full `/a0/usr` tree to match Agent Zero backup behavior.
  `/a0/usr/agents` is the Agent profiles category and should stay separate from
  generic workspace files. When a clone inherits a host mount at `/a0`, add a
  process-scoped Git `safe.directory` entry so health metadata can read the
  checkout without copying host or source-container Git configuration.
  Persistence migration may still snapshot and pause a legacy source because it
  replaces that container while preserving its state.
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
- The installability cache may persist optional `tagUpdatedAt` and
  `tagMetadataCheckedAt` ISO timestamps for Docker Hub channel tags. Treat them
  as best-effort metadata and tolerate their absence in older caches.

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
