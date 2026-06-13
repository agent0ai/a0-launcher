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
- Local development content is selected by `A0_LAUNCHER_LOCAL_REPO`,
  `A0_LAUNCHER_USE_LOCAL_CONTENT`, or the first non-option app path in a
  default-app Electron launch. The default-app path matters for Windows RunOnce
  runtime setup resumes, where the original environment variables may be gone.
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
- `dockerManagerAPI` owns all Docker Manager calls.
- Runtime setup IPC is a named Docker Manager intent. The renderer may request
  setup/start, but assessment and privileged mechanics stay in
  `shell/docker_manager` and `shell/docker_adapter`.
- Windows client WSL setup may request UAC through an explicit runtime setup
  action. Keep that path narrowly scoped to WSL feature/distro setup; do not add
  generic command execution IPC.
- Runtime state may expose HTTP(S) manual guide URLs, but `shell/main.js` must
  continue sanitizing that field before it reaches the renderer.
- Long-running Docker operations should return an accepted operation id and
  report progress through Docker Manager events instead of blocking the renderer.
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
