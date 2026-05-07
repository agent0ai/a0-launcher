# FAQ: A0 Launcher Integration

## What is A0 Launcher?

A lightweight Electron desktop shell that manages Agent Zero instances via Docker and displays a UI downloaded from GitHub Releases.

## What is "Agent Zero Core"?

The actual agent/backend system (capabilities, tools, runtime). It is the "engine", not the launcher UI shell.

## How do A0 Launcher and Agent Zero relate?

- **Agent Zero Core**: the agent runtime + backend logic.
- **Agent Zero WebUI**: the web interface that talks to the backend.
- **A0 Launcher**: an Electron desktop wrapper that manages Docker instances and loads UI content.

The launcher uses the same UI framework as Agent Zero (styles, component loader, Alpine stores, modals) so the two projects share a common look and feel.

## What did we port from Agent Zero?

We ported the **UI component infrastructure** (the "frontend framework layer"):

- Shared styling system (CSS custom properties, spacing, buttons, modal chrome)
- Component loader (`<x-component>` tag system via `components.js`)
- Modal stack with backdrop + z-index stacking (`modals.js`)
- Alpine store helper (`AlpineStore.js`)
- Custom Alpine directives (`x-destroy`, `x-create`, `x-every-second`, etc.)
- Key vendor libraries: Alpine.js, Ace editor, Material Symbols (local fonts)

We did **not** port product-specific features like chat, speech, scheduler, or settings.

## How does the custom protocol work?

The Electron shell registers an `a0app://` protocol that serves content from disk. This makes `fetch()`, `new URL()`, and ES module imports work naturally, exactly like a real web server. The vanilla Agent Zero `components.js` works without any modifications.

The custom protocol lives in `shell/main.js` (the Electron host layer). It is NOT part of the A0 UI core.

## What is the "A0 UI Core" and can it be reused?

The A0 UI Core lives in `app/a0ui/` and mirrors Agent Zero's `webui/` layout:

- `app/a0ui/js/` -- framework JS (vanilla copies from Agent Zero v0.9.8)
- `app/a0ui/css/` -- framework CSS (buttons, modals)
- `app/a0ui/vendor/` -- Alpine, Ace, Google icons + local fonts
- `app/a0ui/index.css` -- theme

These are intended to become a **git submodule** shared between the launcher and the main Agent Zero project. The only wanted deviation is local `@font-face` rules instead of the Google Fonts CDN import.

## What stays in the launcher only (not in the core)?

- `shell/` -- Electron main process, custom protocol, Docker management
  - `shell/docker_adapter/` -- low-level Docker client (dockerode wrapper)
  - `shell/docker_manager/` -- feature/business orchestration (state, operations, volumes, releases)
- `app/docker_manager.js` / `app/docker_manager.css` -- Docker manager UI orchestrator + styles
- `app/components/docker-manager/` -- launcher-owned UI sections (co-located HTML + JS per section)

## What about CSP (Content Security Policy)?

Alpine requires `unsafe-eval` to evaluate expressions. The component loader executes inline module scripts via Blob URLs, which requires `blob:` in `script-src`. These are narrowly scoped to what the framework needs.

## How do we validate the integration?

Use the docker manager page and run the operational flows:

- Docker onboarding (detection + download CTA)
- Image listing
- Container listing
- Volume management (list, remove, prune)
- Refresh / Open UI / Homepage buttons
- Progress observation during install/update

This validates the shared A0 UI framework under real launcher behavior.

## Naming conventions

- Alpine stores: `*-store.js` (e.g. `docker-manager-store.js`)
- Component folders: each section gets its own folder with `index.html` + co-located JS controller
- Custom CSS goes in a `<style>` tag at the bottom of component HTML, not in separate CSS files
- IPC channels: `docker-manager:*` prefix
- Preload API: `window.dockerManagerAPI`
- App actions: `window.dockerManagerActions`

## What is next?

- Extract the A0 UI Core (`app/a0ui/`) into a git submodule shared with the main Agent Zero project
- Implement auto-install Docker Desktop flow (Windows/macOS installer download; Linux docs redirect)
- Add finer-grained Docker operations to UI sections as needed
- Port additional components from Agent Zero as needed
