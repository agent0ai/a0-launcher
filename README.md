# A0 Launcher

Desktop application shell for Agent Zero. This Electron app automatically downloads and displays the latest content from GitHub releases.

## Architecture

The app consists of two parts:

1. **Shell** (`shell/`) - The Electron executable that handles:
   - Window management
   - Checking for updates via GitHub Releases API
   - Downloading and caching content
   - Loading the downloaded content

2. **Content** (`app/`) - The actual application UI:
   - HTML, CSS, and JavaScript files
   - Bundled into `content.json` on each release
   - Downloaded at runtime by the shell

> **Note:** The `app/` folder exists in this repo as **source content** for the GitHub Action to bundle. The built executable does NOT include these files - it downloads them from GitHub Releases at runtime. This enables "build once, update forever" - content updates are deployed by creating new releases, not rebuilding the app.

## Project Governance

Project non-negotiables live in `.specify/memory/constitution.md` (Electron security model, shell/content contract, and release semantics). When making changes to `shell/`, `forge.config.js`, or release workflows, ensure the release tag reflects the change scope (MAJOR for shell/workflow behavior changes).

## Fork Testing (End-to-End)

This project can be tested end-to-end in your fork (including GitHub Releases + Actions) without rewriting code.

### What "end-to-end" means here

- The packaged shell (`shell/`) downloads `content.json` from GitHub Releases at runtime.
- In your fork, you want the shell you built to download content from *your fork's* releases.

### Default behavior (recommended)

When you build/run from your fork, the app will default to using your fork as the content source because build scripts generate `shell/build-info.json` from your git `origin` remote.

### Override behavior (when you need it)

You can force the content source repo explicitly:

```bash
A0_LAUNCHER_GITHUB_REPO="your-user/a0-launcher" npm start
```

This is also useful when running a vendor-built executable but testing content from your fork.

### GitHub Actions in your fork

1. Enable Actions in your fork (GitHub UI: "Actions" tab).
2. To test building executables without creating a release:
   - Run the `Build Executables` workflow with `workflow_dispatch`.
   - Provide an input version like `v99.0.0`.
   - Download artifacts from the workflow run (macOS, Windows, Linux).
   - macOS signing/notarization secrets are optional for fork testing - the workflow builds unsigned mac artifacts when secrets are absent.
3. To test the full release pipeline:
   - Create a GitHub Release in your fork with a tag like `v99.0.0`.
   - `Bundle Content` uploads `content.json` to the release.
   - `Build Executables` uploads executables to the release (major changes build fresh; minor/patch reuse previous major's assets).

## Development

### Service Versions (Docker Version Management)

This repo includes a "Service Versions" screen (Docker-backed) that can install, update, switch, and roll back the backend service.

Notes:
- Requires Docker Desktop/Engine installed and running.
- Optional dev overrides:
  - `A0_BACKEND_GITHUB_REPO="owner/repo"` (override the GitHub Releases catalog source)
  - `A0_BACKEND_IMAGE_REPO="namespace/name"` (override the image repo to pull/run)
- The UI in `app/` is bundled into `content.json` by CI and downloaded at runtime. For end-to-end UI testing, publish a release with your `content.json` and run with `A0_LAUNCHER_GITHUB_REPO="your-user/a0-launcher"` (see "Fork Testing (End-to-End)").

### Prerequisites

- Node.js 20+
- npm 9+

### Setup

```bash
npm install
```

### Run in Development

```bash
npm start
```

### Local UI Content (No GitHub Releases)

By default, `npm start` loads UI content by downloading `content.json` from GitHub Releases (or from cache in offline mode).
For fast UI iteration, you can force the shell to load the local `app/` directory directly.

- `A0_LAUNCHER_USE_LOCAL_CONTENT=1`: Use the current working directory (CWD) as the repo root if it looks like an A0 Launcher checkout (must contain `app/index.html` and `package.json`).
- `A0_LAUNCHER_LOCAL_REPO=<path>`: Use a specific local repo path (absolute path, or relative to CWD). Same repo-root validation applies.

Precedence:
- If `A0_LAUNCHER_LOCAL_REPO` is set and valid, it wins.
- Otherwise if `A0_LAUNCHER_USE_LOCAL_CONTENT=1` and CWD is valid, CWD is used.
- Otherwise the shell falls back to downloading `content.json` from GitHub Releases.

Examples:

```bash
# Use the current repo checkout as UI content source
A0_LAUNCHER_USE_LOCAL_CONTENT=1 npm start

# Use a specific local checkout (absolute or relative path)
A0_LAUNCHER_LOCAL_REPO=. npm start
A0_LAUNCHER_LOCAL_REPO=/home/rafael/Workspace/Repos/rafael/a0-launcher npm start
```

### Build Executables

```bash
# All platforms (on respective OS)
npm run make

# Platform specific
npm run make:mac
npm run make:win
npm run make:linux
```

### macOS: Unsigned vs Signed Builds

For day-to-day development and fork testing, you typically want an unsigned build:

```bash
SKIP_SIGNING=1 npm run make:mac
```

Release-grade macOS builds (signed + notarized) require CI secrets:

- `MACOS_CERT_P12` (base64-encoded .p12)
- `MACOS_CERT_PASSPHRASE`
- `APPLE_ID`
- `APPLE_PASSWORD` (app-specific password)
- `APPLE_TEAM_ID`

Notes:
- If the signing secrets are not present (common in forks), GitHub Actions will still build mac artifacts unsigned.
- Notarization is enabled automatically when Apple credentials are present (or explicitly with `NOTARIZE=1`).

### macOS: Ephemeral VM Bootstrap

If you are using short-lived macOS machines and want a repeatable setup:

- **Fastest path (recommended)**: build in GitHub Actions and download the mac artifact to your VM (see "Fork Testing (End-to-End)").
- **Local build path**: run the bootstrap script from repo root:

```bash
./scripts/bootstrap-macos.sh build
```

This installs prerequisites (Homebrew + Node 20) and produces unsigned mac artifacts using `SKIP_SIGNING=1`.

## Release Process

1. Update the content in `app/` directory
2. Create a new GitHub Release with a version tag (e.g., `v1.0.0`)
3. The `bundle-content.yml` workflow automatically:
   - Bundles all files in `app/` into `content.json`
   - Uploads `content.json` to the release

When users launch the app, it will:
1. Check the latest release via GitHub API
2. Compare timestamps with locally cached content
3. Download new content if available
4. Display the content

## Project Structure

```
a0-launcher/
├── .github/workflows/     # GitHub Actions
│   ├── bundle-content.yml # Bundles app/ on release
│   └── build.yml          # Builds executables
├── app/                   # Source content (bundled on release, NOT in executable)
│   └── index.html
├── shell/                 # Electron shell (packaged)
│   ├── assets/           # Icons and entitlements
│   ├── main.js           # Main process
│   ├── preload.js        # Context bridge
│   └── loading.html      # Loading screen
├── forge.config.js       # Electron Forge config
└── package.json
```

## License

MIT
