# Quickstart: Docker Version Management

This quickstart is for developers/testers implementing and validating the "Agent Zero Versions" feature defined in:

- `specs/001-docker-version-management/spec.md`

## Prerequisites

- Node.js 20+
- npm 9+
- Docker Desktop (macOS/Windows) or Docker Engine (Linux), running and reachable
- Network access (for fetching GitHub release metadata and pulling images)

## Run The Launcher Shell (Dev)

From repo root:

```bash
npm install
npm start
```

Notes:
- The shell downloads `content.json` (the `app/` UI bundle) from GitHub Releases at runtime.
- For end-to-end fork testing of UI changes, follow the workflow in `README.md` ("Fork Testing (End-to-End)").

## Backend Service Defaults (Planned)

Unless overridden, the feature is planned to target Agent Zero's official image and releases:

- GitHub releases repo: `agent0ai/agent-zero`
- Docker image repo: `agent0ai/agent-zero`

Planned (optional) overrides for development:

- `A0_BACKEND_GITHUB_REPO=owner/repo` (override release list source)
- `A0_BACKEND_IMAGE_REPO=namespace/name` (override image repo to pull/run)

## Validate Core Flows

### 1) Version List And Update Available

- Open the "Agent Zero" screen.
- Verify the UI shows:
  - Installed vs Available versions
  - Which version is Active
  - When an Update is available (including the newest version number)
  - The first-class "Testing" preview entry (independent of GitHub Releases), when available
  - Local builds as a separate section (canonical local tags labeled distinctly from custom local builds)
  - Retained instances (rollback targets) as instances ordered by retained-at time

### 2) Install An Older Version

- Choose an older official version and install it.
- Verify progress feedback updates during download/pull.
- If Cancel is available, trigger Cancel and verify the UI returns to a stable state.

### 3) Activate Or Update (Data Loss Warning)

- Trigger activate/update.
- Verify the UI requires one of:
  - "I have a backup"
  - "Proceed without backup"
  - Cancel
- If update completes, verify the prior instance appears in the retained list and the newest version becomes Active.

### 4) Rollback Retention

- After a successful update, verify the most recent prior instance appears in the retained list.
- Verify retained instances are listed as instances (with retained-at time), not as a purely semver-sorted version list.
- Verify you can delete retained (non-active) instances with confirmation.
- Trigger "Roll back" from a retained instance and verify the selected instance becomes Active.

### 5) Local Canonical Tags (Developer/Power User)

- Ensure at least one canonical local tag exists (for example `agent0ai/agent-zero:local` or `agent0ai/agent-zero:testing`).
- Verify the UI shows canonical local tags as stable "Local Build" entries (and non-canonical tags as "Custom Local Build").
- If a canonical local tag diverges from its remote counterpart (for example local `testing` differs from remote `testing`), verify the UI offers a "Sync" action and the operation is safe and retryable.

### 6) Offline Mode

- Disable network and open the "Service Versions" screen.
- Verify installed versions remain visible and you can switch among installed versions.
- Verify install/update/sync actions are suppressed while offline, and the UI shows an offline indicator (with last successful check time when known).

## Troubleshooting (Developer-Facing)

- If Docker is not installed/running: ensure Docker Desktop/Engine is installed and started.
- If permissions are denied (Linux): add your user to the `docker` group and re-login, or run Docker with appropriate permissions.
- If pulls are rate limited: log into Docker Desktop/Engine, or implement optional credential support per `spec.md` FR-020.
