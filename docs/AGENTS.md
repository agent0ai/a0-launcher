# AGENTS

## Purpose

`docs/` owns supplemental user-facing documentation for running, integrating,
and troubleshooting the launcher.

These docs explain the product and workflows. Durable implementation contracts
belong in `AGENTS.md` files.

## Ownership

This scope owns:

- `running-ui.md`: notes for running and validating the launcher UI.
- `faq-integration.md`: integration-oriented FAQ and user guidance.
- `release-todos.md`: release checklist and temporary product corrections that
  must survive across coding sessions.
- `superpowers/specs/`: approved design specs created during brainstorming
  before implementation planning.
- `superpowers/plans/`: implementation plans written from approved specs before
  code execution.

## Local Contracts

- Keep public/user-facing language clear and task-oriented.
- Do not let docs drift into a second implementation contract. If a detail is
  needed for agents changing code, put it in the closest owning `AGENTS.md` and
  link or summarize publicly here only when useful.
- Keep commands Linux-friendly by default.
- Update docs when setup, release, local run, or troubleshooting workflows change.
- Keep product terms aligned with the app: `Instances`, `Storage volumes`, and
  `Open UI`.

## Work Guidance

- Prefer short sections with concrete commands and expected outcomes.
- Avoid duplicating long code or architecture descriptions that belong in root or
  scoped AGENTS docs.
- If screenshots or generated artifacts are added later, document the capture
  and regeneration path here.

## Verification

For docs-only changes, run:

```bash
git diff --check
```

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
