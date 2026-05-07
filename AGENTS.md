# A0 Launcher - AGENTS.md

[Generated from codebase reconnaissance on 2025-12-18]

## Quick Reference
- **Tech Stack**: JavaScript (CommonJS) | Electron 33.x (Electron Forge 7.6.x) | Node.js 20+ | GitHub Actions
- **Dependency highlights**: `electron@^33.2.0`, `@electron-forge/*@^7.6.0`, `electron-squirrel-startup@^1.0.1`
- **Dev Run**: `npm start` (GUI required)
- **Build (local)**: `npm run make` (or `npm run make:<os>`)
- **Fork E2E Content Repo Override**: `A0_LAUNCHER_GITHUB_REPO="owner/repo" npm start`
- **Local Dev Content (skip GitHub Releases)**:
  - `A0_LAUNCHER_USE_LOCAL_CONTENT=1 npm start` (use CWD if it contains `app/index.html` + `package.json`)
  - `A0_LAUNCHER_LOCAL_REPO="/abs/or/relative/path" npm start` (override repo dir; takes precedence)
- **Docs**: `README.md`, `.specify/memory/constitution.md`, `specs/`

---

## Table of Contents
1. [Project Overview](#project-overview)
2. [Core Commands](#core-commands)
3. [Project Structure](#project-structure)
4. [Development Patterns and Conventions](#development-patterns-and-conventions)
5. [Safety and Permissions](#safety-and-permissions)
6. [Code Examples (Good and Avoid)](#code-examples-good-and-avoid)
7. [Git Workflow and CI](#git-workflow-and-ci)
8. [Troubleshooting](#troubleshooting)

---

## Project Overview

A0 Launcher is an Electron desktop shell that downloads UI content (`content.json`) from GitHub Releases at runtime and renders it locally. This enables shipping a stable executable while updating the UI/content independently via releases.

**Type**: Electron desktop app (packaged shell + downloadable content)
**Status**: Active development
**Primary languages**: JavaScript (CommonJS), HTML/CSS, YAML, Bash

Key constraints (non-negotiables) live in `.specify/memory/constitution.md`:
- Electron security isolation (treat downloaded content as untrusted)
- Shell/content contract (`content.json` schema)
- Release semver semantics (MAJOR builds executables; MINOR/PATCH reuse artifacts)

---

## Core Commands

### Development
- Install deps (recommended for CI/repro): `npm ci`
- Install deps (developer convenience): `npm install`
- Run dev mode (Electron GUI): `npm start`

### Build / Packaging
- Package (no installers): `npm run package`
- Make installers (current OS): `npm run make`
- Make installers (explicit platform):
  - macOS: `npm run make:mac`
  - Windows: `npm run make:win`
  - Linux: `npm run make:linux`

### macOS: Unsigned vs Signed/Notarized
- Unsigned local build (recommended for forks/dev): `SKIP_SIGNING=1 npm run make:mac`
- Signed + notarized (release-grade):
  - Requires secrets: `MACOS_CERT_P12`, `MACOS_CERT_PASSPHRASE`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
  - Control notarization:
    - Default: notarize when Apple credentials are present
    - Force on: `NOTARIZE=1 npm run make:mac`

### File-scoped "fast checks" (preferred)
There is no repo-standard JS test runner or linter script yet. Use these for fast feedback:
- Syntax check a file: `node --check shell/main.js`
- Syntax check a script: `node --check scripts/write-build-info.js`
- Validate Forge config loads: `node -e "require('./forge.config.js'); console.log('forge.config.js: OK')"`

### Testing
- **JavaScript tests**: No `npm test` script is currently defined in `package.json`.
- **SpecKit tooling tests**: exist under `.specify/tests/` (Python) but are not part of npm scripts.

---

## Project Structure

```
/
├── AGENTS.md                          # You are here
├── README.md                          # Human-facing overview + fork/testing + signing
├── package.json                       # npm scripts + Electron deps
├── package-lock.json                  # Lockfile (CI should use npm ci)
├── forge.config.js                    # Electron Forge config (makers, signing/notarization)
├── app/                               # Source UI content (bundled into content.json by CI)
│   └── index.html
├── shell/
│   ├── main.js                        # Electron main process (update/download/extract/load)
│   ├── preload.js                     # contextBridge surface (renderer API)
│   ├── loading.html                   # Loading UI shown before content loads
│   └── assets/                        # Icons + mac entitlements
├── scripts/
│   ├── write-build-info.js            # Generates shell/build-info.json from git remote/env
│   └── bootstrap-macos.sh             # Ephemeral macOS VM bootstrap (unsigned build/dev)
├── .github/workflows/
│   ├── bundle-content.yml             # Bundles app/ -> content.json and uploads
│   └── build.yml                      # Builds executables; reuses artifacts for minor/patch
├── specs/                              # SpecKit artifacts (may include not-yet-implemented work)
│   └── 001-docker-version-management/  # Example feature spec + contracts
├── .specify/                           # SpecKit memory/templates/scripts
└── .cursor/                            # Cursor commands and auto-generated rules
```

Key files worth opening first:
- `shell/main.js`: update and content lifecycle, Electron security settings
- `shell/preload.js`: renderer API surface (must stay minimal)
- `.github/workflows/build.yml`: release vs fork/dev build behavior
- `.github/workflows/bundle-content.yml`: `content.json` bundling assumptions (text-only)
- `.specify/memory/constitution.md`: project "non-negotiables"

---

## Development Patterns and Conventions

### Runtime Architecture (Shell vs Content)
- **Shell (`shell/`)**: Electron main process, packaging, update/download logic.
- **Content (`app/`)**: downloaded and rendered UI content. It is treated as untrusted.

### Electron Security Baseline
Keep these defaults in `BrowserWindow`:
- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- All renderer-to-main capabilities go through a whitelisted `contextBridge` API in `shell/preload.js`

### Content Contract: `content.json` (text-only)
- Bundling reads all files in `app/` as UTF-8 strings.
- Extraction writes files as UTF-8 strings to a userData cache directory.
- Adding binary assets requires updating BOTH:
  - `.github/workflows/bundle-content.yml` (bundler)
  - `shell/main.js` (extractor)

Current implicit schema (see constitution and bundler):
```json
{
  "bundled_at": "ISO-8601 timestamp",
  "file_count": 123,
  "files": {
    "relative/path.ext": "file contents as UTF-8 string"
  }
}
```

### Fork End-to-End Testing (Content Source Selection)
The shell downloads from the GitHub repo defined by:
1. `A0_LAUNCHER_GITHUB_REPO` env var (format: `owner/repo`)
2. `shell/build-info.json` (generated by `scripts/write-build-info.js`)
3. Fallback default: `agent0ai/a0-launcher`

`shell/build-info.json` is generated on `npm start`, `npm run make*`, and `npm run package` (and is gitignored).

### Code Style
No single enforced formatter config is present. Existing code mixes:
- single quotes in `shell/*.js`
- double quotes + trailing commas in `forge.config.js` and `scripts/*.js`

Rule of thumb: keep changes stylistically consistent within the file you touch; avoid drive-by reformatting.

---

## Safety and Permissions

### Allowed without asking
- Read/search any repository file.
- Add/update JS/HTML in `shell/`, `app/`, `scripts/` while respecting constitution gates.
- Run file-scoped checks: `node --check <file>`, `node -e "require(...)"`.
- Run CI-equivalent installs in a scratch environment: `npm ci` (creates `node_modules/`).

### Ask before executing
- Adding/removing dependencies (`package.json`, `package-lock.json`).
- Editing GitHub workflows (`.github/workflows/*`) or release semantics.
- Broadening renderer capabilities (new preload exports, new IPC surface, relaxing `contextIsolation`/`sandbox`).
- Modifying `.specify/memory/constitution.md` (governance document).
- Deleting files or directories.

### Never do (unless explicitly instructed by a human)
- Commit secrets (Apple creds, signing certs, tokens) or write them into `app/` content.
- Disable Electron isolation defaults or expose `ipcRenderer` directly to untrusted content.
- Use destructive git commands that discard work (e.g., `git reset --hard`, `git checkout --`, `git restore`).

---

## Code Examples (Good and Avoid)

### GOOD: Validate untrusted inputs (repo override)
From `shell/main.js`:

```js
function normalizeGithubRepo(value) {
  const v = (value || '').trim();
  if (!v) return '';
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return v;
  return '';
}
```

### GOOD: Keep BrowserWindow isolation on by default
From `shell/main.js`:

```js
mainWindow = new BrowserWindow({
  // ...
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  }
});
```

### GOOD: Keep build metadata generation tolerant (dev should not break)
From `scripts/write-build-info.js`:

```js
function writeBuildInfo(payload) {
  try {
    fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    process.stderr.write(
      `[build-info] WARNING: failed to write ${OUTPUT_FILE}: ${error?.message || String(error)}\n`,
    );
    return false;
  }
}
```

### AVOID: Adding preload event listeners without an unsubscribe strategy
From `shell/preload.js`:

```js
onStatusUpdate: (callback) => {
  ipcRenderer.on('update-status', (_event, message) => callback(message));
},
```

If you add more event listeners, consider returning an unsubscribe function (or ensure the renderer calls it only once).

### AVOID: Swallowing errors silently (unless intentionally non-blocking)
From `shell/main.js`:

```js
try {
  const raw = fsSync.readFileSync(BUILD_INFO_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  const fromFile = normalizeGithubRepo(parsed?.githubRepo);
  if (fromFile) return fromFile;
} catch {
  // ignore
}
```

If the input is not optional, log and/or surface errors instead of ignoring them.

### AVOID: Assuming app content is UTF-8 text when adding binaries
From `.github/workflows/bundle-content.yml`:

```js
// Read file content as string (works for text files)
files[relativePath] = fs.readFileSync(fullPath, 'utf8');
```

Do not add binary assets to `app/` unless bundling/extraction is updated accordingly.

---

## Git Workflow and CI

### Branching and PRs
No strict conventions are enforced in-repo (commit history mixes "Update ..." and `fix:`/`feat:`). Prefer:
- Feature branches per change
- PRs to main vendor repo with a clear testing section

### CI Workflows (GitHub Actions)
- `Bundle Content` (`.github/workflows/bundle-content.yml`):
  - On release: bundles `app/` into `content.json` and uploads to the release.
  - On workflow_dispatch: bundles and uploads as a workflow artifact.
- `Build Executables` (`.github/workflows/build.yml`):
  - On release: builds executables only for MAJOR changes, otherwise reuses previous major's assets.
  - On workflow_dispatch: always builds executables (intended for fork/dev testing) and uploads workflow artifacts.
  - macOS signing secrets are optional in forks; the workflow builds unsigned when secrets are absent.

### Release Semantics (important)
Follow `.specify/memory/constitution.md`:
- MAJOR: changes that affect the packaged executable (typically `shell/`, `forge.config.js`, workflows)
- MINOR/PATCH: content-only (`app/`) changes that do not require rebuilding the shell

---

## Troubleshooting

### "No content available" / blank UI
- The shell expects a GitHub Release with a `content.json` asset.
- Verify the repo it is using:
  - Look for "Using GitHub content repo: ..." in logs (main process)
  - Override: `A0_LAUNCHER_GITHUB_REPO="owner/repo" npm start`

### Offline mode behavior
If GitHub API is unreachable, the shell will use cached content if present. If cache is missing, it will show an error.

### macOS build fails on a fresh machine
- For dev/fork: use unsigned build: `SKIP_SIGNING=1 npm run make:mac`
- For ephemeral macOS VMs: run `./scripts/bootstrap-macos.sh build` (from repo root)
- For release-grade: you need signing and notarization secrets (see README and forge config)

### Linux build fails due to missing rpm tooling
CI installs `rpm` on ubuntu before building. Local linux builds may need:
- `sudo apt-get update && sudo apt-get install -y rpm`

### Cursor auto-generated rule mismatch
`.cursor/rules/specify-rules.mdc` may contain auto-generated guidance (e.g., `src/`, `tests/`, `npm test`) that does not match the current repo. Prefer `package.json`, `README.md`, and `.specify/memory/constitution.md` as the source of truth.
