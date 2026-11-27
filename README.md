# Journalinator

A shared corkboard journal for Foundry VTT v14, with per-user private canvases, note cards, pins and threads. English and Russian interfaces are included.

## Active development

This branch is `note-system-update`. Its runtime baseline is release 0.9.6; the note-system rewrite has **not yet been implemented** by this documentation change.

Start with [the note-system handover](handoff/note-system-update/README.md). It is the sole active design and implementation instruction set. [The OpenCode prompt](handoff/note-system-update/OPENCODE-PROMPT.md) defines delegated tasks, coordinator approval, commits and the initial owner approval gate.

The planned rewrite uses one Markdown body per note, in-place editing, autosave, live viewing, whole-note locks, Plain/Profile layouts and separate skins. It removes the old secret vault, Location notes, actor linking and statistics UI. These are target changes, not claims about the current runtime. There is no old-data migration requirement.

## Install the released version

Use Foundry's Add-on Modules installer with this manifest:

```text
https://github.com/nmorozov539-wq/Journalinator/releases/latest/download/module.json
```

For manual installation, extract the release's `fvtt-journalinator` folder into `<Foundry data>/Data/modules/`. Enable it in the world and open Journalinator from its scene-control button. Foundry loads the module directly; no build is required. See [CHANGELOG.md](CHANGELOG.md) for release history.

Do not install this development branch into a live world while implementing the rewrite. The local canonical checkout is already symlinked into a Foundry installation; follow the isolated-checkout instructions in the handover.

## Private canvases

Private canvases are isolated through application UI and document ownership, not encryption. Preserve existing ownership, admin, inbox and copy/publish behavior during the rewrite. [PRIVATE-WORKSPACES.md](PRIVATE-WORKSPACES.md) records the retained boundary. Removing the older encrypted vault does not turn private canvases into encrypted storage.

## Development

```sh
npm install
npm test
npm run check
```

`npm test` runs Node tests, including jsdom UI checks when declared dependencies are installed. Real Foundry multiplayer verification is also required for the rewrite. Do not reuse historical test counts as current results.

| Area | Path |
| --- | --- |
| Startup | `scripts/init.mjs` |
| Board and app | `scripts/app/canvas.mjs`, `scripts/app/journal-app.mjs` |
| Editors | `scripts/app/editor.mjs`, `scripts/app/private-editor.mjs` |
| Persistence and protocol | `scripts/store/`, `scripts/socket.mjs`, `scripts/locks.mjs` |
| Note presentation | `scripts/presentation.mjs`, `scripts/markdown.mjs`, `scripts/styles/` |
| Pins and threads | `scripts/board-pins.mjs`, `scripts/anchors.mjs`, `scripts/link-thread.mjs` |
| Tests and localization | `tests/`, `lang/` |
| Active handover | `handoff/note-system-update/` |

## License

[MIT](LICENSE).
