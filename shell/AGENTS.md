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
- macOS runtime setup is shell-owned privileged work. Renderer code may call
  only named Docker Manager methods such as `getRuntimeSetupState()` and
  `startRuntimeSetup()`; it must never provide shell commands, helper paths,
  sudo credentials, or raw process arguments.
- New windows that open Agent Zero UIs or remote instances must sanitize URLs and
  allow only `http:` or `https:`.
- The A0 CLI terminal IPC must accept only local `http:` or `https:` URLs
  without credentials.
- External links should open through Electron `shell.openExternal` only after
  validation.
- Instance UI tabs are shell-owned `WebContentsView`s. Renderer code may request
  open/select/close/reload/detach and report viewport bounds, but URL
  resolution, URL validation, web contents lifecycle, and detached windows stay
  in `shell/main.js`.
- Local development content is selected by `A0_LAUNCHER_LOCAL_REPO` or
  `A0_LAUNCHER_USE_LOCAL_CONTENT`.
- Non-local content comes from the configured GitHub Release `content.json`
  asset and is unpacked under Electron `userData`.
- Release bundles may contain legacy string file entries or structured
  `{ encoding, data }` entries. The loader must preserve `utf8` text and decode
  `base64` binary assets while rejecting unsafe paths.
- Legacy cache metadata with `version: "dev-local"` must never block release
  updates. Use explicit local-content mode for development instead of
  future-dated sentinel timestamps.
- The `a0app://` custom protocol is the renderer content origin; keep URL
  resolution, fetch, and CSP compatible with that scheme.
- `content_meta.json` owns the downloaded content version shown as `Content:`.
- `app.getVersion()` owns the app version shown as `App:`.
- `electronAPI` owns shell metadata: status/error listeners, app/content version,
  and icon data URL.
- Runtime app branding is shell-owned. `shell/assets/icon.png`, `icon.ico`, and
  `icon.icns` are the Agent Zero application icons for window, tray,
  renderer-header, Dock, and packaged app surfaces. `shell/main.js` must set the
  macOS Dock icon explicitly during local/dev Electron runs because those runs
  otherwise inherit the stock `Electron.app` icon.
- `dockerManagerAPI` owns all Docker Manager calls.
- Long-running Docker operations should return an accepted operation id and
  report progress through Docker Manager events instead of blocking the renderer.
- Runtime setup uses the same progress event contract with
  `type: "runtime_setup"` plus sanitized `setupStep` and `setupCode` strings.
  `docker-manager:installDocker` remains the Docker Desktop fallback path.
- `docker-manager:getInventory` must return renderer-safe inventory only:
  `dockerAvailable`, `images`, `containers`, `volumes`, `remoteInstances`, and
  a sanitized `environment` summary limited to display-safe primitive fields.
  It must not expose `environment.dockerHost`, `diagnosticDetails`, Docker host
  overrides, socket paths, daemon host internals, or raw adapter diagnostics.
- Inventory `images` entries must be built from an allowlist before crossing
  IPC: `imageRef`, `tag`, `createdAt`, and `sizeBytes`.
- Inventory `containers` entries must be built from an allowlist before
  crossing IPC: `containerId`, `containerName`, `instanceName`, `imageRef`,
  `state`, `status`, `createdAt`, `startedAt`, `uiUrl`, and only exact
  renderer-used launcher labels such as `a0.launcher.role=active`. Do not pass
  arbitrary Docker labels, port objects, or raw inspect data.
- Inventory `volumes` entries must be built from an allowlist before crossing
  IPC: `name`, `driver`, `scope`, and `createdAt`. They must not expose Docker
  `Mountpoint` values, adapter `mountpoint` fields, Docker labels, or any raw
  Docker host paths.
- Inventory `remoteInstances` entries must be built from an allowlist before
  crossing IPC: `id`, `name`, and validated `http:` or `https:` `url`.
- `docker-manager:getRuntimeSetupState` must return a renderer-safe summary:
  `runtimeBackend`, `machineName`, `hasDockerHostOverride`,
  `usesDefaultDockerSocket`, and `lastSuccessfulSetupAt`. It must not expose raw
  Docker host overrides, socket paths, helper paths, or command details.
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
