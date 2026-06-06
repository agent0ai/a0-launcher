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
- `status-header/`: title, release metadata, persistent banner surface,
  refresh, API Dashboard, and operation progress.
- `onboarding/`: runtime setup guidance, primary setup action, operation cancel,
  and Docker Desktop fallback when no local Docker inventory is available.
- `sidebar/`: tab navigation and `dm:nav` event publication.
- `official-versions/`: install/version cards, activation dialog, port/env
  overrides, data-loss acknowledgement, and update/switch actions.
- `local-testing/`: local containers, active instance controls, remote instance
  CRUD, and instance opening.
- `retained-instances/`: retained rollback containers and storage-volume cleanup.
- `storage-summary/`: storage overview metrics.
- `settings/`: port preferences and retention policy controls.
- `help/`: concise static help in the install tab.
- `instance-tabs/`: browser-style tab chrome, active-tab controls, empty state,
  and viewport bounds reporting for shell-owned Agent Zero UI views.

## Local Contracts

- Components render from the state emitted by `app/docker_manager.js` through
  `dm:state`.
- Components should render once from `window.__dmLastState` if it already
  exists, then subscribe to future updates.
- Components should not call `window.dockerManagerAPI` directly. Use
  `window.dockerManagerActions`.
- Runtime setup progress appears as the normal Docker Manager operation shape
  with `type: "runtime_setup"`. Onboarding renders that state but does not know
  setup commands, socket paths, or package-manager mechanics.
- `state.banner` is the persistent top-of-page status surface rendered by
  `status-header/`. Toasts are transient echoes only; components should not
  create duplicate persistent banners.
- Runtime setup summaries exposed to components must not include raw
  `dockerHostOverride` values. Use `hasDockerHostOverride` when the UI needs to
  know whether an override exists.
- Sidebar navigation publishes `dm:nav`; tab content activation remains owned by
  the renderer coordinator, not individual tab content components.
- Empty, loading, error, success, and disabled states must be explicit enough
  that the user is never left wondering whether Docker or the launcher is still
  working.
- Official version cards must distinguish available, installed, active, testing,
  local, matching digest, and differing digest states without exposing raw Docker
  mechanics as the main story.
- Activating a tag while another instance is active must keep the
  backup/proceed acknowledgement.
- Port mappings and environment text stay advanced activation inputs. They
  should not become a required path for normal users.
- The Instances tab owns both local Docker containers and saved remote
  instances. Visible copy must say `Instances`, not `Sessions`.
- Retained instances are rollback candidates; storage-volume cleanup must remain
  clearly separate from instance start/stop actions.
- Storage UI must say `Storage volumes` when referring to Docker volumes.
- Settings owns persistence for preferred UI/SSH ports and retained-instance
  count. Do not scatter those controls into install or instance cards.
- Onboarding is visible only when Docker is unavailable and there are no images
  or containers to inspect. It should always keep `Download Docker Desktop`
  available as a fallback while the panel is visible, including during launcher
  runtime setup.
- `Open UI` opens local and remote instances in a launcher tab by default.
  Reopening the same target focuses the existing tab. Detach moves the target
  into a standalone secure Electron window without stopping the instance.

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
