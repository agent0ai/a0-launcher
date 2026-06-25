# AGENTS

## Purpose

`app/` owns the renderer content loaded inside the Electron shell.

It is a static browser application built from local HTML, CSS, ES modules, the
portable Agent Zero UI framework, and `<x-component>` includes. It presents the
Docker Manager experience and asks the preload APIs to perform privileged work.

## Ownership

This scope owns:

- `app/index.html`: renderer entrypoint, CSP, shared styles/scripts, and tab
  layout.
- `app/docker_manager.js`: renderer state coordination, preload API calls,
  action facade, runtime setup action, toast helpers, and initial refresh flow.
- `app/docker_manager.css`: launcher-specific UI surface.
- `app/assets/`: renderer-visible images, symbols, and setup showcase media.
- `app/components/`: component HTML and ES modules loaded through
  `<x-component>`.
- `app/a0ui/`: portable Agent Zero UI primitives vendored into this app.

## Local Contracts

- Renderer code must not import Node or Electron modules directly.
- All privileged behavior goes through preload surfaces:
  `window.electronAPI` for shell metadata and `window.dockerManagerAPI` for
  Docker Manager operations.
- `app/docker_manager.js` owns the canonical renderer snapshot. Components read
  state from the `dm:state` event or `window.__dmLastState`; they should not
  each call the Docker APIs independently.
- Components invoke behavior through `window.dockerManagerActions`, not through
  raw IPC names.
- Instance topology state is part of the canonical renderer snapshot. The
  renderer may arrange graph nodes and request logical links through named
  actions, but Docker network creation and container attachment stay in the
  shell-owned Docker Manager path.
- Runtime setup state is part of the canonical renderer snapshot. If the
  runtime is not ready after initial state loads and no saved remote Instances
  exist, the renderer must show the startup runtime modal with a first-step
  affordance to add a remote Instance. Saved remote Instances must keep the
  launcher usable without local Docker setup. Docker mechanics stay in the
  shell.
- The setup capability slideshow is for the long Agent Zero image pull/extract
  wait, not for Docker runtime setup or short install preflight checks.
- When runtime setup completes, the same modal shell owns the next step without
  implying Agent Zero is still missing: download an image if none is installed,
  run Agent Zero if an image is installed but no local Instance exists, or
  continue if an Instance already exists.
- During the first Agent Zero image pull, the operation modal may offer saved
  Instance provider/model defaults and an explicit one-time checkbox to start
  the first Instance after the download finishes. It may also offer an optional
  A0 CLI install step before the setup slideshow; every first-pull setup step
  must include a visible Skip affordance.
- Long-running non-runtime Docker operations should use the same centered modal
  affordance rather than a top-of-page status strip. Keep the header quiet once
  the modal flow exists.
- Local instance card `Start`, `Stop`, and `Delete` are background queued
  actions. They must not open the global operation modal or make the page inert;
  show queue/running state on the affected card and surface failures with toast
  feedback.
- Running an installed image from Installs must keep the operation modal until
  the Docker Manager reports the new Instance UI ready, then hand off to the
  Instances tab so the created Instance is visible.
- A0 CLI launch, rename, color selection, and log inspection controls belong to
  each local instance card. Clone belongs to local containers and may appear on
  a saved remote card only when that card points at a loopback URL backed by a
  discovered local container. Pass the card's local UI URL through the
  shell-owned terminal action; the shell prompts for the CLI working folder
  before opening the terminal. If the shell reports that the `a0` command is
  not installed, show `Install A0 CLI` instead of `Open A0 CLI`. Do not add a
  global footer or ambiguous active-instance CLI button.
- Local Instance Backup and Restore belong with the other card-local actions.
  They must call named renderer actions that delegate host path selection and
  container archive work to the shell and Docker Manager.
- Per-Instance color selection is launcher identity metadata for local and saved
  remote Instances. It should use bounded palette IDs from Docker Manager state,
  tint only the card visual, and never imply Docker or Agent Zero runtime state.
- Removing an Install is a named renderer action from the Installs view. The
  renderer should present it as image cleanup and let Docker Manager report
  Docker's in-use refusal rather than trying to infer container/image bindings
  in component code.
- The compact header shows the Agent Zero wordmark without visible launcher
  version text. Shell app/content metadata may remain in renderer state for
  diagnostics and update decisions, but it should not reintroduce version or
  `Content:` clutter into the header.
- Keep external navigation intentional. The lean resource footer may request
  approved Docs, API Dashboard, and Support resource IDs through
  `window.dockerManagerActions.openResourceLink`; the shell maps those IDs to
  fixed public URLs. Keep this footer as bottom launcher chrome that is visible
  without a page scroll. Direct `window.open` should stay limited to safe public
  links such as Docker install help.
- Use `Instances`, not `Sessions`, in visible copy.
- Use `Storage volumes` when referring to Docker volumes.
- Keep developer-only Docker controls in the Advanced tab. They may compose and
  run custom images through named Docker Manager actions, but renderer code must
  not expose generic command execution.
- Keep install, activation, rollback, and destructive-storage flows explicit
  about risk without adding Docker jargon where a user decision is enough.
- Toast feedback for modal actions must remain visible above blocking modal
  backdrops, especially recoverable failures such as Docker Hub sign-in.
- Keep `Open UI` colocated with the instance or install it opens.
- Keep compact controls stable in width and avoid text overflow on small
  windows.
- Keep the launcher workspace responsive across large displays. Do not
  reintroduce fixed-width page or tab wrappers around the main renderer shell;
  prefer viewport-aware gutters, grids, and scroll regions.
- Do not use circular launcher buttons. The maximum launcher control radius is
  the shared 6px Refresh-button radius.
- Prefer local Material Symbols icons through the bundled font instead of remote
  icon/font assets.
- Do not add marketing-page structure to the app entrypoint. The first screen is
  the usable launcher.
- Instance tab chrome, including the Home tab that returns to the launcher, is
  renderer-owned, but embedded Agent Zero pages are not. The renderer computes
  the tab viewport bounds and sends them through preload; the shell owns the
  `WebContentsView` attached to that rectangle.

## Work Guidance

- Add shared renderer state to `docker-manager-store.js` first, then expose it
  through the snapshot in `app/docker_manager.js`.
- If a new component needs actions, add a named action to
  `window.dockerManagerActions` and document the behavior in the component
  owning doc.
- Keep component scripts idempotent: a component may render from the last state
  immediately and then subscribe to future `dm:state` events.
- Keep launcher-specific styles in `app/docker_manager.css`; do not place
  one-off feature styling in portable `app/a0ui` files.

## Verification

After renderer changes, run at least:

```bash
node --check app/docker_manager.js
git diff --check
```

For visible UI changes, start the launcher with local content and inspect the
affected tabs:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```

## Child DOX Index

- `/app/a0ui/AGENTS.md`: portable Agent Zero UI framework assets and vendored
  browser dependencies.
- `/app/components/docker-manager/AGENTS.md`: Docker Manager renderer
  components and component store.
