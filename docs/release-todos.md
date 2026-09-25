# Release TODOs

Use this checklist before cutting the next launcher release.

## Next Release

- Restore and verify Windows ARM release artifacts. The build workflow must produce both:
  - `a0-launcher-<version>-windows-arm-setup.exe`
  - `a0-launcher-<version>-windows-arm.nupkg`
- Keep Windows x86 artifacts. The build workflow must also produce:
  - `a0-launcher-<version>-windows-x86-setup.exe`
  - `a0-launcher-<version>-windows-x86.nupkg`
- Keep Linux DEB artifacts only:
  - `a0-launcher-<version>-linux-arm.deb`
  - `a0-launcher-<version>-linux-x86.deb`
- Do not publish Linux RPM artifacts unless there is an explicit product decision to support RPM again.
- Keep macOS artifacts unchanged:
  - `a0-launcher-<version>-macos-arm.dmg`
  - `a0-launcher-<version>-macos-arm.zip`
  - `a0-launcher-<version>-macos-x86.dmg`
  - `a0-launcher-<version>-macos-x86.zip`
- Verify `content.json` is present and built from the release tag.
- Validate instance tabs on macOS via cloud runner or manual macOS test:
  - local `Open UI` opens a launcher tab
  - opening the same instance focuses the existing tab
  - detach opens a standalone window
  - closing the detached window does not stop the instance
- Expected asset count with Windows ARM restored and RPM omitted: 11 assets.
- Verify with:

```bash
gh release view <tag> --repo agent0ai/a0-launcher --json assets \
  --jq '[.assets[].name]'
```

## CLI Connector

- The bottom A0 CLI Connector must use the launcher-managed active instance when one is running.
- If no launcher-managed active instance exists, it must fall back to a running local Agent Zero container from the Instances inventory when that container has a local UI URL.
- The CLI connector must never pass remote, credentialed, or non-HTTP URLs to the shell terminal launcher.
- Validate against a generic running Agent Zero container such as:

```bash
docker ps --filter ancestor=agent0ai/agent-zero:latest
```

- For the known local smoke-test case, a container mapped as `127.0.0.1:32080` or `0.0.0.0:32080->80/tcp` should make the dock show:
  - `Instance socket ready`
  - `a0 --host http://127.0.0.1:32080/`

## Local Content

- `npm start` should exercise release content.
- Local UI iteration should use:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```

- `version: "dev-local"` cache metadata must not block release updates.
