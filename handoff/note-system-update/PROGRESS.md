# Note-system rewrite — progress ledger

Coordinator: OpenCode. Implementation branch: `note-system-update-impl` (child of `note-system-update`). Current implementation head at T12 start: `3d4ccc2`.

Owner approval: 2026-11-28, Phase 0 gate approved as designed.

## Isolation

| Purpose | Path |
| --- | --- |
| Canonical checkout (untouched) | `/home/Riv/Projects/fvtt-journalinator` @ `note-system-update` (`c778b35`) |
| Implementation worktree/branch | `/home/Riv/Projects/fvtt-journalinator-impl` @ `note-system-update-impl` (`3d4ccc2`) |
| T12 worktree/branch | `/tmp/opencode/wt-t12` @ `task/t12-docs` (base `3d4ccc2`) |
| Disposable Foundry data root | `/tmp/opencode/foundry-note-system-test` (exists; not live data) |
| Live Foundry data (prohibited) | `/home/Riv/foundry-v14-data` |

The canonical branch remains untouched until the coordinator approves final integration. Nothing has been pushed, merged, released, packaged for distribution or deployed from the implementation branch.

## Baseline evidence (actual run)

- `npm test`: 457 tests, 453 pass, 4 explicit legacy skips, 0 fail (`/tmp/opencode/baseline-test.log`).
- `npm run check`: passes (`/tmp/opencode/baseline-check.log`).
- `tests/ui/smoke.mjs` and `tests/integration.test.mjs` are jsdom/fake-Foundry single-process harnesses; they are not Foundry multiplayer evidence.
- Phase 0 design: `/tmp/opencode/note-system-phase0-design.md` (copy committed with the ledger when stable).

## Current integrated test evidence (T12 run)

- `node --test tests/i18n.test.mjs`: 5/5 pass.
- `node --test tests/fonts.test.mjs tests/theme.test.mjs`: 35/35 pass.
- `npm run check`: passes.
- `npm test` on the integrated implementation branch: 563 tests, 535 pass, 28 fail. All 28 failures are legacy test files that still import removed modules (`scripts/actor-status.mjs`, `scripts/secrets/*`, `scripts/migrate.mjs`): `actor-status`, `crypto`, `integration`, `model`, `presentation`, `secret-presentation`, `ui-smoke`, `vault-concurrency`. The scoped task suites listed below pass. These legacy test files must be removed or replaced by T13; they are not evidence against the implemented note-system suites.

## Task ledger

| # | Task | Owner agent | Branch | Status | Review | Commit |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Parser + renderer + text derivation | explore/general | `task/t1-parser` | complete | approved after 2 review rounds; 65 scoped tests, full suite 518 pass/4 skip/0 fail; title indentation, comment invisibility and reference-image rendering defects fixed | `ea5f71e` |
| T2 | Schema + registries + templates | general | `task/t2-schema` | complete | approved; 26 scoped tests, full suite 544 pass/4 skip/0 fail; handwriting key is `handwritten` (no legacy `hand` alias) | `c91945f` |
| T3 | Removals + store/init/containers | general | `task/t3-removals` | complete | approved; 10 scoped tests; vault/actor/migration/stats-model removed; v2 read seam + non-destructive schema guard; full suite red only on old vault/UI tests as expected | `99f21ab` |
| T4a | Protocol + leases + autosave core | general | `task/t4a-protocol` | complete | approved after review fixes; 34 scoped tests; whole-note leases, v2 creation, autosave receipts, preview relay, world schema write gate, creation/save/end/force hooks | `bff6e34` |
| T4b | Lock enforcement + geometry/sizing | general | `task/t4b-locks` | complete | approved after 2 review rounds; 50 scoped tests; all structural/pin/route/link/trash writes gated, group move/delete atomic validation, v2 sizing commands, thread/permanent-delete hooks, prune skips locked notes | `dde7062` |
| T5 | History + activity + diff | general | `task/t5-history` | complete | approved; 96 scoped tests; 20 distinct snapshots, cooldown/checkpoints/restore capture, deduped counters, bounded Myers diff, no text stored | `7343c52` |
| T6 | Shared in-place editor + recovery | general | `task/t6-editor` | complete | approved after 3 review rounds; 93 scoped tests; source surface, toolbar/hints, image dialog, recovery, autosave/conflict/event-id fixes | `f1c86fd` |
| T7a | Private store v2 + history + local sessions | general | `task/t7a-private` | complete | approved; 79 scoped tests; v3 workspace with schema v2 notes, non-destructive guard, workspace-local history, local coordinator/transport, no shared preview/activity | `bad08b1` |
| T7b | Private workspace + shared editor/history UI | general | `task/t7b-private-ui` | complete | approved; 39 scoped tests (`private-history-ui`, `private-ui`, `private-store-v2`, `private-history`, `private-session`) pass; private canvas uses shared editor/history, trash/search and no shared preview | `3d4ccc2` |
| T8 | Canvas rendering + creation/selection UI | general | `task/t8-canvas` | complete | approved; 58 scoped tests; body-only cards, Plain/Profile/skins, creation menu, selection bar, lock badges/gating, editor mount | `c0493a9` |
| T9 | App surfaces (search/trash/history/transfers UI) | general | `task/t9-app` | complete | approved; 17 scoped tests (`app-search`, `app-surfaces`, `history-dialog`) pass; derived labels, layout/author filters, read-only notices, history modal, v2 transfer surfaces | `ae424fc` |
| T10 | Sizing + geometry + pin compensation | general | `task/t10-sizing` | complete | approved; 25 scoped tests (`canvas-geometry`, `sizing`) pass; deterministic width steps, vertical growth, manual override, main-pin-preserving origin translation; rotated-origin test aligned in `698fc5e` | `b4d8aaa` |
| T11 | Transfers + routes + clipboard | general | `task/t11-transfers` | complete | approved; 37 scoped tests (`private-transfer-v2`, `route-v2`, `shared-transfer`, `note-protocol`) pass; v2 payloads, fresh IDs/remap, locks, routes, batch publish, unsupported payload rejection | `bb50227` |
| T12 | i18n + docs + ledger | docs/i18n | `task/t12-docs` | in progress — coordinator review pending | EN/RU key parity, used-key coverage, empty-string and dotted-collision checks; docs rewritten against the implemented runtime | uncommitted |
| T13 | Independent verification | — | — | queued | — | — |

## Decisions of record

- Schema v2 as in the approved Phase 0 design; no migration or compatibility aliases.
- `saveNoteAppearance` is an explicit lease-gated command; body and appearance revisions are separate.
- `card.sizing = {mode, width?, minHeight?}` replaces `card.width/height`; `card.autoSizeOrigin` preserves the main pin.
- `lastSave` receipt is persisted on the note for idempotent autosave across GM failover.
- Activity uses the existing hidden `stats` page/container; no stats/ranking UI.
- Private history is in scope and workspace-local.
- Free pins are not transported (preserve v0.9.6 behavior, D19).
- `[[text]]` remains literal; no typed-link reconciliation on save.
- Private editing uses a local per-note lock plus the workspace `rev` guard; it does not require a GM.

## Deviations

- **Title line-height editor compromise.** The editing mirror draws the first-line title at 26 px, but in a 24 px line box so the transparent textarea's caret and selection chrome stay aligned with the visible mirror. The stored/rendered card still uses the documented H1 typography; the editor's title line box is not exactly 1.15.
- **T10/T11 origin fix.** `698fc5e` aligns the geometry test with the rotated creation origin. Automatic size changes translate the card origin so the main pin stays fixed; this is the approved T10 behavior and the test adjustment records it.
- **Batch publish.** T11 adds `publishPrivateNotes` alongside the existing single-note publish path. Each note still gets a fresh v2 page/card and fresh identity; single-note behavior and receipt semantics are unchanged.
- **Private history lazy session-start.** The pre-edit session-start checkpoint is written in the same private page update as the first saved body, not when the editor or history dialog opens. This avoids a workspace write on a read-only open.
- **Hardcoded literals pending T13 localization cleanup.** `scripts/socket.mjs` still sends English-only notices: `Incompatible note data.` (lines ~1356, 1456, 1660, 1702) and `Invalid note payload.` (lines ~1503, 1579, 1709). They are user-visible on rejected socket operations and need localization in a reviewed runtime task.
- **Skin swatch label-key collision (unresolved runtime defect).** The runtime uses `JN.Skin.Paper` and `JN.Skin.Font` for the appearance row labels and `JN.Skin.Paper.*` / `JN.Skin.Font.*` for the individual swatches. Foundry's dotted-key expansion forbids a key being both a string and a parent, so those seven swatch keys cannot be added without renaming one side in runtime code. T12 keeps the row-label keys so the localization suite passes; the seven swatch labels remain raw keys until a reviewed runtime rename (for example `JN.Skin.PaperCream`, `JN.Skin.FontSerif`, …) is authorized. This is not fixable from `lang/*.json` alone.
- **Legacy test files.** The integrated `npm test` run still fails on eight test files that import removed vault/actor/migration modules. T12 does not own or edit tests; T13 must remove or replace them before the suite can be reported green as a whole.

## Still unverified in real Foundry

Node/jsdom coverage is not multiplayer evidence. T13 must check at least:

- Lease acquire/heartbeat/expiry, reconnect, and GM force-unlock across two clients and GM failover.
- Live preview relay between distinct clients, including late joiners and revoked/expired leases.
- Card auto-growth/shrink and pin/thread stability after saves and re-renders at real zoom levels.
- Private local tab coordination through localStorage/BroadcastChannel, including a second tab and stale workspace revision rejection.
- Transfer inbox acceptance/decline, save races, and clipboard/publish while reconnecting.
- History restore while another client holds or loses the lease.
- IME composition, native undo/redo, copy/paste and keyboard shortcuts inside Foundry's application window.
- Old-format shared and private data showing the read-only notice without writing, deleting or resetting anything.
- Control sizing and wrapping on coarse pointers and narrow viewports inside Foundry.
- Bundled paper/font assets loading from the packaged module path.
