# Note-system rewrite — progress ledger

Coordinator: OpenCode. Implementation branch: `note-system-update-impl` (child of `note-system-update`). Current implementation head: `283fbd1` (T15 `52acca1` plus final verification ledger).

Owner approval: 2026-11-28, Phase 0 gate approved as designed.

**Final status:** implemented and integrated on `note-system-update-impl`. Unit suite 593/593 pass, `npm run check` passes. Real Foundry v14 verification with GM + two players passed the tested scope after T14/T15 fixes; remaining unverified cases are listed in the T15 section. `note-system-update` itself has not been advanced, pushed, merged to main, released or deployed.

**Task rows T1-T12 were committed on their task branches and integrated in dependency order; T13a/T14/T15 are the independent verification/convergence/fix chain.**

## Owner actions / integration boundary

The work is complete on `note-system-update-impl`. The canonical `note-system-update` branch (checked out and symlinked into the live Foundry data root) has deliberately not been advanced, because doing so would deploy unreviewed runtime code into that installation. After owner review, integrate with:

```sh
git -C /home/Riv/Projects/fvtt-journalinator merge --ff-only note-system-update-impl
```

No push, main merge, release, packaging or live-world change was performed. Remaining unverified cases are listed at the end of the T15 section; the most important are private transfers/inbox, IME/undo/copy-paste, background tabs, GM failover, locked restyle/copy/transfer/checkbox, and RU UI (the verification Foundry install ships only core English).

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

## Current integrated test evidence

- Final `npm test`: **593 tests, 593 pass, 0 fail, 0 skipped**.
- Final `npm run check`: **passes**.
- Real Foundry v14 verification: T15 section below (GM + two players, disposable roots/ports, real screenshots).
- The T13/T14 FAIL sections below are retained as chronological history and are superseded by the T15 pass table.

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
| T12 | i18n + docs + ledger | docs/i18n | `task/t12-docs` | complete | EN/RU key parity, used-key coverage, dotted keys renamed, socket notices localized; docs rewritten against the implemented runtime | `0629f28` |
| T13a | Test convergence | verification | `task/t13a-tests` | complete | obsolete suites removed with their subsystems; integration/UI/pin suites rewritten for v2; full suite 572/572 | `8c1137a` |
| T13b | Independent real Foundry verification | verification | `task/t13b-foundry` | complete in tested scope | GM + two players on disposable Foundry 14.367; screenshots/logs in `/tmp/opencode/note-system-evidence/`; T14/T15 blockers fixed and re-verified; unverified list recorded | ledger commit |
| T14 | Real-Foundry UI fixes | verification/fixes | `task/t14-foundry-fixes` | complete | editor chrome CSS, canvas pointer/dblclick routing, close/re-acquire guard, recovery/history visibility, unlock reachability/name, legacy guard; 581/581 | `7afbc57` |
| T15 | Cross-session/status fixes | verification/fixes | `task/t15-session-fixes` | complete | sequence seeded from grant receipt, forced reason propagated, selection-bar/unlock stacking, rejected-save copy; 593/593 | `52acca1` |

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
- **Socket notices localized in T12.** `scripts/socket.mjs` now uses `JN.Notices.IncompatibleData` / `JN.Notices.InvalidNotePayload`; no hardcoded English notices remain in that path.
- **Skin swatch keys renamed in T12.** `PAPERS`/`FONTS` label keys are `JN.Skin.PaperCream`/`JN.Skin.FontDefault` etc., avoiding Foundry's dotted-key collision with the row labels.
- **Legacy test convergence in T13a.** Removed-feature suites were deleted; integration/UI/pin/route tests were rewritten for v2. Final suite is 593/593.

## Real Foundry verification

Real-client evidence and the PASS/FAIL/UNVERIFIED tables are in the T13/T14/T15 sections below. The final T15 pass is authoritative; earlier T13/T14 FAIL sections are retained as chronological history.

---

# T13 / T13b — real Foundry v14 verification (2026-11-28)

**Verdict: FAIL at this historical HEAD (`8c1137a`) — superseded by T14/T15.** Foundry launches, the module loads, and single-client data flows work, but real Chromium exposed UI and lock-protocol defects that the jsdom suite could not see. Those defects were fixed in T14/T15 and re-verified; see the T15 pass section. No runtime/tests/lang/docs were edited for this verification; only this ledger.

## Environment actually used

| Item | Value |
| --- | --- |
| Foundry | 14.367 (Stable build 367), Electron 41.3.0 / Chromium 146 |
| System | Pathfinder Second Edition 7.4.3 (copied from live root; `system.json` targets v13.348, max v14) |
| Module | `/home/Riv/Projects/fvtt-journalinator-impl` @ `8c1137a`, version 0.9.6, symlinked into the disposable root |
| Fresh world | `journalinator-note-test` (created through `/setup` → Create World, system `pf2e`) |
| Main disposable root | `/tmp/opencode/foundry-note-system-test` (port **30002**) |
| Incompatible-format root | `/tmp/opencode/foundry-note-system-test-incompat` (copy of the main root, port **30003**) |
| Live root / port | `/home/Riv/foundry-v14-data`, port 30001 — **never started, read, or written by this run** |
| Users | `Gamemaster` (blank password), `Player A`, `Player B`; player password stored only in `/tmp/opencode/note-system-test-users.txt` |
| Browser automation | Playwright 1.64.1 + system Chrome 146 via `/usr/bin/google-chrome-stable` |
| Evidence root | `/tmp/opencode/note-system-evidence/` |
| Harness scripts | `/tmp/opencode/t13b/*.mjs`; raw runs in `/tmp/opencode/t13b/*.out` |

Launch commands (both stopped after verification):

```sh
DISPLAY=:0 /home/Riv/foundry-v14/foundryvtt \
  --dataPath=/tmp/opencode/foundry-note-system-test \
  --port=30002 --noupnp --noupdate
# incompatible copy:
DISPLAY=:0 /home/Riv/foundry-v14/foundryvtt \
  --dataPath=/tmp/opencode/foundry-note-system-test-incompat \
  --port=30003 --world=journalinator-note-test --noupnp --noupdate
```

No license key was required: this build stubs license verification. Playwright used a single Chromium launch with three contexts and `--disable-gpu --disable-dev-shm-usage`; with GPU/SwiftShader the browser repeatedly crashed with three concurrent Foundry clients in this 5.7 GB host. Foundry showed its "no hardware acceleration" warning. That warning is environmental; the pointer-capture, stacking and missing-CSS defects below are DOM/CSS/Chromium behavior and are not specific to software rendering.

## Test counts (actual run at this HEAD)

- `npm test`: **572 tests, 572 pass, 0 fail, 0 skipped** — log `unit-tests-t13b.log`.
- `npm run check`: passes — log `check-t13b.log`.
- These are **not** Foundry evidence. The real-client findings below override the green unit suite.

## Per-case results

Legend: PASS = observed in real Foundry; FAIL = observed broken; UNVERIFIED = not exercised / blocked.

| Case | Result | Evidence / note |
| --- | --- | --- |
| Foundry launches on 30002 with a fresh world | PASS | `/tmp/opencode/foundry-30002.log` |
| Module active; note/layout/activity/history v2 models registered | PASS | `module-load.log`: `fvtt-journalinator.{note,layout,activity,history}`, module active, 0 console errors |
| No removed vault/secret/actor runtime surfaces on load | PASS | `module-load.log` (only module active; no removed-module errors) |
| GM + two player clients open Journalinator | PASS | `three-clients-gm.png`, `three-clients-pa.png`, `three-clients-pb.png`; controls `aria-label="Journalinator"` |
| Creation menu: Blank / Document / Profile order and copy | PASS | `creation-menu-gm.png`, `creation-states.log` |
| Blank payload: empty body, Plain, Amber/Handwritten | PASS | `creation-blank-editor-gm.png`; `creation-states.log` |
| Document payload: Plain/Cream/Default; title marker | PASS (data) | `creation-document-*.png`; initial focus not inspected |
| Profile payload: Profile layout, Parchment/Serif, fallback class | PASS (data) | `creation-profile-initial.png`; body is `#` without trailing space |
| One in-place source surface (single textarea) | PASS | `editorInfo().value`; one `.jn-source-input` |
| Editor visual chrome per UI-SPEC (horizontal Title/Divider/Portrait/…/Done, status row, hint, Profile helper) | **FAIL** | `defect-01-unstyled-editor-toolbar.png`: toolbar is a vertical stack of Foundry default buttons; **0** CSS rules mention `jn-editor-tool`. `creation-profile-initial.png` shows helper text overlapping the paper and other cards |
| Double-click a card opens editing at the pointer | **FAIL** | `defect-03-dblclick-no-editor.png`, `ui-defect-repro.log`: native `dblclick` target is `DIV.jn-canvas`, never `.jn-card`; no editor opens |
| Clicking editor toolbar buttons / Done works with a real mouse | **FAIL** | `defect-02-…`, `ui-defect-repro.log`: real click on Done leaves the editor open; JS `.click()` closes it. Canvas calls `setPointerCapture` on the root for card presses, retargeting the click |
| Typing updates source and autosaves to `Saved` | PASS | `editor-life-test.log` (`Saving…` → `Saved`); `sync-01` |
| Second client sees rendered body/live preview while first edits | PASS | `sync-02-player-a-live-preview.png` (Player A saw “Gamemaster is editing” + body) |
| Late-joining client sees current preview | UNVERIFIED | not exercised |
| Title styled in the editor (H1 styling / faint marker) | **FAIL** | title rules = 0; source surface only has inline positioning. `creation-states.log` |
| Profile helper / hint states render visibly and unobstructed | **FAIL** | helper text present but unstyled and overlapped (`creation-profile-initial.png`) |
| Lock badge names the editing user for GM and players | PASS | `lock-02-gm-sees-lock-and-unlock.png`, `lock-03-player-b-sees-lock.png` (“Player A is editing”) |
| Locked note cannot be moved by Player B | PASS | `lock-04-player-b-move-blocked.png`; box unchanged after drag |
| Locked note cannot be opened/edited by Player B | PASS | Edit button disabled; locked card does not select (`lock-test2.out`) |
| Locked note cannot be resized/deleted/restyled/copied/transferred/task-toggled | UNVERIFIED | not individually exercised |
| GM sees an Unlock control on a locked card | PASS | `lock-02…`, `force-unlock-01-real-click.png` |
| GM force-unlock through the UI | **FAIL** | real click on card Unlock is swallowed; JS click opens a Foundry dialog; dialog submit never emitted `forceUnlockNote` and lock remained (`force-unlock-trace.log`, `force-unlock2-dialog.png`). Dialog says “End **someone’s** editing session?” instead of the player’s name |
| Done / Escape releases the lock for other clients | **FAIL** | `release-test.log`, `escape-trace2.log`, `release2-gm-after-pa-escape.png`: after Escape the server sends `noteEditRevoked`, then the editor’s own `journalinatorEditStateChanged` calls `onLeaseLost` → `onRequestEdit` → a **second `beginNoteEdit`** before `noteEditEnded`. The second session’s end is rejected `sequenceOutOfOrder`; lock stays until expiry |
| Lock expires after disconnect/reload (~30 s) | PASS | `recovery-test.log`: GM lock cleared ~27 s after the reloaded client was ready (~49 s wall clock including 22 s page load) |
| Reload preserves the unsaved draft | PASS | recovery dialog carried `UNCOMMITTED-DRAFT` |
| Recovery prompt is visible and actionable | **FAIL** | `recovery-01-dialog.png`: prompt exists in DOM with exact text/actions but is not visible; `.jn-canvas` intercepts pointer events and “Recover draft” cannot be clicked (`recovery-test.log`) |
| Background-tab lease behaviour | UNVERIFIED | not exercised |
| No-GM shared canvas: readable, not writable, banner shown | PASS | `nogm-01-banner.png`: banner “A GM must be connected to edit shared notes.”, `+ Note` disabled, Edit disabled, cards readable |
| More → History opens | PASS | `history-01-more-menu.png`, `history-02-dialog.png` |
| History list/preview layout | **FAIL** | `history-02-dialog.png`, `history-03-selected-old.png`: entries overlap vertically; preview pane is blank; no `.jn-history-*` CSS exists |
| Restore confirmation, restore, pre-restore checkpoint | PASS | `history-04-confirm.png`, `history-05-after-restore.png`, `history-06-after-restore-dialog.png`; toast “Version restored”; new current entry retained old current |
| Width steps 220/300/380 and shrink while typing | UNVERIFIED | automated long-line run lost the editor mid-run; no trustworthy width series collected |
| Profile 300/380 | UNVERIFIED | not exercised |
| Main pin stable within 1 px at 0/positive/negative rotation across save/reload | UNVERIFIED | not measured |
| Manual resize + Auto state | UNVERIFIED | not exercised |
| Cream/Amber/Parchment and font template mapping | PASS (data) | templates produced amber/cream/parchment + handwritten/default/serif |
| Appearance controls (paper/font/torn/background) | UNVERIFIED | editor toolbar controls unclickable; selection-bar controls not exercised |
| Desktop-width screenshots | PASS | 1200–1400 px captures throughout |
| Narrow 400 px app viewport | PASS (layout) | `narrow-400-app-viewport.png`; app/root widths 398/398, toolbar 318, no horizontal overflow. Editor visuals still broken |
| Zoomed canvas | UNVERIFIED | not exercised |
| English UI | PASS | all screenshots |
| Russian UI | UNVERIFIED | this Foundry install ships only core `en.json`; module `lang/ru.json` exists but the full client cannot be switched to RU here |
| Incompatible-format notice in a separate copy, no writes | PASS | `incompatible-01-notice.png`, `incompatible-notice.log`; notice shown, 0 cards; legacy page SHA-256 unchanged before/after |
| Legacy page **without** an explicit `schemaVersion` is detected | **FAIL / guard gap** | Foundry’s note data model defaulted the missing `schemaVersion` to `2`; the page rendered as a current note and no notice appeared. Only an explicit `schemaVersion: 1` triggered the notice |
| Private canvas, shared/private transfers, inbox | UNVERIFIED | not exercised |
| IME, native undo/redo, copy/paste, keyboard shortcuts | UNVERIFIED | not exercised |
| GM failover / multiple GMs | UNVERIFIED | not exercised |

## Bugs found (minimal reproduction)

1. **Editor chrome has no stylesheet (critical, visual/usability).** `.jn-editor-toolbar` is only absolutely positioned; there are zero CSS rules for `.jn-editor-tool`, `.jn-source`, `.jn-editor-subrow`, `.jn-editor-hint` or `.jn-editor-profile-helper`. Repro: open any note; the toolbar appears as a vertical column of default Foundry buttons above/below the paper, status reads `Editing · YouSaved`, and the Profile helper/ghost overlap the card. Evidence: `defect-01-unstyled-editor-toolbar.png`, `creation-profile-initial.png`, `creation-states.log`.
2. **Canvas pointer capture retargets card-child clicks (critical).** `JournalCanvas` calls `root.setPointerCapture(pointerId)` on card pointerdown. Subsequent `click`/`dblclick` events target `.jn-canvas`, so in-card controls never receive clicks and native double-click editing never fires. Repro: select a note → Edit → real mouse click Done (nothing); double-click the card body (no editor; trace shows target `DIV.jn-canvas`). Evidence: `ui-defect-repro.log`, `defect-02-after-done-js-close.png`, `defect-03-dblclick-no-editor.png`.
3. **A player re-acquires its own lease while closing (critical, multiplayer).** On `endNoteEdit`, the GM broadcasts `noteEditRevoked`; the closing client treats its own revocation as `leaseLost`, calls `onLeaseLost → onRequestEdit → #beginEditing`, and sends a second `beginNoteEdit` before `noteEditEnded`. The second end is rejected `sequenceOutOfOrder`, so the lock remains until expiry. Repro: Player A edits → Escape; GM keeps “Player A is editing” >12 s. Evidence: `escape-trace2.log`, `begin-stack.log`, `release2-gm-after-pa-escape.png`.
4. **Recovery dialog is behind the board (critical).** The prompt is in DOM with the correct draft and actions, but invisible and pointer-blocked by `.jn-canvas`. Repro: edit → reload before autosave → open note → recovery prompt exists; screenshot shows no dialog; clicking “Recover draft” is intercepted. Evidence: `recovery-01-dialog.png`, `recovery-test.log`.
5. **History dialog is visibly broken (high).** Entries overlap; the right preview pane is blank. Restore logic itself works. Repro: select a note → More → History. Evidence: `history-02-dialog.png`, `history-03-selected-old.png`.
6. **GM force-unlock is not reachable end-to-end (high).** Card Unlock needs a JS click; the dialog says “someone’s” instead of the player name; submitting it did not emit `forceUnlockNote` in the socket trace, and the lock stayed. Repro: Player A holds a note → GM click Unlock → confirm. Evidence: `force-unlock-trace.log`, `force-unlock-02-confirm-dialog.png`, `force-unlock2-dialog.png`.
7. **Schema guard can miss legacy pages with no `schemaVersion` (medium).** Foundry’s note model injects the default `2` before the guard sees the page. A legacy-shaped page with `schemaVersion: 1` is correctly rejected (`incompatible-01-notice.png`), but a page with the field omitted was treated as current. Needs a guard that checks the raw stored shape/version, or a legacy marker.
8. **Localization debt still visible.** The unlock dialog’s generic “someone’s” text and the editor chrome status spacing (`Editing · YouSaved`) are user-visible. The hardcoded English socket notices from T12 remain.

## Owner actions

1. Add the missing editor/history/recovery CSS and re-check at 400 px and desktop widths.
2. Replace canvas pointer capture on cards with capture that excludes interactive descendants (or release before click / hit-test the real target), so `dblclick`, toolbar, lock-unlock and dialog buttons work with a real mouse.
3. Fix the close race: ignore the editor’s own `noteEditRevoked` while `close()` is in flight; never call `onRequestEdit` from a self-end revocation. Add a real two-client regression test for Done/Escape releasing the lease.
4. Portal recovery (and any other modal) to `document.body` at a z-index above the app/canvas.
5. Fix history list scrolling/height and render the preview pane.
6. Pass the lease user name into the force-unlock dialog and make its submit path testable/clickable.
7. Harden the schema guard against missing/defaulted `schemaVersion`.
8. Re-run this real-Foundry matrix after fixes. The 572/572 jsdom suite is not sufficient evidence.

## Limitations

- Headless Chromium used software rendering (`--disable-gpu`); three concurrent GPU clients crashed this host. Screenshots are real Foundry UI, but frame rate is low.
- PF2e 7.4.3 is a v13-targeted system; some launches log pf2e hook errors (`settings` undefined, unregistered `pf2e.*` settings). These are system-side and not counted against Journalinator, but they can make scene controls/chat noisy.
- Some modal interactions (Foundry `DialogV2` submit, recovery button) could not be driven by Playwright because the board/overlay intercepted pointer events. They are recorded as UI failures; the server-side force-unlock path was not proven either way.
- Not exercised: late join, GM failover, private canvas/transfers, IME/undo/paste, background tabs, pin/width measurements, zoom, RU. These remain unverified.
- All disposable Foundry processes were stopped. Ports 30002/30003 are closed; port 30001 was never started, read or written. The disposable roots and `/tmp/opencode/note-system-evidence/` are left in place for coordinator review.

---

# T14 re-verification — real Foundry v14 after integration fixes (2026-11-28)

Implementation re-tested at `/home/Riv/Projects/fvtt-journalinator-impl` HEAD `7afbc57` (`Fix real Foundry editor interaction, dialogs and legacy guard`). Same disposable root, ports, world and module symlink as T13. Nothing was committed or pushed; only this ledger changed.

## Environment / commands

| Item | Value |
| --- | --- |
| Foundry | 14.367 build 367 |
| System / world | PF2e 7.4.3 / `journalinator-note-test` |
| Module | `7afbc57`, v0.9.6, symlinked at `/tmp/opencode/foundry-note-system-test/Data/modules/fvtt-journalinator` |
| Main root / port | `/tmp/opencode/foundry-note-system-test` — **30002** |
| Incompatible root / port | `/tmp/opencode/foundry-note-system-test-incompat` — **30003** |
| Live root / port | `/home/Riv/foundry-v14-data`, 30001 — untouched |
| Unit checks | `npm test`: **581 pass / 0 fail / 0 skip**; `npm run check`: pass (`t14-unit-tests.log`, `t14-check.log`) |

Exact launch form (the `--world` arg is required; without it Foundry stayed on `/setup`):

```sh
DISPLAY=:0 /home/Riv/foundry-v14/foundryvtt \
  --dataPath=/tmp/opencode/foundry-note-system-test \
  --port=30002 --world=journalinator-note-test --noupnp --noupdate

DISPLAY=:0 /home/Riv/foundry-v14/foundryvtt \
  --dataPath=/tmp/opencode/foundry-note-system-test-incompat \
  --port=30003 --world=journalinator-note-test --noupnp --noupdate
```

Clients: GM + Player A + Player B (Chromium 146 via Playwright 1.64.1, `--disable-gpu --disable-dev-shm-usage`). Both Foundry processes stopped after the run.

## Previously failing items — re-test result

| # | Previously failed case | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Styled editor toolbar and real mouse controls | **PASS** | `t14-01-editor-toolbar-styled.png`: toolbar is flex/wrap, 440×54 px, six controls in one row; title mirror is 26 px / 700 with `.45` marker. Real clicks applied Title, Divider, Layout→Profile, Appearance→Amber/Serif, opened the Portrait image dialog, and closed with Done. `t14-02`…`t14-06`, `t14-editor-ui.log` |
| 2 | Double-click card text opens the editor at the clicked text | **PASS** | `t14-08-dblclick-editor.png`: editor opened; textarea focused with `selectionStart=1` inside the clicked title line (`t14-editor-ui.log`) |
| 3 | Done/Escape releases the lock; no second begin/re-acquire; one end | **PASS for a first close, FAIL for a second close in the same page** | First close: PA socket trace shows exactly one `beginNoteEdit`, one `endNoteEdit`, one `noteEditRevoked(ended)`, one `noteEditEnded`; PA lock cleared on the first poll (`t14-close-test.log`, `t14-sequence-test.log`). Reopening the same note in the same page and pressing Escape hits `sequenceOutOfOrder`; the editor stays `rejected` and the lock stays held until expiry (`t14-reject-reason.log`, `t14-seq-lock-repro.log`, `t14-53-player-blocked-by-gm-stuck-lock.png`, `t14-54-gm-rejected-editor.png`) |
| 4 | Recovery dialog visible and clickable above the board | **PASS** | `t14-14-recovery-dialog-visible.png`: full-screen overlay, panel visible, exact draft/timestamp, “Recover draft” clicked; restored text opened in the editor (`t14-15-recovery-editor-restored.png`, `t14-recovery-test.log`) |
| 5 | History list/preview layout and rendered preview | **PASS** | `t14-22-history-dialog.png`, `t14-23-history-preview-content.png`: entries 35/66/66 px high with no overlap; preview rendered `<h1>` + `<p>`; `t14-52-history-restore-confirm.png` shows confirmation and “Version restored” toast (`t14-history-test.log`, `t14-history-restore2.log`) |
| 6 | GM Unlock names holder; one force command; player forced state | **PARTIAL** | Name/reachability PASS: dialog reads “End Player A’s editing session?” and one `noteEditRevoked(reason=forced)` reached PA after a real confirm click (`t14-19-force-unlock-dialog-named.png`, `t14-force-unlock-test2.log`). Player state is **FAIL**: PA entered `leaseLost` with “Editing connection lost. Reopen the note to recover your draft.”, not the forced/GM-ended state (`t14-20-player-forced-state.png`). A selected locked card also puts the selection-bar notice over the card’s Unlock button; GM must deselect first (`t14-16-force-unlock-dialog-named.png`) |
| 7 | Legacy page with **missing** `schemaVersion` detected, no writes | **PASS** | `t14-48-incompatible-missing-schema.png`: notice shown, 0 cards; legacy page SHA-256 unchanged before/after (`t14-legacy-missing-schema-before.sha256`, `t14-incompatible-missing-schema.log`) |

## Remaining matrix — re-test result

| Case | Result | Evidence |
| --- | --- | --- |
| Late-joining client sees current preview + lock | **PASS** | `t14-33-late-join-preview.png`: Player B launched mid-edit saw body + “Gamemaster is editing” |
| Locked note: player cannot move/resize/delete/toggle | **PASS** | `t14-31-locked-card-player.png`; locked drag unchanged, resize handle hidden, Delete did not remove the card (`t14-lock-drag.log`) |
| Locked note: restyle/copy/transfer/checkbox | UNVERIFIED | not individually exercised |
| Lock expiry after reload/disconnect (~30 s) | **PASS** | `t14-recovery-test.log`: GM lock cleared 43.5 s after reload start (23.6 s load), i.e. ~20 s after ready; consistent with 30 s lease |
| Recovery draft after reload | **PASS** | `t14-14`, `t14-15` |
| No-GM banner / read-only shared canvas | **PASS** | `t14-34-no-gm-banner.png`: exact banner, `+ Note` disabled, Edit disabled, notes readable |
| Width steps Plain 220/300/380 + shrink | **PASS** | 220→300→380→380→380, shrink back to 220 (`t14-size-test.log`, `t14-35-size-max-width.png`) |
| Profile 300/380 | **PASS** | valid Profile 300 at 300 px with 1×1 portrait, 380/383 with longer text (`t14-profile300.log`, `t14-56-profile-300.png`, `t14-41-profile-300-380.png`) |
| Manual resize + Auto | **PASS** | 220→323 manual (`.jn-sized`), Auto→220 (class removed) (`t14-manual-pin.log`, `t14-37`, `t14-38`) |
| Main pin stable at 0/positive/negative rotation across reload | **PASS** | pin world `left/top` deltas 0 / 0 for `0deg`, `0.1deg`, `-0.7deg` (`t14-manual-pin.log`, `t14-39`) |
| Main pin stable during 220→380 growth and shrink | **PASS** | pin left/top unchanged while width 220→380→220 (`t14-pin-grow-profile.log`, `t14-40`) |
| Skins: Amber/Cream/Parchment + fonts | **PASS** | template and appearance controls produce the expected paper/font tokens (`t14-05-appearance-applied.png`, `t14-41`) |
| EN UI / narrow 400 px / zoom | **PASS (EN/narrow); zoom screenshot only** | `t14-42-narrow-400-app.png` (398/398 app/root, no overflow), `t14-43-zoomed-canvas.png`; zoom scale was not numerically asserted |
| RU UI | UNVERIFIED | Foundry install ships only core `en.json`; module `lang/ru.json` exists but the client cannot switch to RU here |
| Private canvas creation and isolation | **PASS (basic)** | `t14-45-private-created.png`, `t14-46-private-note.png`, `t14-47-shared-after-private.png`: private note absent from shared |
| Private/shared transfers, inbox | UNVERIFIED | not exercised |
| IME/undo/copy-paste/background tab/GM failover | UNVERIFIED | not exercised |

## Remaining blockers / bugs

1. **Second editor session in the same page fails to save/close (`sequenceOutOfOrder`).** Critical. The lease uses a per-page `clientSessionId`, but each new `NoteEditorSession` starts `_sequence` at 0 while the server keeps the previous session’s `lastSave.sequence`. A save/end whose sequence is lower is rejected. Repro: type, wait for autosave, type again, Done; reopen the same note; Escape. Editor state becomes `rejected` with `status.error = "sequenceOutOfOrder"`, the editor stays open, and the lease remains visible to other clients until expiry. The UI mislabels this as “Recovery copy unavailable in this browser.” Evidence: `t14-reject-reason.log`, `t14-seq-lock-repro.log`, `t14-54-gm-rejected-editor.png`, `t14-53-player-blocked-by-gm-stuck-lock.png`. Fix: seed the session sequence from the `beginNoteEdit` reply’s `lastSave.sequence` (the reply already includes it), or make the counter monotonic per page/client-session; distinguish a sequence rejection from a storage failure in the status UI.
2. **Players receive `leaseLost`, not `forced`, after GM unlock.** The GM path calls `journalinatorNoteForceUnlocked` locally; remote clients only see `noteEditRevoked(reason=forced)` and the editor converts the cleared mirror to `leaseLost`. Result: “Editing connection lost” instead of a GM-ended message. Evidence: `t14-20-player-forced-state.png`, `t14-force-unlock-test2.log`. Fix: surface the revocation reason/reason `forced` to `NoteEditor` and render the forced state; keep stale saves rejected.
3. **Selection-bar notice covers the card’s GM Unlock button.** With a locked note selected, the notice row (“A note in this selection is being edited…”) sits above the lock badge and intercepts the click; the GM must deselect first. Evidence: `t14-16-force-unlock-dialog-named.png`. Fix: keep the notice clear of the badge or raise/relocate the badge/Unlock control.
4. **Status wording conflates rejection with storage.** `sequenceOutOfOrder` is shown as “Recovery copy unavailable in this browser.” even though `localStorage` is available; this makes the remaining bug look like a storage problem. Evidence: `t14-reject-reason.log`.

## Owner actions

1. Fix the per-page session sequence (blocker above) and add a real two-client regression loop: edit → autosave → Done → reopen → Escape.
2. Propagate `reason=forced` to remote editors so the forced state/message is correct.
3. Fix the selection-bar/lock-badge stacking so GM Unlock is clickable without deselecting.
4. Re-run the T14 harness; the 581/581 jsdom suite still does not cover these cross-session/pointer/stacking cases.

## Remaining limitations

Headless Chromium used software rendering; PF2e 7.4.3 is a v13-targeted system and logs system-side hook errors in some launches (not counted against Journalinator). Private transfer, IME/undo/paste, background tabs, GM failover and RU remain unverified. All disposable Foundry processes were stopped; ports 30001/30002/30003 are closed and the live root was untouched. Evidence is under `/tmp/opencode/note-system-evidence/t14-*` with harness runs in `/tmp/opencode/t13b/t14-*.out` and logs.

---

# T15 re-verification — final disposable Foundry pass (2026-11-28)

Implementation re-tested at `/home/Riv/Projects/fvtt-journalinator-impl` HEAD `52acca1` (`Fix cross-session save sequencing and forced-lock feedback`). Same roots, ports, world and module symlink. Nothing was committed or pushed; only this ledger changed. Both Foundry instances are stopped; port 30001/live root untouched.

## Environment / exact commands

| Item | Value |
| --- | --- |
| Foundry | 14.367 build 367 |
| System / world | PF2e 7.4.3 / `journalinator-note-test` |
| Module | `52acca1`, v0.9.6, symlinked at `/tmp/opencode/foundry-note-system-test/Data/modules/fvtt-journalinator` |
| Unit checks | `npm test`: **593 pass / 0 fail / 0 skip**; `npm run check`: pass (`t15-unit-tests.log`, `t15-check.log`) |
| Main root / port | `/tmp/opencode/foundry-note-system-test` — 30002 |
| Incompatible root / port | `/tmp/opencode/foundry-note-system-test-incompat` — 30003 |

```sh
DISPLAY=:0 /home/Riv/foundry-v14/foundryvtt \
  --dataPath=/tmp/opencode/foundry-note-system-test \
  --port=30002 --world=journalinator-note-test --noupnp --noupdate

DISPLAY=:0 /home/Riv/foundry-v14/foundryvtt \
  --dataPath=/tmp/opencode/foundry-note-system-test-incompat \
  --port=30003 --world=journalinator-note-test --noupnp --noupdate
```

Clients: GM + Player A + Player B (Chromium 146 via Playwright 1.64.1, `--disable-gpu --disable-dev-shm-usage`).

## The four remaining blockers — re-test

| Blocker | Result | Evidence |
| --- | --- | --- |
| 1. Second editor session: type→autosave→type→Done→reopen→Escape must save/release; one begin/end; lock clears; Saved/Saving only | **PASS** | PA first session: preview seq 3/4, save seq 5, end seq 6. Second session seeded from the grant: preview 6, save 7, end 8; **0 rejected, 0 diag**; exactly 2 begins/2 ends total (one per session). Editor closed, GM lock cleared on the first poll. GM second session also closed cleanly. `t15-seq-fixed.log`, `t15-01-pa-second-session-escape.png`, `t15-02-gm-second-session-escape.png` |
| 2. Remote force unlock shows forced/GM-ended state + copy, not lease-lost | **PASS** | PA state `forced`, text “The GM ended this editing session. Your unsaved text is kept locally.”, actions `Close` / `Copy text`. One `noteEditRevoked(reason=forced)`. `t15-05-player-forced-state.png`, `t15-force-fixed.log` |
| 3. Selection bar must not cover GM Unlock; clickable while selected at desktop and narrow | **PASS** | Desktop selected: bar y=169..239, Unlock y≈254, `elementFromPoint` = `jn-lock-unlock`; real click opened “End Player A’s editing session?”. Narrow 400 px selected: bar y=183..253, Unlock y≈268, hit = `jn-lock-unlock`; real click opened the same dialog. `t15-18-desktop-selected-unlock.png`, `t15-19-desktop-selected-dialog.png`, `t15-14-narrow-selected-unlock-visible.png`, `t15-15-narrow-selected-unlock-dialog.png`, `t15-desktop-selected-click.log`, `t15-narrow-unlock3.log` |
| 4. Rejected save uses server-save-failed copy with draft kept, not storage-unavailable | **PASS** | Induced `staleRevision` conflict: state `conflict`, error `staleRevision`, `draftError:null`; text “Couldn’t save. Your draft is kept on this device.”; actions `Retry` / `Copy text`; draft key present in localStorage. `t15-16-rejected-status-draft-kept.png`, `t15-reject-status.log` |

## Re-confirmed matrix

| Case | Result | Evidence |
| --- | --- | --- |
| Late join sees current preview + lock | **PASS** | `t15-33-late-join-preview.png`: Player B launched mid-edit saw body + “Gamemaster is editing” |
| Locked mutation blocks (move/resize/delete) | **PASS** | `t15-17-locked-mutation-blocked.png`, `t15-lock-blocks.log`: drag unchanged, resize hidden, Delete kept the card; lock cleared first poll after Done |
| Disconnect/reload + lock expiry | **PASS** | `t15-14-recovery-dialog-visible.png`, `t15-15-recovery-editor-restored.png`: recovery dialog visible/clickable; GM lock cleared 52.4 s after reload start (26.3 s load → ~26 s after ready) |
| No-GM banner / read-only | **PASS** | `t15-34-no-gm-banner.png`: exact banner, `+ Note` disabled, Edit disabled, notes readable |
| Width steps Plain 220/300/380 + shrink | **PASS** | 224→303→383→384→385, shrink to 224 (`t15-size-test.log`, `t15-35-size-max-width.png`) |
| Profile 300/380 | **PASS** | T14 valid 300 px + 380 px runs; T15 profile 380/383 documented (`t15-36-profile-size.png`; T14 `t14-profile300.log`) |
| Manual resize + Auto | **PASS** | 222→326 manual (`.jn-sized`), Auto→222 and `jn-sized` removed (`t15-manual3.log`, `t15-40-manual-resize-clean.png`) |
| Pin stability at 0/positive/negative across reload | **PASS** | world `left/top` deltas 0 / 0 for `0deg`, `0.1deg`, `-0.7deg` (`t15-manual-pin.log`, `t15-39-after-reload-pins.png`) |
| Pin stability during growth/shrink | **PASS** | left/top unchanged while width 222→383→222 (`t15-pin-grow.log`) |
| Skins/layouts/EN | **PASS (observed)** | Amber/Handwritten, Parchment/Serif, Cream/Default cards; Plain and Profile layouts; EN throughout (`t15-01-pa-second-session-escape.png`, `t15-36-profile-size.png`) |
| Narrow 400 px / zoom | **PASS** | narrow selected unlock at 400 px; zoom 2.2× (`t15-49-zoomed-canvas.png`, `t15-zoom.log`) |
| Private creation/isolation | **PASS (basic)** | `t15-45-private-created.png`, `t15-46-private-note.png`, `t15-47-shared-after-private.png`: private note absent from shared |
| Incompatible copy / missing schemaVersion | **PASS** | `t15-48-incompatible-missing-schema.png`: notice, 0 cards; legacy page SHA-256 unchanged from T14 baseline |
| History dialog/preview/restore | **PASS (T14 run; unchanged by T15 diff)** | T14 evidence `t14-22`, `t14-23`, `t14-52`; T15 diff does not touch history dialog code/CSS |
| Editor chrome/toolbar/double-click | **PASS (T14 run; unchanged by T15 diff)** | T14 evidence `t14-01`, `t14-08`; T15 unit suite covers selection/sequence |

## Still UNVERIFIED

- Private↔shared transfers, transfer inbox/decline, clipboard publish while reconnecting.
- IME composition, native undo/redo, copy/paste inside Foundry.
- Background-tab lease behaviour and same-user second tab.
- GM failover.
- RU UI (core language pack is not installed here).
- Locked restyle/copy/transfer/checkbox and mixed-group mutation rejection.
- Full history restore re-run at T15 (T14 pass; T15 diff does not touch it).

## Final status

No known functional blocker remains in the tested scope. The four T15 fixes held in real Foundry with GM + two players. Residual risk is confined to the unverified cases above. Headless Chromium under software rendering occasionally crashed after long multi-client runs; successful runs and captured evidence are listed above. All disposable Foundry processes were stopped; ports 30001/30002/30003 are closed; the live root/world/port were never touched.

Evidence: `/tmp/opencode/note-system-evidence/t15-*`; harness runs/logs in `/tmp/opencode/t13b/t15-*`. Only this `PROGRESS.md` is modified; nothing is committed or pushed.
