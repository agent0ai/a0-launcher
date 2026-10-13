# FAQ: Agent Zero Launcher Integration

## How do I set up Browser or Computer access?

Open an Instance and its computer icon. Connect your computer guides access
choices, browser preparation and OS permissions. Advanced settings retains
folder, browser-profile and other scope controls. New guided setup leaves file
and command access off. Existing permissions stay as saved.

You may start in Launcher, WebUI or iOS. A code from another device joins setup
progress after normal login to the same server; confirm the computer on that
device, then review and allow access here. Codes expire in ten minutes and
grant no permissions. Test browser uses a temporary page. Test computer checks
a fresh capture without input. Tests cannot clear an existing viewer hold.
Older servers/connectors keep local setup available and explain required updates.

## What is Agent Zero Launcher?

A lightweight Electron desktop shell that manages Agent Zero instances via Docker and displays a UI downloaded from GitHub Releases.

## What is "Agent Zero Core"?

The actual agent/backend system (capabilities, tools, runtime). It is the "engine", not the launcher UI shell.

## How do Agent Zero Launcher and Agent Zero relate?

- **Agent Zero Core**: the agent runtime + backend logic.
- **Agent Zero WebUI**: the web interface that talks to the backend.
- **Agent Zero Launcher**: an Electron desktop wrapper that manages Docker instances and loads UI content.

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

## Why does A0 controlled profile open a different browser window?

For normal setup, choose Browser and/or Computer access and click **Connect and
check**. Launcher saves your choices, connects, and checks the selected browser
automatically. Approve Chrome's connection prompt if it appears. Computer
capture is checked when its system permissions are ready; otherwise the next
permission step stays visible. A successful browser check confirms actual typing
and capture on a temporary page, which is then closed.

It is a separate, persistent browser profile for Agent Zero. Your everyday
profile's logins, cookies and extensions stay separate. Launcher connects to
the controlled profile automatically; do not enable the remote-debugging
switch in its inspect page. That page's server status is not the connection
status used by A0. Check Browser status in Launcher instead.

Choose the normal browser profile when you want Agent Zero to use your existing
browser and its signed-in sites. That path needs the browser's remote-debugging
approval. Save a changed browser selection before using Set up browser.
While a selection is unsaved, Launcher shows **Not applied**, disables Retry
and preparation, and offers **Save and connect**. The previous connection's
error is not the result of testing the newly selected browser. A completed
connection test keeps its typing/capture result visible in the setup assistant.

If your browser is running its debugging server but is missing from the list,
choose **My existing browser — enter connection address** under Advanced
settings. Enter the local HTTP address and port shown by that browser (for
example `http://127.0.0.1:9222`; use its actual port), then choose **Save and
connect**. Approve the connection in the browser if prompted, and use **Test
browser** to verify typing and capture. This attaches to your existing browser
without opening a separate profile. The connection address accepts localhost,
127.0.0.1, or IPv6 loopback; do not paste a DevTools WebSocket link or credentials.

## Can a tunnel keep me signed in while my computer is locked?

The WebUI's **Open Launcher on this computer** uses a fixed app link in
compatible packaged releases. It opens guidance only; select the same Instance
and sign in before entering a continuation code. Nothing in the link authorizes
host access. If no app opens, install/update Launcher or continue manually.

A persistent tunnel keeps a stable server address, not an Agent Zero login
session. Keep UI Login and UI Password configured for remote WebUI access.
Tunnel-provider sign-in is separate, and a tunnel does not require locking
the computer.

After a successful sign-in, Launcher can offer to save credentials using the
operating system's secure storage. This is optional. Saved valid credentials
allow automatic WebUI login recovery when storage is available. A fresh
authentication or operating-system unlock still needs the user at the
computer; the phone cannot unlock it. An offline gateway alone cannot tell
whether the computer is locked, asleep, signed out or Launcher is closed.
Reconnecting must not clear a held host action.

## What is next?

- Extract the A0 UI Core (`app/a0ui/`) into a git submodule shared with the main Agent Zero project
- Implement auto-install Docker Desktop flow (Windows/macOS installer download; Linux docs redirect)
- Add finer-grained Docker operations to UI sections as needed
- Port additional components from Agent Zero as needed
