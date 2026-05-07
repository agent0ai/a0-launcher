<!--
Sync Impact Report

- Version change: 1.0.0 -> 1.0.1
  Bump rationale: Ported the existing A0 Launcher constitution content into the
  official SpecKit template and added patch-level clarifications that reflect
  current repo behavior (fork testing repo selection + macOS signing toggles).
- Principles modified:
  - III. Release Semver and Build Workflow Discipline: clarified release builds
    vs workflow_dispatch test builds.
- Sections modified:
  - Technical Standards and Conventions / Environment Variables and Secrets:
    documented A0_LAUNCHER_GITHUB_REPO, SKIP_SIGNING, and NOTARIZE.
- Sections added: none
- Sections removed: none
- Propagation status:
  - OK: .specify/templates/plan-template.md (updated; A0 tech context + constitution gates + repo structure)
  - OK: .specify/templates/spec-template.md (reviewed; no changes required)
  - OK: .specify/templates/tasks-template.md (updated; Electron-oriented paths/examples)
  - OK: .cursor/commands/*.md (reviewed; no changes required)
  - OK: README.md (already documents fork testing + signing flows)
- Deferred placeholders (TODOs): none
-->

# A0 Launcher Constitution

## Core Principles

### I. Electron Security Model (Non-Negotiable)
The launcher MUST treat any downloaded content as untrusted input and MUST keep
Electron security controls enabled by default.

- BrowserWindows MUST keep `contextIsolation: true`, `sandbox: true`, and
  `nodeIntegration: false`.
- All main-process capabilities exposed to renderer code MUST go through a
  narrowly scoped `contextBridge` API (do not expose `ipcRenderer` directly).
- Any changes that broaden renderer capabilities (new IPC channels, new preload
  surface, relaxed CSP) MUST include explicit rationale and risk assessment in
  the relevant `specs/<feature>/plan.md`.

Rationale: This app executes UI code that can change independently from the
packaged shell. The safest default is strict isolation.

### II. Shell/Content Separation and Bundle Contract
The packaged Electron shell (`shell/`) and the downloaded content (`app/`)
MUST remain cleanly separated, with a stable, documented contract.

- `app/` is source content for `content.json` and MUST be treated as deployable
  independently from the shell executable.
- The `content.json` schema MUST remain compatible with `shell/main.js`
  (currently: `{ bundled_at, file_count, files: { "<path>": string } }`).
- Content bundling/extraction currently assumes UTF-8 text files. Adding binary
  assets to `app/` MUST be accompanied by updating both:
  - `.github/workflows/bundle-content.yml` (bundling)
  - `shell/main.js` (extraction)

Rationale: "Build once, update forever" only works when the shell-content
contract is stable and explicit.

### III. Release Semver and Build Workflow Discipline
Release tags and changes MUST follow semantic versioning with meaning aligned to
the GitHub Actions workflows.

- Releases MUST be tagged as `vMAJOR.MINOR.PATCH`.
- Any changes that affect the packaged executable behavior (typically changes in
  `shell/`, `forge.config.js`, or packaging/signing behavior) MUST increment
  MAJOR.
- Changes that only update `app/` content SHOULD use MINOR or PATCH and MUST NOT
  require rebuilding the shell.
- CI workflows are authoritative:
  - `.github/workflows/build.yml` builds executables for releases only when MAJOR
    changes. `workflow_dispatch` builds are permitted for fork/dev testing.
  - `.github/workflows/bundle-content.yml` produces `content.json` per release.

Rationale: The release pipeline reuses prior build artifacts for non-major
changes. Versioning must match that assumption to avoid shipping mismatched
executables.

### IV. Dependencies and Reproducible Builds
Development and CI MUST be reproducible and SHOULD keep dependency surface area
small.

- Node.js 20+ and npm 9+ are the supported baseline for development and CI.
- `package-lock.json` MUST be committed and kept in sync with `package.json`.
- CI and release builds MUST use `npm ci` (lockfile-based installs).
- New third-party dependencies SHOULD be avoided when Electron/Node built-ins
  suffice, and MUST include justification when introduced.

Rationale: Electron app stability and security degrade quickly with unchecked
dependency growth and non-reproducible installs.

### V. Spec-Driven Development Artifacts (SpecKit)
This repository uses SpecKit artifacts and scripts to keep work traceable and
repeatable.

- Feature work SHOULD be captured under `specs/` and follow the SpecKit workflow
  (`/speckit.specify` -> `/speckit.plan` -> `/speckit.tasks` -> `/speckit.implement`).
- The constitution is a quality gate. Any change to this file MUST:
  - Update the Sync Impact Report at the top
  - Bump `Version` using semver rules in Governance
- Plans (`plan.md`) MUST include a "Constitution Check" section that evaluates
  the relevant gates before implementation.

Rationale: The launcher relies on a small set of non-negotiable constraints
(security, release semantics, and shell/content contracts). Specs keep those
constraints explicit per change.

## Technical Standards and Conventions

### Repository Layout
```text
a0-launcher/
├── app/                   # Source content bundled to content.json on release
├── shell/                 # Packaged Electron shell
├── forge.config.js        # Electron Forge packaging config (signing/notarization)
├── package.json           # Node/Electron dependencies and scripts
└── .github/workflows/     # CI: build executables + bundle app content
```

### Runtime/Build Technology
- Runtime: Electron (Electron Forge), JavaScript (CommonJS), HTML/CSS
- Package manager: npm (lockfile required)
- CI: GitHub Actions

### Environment Variables and Secrets
- Content source repo override (fork/testing): `A0_LAUNCHER_GITHUB_REPO` (format: `owner/repo`)
- macOS notarization uses `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.
- Code signing uses `MACOS_CERT_P12`, `MACOS_CERT_PASSPHRASE`.
- macOS build toggles:
  - `SKIP_SIGNING=1` disables macOS signing and notarization for local/fork builds.
  - `NOTARIZE=1` forces notarization on; default behavior is to notarize when Apple
    credentials are present.
- Secrets MUST only be provided via CI secrets or local environment variables
  (never committed to the repository, never written into `app/` content).

## Development Workflow and Quality Gates

### Local Development
- Install: `npm install`
- Run: `npm start`
- Package/make: `npm run make` (or `make:mac`, `make:win`, `make:linux`)
- Unsigned macOS builds (no Apple setup required): `SKIP_SIGNING=1 npm run make:mac`

### Release Workflow (Operational Contract)
- Update `app/` content as needed.
- Create a GitHub Release tagged `vMAJOR.MINOR.PATCH`.
- `bundle-content.yml` uploads `content.json` to the release.
- `build.yml` produces executables:
  - Release builds: MAJOR changes build fresh artifacts; MINOR/PATCH changes reuse
    prior major's artifacts and rename to match tag.
  - `workflow_dispatch` builds are for fork/dev testing and upload artifacts to
    the workflow run.

### Constitution Gates (to copy into plan.md)
- Gate A (Security): Renderer isolation and preload API remain minimal; any
  widening is justified and reviewed.
- Gate B (Bundle Contract): `content.json` schema remains compatible with the
  shipped shell; app content remains text-only unless bundling/extraction is
  updated.
- Gate C (Release Semantics): Version bump matches what changed (MAJOR for shell,
  MINOR/PATCH for content-only).

## Governance
The constitution supersedes all other project guidance. If a spec, plan, or task
conflicts with a MUST rule here, the spec/plan/tasks must change. Do not dilute
the rule to make a plan "easier".

### Amendments
- Any amendment MUST include:
  - The reason for the change
  - The impacted principles/sections
  - Any required migration notes (what existing code/docs must be updated)
- The Sync Impact Report at the top of this file MUST be updated with:
  - Version change and rationale
  - Updated propagation status for dependent templates/docs

### Versioning Policy (Semver)
- MAJOR: Principle removed or meaning narrowed/widened in a way that changes
  what future work is allowed to do.
- MINOR: New principle or materially expanded guidance that adds new constraints.
- PATCH: Clarifications or wording changes with no semantic governance change.

### Compliance Expectations and Cadence
- Any work that touches `shell/`, release workflows, or the update mechanism
  SHOULD re-check all Constitution Gates in the plan.
- Review cadence: revisit this constitution at least quarterly or immediately
  after any MAJOR shell change.

**Version**: 1.0.1 | **Ratified**: 2025-12-17 | **Last Amended**: 2025-12-18

