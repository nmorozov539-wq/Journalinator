# Foundry VTT Collaborative Notes Canvas: Module Spec

*Working title: TBD. Target: Foundry VTT v14, system-agnostic (built for a PF2e table). Status: design draft v0.1, ready to hand to a coding tool.*

## 1. Vision

A fullscreen, Obsidian-flavored shared journal for a tabletop group. Players and the GM write **notes**, place them on a single **canvas**, and connect them with curvy **links**, like a detective's corkboard. It exists to solve one problem: narrative and mystery campaigns are hard to follow without collective note-taking.

The goal is collective effort. Everyone can read and edit everything, authorship is visible, and the journal rewards contribution (an MVP board) rather than individual ownership.

## 2. Guiding principles

- **Notes are the source of truth.** The canvas only draws what notes contain. Nothing important lives only on the canvas, except free text labels and card positions.
- **One canvas, one journal.** No multiple boards in v1. Simplicity over flexibility.
- **Shared and open by default.** Everyone sees and edits everything, with a GM-only tier added later.
- **Safe by design.** Locks, a trash bin, and version snapshots protect against misclicks and conflicts.
- **Built for bad netcode.** Players may be at 200 ms ping and Foundry's sockets are unreliable. No live cursors or live drag streaming. Updates are sent when an action starts or finishes.
- **Fast capture during live play.** The module is used mid-session, so creating a note and connecting it must take seconds.
- **Styling is the soul.** Notes look like physical objects on a table. The style system must be extensible.

## 3. Scope

**In scope for v1:** notes, markdown editing, block locking, one canvas, drawn and typed links, three note styles, free text labels, search and filter, trash bin, per-note contribution stats, journal-wide stats, fullscreen layout.

**Planned later (designed for, not built first):** GM tier with partial declassification, GM hint notes and links, custom style templates (HTML/CSS), version history UI.

**Out of scope for now:** multiple canvases, linking to Foundry documents (actors, scenes, items), structured properties/fields, freehand drawing, frames and zones, live cursors, Obsidian vault export/import (a separate future feature).

## 4. Core concepts

### 4.1 Note

An individual document with a title, a markdown body, a style, an author, and outgoing links. Can be read as a document, and can optionally be placed on the canvas. Think of an Obsidian note.

- A note can exist without being on the canvas (drawer only).
- A note can be placed on the canvas **only once**.
- Notes may have an optional image (shown on the card).

### 4.2 Link

A connection from one note to another, stored **on the note it originates from**. Links carry:

- target note ID
- label (optional text, e.g. "works for")
- direction: none, one-way (source to target), or two-way
- color
- line style (solid or dashed, for example dashed for "suspected")
- origin: `drawn` or `typed`

Links refer to notes by **ID**, never by title, so renaming a note never breaks links.

### 4.3 Canvas

A single shared board that holds note cards at positions, plus free text labels. Canvas layout is a **separate record** from note content, because card positions and labels do not belong inside note text.

### 4.4 Free text label

The only canvas-only element. A piece of text placed on the canvas (headings, annotations). Lives in the canvas layout record, not in any note. Everything else on the board is a note.

### 4.5 Style

A named visual treatment applied to a note's card (and possibly its editor). v1 ships three presets:

1. **Sticky note**: small, colored, quick capture
2. **Document**: clean page-like card
3. **Torn paper**: rough-edged scrap

Styles are **named definitions in a registry**, not hardcoded branches, so adding a new style (or later, user-made HTML/CSS templates) means adding a registry entry.

## 5. Data model

Stored in Foundry's own world data so it is backed up with the world and survives moving between hosts (VPS and PC). Exact storage mechanism (world settings, a custom document type, or flags on a document) should be chosen by reading the official v14 docs. Logical shape:

**Note**

- `id` (stable, unique)
- `title`
- `style` (registry key)
- `image` (optional)
- `blocks`: ordered list of `{ blockId, text }` (see 6.2)
- `links`: list of `{ targetId, label, direction, color, lineStyle, origin }`
- `authorId` (creator)
- `createdAt`, `updatedAt`
- `contributions`: map of `userId` to characters added
- `deleted`: boolean plus `deletedAt`, `deletedBy` (trash)
- *(reserved for GM tier)* `visibility` and per-block `hidden` flags

**Canvas layout** (single record)

- `cards`: list of `{ noteId, x, y, width, height }`
- `labels`: list of `{ labelId, text, x, y, size, color }`
- viewport defaults (optional)

**Journal stats** can be derived from notes rather than stored separately, except for activity-over-time data, which needs a small event log (see 11).

## 6. Notes and editing

### 6.1 Markdown

Notes use markdown (basic rendering is acceptable for v1: headings, bold, italics, lists, quotes, links). Editing is **Obsidian-ish**: clicking a paragraph turns that block into raw markdown to type in, and it renders again when you click away.

### 6.2 Blocks and locking

A note body is a list of blocks (split on blank lines), each with a **stable block ID** so inserting a paragraph above does not shift locks onto the wrong text.

- Clicking a block to edit **requests a lock** on that block.
- The **first request to be accepted wins**. Everyone else sees immediately that the block is being edited, and by whom, and cannot edit it.
- The lock releases on save, on click-away, or after a timeout (in case someone's browser dies or disconnects).
- Different blocks of the same note can be edited by different people at the same time.
- Adding a new block, reordering, and deleting a block also go through the same arbitration.

### 6.3 Arbitration (important for 200 ms ping)

Two players can click the same block "simultaneously" and both believe they won. To avoid this, **one client arbitrates**: the **GM's client** receives lock requests, grants or denies them in order of arrival, and performs the actual saves (players generally cannot write world data directly in Foundry anyway). Players get an immediate local "pending" state and then a grant or a denial.

Consequence: the journal is editable only while a GM is online. This is acceptable for live sessions. Read access should still work for players when the GM is offline, if the data model allows it.

### 6.4 Typed wikilinks

Typing `[[Baron Voss]]` or `[[Baron Voss|works for]]` in a block is a shortcut for creating a link. On save:

- The title is resolved to a note ID and a link record with `origin: typed` is created or updated.
- The link then appears on the canvas like any other link (if both notes are placed).
- Links are configured through the link toolbar, not through text syntax. Players should not need to learn syntax, so typed links are a convenience, and malformed ones simply do nothing harmful.
- Alias syntax follows Obsidian: `[[Target|label]]`.

## 7. Links on the canvas

- Links are drawn by dragging from one card to another.
- Lines are **smooth curves (Bezier-style), not right-angled or rounded-corner connectors.**
- Selecting a link shows a small toolbar on the line itself with: **label, direction (none / one-way / two-way), color, line style (solid / dashed)**. All are needed for v1.
- A link is drawn only if **both** notes are placed on the canvas. Otherwise it still exists and still counts as a backlink.
- Each note shows **backlinks** ("mentioned in / linked from").
- If a note is deleted, links pointing to it are **hidden, not erased**, so restoring from the trash brings the whole web back intact.

## 8. Canvas behavior

- Notes are placed on the canvas **manually**, once. They can be removed from the canvas without deleting the note.
- Notes can also be **created directly on the canvas**; they behave as normal notes and are placed immediately.
- Cards show a **title and optional image**. **Hovering** shows the note text (full or partial; to be decided when visuals are prototyped).
- Cards are resizable. Free text labels can be added anywhere.
- Pan and zoom. Designed for roughly **50 notes** on the canvas, so heavy virtualization is not needed.
- Updates are sent when an action **starts or finishes** (pick up a card, drop a card). No live drag streaming, no remote cursors.
- Each player has a **color** (taken from Foundry's user color) used for authorship indicators.

## 9. Layout and navigation

Fullscreen app with three regions, so nothing is covered while the canvas is open:

- **Left: drawer.** All notes (placed and unplaced), with search and filters.
- **Center: canvas.**
- **Right: note editor.** Opens when a card or drawer item is clicked.

A note can also be opened in **full screen** for focused reading or writing.

**Finding things:**

- Search box in the drawer.
- Filtering in the drawer (by author, style, placed/unplaced, and similar).
- On the canvas, applying a filter or search **dims everything that does not match**.
- Jump to a note: select in the drawer to pan and zoom the canvas to its card.

## 10. Trash

- Deleting a note moves it to the trash and removes it from the canvas.
- **Anyone can restore** a note from the trash. A restored note returns to the drawer (and its previous canvas position if that is still free; otherwise unplaced).
- **Only the GM can permanently empty** the trash. It never empties itself.
- Restoring brings back its hidden inbound links.

## 11. Contribution stats

**Per note:** shows creator and, per user, how many characters they added. Computed by diffing text before and after each save and crediting added characters to the person who saved. Block locking makes this accurate.

**Journal-wide (a stats page):**

- MVP board (characters written)
- Notes created per player
- Links drawn per player
- Most-linked note
- Most-edited note
- Activity per session (needs a small event log with timestamps; sessions can be derived from date gaps or a manual session marker)

Tone: friendly, celebratory, not competitive pressure. Seeing your name as MVP of the journal is the reward.

## 12. Visual direction

Obsidian-like (clean, muted panels) that does not look alien inside Foundry. Notes on the canvas look like tabletop objects (sticky, document, torn paper). Final look is decided through **demos**, not in this spec.

## 13. GM tier (later phase, design for it now)

- The GM has their own **hidden notes and canvas elements**, with the same base toolset.
- The GM can **declassify** parts of a note as players discover them (for example a character dossier revealed piece by piece).
- The GM can leave **hint notes and links** on the canvas.
- **Hard rule: hidden content is never sent to player clients.** It is not hidden by CSS or UI; the player's browser never receives it.
- **Hard rule: hiding must not leak volume.** Hidden text leaves no gaps, no redaction bars sized to the content, and no length hints. For players, hidden parts are simply absent. If a closing flourish is wanted, it is a fixed line such as "...he never actually knew what his actions led to" that does not vary with the hidden amount.
- Because of these rules, the v1 data model and sync layer must route all reads through a **server-side/GM-side filter** from day one, even if it initially returns everything.

## 14. Technical notes for the coding tool

- Target **Foundry VTT v14**. Server runs on a VPS and on a PC at different times; the exact build may vary. **Read the official v14 API documentation rather than relying on model memory** for application windows, sockets, document storage, and permissions.
- Prefer the framework's current application and sheet APIs for the fullscreen window.
- Use Foundry's socket system for lock requests and updates, with the GM client as the arbiter (see 6.3).
- Render the canvas with SVG and/or HTML elements (50 notes is small). Links as SVG curves.
- Note styles come from a registry (see 4.5).
- Keep the layout record separate from note content.
- Do not depend on other modules.

## 15. Build phases

1. **Skeleton:** fullscreen window, three-region layout, create/list/open notes, storage in world data.
2. **Canvas:** place/remove cards, drag, resize, pan, zoom, create on canvas, free text labels.
3. **Links:** drawn curves, link toolbar, backlinks, typed `[[wikilinks]]` creating links on save.
4. **Collaboration:** GM-arbitrated block locks, conflict messages, authorship colors.
5. **Safety:** trash bin and restore, GM-only empty.
6. **Stats:** per-note contributions, journal stats page.
7. **Polish:** three note styles in full, hover previews, search/filter dimming, visual pass based on demos.
8. **GM tier:** hidden notes, declassification, hint elements (using the filter layer from phase 1).
9. **Later ideas:** custom style templates, version history UI, Obsidian vault export/import, links to Foundry documents.

## 16. Open questions

- **Typed link removal:** if someone deletes `[[Baron Voss]]` from the text, should the typed link vanish? Suggested default: yes if it is still typed-origin and was never edited in the toolbar; otherwise keep it.
- **Unresolved typed links:** if `[[Nobody]]` matches no note, ignore it, or offer to create that note? Suggested default: offer to create it.
- **Duplicate titles:** how to resolve typed links when two notes share a title? Suggested default: require unique titles.
- **Hover preview length:** full text or the first lines? Decide in the demo stage.
- **Lock timeout length** and whether to show "stale lock" warnings.
- **Offline GM:** read-only for players, or no access at all?
- **Version history:** is a simple per-note snapshot on each save enough for the "failed save" worry, and when does a UI for it get built?
- **Module name and branding.**
