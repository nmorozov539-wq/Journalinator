# Foundry VTT Collaborative Notes Canvas: Module Spec

*Working title: TBD. Target: Foundry VTT v14, system-agnostic (built for a PF2e table). Status: design draft v0.3. Storage and behavior settled; visuals settled through the HTML demo, which is the visual reference for the coding agent.*

## 1. Vision

A fullscreen, Obsidian-flavored shared journal for a tabletop group. Players and the GM write **notes**, place them on a single **canvas**, and connect them with curvy **links**, like a detective's corkboard. It exists to solve one problem: narrative and mystery campaigns are hard to follow without collective note-taking.

The goal is collective effort. Everyone can read and edit everything, authorship is visible, and the journal rewards contribution (an MVP board) rather than individual ownership.

## 2. Guiding principles

- **Notes are the source of truth.** The canvas only draws what notes contain. Nothing important lives only on the canvas, except free text labels and card positions.
- **One canvas, one journal.** No multiple boards in v1. Simplicity over flexibility.
- **Shared and open by default.** Everyone sees and edits everything, with a GM-only tier added later.
- **Safe by design.** Block locks, a trash bin, and per-note version snapshots (stored from v1, UI later) protect against misclicks and conflicts.
- **Built for bad netcode.** Players may be at 200 ms ping and Foundry's sockets are unreliable. No live cursors or live drag streaming. Updates are sent when an action starts or finishes.
- **Fast capture during live play.** Creating a note and connecting it must take seconds (see 8.2).
- **The GM is the single writer.** Players never write world data directly; the GM client applies every change. This is enforced by Foundry permissions, not by convention (see 5).
- **Styling is the soul.** Notes look like physical objects on a table. The style system must be extensible.

## 3. Scope

**In scope for v1:** notes, markdown editing, block locking, one canvas, drawn and typed links, three note styles with optional images, resizable and tilted cards, free text labels, a quick switcher with author and style filters, trash bin, per-note snapshots (stored, no UI), per-note contribution stats, journal-wide stats, and a fullscreen layout with a resizable editor panel.

**Planned later (designed for, not built first):** GM tier with partial declassification, GM hint notes and links, custom style templates (HTML/CSS), version history UI.

**Out of scope for now:** multiple canvases, folders or a permanent note list (the canvas is the index), notes that exist off the canvas, linking to Foundry documents (actors, scenes, items), structured properties/fields, freehand drawing, frames and zones, live cursors, Obsidian vault export/import (a separate future feature).

## 4. Core concepts

### 4.1 Note

An individual document with a title, a markdown body, a style, an author, and outgoing links. Can be read as a document, and can optionally be placed on the canvas. Think of an Obsidian note.

- Every note **is on the canvas** from the moment it is created, exactly once. There is no separate pile of unplaced notes and no “remove from canvas”; deleting a note sends it to the trash (see 11).
- Notes may have an optional image, shown at the top of the card and cropped to fill the space the title and text leave. A landscape picture suits a wide, short card and a portrait picture a tall, narrow one, so resizing the card is the crop control. The image is chosen with Foundry’s file picker; the module never uploads files itself and stores only the file path.
- Cards are **resizable** (drag the corner of a selected card; double-click the corner to return to auto size) and carry a small stored **tilt** (see 4.5).
- Titles are **unique among non-deleted notes**, enforced by the GM on write.

### 4.2 Link

A connection from one note to another, stored **on the note it originates from**. Links carry:

- target note ID
- label (optional text, e.g. “works for”)
- direction: none, one-way (source to target), or two-way
- color
- line style (solid or dashed, for example dashed for “suspected”)
- origin: `drawn` or `typed`
- `edited`: true once anyone has changed the link in the toolbar (used for typed-link removal, see 6.8)
- `createdBy`: the user who created it (used for stats)

Links refer to notes by **ID**, never by title, so renaming a note never breaks links.

### 4.3 Canvas

A single shared board that holds note cards at positions, plus free text labels. Canvas layout is a **separate record** from note content, because card positions and labels do not belong inside note text.

### 4.4 Free text label

The only canvas-only element. A piece of text placed on the canvas (headings, annotations). Lives in the layout record, not in any note. Everything else on the board is a note.

### 4.5 Style

A named visual treatment applied to a note's card (and possibly its editor). v1 ships three presets:

1. **Sticky note**: small, colored, quick capture
2. **Document**: clean page-like card
3. **Torn paper**: rough-edged scrap

Styles are **named definitions in a registry**, not hardcoded branches, so adding a new style (or later, user-made HTML/CSS templates) means adding a registry entry.

**Tilt.** Sticky and torn cards sit at a slight angle, like objects on a table. The angle is a stored value on the card (`rotation` in the layout record, see 5.4), never computed per client, so everyone sees the same tilt and it does not change on reload. It is seeded randomly (about ±2.5°) when the card is created, is 0° for documents, and can later be adjusted by the user.

## 5. Storage architecture

All data lives in Foundry's world data, so it is backed up with the world and moves between hosts (VPS and PC) with it. Foundry does not let modules add new top-level document types, so the module uses `JournalEntry` documents as containers and a module-defined `JournalEntryPage` sub-type for the content.

### 5.1 Containers

Three `JournalEntry` documents, created by the GM client on first run:

1. **Shared journal.** Players: Observer. GM: Owner. Holds one `note` page per note, one `layout` page, and one `stats` page.
2. **History.** GM only. Holds per-note snapshots, which keeps the shared document light.
3. **GM secrets.** Players: None. Empty in v1, but the read layer treats it as a source from day one (see 5.7 and 14).

The containers are hidden from the normal Journal sidebar so nobody edits them by hand. Pages of our sub-type get a registered sheet that simply opens the module's fullscreen app.

### 5.2 Why players are Observers

Observer permission means players can read through Foundry's normal document sync, with live updates for free, but cannot write. Every change goes through the GM client. This makes “GM is the single writer” a real guarantee, and it means players can still read the journal when the GM is offline.

### 5.3 Note page

Stored in the page's `system` data via a `TypeDataModel` registered for the module's `note` sub-type. The page `name` is the note title and the page `_id` is the note ID.

- `style` (registry key)
- `image` (optional file path)
- `blocks`: ordered list of `{ blockId, text }`, with `blockId` from `foundry.utils.randomID()`
- `links`: list of `{ targetId, label, direction, color, lineStyle, origin, edited, createdBy }`
- `authorId`, `createdAt`, `updatedAt`
- `editCount`: number of saves (for “most edited”)
- `contributions`: map of `userId` to characters credited
- `deleted`: null, or `{ at, by, lastCard }` where `lastCard` remembers the card position for restore

Arrays are replaced whole on update, which is fine at note size because the GM serializes writes, so concurrent updates cannot clobber each other.

### 5.4 Layout page

A single page holding:

- `cards`: a **keyed object** by note ID, each `{ x, y, width?, height?, rotation }`. `width` and `height` are absent while a card is at auto size and are set once someone resizes it.
- `labels`: a keyed object by label ID, each `{ text, x, y, size, color }`
- optional viewport defaults

Cards and labels are keyed objects, not arrays, so the GM updates a single path such as `system.cards.<noteId>`. Two players dropping different cards at the same moment never overwrite each other. Removing a card uses Foundry's key-deletion update syntax.

### 5.5 Stats page

Instead of an ever-growing event log, store bounded daily buckets: `activity[YYYY-MM-DD][userId] = { chars, notes, links }`, plus optional `sessions: [{ date, label }]` for manual session markers. “Activity per session” is derived by grouping days (by date gaps, or by markers when present).

### 5.6 Snapshots

When a block lock releases and the note changed, the GM saves a snapshot of the note into the History entry, at most one per note every few minutes, as a ring buffer of about 20 per note. This answers the “failed save” worry from v1. The restore UI comes later.

### 5.7 The read layer

All reads in the app go through one `NotesStore` module, never directly to Foundry documents. For players it returns shared content only. For the GM it merges shared content with GM secrets. In v1 the secrets source is empty, but the seam exists, so the GM tier needs no refactor.

### 5.8 Known trade-off: sub-types and module deactivation

If the module is deactivated, its sub-type pages become invalid and disappear from view until it is re-enabled. The data is not lost. This is acceptable for a module that is the whole point of the world's journal, and it is documented in the module's readme.

### 5.9 Must verify before relying on this

- **Player clients never receive None-ownership documents.** The GM secrets design depends on it. Test by logging in as a player and inspecting `game.journal` and the raw data received.
- **Socket handlers receive a trustworthy sender user ID.** Authorship and stats depend on it. The sender must come from Foundry's socket layer, never from a field in the payload.
- Exact v14 APIs for the fullscreen application window, sheet registration for the sub-type, and hiding the containers from the sidebar. Read the official v14 docs rather than relying on model memory.

## 6. Notes and editing

### 6.1 Markdown

Notes use markdown (basic rendering is acceptable for v1: headings, bold, italics, lists, quotes, links). Editing is **Obsidian-ish**: clicking a block turns it into raw markdown to type in, and it renders again when you click away.

### 6.2 Edit flow

Players type locally and the block is sent **on click-away or explicit save, never per keystroke**. That is one socket message and one world write per block edit, and the contribution diff runs on that save. Unsaved text is kept as a local draft so it can be offered back after a disconnect.

### 6.3 Blocks and locking

A note body is a list of blocks (split on blank lines), each with a **stable block ID** so inserting a paragraph above does not shift locks onto the wrong text.

- Clicking a block to edit **requests a lock** on that block.
- The **first request to be accepted wins**. Everyone else sees immediately that the block is being edited, and by whom, and cannot edit it.
- Different blocks of the same note can be edited by different people at the same time.
- Adding a block, reordering, and deleting a block also go through the same arbitration.

### 6.4 Split and merge

- Pressing Enter twice splits a block into two. The first keeps the original ID and the second gets a new one.
- Backspace at the start of a block merges it into the previous block, which keeps its ID. A merge needs both locks, so it goes through normal arbitration, and the other block's lock is released.

### 6.5 Lock lifecycle

The editing client sends a heartbeat every few seconds while a lock is held. The GM expires a lock after about 20 seconds without a heartbeat. Both numbers are tunable constants. A lock also releases on save and on click-away. If a lock expires under someone whose connection dropped, their text is preserved as a local draft rather than lost.

### 6.6 Arbitration and the write path

Two players can click the same block “simultaneously” and both believe they won. To avoid this, **the active GM's client arbitrates** (`game.users.activeGM`):

1. A player clicks a block and sees an immediate local “pending” state while a lock request goes out over the module socket.
2. The GM grants or denies in order of arrival and broadcasts the lock state. Locks are **ephemeral GM-memory state**, never stored in documents, so lock traffic causes no world writes.
3. On save, the player sends the block text. The GM validates (does the sender hold the lock, is the title unique, and so on), applies the update, and credits contribution to the sender.
4. Foundry's normal document sync pushes the result to every client. The GM sends an explicit ack or denial to the requester.

If there are several GMs, only the active GM arbitrates, and arbitration fails over if they disconnect. Lock state is rebuilt empty after a failover, and clients re-request locks they still need.

**Offline GM:** players have read-only access, and the UI says so plainly.

### 6.7 Fast capture hooks

See 8.2. Note creation and link creation are write operations like any other and go through the GM.

### 6.8 Typed wikilinks

Typing `[[Baron Voss]]` or `[[Baron Voss|works for]]` in a block is a shortcut for creating a link. On save:

- The title is resolved to a note ID and a link record with `origin: typed` is created or updated.
- The link appears on the canvas like any other link.
- Links are configured through the link toolbar, not text syntax. Typed links are a convenience, and malformed ones do nothing harmful.
- Alias syntax follows Obsidian: `[[Target|label]]`.
- **Removal:** if the `[[...]]` text is deleted, the link is removed only if it is still `origin: typed` and `edited: false`. Otherwise it is kept.
- **Unresolved:** if `[[Nobody]]` matches no note, saving creates that note on the canvas beside the note being written, with the link already drawn, and a short message says so. The save is never blocked, and a note created by a typo can simply be trashed.
- **Duplicate titles** cannot exist among non-deleted notes, so resolution is unambiguous. A rename or create that would collide is denied with a clear message.

## 7. Links on the canvas

- Links are drawn by dragging from one card to another.
- Lines are **smooth curves (Bezier-style), not right-angled or rounded-corner connectors**, with an arrowhead at each end that the direction setting calls for.
- Selecting a link shows a small toolbar on the line itself with: **label, direction (none / one-way / two-way), color, line style (solid / dashed)**, and a delete button. Anyone can delete a link.
- Every note is on the canvas, so every link between live notes is drawn. Each note also shows **backlinks** (“mentioned in / linked from”) as clickable chips at the top of the editor.
- If a note is deleted, links pointing to it are **hidden, not erased**, so restoring it from the trash brings the whole web back intact.

## 8. Canvas behavior

### 8.1 Basics

- Notes are placed on the canvas **when they are created** (see 8.2) and leave it only by being deleted to the trash.
- Cards show a **title, a small excerpt of the text, and an optional image**. **Hovering** shows the full text of the note.
- Cards are **resizable** (corner handle on the selected card; double-click the handle to reset to auto size) and carry a stored **tilt** (4.5). Free text labels can be added anywhere.
- Pan and zoom. Designed for roughly **50 notes**, so heavy virtualization is not needed.
- Each player has a **color** (Foundry’s user color) used for authorship indicators (a colored edge and an initial badge on each card) and lock markers.
- Updates are sent when an action **starts or finishes**. No live drag streaming, no remote cursors. Picking up a card sets an ephemeral “held by” marker (like a lock) so two people cannot drag the same card; dropping it sends one move request.

### 8.2 Fast capture

- **Double-click empty canvas** creates a new sticky note at that spot.
- **“New linked note”** on a selected card creates a note beside it and a link from the selected card in one step.
- **Quick switcher:** typing a title that does not exist and pressing Enter creates the note on the canvas, in free space near the center of the view.
- **Typed `[[wikilinks]]`** to missing notes create them beside the note being written (6.8).
- A new note gets the sticky style and a small random tilt, is on the canvas immediately, and opens in the editor.

## 9. Layout and navigation

Fullscreen app with a top bar and two regions, so nothing is covered while the canvas is open:

- **Top bar:** the title, the **search box and quick switcher**, the preview toggle, and the stats button, with a row of **filter chips** beneath it (one per author, one per card style).
- **Center: canvas,** taking all the width the editor does not use.
- **Right: note editor.** Opens when a card is clicked or a note is picked in the switcher, and closes when nothing is selected. Its **width is adjustable by dragging its left edge** (desktop; on a phone it slides over the canvas).

There is no permanent note list: the canvas is the index (see 18).

**The editor** shows, top to bottom: the title, the **linked notes** as clickable chips, the author line, and the note as **one continuous document**. Paragraphs are plain text with no borders. A paragraph gets a box only while it is being edited (a highlight in the editor’s own color across the full width of the panel, with raw markdown in a text area) or while someone else has it locked (their color and an “is editing…” tag). An **Authors** toggle shows each paragraph’s author as a colored edge, and hovering a paragraph names its author.

A note can also be opened in **full screen** for focused reading or writing.

**Entry point:** a button in Foundry's UI (scene controls or sidebar; exact placement per the v14 docs) opens the app.

**Finding things:**

- **Quick switcher** (the search box, or Ctrl/Cmd+K): typing filters notes by title, text, and author; an empty box lists the most recent notes. Arrow keys and Enter pick one, which pans the canvas to its card and opens it. If no title matches, Enter offers to create a note with that title.
- **Dimming:** while a search or filter is active, every card and link that does not match is dimmed on the canvas.
- **Filter chips** by author and by card style combine with the search.
- **Recent** is derived from each note’s last-edited time.

## 10. Permissions

- **Anyone** can create notes, edit unlocked blocks, move and resize cards, add labels, draw and delete links, delete a note (to trash), and restore a note from the trash.
- **Only the GM** can permanently empty the trash, add session markers, and use the GM tier.
- Everything above is carried out by the GM client on the player's behalf (see 6.6). Players hold Observer permission only.

## 11. Trash

- Deleting a note moves it to the trash (`deleted` set) and removes its card from the layout, remembering the position in `deleted.lastCard`.
- **Anyone can restore** a note. It returns to its previous canvas position if that area is still free, otherwise to the nearest free spot.
- **Only the GM can permanently empty** the trash. It never empties itself.
- Restoring brings back its hidden inbound links.

## 12. Contribution stats

**Per note:** shows the creator and, per user, how many characters they added. Computed by diffing the block text before and after each save and crediting added characters to the person who saved. Block locking makes this accurate. Credit per save is **capped** (default 2,000 characters) so a pasted wall of text cannot win MVP alone.

**Journal-wide (a stats page):**

- MVP board (characters written)
- Notes created per player
- Links drawn per player
- Most-linked note
- Most-edited note (`editCount`)
- Activity per session (from the daily buckets in 5.5)

Tone: friendly, celebratory, not competitive pressure. Seeing your name as MVP of the journal is the reward.

## 13. Visual direction

The look is settled by the **HTML demo**, which is published as an artifact and is the visual reference for the coding agent. It is muted Obsidian-style: dark neutral panels, a dot-grid canvas, and **dark, muted cards** (not light paper) so the board stays calm, with one soft violet accent for selection.

- **Cards:** three dark styles. Sticky: small, desaturated tint (rose, sage, or yellow), slight tilt, soft shadow. Document: dark page with a serif title and a thin rule beneath it. Torn paper: aged brown-gray with a jagged clipped edge and a tilt. All show a title, a short excerpt in small muted text, and an optional image across the top.
- **Authorship:** each player has a muted hue (violet, teal, amber, rose): a colored edge and initial badge on cards, and an optional Authors toggle in the editor.
- **Locks:** a full-width highlight in the editor’s color on the paragraph with an “is editing…” tag, and a small pill on the card.
- **Links:** smooth Bezier curves with arrowheads, labels on a background-colored halo, dashed for “suspected”, and a toolbar on the selected link.
- **Hover preview:** the full text of the note.
- **Search:** typing dims non-matching cards and links, and the quick switcher drops down under the search box.
- **Editor panel:** a plain document with no borders, resizable by its left edge.

## 14. GM tier (later phase, design for it now)

- The GM has their own **hidden notes and canvas elements**, with the same base toolset.
- The GM can **declassify** parts of a note as players discover them (for example a character dossier revealed piece by piece).
- The GM can leave **hint notes and links** on the canvas.
- **Hard rule: hidden content is never sent to player clients.** It is not hidden by CSS or UI; the player's browser never receives it.
- **Hard rule: hiding must not leak volume.** Hidden text leaves no gaps, no redaction bars sized to the content, and no length hints. For players, hidden parts are simply absent. If a closing flourish is wanted, it is a fixed line such as “...he never actually knew what his actions led to” that does not vary with the hidden amount.

**How storage enforces this (see 5):**

- Hidden blocks, GM-only notes, and GM-only links live in the **GM secrets** entry, whose ownership is None for players. Pages there use the note schema plus anchor data (`afterBlockId`) for the GM's merged view.
- Players' notes simply never contain hidden text, so there are no gaps or length hints.
- **Declassifying is a real write into the shared note.** There is no visibility flag to flip. The GM writes the block into the shared note first, then removes it from secrets, so a failure never loses text.
- All reads go through `NotesStore` (5.7), which merges sources for the GM and returns shared-only for players.

## 15. Technical notes for the coding tool

- Target **Foundry VTT v14**. The server runs on a VPS and on a PC at different times. **Read the official v14 API documentation rather than relying on model memory** for application windows, sockets, document storage, sub-types, and permissions.
- Register the `note`, `layout`, and `stats` page sub-types in `module.json` under `documentTypes` for `JournalEntryPage`, with `TypeDataModel` classes assigned in `CONFIG.JournalEntryPage.dataModels` during init.
- Prefer the framework's current application and sheet APIs for the fullscreen window.
- Use the module socket for lock requests, write requests, and acks, with the active GM as arbiter (see 6.6).
- Render the canvas with SVG and/or HTML elements (50 notes is small). Links as SVG curves.
- Note styles come from a registry (see 4.5).
- All app reads go through `NotesStore`. Keep the layout record separate from note content.
- Do not depend on other modules.

## 16. Build phases

0. **Visual demo (done):** the published HTML demo of the canvas, three card styles with images and resizing, link toolbar, editor, lock indicators, quick switcher, filters, and stats page. It is the visual reference for later phases.
1. **Skeleton and storage:** containers, sub-types, `NotesStore`, fullscreen window, top bar with quick switcher, editor panel, create and open notes. **Includes the two verification tests in 5.9** (None-ownership never reaches players; socket sender ID is trustworthy).
2. **Canvas:** cards created on the canvas, drag, resize, tilt, pan, zoom, free text labels, fast-capture hooks.
3. **Links:** drawn curves, link toolbar, backlinks, typed `[[wikilinks]]` creating links (and missing notes) on save.
4. **Collaboration:** GM-arbitrated block locks, heartbeats, split/merge, conflict messages, draft rescue, authorship colors.
5. **Safety:** trash bin and restore, GM-only empty, snapshots stored on lock release.
6. **Stats:** per-note contributions, daily buckets, journal stats page, session markers.
7. **Polish:** the three note styles in full, hover previews, search and filter dimming, visual pass against the demo.
8. **GM tier:** hidden notes, declassification, hint elements (using the secrets entry and read layer from phase 1).
9. **Later ideas:** custom style templates, version history UI, a reading view for catching up, Obsidian vault export/import, links to Foundry documents.

## 17. Open questions

- **Lock timing:** are the heartbeat interval and 20-second expiry right at real table latency? Tune in phase 4, and decide whether to show a subtle “connection lost” hint on a stale lock.
- **Version history UI:** snapshots are stored from v1; decide when the restore UI gets built.
- **Stats cap value:** is 2,000 characters per save the right cap?
- **Minor lore:** there is no way to keep minor notes off the board. If that becomes a problem after playtesting, collapse cards to a title only rather than adding an “unplaced” state.
- **Module name and branding.**

## 18. Decisions log (v0.1 to v0.2)

- Storage: `JournalEntry` containers with module-defined page sub-types; players are Observers and the GM is the single writer.
- Hidden GM content lives in a separate None-ownership entry, never as flags on shared pages.
- Layout uses keyed objects so card moves are path-level updates.
- Stats use daily buckets rather than a raw event log.
- Snapshots are stored in v1 in a GM-only History entry; the UI is deferred.
- Edits are sent on click-away or save, not per keystroke.
- Offline GM means read-only for players.
- Typed-link defaults accepted: removal when unedited, offer to create unresolved links, unique titles among non-deleted notes.
- Fast capture added: double-click to create, and “new linked note”.

### v0.2 to v0.3

- Dropped the persistent note drawer, folders, and the “unplaced” state. The canvas is the index, and every note is on the board from the moment it is created.
- Added a quick switcher in the search box (Ctrl/Cmd+K) with recent notes, create-on-Enter, and author and style filter chips that dim the canvas.
- Cards are resizable, with one image slot at the top that fills the leftover space (replacing separate landscape and portrait slots), plus a stored tilt per card.
- The editor is one continuous document: linked notes on top, no paragraph borders, a box only while editing or locked, an Authors toggle, and a width adjustable by dragging.
- Typed `[[wikilinks]]` to missing notes create the note beside the current one and draw the link.
- Visual direction settled: muted Obsidian-style, dark cards, dot-grid canvas.
