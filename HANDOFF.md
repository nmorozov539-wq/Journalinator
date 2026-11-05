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

## 2. What changed in this patch

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

These are deliberately small, low-risk fixes. The larger issues below are not addressed.

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
   every client.
7. Layout updates use keyed paths (`system.cards.<id>.x`), so independent card moves do not
   clobber one another. Note content and links are whole-array fields and must be serialized.

### 4.2 What is now guaranteed

- `writeQueue` serializes all GM-side message handling, including nested stats/snapshot writes
  triggered by a handler.
- A failed handler is caught and logged; the queue continues.
- Sender attribution comes from the socket layer, not the payload.
- Locks are not persisted, so lock traffic causes no world writes.

### 4.3 Remaining GM-side weaknesses

**Lock mirror resync is broken.** `receiveLockBroadcast` applies `lockState` entries but never
clears the local mirror. After a GM failover, the new GM's authoritative map starts empty,
stale locks remain visible on clients, and those clients cannot click the block to re-request
because the mirror says someone else holds it. Fix by replacing the whole mirror on a
`lockState` snapshot, emitting a lock-change hook for keys that disappeared, and requesting a
snapshot when the active GM changes. The current `open()` path only requests state when the
selected note changes.

**Failover needs an epoch/term.** During a GM handoff, late messages or broadcasts from the old
GM can arrive after the new GM has taken over. Add a monotonically increasing term to lock
broadcasts and reject messages from an older term. Also re-check `game.users.activeGM` inside
each queued job; the queue can still hold work when the GM loses active status, and
`handleMessage` itself does not re-check.

**The queue is global.** A slow handler blocks every other write. Most handlers are short, so
this is acceptable for now, but a per-note queue would allow parallel work on different notes.
If adding that, keep a global queue for layout/stats operations or make all queue keys
consistent.

**All payload fields are hostile.** The sender id is trustworthy; everything else is not.
Validate every field in `handleMessage`:

- `createNote`: trim title, reject duplicate titles among non-deleted notes, reject empty
  titles, coerce style to a registry key.
- `newLinkedNote`: same title checks; validate source exists and is not deleted.
- `saveBlock`: validate text is a string, note exists and is not deleted, sender holds the
  lock, block belongs to the note.
- `splitBlock` / `mergeBlockUp`: same, plus require both locks for merge and keep the
  original block id.
- `setNoteStyle`: validate against `CARD_STYLES`; currently any string is accepted.
- `setNoteImage`: rely on `FilePathField` validation, but reject non-image paths explicitly.
- `createLink`: target exists, is not the source, is not deleted; dedupe repeated links.
- `updateLink`: whitelist `label`, `direction`, `color`, `lineStyle`; validate each value;
  never allow `id`/`targetId` to change through `...message.fields`.
- `moveCard` / `resizeCard`: note/card must exist; clamp absurd dimensions and coordinates.
- `deleteNote`: make idempotent; do not overwrite `lastCard` if the note is already deleted.
- `restoreNote`: ensure the page is actually deleted; free-spot logic is fine.
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

1. Lock-state replacement + resync on active-GM change.
2. Term/epoch for failover and stale-message rejection.
3. Payload validation table above.
4. Title uniqueness + rename support.
5. Secrets storage spike (section 3).
6. Only then Phase 8 UI.

---

## 5. Other known bugs and gaps

### High impact

- **No title uniqueness enforcement.** Spec §4.1/§6.8 require unique non-deleted titles; the
  GM never checks. This can make typed-link resolution ambiguous and break declassification
  later. There is also no rename path at all — the editor shows the title as plain text.
- **New notes stack at `(0,0)`.** `createNotePage` falls back to `x ?? 0, y ?? 0`; the
  `+ New Note` button and quick-switcher create send no coordinates. Quick-switcher create
  should place the note near the viewport center, and both should use `findFreeSpot`.
- **Editor lifecycle leaks.** `NoteEditor` registers a global `journalinatorLocksChanged`
  listener in its constructor and never removes it. `JournalApp._onClose` does not call an
  editor destroy method, so closing the app while editing leaves the heartbeat running and the
  block locked. `onChange: () => new JournalApp().render(true)` creates a new app instance on
  every scene-control click; consider a module-level singleton (or verify the correct v14
  `singleton` option before using it).
- **Unsaved edits when switching notes.** `NoteEditor.open()` calls `#stopEditing()` without
  saving and then clears `drafts`. It usually works only because clicking elsewhere blurs the
  textarea first. Save explicitly before switching, or keep per-note drafts.
- **Drafts are memory-only.** A disconnect or page reload loses the rescued text, while spec
  §6.5 implies it should survive a dropped connection. Persist to `localStorage` keyed by
  note/block and offer recovery.

### Medium impact

- **Stats sessions ignore post-marker days.** `deriveSessions` treats each marker as a single
  date, so activity on days after a marker but before the next marker is omitted. Define
  marker ranges instead.
- **Typed links do not count toward "links drawn."** `reconcileTypedLinks` creates links
  without `recordActivity({ links: 1 })`. Decide whether typed links should count.
- **Contribution credit is net length, not a real diff.** Replacing 100 characters with 100
  different characters credits zero. It is a reasonable MVP approximation; document it or
  move to a proper diff.
- **Link color is injected into raw SVG.** `scripts/app/canvas.mjs` interpolates
  `link.color` into `stroke`, marker ids, and attribute strings. A hostile client can send
  arbitrary SVG/attribute content through `updateLink`. Validate against the allowed palette
  (and validate `direction`/`lineStyle`) on the GM.
- **Card image paths go into CSS `url("...")` without escaping.** Escape quotes/backslashes,
  or build the style with `CSS.escape`/a safe allowlist.
- **Link toolbar is rebuilt on every document update.** Even with `onchange`, typing can lose
  focus if an unrelated update re-renders the toolbar. Consider updating just the input value
  or not rebuilding while it has focus.
- **Search/filter interaction.** The quick-switcher list ignores author/style filter chips;
  the spec says filters combine with search. Decide whether the dropdown should apply them too.
- **`createLink` does not prevent self-links or duplicates.**
- **`deleteNote` is not idempotent.** Calling it twice overwrites `lastCard` with `null`,
  losing the restore position.
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

## 6. Testing checklist for this patch

- [ ] Two clients save different blocks of the same note at nearly the same moment; both
  changes survive (write queue).
- [ ] Delete a note, then type a `[[Title]]` matching the trashed note's title; a new live note
  is created instead of linking to the trash.
- [ ] Edit a link label by typing several characters and blurring/Enter; only one socket
  request is sent and the label persists.
- [ ] Run `node --check` over every `.mjs` file.

## 7. Suggested next steps

1. Fix lock mirror replacement and resync on GM change.
2. Add validation and title uniqueness/rename.
3. Fix editor teardown and unsaved-state handling.
4. Spike the encrypted-secrets design before Phase 8.
5. Add a README and unit tests for the pure modules.
