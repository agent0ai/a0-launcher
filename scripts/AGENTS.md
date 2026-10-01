# AGENTS

## Purpose

`scripts/` owns small developer and build helper scripts.

Scripts should be deterministic, easy to run from Linux, and conservative about side effects.

## Ownership

This scope owns:

- `write-build-info.js`: writes `shell/build-info.json` so the shell knows which GitHub repository to use for launcher content when no runtime override is set.
- `bootstrap-macos.sh`: macOS bootstrap helper for local development.
- `package-preview.js`: opt-in local preview packaging using the installed Forge packager. Run `node scripts/package-preview.js`; output is `dist/preview/`. It keeps package name/userData, labels the executable Preview, sets `a0BundledPreview`, and bundles its renderer. Quit the released Launcher first. On macOS, `A0_PREVIEW_SIGN_IDENTITY` optionally selects an existing signing identity. This neither publishes nor notarizes.

## Local Contracts

- `write-build-info.js` must not block local development if it cannot write build metadata; it should warn and let runtime fallbacks work.
- Repository resolution order for build info is environment first, then Git remote, then canonical default.
- Keep generated `shell/build-info.json` small and non-secret.
- Shell scripts should use portable POSIX/Bash patterns where practical and should not assume Windows paths.
- Do not make helper scripts mutate Git history, tags, or remotes unless the script is explicitly for release automation and documented as such.

## Work Guidance

- Prefer Node standard-library helpers for JSON and path handling.
- Keep script output concise and useful in CI logs.
- When adding a new script, add or update the corresponding package script in `package.json` only if it is a supported developer workflow.

## Verification

After script changes, run:

```bash
node --check scripts/write-build-info.js
git diff --check
```

For shell script edits, also run `bash -n` on the edited file.

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
