# AGENTS

## Purpose

`.github/` owns repository automation for release builds and renderer content
bundling.

Workflow changes can alter what users download, what the app displays as its
version, and what content non-local launcher runs load.

## Ownership

This scope owns:

- `workflows/build.yml`: executable builds for GitHub Releases and manual
  workflow dispatch.
- `workflows/bundle-content.yml`: `app/` static content bundling into
  `content.json` for GitHub Releases or manual artifacts.

## Release Contracts

- Release builds are driven by `v*` tags or manual workflow input.
- Tags without a patch segment, such as `v0.1`, are normalized to full semver
  build versions such as `0.1.0`.
- Build jobs call `npm version <version> --no-git-tag-version --allow-same-version`
  so generated Electron packages use the selected release version.
- Keep the checked-in `package.json` version aligned with the current release
  line because local runs and fallback paths use it directly.
- Build every release from the tagged source. Do not relabel or reuse executable
  assets from older releases.
- Executable artifact names should remain predictable:
  `a0-launcher-<version>-<platform>-<arch>...`.
- Release artifacts are macOS DMG/ZIP for arm and x86, Windows x86 Squirrel
  setup/NuGet packages, and Linux DEB packages for arm and x86. Do not publish
  Linux RPMs unless the product decision changes.
- Content bundling checks out the release tag, walks `app/`, and uploads
  `content.json` to the same release.
- `content.json` file entries use `{ encoding, data }`, with `utf8` for text
  files and `base64` for binary assets. Keep this in sync with
  `/shell/main.js` content extraction.
- If a release tag is moved after publishing, manually confirm whether workflow
  reruns or release asset refreshes are needed; moving the ref alone does not
  guarantee all old assets were rebuilt.

## Development Guidance

- Keep workflow permissions as narrow as practical.
- Preserve separate executable-build and content-bundle workflows unless a task
  explicitly asks to merge them.
- Do not add secrets to logs or generated artifacts.
- Use repository variables and explicit workflow inputs over hardcoded forks when
  a workflow must support forks.
- When version or tag semantics change, update `/AGENTS.md` and this file in the
  same session.

## Testing

Workflow YAML has no local test contract. For small edits, run:

```bash
git diff --check
```

For release-affecting edits, inspect the relevant workflow path and document any
manual GitHub Actions verification in the final response.
