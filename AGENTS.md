# AGENTS.md

## Project overview

This repository contains two cooperating pieces:

- A VS Code extension that stores collaborative comment threads in
  `.comments/collab-comments.json`, re-anchors them as documents change, and exposes
  them through editor decorations, a tree view, and a webview discussion panel.
- A Quarto extension that can connect local HTML previews to the running VS Code
  extension or deliberately embed a read-only comment snapshot in static HTML.

The VS Code extension supports any file type. The preview bridge is intentionally
limited to QMD files in the first open workspace folder.

## Repository map

- `src/extension.ts`: activation, VS Code registrations, application state, and
  orchestration between storage, editor comments, views, and the Quarto bridge.
- `src/model.ts`: persisted data types, store parsing, and tracked-change merging.
- `src/repository.ts`: conflict-aware persistence for the comment store.
- `src/anchors.ts`: range transforms and resilient text re-anchoring.
- `src/quartoMapping.ts`: conservative rendered-selection-to-QMD mapping.
- `src/quartoBridge.ts`: authenticated loopback HTTP bridge and temporary descriptor.
- `src/panelProtocol.ts`: validation for messages received from the webview.
- `src/webviewSurface.ts`: VS Code host for the Discussion webview.
- `src/highlight.ts`: pure helpers for editor/panel highlighting and scroll sync.
- `media/review.js` and `media/review.css`: authored Discussion webview client assets.
- `_extensions/collab-comments/`: authored Quarto Lua filter and browser assets.
- `tests/quarto/verify.sh`: end-to-end Quarto rendering and security smoke checks.
- `example.qmd` and `demo-long.qmd`: manual/demo documents; their HTML and support
  directories are rendered artifacts checked into the repository.

`dist/` and `out/` are generated and ignored. Change sources, not files in those
directories. Do not refresh checked-in demo HTML unless the task specifically calls
for it.

## Setup and commands

Use the package-lock file and install dependencies with `npm ci`.

- `npm run compile`: bundle the extension to `dist/extension.js`.
- `npm run watch`: rebuild the extension while developing; press `F5` in VS Code to
  launch the Extension Development Host.
- `npm run lint`: lint TypeScript under `src/`.
- `npm test`: compile, bundle, lint, and run all Node tests.
- `npm run test:quarto`: run Quarto integration checks. This requires Quarto 1.4+
  and should be run when changing the Quarto filter/assets, bridge discovery,
  export behaviour, or related configuration.
- `npm run package`: create the minified production bundle used for publishing.

For a focused TypeScript test, compile tests first and then run the emitted file,
for example:

```bash
npm run compile-tests
node --test out/anchors.test.js
```

## Development conventions

- Keep TypeScript strict and consistent with the existing style: two-space
  indentation, single quotes, semicolons, and trailing commas only where already
  idiomatic.
- Keep pure domain logic out of `extension.ts` when it can live in a focused module
  and be tested without the VS Code runtime.
- Place TypeScript tests beside their source as `src/*.test.ts`. Use `node:test` and
  `node:assert/strict`; add a regression test for behaviour changes and boundary
  cases.
- Treat all persisted JSON, browser requests, and webview messages as untrusted.
  Validate at the boundary before changing state.
- Preserve the existing `CommentStore` schema unless the task includes a compatible
  migration. Missing optional legacy fields must continue to load safely.
- Keep user-visible commands, configuration keys, view IDs, and activation metadata
  synchronized with `package.json` and the code that registers or consumes them.
- Update `README.md` when changing user-visible behaviour, configuration, storage,
  setup, or security expectations.

## Behaviour and security invariants

- Never overwrite an externally edited comment store. Repository writes must remain
  conflict-aware, and an empty store must remove the JSON file and its now-empty
  `.comments` directory.
- Re-anchoring may use stored text and context, but it must not silently jump to an
  unrelated repeated match. Ambiguous rendered selections must be rejected rather
  than guessed.
- The preview bridge must stay bound to `127.0.0.1`, require its short-lived bearer
  capability, accept only QMD paths inside the workspace, and refuse unsafe writes
  for dirty, stale, or conflicted state.
- Temporary bridge descriptors and their directory are a security boundary. Preserve
  expiry checks, ownership/permission checks, endpoint validation, and cleanup.
- Static Quarto output must remain comment-free by default. Export is opt-in, must
  remain read-only, and must safely encode untrusted comment content.
- Keep webview CSP restrictions intact. Render user-controlled text as text, not
  executable markup, and route incoming messages through `parsePanelRequest`.

## Verification expectations

Run the narrowest relevant checks while iterating, then before handing off:

- TypeScript-only changes: `npm test`.
- Quarto-only changes: `npm run test:quarto` plus `npm test` if shared contracts or
  TypeScript bridge code changed.
- Manifest or packaging changes: `npm test` and `npm run package`.
- UI changes: run `npm test`, then inspect the affected view in the Extension
  Development Host; exercise both resolved and unresolved threads where applicable.

Do not discard unrelated working-tree changes. Keep edits scoped to the request and
report any verification that could not be run because an external tool is missing.
