# AGENTS.md

Guidance for AI coding agents working in `/home/eclypso/a0/a0-launcher`.

## Compass

Build as if elegance and reliability are the same requirement. Prefer code that is clear, restrained, robust, and worthy of the Agent Zero brand: functional beauty, not decorative noise.

Keep the signal high. Explore boldly, then refine carefully. Make the app feel like it dissolves Docker from the user's path instead of explaining Docker back to them.

## Environment

- Shell: `bash`
- OS: Ubuntu Linux
- Workspace: `/home/eclypso/a0/a0-launcher`
- Use Linux paths and commands in examples.
- Do not assume Windows-only paths such as `.\.venv\Scripts\python`; use Linux virtualenv paths like `./.venv/bin/python`.

## Running The Launcher

Use local app contents with:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```

For quick validation, prefer:

```bash
node --check shell/main.js
node --check shell/preload.js
node --check shell/docker_manager/index.js
node --check app/docker_manager.js
git diff --check
```

There is no default `npm test` contract in this repo unless a future commit adds one.

## Agent Zero Runtime Assumptions

- When discussing plugin/backend code, treat the Dockerized Agent Zero instance at `localhost:32080` as the live runtime.
- If you change live runtime plugin/backend code, also copy those changes into the real A0 Core plugin repo:

```bash
/home/eclypso/a0/agent-zero/plugins
```

Do not leave runtime-only plugin changes stranded in the container.

## Product Direction

The launcher is the bridge that lets people run Agent Zero instances without needing to understand Docker first.

- Say `Instances`, not `Sessions`, for running or retained containers.
- Say `Storage volumes`, not just `Storage`, when referring to Docker volumes.
- Keep Docker mechanics behind purposeful controls.
- Put `Open UI` where the instance lives, not in the global header.
- Keep the surface quiet and precise: avoid excessive borders, nested cards, and explanatory clutter.
- The API Dashboard destination is:

```text
https://www.agent-zero.ai/p/community/api-dashboard/
```

## Code Style

- Follow existing patterns before inventing new ones.
- Keep changes narrowly scoped to the requested behavior.
- Use structured APIs and parsers when available; avoid fragile string manipulation for nontrivial data.
- Prefer small helpers when they remove real complexity.
- Add comments only where they explain a non-obvious decision.
- Default to ASCII unless the file already uses meaningful Unicode.

## Frontend Principles

- Build the usable app first, not a landing page.
- Use Agent Zero's existing visual language and local tokens.
- Prefer familiar icon buttons for obvious controls such as refresh.
- Avoid boxy chrome where a lighter grouping works better.
- Make interactive states clear: loading, disabled, empty, success, and error.
- Keep text short and task-oriented.
- Verify text does not overflow compact controls or cards.

## Docker Manager Boundaries

- `app/` is the renderer/content layer.
- `shell/` is the Electron main/preload and Docker orchestration layer.
- Docker access belongs behind IPC and `shell/docker_manager`.
- Renderer code should call `window.dockerManagerAPI` through the preload surface.
- Keep Electron windows secure: `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` unless there is a documented reason.

## CodeRabbit

CodeRabbit is installed in the terminal. Use it for code review when changes are more than trivial.

Review uncommitted changes with:

```bash
coderabbit --prompt-only -t uncommitted
```

Useful help:

```bash
cr -h
```

Do not run CodeRabbit more than 3 times for one set of changes. If it is cancelled, assume the user chose to cancel because the review was unnecessary for that change.

## Git Discipline

- Make separate, logical, no-nonsense commits.
- Use a concise subject and a short body explaining the intent.
- Do not stage unrelated user changes accidentally.
- Do not revert user changes unless explicitly asked.
- Before committing, inspect `git status --short` and the staged diff.
- Prefer commits that tell the product story in order: surface, behavior, runtime wiring, docs.
