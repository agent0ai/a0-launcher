# Running the UI (A0 Launcher)

## Architecture overview

The launcher is structured as two layers with a clean separation boundary:

```text
┌──────────────────────────────────────────────────────┐
│  Shell  (Electron main process)                      │
│  shell/main.js · shell/preload.js                    │
│  ┌────────────────────┐  ┌─────────────────────────┐ │
│  │ docker_adapter/    │  │ docker_manager/          │ │
│  │ Low-level Docker   │  │ Feature orchestration    │ │
│  │ (dockerode)        │  │ (state, operations, IPC) │ │
│  └────────────────────┘  └─────────────────────────┘ │
│  a0app:// protocol handler                           │
└──────────────┬───────────────────────────────────────┘
               │ IPC (docker-manager:*)
┌──────────────▼───────────────────────────────────────┐
│  Content  (app/)  — served via a0app://              │
│  ┌─────────────┐  ┌───────────────────────────────┐  │
│  │ a0ui/       │  │ components/docker-manager/    │  │
│  │ A0 UI Core  │  │ Section folders with co-      │  │
│  │ (vanilla)   │  │ located HTML + JS per section │  │
│  └─────────────┘  └───────────────────────────────┘  │
│  docker_manager.js  (thin orchestrator + store)      │
│  docker_manager.css (A0-token-based layout styles)   │
│  index.html         (page shell + x-component refs)  │
└──────────────────────────────────────────────────────┘
```

### Shell layer (`shell/`)

The Electron main process. It handles window management, content downloading from GitHub Releases, the `a0app://` custom protocol, system tray, and all Docker operations via IPC.

### Content layer (`app/`)

Static HTML/CSS/JS served to Electron via the `a0app://` protocol so that `fetch()`, `new URL()`, and ES module imports work naturally. No bundler required.

### Custom protocol (`a0app://`)

Instead of loading content via `file://` (which breaks `fetch()` and relative URL resolution), the shell registers `a0app://content/...` that maps to the content directory on disk. This lets the vanilla A0 component loader work without modifications.

### A0 UI Core (`app/a0ui/`)

Vanilla copies of the Agent Zero WebUI framework:

- `app/a0ui/index.css` -- main theme (local `@font-face` instead of Google Fonts CDN)
- `app/a0ui/css/` -- `buttons.css`, `modals.css`
- `app/a0ui/js/` -- `initFw.js`, `components.js`, `modals.js`, `AlpineStore.js`, `initializer.js`, `confirmClick.js`, `device.js`, `shortcuts.js`, `sleep.js`
- `app/a0ui/vendor/` -- Alpine.js, Ace editor, Material Symbols (local fonts: Rubik, Roboto Mono)

These are intended to become a **git submodule** shared with the main Agent Zero project. The only wanted deviation is local font bundling.

### Launcher-specific files

- `app/docker_manager.js` -- thin orchestrator (Alpine store init, IPC refresh, event bus)
- `app/docker_manager.css` -- layout styles using A0 CSS tokens
- `app/components/docker-manager/` -- co-located section folders (each with `index.html` + JS controller)

### Docker backend

- `shell/docker_adapter/` -- low-level Docker client (dockerode wrapper, abstract `DockerInterface`, registry client, log processor)
- `shell/docker_manager/` -- feature/business layer (state aggregation, operations, retention, releases, volumes, IPC-facing orchestration)

## Prerequisites

- Node.js 20+
- npm 9+

## Run in development

```bash
npm install
npm start
```

### Local content iteration (skip GitHub download)

```bash
A0_LAUNCHER_USE_LOCAL_CONTENT=1 npm start
```

This tells the shell to load `app/index.html` from the repo root instead of from the cached download directory.

### Cache seeding (Windows PowerShell)

For fast iteration without GitHub Releases:

```powershell
$userData = Join-Path $env:APPDATA 'a0-launcher'
$contentDir = Join-Path $userData 'app_content'
New-Item -ItemType Directory -Force -Path $contentDir | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $contentDir '*')
Copy-Item -Recurse -Force -Path 'app\*' -Destination $contentDir

$meta = @{ version='dev-local'; published_at='2999-01-01T00:00:00.000Z'; downloaded_at=(Get-Date).ToString('o') }
$json = $meta | ConvertTo-Json -Depth 4
$metaPath = Join-Path $userData 'content_meta.json'
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($metaPath, $json, $enc)
```

Re-run after editing `app/` files.

## UI smoke tests

Validate the docker manager end-to-end from the main page:

- Docker onboarding (detected vs missing + download CTA)
- Image listing (detected local images)
- Container listing (state, name, image ref)
- Volume listing + remove + prune
- Counts summary
- Refresh button
- Open UI / Homepage buttons
- Progress panel (during install/update operations)

## IPC namespace

All docker manager IPC channels use the `docker-manager:` prefix:

- `docker-manager:getState`, `docker-manager:refresh`
- `docker-manager:getInventory`, `docker-manager:install`, `docker-manager:startActive`, `docker-manager:stopActive`
- `docker-manager:removeVolume`, `docker-manager:pruneVolumes`, `docker-manager:installDocker`
- `docker-manager:openUi`, `docker-manager:openHomepage`
- `docker-manager:state` (push event), `docker-manager:progress` (push event)

The preload bridge exposes these as `window.dockerManagerAPI`.

## Notes on CSP

The CSP in `app/index.html` allows:

- `'unsafe-eval'` -- required by Alpine's expression evaluator
- `blob:` in `script-src` -- used by the component loader for inline module execution
- `a0app:` -- the custom protocol scheme

If a component renders but Alpine content does not appear, CSP is the first thing to check.
