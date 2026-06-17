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
- `status-header/`: wordmark, launcher version line, reserved launcher update
  affordance, refresh, and shared progress-recovery helpers.
- `operation-modal/`: centered progress/error modal for non-runtime installs,
  updates, activation, start/stop, delete, rollback, and recovery actions.
- `runtime-gate/`: mandatory startup runtime setup modal, runtime setup
  progress, recovery actions, and non-dismissable gating.
- `onboarding/`: retired runtime setup banner files kept only for compatibility
  until they are removed.
- `sidebar/`: tab navigation and `dm:nav` event publication.
- `official-versions/`: install/version cards, activation dialog, model default
  helpers, port/env overrides, data-loss acknowledgement, and update/switch
  actions.
- `local-testing/`: local containers, per-instance action menus, remote
  instance CRUD, and instance opening.
- `advanced/`: developer-mode custom image runner, Docker Compose composer,
  diagnostics, and storage-volume maintenance.
- `settings/`: port preferences and retention policy controls.
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
- Docker Desktop installed-but-stopped states must be warning states that tell
  the user to start Docker Desktop. Do not show a download/reinstall action for
  that state.
- If runtime state includes `setupActionLabel`, the runtime modal should use it
  for the primary setup button. Docker Desktop states may name Docker Desktop
  plainly; default setup buttons should stay Agent Zero-first.
- Sidebar navigation publishes `dm:nav`; click-originated events include
  `userInitiated` so the renderer coordinator can refresh data-heavy tabs.
  Tab content activation remains owned by the renderer coordinator, not
  individual tab content components.
- Empty, loading, error, success, and disabled states must be explicit enough
  that the user is never left wondering whether Docker or the launcher is still
  working.
- Runtime setup progress belongs primarily in the blocking runtime modal.
- Runtime setup success should stay in the same modal shell long enough to
  offer first Agent Zero image setup. The selector defaults to `latest`, and the
  primary `Setup Agent Zero` action starts the selected image install.
- If two or more usable local runtime endpoints are detected during setup
  completion, the same modal may show a compact `Run Agent Zero with` selector.
  Hide that selector for zero or one usable endpoint, and do not add a runtime
  picker to Settings or the global chrome.
- Post-runtime image, activation, update, rollback, start, stop, and delete
  progress should use the centered operation modal rather than a top-page
  status strip.
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
- Activating a tag while another instance is active must keep the
  backup/proceed acknowledgement.
- Activation may offer optional model provider/model/API-key helpers. Keep Main
  and Utility in the primary dialog body, keep Embedding under Advanced, compile
  helpers to Agent Zero environment defaults, and preserve Advanced environment
  variables as the explicit escape hatch.
- Port mappings and environment text stay advanced activation inputs. They
  should not become a required path for normal users.
- The Advanced tab may expose developer-mode custom image, tag, environment,
  port, mount, and editable Compose-file controls. Keep it opt-in, validate
  through Docker Manager IPC, and never expose a generic command runner or a
  runtime-candidate browser.
- The Instances tab owns both local Docker containers and saved remote
  instances. Visible copy must say `Instances`, not `Sessions`.
- Local instance cards keep `Open UI` or `Start` as the visible primary action.
  Secondary management actions such as `Open A0 CLI`, `Stop`, and `Delete`
  belong in the card overflow menu so they always apply to the specific instance
  shown.
- Retained instances are rollback candidates; storage-volume cleanup belongs in
  Advanced and must remain clearly separate from instance start/stop actions.
- Storage UI must say `Storage volumes` when referring to Docker volumes.
- Settings owns persistence for preferred UI/SSH ports and retained-instance
  count. Do not scatter those controls into install or instance cards.
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
