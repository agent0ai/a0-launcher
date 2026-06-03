# AGENTS.md

Guidance for AI coding agents working in `/home/eclypso/a0/a0-launcher`.

## Purpose

This root DOX file owns repo-wide policy for the A0 Launcher and is the first
contract to read before editing any project file.

The launcher is an Electron desktop app that lets people install, activate,
switch, inspect, and open Dockerized Agent Zero instances without needing to
learn Docker first. Build it as if elegance and reliability are the same
requirement: clear, restrained, robust, and worthy of the Agent Zero brand.

## Ownership

This scope owns top-level project policy, product language, release/version
expectations, development commands, and the Child DOX Index.

Root-owned files and folders:

- `AGENTS.md`: repo-wide DOX rail and Child DOX Index.
- `README.md`: public product overview and user/developer quick start.
- `package.json` and `package-lock.json`: Electron app version, dependencies,
  npm scripts, and local-dev fallback metadata.
- `forge.config.js`: Electron Forge makers, signing, notarization, and
  executable packaging configuration.
- `.gitignore`, `LICENSE`: repository metadata.
- Child-owned areas listed in the Child DOX Index below.

## Local Contracts

DOX contracts:

- Treat every `AGENTS.md` file as the source of truth for its subtree.
- Before editing, read this file, identify the paths you expect to touch, then
  walk from the repo root to each target path and read every `AGENTS.md` on that
  route.
- If a parent lists a child `AGENTS.md` whose scope contains the target path,
  read the child and continue downward.
- The closer `AGENTS.md` controls local details. No child may weaken these root
  DOX rules.
- After every meaningful change, make a DOX pass: update the closest owning
  `AGENTS.md`, update affected parents or children, refresh Child DOX Indexes,
  and remove stale or contradictory notes.
- Keep public product copy in `README.md` and `docs/`. Keep durable development
  contracts in `AGENTS.md`.

Architecture contracts:

- `app/` is the static renderer/content layer.
- `shell/` is the privileged Electron main/preload and Docker orchestration
  layer.
- `shell/docker_manager/` is the product-level Agent Zero image, instance,
  storage-volume, release, retention, and remote-instance orchestration layer.
- `shell/docker_adapter/` is the generic Docker and Docker Hub abstraction.
- Renderer code requests intent; shell code owns privilege; Docker adapter code
  owns Docker mechanics.

Runtime and release contracts:

- Shell: `bash`.
- OS: Ubuntu Linux.
- Workspace: `/home/eclypso/a0/a0-launcher`.
- Use Linux paths and commands in examples.
- Do not assume Windows-only paths such as `.\.venv\Scripts\python`; use Linux
  virtualenv paths like `./.venv/bin/python`.
- Use local app contents with:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```

- `App: ...` in the UI comes from Electron `app.getVersion()`, which reads the
  root `package.json` version.
- Keep `package.json` and the root entries in `package-lock.json` aligned with
  the current release line so local `npm start` runs do not show stale metadata.
- Packaged or non-local runs fetch `content.json` from the latest GitHub Release
  for the configured launcher repo and unpack it under Electron `userData`.
- `A0_LAUNCHER_GITHUB_REPO` can override the launcher content repository.
- `A0_LAUNCHER_USE_LOCAL_CONTENT=true` can use the current working directory as
  local content when it contains `app/index.html` and `package.json`.
- Docker images default to `agent0ai/agent-zero`.
- Backend release metadata defaults to `agent0ai/agent-zero`.
- `A0_BACKEND_IMAGE_REPO` and `A0_BACKEND_GITHUB_REPO` may override those repos
  for testing.
- `v*` tags are release inputs for executable builds.
- Two-segment tags such as `v0.1` become semver `0.1.0` in the workflow.
- Release artifacts are macOS arm/x86 DMG and ZIP, Windows arm/x86 Squirrel
  setup and NuGet packages, Linux arm/x86 DEB packages, and `content.json`.
  Linux RPMs are intentionally omitted unless the product decision changes.
- If a release tag is moved to include a metadata fix, keep `main`, the tag, and
  both remotes intentionally aligned.

Agent Zero runtime assumptions:

- When discussing plugin/backend code, treat the Dockerized Agent Zero instance
  at `localhost:32080` as the live runtime.
- If you change live runtime plugin/backend code, also copy those changes into
  the real A0 Core plugin repo:

```bash
/home/eclypso/a0/agent-zero/plugins
```

- Do not leave runtime-only plugin changes stranded in the container.

Product language:

- Say `Instances`, not `Sessions`, for running or retained containers.
- Say `Storage volumes`, not just `Storage`, when referring to Docker volumes.
- Keep Docker mechanics behind purposeful controls.
- Put `Open UI` where the instance lives, not in the global header.
- Keep the surface quiet and precise: avoid excessive borders, nested cards, and
  explanatory clutter.
- The API Dashboard destination is:

```text
https://www.agent-zero.ai/p/community/api-dashboard/
```

Security and boundaries:

- Docker access belongs behind IPC and `shell/docker_manager`.
- Renderer code should call `window.dockerManagerAPI` through the preload
  surface.
- Keep Electron windows secure: `contextIsolation: true`, `nodeIntegration:
  false`, and `sandbox: true` unless there is a documented reason.

## Work Guidance

- Follow existing patterns before inventing new ones.
- Keep changes narrowly scoped to the requested behavior.
- Use structured APIs and parsers when available; avoid fragile string
  manipulation for nontrivial data.
- Prefer small helpers when they remove real complexity.
- Add comments only where they explain a non-obvious decision.
- Default to ASCII unless the file already uses meaningful Unicode.
- Do not create hidden scratch directories or commit generated outputs unless a
  checked-in fixture is explicitly requested.
- Build the usable app first, not a landing page.
- Use Agent Zero's existing visual language and local tokens.
- Prefer familiar icon buttons for obvious controls such as refresh.
- Avoid boxy chrome where a lighter grouping works better.
- Make interactive states clear: loading, disabled, empty, success, and error.
- Keep text short and task-oriented.
- Verify text does not overflow compact controls or cards.

Git discipline:

- Make separate, logical, no-nonsense commits when the user asks for commits.
- Do not stage unrelated user changes accidentally.
- Do not revert user changes unless explicitly asked.
- Before committing, inspect `git status --short` and the staged diff.

## Verification

There is no default `npm test` contract in this repo unless a future commit adds
one.

For quick validation, prefer:

```bash
node --check shell/main.js
node --check shell/preload.js
node --check shell/docker_manager/index.js
node --check app/docker_manager.js
git diff --check
```

For shell instance-tab logic, run:

```bash
node --test shell/instance_tabs.test.js
```

For visible UI changes, run local content and inspect the affected workflow:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```

## Child DOX Index

This index must stay exhaustive.

- `/.github/AGENTS.md`: GitHub Actions release builds and content bundling.
- `/app/AGENTS.md`: static renderer app, renderer state, assets, and component
  loading.
  - `/app/a0ui/AGENTS.md`: portable Agent Zero UI framework assets and vendored
    browser dependencies.
  - `/app/components/docker-manager/AGENTS.md`: Docker Manager renderer
    components and component store.
- `/docs/AGENTS.md`: supplemental user-facing documentation.
- `/scripts/AGENTS.md`: developer and build helper scripts.
- `/shell/AGENTS.md`: Electron main/preload host, content loading, IPC, windows,
  tray, and privileged orchestration.
  - `/shell/docker_adapter/AGENTS.md`: generic Docker and Docker Hub adapter.
  - `/shell/docker_manager/AGENTS.md`: Agent Zero Docker Manager product layer.
