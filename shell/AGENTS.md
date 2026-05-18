# AGENTS

## Purpose

`shell/` owns the Electron host: main process, preload bridge, content loading,
window policy, tray behavior, IPC, and the bridge to Docker orchestration.

This layer is privileged. Keep it narrow, explicit, and boring in the best way.

## Documentation Hierarchy

Child docs:

- `/shell/docker_manager/AGENTS.md`
- `/shell/docker_adapter/AGENTS.md`

Keep this file focused on Electron-wide contracts. Put Docker Manager behavior
in `/shell/docker_manager/AGENTS.md` and Docker/Docker Hub mechanics in
`/shell/docker_adapter/AGENTS.md`.

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

## Electron Security Contracts

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
- External links should open through Electron `shell.openExternal` only after
  validation.

## Content Loading Contracts

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

## IPC And Event Contracts

- `electronAPI` owns shell metadata: status/error listeners, app/content version,
  and icon data URL.
- `dockerManagerAPI` owns all Docker Manager calls.
- Long-running Docker operations should return an accepted operation id and
  report progress through Docker Manager events instead of blocking the renderer.
- Error responses should use `dockerManager.toErrorResponse()` so renderer code
  sees a stable `{ code, message }` shape.
- The tray should reflect current Docker Manager state without becoming a second
  state owner.

## Development Guidance

- Keep main-process code as orchestration. Put reusable Docker behavior in
  `shell/docker_manager` or `shell/docker_adapter`.
- Prefer one IPC method per user intent rather than generic "run command"
  bridges.
- When adding a renderer-visible action, update `shell/preload.js`,
  `shell/main.js`, `app/docker_manager.js`, and the owning `AGENTS.md` files in
  the same session.
- Avoid platform-specific assumptions unless the code explicitly checks
  `process.platform`.

## Testing

After shell changes, run:

```bash
node --check shell/main.js
node --check shell/preload.js
git diff --check
```

If IPC or content loading changed, launch local content:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```
