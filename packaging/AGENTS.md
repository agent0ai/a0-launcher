# AGENTS

## Purpose

`packaging/` owns the updater-capable desktop packaging toolchain. It mirrors the Space Agent release shape: electron-builder creates platform artifacts and update metadata, then release staging rewrites those artifacts into canonical GitHub Release asset names.

## Ownership

This scope owns:

- `package.json` and `package-lock.json`: packaging-only Electron and electron-builder dependencies.
- `release-asset-filters.yaml`: public installer asset selection before upload.
- `platforms/windows/installer.nsh`: Windows NSIS installer diagnostics, running-app shutdown hardening, and first-run launch behavior.
- `scripts/desktop-builder.js`: platform/arch packaging orchestration and electron-builder config shaping.
- `scripts/*-package.js` and `scripts/host-package.js`: local platform entry points for desktop packaging.
- `scripts/release-version.js`: `v*` tag parsing and semver normalization.
- `scripts/release-metadata*.js`: updater metadata parsing, merging, and serialization.
- `scripts/release-assets-stage.js`: canonical release asset naming, stale asset manifest generation, and updater metadata rewriting.

## Local Contracts

- Packaging dependencies are installed with:

```bash
npm install --prefix packaging
```

- The root package owns product metadata. Packaging scripts read the root `package.json` `build` config and do not carry a second product identity.
- Packaging scripts must not publish directly. GitHub Release upload is owned by `.github/workflows/build.yml`.
- Keep electron-builder at 26.15.6 or newer within v26. Earlier releases can produce NSIS app archives whose executable filters the install-time extractor silently skips, leaving Windows installs without the launcher executable and Electron runtime DLLs.
- The NSIS uninstaller removes the Launcher-owned `%APPDATA%\\a0-launcher` directory, including saved preferences, remote Instances, credentials, and cached content.
- Use `A0_LAUNCHER_APP_VERSION` and `A0_LAUNCHER_RELEASE_TAG` for CI-provided release versions. Two-segment tags such as `v1.8` are the public release shape; build them as semver `1.8.0` where tooling requires it, but stage public assets with release version `1.8`.
- Canonical public/updater asset names are:

```text
a0-launcher-<release-version>-macos-<arch>.dmg
a0-launcher-<release-version>-macos-<arch>-update.zip
a0-launcher-<release-version>-windows-<arch>.exe
a0-launcher-<release-version>-linux-<arch>.AppImage
```

- Keep metadata filenames stable for electron-updater:

```text
metadata-latest-windows.yml
metadata-latest-mac.yml
metadata-latest-linux.yml
metadata-latest-linux-arm64.yml
```

## Work Guidance

- Prefer small, deterministic Node scripts over shell-heavy release logic.
- Keep staging idempotent: generated manifests should list stale source names and exact upload files.
- Do not add signing secrets or credentials to scripts, logs, or generated metadata.
- Keep output under `dist/desktop/` or explicit caller-provided staging directories.

## Verification

After packaging-script changes, run:

```bash
node --check packaging/scripts/tooling.js
node --check packaging/scripts/release-version.js
node --check packaging/scripts/desktop-builder.js
node --check packaging/scripts/release-metadata.js
node --check packaging/scripts/release-metadata-merge.js
node --check packaging/scripts/release-assets-stage.js
node packaging/scripts/linux-package.js --dry-run --arch x64
git diff --check
```

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
