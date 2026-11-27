# Journalinator — Stylized Canvas experimental build

A local, experimental Canvas 2 presentation for the Journalinator Foundry VTT module.
This branch is **not** a production release. It has only the new canvas: no legacy renderer,
no runtime old/new switch, no old palettes/card shapes. Core data, history, locks, permissions,
private workspaces and the encrypted GM vault are preserved.

- Repository branch: `stylized-canvas`
- Module version: `0.9.4`
- Foundry: v14.367 (verified locally)
- Package: `dist/Journalinator-v0.9.4.zip` with a `fvtt-journalinator` module folder
  (built locally; matches the manifest download URL)

## What is in this build

- Universal note primitive with optional label, Markdown blocks, pictures, links, author and
  permissions. Compact/extended is derived from visible content; extended styles are Memo,
  Document and Target, plus an optional torn-edge modifier on any note.
- Procedural cork board, bundled EN/RU paper fonts, paper materials and
  primary-style pins on notes or the canvas.
- Configurable L3 waxed-linen and L6 double-strand threads: material, thickness, slack, colour,
  pattern, ends, labels, presets, and local silhouette fade on hover/edit.
- A fixed top-center default pin on each new note and freely placed movable pins on notes or
  the canvas. Existing anchor-linked connections remain readable.
- Route a note through a thread (A) or explicitly split a relationship through a note (B),
  with transactional writes and undo. Typed links cannot be silently split.
- Screen-space floating contextual toolbar with cosmetic single/bulk editing.
- Theme API (`game.journalinator.themes`) and hooks remain available; the theme selector is
  visible but intentionally inactive. Existing theme ids normalize to the new materials.

## Install locally

Foundry loads the module directly from its data folder; there is no build step.

1. Copy or symlink this repository into a **test** Foundry data folder:
   ```bash
   ln -s /home/Riv/Projects/fvtt-journalinator \
     /path/to/foundry-test-data/Data/modules/fvtt-journalinator
   ```
2. Start Foundry with that isolated data root, e.g.:
   ```bash
   node /home/Riv/foundry-v14/resources/app/main.mjs \
     --dataPath=/home/Riv/foundry-test-data \
     --port=30199 --world=journalinator-stylized --noupdate --noupnp
   ```
   The headless server works under system Node; the Electron client can use the same data root.
3. In the test world, enable **Journalinator** in Manage Modules, then open the Journalinator
   scene-control button.

**Do not launch a live campaign world while this branch is checked out.** The repository is
symlinked into the normal data folder on this machine; any launch of that world executes the
working tree. Use `/home/Riv/foundry-test-data` and a disposable copy. Keep a world backup before
testing migration; this branch is not a data backup.

## Test commands

```bash
npm run check        # syntax check every module script
npm test             # node --test unit/integration/jsdom suites
tools/package-stylized.sh   # build dist/Journalinator-v0.9.4.zip
```

## Experimental settings / switches

- World setting **Attachment pins** (`pinsEnabled`, default on). Turning it off hides pin UI and
  pin interactions; existing anchor data and links are preserved and still render.
- Existing theme registry/API remains; the palette selector is inert. `boardTheme` defaults to
  the new `stylized` theme.

## Known limitations / not yet validated

- **Real multiplayer Foundry UI testing is pending.** Node/jsdom tests and headless Chromium
  probes are not a substitute for a GM + players session.
- Pin/route undo is held in the active GM's memory, capped at 20, and is lost on reload/failover;
  stale undo entries are refused rather than clobbering later edits.
- Disabling a main pin on a **private** canvas with links does not redistribute; the control is
  qualified as a shared-canvas action.
- Multi-link bulk selection is not implemented (one selected link at a time). Multi-note
  cosmetic bulk is implemented.
- Route B refuses links that already have board pins/route waypoints (clear board pins from the
  link toolbar first). Splitting typed links is refused by design.
- A crash between the two page writes in the fake-Foundry split fallback can leave a partial
  split; real Foundry v14 uses a batched `updateDocuments` path.
- Migration is additive and GM-run, but it changes schema in the test world. Older production
  builds may not understand migrated data. Test on a disposable copy.
- Private transfer acceptance is best-effort, not full CAS. The importer re-reads after saving and
  re-imports once if a stale owner save overwrote the copied notes; if they are still missing the
  offer is kept and a retry error is shown. Foundry journal updates have no server-side
  last-writer guard, so a write landing after that final check can still overwrite a copy.
- Transfer inboxes cap at 20 pending offers per recipient and 5 from one sender to one recipient;
  offers older than 30 days are hidden on read and their flag keys are deleted on the next add.
- Torn card shadows use a per-card drop-shadow filter; stress-test 50–100 torn notes before
  relying on it for a large live board.
- Older archives and pre-0.9 patch notes describe earlier visuals; use the packaged artifact
  above for review. `dist/` is generated and gitignored.

## Manual review checklist (team)

Use a disposable world and try: short scraps, long Markdown, pictures, all four paper styles,
torn on/off, six pin styles, overlapping threads, hover/edit fade, pin off/on, main-pin disable +
Ctrl+Z, route-through and split, multi-select cosmetic edits, search on unlabelled notes, private
canvas, GM vault notes, two players editing, and 50–100 notes / 100–200 links.

Record pass/fail and reproduction steps; do not remove experimental options before team review.

## Verification performed for this build

- `npm run check` — pass.
- `npm test` — unit, integration, fake-Foundry, and jsdom UI suites pass for 0.9.4.
- Isolated Foundry **14.367** control-mode smoke (2026-11-26, `/home/Riv/foundry-test-data`,
  disposable `journalinator-stylized` world on port 30199, Playwright/Chromium):
  - module **0.9.1** active; initial left control was `tokens`;
  - clicking the Journalinator scene control opened exactly one app (`#journalinator-app`) and the
    control became `journalinator`;
  - closing via the real window-header close button detached the app, returned the control to
    `tokens` (`aria-pressed="true"`), and left no rendered instance;
  - clicking **Walls** afterwards left the control on `walls` with no Journalinator app open — it
    did not reopen;
  - clicking Journalinator again opened one fresh app.
  - no Journalinator page/console errors. The disposable PF2e world emitted unrelated PF2e/FVTT
    data-preparation errors; the only 404 was an `xdy-pf2e-workbench` icon. Neither involved this
    module.
- Headless Chromium probes from 0.9.0 still cover cork/fonts/rules, pin hit areas at zoom 0.5/2,
  thread layers/fade, route chooser, popover clamping and no layout shift.
- Production campaign world was not launched or modified. Multi-user, GM/player permission
  boundaries and live migration of a real campaign world remain **pending manual testing**.

The current package checksum is generated in `dist/Journalinator-v0.9.4.zip.sha256`.
