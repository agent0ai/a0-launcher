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
  action facade, toast helpers, terminal dock, and initial refresh flow.
- `app/docker_manager.css`: launcher-specific UI surface.
- `app/assets/`: renderer-visible images and symbols.
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
- Runtime setup onboarding is renderer-owned UI only. It may show current setup
  progress, start setup, cancel the current operation by op id, and offer the
  Docker Desktop fallback through named actions. Terminal runtime setup failures
  from progress events must remain visible as error banners even if the
  onboarding panel hides; runtime detection, installation, socket selection, and
  privileged Docker mechanics remain shell-owned.
- Renderer runtime setup state must stay sanitized. The renderer may keep
  `runtimeBackend`, `machineName`, `hasDockerHostOverride`,
  `usesDefaultDockerSocket`, and `lastSuccessfulSetupAt`, but must not store or
  display raw Docker host overrides, socket paths, helper paths, or command
  details.
- The bottom A0 CLI Connector should prefer the launcher-managed active
  instance URL, then fall back to a running local container from the Instances
  inventory when that container has a local UI URL.
- `Content: ...` comes from shell content metadata. `App: ...` comes from
  Electron `app.getVersion()`.
- Keep external navigation intentional. Product destinations such as API
  Dashboard should go through the shell action where one exists; direct
  `window.open` should stay limited to safe public links such as Docker install
  help.
- Use `Instances`, not `Sessions`, in visible copy.
- Use `Storage volumes` when referring to Docker volumes.
- Keep install, activation, rollback, and destructive-storage flows explicit
  about risk without adding Docker jargon where a user decision is enough.
- Keep `Open UI` colocated with the instance or install it opens.
- Keep compact controls stable in width and avoid text overflow on small
  windows.
- Prefer local Material Symbols icons through the bundled font instead of remote
  icon/font assets.
- Do not add marketing-page structure to the app entrypoint. The first screen is
  the usable launcher.
- Instance tab chrome is renderer-owned, but embedded Agent Zero pages are not.
  The renderer computes the tab viewport bounds and sends them through preload;
  the shell owns the `WebContentsView` attached to that rectangle.

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
