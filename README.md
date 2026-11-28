# Journalinator

A shared corkboard journal for Foundry VTT v14, with per-user private canvases, note cards, pins and threads. English and Russian interfaces are included.

## Development status

Current release: **0.10.0**. Implemented features can still have bugs; historical verification is not a guarantee of current behavior. See [CHANGELOG.md](CHANGELOG.md) for release history.

For code-level appearance changes, read [the styling guide](docs/STYLING-GUIDE.md). It maps persisted settings, the theme API, current CSS consumers and dormant scene-color support. Completed implementation handouts have been removed; their history remains in Git.

## Implemented note system

- **One Markdown body per note.** The first-line H1 is the visible title. Later H1s render as H2. Foundry's required page name is a hidden stable ID-based value, not a user-facing note name. Empty and duplicate titles are allowed.
- **Plain and Profile layouts.** Plain derives scrap/document presentation from the presence or absence of a title. Profile is explicitly selected and requires a first-line title, an optional underline, a portrait image and an optional `## Caption`; an incomplete Profile falls back to Plain in read mode and shows one editor-only hint.
- **Skins.** Cream, Amber and Parchment papers, four bundled fonts, torn edges and decorative background images. Tilt is seeded from the note ID, so it is stable across clients and reloads. Layout and skin changes never rewrite body text.
- **In-place editing.** The card itself becomes one continuous Markdown source surface. Title, Divider and Portrait tools, native undo/redo, copy/paste and IME stay on the same paper. The title marker is muted but editable. There is no separate panel, paragraph widget or rich-text document model.
- **Autosave and live viewing.** Edits save automatically and other viewers see the rendered text update. The status row reports `Saved`, `Saving…`, offline, recovery-storage and failure states. Unsaved text is kept in a local browser draft and can be compared or recovered.
- **Whole-note GM-mediated leases.** One editor owns a note at a time. Other clients can read it but cannot mutate, drag, resize, restyle or delete it. The GM can force-unlock after an explicit confirmation. A missing GM leaves shared notes read-only.
- **History and recovery.** Each note keeps up to 20 distinct text snapshots with a session-start checkpoint, periodic checkpoints and a mandatory pre-restore checkpoint. The history dialog previews versions and restores text only; geometry, pins, appearance and threads are not restored. Local recovery drafts are author-local.
- **Private canvas.** Each user has an owner-scoped private workspace using the same creation, layout, skin, editor, history and trash controls. Private editing uses a local per-note tab lock plus the workspace revision guard instead of a GM lease. Private previews, drafts and history are never broadcast to the shared canvas.
- **Activity foundation.** Shared saves record deduplicated activity counters in the existing hidden journal page. There is no statistics screen or ranking UI, and private writing never enters shared activity.
- **Preserved board mechanics.** Board backgrounds, pins, free-pin selection and transfer, thread rendering and route-note operations remain. Note sizing is automatic by default, with manual resize, vertical growth and a fixed main pin.

## Clean break

This build reads exactly one stored format (schema v2). There is no migration, no legacy adapter and no compatibility mode. The GM vault and secret notes, Location notes, actor linking, the old block/paragraph editor, typed `[[wikilinks]]`, and the statistics UI are removed.

An older or corrupt shared journal shows a read-only notice in the Journalinator window; an older private workspace shows its own read-only notice. Existing data is not changed, overwritten or reset automatically. Use a fresh test world or ask the host to reset Journalinator data. Resetting the party's real data remains an owner action outside the module.

## Install the released version

Use Foundry's Add-on Modules installer with this manifest:

```text
https://github.com/nmorozov539-wq/Journalinator/releases/latest/download/module.json
```

For manual installation, extract the release's `fvtt-journalinator` folder into `<Foundry data>/Data/modules/`. Enable it in the world and open Journalinator from its scene-control button. Foundry loads the module directly; no build is required. See [CHANGELOG.md](CHANGELOG.md) for release history.

Use a separate checkout for development; the local canonical checkout may be linked to a live Foundry installation.

## Private canvases

Private canvases are isolated through application UI and Foundry document ownership, not encryption. The shared canvas must never include private content, and private work is not a live shared document. [The private workspace reference](docs/PRIVATE-WORKSPACES.md) records the implemented boundary.

## Development

```sh
npm install
npm test
npm run check
```

`npm test` runs the Node and jsdom suites. The UI tests use a fake Foundry harness, not a live server. Do not reuse historical test counts as current results or mistake mocked tests for visual/multiplayer verification. Follow the scope and testing limits of the active task.

| Area | Path |
| --- | --- |
| Startup and settings | `scripts/init.mjs` |
| Document parser, renderer and text derivation | `scripts/document/` |
| In-place editor, toolbar, drafts and recovery | `scripts/editor/`, `scripts/app/editor.mjs` |
| Autosave session and edit protocol | `scripts/edit-session.mjs`, `scripts/editor/session.mjs` |
| Sizing, auto measurement and geometry | `scripts/sizing/` |
| Private workspace, sessions and history | `scripts/private/`, `scripts/app/private-workspace.mjs`, `scripts/app/private-editor.mjs` |
| Persistence, schema guard and transfers | `scripts/store/`, `scripts/socket.mjs`, `scripts/private-transfer.mjs` |
| Board, selection and app surfaces | `scripts/app/canvas.mjs`, `scripts/app/journal-app.mjs`, `scripts/app/selection-bar.mjs`, `scripts/app/history-dialog.mjs` |
| Pins, routes and threads | `scripts/board-pins.mjs`, `scripts/anchors.mjs`, `scripts/link-thread.mjs`, `scripts/route-notes.mjs` |
| Tests and localization | `tests/`, `lang/` |
| Styling data flow and theme API | [docs/STYLING-GUIDE.md](docs/STYLING-GUIDE.md) |

## License

[MIT](LICENSE).
