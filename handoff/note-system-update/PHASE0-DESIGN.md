# Note-system rewrite — Phase 0 integrated design

Status: awaiting owner approval. No runtime file has been edited.

## 1. Checkout and isolation

| Purpose | Path |
| --- | --- |
| Canonical checkout / feature branch | `/home/Riv/Projects/fvtt-journalinator` @ `note-system-update` (`c778b35`, baseline `c1f2418`) |
| Implementation worktree / branch | `/home/Riv/Projects/fvtt-journalinator-impl` @ `note-system-update-impl` (linear child of `note-system-update`) |
| Live Foundry data (do not touch) | `/home/Riv/foundry-v14-data` (world `pf2e-setup-world`, port 30001, module symlink -> canonical checkout) |
| Disposable test data root (to be built at phase 6) | `/tmp/opencode/foundry-note-system-test` (Foundry `--dataPath=`, alternate port 30002) |
| Task worktrees (as needed) | `/tmp/opencode/wt-<task>` off the current impl HEAD |

Sub-agents work in isolated worktrees/branches. Only the coordinator integrates approved commits into `note-system-update-impl`; `note-system-update` is updated only by approved integration at the end. No push/merge/release/live deployment.

Baseline evidence: `npm test` 457 tests, 453 pass, 4 explicit legacy skips, 0 fail; `npm run check` passes. `tests/ui/smoke.mjs` and `tests/integration.test.mjs` are jsdom/fake-Foundry single-process harnesses, not multiplayer evidence.

## 2. Target architecture

### 2.1 Note data (schemaVersion 2)

```
Note.system = {
  body: string,                       // sole content authority
  revision: nonneg int,               // body revision
  layout: "plain" | "profile",        // selected layout; never inferred
  skin: {
    paper: "cream"|"amber"|"parchment",
    font: "default"|"serif"|"handwritten"|"display",
    torn: boolean,
    backgroundImage: string|null,
    tiltSeed: int                     // stable; rotation derived once
  },
  attachment: { mainPinEnabled, mainSnapRadius, minorSnapRadius, pinStyle }, // preserved
  links: [ ...thread fields minus hint/hidden... ],                         // preserved
  authorId, createdAt, updatedAt, deleted, lastSave
}
lastSave = { requestId, clientSessionId, sequence, revision, bodyHash, at } // idempotency receipt
```

Foundry page `name` is `jn-note-<id>`, set once and never displayed or renamed. Duplicate/empty derived titles allowed.
Removed: `kind`, `style`, `label`, `nameGenerated`, `heading`/`targetHeading`, `presentation.*`, content `image`, `formerNames`, `forceExtended`, `pictureLayout`, `blocks`, `editCount`, `contributions`, `hint`, `actorRef`, secret/hidden flags. Thread `label`, board-label text, and anchor `kind` are preserved.

`card.sizing = { mode: "auto"|"manual", width?: 160-800, minHeight?: 80-1600 }` replaces `card.width/height`.
`card.autoSizeOrigin = {x,y}` is added as the stable world point of the main pin (virtual top-center if disabled). In auto mode every client derives `x/y` from origin + measured size + rotation; no auto-size result is stored as content. Manual mode stores width/minHeight and keeps a normal `x/y`.

History/activity/private storage stay on their existing hidden pages/containers; the `stats` document type is retained as the hidden activity store (no user-facing stats), renamed in code only.

### 2.2 Document model (single parser)

New pure modules (no DOM dependency except renderer polish):

- `scripts/document/parse.mjs`:
  `parseDocument(body, {selectedLayout}) -> { title, underline, slots, effectiveLayout, profileIssue, excerpt, imageSources, codeRanges, blocks }`
  - line-1 strict ATX title (<=3 leading spaces, top-level only; `# ` alone = empty affordance; leading blank/comment blocks title)
  - source scanner for fenced code (matching backtick/tilde lengths), indented code, comments, lists, blockquotes, tables, reference definitions, HTML blocks
  - top-level standalone `---` after a heading = underline (blank lines allowed); otherwise divider; table separator rows never dividers; `===` never a setext title
  - Profile: title, optional underline, standalone inline/reference image paragraph, optional H2 caption, rest; blank lines/comments tolerated, visible intervening text falls back
- `scripts/document/render.mjs`: `renderDocument(parsed, {sanitizer, interactiveTasks}) -> {html, effectiveLayout}`. Render all source exactly once, extra H1 -> H2, raw HTML sanitized, no raw H1/img slot promotion. Writer/reader/preview use the same function.
- `scripts/document/text.mjs`: derived title/excerpt for search, trash, transfers, history (`Empty note`, `Image note`, 70 code points).
- Registries: `scripts/layouts/registry.mjs` (plain/profile slots, widths), `scripts/skins/registry.mjs` (papers/fonts/tilt ranges -> existing theme tokens), `scripts/templates.mjs` (Blank/Document/Profile, quick-switcher create).

Showdown cannot suppress setext; the parser/renderer inserts structural tokens and guard lines so Showdown output is corrected without rewriting stored source. Raw sanitizer runs on final HTML.

### 2.3 Edit-session protocol (active GM mediated)

Replace block locks with one whole-note lease: `{canvasId, noteId, userId, clientSessionId, leaseToken, gmEpoch}`. Verified socket sender is authoritative. 5 s heartbeat, 30 s expiry, no typing idle. Second tab is a separate session. `gmEpoch` is an opaque token regenerated whenever active-GM authority changes; mismatch = failover.

Commands: `beginNoteEdit`, `noteEditHeartbeat`, `previewNoteBody`, `saveNoteBody`, `saveNoteAppearance`, `endNoteEdit`, `forceUnlockNote`, `requestNoteEditState` (plus lease identity on existing mutating commands). Targeted replies: `noteEditGranted|Denied`, `noteEditHeartbeatAck|Revoked`, `notePreview`, `noteSaveAck|Rejected`, `noteAppearanceAck`, `noteEditEnded|EndRejected`, `noteEditForced`, `noteEditState`.

- body limit 200,000 UTF-16 code units, explicit rejection (never truncate); finite/bounded validation of every field.
- preview coalesced <=150 ms; ephemeral overlay keyed canvas/note/lease/sequence; never persisted; never private.
- autosave debounce 700 ms, max 3 s wait, one in-flight save per note; save atomically checks lease + baseRevision, writes body/revision/updatedAt/lastSave, then emits ack with revision/sequence. Idempotent retry compares `lastSave`; no-op save returns current revision without write/activity.
- end-edit flushes then releases after ack; force-unlock revokes first, keeps last acknowledged body, discards preview, tells old editor, leaves local draft.
- appearance/layout/skin/sizing changes use `saveNoteAppearance` (lease-gated, separate appearance revision; body revision untouched). `moveCard`/`resizeCard` require every affected note to be unleased; during editing even the holder cannot mutate structure/pins/routes.
- all note-mutating handlers enforce: lease required (body/appearance) or "no active lease on any affected note" (geometry, delete/restore, pins, links, threads, routes, copy/transfer send where server-visible). Group operations validate all IDs first and fail whole.
- no active GM: shared notes read-only, banner shown, drafts stay local.

### 2.4 Sizing and pin geometry

- Auto widths: Plain 220/300/380, valid Profile 300/380; smallest step containing intrinsic unbreakable content + 40 px padding; images alone >=300; beyond 380 wrap and compute height (min 120).
- Offscreen measurement surface using bundled fonts; recompute on input/render frame (RAF-coalesced), image decode, font-ready, resize; no CSS size transitions/hysteresis.
- Profile portrait centered, max-height 220, `object-fit: contain`; body images cap 320 height; tables/code contained horizontal scroll.
- Manual mode fixes width/minHeight; overflow grows vertically; Auto clears overrides and recomputes immediately.
- Main pin stability: derive `x/y` from persisted `card.autoSizeOrigin` and measured `w/h/rotation` (center rotation). No `x -= deltaW/2` approximation. Card drag updates origin; skin rotation change updates origin. Attached pins stay normalized and follow; free pins never move. Thread endpoints refreshed in the same geometry pass.

### 2.5 History, recovery, activity

- History page: `snapshots[noteId] = [{id, at, authorId, revision, body}]`, newest 20 distinct. Session-start checkpoint, periodic <=60 s (only when saved content changes), end-edit checkpoint, mandatory pre-restore checkpoint. Restore is a normal lease-protected revisioned body write; text only. Trash keeps history; empty-trash deletes it. Private history lives in the private workspace.
- Local recovery drafts: per origin/world/user/canvas/note/session, 150 ms coalesced + flush on blur/pagehide/lock loss/switch, 30 days, quota-safe; never claim "saved locally" on failure. Recovery dialog per UI-SPEC with explicit replace/copy/discard and revision recheck.
- Activity: hidden store keyed UTC day/user/note with `charsAdded, charsRemoved, saveCount, notesCreated, titlesSet, imagesAdded, threadsCreated, largePasteCount, templateInsertCount`; accepted/deduped events only; bounded code-point diff (prefix/suffix trim + capped Myers; beyond cap counts middle as full removal+addition); paste/template event IDs persisted with next accepted save; no text in activity; no rankings/stats/session-marker UI; no private activity.

### 2.6 Private canvas

Same parser/editor/layout/skin/history UI; private pages keep their existing owner/admin permission path and workspace revision check. Add a local per-note edit-session coordinator (BroadcastChannel + localStorage fallback) so tabs don't collide; no GM lease and no shared preview/activity. Workspace `rev` remains the persistence guard. Private notes carry schema v2 body/layout/skin/sizing; transfers carry body/layout/skin/sizing with fresh revision/history/activity IDs.

## 3. Removals (clean break)

- delete `scripts/secrets/*`, `scripts/actor-status.mjs`, secret settings/containers/flags/UI/strings and socket GM-secret handlers
- delete note block/paragraph, title/label/heading/image/kind/style-as-type/forceExtended/pictureLayout/formerNames/contributions/editCount/hint fields and all call sites
- delete typed-wikilink reconciliation on save; `[[text]]` stays literal
- delete Location creation/filters/menus; keep board labels, anchor kinds, thread labels
- delete stats/rankings/session-marker UI; keep activity API
- delete migration/backfill; replace with non-destructive unsupported-format detection + read-only notice; never rewrite/delete old containers or settings; fresh world initializes current structures only
- keep pins/threads/materials/board backgrounds/route mechanics/free-pin selection/send/trash/publish; free pins remain non-transferable (current v0.9.6 behavior, D19 preserve)
- keep bundled fonts/assets; no new runtime dependency

## 4. Task graph and ownership

Every task has 1-3 owned paths, prohibited paths, frozen interfaces, explicit acceptance cases, and returns diff/rationale/tests/issues. No commits until coordinator review of the exact result. Integration order below; parallel only on disjoint files.

| # | Task | Owns | Depends | Exit |
| --- | --- | --- | --- | --- |
| T1 | Parser + renderer + text derivation | new `scripts/document/*`, `tests/document-*.test.mjs` | — | all title/underline/code/table/profile fixtures pass; no existing file edited |
| T2 | Schema + registries + templates | `data/note-model.mjs`, `data/layout-model.mjs`, `data/history-model.mjs`, `data/activity-model.mjs`, new `layouts/*`, `skins/*`, `templates.mjs`, schema/registry tests | T1 interfaces | v2 schema, sizing/origin, registries; old fields gone from models |
| T3 | Removals + store/init/containers | delete `secrets/*`, `actor-status.mjs`, `migrate.mjs`; `store/notes-store.mjs`, `store/containers.mjs`, `init.mjs`, `module.json`, schema-guard | T2 | single current-schema read seam; no vault/actor/migration init; incompatible notice guard |
| T4 | Protocol + leases + lock enforcement | `socket.mjs`, new `edit-session.mjs`, `init.mjs` lock wiring via T3 interface, protocol tests | T2,T3 | 8 commands, receipts, preview, failover, all handlers gated |
| T5 | History + activity + diff | new `history.mjs`, `activity.mjs`, `text-diff.mjs`, models wiring, tests | T2,T4 interfaces | checkpoints/restore, idempotent counters, diff cases |
| T6 | Shared editor | `app/editor.mjs`, new `editor/session.mjs`, `editor/source-surface.mjs`, editor tests | T1,T2,T4 | in-place source editor, toolbar, autosave, drafts, helpers, preview |
| T7 | Private canvas | `store/private-store.mjs`, `app/private-editor.mjs`, `private-workspace.mjs`, `private-admin.mjs`, `private-transfer.mjs`, `data/private-model.mjs`, private tests | T2,T5,T6 | v2 private notes, local session, private history, no leakage |
| T8 | Canvas card rendering + creation + selection UI | `app/canvas.mjs` (render/selection), `app/note-dialog.mjs`, `app/journal-app.mjs` creation/selection portions, CSS | T1,T2,T6 | Blank/Document/Profile menu, Plain/Profile render, toolbar, lock gating |
| T9 | App surfaces | `app/journal-app.mjs` (search/trash/transfers/stats removal), `app/note-search.mjs`, history UI, lang hooks | T8 | derived labels/filters, history modal, no stats/vault UI |
| T10 | Sizing + geometry + pin compensation | new `sizing/measure.mjs`, `app/canvas.mjs` geometry portions, CSS sizing, geometry tests | T8,T9 | 220/300/380 live, rotated pin stability, thread refresh |
| T11 | Transfers + routes + clipboard | `private-transfer.mjs`, `route-notes.mjs`, `socket.mjs` transfer handlers (serialized after T4), transfer tests | T4,T7,T10 | v2 payloads, remap, locks, no unsupported migration |
| T12 | i18n + docs + ledger | `lang/en.json`, `lang/ru.json`, README, HANDOFF, CHANGELOG, `handoff/note-system-update/PROGRESS.md` | all functional | EN/RU parity, no orphan removed strings, accurate docs |
| T13 | Independent verification | new/updated tests, `tests/ui/smoke.mjs` convergence, disposable Foundry evidence | all | full suite/check + multiplayer/screenshot acceptance ledger |

Test convergence note: `tests/ui/smoke.mjs` (~5.9k lines) and `tests/integration.test.mjs` assert removed features; they are owned exclusively by T13 after the feature work, with focused new tests written per task. Intermediate commits may leave the full suite red; every task must pass its scoped tests, and the integrated branch must pass at T13.

## 5. Test plan

- Parser: title line 1 (indent/closing hashes/CRLF), `# ` affordance, later H1->H2, leading blank/comment, fenced/indented code, comments, quotes/lists/tables, separator rows, `===`, heading+`---` underline, divider, reference images, Profile all slot orders/fallbacks, byte-identical source on layout switch, sanitizer/raw HTML.
- Session: grant/deny/second tab, heartbeat 5 s/expiry 30 s, preview coalescing/staleness/revocation, save ack/no-op/retry/receipt/failover, baseRevision conflict, oversize/invalid, force-unlock, queued-op rejection at execution, end flush/release order.
- Editor: creation templates/focus, in-place double-click, toolbar actions/undo/selection, native undo/IME, Ctrl+S/Escape, autosave timing, drafts/recovery comparison, no DOM teardown on remote updates.
- Locks/board: remote lock blocks select/drag/resize/delete/restyle/copy/transfer/checkbox/pins/threads/routes; mixed group fails whole; free pins/notes unaffected; editor cannot mutate structure.
- Size/geometry: step growth/shrink, vertical growth, manual mode, long words/tables/code/images/Russian, pin stability at multiple rotations within 1 px across save/reload/sync, attached/free pin semantics, thread refresh.
- History/activity: 20 distinct, checkpoint timing, pre-restore, text-only restore, trash retention, real diff incl. equal-length replacement/Unicode/large bodies, counters/idempotency, private isolation.
- Transfers: shared<->private, private->private inbox, publish, clipboard; body/layout/skin/sizing remap; fresh IDs/revision/history; receipts; orphan/free/attached pin rules; unsupported payload rejection.
- Removals/clean break: rg audit for vault/secret/actor/Location/block/ranking/migration runtime symbols; fresh world structures; old-format notice without writes.
- Verification: full `npm test` + `npm run check`; disposable Foundry v14 world with GM + two players, disconnect/reload/force-unlock/GM failover; screenshots per UI-SPEC (states, widths, EN/RU, zoom).

## 6. Owner decisions requested

1. **Approve this design and task plan** (the required gate before runtime edits).
2. **Confirm the documented extensions** required by the package's own acceptance criteria: `saveNoteAppearance` command, `card.sizing` replacing `width/height`, `card.autoSizeOrigin`, `lastSave` receipt on the note, activity stored on the existing hidden `stats` page, private history included in scope, free pins not transported (preserve v0.9.6).
3. Anything you want changed before T1 starts.
