# AGENTS

## Purpose

`shell/docker_adapter/` owns the generic Docker and Docker Hub abstraction used
by the launcher.

This layer should know Docker mechanics. It should not know launcher copy,
renderer layout, or product-specific tab behavior.

## Ownership

This scope owns:

- `DockerInterface.mjs`: abstract interface, environment detection, host parsing,
  Dockerode option normalization, singleton construction, and shared typedefs.
- `getDocker.js`: CommonJS bridge that dynamically imports the ESM interface for
  `shell/docker_manager`.
- `RuntimeProvisioner.mjs`: platform provisioner base and shared process helpers.
- `runtime_provisioner.test.mjs`: runtime provisioner selection and parser
  smoke tests.
- `impl/DockerodeDocker.mjs`: Dockerode-backed container inspection, commit
  snapshots, creation, lifecycle, volume, image, pull, and log operations.
- `dockerode_docker.test.mjs`: Dockerode adapter regression tests for
  container state shaping.
- `impl/DockerHubRegistry.mjs`: Docker Hub registry and manifest/digest access.
- `impl/DockerodeLogProcessor.mjs`: Docker pull/log stream processing.
- `impl/ColimaRuntime.mjs`: macOS Colima/Lima assessment, self-contained
  component download, checksum verification, and dedicated runtime profile
  start mechanics.
- `impl/LinuxEngineRuntime.mjs`: Linux native Docker Engine assessment, daemon
  start, and package-manager bootstrap mechanics.
- `impl/WindowsWslDockerProxy.mjs`: Windows loopback bridge from
  `127.0.0.1:23750` to the WSL Docker Engine Unix socket.
- `impl/WindowsWslRuntime.mjs`: Windows Docker Desktop, Windows client WSL
  Docker Engine, and Windows Server WSL2/nested-virtualization assessment.
- `LOG_PROCESSOR.md`: explanatory implementation notes for log processing.

## Local Contracts

- `DockerInterface.mjs` is ESM by design. Keep the CommonJS bridge contained in
  `getDocker.js`.
- Environment detection should be best-effort and return structured diagnostics
  rather than throwing for ordinary "Docker unavailable" cases.
- Environment detection should probe likely platform endpoints when
  `DOCKER_HOST` is unset, including Linux native Engine, Docker Desktop for
  Linux, and rootless sockets.
- Environment detection should build a deduplicated runtime endpoint registry
  before provisioning. Include launcher preference, `DOCKER_HOST`, Docker
  contexts, and known Docker-compatible provider sockets as candidates, then
  mark a candidate usable only after a Docker API probe succeeds.
- `DOCKER_HOST` parsing must preserve enough detail to diagnose Unix socket,
  named pipe, TCP, HTTP, HTTPS, and invalid host configurations.
- Provider names such as Docker Desktop, Colima, OrbStack, Rancher Desktop, and
  Podman are labels around Docker-compatible endpoints. Do not treat Portainer
  as a runtime endpoint, and do not expose containerd/nerdctl-only paths as
  usable Docker endpoints.
- Runtime provisioners are consulted only after the Docker Manager has tried to
  reuse an existing Docker endpoint. They should classify repairable states
  before proposing installation.
- Runtime provisioners should report user-facing progress through `onProgress`
  for platform setup phases such as authorization, component download, Docker
  Engine install/start, follow-up/relogin, and Docker Desktop waiting. Keep the
  messages stable enough for Docker Manager to normalize into modal steps.
- macOS automatic provisioning uses a dedicated Colima profile named `a0`.
  It must not require Docker Desktop, Homebrew, or a privileged Docker socket
  symlink. Because Colima checks for a Docker client during startup, the
  provisioner may install Docker's official static macOS CLI into the
  launcher-owned runtime bin directory when the host does not provide one.
- macOS assessment is reuse-first for an already installed Docker Desktop. If
  Docker Desktop is installed but its socket is not reachable, report a
  `docker_desktop` `engine_stopped` state so the product can ask the user to
  start it instead of offering a fresh download/setup path.
- Linux automatic provisioning uses the host package manager and starts native
  Docker Engine; it must not manage container CPU, memory, or disk sizing.
- Linux privileged setup prefers `pkexec` for desktop authentication and may use
  `sudo -n` only when `pkexec` is absent and passwordless sudo is already
  available.
- Linux Engine permission repair should add the current user to the existing
  `docker` group when Docker is installed but the account is not a member yet,
  then report that a logout/login is required.
- Windows assessment must not direct Windows Server users to Docker Desktop.
  Docker Desktop is for client Windows; Windows Server needs an existing Docker
  endpoint or a WSL2-backed Linux Docker Engine with nested virtualization.
- Windows WSL Engine support must keep unauthenticated Docker API exposure on
  Windows loopback only. Do not bind Docker TCP on WSL public or non-loopback
  interfaces.
- Windows WSL Engine support must also keep the selected WSL distro alive while
  the launcher-owned loopback bridge is active; otherwise WSL can idle-stop and
  Docker marks healthy Linux containers as exited.
- Windows WSL keepalive helpers must carry a launcher-specific marker and clean
  up their child sleep process on shutdown so app restarts do not leave orphaned
  WSL helper loops.
- Windows WSL loopback detection may need a longer first probe than other
  Docker endpoints because starting the bridge can cold-start WSL. Keep that
  extra wait scoped to `127.0.0.1:23750`.
- Windows client WSL onboarding details should stay Agent Zero-first for normal
  users. Reserve explicit Docker Desktop naming for Docker Desktop reuse or
  repair states, and keep low-level Docker Engine wording out of the primary
  setup path.
- Windows clients with Docker Desktop installed but stopped must report a
  `docker_desktop` `engine_stopped` state with start guidance, not a Docker
  Desktop download or reinstall link.
- Windows client WSL feature installation may use a user-approved UAC prompt via
  `wsl.exe --install --no-distribution`; it must report restart/follow-up states
  instead of claiming Docker is ready immediately.
- After the WSL feature reboot, Windows client assessment must be able to
  continue from ordinary user context. Do not rely only on admin-only optional
  feature queries; infer feature readiness from `wsl.exe` status/list output
  when it reports WSL2 is available but no distro is installed.
- On Windows 10, `wsl.exe --install -d Ubuntu --no-launch` may install the
  Ubuntu Appx package without registering a WSL distro. The Windows client setup
  path should use the Ubuntu launcher root-registration path when available so
  users are not forced through an interactive Unix user setup.
- Windows client WSL Docker Engine setup may install Docker Engine packages
  inside an existing Ubuntu WSL2 distro using Docker's official apt repository.
  Include the Python bridge dependency and keep Docker API access on the
  launcher-owned Windows loopback bridge.
- The Windows loopback bridge may run its WSL helper as `root` so users do not
  need to manage Linux `docker` group membership during onboarding.
- Concrete implementations live under `impl/` and are loaded on demand.
- Docker Hub calls should expose digest/content-type/rate-limit metadata without
  forcing renderer or Docker Manager code to parse registry responses directly.
- Dockerode image pulls and Docker Hub metadata requests should reuse Docker CLI
  registry credentials from `DOCKER_CONFIG` or `~/.docker/config.json`, including
  configured credential helpers, so the launcher honors a successful
  shell-owned `docker login`.
- `impl/DockerodeDocker.mjs` may surface launcher-managed container labels as
  structured metadata and may include containers labeled
  `a0.launcher.managed=true` in `listContainers()` even when their image repo
  differs from the default Agent Zero repo. Keep UI language and product
  decisions in `shell/docker_manager` or the renderer.
- Container file reads must stay bounded, path-specific, and adapter-owned.
  They are for structured inspection such as product-layer runtime source
  metadata, not for exposing a generic command or filesystem browser.
- Container commit support is a low-level snapshot primitive for product-layer
  clone workflows. Keep clone naming, labels, and port-policy decisions in
  `shell/docker_manager`.
- Log processing should normalize stream events into stable progress messages and
  preserve enough detail for cancellation/failure diagnosis.

## Work Guidance

- Keep this layer reusable. Do not import Electron UI modules or renderer files.
- Do not add launcher-specific labels such as `Instances` here; translate
  low-level results in `shell/docker_manager`.
- Prefer structured return values over throwing when the caller can recover or
  show a diagnostic.
- Keep all Dockerode-specific assumptions behind this adapter.
- When adding a new Docker capability, define or update the abstract method in
  `DockerInterface.mjs` before implementing it in `impl/DockerodeDocker.mjs`.

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
