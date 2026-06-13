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
- `impl/DockerodeDocker.mjs`: Dockerode-backed concrete implementation.
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
- `DOCKER_HOST` parsing must preserve enough detail to diagnose Unix socket,
  named pipe, TCP, HTTP, HTTPS, and invalid host configurations.
- Runtime provisioners are consulted only after the Docker Manager has tried to
  reuse an existing Docker endpoint. They should classify repairable states
  before proposing installation.
- macOS automatic provisioning uses a dedicated Colima profile named `a0`.
  It must not require Docker Desktop, Homebrew, or a privileged Docker socket
  symlink. Because Colima checks for a Docker client during startup, the
  provisioner may install Docker's official static macOS CLI into the
  launcher-owned runtime bin directory when the host does not provide one.
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
- Concrete implementations live under `impl/` and are loaded on demand.
- Docker Hub calls should expose digest/content-type/rate-limit metadata without
  forcing renderer or Docker Manager code to parse registry responses directly.
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

For runtime provisioner changes, run:

```bash
node --test shell/docker_adapter/runtime_provisioner.test.mjs
```

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
