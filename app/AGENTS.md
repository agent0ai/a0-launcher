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
- Runtime setup state is part of the canonical renderer snapshot. If the
  runtime is not ready after initial state loads, the renderer must show the
  blocking startup runtime modal before any launcher workspace feature can be
  used. Docker mechanics stay in the shell.
- The setup capability slideshow is for the long Agent Zero image pull/extract
  wait, not for Docker runtime setup or short install preflight checks.
- When runtime setup completes, the same modal shell owns the first Agent Zero
  image setup prompt, including a short explanation and a version selector that
  defaults to the Docker `latest` tag.
- During the first Agent Zero image pull, the operation modal may offer saved
  Instance provider/model defaults and an explicit one-time checkbox to start
  the first Instance after the download finishes. It may also offer an optional
  A0 CLI install step before the setup slideshow; every first-pull setup step
  must include a visible Skip affordance.
- Long-running non-runtime Docker operations should use the same centered modal
  affordance rather than a top-of-page status strip. Keep the header quiet once
  the modal flow exists.
- A0 CLI launch, rename, and log inspection controls belong to each local
  instance card. Clone belongs to local containers and may appear on a saved
  remote card only when that card points at a loopback URL backed by a
  discovered local container. Pass the card's local UI URL through the
  shell-owned terminal action; the shell prompts for the CLI working folder
  before opening the terminal. If the shell reports that the `a0` command is
  not installed, show `Install A0 CLI` instead of `Open A0 CLI`. Do not add a
  global footer or ambiguous active-instance CLI button.
- The compact header shows the Agent Zero wordmark without visible launcher
  version text. Shell app/content metadata may remain in renderer state for
  diagnostics and update decisions, but it should not reintroduce version or
  `Content:` clutter into the header.
- Keep external navigation intentional. Product destinations such as API
  Dashboard should go through the shell action where one exists; direct
  `window.open` should stay limited to safe public links such as Docker install
  help.
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
