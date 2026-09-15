# AGENTS

## Purpose

`shell/` owns the Electron host: main process, preload bridge, content loading,
window policy, IPC, and the bridge to Docker orchestration.

This layer is privileged. Keep it narrow, explicit, and boring in the best way.

## Ownership

This scope owns:

- `shell/main.js`: Electron app lifecycle, content distribution, custom
  protocol, main windows, IPC handlers, shell actions, and Docker Manager event
  forwarding.
- `shell/preload.js`: safe renderer bridge exposed through `contextBridge`.
- `shell/developer_projects.js`: bounded, renderer-owned Docker project file
  sessions for native open, save, export, and project action targeting.
- `shell/credential_prompt.html` and `shell/credential_prompt.css`: static
  content and native-window layout for the shell-owned credential consent
  modal. Reuse the Launcher's shared dialog styles and never receive credential
  values.
- `shell/host_access.js`: normalized Launcher Host access defaults, per-Instance
  configuration, scope dependencies, and stable Instance keys.
- `shell/host_gateway.js`: supervised, newline-delimited JSON bridge to the
  installed `a0 gateway` child process.
- `shell/a0_tag.js` and `shell/a0_tag_overlay.*`: A0 Tag lease/controller,
  tagged headless child contract, GNOME Wayland shortcut fallback, and the
  static shell-owned command/result surface.
- `shell/a0_cli_install.js`: official A0 CLI installer command and release
  version policy used by Launcher CLI maintenance.
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
- The A0 CLI terminal IPC may accept a local `http:` or `https:` URL without
  credentials, or a saved remote Instance ID. Remote CLI launches must resolve
  the saved URL in `shell/main.js`; the renderer must not pass arbitrary remote
  URLs. Terminal launch should stay shell-owned and work across Windows, macOS,
  and Linux when the `a0` CLI is installed or available in a sibling
  `a0-connector` development checkout. Launcher-owned instance launches should
  pass the known host directly to the CLI and only use CLI flags advertised by
  that installed `a0 --help`; use the direct `--connect` plus
  `--no-docker-discovery` path only when supported, otherwise pass `--host` and
  let the installed CLI use its normal discovery/autoconnect behavior. Before
  launching, the shell should use a native directory picker so the user chooses
  the CLI working folder; canceling that picker is a quiet no-op. Start the
  interactive CLI through a launcher-owned wrapper script rather than a long
  inline shell command so Textual receives normal terminal input. If an Instance
  has launcher-saved credentials, pass them to `a0` only as ephemeral
  `A0_USERNAME` and `A0_PASSWORD` environment variables for that terminal launch
  when the target is local loopback or remote `https:`; do not write passwords
  into wrapper scripts or command lines.
- After Electron becomes ready, the shell asynchronously ensures that the
  system A0 CLI is installed, advertises the Launcher gateway contract, and is
  current with the latest discoverable `a0-connector` release. Use only the
  official fixed installer endpoint, keep failures non-blocking for the rest of
  Launcher, and expose checking/installing state to the renderer. The named
  `Install A0 CLI` intent is visible only while the system CLI is missing and
  must report completion instead of merely opening a terminal. Do not expose
  generic command execution. Installing or updating the CLI is not Host access
  consent; gateway startup still requires an enabled saved choice and an open
  eligible Instance tab. Preserve user-requested gateway disconnection while
  stopping and restarting other leases around CLI maintenance.
- Compatible installed CLIs update through `a0 update`; missing or gateway-incompatible
  CLIs use the official installer. Windows downloads that installer to a unique
  temporary `.ps1` file and runs PowerShell `-File` with `RemoteSigned`, then
  removes it on success or failure. Keep the installer child supervised rather
  than detached/unreferenced. Do not use inline download-and-execute or
  `ExecutionPolicy Bypass`. Update completion requires the inherited output pipes
  to close and the CLI updater's `Update complete. Run a0.` success line; the
  initial CLI process exiting only confirms handoff. Update failure must not
  trigger an automatic installer fallback.
- A0 CLI v2.5 is the first release expected to advertise the Launcher gateway
  contract. Keep actual gateway startup capability-gated so compatible
  development checkouts and future versions work without version-specific
  branches.
- A0 CLI v2.6 is the first release expected to advertise
  `computer_use_setup_v1`. The shell must capability-gate that command, correlate
  every request/result with `request_id`, reject pending requests on timeout or
  gateway exit, and keep the base gateway usable when the setup capability is
  absent. On macOS, the Electron shell owns the Accessibility prompt so TCC
  authorizes the actual packaged Launcher or Electron dev build; prompt once,
  poll silently, then let the connector continue staged Screen Recording and
  runtime validation. Later preflights remain non-prompting.
- External links should open through Electron `shell.openExternal` only after
  validation. Approved public launcher resources such as Docs, API Dashboard,
  and Support should be exposed to the renderer as fixed resource IDs, not
  arbitrary URL strings.
- Instance UI tabs are shell-owned `WebContentsView`s. Renderer code may request
  open/select/select launcher home/close/reload/reorder/detach/reattach and report viewport
  bounds, but URL resolution, URL validation, web contents lifecycle, and
  detached windows stay in `shell/main.js`. Preserve fractional CSS viewport
  coordinates until converting their origin with the Launcher renderer's zoom
  factor. Attached views fill the current native content bounds from that origin,
  including on main-window resize; do not multiply by display pixel density or
  use the embedded page's zoom. Null bounds still hide the view for Launcher
  modals and tab dragging. Detach reparents the existing view
  below a Launcher-owned header; reattach moves that same view back without a
  page reload. Main-window layout passes must leave detached views untouched
  because their detached windows own those bounds. Local `Open UI` requests
  should wait briefly for a freshly running container's HTTP UI before returning an
  unavailable error. Renderer open requests may pass a bounded Agent Zero
  section selector such as `self-update`; the shell validates the Instance URL,
  then opens only the matching known in-page Agent Zero modal or same-origin
  anchor. If a local Instance or saved remote Instance has
  launcher-saved credentials, `Open UI` may POST them to the same-origin Agent
  Zero `/login` route in the shell-owned browser session before loading the
  tab, and an already-open tab may repeat that recovery when a restart sends
  it back to `/login`; remote credential POSTs must stay on `https:` URLs
  unless the target is local loopback. Do not put credentials in URLs or expose
  decrypted passwords to the renderer. After a successful same-origin manual
  `/login` redirect, an eligible Instance tab with no saved credentials may
  show one branded modal child window with `Save credentials` / `Not now`.
  Observe the form only in the shell, never pass credential values into the
  static modal content, retain them only in memory until that choice, and
  persist them through the existing secure store only after explicit consent.
  After a tab starts from a validated
  Instance URL, in-tab navigation may stay on that Agent Zero origin, including
  same-origin anchors and callbacks; safe off-origin `http:` and `https:` URLs
  should open through the user's external browser. Embedded and detached Agent Zero UI
  web contents
  should attach the same shell-owned edit context menu so selected text and
  editable fields keep normal copy/paste behavior. F5 from an active attached or
  detached Instance surface must refresh that Instance page through the same
  cache-bypassing path as its Reload button, so an Agent Zero restart cannot
  strand aborted UI assets in the embedded view.
- Tab selection shortcuts use shell-owned `before-input-event` handling on the
  main renderer and the active attached Instance page, then reuse the existing
  selection paths and focus the selected surface. Cmd+1..9 on macOS and
  Ctrl+1..9 on Windows/Linux select the corresponding visible position, counting
  Launcher as 1. Ctrl+Tab and Ctrl+Shift+Tab cycle through Launcher and attached
  Instances in their current drag order, wrapping at either end. Detached
  surfaces and temporarily hidden active views do not switch the main window's
  tabs. Unmatched shortcuts remain available to the focused page.
- Each eligible Launcher-owned Instance surface may own exactly one outbound
  `a0 gateway` child. Start it only after an embedded tab opens, keep it alive
  across Launcher-home selection and in-tab reloads, and transfer that same
  lease when the tab moves into a detached window. Stop it when the owning tab
  or detached window closes, its current web contents are destroyed, or the app
  cleans up. Graceful shutdown must be allowed to finish before Electron exits
  so remote shell groups, browser sessions, Computer Use sessions, and the
  WebSocket are not orphaned.
- Missing Host access preferences normalize with the local master state off.
  Preserve explicit saved Instance choices ahead of tab/runtime snapshots;
  Settings owns local defaults and Create/Add Instance is the single initial
  opt-in point. The retained onboarding field is compatibility state only and
  must not gate gateway startup. Legacy loopback DevTools WebSocket browser
  selections from older connectors normalize to automatic detection so a
  restarted browser's port/GUID cannot remain pinned. Browser preparation's
  outer Launcher timeout must outlive the connector's bounded CDP attach so its
  structured result reaches the renderer.
- Launcher gateway supervision must use the installed CLI contract and JSONL
  stdin/stdout; it must not open an inbound port or expose a generic process
  surface through preload. Pass credentials only as ephemeral environment
  variables, never arguments or renderer state. Capability-gate startup on
  `launcher_gateway` plus `launcher_gateway_file_write` HTTP support and
  `launcher_gateway_control` WebSocket
  support, and select CLI candidates by their advertised `a0 gateway` contract
  rather than a release number so a capable sibling development checkout can
  follow an older installed CLI. Contract, authentication, and runtime exits
  stay stopped until an explicit Retry; a user-requested Disconnect is
  suppressed until the Launcher Host access modal reconnects that same lease or
  its owning tab/window closes.
  Keep gateway identity stable for the Launcher installation across tabs,
  preserve saved reverse-proxy base paths, reject URL credentials, and bound
  JSONL input before it enters renderer state. Treat stdout as a strict JSONL
  contract, require versioned status to match the requested gateway identity,
  send `file_read` for the separate read permission, and terminate children
  that do not publish valid status within the bounded startup window. The CLI
  reserves the older `files` argument for legacy read/write Launchers.
- A0 Tag stays shell-owned and capability-gated on gateway feature
  `a0_tag_v1`. The renderer may request a bounded profile list through one
  named action, but never receives generic gateway commands, target tokens,
  prompt context, credentials, or process handles. The selected Instance tab
  or detached-window lease, Host access master, and Computer Use scope must be
  live before shortcut registration and again before exact replacement.
- A0 Tag uses `CommandOrControl+Shift+Enter`, permits one invocation, sends the
  bounded prompt/context on stdin to a new capability-silent tagged chat, and
  treats the Main model's validated replace/action marker as delivery metadata.
  Replace mode may mutate only the helper's revalidated captured range and must
  never press Enter. Action mode uses ordinary Agent Zero Computer Use and
  reports its summary in the static sandboxed Copy/Dismiss overlay.
- If capture fails only because the foreground app exposes no safe inline tag
  range, the same invocation may open the static shell-owned command palette.
  Keep it sandboxed and context-isolated, accept only a bounded query, exact
  live profile key through the narrow local navigation intent, normalize every
  accepted palette request to Computer scope, and close it before tagged
  execution so the prior app can regain focus. That app is the natural starting
  context when the request refers to the current app, not a confinement rule.
  Protected fields, lease/permission/capability failures, and
  apply/revalidation failures remain fail-closed errors. Palette requests have
  no Launcher replacement target; only ordinary inherited Computer Use may
  operate another application.
- The palette's `+` menu may expose only Attach file and Attach folder through
  Electron's native chooser. Exact selected paths stay in the main process and
  may cross only the correlated `a0_tag_upload` gateway command; the sandboxed
  renderer receives bounded basenames/counts, and tagged argv receives only
  validated `/a0/usr/uploads/` references. Folder selection means its regular
  files, matching the WebUI composer; do not add renderer file access, upload
  credentials, a second HTTP client, or implicit workspace scanning.
  Anchor the menu to its `+` trigger with the WebUI composer's four-pixel gap;
  do not anchor it to the outer palette card.
  On Linux Wayland, keep the transparent composer window at its expanded size
  and switch Electron's native window shape between the closed card and the
  open menu canvas; compositor-owned positioning makes resize/reposition move
  the visible card. Other platforms may retain the bottom-anchored resize path.
- The palette microphone must reuse the exact leased Instance page's bundled
  `_whisper_stt` store through the existing narrow local navigation surface.
  On macOS, the shell must request native microphone consent for the actual
  packaged Launcher or Electron development identity before that Instance page
  starts recording; denied consent remains macOS-owned and requires the normal
  System Settings plus application-restart recovery.
  Keep raw microphone audio, device selection, silence detection, model loading,
  transcription requests, and Agent Zero toast calls inside that authenticated
  Instance web contents. Launcher may receive only a bounded final transcript,
  cancellation/error state, and the plugin's configured draft/send choice.
  Read the same Instance's status before recording and surface a bounded footer
  notice when Whisper or its selected model must be prepared, downloaded, or
  loaded; backend errors still use the mirrored palette toast.
  Closing, submitting, lease loss, or pressing the microphone again must stop
  the live plugin microphone session. Do not add an overlay preload, renderer
  credentials, raw-audio IPC, or a second speech service.
- Prefer Electron `globalShortcut`. On GNOME Wayland only, if the desktop lacks
  the GlobalShortcuts portal, one reversible native custom media-key binding
  may signal the current Launcher process. It must check conflicts, preserve
  foreign bindings, exist only while the exact lease is ready, and remove only
  its own path on lease loss/shutdown. The fallback command must match both the
  current PID and its Linux process start time before signaling, so stale PID
  reuse cannot target an unrelated process. Never replace it with a keylogger
  or clipboard/accessibility watcher. Do not create a progress BrowserWindow
  on Linux Wayland because it can steal the origin field's active state; use a
  non-focusing native notification for working/busy feedback there. The
  explicitly requested, focusable command palette is the only working-phase
  window exception; it must be closed before model or Computer Use work starts.
- Generic gateway command failures continue to publish actionable Host access
  status by default. A caller may opt out only for a correlated recoverable
  operation such as an invalid A0 Tag field; the structured request must still
  reject while the underlying connected gateway status stays usable.
- Embedded and detached Launcher-owned Agent Zero web contents must append
  `A0-Launcher/<version>` to the user agent. This tag identifies the shell-owned
  browsing surface; it does not grant authentication or gateway authority, and
  Agent Zero pages receive no Launcher Host access preload. The detached
  Launcher's own header may use the normal named renderer bridge for its tab,
  modal visibility, reload, and reattach intents; main-process handlers must
  resolve the caller back to its owning detached window before moving its view.
- Local development content is selected by `A0_LAUNCHER_LOCAL_REPO`,
  `A0_LAUNCHER_USE_LOCAL_CONTENT`, a repo-shaped default-app current working
  directory, a repo-shaped unpackaged-app current working directory, or the
  first non-option app path in a default-app Electron launch. The default-app
  path matters for Windows RunOnce runtime setup resumes, where the original
  environment variables may be gone.
- Local-content development prefers the adjacent `a0-connector` virtualenv over
  the installed A0 CLI so coupled unreleased capabilities use the matching
  gateway; explicit `A0_CLI_PATH` remains authoritative, while non-local runs
  continue to prefer the installed CLI.
- Non-local content comes from the configured GitHub Release `content.json`
  asset and is unpacked under Electron `userData`. Downloaded release content
  must be written to a staging directory first, then swapped into
  `app_content`, so a failed cleanup or partial extraction cannot destroy the
  last usable cache.
- Packaged launcher executable update prompts use `electron-updater` metadata
  from the launcher GitHub Release. A newer executable may hold
  `shell/loading.html` with `Update` and `Continue`; `Update` downloads the
  updater payload, then becomes a restart/install action once downloaded. Before
  `quitAndInstall()`, stop active gateway leases and run the installed CLI's
  `a0 update` handoff; a CLI update failure is logged but must not strand the
  downloaded Launcher update.
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
  then loads `a0app://content/index.html`. Keep the JavaScript hold durations
  aligned with the CSS animations, wait for the splash document itself instead
  of guessing its readiness, and do not add secondary decorative waits.
  Actionable update text and controls must remain legible over arbitrary desktop
  backgrounds by using solid, high-contrast Agent Zero palette surfaces. Use the
  bundled Rubik face with a swap fallback so typography never gates startup.
  The initial update-available view uses only Update and Continue; reserve the
  status row for progress and failure feedback.
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
- Runtime preferences are soft. Endpoint detection must fall back when the
  preferred endpoint is unavailable without deleting the preference; a runtime
  explicitly started by the user becomes the new preferred endpoint.
- Runtime discovery may expose multiple endpoint aliases for fallback, but
  renderer onboarding choices must be based on distinct verified Docker daemon
  identities rather than endpoint count.
- Shell state sanitization may expose only the bounded runtime-candidate fields
  needed by the picker, including the narrowly validated installed-and-stopped
  Docker Desktop start state.
- Docker Hub sign-in recovery is a named shell-owned intent. The renderer may
  request it, but `shell/main.js` must launch a visible wrapper around the real
  `docker login` flow instead of exposing generic command execution.
- Developer custom-image runs are named Docker Manager intents. The renderer may
  pass image, tag, environment, port, mount, and pull preferences, but shell code
  must keep validation and Docker execution behind `shell/docker_manager`; do not
  add generic shell or Docker command IPC.
- Developer project files stay shell-owned: native dialogs authorize one
  dedicated project folder per renderer, the renderer receives an opaque token
  plus bounded UTF-8 root-file contents, and saves may target only supported
  project-root filenames. Export uses a separate native save dialog. Docker
  project execution resolves the token back to the authorized root and passes
  only fixed Validate, Build, Up, Stop, Logs, or Down intents to Docker Manager.
- Create local Instance may select only Agent Zero releases and local Agent Zero
  builds. Arbitrary Docker image execution remains an Advanced developer intent.
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
  Preserve image-pull `progressStartedAt` and numeric `progressStartValue` so
  modal and background-toast ETAs use the current phase's observed work.
- Docker Manager refresh IPC accepts only a bounded forced/non-forced choice.
  Initial loading, tab navigation, and post-operation reconciliation use normal
  remote caches while rebuilding live local Docker state. Startup follows that
  first usable snapshot with a non-blocking forced remote refresh when its
  catalog predates the launch. Explicit Refresh remains forced.
- The Settings page may submit its five owned preference sections through one
  named IPC intent. Validate and sanitize every section, persist one combined
  state update, and restart Host access leases through the existing shell path.
- Sanitized Docker Manager state may expose bounded health-derived runtime
  identity fields for local and saved remote Instances; never forward arbitrary
  health response content.
- Install image removal is a named Docker Manager IPC intent. The renderer may
  pass a release tag, but shell code must validate the IPC body and Docker
  Manager must perform a non-forced image removal so Docker can refuse images
  still used by any container.
- Per-instance clone, rename, and Colour/Icon selection operations are named
  Docker Manager intents. Clone may accept a bounded `/a0/usr` category selection, but
  archive copy and filtering stay in `shell/docker_manager` and
  `shell/docker_adapter`. Appearance selection may accept only bounded palette
  and icon IDs and must stay launcher metadata. Long-running container
  mutations report progress.
- Per-instance Restart is a named Docker Manager intent. It must use the
  adapter's native immediate container restart, stay in the per-container
  background queue, and wait for UI readiness before reporting completion.
- Per-instance deletion may remove persistent workspace storage only after an
  explicit renderer choice. Root-owned host-workspace contents must be cleaned
  through the Docker adapter, and a cleanup failure after container deletion
  must report that partial result instead of claiming the Instance still exists.
- Per-instance Backup and Restore are named Docker Manager intents. The shell
  owns native save/open dialogs for `.zip` files; Docker Manager owns the
  `/a0/usr` archive semantics and progress events.
- Workspace storage preference and migration actions are named Docker Manager
  intents. They may expose storage mode/root/path-mode/volume fields, but
  Docker mount creation, migration, and archive copy behavior must stay in
  `shell/docker_manager` and `shell/docker_adapter`.
- Opening an Instance storage folder is a named Docker Manager intent. The
  renderer passes a container id; the shell resolves and opens only validated
  host-directory workspace paths.
- Per-instance Docker log inspection is a named, bounded, read-only Docker
  Manager intent. Do not expose raw Docker log commands or shell execution.
- Error responses should use `dockerManager.toErrorResponse()` so renderer code
  sees a stable `{ code, message }` shape.
- The no-argument `beginLocalSetup` IPC saves local onboarding intent without
  installing a runtime. Sanitized state exposes only `new`, `local`, `complete`,
  or null for unknown onboarding; completion belongs to Docker Manager state,
  independently of the legacy Host access onboarding field.
- The launcher should not create a system tray/menu-bar status icon. Keep the
  normal app window plus platform Dock/taskbar entry as the only shell presence.

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
node --test shell/a0_cli_install.test.js
node --test shell/launcher_update.test.js
node --test shell/launcher_updater_debug_release.test.js
node --test shell/instance_tabs.test.js
node --test shell/host_access.test.js shell/host_gateway.test.js
git diff --check
```

If IPC or content loading changed, launch local content:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```

## Child DOX Index

- `/shell/docker_adapter/AGENTS.md`: generic Docker and Docker Hub adapter.
- `/shell/docker_manager/AGENTS.md`: Agent Zero Docker Manager product layer.
