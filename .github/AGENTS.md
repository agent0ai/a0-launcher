# AGENTS

## Purpose

`.github/` owns repository automation for release builds and renderer content bundling.

Workflow changes can alter what users download, what the app displays as its version, and what content non-local launcher runs load.

## Ownership

This scope owns:

- `workflows/build.yml`: updater-capable executable builds for GitHub Releases and manual workflow dispatch.
- `workflows/bundle-content.yml`: `app/` static content bundling into `content.json` for GitHub Releases or manual artifacts.

## Local Contracts

- Release executable builds are driven by `v*` tag pushes or manual workflow input.
- Tags without a patch segment, such as `v1.1`, are the public release shape. They are normalized to full semver build versions such as `1.1.0` only where Electron tooling or updater comparisons require it; public release asset names keep the shorter `1.1` version.
- Build jobs pass `A0_LAUNCHER_APP_VERSION` and `A0_LAUNCHER_RELEASE_TAG` into the packaging scripts so generated Electron packages use the selected release version without mutating the checked-out tag.
- Keep the checked-in `package.json` version aligned with the current two-segment release line because local runs and fallback paths use it directly.
- Build every release from the tagged source. Do not relabel or reuse executable assets from older releases.
- Executable artifact names should remain predictable: `a0-launcher-<release-version>-<platform>-<arch>...`.
- Release artifacts are macOS x64/arm64 DMG plus updater ZIP, Windows x64/arm64 NSIS setup EXE, Linux x64/arm64 AppImage, and updater metadata files: `metadata-latest-windows.yml`, `metadata-latest-mac.yml`, `metadata-latest-linux.yml`, and `metadata-latest-linux-arm64.yml`.
- Do not publish Linux DEB/RPM or Windows Squirrel/NuGet artifacts unless the product decision changes.
- Content bundling checks out the release tag, walks `app/`, and uploads `content.json` to the same release. Manual dispatch with a tag also uploads to that release; manual dispatch without a tag only stores the workflow artifact.
- `content.json` file entries use `{ encoding, data }`, with `utf8` for text files and `base64` for binary assets. Keep this in sync with `/shell/main.js` content extraction.
- If a release tag is moved after publishing, manually confirm whether workflow reruns or release asset refreshes are needed; moving the ref alone does not guarantee all old assets were rebuilt.

## Work Guidance

- Keep workflow permissions as narrow as practical.
- Preserve separate executable-build and content-bundle workflows unless a task explicitly asks to merge them.
- Do not add secrets to logs or generated artifacts.
- Use repository variables and explicit workflow inputs over hardcoded forks when a workflow must support forks.
- When version or tag semantics change, update `/AGENTS.md` and this file in the same session.

## Verification

Workflow YAML has no local test contract. For small edits, run:

```bash
git diff --check
```

For release-affecting edits, inspect the relevant workflow path and document any manual GitHub Actions verification in the final response.

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
