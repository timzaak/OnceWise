# OnceWise AI Extension (Chrome MV3)

A Chrome extension built with WXT + React: clicking the toolbar icon opens the flow workbench sidepanel, plus the extension's import/management page (`entrypoints/import/`), a content-script runtime injected dynamically per the flow's site, and the "Sync" tab.

- Layout: `entrypoints/` (background / content / sidepanel / import), `lib/` (about 29 modules in the flow-* / import-* / sync-* prefix families), `test-pages/` (controlled test pages, see their README)
- `tests/`: Vitest unit tests, named as a near 1:1 mirror of `lib/` (cross-module tests self-describe the surface under test in a file-header comment; story-level acceptance belongs to the demo e2e under `demo/e2e/extension/` — unit tests do not map back to stories)
- Build: `npm run build` (production build → `.output/chrome-mv3`); dev: `npm run dev`
- Test and demo run instructions are maintained centrally in the repo-root [scripts/index.md](../scripts/index.md); this file does not duplicate those commands
