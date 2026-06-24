# AGENTS

## Purpose

`shell/` owns the Electron host: main process, preload bridge, content loading,
window policy, tray behavior, IPC, and the bridge to Docker orchestration.

This layer is privileged. Keep it narrow, explicit, and boring in the best way.

## Ownership

This scope owns:

- `shell/main.js`: Electron app lifecycle, content distribution, custom
  protocol, main windows, tray, IPC handlers, shell actions, and Docker Manager
  event forwarding.
- `shell/preload.js`: safe renderer bridge exposed through `contextBridge`.
- `shell/loading.html`: loading/error shell while content initializes.
- `shell/launcher_update.js`: launcher update version formatting and legacy
  platform release-asset selection helpers.
- `shell/launcher_updater_debug_release.js`: packaged updater metadata staging
  for DevTools-triggered upgrade, reinstall, and downgrade tests.
- `shell/launcher_updater_artifacts.js`: updater cache cleanup marker and
  pending-download cleanup helpers.
- `shell/launcher_updater_install_options.js`: updater diagnostic log path and
  install-option helpers.
- `shell/assets/`: application icons and platform entitlements.
- `shell/docker_manager/`: Agent Zero image and instance orchestration.
- `shell/docker_adapter/`: Docker and registry abstraction layer.

## Local Contracts

- Keep renderer windows on `contextIsolation: true`, `nodeIntegration: false`,
  and `sandbox: true` unless an exception is documented here.
- Do not expose `ipcRenderer`, raw channels, filesystem paths, shell execution,
  or Docker objects directly to the renderer.
- The preload bridge exposes named methods only. New IPC must be added to both
  `shell/preload.js` and `shell/main.js` deliberately.
- Validate IPC bodies in `shell/main.js` before passing values to
  `shell/docker_manager`.
- New windows that open Agent Zero UIs or remote instances must sanitize URLs and
  allow only `http:` or `https:`.
- The A0 CLI terminal IPC must accept only local `http:` or `https:` URLs
  without credentials. Terminal launch should stay shell-owned and work across
  Windows, macOS, and Linux when the `a0` CLI is installed or available in a
  sibling `a0-connector` development checkout. Launcher-owned instance launches
  should pass the known host directly to the CLI and only use CLI flags
  advertised by that installed `a0 --help`; use the direct `--connect` plus
  `--no-docker-discovery` path only when supported, otherwise pass `--host` and
  let the installed CLI use its normal discovery/autoconnect behavior. Before
  launching, the shell should use a native directory picker so the user chooses
  the CLI working folder; canceling that picker is a quiet no-op. Start the
  interactive CLI through a launcher-owned wrapper script rather than a long
  inline shell command so Textual receives normal terminal input.
- A0 CLI availability shown to the renderer is based on whether the `a0`
  terminal command can be discovered on the host. Installing A0 CLI is a named
  shell-owned intent that opens a fixed installer wrapper for the official
  `a0-connector` install script; do not expose generic command execution.
- External links should open through Electron `shell.openExternal` only after
  validation. Approved public launcher resources such as Docs, API Dashboard,
  and Support should be exposed to the renderer as fixed resource IDs, not
  arbitrary URL strings.
- Instance UI tabs are shell-owned `WebContentsView`s. Renderer code may request
  open/select/select launcher home/close/reload/detach and report viewport
  bounds, but URL resolution, URL validation, web contents lifecycle, and
  detached windows stay in `shell/main.js`. Local `Open UI` requests should wait
  briefly for a freshly running container's HTTP UI before returning an
  unavailable error.
- Local development content is selected by `A0_LAUNCHER_LOCAL_REPO`,
  `A0_LAUNCHER_USE_LOCAL_CONTENT`, a repo-shaped default-app current working
  directory, a repo-shaped unpackaged-app current working directory, or the
  first non-option app path in a default-app Electron launch. The default-app
  path matters for Windows RunOnce runtime setup resumes, where the original
  environment variables may be gone.
- Non-local content comes from the configured GitHub Release `content.json`
  asset and is unpacked under Electron `userData`.
- Packaged launcher executable update prompts use `electron-updater` metadata
  from the launcher GitHub Release. A newer executable may hold
  `shell/loading.html` with `Update` and `Continue`; `Update` downloads the
  updater payload, then becomes a restart/install action once downloaded.
- `electron-updater` stays configured with `autoDownload: false`,
  `autoInstallOnAppQuit: false`, web installers disabled, and differential
  download disabled. User intent must start download and install.
- The preload bridge intentionally exposes a DevTools debugging surface at
  `window.space` and `window.launcherUpdater` with `checkForUpdates()`,
  `downloadUpdate()`, `installUpdate()`, and `debugReinstall(version)`.
  `debugReinstall` may stage upgrades, reinstalls, or downgrades by reading the
  requested release metadata; keep it package-only and updater-owned.
- Startup begins in a transparent, frameless splash window that shows only the
  launcher icon and title. Before app content opens, `shell/main.js` sends the
  splash exit event, replaces that splash with the normal framed app window,
  then loads `a0app://content/index.html`.
- Release bundles may contain legacy string file entries or structured
  `{ encoding, data }` entries. The loader must preserve `utf8` text and decode
  `base64` binary assets while rejecting unsafe paths.
- Legacy cache metadata with `version: "dev-local"` must never block release
  updates. Use explicit local-content mode for development instead of
  future-dated sentinel timestamps.
- The `a0app://` custom protocol is the renderer content origin; keep URL
  resolution, fetch, and CSP compatible with that scheme.
- `content_meta.json` owns the downloaded content version exposed through
  shell metadata.
- `app.getVersion()` owns the launcher app version exposed to the renderer for
  diagnostics and update decisions. The default renderer header does not show
  visible launcher version text.
- `electronAPI` owns shell metadata: status/error listeners, app/content version,
  and icon data URL.
- `dockerManagerAPI` owns all Docker Manager calls.
- Runtime setup IPC is a named Docker Manager intent. The renderer may request
  setup/start, but assessment and privileged mechanics stay in
  `shell/docker_manager` and `shell/docker_adapter`.
- Docker Hub sign-in recovery is a named shell-owned intent. The renderer may
  request it, but `shell/main.js` must launch a visible wrapper around the real
  `docker login` flow instead of exposing generic command execution.
- Developer custom-image runs are named Docker Manager intents. The renderer may
  pass image, tag, environment, port, mount, and pull preferences, but shell code
  must keep validation and Docker execution behind `shell/docker_manager`; do not
  add generic shell or Docker command IPC.
- Docker CLI discovery for that sign-in flow should honor explicit
  `A0_DOCKER_CLI_PATH` or `DOCKER_CLI_PATH` overrides, then `PATH`, then known
  Docker Desktop, Homebrew, Linux package, and Snap locations before failing.
- Windows client WSL setup may request UAC through an explicit runtime setup
  action. Keep that path narrowly scoped to WSL feature/distro setup; do not add
  generic command execution IPC.
- Runtime state may expose HTTP(S) manual guide URLs, but `shell/main.js` must
  continue sanitizing that field before it reaches the renderer.
- Long-running Docker operations should return an accepted operation id and
  report progress through Docker Manager events instead of blocking the renderer.
  The sanitized progress bridge should preserve explicit product state flags
  such as `uiReady` when the renderer depends on them for handoff behavior.
- Install image removal is a named Docker Manager IPC intent. The renderer may
  pass a release tag, but shell code must validate the IPC body and Docker
  Manager must perform a non-forced image removal so Docker can refuse images
  still used by any container.
- Per-instance clone, rename, and color-selection operations are named Docker
  Manager intents. Clone may accept a bounded `/a0/usr` category selection, but
  archive copy and filtering stay in `shell/docker_manager` and
  `shell/docker_adapter`. Color selection may accept only bounded palette IDs
  and must stay launcher metadata. Long-running container mutations report
  progress.
- Per-instance Backup and Restore are named Docker Manager intents. The shell
  owns native save/open dialogs for `.zip` files; Docker Manager owns the
  `/a0/usr` archive semantics and progress events.
- Workspace storage preference and migration actions are named Docker Manager
  intents. They may expose storage mode/root/volume fields, but Docker mount
  creation, migration, and archive copy behavior must stay in
  `shell/docker_manager` and `shell/docker_adapter`.
- Opening an Instance storage folder is a named Docker Manager intent. The
  renderer passes a container id; the shell resolves and opens only validated
  host-directory workspace paths.
- Per-instance Docker log inspection is a named, bounded, read-only Docker
  Manager intent. Do not expose raw Docker log commands or shell execution.
- Error responses should use `dockerManager.toErrorResponse()` so renderer code
  sees a stable `{ code, message }` shape.
- The tray should reflect current Docker Manager state without becoming a second
  state owner.

## Work Guidance

- Keep main-process code as orchestration. Put reusable Docker behavior in
  `shell/docker_manager` or `shell/docker_adapter`.
- Prefer one IPC method per user intent rather than generic "run command"
  bridges.
- When adding a renderer-visible action, update `shell/preload.js`,
  `shell/main.js`, `app/docker_manager.js`, and the owning `AGENTS.md` files in
  the same session.
- Avoid platform-specific assumptions unless the code explicitly checks
  `process.platform`.

## Verification

After shell changes, run:

```bash
node --check shell/main.js
node --check shell/preload.js
node --test shell/launcher_update.test.js
node --test shell/launcher_updater_debug_release.test.js
node --test shell/instance_tabs.test.js
git diff --check
```

If IPC or content loading changed, launch local content:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```

## Child DOX Index

- `/shell/docker_adapter/AGENTS.md`: generic Docker and Docker Hub adapter.
- `/shell/docker_manager/AGENTS.md`: Agent Zero Docker Manager product layer.
