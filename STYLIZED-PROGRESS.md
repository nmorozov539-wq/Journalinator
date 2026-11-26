# Stylized Canvas — progress log

Branch: `stylized-canvas` (local only; no push/merge/publish).
Baseline: `54eee06` (`StateHookUp`, local checkout) → branch created at Phase 0.
Spec package: `handoff/` (README, IMPLEMENTATION, DECISIONS, ACCEPTANCE, VISUAL-REFERENCE, THREAD-CONFIGURATOR).
Module: 0.8.4 · Foundry v14.367 · local Foundry available (isolated test root plan below).

## Phase 0 — repository audit and baseline

### Git / baseline
- Working tree before start: only untracked `handoff/`; no tracked modifications. Preserved.
- Created `stylized-canvas` from local `StateHookUp` HEAD `54eee06`. Rationale: local checkout is the actual delivery baseline; GitHub `main` `dd452db` is its parent. No commits, pushes or merges to other branches.
- `npm test` (baseline): **165 tests, 165 pass, 0 fail, 0 skipped** (~9.0 s), jsdom/showdown present.
- `npm run check`: **All module scripts passed syntax checks.**
- `dist/` is stale (0.7.25). Testing uses the repo root manifest (0.8.4), not `dist/`.

### Environment
- Foundry **14.367 Stable** at `/home/Riv/foundry-v14/foundryvtt`; data root `/home/Riv/foundry-v14-data`.
- Module is symlinked at `Data/modules/fvtt-journalinator → /home/Riv/Projects/fvtt-journalinator`.
- **Live production world `pf2e-setup-world` is module-enabled and must not be launched with WIP code.** All testing must use an isolated data root `/home/Riv/foundry-test-data` and test world `journalinator-test` on port 30199. Headless server works under system Node `resources/app/main.mjs`; Chromium + Playwright available externally for screenshots.
- No Foundry process was started in Phase 0.

### Audit reports (subagent sessions)
- Data/security/migration: `ses_de83107eaffdNeVP9bKlMs00HQ`
- Rendering/UI/theme/tests: `ses_de83107e7ffemU11DubD4kT5Vf`
- Visual reference extraction: `ses_de83107c8ffedOj0nvK5VZ8RLa`
- Environment/verification: `ses_de83107c6ffeE6deXPVK74WsdX`

Key findings:
- No schema version or migration exists anywhere; styles are five legacy keys (`sticky/document/torn/wanted/memo`).
- Private workspace and secret vault have **allowlist normalizers** that silently drop unknown fields. Any new field must be added there or data is lost.
- Secret declassification and `notes-store.#secretNote` reconstruct fixed field sets; new fields must be added in both.
- Link `pins` are free world-space board waypoints, not note anchors. Stable link IDs, points/sides, direction, color slot, lineStyle all exist.
- Current canvas has one permanent SVG mask that cuts threads under **all** cards; hover local fade is not implemented. No rotation gesture. Context/link toolbars are already screen-space.
- Theme API: `game.journalinator.themes.register/list/get`, hooks `journalinatorThemeRegistered/Changed`, client settings `boardTheme`/`customThemes`, normalized token schema, CSS vars. Selector is currently active.
- Tests: `tests/ui/smoke.mjs`, `theme.test.mjs`, `i18n.test.mjs`, `integration.test.mjs` are the high-impact suites; exact DOM/geometry/theme assertions must be updated deliberately, not deleted.
- Visual reference: approved cork/paper/torn/thread values extracted; pin library and exact widths are candidates, not approved. Two HTML bugs to avoid: demo sticky max-width override and DOM-index torn seed.

### Phase 0 decisions (reversible unless noted)

| Topic | Decision | Rationale |
|---|---|---|
| Baseline | Branch from local `StateHookUp` | Latest real work; preserves actor-status commit. Can be rebased onto `main` later. |
| Rendering model | One note primitive; `presentation.extendedStyle` (`memo/document/target`) + derived compact/extended. Keep legacy `system.style` read-only for old records. | R04/R05/R06. |
| Schema | Additive, versioned with `system.schemaVersion` (0 legacy, 1 current). Read-time resolver means unmigrated records render. GM-only idempotent migration pass. | Avoid destructive rewrite; supports rollback by branch. |
| Labels | `system.label` optional; empty renders nothing. Internal `name`/ID remains wikilink/identity key. Legacy meaningful names copied to label; generated placeholders detected by localized heuristic + `nameGenerated`. Never use labels for link lookup. | R09, DECISIONS open item. |
| Unlabelled wikilinks | Keep existing title/`formerNames` resolution unchanged. Search indexes label + visible text with excerpt fallback; excerpts are not lookup keys. | No silent new syntax; preserves typed links. |
| Hidden content | Classifier uses only viewer-visible blocks. No viewer-specific size writes. Hidden-block count may style a GM-only state but never changes geometry for players. | A11/A09. |
| Private schema | Read-time normalization accepts format 1 or 2 and writes format 2 on next save; new fields deep-normalized. | No migration key required; reversible. |
| Secret schema | Vault data format 2 with deep normalization; migrate lazily inside `vaultStore.mutate` while unlocked. Crypto blob format stays 1. Declassification allowlists extended explicitly. | Never log/export plaintext; old blobs keep working. |
| Pin redistribution | GM-authoritative serialized batch with pre-state capture; local undo stack in app sends exact restore. Routes referencing a removed main pin drop the waypoint, preserving original link. | A20/E03. Atomic within the existing single-GM write queue. |
| Route A/B | A keeps original link ID/endpoints and adds `routeAnchors[].noteId/anchorId`; main pin required. B is disallowed for `origin:"typed"` links; copies material/style/label to first segment only; local undo restores the exact original link. | E04/§6 safety. |
| Thread sag | Rest sag = `min(100, |dx| * slack)` with default 0.09 matching current 42-cap at typical spans; spring solver preserved. | Resolves configurator/spec mismatch. |
| Pin art | Ship brass/iron/enamel/wood/decorative/wax candidates; default enamel provisional; main 20px, minor 9px, board 12px. | E05, no concept approval needed. |
| Fonts | Bundle SIL-OFL WOFF2 locally; IM Fell English is Latin-only, so RU formal headings use a bundled Cyrillic old-style serif (Old Standard TT if obtainable) and document the substitution. No runtime CDN. | Offline EN/RU requirement. |
| Theme API | Keep register/list/get/hooks/settings and existing CSS var contract. Add allowlisted material/pin/thread tokens with safe defaults. New built-in default `stylized`; old theme ids still resolve but render new materials. Selector visible but inert. | R02. |
| Floating tools | Screen-space `.jn-canvas-toolbar` child of `.jn-canvas` (like link toolbar), not layout flow. Cosmetic-only bulk. | R14/A25/A26. |

### Known limitations / risks to watch
- Real Foundry/multiplayer validation is pending; Node/jsdom tests are not a substitute.
- "Private" workspaces are UI-private plaintext; vault "open" mode is trust-based. Migration must never surface them in shared data.
- Existing app undo only covers trash. Pin redistribute and route-B undo will use a small explicit local undo stack; document that it is session-local.
- Torn silhouettes use stable note-ID-seeded polygons; the demo's DOM-index seed must not be copied.
- Performance at 50–100 notes / 100–200 links must be measured, not assumed.

### Phase plan
| Phase | Scope | Gate |
|---|---|---|
| 1 | Universal note schema, presentation resolver, migration, private/secret/socket compatibility, tests | roundtrip, IDs, permissions, old fixtures |
| 2 | Classifier/adaptive sizing, Markdown + picture layout, label editor, creation menu, search | A02–A06, A09 |
| 3 | Cork, four renderers + torn, theme tokens/API, fonts, selector inert | A07, A08, A12, A13 |
| 4 | L3/L6 threads, presets, patterns/ends, slack/sag, local fade | A14–A16 |
| 5 | Anchors, optional pins, snapping, lifecycle, redistribution, pin art | A17–A21 |
| 6 | Route A/B note-on-thread, transactional ops + undo | A22–A23 |
| 7 | Floating contextual toolbar, popovers, bulk cosmetics, i18n/a11y | A25–A26 |
| 8 | Integration/build, isolated Foundry smoke, package, manual matrix | A27–A28 |

### Phase gates / test commands
`npm test` and `npm run check` after every phase. Add tests per phase.
Manual Foundry checks are recorded as **not run / pending** until an isolated world is actually exercised.

## Change log (fills in as phases land)

### Phase 1 — universal note + migration (commit pending at time of writing)

Implementation agents: `ses_de825bb89ffeGaWs7MOR769FGN` (shared), `ses_de825bb88ffeb5a5vIVaxXhcUu` (private/secret), fix agent `ses_de80e58b2ffeSsBtCUPYNvpQfw`, residual fix `ses_de7f78cf9ffelWPyVaAIxrPRfa`.
Validation: `ses_de81a8f87ffeikgtbB6fY8c7Fm` (found F1–F8), `ses_de8035d95ffeh25CbGi1p1DR8u` (found N1–N6).

Delivered:
- `scripts/presentation.mjs`: renderer/typography/link constants, legacy mapping, `resolvePresentation`, `resolveAttachment`, `resolveLinkCosmetics`, generated-title heuristic, `migrateNoteSystem`, shared anchor sanitizers.
- Note schema: `label`, `schemaVersion`, `presentation`, `attachment`; link cosmetics + anchor IDs + route anchors; layout card anchor registry.
- Shared socket: new `setNotePresentation` / `setNoteAttachment` / `setNoteLabel`; legacy setters synchronise presentation; creation/paste/restore keep new fields and anchors; declassify preserves fields/IDs/formerNames and filters secret route waypoints; client route authoring forced empty until Phase 6.
- Private workspace format 2 (read 1/2, write 2), deep normalisation, anchors/ports preserved, main anchor seeded.
- Vault data format 2 with deep normalisation; crypto blob format unchanged; secret setters synchronised; hidden-link cosmetics validated; declassify preserves new fields.
- GM-only idempotent `migrateSharedWorld()` plus world `schemaVersion` setting; per-card anchor migration preserves minors and skips bad cards.
- Tests: 200 pass / 0 fail; `npm run check` pass.

Known deferred: destructive main-pin disable/redistribution is Phase 5; route A/B authoring is Phase 6. Vault migration is lazy (persists on next vault write).

### Phase 2 — adaptive text, rendering, creation, search

Implementation agents: `ses_de7edb7a3ffeHZ40wtmVyYOFEs` (card renderer), `ses_de7edb7a3ffdPffQGpfqrp7tno` (editor/creation/search), fixes `ses_de7d4315bffepQznMQZRsTQPCD`.
Validation: `ses_de7dfc251ffebCMFu8UyshZpfY`, re-check `ses_de7cbc9b1ffez0rqlSYl4xyhnJ` (plus coordinator hardening).

Delivered:
- Universal card DOM: optional label only when populated (internal name never shown), target heading, explicit image with above/below/left/right layout, inline Markdown order preserved, author-initial signature, no author stripe/badge. Compact is content-sized (90–220 px, wraps); extended widths memo 360/document 248/target 252; manual size overrides compact cap; no calculated size writes.
- Classifier: uses Showdown-rendered structure when available, with a conservative line-based fallback. Hidden blocks excluded; code/comments/reference definitions/escaped hashes never promote; headings/inline images/tables/code/complex/overlong content promote; `forceExtended` only override.
- Editor: optional label, Auto/Memo/Document/Target + Location, font, picture layout, force extended, torn data, Target heading; shared/private/secret save paths.
- Creation: Auto/Memo/Document/Target (+ Location/Label) with presets forcing extended; new notes default Memo/auto; legacy Sticky/Torn gone from UI.
- Search: label + visible text + heading + public author; hidden/secret text and internal names excluded; deterministic excerpt/neutral fallback; filters Memo/Document/Target/Location.
- Tests: **226 pass / 0 fail**; `npm run check` pass. Browser geometry checked manually via /tmp probes for picture layout and compact resize.

Deferred: torn artwork is Phase 3 (data/class already present); real resize gesture geometry remains a manual Foundry check.

### Phase 3 — materials, theme tokens, fonts, torn edges

Implementation agents: `ses_de7bff737ffemRtBkr3WoaYuxR` (theme/API), `ses_de7bff736ffeBL8Nj31ifXT71U` (materials/torn), fixes `ses_de79230d1ffep40t2O0x3rvHcn`.
Validation: `ses_de7b43eb6ffe5JzUPTu9j83dE7`.

Delivered:
- New `styles/stylized.css` (loaded after fonts): dark cork `#7b5233` with bundled 320px procedural tile, warm light/vignette, no grid/dots; paper surfaces on `.jn-card-main` so pins/stamps/signature/resize stay outside torn clips.
- Materials: compact `#d9c08f` + 19px ruling, memo `#ead9b4` Caveat, document `#efe5c9` with 20px margin + double-rule label, target `#e8dbc0` with inset frame/formal label; picture layouts; author signature; no stripe/badge.
- Torn modifier: stable ID-seeded `scripts/tear.mjs` polygon, straight top edge, fiber rim, padding avoids clipping; no DOM-index seed.
- Bundled OFL fonts under `assets/fonts` (Alegreya/Caveat variable, IM Fell, Old Standard TT Cyrillic) with `styles/fonts.css`; no CDN. EN/RU fallback verified.
- Theme schema extended with validated `materials` (board/paper/fonts/pins/threads), new `stylized` built-in default, all `--jn-sc-*` tokens; module-prefixed asset routes; old themes normalize to new materials; selector visible, named, inert, accessible; `journalinatorThemeChanged` fires on actual applied-theme changes.
- Tests: **251 pass / 0 fail**; syntax pass; fonts/contrast/tear tests added. Headless Chromium probe verified cork/grain load, rules visible, resize handle hit-test, selector inert.

Reserved for later phases: pin size/style tokens and thread dye/fade tokens are emitted but consumed in Phases 4–5. Per-torn-card drop-shadow performance remains a Phase 8 measurement item.

### Phase 4 — configurable threads and local fade

Implementation agent: `ses_de785b2a5ffeTCT5IQWnTxoxOm`; fixes `ses_de7683b33ffeZBp1xJzAal6YLw`.
Validation: `ses_de77395d6ffeU6xS5JG1XsTr7R`.

Delivered:
- L3/L6 layered threads (shadow/dark/core/highlights or two strands) with reference factors, offsets and opacities; no arrowheads or direction UI.
- Presets Fine 1.3/2%, Standard 2.6/9% (default), Double 2.8/12% L6, Heavy 4/19% L6; independent thickness 0.8–5, slack 0–25%, material, primary/secondary color slots, pattern, ends, label.
- Continuous/interrupted/alternating patterns; standard/loose ends; free board pins/labels; existing hit path and spring motion. Slug `threadPath` sag = min(100, |dx| * slack); vertical threads straight.
- Local fade: single per-canvas silhouette mask of rotated/torn cards; hover, lock or inline edit toggles 15%-luminance mask shapes with 160ms transition (reduced-motion off); only stroke stacks fade; pins/labels/hit paths unaffected. Permanent under-card mask removed.
- Toolbar controls for presets/material/thickness/slack/color/secondary/pattern/ends/label; change-only writes; Escape/outside close and focus return.
- In-place geometry update path reuses existing SVG nodes on drag; measured Chromium 100 notes/200 links ~6ms geometry update vs ~19–30ms full rebuild, jsdom 238→28ms. No per-link SVG filters; one shared mask.
- Tests: **267 pass / 0 fail**; syntax pass; browser probes confirm layer widths/offsets, fade on rotated/torn note, toolbar.

Deferred/manual: real Foundry drag/hover and multiplayer fade; per-torn-card drop-shadow cost remains a Phase 8 stress item.

### Phase 5 — optional pin system

Implementation agents: `ses_de754a80fffejrEBKWnGNZ7JYO` (data/socket), `ses_de754a80effeHDRQqfLi0pQS1d` (canvas/UI); fixes `ses_de730c436ffegU3biOjU7e54IF`, `ses_de7114b4affeyS0TMYQAnfvmfa`.
Validation: `ses_de74273adffe7ZkBCUIz70a4zg`, re-check `ses_de71f3de0ffej1zhE12dsyGxbl`.

Delivered:
- Stable layout-card anchors (`main` + minor), strict ID grammar/reserved-key rejection, canonical single main, server-derived creators; link endpoints reference anchor IDs with point/side fallback. Rotation/resize/promotion project correctly.
- Main pin (author-colored, 20px, drag handle/link target), minor pins (9px visual, zoom-compensated hit area), board route pins distinct; candidate styles enamel/brass/iron/wood/decorative/wax; pins outside torn clip. World setting `pinsEnabled` (default true); off hides pin UI but existing anchor links still render.
- Link tool snaps to main/minor using per-note screen radii, reuses nearby pins, creates a new minor spec on card-interior clicks; multiple links can share an anchor. Minor pins draggable; context-menu add pin; shared editors expose toggle/snap/style; private/secret equivalents.
- Prune unreferenced minors after link changes, counting trashed-note refs; main never pruned; shared anchors survive multiple links; hidden links cannot reference shared minors.
- Main-pin disable is an atomic GM-queued redistribution across inbound/outbound/route links using nearest minors/projected edges; route waypoints drop while links remain; exact undo via active-GM in-memory store (cap 20), stale undo refused, writeApplied acknowledgement prevents dead Ctrl+Z entries; re-enable only shows pin, no reattach.
- Tests: **320 pass / 0 fail**; syntax pass. Browser probes confirm pin geometry/hit areas at k=0.5/2, six styles, snapping, pin-off rendering.

Known limitations: pin undo is active-GM in-memory (lost on reload/failover, cap 20, stale refused); private main-pin disable with links is shared-canvas-only and the control is qualified; legacy hidden/declassified links have anchor/route fields cleared by design.

### Phase 6 — route notes on threads (A/B)

Implementation agents: `ses_de6ff0656ffeWm1bKi4PoHecjl` (data), `ses_de6ff0656ffdTJ0N4ZFElW3L30` (canvas/drop UI); fixes `ses_de6e3f977ffem26yDsEoTOK2l6`.
Validation: `ses_de6f203c2ffeqSovIYEK6Mo6Fp`.

Delivered:
- Route A: drop a note on a thread, choose "Route through note"; inserts a stable `{noteId, anchorId:"main"}` waypoint with original link ID/endpoints/semantics/cosmetics/label unchanged. Path order is source → board pins → route waypoints → target; follows note move/rotate/resize. Main-only; pin-off rejected server/UI; capacity cap 24 with disabled reason.
- Route B: explicit split into A→C and C→B, atomic via `updateDocuments` on real Foundry (fallback documented), copies material/style, label on first only, hint policy, no dangling pins. Typed links, pinned/routed links, and duplicate A→C/C→B relationships are rejected with localized reasons. Board pins can be cleared from the link toolbar.
- Drop UX: drag/drop proximity detection, target highlight, screen-space mode chooser with disabled reasons, focus trap/Escape/outside/cancel, no pan snap, no optimistic success toast (ack-driven only).
- Undo: one chronological client history (delete/pin/route) with newest-first Ctrl+Z; route A insert, split, and detach record exact raw before-state on the active GM (in-memory, cap 20, stale refused) and ack before history/toast.
- Deleting/soft-deleting a routed note removes only its waypoints from all links (including trashed owners); links survive, restore does not reattach. Delete thread leaves note. Detach action/undo exposed.
- Server rejection notices for cap/duplicate/stale/pin-off/typed/missing; stale route entries pruned-and-continue; secret/hidden routing rejected; final leak dump remains last.
- Tests: **347 pass / 0 fail**; syntax pass; 19+ new route tests. Ongoing limitation: session-local active-GM undo, split crash window on fake-Foundry fallback only.

### Phase 7 — floating contextual toolbar and cosmetic bulk edits

Implementation agent: `ses_de6d64d55ffezpgznJRimB4JFk`; fixes `ses_de6bb29d6ffe1njMT26iDSs5xF`.
Validation: `ses_de6c64aa6ffeCU1EAiq4YClWZk`.

Delivered:
- Screen-space floating toolbar as a direct `.jn-canvas` child at the right edge; no reserved width, no world/pan/layout changes; icon-only resting with leftward hover/focus label expansion; anchored popovers with outside/Escape/selection-close, focus entry/return, keyboard labels, reduced motion.
- Single-note controls: style, force extended, font, picture layout, torn, pin appearance, dimensions + Auto. Multi-note: intersection of cosmetic controls only, Mixed state, no bulk force/dimensions/label/content/image/permissions/links/topology/anchors/pin enable/snap. Secret multi-selection disabled with explanation.
- Link controls: material, thickness, slack, color, pattern, ends, label, presets; change-only writes. Existing link toolbar/context menu/editor retained.
- Bulk writes: shared batches via setNotePresentation/setNoteAttachment; single secret via vault; private via one save. Client aborts stale/mixed-tier selections; socket strips forceExtended for multi-note batches.
- Popover clamps inside canvas at 320/430/1400 widths and re-clamps on resize; focus retention across re-render; selection no longer forces a full app render.
- Tests: **361 pass / 0 fail**; syntax pass; browser probe for narrow/wide popover bounds and no layout shift.

Known scope note: multi-link bulk selection is not implemented (canvas has a single selected link); documented in code. Cosmetic edits inherit the existing collaborative write model.

### Phase 8 — integration, real Foundry smoke, packaging

Coordinator-run with independent validation reports from all prior phases. No new feature agent; packaging/docs only.

- Baseline/regression: `npm run check` pass; `npm test` **361 pass / 0 fail / 0 skipped** (14 suites, ~25 s).
- Isolated Foundry smoke (real runtime, not jsdom):
  - data root `/home/Riv/foundry-test-data`, fresh world `journalinator-fresh`, port 30199, Foundry 14.367, PF2e 7.4.3.
  - module 0.8.4 active; containers created (`shared/history/secrets/private/layout/stats/history`); `schemaVersion` 1; `pinsEnabled` true; scene-control button present.
  - opened Journalinator app; created compact Memo and extended Document notes; verified presentation/attachment/schema in page data and layout `main` anchors; `.jn-card`, `.jn-pin`, paper classes rendered; no Journalinator console errors.
  - Fresh PF2e world emitted unrelated PF2e setting errors on first launch (not module errors). Production world was never launched or modified.
- Package: `tools/package-stylized.sh` builds `dist/Journalinator-stylized-canvas-0.8.4.zip` (105 files, ~1.5 MB). `dist/` is gitignored and not published.
  - SHA-256 `398f94b863b093d1fca334f29327b2a3d1e547600836a6deee313bf2efa346aa`.
- Deliverable docs: `STYLIZED-CANVAS.md` (install/launch, test commands, limitations, manual checklist, verification).
- Manual gates remaining: GM + two players (permissions/private/vault/locks sync), real campaign migration on a disposable copy, 50–100 note stress in a real browser session, live drag/hover/route/pin/undo interaction, EN/RU offline Foundry font rendering.
- No push, merge, release, or deployment was performed. Branch remains local `stylized-canvas`.

### Acceptance status snapshot (A01–A28)

| IDs | Status | Evidence |
|---|---|---|
| A01 | PASS | branch/status/baseline recorded; 361 tests; no main edits |
| A02–A09 | PASS automated + jsdom/browser | classifier/UI/integration/search tests; real Foundry created compact+document notes |
| A10 | PASS automated; real-world migration pending | migration/idempotence/legacy fixtures in integration; disposable copy not GM-joined |
| A11 | NOT RUN | requires GM + two players |
| A12 | PASS | theme API/validation/inert selector tests |
| A13 | PASS browser | cork/no grid/rules/fonts/pin probes |
| A14–A16 | PASS automated + probes | presets/layers/fade tests; Chromium fade/layer measurements |
| A17–A21 | PASS automated + probes | pin lifecycle/redistribution/undo/hit-area tests; real Foundry pins rendered |
| A22–A23 | PASS automated | route A/B, typed/pin-off/rollback/undo tests |
| A24 | PASS automated | labels/stamps/search/trash/link tests retained |
| A25–A26 | PASS automated + probe | toolbar/popover/bulk tests; narrow/wide Chromium clamp |
| A27 | PARTIAL | 100 notes/200 links measured (~6 ms geometry update vs ~19–30 ms rebuild; jsdom 238→28 ms); real Foundry stress pending |
| A28 | PASS local; no publish | manifest/package/launch docs; Foundry 14.367 smoke; no push/merge/release |

Final known limitations: session-local active-GM undo (pin/route), private main-pin disable not redistributed, multi-link bulk not implemented, split fallback crash window on fake Foundry only, per-torn-card shadow cost to stress-test, and all real multiplayer/manual gates above.

### Local commit history (no push/merge/release)

| Phase | Commit |
|---|---|
| 1 universal schema + migration | `4c59576` |
| 2 adaptive rendering/creation/search | `a252fee` |
| 3 materials/theme/fonts/torn | `16f5a94` |
| 4 configurable threads/fade | `38bdb3c` |
| 5 optional pins | `6ccede4` |
| 6 route notes A/B | `bdbd273` |
| 7 floating toolbar/bulk | `7e68ea3` |
| 8 docs/Foundry smoke/package | `1e6b928` |

Final tree state: branch `stylized-canvas`, working tree clean except untracked `handoff/` (spec package) and ignored `dist/` artifact.
