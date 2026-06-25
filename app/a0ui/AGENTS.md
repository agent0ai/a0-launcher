# AGENTS

## Purpose

`app/a0ui/` owns the portable Agent Zero UI primitives bundled with the
launcher.

This subtree should feel like shared framework infrastructure, not a dumping
ground for launcher-specific behavior.

## Ownership

This scope owns:

- `index.css`: base Agent Zero visual language.
- `css/buttons.css` and `css/modals.css`: shared button and modal primitives.
- `js/initFw.js`: frontend framework bootstrap.
- `js/components.js`: `<x-component>` loading.
- `js/AlpineStore.js`, `js/initializer.js`, `js/modals.js`, `js/confirmClick.js`,
  `js/device.js`, `js/sleep.js`, and `js/shortcuts.js`: shared client helpers.
- `vendor/`: locally bundled third-party assets, fonts, Alpine, Ace, and Material
  Symbols.
  - `vendor/cytoscape/`: Cytoscape.js 3.34.0 UMD bundle and MIT license copied
    from the npm package for the Docker Manager Topology tab.

## Local Contracts

- Keep this subtree network-independent. Do not add remote fonts, remote icon
  kits, CDN scripts, or runtime asset fetches.
- Keep launcher-specific Docker Manager state, copy, and behavior outside
  `app/a0ui`; use `app/docker_manager.js`, `app/docker_manager.css`, or component
  files instead.
- `<x-component>` paths are app-relative static paths. Component loading must
  remain deterministic and compatible with both local-content mode and unpacked
  `content.json` mode.
- Vendor files should be treated as bundled artifacts. Edit them only when the
  task is explicitly to update or repair the vendored dependency, and document
  the source/update path in the change.
- Shared primitives should stay conservative. A portable helper belongs here
  only when it is useful beyond one launcher component.

## Work Guidance

- Prefer adding a launcher-local class in `app/docker_manager.css` before
  changing shared visual primitives.
- Preserve existing framework globals and load order unless the task is
  explicitly to change framework bootstrap.
- Keep this scope safe for static release bundling; avoid filesystem or
  environment assumptions.

## Verification

After framework changes, run:

```bash
node --check app/docker_manager.js
git diff --check
```

Then launch with local content and verify component loading still works:

```bash
A0_LAUNCHER_LOCAL_REPO=/home/eclypso/a0/a0-launcher npm start
```

## Child DOX Index

No child `AGENTS.md` files exist in this scope.
