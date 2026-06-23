# AGENTS

## Purpose

`app/components/docker-manager/` owns the renderer components that make up the
launcher workspace.

The components should stay small, state-driven, and predictable. They render the
current Docker Manager snapshot and call named renderer actions when the user
asks for work.

## Ownership

This scope owns:

- `docker-manager-store.js`: mutable renderer store and default state shape.
- `progress-eta.js`: renderer-only minute-level progress ETA formatting shared
  by setup and operation modals.
- `status-header/`: wordmark, launcher update affordance, refresh, and shared
  progress-recovery helpers.
- `operation-modal/`: centered progress/error modal for non-runtime installs,
  updates, activation, start/stop, delete, rollback, and recovery actions.
- `runtime-gate/`: mandatory startup runtime setup modal, runtime setup
  progress, recovery actions, and non-dismissable gating.
- `first-instance-setup/`: first image-pull defaults panel, optional first
  Instance run choice, and optional A0 CLI install step shown before the setup
  slideshow.
- `setup-showcase/`: Agent Zero capability slideshow helper shown during the
  long Agent Zero image pull phase.
- `onboarding/`: retired runtime setup banner files kept only for compatibility
  until they are removed.
- `sidebar/`: tab navigation and `dm:nav` event publication.
- `official-versions/`: install/version cards, activation dialog, saved
  Instance defaults, port/env overrides, data-loss acknowledgement, and
  update/switch actions.
- `local-testing/`: local containers, per-instance action menus, rename,
  clone/log inspection controls, remote instance CRUD, and instance opening.
- `advanced/`: tabbed developer-mode custom image runner with inline Docker
  Compose composer, diagnostics, and storage-volume maintenance.
- `settings/`: port preferences and saved Instance provider/model defaults.
- `instance-tabs/`: browser-style tab chrome, Home tab, active-tab controls,
  empty state, and viewport bounds reporting for shell-owned Agent Zero UI
  views.

## Local Contracts

- Components render from the state emitted by `app/docker_manager.js` through
  `dm:state`.
- Components should render once from `window.__dmLastState` if it already
  exists, then subscribe to future updates.
- Components should not call `window.dockerManagerAPI` directly. Use
  `window.dockerManagerActions`.
- Runtime setup renders from `state.runtime` in the blocking startup modal. It
  should distinguish installable Linux Engine setup, stopped daemons,
  relogin-required states, and manual install fallback without exposing
  package-manager details as the main path.
- If Docker is already reachable through the Docker Manager state, stale
  non-ready runtime assessments must not reopen the blocking runtime modal.
  Only completed runtime setup progress may keep the modal open to guide the
  immediate next step.
- Docker Desktop installed-but-stopped states must be warning states that tell
  the user to start Docker Desktop. Do not show a download/reinstall action for
  that state.
- Generic runtime setup buttons should say `Continue`, including runtime states
  that provide `Setup Agent Zero` or `Continue Setup` as a setup action label.
  Docker Desktop states may still name Docker Desktop plainly.
- Sidebar navigation publishes `dm:nav`; click-originated events include
  `userInitiated` so the renderer coordinator can refresh data-heavy tabs.
  Tab content activation remains owned by the renderer coordinator, not
  individual tab content components.
- Empty, loading, error, success, and disabled states must be explicit enough
  that the user is never left wondering whether Docker or the launcher is still
  working.
- Runtime setup progress belongs primarily in the blocking runtime modal.
- Runtime setup should stay transparent without becoming a feature showcase.
  Use the `See more` disclosure for structured setup phases when detailed
  progress is available.
- Runtime setup success should stay in the same modal shell long enough to
  guide the next step without implying Agent Zero is still missing. If no Agent
  Zero image is installed, offer a `Download Agent Zero` image action with a
  selector defaulting to `latest`. If an image is installed and no local
  Instance exists yet, offer `Run Agent Zero`. If a local Instance already
  exists, offer `Continue`.
- Visible setup titles and transient progress states should use `Setup`, not
  `Set up`, `Set Up`, or `Setting up`; button labels that advance runtime setup
  should use `Continue`.
- If two or more usable local runtime endpoints are detected during setup
  completion, the same modal may show a compact `Run Agent Zero with` selector.
  Hide that selector for zero or one usable endpoint, and do not add a runtime
  picker to Settings or the global chrome.
- Post-runtime image, activation, update, rollback, start, stop, and delete
  progress should use the centered operation modal rather than a top-page
  status strip.
- The Agent Zero setup slideshow belongs only to the image pull/extract wait in
  the install operation modal. Do not show it during Docker runtime setup or
  short preflight checks.
- On a first image pull with no local Instances, the operation modal may show a
  saved Instance defaults panel before the slideshow. Ask for providers,
  models, and API keys before the optional first-Instance name/run choice.
  The first-Instance step may also ask for workspace storage: default to a
  persistent workspace, allow named Docker volumes as the advanced persistent
  choice, and show a clear warning for the explicit no-volume ephemeral choice.
  After the first-Instance step, show an optional A0 CLI install step that
  explains local files, host browser access, and Computer Use in user-friendly
  terms before the setup slideshow. Every first-pull setup phase needs a
  visible Skip button; skipping the CLI step must preserve any already-saved
  first-Instance run choice.
  Persist provider/model defaults to Settings, but keep the "start my first
  Instance" checkbox and storage choice as a one-shot install-scoped intent,
  not a reusable preference. That intent may survive renderer reloads or a
  terminal detour during the active first install, and must be cleared on skip,
  install failure/cancel, or when the first local Instance exists.
- Active modal progress should show the current phase once, in the progress
  header above the bar. Do not repeat the same phase as body detail under the
  modal title.
- Operation progress should keep actionable recovery affordances for
  user-fixable failures. For Docker Hub pull-rate limits, keep the error
  visible and offer the shell-owned Docker sign-in wrapper plus retry instead
  of a dead-end message.
- Operation progress failures must remain visible with the stable
  renderer-facing error message after the async operation finishes.
- Operation progress may show a cancel action only when the Docker Manager
  progress payload marks the current phase as cancelable.
- Official version cards must distinguish available, installable, installed,
  active, visible channel tags (`latest`, `ready`), local builds, matching
  digest, and differing digest states without exposing raw Docker mechanics as
  the main story. Fresh machines must have a visible install action once Docker
  is ready. The unmaintained `testing` tag is intentionally hidden from the
  Installs view.
- Running an installed tag from Installs creates another managed local instance
  and must not stop existing instances or require a data-loss acknowledgement.
  Destructive switch, update, and retained-instance activation flows must keep
  the backup/proceed acknowledgement.
- Activation may offer optional model provider/model/API-key helpers. Keep Main
  and Utility in the primary dialog body, keep Embedding under Advanced, compile
  helpers to Agent Zero environment defaults, and preserve Advanced environment
  variables as the explicit escape hatch.
- Port mappings and environment text stay advanced activation inputs. They
  should not become a required path for normal users.
- Advanced activation may expose a storage override, but the default path should
  use saved workspace storage preferences and create a separate `/a0/usr`
  workspace for every new local instance unless the user explicitly selects the
  no-volume ephemeral mode.
- The Advanced tab may expose developer-mode custom image, tag, environment,
  port, mount, and editable Compose-file controls. Keep it opt-in, validate
  through Docker Manager IPC, and never expose a generic command runner or a
  runtime-candidate browser.
- Advanced should keep developer controls and their related Compose editing
  together in the Developer sub-tab. Diagnostics and Storage volumes remain
  separate sub-tabs so the page avoids multiple boxed panels at once.
- Advanced diagnostics should render structured Docker runtime facts from
  Docker Manager state as report-style rows, not metric-card grids or
  renderer-inferred runtime guesses.
- The Instances tab owns both local Docker containers and saved remote
  instances. Visible copy must say `Instances`, not `Sessions`.
- Local instance cards keep `Open UI` or `Start` as the visible primary action.
  Secondary management and inspection actions such as `Rename`, `See logs`,
  `Open storage folder`, `Clone`, `Open A0 CLI`, `Stop`, and `Delete` belong in
  the card overflow menu so they always apply to the specific instance shown.
  `Open A0 CLI` should let the shell show the native working-folder picker
  before terminal launch; canceling that picker should not display an error.
  If the shell reports that the host `a0` command is unavailable, the same menu
  slot should become `Install A0 CLI` and launch the shell-owned installer
  intent instead of failing late.
  Clone opens a quiet confirmation dialog with `/a0/usr` category choices hidden
  in a disclosure by default; all categories are selected by default to match
  Agent Zero backup behavior, while clearing all categories intentionally
  creates a fresh empty workspace. Keep Agent profiles as their own category for
  `/a0/usr/agents`, separate from generic workspace files. Clone and
  persistence-migration entry points must warn that the source container is
  paused and resumed, and that running AI work stops and must be resumed
  manually.
- Local instance cards should use the launcher-visible instance name as the
  primary visual identity. The visual version chip should prefer the runtime
  branch reported from inside the container over the original Docker image tag,
  because self-updated containers can run `ready` code from a `latest` image.
  Keep the metadata compact: show runtime branch/commit first, put the URL on
  its own line, and avoid listing routine `image latest` or persistent
  workspace fragments in the primary card text.
- Local instance cards should keep workspace state quiet. Persistent host
  directories, named volumes, custom mounts, and legacy ephemeral workspaces
  should be distinguishable through relevant controls and storage affordances
  without turning Docker storage into the primary card story. Intentionally
  ephemeral workspaces should not be labeled legacy.
- `Open storage folder` should appear only for persistent workspace storage
  that exposes an actual host directory path. Do not show it for named Docker
  volumes when the host file manager cannot open a stable user-facing folder.
- `Persist a0/usr data` belongs in the local instance overflow menu only when
  the Docker Manager marks the container as legacy or non-persistent. The
  action must call a named renderer action, keep the old container retained
  until the shell operation succeeds, and show a completion dialog reminding the
  user to verify the new persistent Instance before deleting the old one.
- Renaming a local instance changes the launcher-visible display name. It must
  not rely on mutating existing Docker labels, because Docker labels are
  immutable after container creation.
- Saved remote URL-only instance cards must not expose Docker mutation actions.
  A saved remote card may show `Clone locally` only when its URL is loopback
  (`localhost`, `127.0.0.1`, or IPv6 loopback) and the port matches a discovered
  local Docker container; the action must clone that local container.
- The local instance log viewer is a bottom popover panel driven by bounded
  Docker Manager log snapshots. It must stay read-only and must not expose a
  generic Docker command surface.
- Retained instances are rollback candidates; storage-volume cleanup belongs in
  Advanced and must remain clearly separate from instance start/stop actions.
- Storage UI must say `Storage volumes` when referring to Docker volumes.
  Workspace storage preferences may live in the Advanced storage tab, but copy
  should distinguish workspace directories from Docker named volumes.
- Settings owns persistence for preferred UI/SSH ports and Instance
  provider/model defaults. Do not scatter those persistent controls into
  install or instance cards except for the first-pull defaults prompt.
- `Open UI` opens local and remote instances in a launcher tab by default.
  Reopening the same target focuses the existing tab. Detach moves the target
  into a standalone secure Electron window without stopping the instance.
- Instance tab chrome keeps a Home tab as the first tab whenever any instance UI
  tab is open. Selecting Home clears the active shell-owned view and leaves the
  launcher surface usable below the tab strip.

## Work Guidance

- Keep component scripts pure enough to rerender repeatedly from state without
  accumulating duplicate event listeners.
- Use stable element ids inside a component only within that component's loaded
  fragment; do not rely on ids owned by sibling components.
- Prefer short task-oriented copy. Avoid explanatory paragraphs when a label,
  status, or action name will do.
- Keep destructive actions guarded by confirmation or explicit acknowledgement.
- If a component's contract becomes large enough to need its own doc, add a
  child `AGENTS.md` and update this file plus the root index in the same session.

## Verification

After component changes, run:

```bash
node --check app/docker_manager.js
git diff --check
```

For script changes under this subtree, also run `node --check` on the edited
component modules when they are standalone ES modules.

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
