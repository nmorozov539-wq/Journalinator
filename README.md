# Journalinator

**A shared, Obsidian-style corkboard journal for Foundry VTT v14.**

[![Foundry VTT](https://img.shields.io/badge/Foundry_VTT-v14-informational)](https://foundryvtt.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Tests](https://github.com/nmorozov539-wq/Journalinator/actions/workflows/test.yml/badge.svg)](https://github.com/nmorozov539-wq/Journalinator/actions/workflows/test.yml)

Journalinator turns a campaign's notes into one shared canvas. Every note is a card; cards are
connected with curvy links, edited paragraph by paragraph with live locks, and searched from a
quick switcher. The GM also gets an encrypted tier for secrets that players never receive in
readable form.

> **Status: pre-alpha.** The data paths and UI are covered by tests, but the GM tier has
> not yet been exercised in a live Foundry session. Back up your world before trying it.

See [CHANGELOG.md](CHANGELOG.md) for recent changes.

## Features

- **One shared canvas.** Notes are cards; there is no separate drawer or unplaced state.
- **Private canvas.** Each player profile gets an isolated personal workspace with the same
  note types, labels, links, styles, stats, and trash controls as the main board. Notes can be
  copied between the private and shared canvases with Ctrl/Cmd+C and Ctrl/Cmd+V.
- **Obsidian-ish editing.** Click a paragraph to edit it; blank line + Enter splits, Backspace at
  the start merges. Unsaved text survives reloads as a local draft.
- **Markdown.** Headings, emphasis, lists, task checkboxes, tables, quotes, code, and links render
  in the editor and on cards. Typing `()` or a second `*` closes the pair automatically.
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

1. Download the `Journalinator-v*.zip` release archive.
2. Copy the project into `<Foundry user data>/Data/modules/fvtt-journalinator` so that
   `module.json` is directly inside that folder.
3. Restart Foundry and enable **Journalinator** in the world.

The release contains both the Foundry manifest and a ready-to-install ZIP.

## Using it

Open the journal from the sticky-note button in the scene controls.

- **Add things:** right-click the canvas and choose a note, location or label.
- **Select:** left-click a card, or drag a selection rectangle across several cards.
- **Stamps:** right-click a note to choose a color, corner, and seal. Choosing a new seal replaces the current one. Right-click an existing seal to move it to another corner, change its color, or remove it. For a movable stamp, right-click the board and choose **Place a stamp**. Stamps placed on secret notes stay private.
- **Themes:** Classic, Warm, Parchment, **From scene**, and any themes other modules register. A theme can restyle the board background, every note type's surface and typography, and all shared colors. Your choice is saved for your client.
- **Connection sockets:** right-click a card and open **Connection sockets** to pick a single side or toggle additional sides. Drag from a socket to another card's edge to snap a new link to that side. The destination socket appears automatically and is shared by links on that side.
- **Images:** the Target portrait and every card background accept either an external image URL or a file from Foundry's data folder. Use **Browse…** in the image dialog to pick one from the file picker.
- **Target card:** create one from the board menu or change an existing card's style to Target. Paste an image URL or pick a file from the Foundry data folder for the portrait. The title is the name and the body is the description. Cards grow to fit the full text.
- **Memo:** choose Memo in the board menu for the widest card. Only the body is shown on the board.
- **Text labels:** click to select or drag a selection box around several. Double-click a label to edit it. Double-click empty board space to open the creation menu at the cursor.
- **Delete / undo:** select notes, a label, or a stamp and press `Backspace`. Shared notes go to the trash and can be restored with `Ctrl+Z` (`Cmd+Z` on macOS).
- **Move around:** hold the middle mouse button and drag; use the wheel to zoom.
- **Edit:** double-click a card to start writing immediately, or click a paragraph in the editor.
  A blank line + Enter splits it; Backspace at the start merges it
  into the paragraph above.
- **Link:** drag from any of the four always-visible connection handles to another card, or type
  `[[Another Note]]`. Connections follow the nearest card sides while a card is dragged. Double-click
  a connection to remove it.
  Unknown titles become new notes on the canvas.
- **Find:** Ctrl/Cmd+K opens the quick switcher; typing a title that does not exist offers to
  create it.
- **Trash:** anyone can delete and restore notes; only the GM can empty the trash.

Players hold Observer permission. Every change is applied by the active GM's client, so
**while no GM is connected the journal is read-only**.

## Themes

Themes are declarative token sets, not stylesheets. Note types (sticky, document, torn, target,
memo) keep their structure; a theme changes their surface, frame, shadow, and typography, plus the
board background and the shared colour roles.

The top bar's palette menu lists the built-ins and every registered theme. Three ship today:
**Classic** (the original look), **Warm** (the fantasy palette), and **Parchment** (a light,
printed-paper theme that proves the palette is not hardcoded). **From scene** derives a theme
from the active scene's background.

### From scene

Selecting **From scene** reads the current scene background and builds a theme from it:

1. The image is drawn to a 64×64 canvas and sampled as OKLab pixels.
2. Six perceptual clusters are found by k-means (deterministic seeding, so the same scene gives
   the same palette).
3. Roles are picked for scenes rather than wallpapers: the dominant neutral becomes `bg`/`panel`
   at a clamped lightness and low chroma; the most vivid sufficiently-common cluster becomes the
   accent; a second vivid hue becomes the link thread; text, muted and line are contrast-corrected
   against the panel (7:1, 4.5:1 and a subtle 1.35:1 respectively).
4. Dark or light mode follows the dominant area, with the overall mean as a tie-breaker, so a
   snow map gets a light board and a crypt gets a dark one.
5. GM teal, hint gold and danger red keep their meaning instead of being recolored by the image.

The result is cached per scene + image path. It follows the active scene while selected
(`canvasReady` / background updates), and falls back to **Classic** when the image cannot be
read — for example a remote/S3 asset served without CORS headers. A scene with only a background
colour still produces a usable monochrome theme.

The extraction logic lives in `scripts/scene-palette.mjs`; `SCENE_PROFILE` at the top holds the
scene-specific tunables (sample size, cluster count, light threshold, contrast targets).

#### Registering a theme

```js
game.journalinator.themes.register("moody", {
  colors: { acc: "#c98b5a", thread: "#8b4a55", gm: "#7fae9b", hint: "#d9a35c" },
  board: {
    color: "#141210", pattern: "grid", patternSize: 32, patternOpacity: 0.35, vignette: 0.3,
    // Optional: a path inside Foundry's data folder (no remote URLs).
    image: "modules/fvtt-journalinator/assets/cork.webp", imageOpacity: 0.45, imageSize: "cover"
  },
  type: { uiFont: "system", titleFont: "serif", bodyFont: "serif", bodySize: 12 },
  styles: {
    sticky: { surface: "#3a2f24", radius: 2, shadow: "paper", stripe: 0 },
    document: { surface: "#2a2420", edge: "#4a3a2c", edgeWidth: 1, ruleWidth: 1 },
    torn: { surface: "#332a20" },
    wanted: { surface: "#2a2420", type: { align: "center" } },
    memo: { surface: "#2a2420" }
  }
});
```

Details:

- Colour values are literal CSS colours or references to another role (`"panel"`, `"text"`,
  `"acc"`, …), so overriding `text` repaints everything that defaults to it.
- A theme is a diff against Classic: unmentioned values, including per-style typography, fall
  back to Classic, so a short theme object is valid.
- `board.pattern` is `none`, `dots`, or `grid`. `board.imageSize` is `cover`, `contain`, or `tile`.
- Fonts are `system`, `serif`, `mono`, or `rounded`; shadows are `none`, `flat`, `paper`,
  `raised`, or `deep`; edges are `solid`, `dashed`, `dotted`, or `none`.
- Per-style `surfaceAlpha`, `imageOpacity`, `stripe` (author bar width in px), and `ruleWidth`
  control opacity and framing.
- Registrations persist in a client setting. Pass `{ persist: false }` for a session-only theme.
  `classic`, `fantasy`, and `parchment` are reserved built-in ids.
- `Hooks.on("journalinatorThemeChanged", (id, theme) => …)` fires when a theme is applied;
  `journalinatorThemeRegistered` fires when a new theme is registered; and
  `Hooks.on("journalinatorRegisterThemes", themes => …)` runs at `ready` for late registration.
- A theme's board image must be a safe relative path inside Foundry's data folder (no remote
  URLs, no `../`), and every numeric value is clamped. A theme can express a look; it cannot
  inject CSS or fetch a remote URL. This does **not** affect note images: the portrait and card
  background accept either an external `http(s)` image link or a path inside Foundry's data
  folder.

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
- Private workspaces are isolated by the interface and document ownership, not encryption. The
  host and anyone using browser developer tools can read the underlying world data.
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
| Private canvas and per-profile editor | `scripts/app/private-workspace.mjs`, `private-editor.mjs` |
| Private workspace store and admin panel | `scripts/store/private-store.mjs`, `scripts/app/private-admin.mjs` |
| Markdown rendering and task toggles | `scripts/markdown.mjs` |
| Markdown typing helpers | `scripts/markdown-edit.mjs` |
| Theme tokens, built-ins, validation, registry | `scripts/styles/themes.mjs` |
| Scene image → palette → theme | `scripts/scene-palette.mjs` |
| Note image dialog and Foundry file picker | `scripts/app/image-dialog.mjs`, `scripts/image-picker.mjs` |
| Socket protocol, GM write path | `scripts/socket.mjs` |
| Lock state machine | `scripts/locks.mjs` |
| Storage containers and read layer | `scripts/store/` |
| GM vault and secret actions | `scripts/secrets/` |
| Localization | `scripts/i18n.mjs`, `lang/` |
| Tests | `tests/` |
| Design spec | `Foundry VTT Collaborative Notes Canvas Module Spec.md` |
| Private workspace design | `PRIVATE-WORKSPACES.md` |
| Architecture and testing checklist | `HANDOFF.md` |

## Branches

- **`main`** — Journalinator, the active module (`fvtt-journalinator`, v0.8.4).
- **`investigation-board`** — an earlier, independent realization of the same design, originally
  built by Larkar. It is a separate Foundry module
  (`investigation-board`, 0.3.0-alpha.1), kept for reference. It does
  not include the encrypted GM tier. Its history is unrelated to `main`; do not merge the two.

## License

[MIT](LICENSE).
