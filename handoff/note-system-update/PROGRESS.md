# Note-system rewrite — progress ledger

Coordinator: OpenCode. Runtime branch: `note-system-update-impl` (child of `note-system-update`).
Owner approval: 2026-11-28, Phase 0 gate approved as designed.

## Isolation

| Purpose | Path |
| --- | --- |
| Canonical checkout (untouched) | `/home/Riv/Projects/fvtt-journalinator` @ `note-system-update` |
| Implementation worktree | `/home/Riv/Projects/fvtt-journalinator-impl` @ `note-system-update-impl` |
| Task worktrees | `/tmp/opencode/wt-<task>` (isolated branch per task) |
| Disposable Foundry data root | `/tmp/opencode/foundry-note-system-test` (not yet created) |
| Live Foundry data (prohibited) | `/home/Riv/foundry-v14-data` |

## Baseline evidence (actual run)

- `npm test`: 457 tests, 453 pass, 4 explicit legacy skips, 0 fail (`/tmp/opencode/baseline-test.log`).
- `npm run check`: passes (`/tmp/opencode/baseline-check.log`).
- `tests/ui/smoke.mjs` and `tests/integration.test.mjs` are jsdom/fake-Foundry single-process harnesses; not Foundry multiplayer evidence.
- Phase 0 design: `/tmp/opencode/note-system-phase0-design.md` (copy committed with the ledger when stable).

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
| T7a | Private store v2 + history + local sessions | general | `task/t7a-private` | complete | approved; 79 scoped tests; v3 workspace, non-destructive guard, workspace-local history, local coordinator/transport, no shared preview/activity | `bad08b1` |
| T8 | Canvas rendering + creation/selection UI | general | `task/t8-canvas` | complete | approved; 58 scoped tests; body-only cards, Plain/Profile/skins, creation menu, selection bar, lock badges/gating, editor mount | `c0493a9` |
| T9 | App surfaces (search/trash/history/transfers UI) | pending | `task/t9-app` | in progress | — | — |
| T10 | Sizing + geometry + pin compensation | pending | `task/t10-sizing` | in progress | — | — |
| T11 | Transfers + routes + clipboard | pending | `task/t11-transfers` | in progress | — | — |
| T7 | Private canvas | — | — | queued | — | — |
| T8 | Canvas rendering + creation/selection UI | — | — | queued | — | — |
| T9 | App surfaces (search/trash/history UI) | — | — | queued | — | — |
| T10 | Sizing + geometry + pin compensation | — | — | queued | — | — |
| T11 | Transfers + routes + clipboard | — | — | queued | — | — |
| T12 | i18n + docs + ledger | — | — | queued | — | — |
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

## Deviations

None yet.
