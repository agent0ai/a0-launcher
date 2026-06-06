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
- `impl/DockerodeDocker.mjs`: Dockerode-backed concrete implementation.
- `impl/DockerHubRegistry.mjs`: Docker Hub registry and manifest/digest access.
- `impl/DockerodeLogProcessor.mjs`: Docker pull/log stream processing.
- `LOG_PROCESSOR.md`: explanatory implementation notes for log processing.

## Local Contracts

- `DockerInterface.mjs` is ESM by design. Keep the CommonJS bridge contained in
  `getDocker.js`.
- `DockerInterface.get({ imageRepo, dockerHost })` caches adapter instances per
  image repo and Docker host override. Runtime setup may change the host at
  runtime, so a different `dockerHost` must create a fresh adapter instance.
- When `dockerHost` is omitted, the cache key uses the current `DOCKER_HOST`
  environment value. An explicit empty `dockerHost` means the default Docker
  socket and must not fall back to `DOCKER_HOST`.
- Environment detection should be best-effort and return structured diagnostics
  rather than throwing for ordinary "Docker unavailable" cases.
- `DOCKER_HOST` parsing must preserve enough detail to diagnose Unix socket,
  named pipe, TCP, HTTP, HTTPS, and invalid host configurations.
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

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
