# Instance Tabs Design

Date: 2026-05-20
Status: Approved for implementation planning

## Purpose

Add browser-style tabs for Agent Zero instance UIs inside the launcher. `Open UI`
should open an instance in a tab by default, while still allowing users to detach
that tab into its own standalone window.

This work also tightens live refresh after activation so the Instances area shows
newly running instances without a manual refresh.

## Scope

In scope:

- Tabbed UI for local launcher-managed instances.
- Tabbed UI for saved remote instances.
- Detach from tab to standalone Electron window.
- Duplicate `Open UI` behavior that focuses an existing tab instead of opening
  another copy.
- Live Instances refresh after activation, start, stop, rollback, and removal
  operations.
- Documentation and release-check updates for macOS/cloud-runner validation.

Out of scope for this slice:

- A general-purpose browser with address bar, bookmarks, persisted history, or
  arbitrary navigation entry.
- Full logs panel or governance-proposal workspace expansion.
- Replacing the existing Docker Manager navigation model.
- Claiming local macOS verification from non-macOS machines.

## Product Language

Visible copy must keep Docker terminology out of the normal path:

- Use `Installs` for images.
- Use `Instances` for containers.
- Keep `Open UI` as the user-facing action.
- Use `Storage volumes` where Docker volumes are discussed.

## Architecture

Use a shell-owned tab manager.

The renderer owns tab chrome and user intent. The Electron main process owns URL
resolution, URL validation, web contents lifecycle, and detached windows. This
keeps the existing security boundary intact: renderer code requests an action,
preload exposes a named method, and `shell/main.js` performs privileged work.

The current standalone-window path already validates URLs and opens secure
`BrowserWindow`s. The new tab manager should reuse those validation rules and
centralize the duplicated window-opening logic.

## Renderer Components

Add an `instance-tabs` component under `app/components/docker-manager/` or another
nearby renderer-owned path if implementation discovers a better fit.

The component should provide:

- A browser-style tab strip.
- Active tab title.
- Close control.
- Reload control.
- Detach control.
- Empty state when no instance tabs are open.

The existing Instances cards keep their `Open UI` buttons. Those buttons call a
renderer action with the target identity and default disposition `tab`.

Remote instance cards should use the same action path, passing their remote
instance id. Local container cards should pass their container id.

## Shell Tab Manager

`shell/main.js` should maintain an in-memory registry of open instance tabs.

Each tab record should expose only sanitized renderer state:

- `id`
- `title`
- `url`
- `kind`, such as `local` or `remote`
- `instanceId` or `containerId` when applicable
- `active`
- `loading`
- `canReload`

The shell should resolve URLs from product identities:

- Local active instance: resolve through existing Docker Manager state or helper.
- Local container: resolve through `dockerManager.getContainerUiUrl(containerId)`.
- Remote instance: resolve through `dockerManager.getRemoteInstance(id)`.

The shell must validate local URLs with the current local-only rules and remote
URLs with the current remote HTTP/HTTPS rules. Credentialed URLs remain invalid.

Opening a target that already has a tab should focus the existing tab. The
dedupe key should combine instance identity and normalized URL so port changes
or renamed remote entries do not focus an unsafe or stale target.

## Detach Behavior

Detach moves the selected tab target into a standalone Agent Zero window.

The detached window should use the same secure settings as current Agent Zero UI
windows:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- sanitized `http:` or `https:` URL only

After detach, the tab closes from the in-launcher tab strip. Closing the detached
window does not stop or remove the instance.

## Live Refresh

Activation/start/stop operations already emit Docker Manager state after
completion. The renderer must ensure pushed state updates keep the Instances
view current.

Implementation can satisfy this by either:

- Expanding the `docker-manager:state` subscription to update all
  Instances-facing fields when available, including containers; or
- Triggering a lightweight inventory refresh after operation completion events.

The acceptance behavior is concrete: after activating an install, the Instances
tab shows the new running instance card without pressing refresh.

## macOS And Release Validation

The existing release workflow already builds macOS DMG and ZIP artifacts on
`macos-latest`. This feature should preserve that path.

Verification expectations:

- Static checks run locally.
- macOS artifact generation is verified through GitHub Actions or the user's
  cloud-runner test path.
- Manual macOS validation covers opening a local instance tab, detaching it, and
  closing the detached window.

Release tags stay two-segment `v0.x` tags, such as `v0.4` or `v0.5`. The
workflow normalizes those to full Electron package versions like `0.4.0`.

## Testing

Run at least:

```bash
node --check shell/main.js
node --check shell/preload.js
node --check app/docker_manager.js
git diff --check
```

For edited standalone component modules, run `node --check` on those files too.

Manual verification should cover:

- Local `Open UI` opens a tab.
- Clicking `Open UI` for the same target focuses the existing tab.
- Reload refreshes the active tab contents.
- Detach opens a standalone window and removes the in-launcher tab.
- Remote saved instances open in tabs.
- Invalid remote URLs are rejected.
- Activating an install updates the Instances area live.
- Existing standalone window behavior remains available through detach.

## Documentation Updates Required During Implementation

Update the closest owning `AGENTS.md` files with the final contracts:

- `/shell/AGENTS.md` for the shell-owned tab manager and IPC contract.
- `/app/AGENTS.md` for renderer ownership of tab chrome.
- `/app/components/docker-manager/AGENTS.md` for component behavior.
- `/.github/AGENTS.md` and `/docs/release-todos.md` only if release workflow or
  validation expectations change.
