# AGENTS.md

Guidance for AI coding agents working in `/home/eclypso/a0/a0-launcher`.

## Purpose

This root DOX file owns repo-wide policy for the Agent Zero Launcher and is the
first contract to read before editing any project file.

The launcher is an Electron desktop app that lets people install, activate,
switch, inspect, and open Dockerized Agent Zero instances without needing to
learn Docker first. It also lets people save and open remote Agent Zero
instances running on a VPS or URL without setting up local Docker. Build it as
if elegance and reliability are the same requirement: clear, restrained,
robust, and worthy of the Agent Zero brand.

## Ownership

This scope owns top-level project policy, product language, release/version
expectations, development commands, and the Child DOX Index.

Root-owned files and folders:

- `AGENTS.md`: repo-wide DOX rail and Child DOX Index.
- `README.md`: public product overview and user/developer quick start.
- `TODO.md`: pending work, investigation findings, and acceptance checks.
- `package.json` and `package-lock.json`: Electron app version, dependencies,
  npm scripts, and local-dev fallback metadata.
- `forge.config.js`: legacy Electron Forge makers for local/manual executable
  packaging.
- `.gitignore`, `LICENSE`: repository metadata.
- Child-owned areas listed in the Child DOX Index below.

## Local Contracts

DOX contracts:

- Treat every `AGENTS.md` file as the source of truth for its subtree.
- Before editing, read this file, identify the paths you expect to touch, then
  walk from the repo root to each target path and read every `AGENTS.md` on that
  route.
- If a parent lists a child `AGENTS.md` whose scope contains the target path,
  read the child and continue downward.
- The closer `AGENTS.md` controls local details. No child may weaken these root
  DOX rules.
- After every meaningful change, make a DOX pass: update the closest owning
  `AGENTS.md`, update affected parents or children, refresh Child DOX Indexes,
  and remove stale or contradictory notes.
- Keep public product copy in `README.md` and `docs/`. Keep durable development
  contracts in `AGENTS.md`.

Architecture contracts:

- First-run onboarding starts with local/remote choices and persists local
  intent and completion in Docker Manager state. Completed users never receive
  automatic onboarding again; unavailable runtimes use explicit Runtime Setup
  recovery. First-image download/extraction may use background progress.

- `app/` is the static renderer/content layer.
- `shell/` is the privileged Electron main/preload and Docker orchestration
  layer.
- `shell/docker_manager/` is the product-level Agent Zero image, instance,
  storage-volume, release, retention, and remote-instance orchestration layer.
- `shell/docker_adapter/` is the generic Docker and Docker Hub abstraction.
- Renderer code requests intent; shell code owns privilege; Docker adapter code
  owns Docker mechanics.
- Launcher Host access is an outbound, tab-leased `a0 gateway` child supervised
  by the Electron shell. It is not an inbound app server or background daemon:
  closing the owning tab or detached window, destroyed web contents, and app
  cleanup end the lease. Detaching transfers the same lease, while
  Launcher-home selection and in-tab reload keep it alive. Disconnect suppresses
  that lease until the user reconnects from the Launcher Host access modal or
  closes it. Agent Zero pages expose no Host access menu or Launcher bridge.
- A0 Tag is a default-off Launcher feature leased to one exact open Instance
  surface and its existing outbound gateway. Settings owns its Instance and
  default-profile selection; the fixed global shortcut captures an explicit
  `@a0` or `@a0.<profile>` request when the focused app exposes a safe editable
  range, and otherwise opens a shell-owned command palette for an explicit
  computer-wide request. The app restored after the palette closes is the
  natural starting context when the request refers to the current app; there is
  no separate palette scope selector or permission mode. Each invocation creates
  a new tagged A0 CLI chat. The Main model chooses exact field replacement or
  ordinary Computer Use action, inheriting the gateway's existing scopes and
  safeguards. The command palette microphone delegates to the exact leased
  Instance tab's built-in Whisper STT store: Agent Zero retains microphone,
  model, toast, and draft/send ownership, while Launcher receives only the
  bounded final transcript and exposes the Instance's first-use model-loading
  notice in its footer. Its native file/folder chooser keeps selected host
  paths in the shell, uploads them through the already-authenticated gateway,
  and passes only validated Agent Zero upload references to the tagged chat.
  Do not add a daemon, passive text watcher, inbound protocol, duplicate speech
  or upload backend, or duplicate permission matrix.
- Attached Instance tabs can be reordered by dragging their labels. Releasing a
  dragged tab outside the tab strip detaches it through the same shell-owned
  reparenting path as the dedicated Detach button. F5 refreshes the active
  attached or detached Instance page through the shell-owned reload path.
  Attached views fill the native content area below the measured tab strip;
  the shell converts its CSS position using Launcher-page zoom, not display scale.
  Tab shortcuts follow visible attached-tab order with Launcher in position 1:
  Cmd+1..9 on macOS or Ctrl+1..9 elsewhere selects that position; Ctrl+Tab and
  Ctrl+Shift+Tab cycle with wraparound. Detached windows keep their own focus.
- A running local Instance menu exposes `Restart`. It uses Docker's native
  immediate container restart through the per-Instance background queue and
  waits for the Agent Zero UI to become reachable again.
- Launcher startup asynchronously installs the official A0 CLI when it is
  missing or lacks the Launcher gateway contract, and updates it when a newer
  release is available. Compatible installations use `a0 update`, while Windows
  fresh installs run a downloaded temporary PowerShell file without inline
  execution or `Bypass`. Installing the CLI grants no host capability by itself:
  only an explicitly enabled Host access choice on an open Instance tab may
  start a gateway lease. An Instance menu shows `Install A0 CLI` while the
  system CLI is missing and replaces it with `Open A0 CLI` once installed.
  Create/Add Instance and Host access settings do not include a separate CLI
  installer step. Official compatible CLI packages include the Python
  Playwright client used for host Browser launch without bundling Chromium;
  `Set up browser` repairs older or damaged CLI environments in place.
- On macOS, Browser Host access may also select Safari through the connector's
  system `safaridriver` support. Launcher setup must direct the user to Safari >
  Settings > Advanced > Show features for web developers, then Developer >
  Allow remote automation, and must not toggle that browser security setting
  silently.
- A0 CLI v2.5 is the first connector release with the Launcher gateway
  contract. Continue capability-gating gateway candidates rather than replacing
  that contract check with a version comparison; an unreleased sibling
  development checkout may advertise the capability before the public release.
- A0 CLI v2.6 is the first connector release expected to advertise
  `computer_use_setup_v1`. Capability-gate the correlated Computer Use setup
  command separately from the base gateway contract. On macOS, a newly enabled
  Computer Use choice may prompt once through the staged setup flow. Electron
  owns the Accessibility prompt so TCC grants the packaged Launcher or the
  Electron dev build that actually launched the helper; the connector continues
  Screen Recording and runtime validation afterward. Later launches preflight
  silently and keep the saved choice enabled when runtime permission setup needs
  attention.
- A successful manual login in an eligible Instance tab may offer one branded,
  shell-owned modal child window with `Save credentials` / `Not now` when that
  Instance has no launcher-saved credentials. Login detection and pending
  passwords stay shell-owned and in-memory; the static modal receives no
  credential values, and persistence still requires explicit consent through
  the existing encrypted credential store.

Runtime and release contracts:

- Shell: `bash`.
- OS: Ubuntu Linux.
- Workspace: `/home/eclypso/a0/a0-launcher`.
- Use Linux paths and commands in examples.
- Do not assume Windows-only paths such as `.\.venv\Scripts\python`; use Linux
  virtualenv paths like `./.venv/bin/python`.
- `npm start` from the repository root uses local app contents. For explicit
  local-content selection, use:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```

- The compact header shows the Agent Zero wordmark without visible launcher
  version text. Electron `app.getVersion()` still reads the root `package.json`
  version and remains available through renderer metadata for diagnostics and
  update decisions.
- Keep `package.json` and the root entries in `package-lock.json` aligned with
  the current two-segment release line, such as `1.2`, so local `npm start`
  runs do not show stale metadata.
- Packaged or non-local runs fetch `content.json` from the latest GitHub Release
  for the configured launcher repo and unpack it under Electron `userData`.
- Packaged startup uses `electron-updater` GitHub metadata to compare Electron
  `app.getVersion()` with the latest launcher executable release. When a newer
  launcher executable is available, the loading screen may hold with `Update`
  and `Continue` actions; `Update` downloads the updater payload and then
  runs `a0 update` before restarting through `quitAndInstall()` once the payload
  is ready. A CLI update failure remains non-blocking and is logged.
- Do not hold ordinary startup for decorative delay beyond the brief splash
  entry and exit animations. The first renderer state should rebuild live local
  Docker data from normal remote caches, then refresh remote metadata fully in
  the background when the cached catalog predates that launch; explicit Refresh
  remains a forced freshness check.
- Packaged DevTools expose `window.space.debugReinstall(version)` plus
  `checkForUpdates()`, `downloadUpdate()`, and `installUpdate()` for targeted
  updater testing against a specific release version. This is a debugging
  surface, not product UI.
- `A0_LAUNCHER_GITHUB_REPO` can override the launcher content repository.
- `A0_LAUNCHER_USE_LOCAL_CONTENT=true` can use the current working directory as
  local content when it contains `app/index.html` and `package.json`.
- Docker images default to `agent0ai/agent-zero`.
- Normal Create local Instance pickers list only Agent Zero releases and local
  Agent Zero builds. Arbitrary Docker images belong to the Advanced developer
  flow and must not appear as normal versions or setup choices.
- Advanced Developer is a file-first Docker workspace. It may open bounded
  project-root Dockerfiles, Compose YAML, `.dockerignore`, and `.env.example`
  files; edit them through the bundled code editor; save or export them through
  named shell-owned file intents; and run only fixed Validate, Build, Up, Stop,
  Logs, and Down actions against the selected Docker runtime. Keep quick custom
  image execution as a subordinate one-off flow and never expose generic shell
  or Docker command execution.
- Local and saved remote Instance cards derive their running code identity from
  Agent Zero's `/api/health` Git metadata. A local Instance without health
  metadata may show the bounded branch from `/a0/.git/HEAD`, but health-derived
  and cached `R v...` identity remains preferred. Cache the last valid identity
  by Instance ID so stopped or temporarily offline Instances keep their
  last-seen version until a later successful health check replaces it.
- A saved runtime endpoint is a preference, not a lock: use it while reachable,
  temporarily fall back to another reachable endpoint, and return to it later.
  Explicitly starting or selecting a runtime makes that endpoint preferred.
- Backend release metadata defaults to `agent0ai/agent-zero`.
- `A0_BACKEND_IMAGE_REPO` and `A0_BACKEND_GITHUB_REPO` may override those repos
  for testing.
- Keep every reachable Docker endpoint available for preference and fallback,
  but show the first-run runtime picker only when those endpoints identify two
  or more distinct Docker daemons. Endpoint aliases and unidentified daemons
  must not create a picker choice by themselves.
- An installed stopped Docker Desktop may count as one additional first-run
  choice when another daemon is reachable. Label it as stopped and start it
  through the existing platform runtime setup before saving the preference.
- Launcher-managed local instances should mount isolated persistent workspace
  storage at `/a0/usr` by default. The default backing store is a per-instance
  host directory under `~/agent-zero`; named Docker volumes are an advanced
  alternative, and explicit no-volume runs are ephemeral.
- Cloning an Instance should reuse its configured image reference, falling back
  to the source image ID, and copy selected `/a0/usr` data into fresh storage.
  Do not create a committed snapshot image for ordinary clones.
- `v*` tags are release inputs for executable builds.
- Public release tags and launcher metadata use two-segment versions such as
  `v1.8` / `1.8` when the patch is zero. Packaging normalizes them to full
  semver such as `1.8.0` only where Electron tooling or updater comparisons
  require it.
- Release executable artifacts are macOS x64/arm64 DMG plus updater ZIP,
  Windows x64/arm64 NSIS setup EXE, Linux x64/arm64 AppImage, and
  `electron-updater` metadata files. Release content remains `content.json`.
  Linux DEB/RPM and Windows Squirrel/NuGet artifacts are intentionally omitted
  from the updater-capable release path unless the product decision changes.
- Windows NSIS installers use decoder-compatible app archives plus
  `packaging/platforms/windows/installer.nsh` for installer diagnostics,
  hardened running-app shutdown, and direct executable launch after
  installation so first run does not depend on shortcut creation.
- Windows uninstall removes the Launcher-owned `%APPDATA%\\a0-launcher`
  user-data directory.
- If a release tag is moved to include a metadata fix, keep `main`, the tag, and
  both remotes intentionally aligned.

Agent Zero runtime assumptions:

- When discussing plugin/backend code, treat the Dockerized Agent Zero instance
  at `localhost:32081` as the live runtime.
- If you change live runtime plugin/backend code, also copy those changes into
  the real A0 Core plugin repo:

```bash
/home/eclypso/a0/agent-zero/plugins
```

- Do not leave runtime-only plugin changes stranded in the container.

Product language:

- Say `Instances`, not `Sessions`, for running or retained containers.
- Remote Instances are a first-run path, not an advanced fallback. Do not force
  local Docker setup or an image pull before a user can add a remote Agent Zero
  URL.
- Say `Storage volumes`, not just `Storage`, when referring to Docker volumes.
- Downloaded Versions may be removed from the Versions view, but image removal must be a
  non-forced Docker image delete so Docker refuses removal while any Instance
  still references the image.
- Keep instance deletion separate from workspace deletion. Host workspace
  directories and named Docker volumes should survive container removal unless a
  user takes an explicit storage cleanup action.
- Backup and Restore for local Instances operate on the Agent Zero workspace
  path `/a0/usr` and should use the same backup shape Agent Zero core uses.
- Per-Instance Colour/Icon choices are launcher identity metadata. The bounded
  colour tints the card and tab icon, while the bounded icon identifies attached
  and detached tabs without mutating Docker labels or runtime behavior.
  Colours accept preset IDs or six-digit RGB hex values from the Custom picker.
  The default icon follows the Instance favicon, with the Agent Zero symbol as
  fallback. Explicit custom icons take precedence; Favicon and Globe are both
  available in the picker. Favicon image data is transient, shell-owned tab state.
  Upload image uses a native chooser and saves a bounded image copy in the same
  appearance metadata only on Save, independent of the original host file.
- Keep Docker mechanics behind purposeful controls.
- Put `Open UI` where the instance lives, not in the global header.
- Keep the surface quiet and precise: avoid excessive borders, nested cards, and
  explanatory clutter.
- The API Dashboard destination is:

```text
https://www.agent-zero.ai/p/community/api-dashboard/
```

Security and boundaries:

- Docker access belongs behind IPC and `shell/docker_manager`.
- Renderer code should call `window.dockerManagerAPI` through the preload
  surface.
- Keep Electron windows secure: `contextIsolation: true`, `nodeIntegration:
  false`, and `sandbox: true` unless there is a documented reason.
- Host gateway credentials remain shell-owned and may reach the CLI only as
  ephemeral environment variables. Gateway processes use the existing
  authenticated Agent Zero connector protocol and are capability-gated; do not
  add generic renderer execution IPC, inbound listeners, or a second host-tool
  protocol.

## Work Guidance

- Follow existing patterns before inventing new ones.
- Keep changes narrowly scoped to the requested behavior.
- Use structured APIs and parsers when available; avoid fragile string
  manipulation for nontrivial data.
- Prefer small helpers when they remove real complexity.
- Add comments only where they explain a non-obvious decision.
- Default to ASCII unless the file already uses meaningful Unicode.
- Do not create hidden scratch directories or commit generated outputs unless a
  checked-in fixture is explicitly requested.
- Build the usable app first, not a landing page.
- Use Agent Zero's existing visual language and local tokens.
- Prefer familiar icon buttons for obvious controls such as refresh.
- Avoid boxy chrome where a lighter grouping works better.
- Make interactive states clear: loading, disabled, empty, success, and error.
- Keep text short and task-oriented.
- Verify text does not overflow compact controls or cards.

Git discipline:

- Make separate, logical, no-nonsense commits when the user asks for commits.
- Do not stage unrelated user changes accidentally.
- Do not revert user changes unless explicitly asked.
- Before committing, inspect `git status --short` and the staged diff.

## Verification

There is no default `npm test` contract in this repo unless a future commit adds
one.

For quick validation, prefer:

```bash
node --check shell/main.js
node --check shell/preload.js
node --check shell/docker_manager/index.js
node --check app/docker_manager.js
node --test shell/a0_cli_install.test.js shell/host_gateway.test.js
node --test shell/remote_certificate_trust.test.js
node --test shell/docker_manager/instance_health_certificate_trust.test.js
node --test shell/docker_manager/state_store_remote_instance_edit.test.js
node --test app/components/docker-manager/remote-instance-certificate-trust.test.mjs
node --test shell/launcher_updater_debug_release.test.js
git diff --check
```

For shell instance-tab logic, run:

```bash
node --test shell/instance_tabs.test.js
```

For visible UI changes, run local content and inspect the affected workflow:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```

## Child DOX Index

This index must stay exhaustive.

- `/.github/AGENTS.md`: GitHub Actions release builds and content bundling.
- `/app/AGENTS.md`: static renderer app, renderer state, assets, and component
  loading.
  - `/app/a0ui/AGENTS.md`: portable Agent Zero UI framework assets and vendored
    browser dependencies.
  - `/app/components/docker-manager/AGENTS.md`: Docker Manager renderer
    components and component store.
- `/docs/AGENTS.md`: supplemental user-facing documentation.
- `/packaging/AGENTS.md`: electron-builder packaging, release artifact staging,
  and updater metadata helpers.
- `/scripts/AGENTS.md`: developer and build helper scripts.
- `/shell/AGENTS.md`: Electron main/preload host, content loading, IPC, windows,
  and privileged orchestration.
  - `/shell/docker_adapter/AGENTS.md`: generic Docker and Docker Hub adapter.
  - `/shell/docker_manager/AGENTS.md`: Agent Zero Docker Manager product layer.
