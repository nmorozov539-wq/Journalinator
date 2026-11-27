# Acceptance and verification

The coordinator records evidence per case in PROGRESS.md. A pass requires the behavior, not merely a similarly named test. Run `npm test` and `npm run check` against actual dependencies; record counts/skips and baseline failures. Do not assume the obsolete 453/4 count. Use isolated Foundry v14 worlds, never the party's world or live symlink. Unit tests cover logic; real multi-client sessions cover transport, focus and geometry.

## Document and parser

- [ ] New note has one body/revision, no old title/paragraph/actor/secret fields; Foundry internal name stays stable through edits. Duplicate and empty titles create/save/restore successfully.
- [ ] `# Ada` on line 1 is title; later `# Details` renders H2 without source edits. Leading blank/comment line prevents title. `# ` alone has no reader title zone. ATX indentation/closing markers and CRLF work.
- [ ] Code fences of both kinds and variable lengths, indented code, comments, quotes, lists, tables and inline code do not produce false title/portrait/rule slots. Plain text + `---` never produces setext heading; table separator rows remain tables; `===` creates no setext title.
- [ ] Heading + blank line + `---` underlines the heading; ordinary standalone `---` divides. HTML sanitizer prevents executable markup and does not allow raw H1 to bypass title rules.
- [ ] `[[Missing note]]` stays literal through typing, save, copy, restore and reload; no note/thread is created or removed. Body save leaves existing links/pinLinks unchanged.
- [ ] Profile accepts title, optional rule, inline/reference image, optional H2 caption and rest; tolerates inter-slot blank lines/comments. Wrong order/intervening text falls back without hiding/reordering/duplicating content.
- [ ] Switching layouts/skins leaves body byte-for-byte unchanged. Missing optional slots produce no warning. Broken image URL leaves valid Profile structure and shows accessible error.

## Editing and locks

- [ ] Blank/Document/Profile menus, initial source, focus and skins match UI-SPEC. Empty placeholders never appear to readers or enter stored prose.
- [ ] Double-click edits in place; styled title/faint marker; correct toolbar and Profile hints. Title/Divider/Portrait actions preserve source/selection and undo in one logical action.
- [ ] Typing Enter/blank lines/Backspace never recreates paragraph blocks. Native undo/redo, Ctrl/Cmd+S, Escape, dialogs and IME preserve text/caret. No board shortcuts fire while typing.
- [ ] Player A edits while player B and GM watch rendered updates. B joining late receives current preview. A's cursor/undo survives remote note/board updates.
- [ ] B cannot edit/move/resize/delete/restyle/copy/transfer locked note, toggle its task boxes, or mutate incident pins/threads/routes. Mixed group operation rejects as a whole. Unrelated notes/free pins remain usable.
- [ ] Connected editor keeps lock through >60 seconds of typing inactivity and an image picker. Lost connection expires after 30 seconds; browser/tab reload preserves draft. Background-tab lease loss is handled honestly.
- [ ] GM force-unlock removes preview, preserves last saved content and old editor draft. Delayed old-token previews/saves/queued writes fail; new editor can save. Same user's second tab cannot impersonate the lease.
- [ ] GM failover clears old epoch/previews/locks; writer recovers with new lease/revision. No GM leaves shared canvas read-only without blocking private owner workflow.

## Autosave, drafts and failures

- [ ] Preview cadence ≤1 per 150 ms; idle autosave after ~700 ms; continuous typing saves at least every ~3 s excluding transport latency. No-op input/heartbeat creates no writes.
- [ ] Slow save acknowledgment cannot mark newer typing Saved or clear its draft. Out-of-order preview/ack/revision is ignored safely. One in-flight save coalesces later input.
- [ ] Drop the acknowledgment after successful persistence; retry and GM failover do not duplicate revision/history/activity. Conflicting body revision never silently overwrites.
- [ ] Close/change note/change canvas flushes and releases in order. Pagehide does not depend on asynchronous network success. Offline close retains local copy and permits leaving.
- [ ] Recovery after reload offers exact timestamp/text and explicit actions. Newer shared body requires comparison and explicit replacement; revision checked again at confirmation. Missing/deleted note allows copy/discard only.
- [ ] LocalStorage denied/full, private browsing and multiple tabs have correct warnings and draft isolation. Never say saved locally if persistence failed. Acknowledged identical drafts clear; other drafts do not.
- [ ] Invalid/oversized requests are rejected visibly. No sender/author spoofing or unvalidated whole-object writes. Preview sanitization matches saved sanitization.

## Size, appearance and preserved board features

- [ ] Type and delete across 220/300/380 widths while editing; live grow/shrink, then vertical growth at cap. Profile widths 300/380. Writer/reader dimensions agree; explicit line breaks remain.
- [ ] Manual resize fixes width/min-height with visible Auto state; text never clips. Auto immediately recalculates. Long words, tables, code, huge images and Russian titles remain usable.
- [ ] Main pin world position stable within 1 board pixel during growth/shrink at 0°, positive and negative rotations, after image/font load, save, sync, reconnect and reload. No cumulative positional drift across repeated cycles.
- [ ] Other attached pins preserve identity/relative behavior; free pins stay fixed. Thread endpoints track finished geometry in the same frame. No 500 ms pin transitions return.
- [ ] Current board background options, linen/double threads/materials/slack/fade, pin placement/deletion, free-pin box selection, selected-group dragging and route operations retain baseline behavior.
- [ ] Cream/Amber/Parchment, fonts, torn edge/background controls match spec. Seeded tilt stable across clients/reloads, not random per render. Background images do not become portraits.
- [ ] Actual Foundry screenshots cover Blank, Document, valid Profile, each hint state, editing, remote lock/GM unlock, autosave error, recovery and history. Check at typical desktop width, narrow 400 px app viewport, zoomed canvas, English/Russian. No clipping or hidden essential controls.

## Private notes, copies, history and activity

- [ ] Private editor uses same document/UI semantics, preserves owner permissions/admin/inbox behavior and workspace revision guards. Private body/preview/draft/history never enters shared app search/activity/UI.
- [ ] Shared↔private clipboard, private→shared publish, private→private send/inbox all carry body/layout/skin/sizing and remap selected connections. Sources remain. Histories/activity/leases are not copied. Unsupported old clipboard format rejected clearly.
- [ ] Preserve v0.9.6 orphan/free/attached-pin transfer rules, receipts and route filtering; duplicate acceptance cannot duplicate copied notes. Search/trash show derived labels and handle duplicates.
- [ ] History keeps ≤20 distinct snapshots, checkpoint timing and forced pre-restore snapshot. Restore is revisioned and locked; changes text only. Trash retains history; empty-trash deletes it. Private history stays private.
- [ ] Real character diff counts equal-length replacements, Unicode, additions/removals, deletion and restore. No text copies in activity storage. Autosave retries/no-ops/previews produce no duplicate counts.
- [ ] Title/image/thread/template/paste counters follow definitions. Typed 500 chars ≠ a paste; 500-code-point paste increments once after accepted save. Private edits produce no shared counters; publication creates new shared activity.

## Removals and clean break

- [ ] No runtime imports/UI/settings/socket handlers for vault/encryption/secrets/hints/secret views/declassification or actor linking. Location kind gone; board labels, anchor kinds and thread labels remain.
- [ ] No paragraph split/merge/locks, separate note title/image fields, generated-name aliases, stats/ranking/screens/session-marker controls, typed-link reconciliation or old schema migration path.
- [ ] Fresh world initializes new structures without secret containers. Old-format world shows notice without rewriting/deleting data or masking old body as an empty note. No migration/backfill/reset wizard built.
- [ ] Update README/HANDOFF/CHANGELOG and package references. Historical release notes can mention old features; they do not count as runtime remnants. Remove obsolete tests only when their feature is intentionally removed; retain unrelated coverage.
- [ ] Each substantive task has coordinator approval followed by authoring sub-agent commit. Final integrated branch passes required checks; real Foundry evidence or explicit unverified cases recorded. No push, main merge, release or live-world change.
