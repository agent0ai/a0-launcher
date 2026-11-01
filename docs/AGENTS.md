# AGENTS

## Purpose

`docs/` owns supplemental user-facing documentation for running, integrating, and troubleshooting the launcher.

These docs explain the product and workflows. Durable implementation contracts belong in `AGENTS.md` files.

## Ownership

This scope owns:

- `running-ui.md`: notes for running and validating the launcher UI.
- `res/launcher-installation.png`: installation screenshot displayed below the root README title.
- `faq-integration.md`: integration-oriented FAQ and user guidance.
- `runtime-troubleshooting.md`: user-facing runtime detection and repair notes for Docker-compatible endpoints, Docker contexts, and setup fallback paths.
- `release-todos.md`: current artifact, Windows runtime matrix, installer/updater, Instance-surface, and CLI release checks, with dated verification results. Keep observed verification limits explicit, especially simulated host absence and ARM64 packaging versus native execution.

## Local Contracts

- Keep public/user-facing language clear and task-oriented.
- Do not let docs drift into a second implementation contract. If a detail is needed for agents changing code, put it in the closest owning `AGENTS.md` and link or summarize publicly here only when useful.
- Keep commands Linux-friendly by default.
- Update docs when setup, release, local run, or troubleshooting workflows change.
- Keep product terms aligned with the app: `Instances`, `Storage volumes`, and `Open UI`.

## Work Guidance

- Prefer short sections with concrete commands and expected outcomes.
- Avoid duplicating long code or architecture descriptions that belong in root or scoped AGENTS docs.
- Refresh the README screenshot from a real Launcher window during an Agent Zero image download, with the installation walkthrough visible and no private data. Preserve the full supplied scene; optimize the PNG before replacing `res/launcher-installation.png`.

## Verification

For docs-only changes, run:

```bash
git diff --check
```

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
