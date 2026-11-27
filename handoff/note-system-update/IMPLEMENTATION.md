# Implementation contract

Read DECISIONS and UI-SPEC first. The baseline is v0.9.6 at `c1f2418`. Existing names below describe code to replace, not requirements to preserve obsolete behavior. Phase zero must extend this map to concrete functions and callers before editing.

## Baseline code inventory

| Area | Files and current coupling | Required outcome |
| --- | --- | --- |
| Data | `scripts/data/note-model.mjs`, `layout-model.mjs`, `private-model.mjs`, `history-model.mjs`, `stats-model.mjs` | Single body/revision; explicit layout/skin; preserve geometry and link structures. Private actual storage also uses text-page flags: inspect store, not just model. |
| Presentation | `scripts/presentation.mjs`, `scripts/styles/registry.mjs`, `themes.mjs`, `styles/stylized.css`, `journal.css`, `fonts.css` | Replace label/block classification with one parser and layout/skin registries; preserve board theme behavior. |
| Markdown | `scripts/markdown.mjs`, `markdown-edit.mjs`, `wikilinks.mjs` | Shared parsing/render contract, sanitized HTML, literal wikilinks, title/underline rules, native undo and IME handling. |
| Shared writes | `scripts/socket.mjs` | Replace create/rename/image/block-save/split/merge paths. Preserve trusted socket sender, active-GM arbitration, validation, serialized writes and targeted replies. Existing `saveBlock` has no body revision check. |
| Locks | `scripts/locks.mjs` | Replace note:block keys with note/session leases, revoke tokens, failover epoch, full-state replacement. |
| Shared editor | `scripts/app/editor.mjs` | Replace paragraph textareas/drafts/secret actions with one in-place document editor and autosave session. |
| Board/app | `scripts/app/canvas.mjs`, `journal-app.mjs`, `note-dialog.mjs`, `note-search.mjs` | New templates, layout/appearance controls, lock gating, search/excerpts, rendered previews, no stats/vault/Location/actor UI. |
| Private | `scripts/app/private-editor.mjs`, `private-workspace.mjs`, `private-admin.mjs`, `scripts/store/private-store.mjs` | Reuse editor behavior, replace normalization/defaults, preserve owner access and workspace revisions. |
| Transfers | `scripts/private-transfer.mjs`, shared transfer handlers in `socket.mjs`, private workspace clipboard/inbox | New body/layout/skin payload; preserve ID remapping, copy semantics, limits, receipts and pin/route filtering. |
| Pins and routes | `scripts/board-pins.mjs`, `anchors.mjs`, `card-ports.mjs`, `link-thread.mjs`, `route-notes.mjs` | Preserve mechanisms; integrate finalized card geometry and lock guards only. Both note links and layout pinLinks exist. |
| Read/storage/init | `scripts/store/notes-store.mjs`, `containers.mjs`, `scripts/init.mjs`, `migrate.mjs` | Remove secret merge/read paths, vault containers/settings and legacy migration initialization. Read one current schema. |
| History/activity | `scripts/snapshots.mjs`, `stats.mjs`, history/stats models, app dialogs | New-body history and restore UI; counters without rankings/UI. Existing history stores blocks and has no complete restore UI. |
| Full removals | `scripts/secrets/*`, `actor-status.mjs`, their callers/settings/hooks/actions | Remove feature end to end; no dormant menu buttons or dead socket routes. |
| Localization/docs | `lang/en.json`, `lang/ru.json`, README, HANDOFF, CHANGELOG | Matching new controls/messages, remove orphaned feature strings, document final behavior. |
| Tests | `tests/*`, `tests/ui/smoke.mjs`, fake Foundry | Replace obsolete assertions, retain unrelated regressions, add protocol/state/real UI coverage. |

Inventory creation from toolbar, board double-click, quick switcher, route insertion, clipboard, publishing and private inbox. Inventory titles in search, trash, history, notifications, selection toolbars, transfers and any Foundry sidebar names. Inventory all mutations affecting locks, not just text saves. Search actual call sites, imports, exports, CSS selectors and translations; do not assume this table is exhaustive.

## Target data and module boundaries

New notes have `schemaVersion: 2`, `body: string`, `revision: nonnegative integer`, `layout: plain|profile`, `skin: { paper, font, torn, backgroundImage, tiltSeed }`, existing attachment configuration, links, authorId, createdAt, updatedAt and deleted state. The schema version identifies current format; it does not authorize an upgrader. Use `jn-note-<id>` for Foundry's required name, set once. Never use it for display or rename it when body changes.

No derived title, caption, portrait URL, effective layout or auto-size result is persisted as a second content authority. Pure parsing returns derived title, slot source ranges, effective layout, profile issue and visible excerpt. Layout ID stays `profile` even when effective layout is Plain. Store manual geometry and positioning in the existing layout card. Add explicit `sizing: auto|manual`; manual width and minimum height live there. Auto width/height are computed from body/skin. Add a stable auto-size origin only if necessary to preserve the main pin with the existing geometry model; document that field and test it.

Keep pin/anchor IDs and thread payloads intact except deletion of secrecy-only flags. Do not conflate note links with layout `pinLinks`. An ordinary save changes body/revision/timestamps and computed geometry if needed, never whole link arrays or unrelated cards.

Create small shared modules for document parsing, editor session state, sizing and activity diff where useful; avoid replacing the entire application shell. Public/private editors share parsing and UI. Persistence and permission adapters remain distinct. New layouts/skins/templates are registry entries with declarative slots/defaults and optional bounded rendering hooks, not new note schema variants or switches scattered through UI.

## Markdown and Profile parsing

Use a single structural parser contract for title, slots, editor styling, preview, saved rendering, search and counts. Render through Foundry sanitization. Do not regex-rewrite every `#` or `---` in source. Fenced code (backticks and tildes with matching lengths), indented code, comments, lists, blockquotes, tables and reference definitions need contextual handling. Do not treat table separator rows as dividers. Disallow setext headings in the note renderer, including `===`; plain-text underlining is not supported. Existing ordinary Markdown tables/tasks/emphasis/links remain available.

Only top-level H1 on physical line 1 can be the title. Other genuine H1 tokens render as H2, including H1 within quoted content, without changing source. Code/comment contents remain untouched. Top-level standalone `---` immediately following a heading, allowing blank lines, becomes its underline; otherwise a horizontal rule. Whitespace-only blank lines do not create visible empty sections.

For selected Profile, consume the title, optional heading rule, standalone image paragraph, optional immediately following H2 caption, then leave all remaining nodes in source order. Ignore intervening blank lines/comments. Resolve reference images structurally even if definitions appear later. Inline and reference image examples belong in tests. Missing title/image or visible content between required slots yields Plain fallback. Render all source content exactly once even on fallback. An image loading error does not invalidate structural Profile; show its alt text and image error affordance.

Raw HTML must not bypass title/slot rules or sanitizer. Do not promote raw `<h1>`/`<img>` to Profile slots; normalize any rendered extra H1 to H2. Preserve raw source, safe rendering and order. The HTML reference uses specimen text, not a production Markdown parser.

## Shared edit protocol and lock state

Lock identity is `{canvasId, noteId, userId, clientSessionId, leaseToken, gmEpoch}`. The active GM issues a fresh token for each grant. Use the verified socket sender, never the userId in an untrusted payload. A second tab under the same user is a different session and cannot reuse the first tab's lease. Only the active GM can grant/revoke; any GM may request a force-unlock through it.

Suggested commands: `beginNoteEdit`, `noteEditHeartbeat`, `previewNoteBody`, `saveNoteBody`, `endNoteEdit`, `forceUnlockNote`, `requestNoteEditState`. Define precise request/response schemas in the approved phase-zero design. Include requestId, client sequence, baseRevision and lease identity where appropriate. Bound text at 200,000 UTF-16 code units (retain existing whole-block size envelope as the whole-document limit), validate finite numbers/IDs/allowed keys, and reject oversized payloads with an explicit editor error. Character activity counts still use Unicode code points.

The authoritative state machine is unlocked → granted → editing → closing → unlocked. Heartbeats keep an idle open editor alive. End-edit flushes a pending save and releases only after acknowledgment. On unavailable transport preserve the draft, stop previews, and allow the lease to expire; a best-effort unload message is not guaranteed. Revoke/expiry/failover invalidates the token before broadcasting unlock. No typing-idle release. Heartbeat every 5 s, lease 30 s. Background tabs that miss the lease become recovery sessions, not silently authorized writers.

Active-GM changes invalidate every previous epoch/token, clear previews, replace lock mirrors, and preserve dirty local drafts. Request a fresh snapshot from the new GM before editing. No GM means shared notes are readable but not writable. Preserve independent private owner access.

All note-mutating handlers must enforce the lock: body, appearance, layout, geometry, delete/restore, transfer/copy, pin attachment/movement, incident thread changes and route insertion. This is a functional extension of lock enforcement, not a redesign of pins. A link/route touching several notes requires all affected notes to be unlocked, except operations explicitly belonging to the requesting note editor; during in-place editing disable structural/pin mutations even for the editor. Allow the holder's body tools and layout/appearance tools. Group operations touching a locked note fail as a whole with a reason; do not partially move a selection. Board free pins unrelated to locked notes remain usable. Restore from history obtains its own short-lived edit session.

GM force-unlock is separate from stealing editing access. Revoke first, retain last acknowledged body, discard remote preview, notify the old editor and leave its local text recoverable. Old-token saves, queued operations and previews are rejected at execution time, not only at enqueue time. An operation already committed before revocation remains valid; do not attempt retroactive rollback.

## Live preview and autosave

Use an ephemeral preview overlay keyed by canvas/note/lease/sequence; it never overwrites persisted note objects in the client store. Send current draft body at most every 150 ms; coalesce intermediate keystrokes. Validate preview sender/token on active GM and relay only within the appropriate shared context. Do not rebroadcast private bodies. Render previews through the same sanitizer/parser as saved text. Discard stale, out-of-order, old-epoch and revoked messages. Late viewers request a snapshot containing active shared preview and current lease state.

Autosave debounces 700 ms and has a 3 s max wait during continuous typing. Maintain one in-flight save per note session, coalescing later edits. A save atomically validates lease/baseRevision, persists body and new revision, then acknowledges the request with persisted revision and input sequence. Keep revision separate from geometry/skin updates so unrelated appearance changes cannot falsely conflict with body text. Preserve serialized GM writes and revalidate active-GM authority inside the queue.

Only exact acknowledged text/sequence can be marked Saved or removed from drafts. An acknowledgment for older text never clears newer typing. A timeout is uncertain, not proof of failure: reconcile current body/revision and requestId before retrying. Maintain bounded request receipts across GM failover (persist the last accepted save identity with the note) to prevent double saves/counters. No-op retry with identical body returns the existing result. Activity/history side effects must be idempotent on accepted save identity; use receipts/reconciliation rather than optimistic UI counts. This is bookkeeping for autosave, not document history in stats.

Preview from a viewer must never be treated as a saved revision. On close, unlock or disconnection, fall back to last confirmed body when the preview is no longer valid. A new editor always starts from confirmed data plus their own explicitly recovered draft. New revision updates cannot tear down the writer's DOM, reset caret/selection/IME, lose undo history or move the viewport.

## Recovery drafts and history

Persist local drafts under origin/world/user/canvas/note identity, with per-session records, body, baseRevision, acknowledged body identity, timestamp and pending save identity. Write on input (150 ms coalescing), blur, pagehide, lock loss and before view switches. Local persistence is independent of socket availability. Keep for 30 days, prune acknowledged/discarded entries, and catch quota/storage errors; never falsely show Saved locally if persistence failed. Store no vault keys; that system is removed.

Reopen compares draft against confirmed body/revision. Identical body needs no recovery. Otherwise present the recovery UI in UI-SPEC; acquire a fresh lease before restoring. If a newer revision exists, show both and offer copy or explicit replacement. No automatic merge, auto-publish or silent overwrite. Deleted/missing notes offer Copy text and Discard only. Distinguish tabs/sessions; one tab must not discard another tab's unacknowledged work.

History stores `{id, at, authorId, revision, body}` per note, newest 20 distinct snapshots. Capture current confirmed body on beginning an edit, checkpoint at most once per 60 seconds of changing saved content, and record final saved body on end-edit. Avoid adjacent duplicates. Before restore preserve current body regardless of cooldown, then restore selected body as a normal revisioned write. Never restore geometry, links, author identity or skin through text history. Preserve history while a note is in trash; empty-trash deletes it. Transfer/copy starts independent history and does not disclose source history. Private history is workspace-local and unavailable in shared search/activity/history.

## Automatic size and geometry

Use board units, independent of viewport zoom. Typography/layout measurement uses rendered content, not raw Markdown syntax or editing toolbar width. For deterministic stable steps, compute intrinsic max-content width of text blocks in an offscreen measurement surface using bundled fonts; clamp breakable/unbroken text safely. Choose the smallest permitted width containing intrinsic content plus 40 px horizontal padding: Plain 220/300/380, valid Profile 300/380. Beyond 380 wrap prose and measure full required height, with minimum 120. Explicit newlines can increase height before the cap; do not erase user line breaks to enforce horizontal growth. Title presence changes typography, not a separate sizing mode. Images alone require at least 300 width, never exceed available inner width, preserve aspect ratio, and do not change layout selection. Profile portrait is centered, max-height 220 with `object-fit: contain`, never cropped; ordinary body images cap at 320 height while preserving full content. Wide tables/code use contained horizontal scrolling.

Recompute during typing and deletion, image decode and font-ready events. One animation-frame geometry update per input/render batch; no resize transitions or step hysteresis that prevents shrinking. Same document/font/skin/layout yields same size for writer and readers. Toolbar, hints, status and title ghost are overlays excluded from card sizing. Manual mode fixes width (160–800) and user-selected minimum height (80–1600); overflow grows the card vertically, never clips or creates a fixed-height text scroll trap. Auto clears manual overrides and recomputes immediately.

Preserve the main pin's world position while auto-size changes width/height, including rotated cards. With center-based rotation, compute the old main pin world point, then solve the new card translation using new dimensions and the unchanged rotation so the same local main pin projects to that point. Do not compensate only with `x -= deltaWidth/2` for rotated cards. If the main pin is disabled, use a virtual top-center anchor. Keep layout/card origins and anchor projection consistent across save, reload, remote preview, fonts and images; derived preview translation must not become cumulative movement or write on every frame.

Other note-attached pins retain existing relative attachment semantics; they may move naturally with the paper but must not detach, change identity, or jump on save. Free pins do not move with auto-size. Reuse finalized connected-DOM measurement from v0.9.5, preserve v0.9.6 selection/copy rules, and refresh thread endpoints in the same geometry pass. No edits to thread material/slack rendering or board picker behavior. If existing geometry cannot meet these invariants without a field change, report the narrowly scoped change before implementing it.

## Activity foundation

Record accepted events only, keyed by UTC day/user/note, with `charsAdded`, `charsRemoved`, `saveCount`, `notesCreated`, `titlesSet`, `imagesAdded`, `threadsCreated`, `largePasteCount`, `templateInsertCount`. Include event identities for deduplication without storing old text. Diff previous confirmed body against next confirmed body using a bounded real text-diff algorithm over Unicode code points. Equal-length replacement must count removals and additions. Describe/test the algorithm's replacement behavior and large-body performance. Do not infer diff from net length.

`saveCount` counts body-changing durable saves, including history restores; retries/no-ops/preview/heartbeat do not count. `titlesSet` counts nonempty derived titles introduced or changed, not removal. `imagesAdded` counts positive multiset differences of parsed image sources outside code/comments. `threadsCreated` counts actual committed new relationships in note links or pinLinks, once, not render or normalization; event-only free-pin relationships use a board sentinel instead of inventing a note owner. Attribute a note relationship to its source note and its authenticated creator.

Persist paste/template event IDs with the next accepted save, then deduplicate; paste text itself is not logged. Large paste threshold is 500 code points, editor paste events only, not inferred from body diff. Events are effort context, not trustworthy ranking inputs. Template creation records one insert even for blank templates; optional template marker text is included in character counts and separately flagged. Publishing/copying onto shared canvas records a new shared note attributed to the publisher with imported body insertion counters; it does not import source activity. No shared activity for private editing, private transfers or private history. Preserve public note creator metadata without showing per-paragraph authors.

Remove aggregate/ranking dialogs, stats toolbar buttons, session-marker management UI, contribution scores and per-player rank calculations. Keep a storage/API layer tested independently; no dashboard replacement.

## Transfers and fresh data

Clipboard, send-to, inbox acceptance, route-note creation and shared publish all use the current body/layout/skin schema. Copy allocates fresh IDs and remaps connections among copied notes/pins. Preserve existing semantics for dropping external relationships, orphan pins, route anchors and free pins. Keep original private note on publishing or sending; no secret-declassify flow. Copies get fresh revision/history/activity identity. Reject unsupported payload versions clearly; never run old-body migration.

Identify incompatible saved data before writing or allowing schema defaults to appear as empty replacement notes. Show the read-only incompatibility notice; do not delete containers or clear module settings. No migration preview, vault archive workflow, backup wizard or production reset script. Fresh test worlds initialize only current shared/history/private/activity structures; no secrets container. Basic unsupported-format detection is not a compatibility adapter.

## Phases and suggested delegated tasks

| Phase | Task ownership | Exit gate |
| --- | --- | --- |
| 0 | Separate read-only agents: data/protocol, editor/UI, private/pins, independent baseline verification | Integrated inventory/design/ownership report; owner approval before runtime edits. |
| 1 | Schema/parser agent; cleanup agent only on disjoint files after contract agreement | Pure document model, registries and fixtures; explicit removals; no dual runtime schema. |
| 2 | Protocol agent owns socket/locks; private agent owns private storage with agreed interfaces | Leases/revisions/preview/autosave receipts and private concurrency tests. |
| 3 | Editor agent owns shared editor/session; private editor adapter agent depends on editor API | In-place toolbar, typing, autosave/recovery and lifecycle tests. |
| 4 | Rendering/geometry agent owns canvas/CSS; coordinate localization ownership | Live grow/shrink, pins, Profile/skin states match reference and tests. |
| 5 | Transfer/routes agent; history/activity agent on disjoint files, serialize socket integration | Copy/publication/trash/restore/activity accepted cases pass. |
| 6 | Independent verification and documentation agent; fixes delegated back to owners | Full checks, actual Foundry multiplayer screenshots/evidence, no removed-feature remnants. |

Phases may contain parallel tasks with non-overlapping ownership; dependencies cannot be skipped. Each task has coordinator-reviewed approval before its author commits. Keep commits coherent and bounded; intermediate dependency commits may require their approved predecessor, but final branch must run. Never delete failing unrelated tests to obtain a pass. Do not implement CRDTs, a new backend, a rich document schema, unrelated theme redesign or a generalized plugin framework.
