# Journalinator — Handoff Notes

Status: pre-alpha, v0.1.0. Phases 1–7 of the spec are implemented; Phase 8 (GM tier) has not
started. This file records the current architecture, the bugs found during review, and the
GM-side design work that should happen before Phase 8 is attempted.

---

## 1. Code map

| Area | File |
| --- | --- |
| Module entry, hooks, scene-control button | `scripts/init.mjs` |
| Journal containers, upgrade path, sidebar hiding | `scripts/store/containers.mjs` |
| Single read seam for notes/layout/stats | `scripts/store/notes-store.mjs` |
| Page data models | `scripts/data/*.mjs` |
| Fullscreen app shell, top bar, switcher, trash, stats UI | `scripts/app/journal-app.mjs` |
| Canvas, cards, labels, links, pan/zoom | `scripts/app/canvas.mjs` |
| Block editor, locks, split/merge, drafts | `scripts/app/editor.mjs` |
| Socket protocol, GM write path, typed links, trash | `scripts/socket.mjs` |
| Ephemeral lock state machine | `scripts/locks.mjs` |
| Typed `[[wikilink]]` reconciliation | `scripts/wikilinks.mjs` |
| Daily activity buckets and stats aggregation | `scripts/stats.mjs` |
| Snapshot ring buffers | `scripts/snapshots.mjs` |
| Style registry | `scripts/styles/registry.mjs` |
| Styles | `styles/journal.css` |
| Design spec | `Foundry VTT Collaborative Notes Canvas Module Spec.md` |
| Visual reference | `Notes Canvas_ Round 1.html` |

There is no build step, no package manager, and no test suite. The module is loaded directly by
Foundry.

---

## 2. Recent fixes

1. **GM writes are now serialized.** `scripts/socket.mjs` has a `writeQueue` promise chain;
   both socket requests and the active GM's direct `requestWrite` path go through
   `enqueueWrite`. This fixes the spec §5.3 assumption that the GM serializes writes. Without
   it, two concurrent `saveBlock`/`createLink`/`updateLink` handlers can read the same
   whole-array field and the second write clobbers the first.
2. **Typed wikilinks no longer resolve to trashed notes.** The `byTitle` lookup in
   `scripts/socket.mjs` now filters `!p.system.deleted`.
3. **Link labels save on change, not per keystroke.** The link toolbar label input uses
   `onchange` instead of `oninput`, giving one socket message/world write per label edit
   (spec §6.2) instead of one per character.
4. **Lock snapshots replace the mirror, and active-GM changes force a resync.**
   `receiveLockBroadcast` now treats `lockState` as a full replacement, emitting null hooks for
   locks that disappeared. `startLockResync()` watches user documents and, when
   `game.users.activeGM` changes, clears the mirror and requests a fresh snapshot. This removes
   the stale-lock-after-failover bug where a block stayed unclickable forever.
5. **Editor lifecycle is cleaned up.** `NoteEditor` now activates/deactivates its lock hook
   instead of registering it forever in the constructor. On app close it saves the in-progress
   block, releases active and pending locks, stops the heartbeat, clears drafts, and removes
   the hook. Switching notes also saves explicitly before clearing state. The scene-control
   button reuses `foundry.applications.instances` instead of creating a second app with the
   same id, and the search-blur timer is cancelled on close so it cannot re-render a closed app.
6. **Titles are unique, notes can be renamed, and new notes appear in view.** The GM rejects
   duplicate live titles (case-insensitive) and sends a targeted rejection notice to the
   requester. Generated titles use `Untitled`, `Untitled 2`, etc. The editor has a rename
   button; renames update `formerNames` so existing typed links keep pointing at the renamed
   note instead of turning the old title into a new ghost note. Restoring a note whose title
   was reused auto-suffixes it. `+ New Note`, quick-switcher create, and double-click create all
   place cards through `findFreeSpot`; toolbar/switcher creates start at the viewport center.
   This also fixed an inverted overlap test in `findFreeSpot`: it previously treated separated
   cards as overlapping and happily returned occupied coordinates.
7. **The GM write path now validates hostile payloads.** `updateLink` whitelists only
   `label`/`direction`/`color`/`lineStyle`, validates each against its allowed set, and rejects
   edits that would change a link's `id` or `targetId`. `createLink` rejects self-links,
   duplicates, and deleted/missing targets. Styles/images/title lengths/block text/card
   geometry are type- and range-checked, and note-page type checks reject attempts to target
   layout/stats/history pages. Card images are CSS-escaped, and link colors/IDs are sanitized
   again at render time before entering SVG.

These are incremental fixes; the larger issues below remain.

---

## 3. Critical: Phase 8 secrets cannot use `JournalEntry` storage

Spec §5.1/§5.9/§14 assume that a `JournalEntry` with ownership `NONE` is a secrecy boundary.
The implementation comments in `scripts/store/containers.mjs` record the opposite: on Foundry
v14, every connected client receives the full data of every `JournalEntry`, regardless of
ownership (`World.#p()` calls `db.JournalEntry.dump()` with no permission filter in
`dist/packages/world.mjs`). Ownership only hides the UI.

Consequences:

- The `GM Secrets` container is not secret. It is empty today, but it is not a safe place for
  hidden notes/blocks/links.
- The `History` container is also readable by players; snapshots are not private.
- Any Phase 8 design that stores hidden text in a synced `JournalEntry` violates the spec's
  hard rule that hidden content is never sent to player clients.

**Before Phase 8, verify this against the exact v14 build in use.** If confirmed, the storage
design needs to change. Options worth evaluating:

1. **Client-side encrypted blob plus a GM-held key (recommended starting point).**
   Store ciphertext, IV, salt, and KDF parameters in a journal page or world setting. The data
   key is wrapped with a GM passphrase (`crypto.subtle` + PBKDF2/Argon-like KDF) and only
   decrypted in the GM client. Players receive ciphertext only. Declassification is a real
   write: decrypt, write plaintext into the shared note, then remove it from the encrypted
   blob. This also avoids leaking length if the plaintext is padded before encryption.
2. **A document type that is actually ownership-filtered on the wire.** Do not assume; trace
   the v14 sync path for the specific document class and verify with a player client inspecting
   raw received data. JournalEntry is known not to satisfy this.
3. **Server-side module storage.** Requires server-side code and was out of scope for the
   original spec; mention only if the table is willing to run custom server code.

Do not build the Phase 8 UI until a player client can be shown to never receive plaintext
hidden content. Also account for metadata leaks: number of secret notes, timestamps, and
ciphertext lengths can reveal information even when content is encrypted.

---

## 4. GM-side design (read this before touching the write path)

### 4.1 Current flow

1. Players have `Observer` ownership on the shared journal. They cannot write documents
   directly.
2. A player sends a message over the module socket (`module.fvtt-journalinator`).
3. Foundry's server appends the verified sender user id as the second callback argument; the
   sender id is never taken from the message payload.
4. Only the active GM (`game.users.activeGM`) processes write messages.
5. The GM client applies the change with document updates; Foundry's normal sync pushes the
   result to players.
6. Locks are ephemeral GM memory. Every client keeps a mirror; only the active GM keeps the
   authoritative grant/deny/expire map. Lock broadcasts are informational and are applied by
   every client. A full `lockState` replaces the mirror, and an active-GM change triggers a
   fresh snapshot.
7. Layout updates use keyed paths (`system.cards.<id>.x`), so independent card moves do not
   clobber one another. Note content and links are whole-array fields and must be serialized.

### 4.2 What is now guaranteed

- `writeQueue` serializes all GM-side message handling, including nested stats/snapshot writes
  triggered by a handler.
- A failed handler is caught and logged; the queue continues.
- Sender attribution comes from the socket layer, not the payload.
- Locks are not persisted, so lock traffic causes no world writes.
- A `lockState` snapshot is authoritative: it replaces the local mirror instead of merging, so
  locks that no longer exist on the GM cannot survive in client memory.
- Active-GM changes clear the mirror and request a fresh snapshot.
- Lock broadcasts are accepted only from the current active GM, so a late broadcast from a
  former GM cannot resurrect stale locks.
- Queued GM writes re-check active-GM status before applying, so a former GM cannot finish a
  write after a failover.
- Live note titles are unique (case-insensitive); duplicate creates and renames are rejected
  and the requesting client gets a targeted notification.

### 4.3 Remaining GM-side weaknesses

**Lock mirror resync is now handled.** `receiveLockBroadcast` treats `lockState` as a full
replacement, `startLockResync()` watches `createUser`/`updateUser`/`deleteUser`/`userConnected`
so an active-GM change clears the mirror and requests a fresh snapshot, and lock broadcasts are
ignored unless they come from the current active GM. `userConnected` is the important one:
Foundry v14 updates `user.active` from activity data rather than a normal document update.
Remaining work: a queued write that was accepted before a failover is dropped rather than
retried, and ordering across a very fast double-failover is still implicit rather than enforced
by a term number.

**Failover hardening still worth doing.** Add a monotonically increasing term/epoch to lock and
write messages if failover behavior becomes important. A term makes ordering explicit and lets
clients reject stale messages deterministically rather than relying on sender identity checks.
The sender checks above are the minimum; a term is the robust version.

**The queue is global.** A slow handler blocks every other write. Most handlers are short, so
this is acceptable for now, but a per-note queue would allow parallel work on different notes.
If adding that, keep a global queue for layout/stats operations or make all queue keys
consistent.

**All payload fields are hostile.** The sender id is trustworthy; everything else is not.
Validate every field in `handleMessage`:

- `createNote`: title uniqueness/empty-title/length checks and style coercion are implemented.
- `newLinkedNote`: title checks and source note type/deletion checks are implemented.
- `renameNote`: title uniqueness/empty-title/length checks and note-page type checks are implemented.
- `saveBlock`: text is type- and length-checked, note/page type and deletion are checked, and
  the lock is required.
- `splitBlock` / `mergeBlockUp`: same, plus both locks are required for merge and the original
  block id is kept.
- `setNoteStyle`: validated against `CARD_STYLES`.
- `setNoteImage`: accepts null or a bounded string; `FilePathField` handles the rest.
- `createLink`: target/source are note pages, live, distinct, and duplicates are rejected.
- `updateLink`: only `label`/`direction`/`color`/`lineStyle` are accepted, each validated;
  `id`/`targetId` cannot be changed.
- `moveCard` / `resizeCard`: note/page type and deletion are checked; coordinates must be
  finite and dimensions positive or null.
- `deleteNote`: idempotent; a second delete leaves `lastCard` intact.
- `restoreNote`: page type, deleted state, and title collisions are handled; free-spot logic is
  intact.
- `addLabel` / `updateLabel`: still need type/range validation for `text`, `x`, `y`, `size`,
  `color`, and a check that the label exists before updating.
- `emptyTrash` / `addSessionMarker`: keep the sender `isGM` check; also handle the case where
  the sender user no longer exists.

**Offline GM.** `requestWrite` emits into the void when there is no active GM. The UI shows a
read-only banner but the buttons remain active. Either disable write controls while
`game.users.activeGM` is null, or queue local intent and explain that it will not apply.

**Secrets and history.** See section 3. Do not treat `ownership: NONE` as privacy anywhere in
the GM tier.

**Snapshots and activity are read-modify-write.** `recordActivity` and `maybeSnapshot` are now
inside the queue, so they are safe from concurrent handlers. If the queue is ever made
per-note, keep the stats page and history page operations serialized globally.

**Lock broadcast messages bypass the write queue.** `lockUpdate`/`lockState` are applied by
every client immediately, while lock requests (`requestLock`/`releaseLock`/`heartbeat`) go
through `handleMessage` and are now serialized with world writes. That is fine while handlers
are short, but it means a slow write can delay a heartbeat. If lock latency becomes a problem,
split lock operations out of the queue and add sequence numbers or a term/epoch so their
ordering is still well-defined.

### 4.4 Suggested GM-side order

1. Finish label validation (`addLabel`/`updateLabel`).
2. Term/epoch for failover ordering if it becomes important.
3. Secrets storage spike (section 3).
4. Only then Phase 8 UI.

---

## 5. Other known bugs and gaps

### High impact

- **Drafts are memory-only.** A disconnect or page reload loses the rescued text, while spec
  §6.5 implies it should survive a dropped connection. Persist to `localStorage` keyed by
  note/block and offer recovery.

### Medium impact

- **Renamed notes leave stale typed-link text.** Existing `[[Old Title]]` text resolves to the
  renamed note because `formerNames` is recorded, but the visible text is not rewritten and a
  freshly typed `[[Old Title]]` will create a new note. Rewriting wikilink text on rename (or
  resolving aliases for new links) is the next refinement.
- **Stats sessions ignore post-marker days.** `deriveSessions` treats each marker as a single
  date, so activity on days after a marker but before the next marker is omitted. Define
  marker ranges instead.
- **Typed links do not count toward "links drawn."** `reconcileTypedLinks` creates links
  without `recordActivity({ links: 1 })`. Decide whether typed links should count.
- **Contribution credit is net length, not a real diff.** Replacing 100 characters with 100
  different characters credits zero. It is a reasonable MVP approximation; document it or
  move to a proper diff.
- **Label geometry/color still need validation.** `addLabel`/`updateLabel` accept arbitrary
  fields; add type/range checks and require the label to exist before updating.
- **Link toolbar is rebuilt on every document update.** Even with `onchange`, typing can lose
  focus if an unrelated update re-renders the toolbar. Consider updating just the input value
  or not rebuilding while it has focus.
- **Search/filter interaction.** The quick-switcher list ignores author/style filter chips;
  the spec says filters combine with search. Decide whether the dropdown should apply them too.
- **`emptyTrash` assumes the history entry/page still exists.** If the history container was
  deleted, the page lookup is null and snapshot cleanup is skipped; the delete itself still
  works. `ensureContainers` also only repairs a missing history page, not missing layout/stats
  pages.
- **Race on first-run container creation.** Two GMs loading a fresh world at the same time can
  both create containers before the setting is saved.

### Packaging / missing deliverables

- No `README.md`, even though spec §5.8 says the sub-type deactivation trade-off must be
  documented there.
- `module.json` has `authors: []` and no `url`, `manifest`, `license`, or repository metadata.
- No sheet registration for the module's `JournalEntryPage` sub-types (spec §5.1).
- No tests, linting, or CI. The pure modules (`stats.mjs`, `wikilinks.mjs`, free-spot search,
  store filtering) are easy to unit-test.
- No localization; all strings are hardcoded English.
- The spec's "must verify" items (player never receives None-ownership data; socket sender id)
  should be re-run against the exact v14 build and recorded in the README or this file.

---

## 6. Testing checklist

- [ ] Two clients save different blocks of the same note at nearly the same moment; both
  changes survive (write queue).
- [ ] Delete a note, then type a `[[Title]]` matching the trashed note's title; a new live note
  is created instead of linking to the trash.
- [ ] Edit a link label by typing several characters and blurring; only one socket request is
  sent and the label persists.
- [ ] With a block locked, disconnect the active GM so another GM takes over. The stale lock
  must clear, and the block must become clickable again without a page reload.
- [ ] Remove every GM; confirm existing lock pills/highlights disappear rather than persisting
  against an absent GM.
- [ ] Edit a block, close the app without clicking away, and reopen it. The text must be saved,
  the block must be unlocked for other clients, and there must be no heartbeat left running.
- [ ] Edit a block, click another note, and confirm the first note saved before the switch.
- [ ] Click the scene-control button several times while the app is open; only one window and
  one editor lock listener should exist.
- [ ] Create two notes with the same title; the second is rejected and the requesting client
  sees a notification. Rename a note to an existing title; same result.
- [ ] Double-click empty canvas twice; titles become `Untitled` and `Untitled 2`, and the cards
  do not overlap.
- [ ] Use `+ New Note` and the quick switcher with the canvas panned; the new card appears near
  the viewport center, not at `(0,0)`.
- [ ] Rename a note that is the target of an existing `[[Old Title]]` link, then save the
  source note. The link must still target the renamed note, not create a new note.
- [ ] Restore a trashed note whose title was reused; it should return with a suffixed title and
  the requester should see a notice.
- [ ] Send an `updateLink` message with `id`/`targetId` or an invalid color/direction/style and
  confirm the stored link is unchanged and nothing unusual appears in the canvas SVG.
- [ ] Try a self-link and a duplicate link; both are rejected. Try setting an unknown style or a
  non-note page id; both are rejected.
- [ ] Run `node --check` over every `.mjs` file.

## 7. Suggested next steps

1. Finish label validation (`addLabel`/`updateLabel`) and any remaining geometry range checks.
2. Add explicit term/epoch handling for failover ordering if failover becomes important.
3. Spike the encrypted-secrets design before Phase 8.
4. Add a README and unit tests for the pure modules.
5. Only then Phase 8 UI.
