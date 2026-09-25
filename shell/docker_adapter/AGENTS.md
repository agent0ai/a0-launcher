# AGENTS

## Purpose

`shell/docker_adapter/` owns the generic Docker and Docker Hub abstraction used by the launcher.

This layer should know Docker mechanics. It should not know launcher copy, renderer layout, or product-specific tab behavior.

## Ownership

This scope owns:

- `DockerInterface.mjs`: abstract interface, environment detection, host parsing, Dockerode option normalization, singleton construction, and shared typedefs.
- `DockerCli.mjs`: cross-platform Docker CLI discovery and fixed Dockerfile or Compose project command execution against the selected runtime endpoint.
- `docker_cli.test.mjs`: command-shape and non-destructive Compose regression checks.
- `getDocker.js`: CommonJS bridge that dynamically imports the ESM interface for `shell/docker_manager`.
- `RuntimeProvisioner.mjs`: platform provisioner base and shared process helpers.
- `runtime_provisioner.test.mjs`: runtime provisioner selection and parser smoke tests.
- `impl/DockerodeDocker.mjs`: Dockerode-backed container inspection, commit snapshots, creation, lifecycle, volume, image, pull, and log operations.
- `dockerode_docker.test.mjs`: Dockerode adapter regression tests for container state shaping.
- `impl/DockerHubRegistry.mjs`: Docker Hub registry and manifest/digest access.
- `impl/DockerodeLogProcessor.mjs`: Docker pull/log stream processing.
- `impl/ColimaRuntime.mjs`: macOS Colima/Lima assessment, self-contained component download, checksum verification, and dedicated runtime profile start mechanics.
- `impl/LinuxEngineRuntime.mjs`: Linux native Docker Engine assessment, daemon start, and package-manager bootstrap mechanics.
- `impl/WindowsWslDockerProxy.mjs`: Windows loopback bridge from `127.0.0.1:23750` to the WSL Docker Engine Unix socket.
- `impl/WindowsWslRuntime.mjs`: Windows Docker Desktop, Windows client WSL Docker Engine, and Windows Server WSL2/nested-virtualization assessment.
- `LOG_PROCESSOR.md`: explanatory implementation notes for log processing.

## Local Contracts

- `DockerInterface.mjs` is ESM by design. Keep the CommonJS bridge contained in `getDocker.js`.
- Environment detection should be best-effort and return structured diagnostics rather than throwing for ordinary "Docker unavailable" cases.
- Environment detection should probe likely platform endpoints when `DOCKER_HOST` is unset, including Linux native Engine, Docker Desktop for Linux, and rootless sockets.
- Environment detection should build a deduplicated runtime endpoint registry before provisioning. Include launcher preference, `DOCKER_HOST`, Docker contexts, and known Docker-compatible provider sockets as candidates, then mark a candidate usable only after a Docker API probe succeeds.
- Reachable endpoint candidates should expose Docker's daemon ID when available. Preserve endpoint aliases for preference and fallback; consumers may group verified matching daemon IDs when deciding whether more than one runtime is actually available. A missing daemon ID must not trigger a picker choice.
- `DOCKER_HOST` parsing must preserve enough detail to diagnose Unix socket, named pipe, TCP, HTTP, HTTPS, and invalid host configurations.
- Provider names such as Docker Desktop, Colima, OrbStack, Rancher Desktop, and Podman are labels around Docker-compatible endpoints. Do not treat Portainer as a runtime endpoint, and do not expose containerd/nerdctl-only paths as usable Docker endpoints.
- Runtime provisioners are consulted only after the Docker Manager has tried to reuse an existing Docker endpoint. They should classify repairable states before proposing installation.
- Runtime provisioners should report user-facing progress through `onProgress` for platform setup phases such as authorization, component download, Docker Engine install/start, follow-up/relogin, and Docker Desktop waiting. Keep the messages stable enough for Docker Manager to normalize into modal steps.
- Colima reports explicit phases for Docker client preparation, nested startup logs, and final socket verification. Log lines containing `done` or `ready` must not complete setup before the runtime socket is reachable.
- Runtime start and provision results should report the Docker endpoint they made reachable so the product layer can remember an explicit user choice.
- Platform provisioners should expose Docker Desktop-only assessment and targeted start behavior so the product can offer an installed stopped Docker Desktop beside a different reachable daemon without disturbing that fallback.
- Renderer-visible runtime assessment labels and details should use `Setup`, not `Set up`, `Set Up`, or `Setting up`; internal field names may remain `setup`.
- macOS automatic provisioning uses a dedicated Colima profile named `a0`. It must not require Docker Desktop, Homebrew, or a privileged Docker socket symlink. Because Colima checks for a Docker client during startup, the provisioner may install Docker's official static macOS CLI into the launcher-owned runtime bin directory when the host does not provide one.
- macOS assessment is reuse-first for an already installed Docker Desktop. If Docker Desktop is installed but its socket is not reachable, report a `docker_desktop` `engine_stopped` state so the product can ask the user to start it instead of offering a fresh download/setup path.
- A missing macOS Colima runtime uses the same neutral initial setup description as Windows: `Finish local Agent Zero runtime Setup.` Active progress continues to describe its specific phase; Linux keeps its Docker Engine description.
- Linux automatic provisioning uses the host package manager and starts native Docker Engine; it must not manage container CPU, memory, or disk sizing. Before native setup, recognize an installed stopped Docker Desktop through its user service or `/opt/docker-desktop`, start it with the unprivileged user service, and return its `~/.docker/desktop/docker.sock` endpoint.
- Linux privileged setup prefers `pkexec` for desktop authentication and may use `sudo -n` only when `pkexec` is absent and passwordless sudo is already available.
- Linux Engine permission repair should add the current user to the existing `docker` group when Docker is installed but the account is not a member yet, then report that a logout/login is required.
- Windows assessment must not direct Windows Server users to Docker Desktop. Docker Desktop is for client Windows; Windows Server needs an existing Docker endpoint or a WSL2-backed Linux Docker Engine with nested virtualization.
- Windows WSL Engine support must keep unauthenticated Docker API exposure on Windows loopback only. Do not bind Docker TCP on WSL public or non-loopback interfaces.
- Windows WSL Engine detection may prepare the launcher-owned loopback bridge for the built-in `127.0.0.1:23750` endpoint before probing it, so an installed Ubuntu Docker Engine can be reused at startup without another setup modal.
- Windows WSL Engine support must also keep the selected WSL distro alive while the launcher-owned loopback bridge is active; otherwise WSL can idle-stop and Docker marks healthy Linux containers as exited.
- Windows WSL keepalive helpers must carry a launcher-specific marker and clean up their child sleep process on shutdown so app restarts do not leave orphaned WSL helper loops.
- Windows WSL loopback detection may need a longer first probe than other Docker endpoints because starting the bridge can cold-start WSL. Keep that extra wait scoped to `127.0.0.1:23750`.
- Windows client WSL onboarding details should stay Agent Zero-first for normal users. Reserve explicit Docker Desktop naming for Docker Desktop reuse or repair states, and keep low-level Docker Engine wording out of the primary setup path.
- Windows clients with Docker Desktop installed but stopped must report a `docker_desktop` `engine_stopped` state with start guidance, not a Docker Desktop download or reinstall link. Discover both Program Files and per-user `%LOCALAPPDATA%/Programs/DockerDesktop` installations. Start Desktop with PowerShell's `Start-Process -FilePath` and report launch errors before waiting for its pipe. Never select Docker's private `docker-desktop` or `docker-desktop-data` WSL distributions for Engine setup or startup.
- Windows client WSL feature installation may use a user-approved UAC prompt via `wsl.exe --install --no-distribution`; it must report restart/follow-up states instead of claiming Docker is ready immediately.
- After the WSL feature reboot, Windows client assessment must be able to continue from ordinary user context. Do not rely only on admin-only optional feature queries; infer feature readiness from `wsl.exe` status/list output when it reports WSL2 is available but no distro is installed.
- On Windows 10, `wsl.exe --install -d Ubuntu --no-launch` may install the Ubuntu Appx package without registering a WSL distro. The Windows client setup path should use the Ubuntu launcher root-registration path when available so users are not forced through an interactive Unix user setup.
- Windows client WSL Docker Engine setup may install Docker Engine packages inside an existing Ubuntu WSL2 distro using Docker's official apt repository. Include the Python bridge dependency and keep Docker API access on the launcher-owned Windows loopback bridge.
- The Windows loopback bridge may run its WSL helper as `root` so users do not need to manage Linux `docker` group membership during onboarding.
- Concrete implementations live under `impl/` and are loaded on demand.
- Docker Hub calls should expose digest/content-type/rate-limit and tag update metadata without forcing renderer or Docker Manager code to parse registry responses directly.
- Dockerode image pulls and Docker Hub metadata requests should reuse Docker CLI registry credentials from `DOCKER_CONFIG` or `~/.docker/config.json`, including configured credential helpers, so the launcher honors a successful shell-owned `docker login`.
- `impl/DockerodeDocker.mjs` may surface launcher-managed container labels as structured metadata and may include containers labeled `a0.launcher.managed=true` or legacy Agent Zero install-script containers labeled `ai.agent0.managed=true` in `listContainers()` even when their image repo differs from the default Agent Zero repo. Keep UI language and product decisions in `shell/docker_manager` or the renderer.
- Docker may report a container's summary image as an image id or `<none>` after the original tag is replaced. `listContainers()` should recover `Config.Image` from container inspect for those unresolved summaries before deciding whether the container belongs to the requested image repo.
- Runtime diagnostics may expose sanitized Docker Engine `version()` and `info()` fields through `getRuntimeDiagnostics()`. Keep the payload bounded and generic; product grouping and visible copy belong above this layer.
- Container file reads must stay bounded, path-specific, and adapter-owned. They are for structured inspection such as product-layer runtime source metadata, not for exposing a generic command or filesystem browser.
- Container archive copies, generated text-file writes, directory creation, and immediate directory listings must stay path-specific and adapter-owned. They are allowed for product-layer workflows such as workspace migration and selective workspace clone, but must not become a renderer-facing filesystem browser or generic `docker cp` surface.
- Container archive import/export primitives may expose raw streams to the product layer for bounded workflows such as Backup and Restore, but product scope, path filtering, metadata, and user-facing semantics must remain in `shell/docker_manager`.
- Docker image removal should default to non-forced deletion so callers preserve Docker's native protection for images still referenced by containers. Forced removal must be an explicit option.
- Local image inventory may be repository-scoped or runtime-wide. Runtime-wide discovery must preserve every tagged image's full repository and tag.
- Container inventory should include backend, launcher-managed, and Compose-created Agent Zero containers identified by their inspected `/exe/initialize.sh` entrypoint; never infer Agent Zero from a container name.
- Container commit support is a low-level snapshot primitive for product-layer clone workflows. Keep clone naming, labels, and port-policy decisions in `shell/docker_manager`.
- Root-owned bind-mount contents may be removed through a one-shot container created from an already-local image. Use a fixed cleanup command and a structured bind mount without networking, wait for success, and always remove the helper.
- Log processing should normalize stream events into stable progress messages and preserve enough detail for cancellation/failure diagnosis.
- Image extraction percentages use Docker's expanded layer totals, not frozen compressed manifest sizes. Reserve 100% for explicit layer completion.
- Docker project execution may use the installed Compose plugin or legacy `docker-compose` fallback. Keep paths in argument arrays, never invoke a shell, bind `DOCKER_HOST` to the adapter's selected endpoint, bound returned output, and keep the action allowlist inside the adapter.

## Work Guidance

- Keep this layer reusable. Do not import Electron UI modules or renderer files.
- Do not add launcher-specific labels such as `Instances` here; translate low-level results in `shell/docker_manager`.
- Prefer structured return values over throwing when the caller can recover or show a diagnostic.
- Keep all Dockerode-specific assumptions behind this adapter.
- When adding a new Docker capability, define or update the abstract method in `DockerInterface.mjs` before implementing it in `impl/DockerodeDocker.mjs`.

## Verification

After adapter changes, run:

```bash
node --check shell/docker_manager/index.js
git diff --check
```

For ESM files, also run Node syntax checks through dynamic import when needed:

```bash
node -e "import('./shell/docker_adapter/DockerInterface.mjs')"
```

For Dockerode adapter state-shaping changes, run:

```bash
node --test shell/docker_adapter/dockerode_docker.test.mjs
```

For runtime provisioner changes, run:

```bash
node --test shell/docker_adapter/runtime_provisioner.test.mjs
```

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
