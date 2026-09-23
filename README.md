# Agent Zero Launcher

Agent Zero Launcher is an Electron desktop app for installing, running, switching,
inspecting, and opening Dockerized Agent Zero instances without making Docker the
first thing a user has to understand.

It is intentionally small at the shell boundary: renderer code expresses user
intent, the Electron shell owns privileged IPC, and the Docker manager owns image,
container, release, storage-volume, and remote-instance orchestration.

## What It Does

- Detects Docker Desktop or Docker Engine availability.
- Lists Agent Zero backend releases and local Docker images.
- Manages Agent Zero Versions and Instances: downloads, updates, activates, starts, stops, and switches.
- Keeps retained instances available for rollback.
- Shows local containers, saved remote instances, and storage volumes.
- Opens Agent Zero UIs from the instance where they belong.
- Installs and maintains the official A0 CLI, with per-Instance actions to open
  it or run installation/update explicitly.
- Offers opt-in, tab-leased Host access for local files, browser, and computer
  control without making CLI installation part of Instance setup.

## Tab Shortcuts

- **Ctrl+1..9** (Windows/Linux) or **Cmd+1..9** (macOS): select that tab
  position, counting Launcher as tab 1.
- **Ctrl+Tab** / **Ctrl+Shift+Tab**: select the next / previous tab, wrapping
  at either end.
- **F5**: reload the active Instance.

Tab switching follows the current order in the main window and excludes
detached Instances.

Tabs use the Instance's favicon by default. Colour/Icon offers Favicon alongside
the custom icons, including Globe; your saved custom choice takes precedence.
Use **Upload image** to choose your own image or SVG, then **Save** to keep it
as the Instance icon. The Launcher saves a copy, so you can move the source file.
The first colour option, **Custom**, opens a colour picker alongside the presets.

## Runtime Model

The launcher has two layers:

1. **Shell** (`shell/`)
   - Electron main process, preload bridge, secure windows, and IPC.
   - Downloads release content from GitHub Releases when local content is not
     requested.
   - Owns privileged Docker and terminal-launch behavior through
     `shell/docker_manager/` and `shell/docker_adapter/`.

2. **Renderer content** (`app/`)
   - Static HTML, CSS, ES modules, local Agent Zero UI assets, and
     `<x-component>` includes.
   - Bundled into `content.json` by GitHub Actions for release content updates.
   - Served by the shell through the `a0app://` protocol so `fetch()`, ES module
     imports, and relative URLs work like they would on a local web server.

Packaged and normal non-local runs load `content.json` from the latest configured
GitHub Release and cache it under Electron `userData`. Local UI work should opt
into local content explicitly.

Packaged runs also use `electron-updater` metadata from the latest launcher
GitHub Release. When a newer executable exists, the startup screen can offer an
`Update` button that downloads the updater payload, then restarts to install it
once the payload is ready. `Continue` opens the launcher without updating.

## Requirements

- Node.js 20+
- npm 9+
- Docker Desktop, Docker Engine, Colima, or rootless Docker for Docker Manager
  features

Runtime setup and repair notes are in
[docs/runtime-troubleshooting.md](docs/runtime-troubleshooting.md).

## Quick Start

```bash
npm install
npm start
```

Plain `npm start` exercises the release-content path. That means it may show the
latest downloaded `content.json`, not your edited local `app/` files.

For local UI development, run:

```bash
A0_LAUNCHER_LOCAL_REPO=. npm start
```

You can also use the current working directory when it contains `app/index.html`
and `package.json`:

```bash
A0_LAUNCHER_USE_LOCAL_CONTENT=1 npm start
```

Content-source precedence:

1. `A0_LAUNCHER_LOCAL_REPO=<path>`
2. `A0_LAUNCHER_USE_LOCAL_CONTENT=1`
3. GitHub Release `content.json`

To test release content from a fork or another repository:

```bash
A0_LAUNCHER_GITHUB_REPO="owner/a0-launcher" npm start
```

## Docker Manager Development

Useful backend overrides:

```bash
A0_BACKEND_GITHUB_REPO="owner/agent-zero" npm start
A0_BACKEND_IMAGE_REPO="namespace/agent-zero" npm start
```

The default backend image is `agent0ai/agent-zero`, and the default backend
release metadata repository is `agent0ai/agent-zero`.

Launcher checks the official A0 CLI in the background at startup, installing it
when missing or incompatible and updating it when a newer release is available.
This does not enable Host access: a gateway runs only for an Instance whose Host
access setting was explicitly enabled while its Launcher tab or detached window
is open. Each local and saved remote Instance menu shows `Install A0 CLI` while
the system CLI is missing, then replaces it with `Open A0 CLI`. A0 CLI v2.5 is
the first release carrying the Launcher gateway contract. Launcher 1.4 uses the
`computer_use_setup_v1` capability introduced in A0 CLI 2.6 to stage macOS
Accessibility and Screen Recording setup after Computer Use is enabled. Saved
permission choices remain on when runtime setup needs attention; subsequent
launches preflight silently instead of reopening system prompts.

## Validation

There is no default `npm test` contract yet. For quick validation, use:

```bash
node --check shell/main.js
node --check shell/preload.js
node --check shell/docker_manager/index.js
node --check app/docker_manager.js
git diff --check
```

For visible UI changes, run local content and inspect the affected screen:

```bash
A0_LAUNCHER_LOCAL_REPO=. npm start
```

## Build Executables

```bash
npm install --prefix packaging
npm run desktop:dist
npm run desktop:dist:mac
npm run desktop:dist:win
npm run desktop:dist:linux
```

Platform-specific examples:

```bash
npm run desktop:dist:mac -- --arch arm64
npm run desktop:dist:mac -- --arch x64
npm run desktop:dist:win -- --arch arm64
npm run desktop:dist:win -- --arch x64
npm run desktop:dist:linux -- --arch arm64
npm run desktop:dist:linux -- --arch x64
```

Release artifacts are:

- macOS x64/arm64 DMG and updater ZIP
- Windows x64/arm64 NSIS setup EXE
- Linux x64/arm64 AppImage
- `electron-updater` metadata files
- `content.json`

Linux DEB/RPM and Windows Squirrel/NuGet artifacts are intentionally not
published in the updater-capable release path unless the product decision
changes.

Packaged updater debugging follows the Space Agent flow. Open DevTools in a
packaged launcher and use:

```js
space.checkForUpdates()
space.debugReinstall('v0.4')
space.installUpdate()
```

`debugReinstall(version)` stages and downloads the requested release metadata,
including downgrades. After it finishes, click `Restart` on the startup screen or
run `space.installUpdate()`.

## macOS Signing

For local or fork builds, unsigned macOS artifacts are usually enough:

```bash
SKIP_SIGNING=1 npm run desktop:dist:mac
```

Release-grade macOS signing and notarization in GitHub Actions require:

- `MACOS_CERT_P12`
- `MACOS_CERT_PASSPHRASE`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

When Apple credentials are absent, the workflow still builds unsigned macOS
artifacts.

## Release Process

GitHub Actions owns the release path:

1. Create or move a `v*` tag intentionally.
2. Push the tag. `build.yml` builds updater-capable executable artifacts,
   stages canonical release asset names, creates or updates the GitHub Release,
   and uploads installers plus updater metadata.
3. `bundle-content.yml` checks out the tag, bundles `app/` into `content.json`,
   and uploads it to the release.

Two-segment tags such as `v1.8` are the public release shape. Executable builds
normalize them to full semver versions such as `1.8.0` only where packaging or
updater tooling requires it, while public asset names keep `1.8`.

After publishing, verify release assets with:

```bash
gh release view <tag> --repo agent0ai/a0-launcher --json assets \
  --jq '[.assets[].name]'
```

## Repository Layout

```text
a0-launcher/
├── .github/workflows/       # Release executable and content bundle workflows
├── app/                     # Static renderer source content
│   ├── a0ui/                # Portable Agent Zero UI primitives and vendor assets
│   ├── components/          # Docker Manager component views
│   ├── docker_manager.css   # Launcher UI styles
│   ├── docker_manager.js    # Renderer state coordinator and action facade
│   └── index.html           # Renderer entrypoint
├── docs/                    # Supplemental user-facing docs and release notes
├── packaging/               # electron-builder release and updater metadata tooling
├── scripts/                 # Build metadata and bootstrap helpers
├── shell/                   # Electron shell, preload, content loading, IPC
│   ├── docker_adapter/      # Docker and registry abstraction layer
│   └── docker_manager/      # Agent Zero image, instance, release, and volume logic
├── AGENTS.md                # Repo-wide coding-agent contract
├── forge.config.js          # Electron Forge makers and packaging config
└── package.json
```

Coding agents should read `AGENTS.md` first. Each subtree may also have its own
`AGENTS.md` with closer implementation contracts.

## License

MIT
