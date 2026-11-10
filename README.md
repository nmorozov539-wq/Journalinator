# Journalinator

**A shared, Obsidian-style corkboard journal for Foundry VTT v14.**

[![Foundry VTT](https://img.shields.io/badge/Foundry_VTT-v14-informational)](https://foundryvtt.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Tests](https://github.com/nmorozov539-wq/Journalinator/actions/workflows/test.yml/badge.svg)](https://github.com/nmorozov539-wq/Journalinator/actions/workflows/test.yml)

Journalinator turns a campaign's notes into one shared canvas. Every note is a card; cards are
connected with curvy links, edited paragraph by paragraph with live locks, and searched from a
quick switcher. The GM also gets an encrypted tier for secrets that players never receive in
readable form.

> **Status: pre-alpha (0.1.0).** The data paths and UI are covered by tests, but the GM tier has
> not yet been exercised in a live Foundry session. Back up your world before trying it.

## Features

- **One shared canvas.** Notes are cards; there is no separate drawer or unplaced state.
- **Obsidian-ish editing.** Click a paragraph to edit it; blank line + Enter splits, Backspace at
  the start merges. Unsaved text survives reloads as a local draft.
- **Per-paragraph locks.** The active GM arbitrates edits, so two people cannot write the same
  paragraph at once. Different paragraphs can be edited simultaneously.
- **Links.** Drag from a card's link handle, or type `[[Note]]` / `[[Note|label]]`. Links carry a
  label, direction, color, and solid/dashed style; backlinks appear in the editor.
- **Three card styles.** Sticky note, document, and torn paper, with optional images, resizing,
  and a stored tilt.
- **Finding things.** Quick switcher (Ctrl/Cmd+K), search dimming, and author/style filters.
- **Safety.** Trash with restore for everyone and permanent empty for the GM only.
- **Contribution stats.** Per-note authors and character counts, plus journal-wide activity.
- **Encrypted GM tier.** Secret notes, hidden blocks and links, GM labels, declassification,
  hints, and a player-view preview. Players receive only ciphertext.
- **English and Russian UI.** Follows each client's Foundry language setting.

## Install

The module id is `fvtt-journalinator` and it targets Foundry VTT v14. There is no build step.

### From Foundry (manifest URL)

1. Open **Add-on Modules → Install Module** in Foundry.
2. Paste this URL into **Manifest URL**:

   ```text
   https://github.com/nmorozov539-wq/Journalinator/releases/latest/download/module.json
   ```

3. Install, enable the module in your world, then open it from the sticky-note button in the
   scene controls.

### Manual install

1. Download `fvtt-journalinator-v0.1.0.zip` from the latest GitHub release.
2. Copy the project into `<Foundry user data>/Data/modules/fvtt-journalinator` so that
   `module.json` is directly inside that folder.
3. Restart Foundry and enable **Journalinator** in the world.

The release contains both the Foundry manifest and a ready-to-install ZIP.

## Using it

Open the journal from the sticky-note button in the scene controls.

- **New note:** double-click empty canvas, or use **+ New Note**.
- **Edit:** click a paragraph. A blank line + Enter splits it; Backspace at the start merges it
  into the paragraph above.
- **Link:** drag from a card's round link handle to another card, or type `[[Another Note]]`.
  Unknown titles become new notes on the canvas.
- **Find:** Ctrl/Cmd+K opens the quick switcher; typing a title that does not exist offers to
  create it.
- **Trash:** anyone can delete and restore notes; only the GM can empty the trash.

Players hold Observer permission. Every change is applied by the active GM's client, so
**while no GM is connected the journal is read-only**.

## GM secrets

GMs (and Assistant GMs, unless the world setting turns that off) get extra controls in the top
bar.

1. Click **Set up secrets** and choose a mode:
   - **Passphrase (recommended).** The vault is encrypted with a key only your passphrase
     opens. Players receive the ciphertext but cannot read it. Use something long, like four or
     five random words: a player can copy the vault and try guesses offline.
   - **No passphrase.** Still encrypted, but the key is stored beside it, so a player with the
     browser console can read everything. This only stops casual peeking.
2. Write secret things:
   - **+ Secret Note** (or Alt + double-click the canvas). Secret titles get a `GM-XXXX` prefix.
   - **+ Hidden block** in any shared note, or hover a paragraph and click **+**.
   - **Hide** on a shared paragraph or link moves it into the vault.
   - **+ GM Label**, and any link touching a secret note, are GM-only.
3. Reveal things as players discover them:
   - **Reveal** publishes a hidden paragraph in the same position.
   - **Declassify…** publishes a secret note under a public title.
   - **Reveal** publishes a GM-only link between two shared notes.
4. **Mark as hint** (notes) and **✦** (links) show players a gold "from the GM" marker.

**GM view / Player view** switches between your merged view and exactly what players see.

### What players can and cannot learn

Players never receive hidden text, secret titles or ids, or hidden links in readable form. Their
notes simply do not contain the hidden parts, so there are no gaps or length hints.

They *can* see that the encrypted vault changed and roughly how big it is, in power-of-two
steps (16 KB, 32 KB, ...). Images on secret notes are ordinary server files: the vault hides
which image a note uses, not the file itself.

Changing the passphrase, or switching modes, creates a brand-new key; old passphrases stop
working. **If you forget the passphrase and no browser remembers it, the secrets are gone.**

## Collaboration model

- Players are Foundry **Observers**: they read through normal document sync and never write
  world data.
- The active GM's client validates and applies every change. It serializes writes so concurrent
  edits cannot clobber whole-array fields.
- Block locks are ephemeral GM memory, renewed by a heartbeat. If the active GM disconnects, the
  next GM takes over and clients convert in-progress edits into drafts.
- With no GM online, the UI is read-only but still readable.

## Languages

The interface follows Foundry's client language. English and Russian ship in `lang/`; add a
language file there and register it in `module.json` to extend it.

## Compatibility

- Foundry VTT **v14** (API target; see the status note above).
- System-agnostic; built for a PF2e table.
- No dependencies on other modules.

## Current limitations

- Pre-alpha. The GM tier is covered by Node tests against a fake Foundry but has not been run in
  a real session yet.
- Notes are rendered as plain text; basic markdown rendering is still on the roadmap.
- The editor panel is fixed-width; a fullscreen reading mode is not implemented yet.
- The module stores notes as its own `JournalEntryPage` sub-types. Deactivating the module hides
  those pages until it is enabled again; the data is not lost.
- The module is not listed in Foundry's public package directory yet; install it with the manifest URL above.

## Development

No build step: Foundry loads `scripts/init.mjs` and `styles/journal.css` directly.

```sh
node --test tests/*.test.mjs   # data-path tests, no dependencies
npm install && npm test        # also runs the jsdom UI smoke test
npm run check                  # node --check over every script
```

Layout:

| Area | Path |
| --- | --- |
| Module entry, hooks, scene control | `scripts/init.mjs` |
| Fullscreen app shell, top bar, switcher, trash, stats | `scripts/app/journal-app.mjs` |
| Canvas, cards, labels, links | `scripts/app/canvas.mjs` |
| Block editor, locks, drafts | `scripts/app/editor.mjs` |
| Socket protocol, GM write path | `scripts/socket.mjs` |
| Lock state machine | `scripts/locks.mjs` |
| Storage containers and read layer | `scripts/store/` |
| GM vault and secret actions | `scripts/secrets/` |
| Localization | `scripts/i18n.mjs`, `lang/` |
| Tests | `tests/` |
| Design spec | `Foundry VTT Collaborative Notes Canvas Module Spec.md` |
| Architecture and testing checklist | `HANDOFF.md` |

## Branches

- **`main`** — Journalinator, the active module (`fvtt-journalinator`, v0.1.0).
- **`investigation-board`** — an earlier, independent realization of the same design, originally
  built by Larkar. It is a separate Foundry module
  (`investigation-board`, 0.3.0-alpha.1), kept for reference. It does
  not include the encrypted GM tier. Its history is unrelated to `main`; do not merge the two.

## License

[MIT](LICENSE).
