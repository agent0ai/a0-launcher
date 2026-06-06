# macOS Runtime Setup Design

Status: approved for implementation planning
Date: 2026-06-05

## Purpose

A0 Launcher should be able to set up a working local container runtime on macOS
without requiring the user to install Docker Desktop or another GUI-first
container product. Linux and Windows remain on their existing solved paths. The
macOS path should minimize friction while preserving clear privilege boundaries,
recoverability, and user trust.

The target runtime is Docker CLI compatibility backed by Podman on macOS:

- Homebrew is installed automatically when missing.
- Docker CLI, Compose, credential helper, and Podman are installed through
  Homebrew.
- Podman provides the container engine through a Podman machine.
- Docker clients use Podman's Docker-compatible socket through
  `podman-mac-helper` when available.
- The launcher falls back to a direct `DOCKER_HOST` socket override only when
  the default socket compatibility path is unavailable.
- Docker Desktop remains a fallback, not the primary macOS setup path.

## Goals

- Give the user one primary action: set up the required runtime.
- Keep all privileged work in the Electron shell process.
- Never ask the renderer to provide or execute arbitrary shell commands.
- Never collect, store, log, or forward the user's sudo password.
- Use a native macOS authorization prompt for the one privileged helper step.
- Make setup idempotent: rerunning should skip completed steps and repair only
  missing or failed parts.
- Verify the result with the same Docker adapter the launcher already uses.

## Non-Goals

- Do not build a general package manager UI.
- Do not add Colima, OrbStack, or Docker Desktop as primary setup backends.
- Do not silently stop, delete, or reconfigure a user's existing Podman machine.
- Do not depend on Podman Desktop or any GUI application.
- Do not promise all Docker Desktop features; the requirement is enough Docker
  API compatibility for Agent Zero launcher flows.

## Architecture

Add a shell-owned runtime setup service at
`shell/docker_manager/runtime_setup.js`, with narrow IPC wiring in
`shell/main.js` and preload methods in `shell/preload.js`.

Renderer code requests intent only:

- `getRuntimeSetupState()`
- `startRuntimeSetup()`
- `cancelRuntimeSetup()`
- `openRuntimeSetupFallback()`

The shell service owns:

- runtime detection
- fixed command step planning
- child-process execution
- native macOS authorization invocation
- sanitized progress events
- cancellation
- final Docker verification
- durable setup metadata

Runtime setup progress should reuse the existing Docker Manager operation event
shape and emit `type: "runtime_setup"`. This keeps renderer progress handling
consistent while still allowing setup-specific copy and status codes.

## macOS Setup Flow

The setup service runs a step graph where every step starts with detection.

1. Detect whether Docker already works through `DockerInterface.detectEnvironment`.
2. On macOS, detect Homebrew by checking the supported Apple Silicon and Intel
   paths plus `PATH`.
3. If Homebrew is missing, run the official install script with
   `NONINTERACTIVE=1`.
4. Load Brew shellenv from `/opt/homebrew/bin/brew` or `/usr/local/bin/brew` for
   the setup process.
5. Install or upgrade required formulae:
   - `docker`
   - `docker-compose`
   - `docker-credential-helper`
   - `podman`
6. Choose the Podman machine:
   - Prefer a dedicated `a0-launcher` machine on clean systems.
   - If the user already has a running or configured Podman machine, do not
     silently stop or mutate it.
   - If Podman's helper/socket behavior proves more reliable with
     `podman-machine-default`, use the default machine and document that
     product decision.
7. Initialize the selected machine if it does not exist.
8. Start the machine once so Podman creates connection and API socket metadata.
9. Install `podman-mac-helper` through a native macOS authorization prompt.
10. Restart the machine so helper socket compatibility takes effect.
11. Set the machine to rootful mode if Agent Zero startup verification requires
    it, then restart again.
12. If `/var/run/docker.sock` compatibility is unavailable, derive and persist a
    launcher-owned Docker host override for the Podman API socket.
13. Verify Docker compatibility through Dockerode and an Agent Zero-compatible
    container operation.

## Machine Ownership

The launcher should prefer isolation but not at the cost of surprising the user.
Current Podman behavior allows only one Podman-managed VM to be active at a
time, so setup must avoid silently interrupting an existing Podman workflow.

Initial policy:

- On a clean machine, create and manage `a0-launcher`.
- If `podman-machine-default` exists and no other machine is active, use it when
  that is the most reliable helper path.
- If another machine is active, halt setup and ask for explicit confirmation
  before changing anything that would stop, recreate, rootful-toggle, or remap
  it.
- Never delete a user machine without a separate destructive confirmation.

## State And Persistence

Persist only durable setup metadata through the existing Docker Manager state
store or a tightly scoped runtime setup state file under Electron `userData`.

Suggested shape:

```json
{
  "runtimeBackend": "podman",
  "machineName": "a0-launcher",
  "dockerHostOverride": "unix:///path/to/podman-machine-api.sock",
  "usesDefaultDockerSocket": true,
  "lastSuccessfulSetupAt": "2026-06-05T00:00:00.000Z"
}
```

Do not persist:

- passwords
- full shell environments
- arbitrary command lines supplied by the renderer
- unsanitized command output
- installer logs containing local secrets

The Docker adapter should accept a launcher-owned Docker host override when the
default socket path does not work. That override must stay shell-side and should
not require the user to export `DOCKER_HOST` manually.

## Renderer Experience

The onboarding component changes from a simple download CTA into a runtime setup
panel:

- Primary action: `Set up runtime`
- Secondary action: `Download Docker Desktop`
- During setup: step name, current action, cancel when safe, and short status
  copy.
- On failure: concise error, retry action, diagnostics action if available, and
  Docker Desktop fallback.
- On success: refresh inventory and hide onboarding once Docker is available.

Visible language should say `runtime` only when needed and should avoid asking
the user to understand Podman, socket paths, or rootful mode before they can run
Agent Zero.

## Error Handling

Each failing step should return a stable setup code, a user-facing message, and
a recovery action.

- `HOMEBREW_INSTALL_FAILED`: retry setup or use Docker Desktop fallback.
- `BREW_SHELLENV_FAILED`: open diagnostics and retry after a shell refresh.
- `PACKAGE_INSTALL_FAILED`: retry package install or use Docker Desktop
  fallback.
- `AUTHORIZATION_CANCELED`: explain that setup needs one admin approval.
- `PODMAN_MACHINE_EXISTS`: ask before using or changing an existing machine.
- `PODMAN_MACHINE_FAILED`: retry; offer reset/recreate only after explicit
  confirmation.
- `ROOTFUL_SWITCH_FAILED`: keep current machine unchanged and show fallback.
- `DOCKER_SOCKET_COMPAT_FAILED`: try direct socket override, then fallback.
- `VERIFY_FAILED`: do not claim setup is ready; keep logs available.

Raw command output stays shell-side unless sanitized. The renderer should see
stable codes, short messages, and optional redacted diagnostics.

## Security And Privilege Boundaries

- The renderer can only call named setup actions.
- The setup service must run a fixed command graph, not renderer-provided shell.
- Use `spawn` or `execFile` with explicit argument arrays whenever practical.
- Use shell execution only for the Homebrew official install script and tightly
  controlled shellenv/bootstrap commands where unavoidable.
- The privileged helper step uses native macOS authorization, not an in-app
  password prompt.
- All external links and fallback downloads remain validated in the shell.

## Testing

Static checks:

```bash
node --check shell/main.js
node --check shell/preload.js
node --check shell/docker_manager/index.js
node --check app/docker_manager.js
git diff --check
```

Unit tests:

- planner chooses no-op when Docker already works
- planner installs Homebrew only when missing
- planner installs missing formulae only
- planner handles Apple Silicon and Intel Brew paths
- planner handles clean, default-machine, dedicated-machine, and active-machine
  Podman states
- Docker host override is produced only when default socket compatibility fails
- renderer receives sanitized progress only

Manual macOS verification:

- clean Apple Silicon machine
- clean Intel machine
- machine with Homebrew already installed
- machine with Docker Desktop already running
- machine with existing Podman machine
- cancellation at Homebrew, package install, authorization, and verification
  stages

Success criteria:

- User can install and run Agent Zero from A0 Launcher on macOS without Docker
  Desktop.
- Setup survives rerun after partial failure.
- Docker inventory refreshes after setup and the onboarding panel disappears.
- Agent Zero can be pulled, started, and opened from the launcher.

## External References

- Homebrew supports `NONINTERACTIVE=1` for unattended installer runs and uses
  `/opt/homebrew` on Apple Silicon and `/usr/local` on Intel macOS.
- Podman on macOS runs containers in a Podman machine VM.
- Podman documents `podman-mac-helper install` for Docker socket compatibility
  and a direct `DOCKER_HOST` socket export as a fallback.
- Podman Desktop documentation treats Homebrew installation as an available but
  less recommended Podman Desktop path; the launcher accepts this tradeoff
  because the product goal is no additional GUI software.
