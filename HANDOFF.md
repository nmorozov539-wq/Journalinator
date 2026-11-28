# Current development handoff

The note-system rewrite is implemented on the development branch `note-system-update-impl`, the child of `note-system-update`. Final integrated head: `283fbd1` (T15 fix `52acca1` + final verification ledger). The canonical checkout `/home/Riv/Projects/fvtt-journalinator` remains on `note-system-update` at `c778b35` and has not been integrated. Nothing has been pushed, merged, released or deployed. The canonical branch must stay untouched until the coordinator/owner approves final integration.

## Status

Tasks T1 through T15 are implemented, reviewed and committed on the implementation branch. The full Node suite is 593/593 with `npm run check` passing. Independent real Foundry v14 verification with a GM and two players passed the tested scope after the T14/T15 fixes; the specific unverified cases are listed in [the ledger](handoff/note-system-update/PROGRESS.md). Screenshots and logs are under `/tmp/opencode/note-system-evidence/`.

[handoff/note-system-update/PROGRESS.md](handoff/note-system-update/PROGRESS.md) is the ledger of record for task status, commit hashes, scoped evidence, deviations and unverified real-Foundry cases. Read it before trusting any count or completion claim.

The rewrite uses one Markdown body per note, derived titles, Plain/Profile layouts, Cream/Amber/Parchment skins, in-place autosaving editing, live rendering for viewers, whole-note GM-mediated edit leases, history/recovery, a private canvas with local tab coordination, and a shared activity foundation without a statistics UI. The GM vault, secret notes, Location notes, actor linking, the old block/paragraph editor and typed wikilinks are removed.

There is a clean break: no migration, no legacy adapter and no compatibility mode. Incompatible shared or private data produces a read-only notice and is left unchanged. Use a fresh disposable world.

## Boundaries

- Do not push, merge to `main`/`note-system-update`, release, package for distribution or deploy.
- Do not install this branch into live Foundry data or point it at the canonical checkout.
- Commit only after coordinator review of the exact result, and only the task's owned files.
- Real Foundry verification was run in a disposable v14 world; see the ledger for the exact PASS/FAIL/UNVERIFIED cases. Remaining unverified items are not claimed as complete.

## Checks

From the task worktree, with declared test dependencies installed:

```sh
node --test tests/i18n.test.mjs
node --test tests/fonts.test.mjs tests/theme.test.mjs
npm test
npm run check
```

The Node/jsdom suites use a fake Foundry harness and do not prove multiplayer behavior. Localization changes must keep EN/RU key parity, no empty strings and no dotted-key collisions.

## Remaining owner actions

1. Review the implementation branch and the verification ledger.
2. Integrate only when authorized: `git -C /home/Riv/Projects/fvtt-journalinator merge --ff-only note-system-update-impl`.
3. Decide whether to reset the party's real Journalinator data or create a fresh world for the rewritten format.
4. Optional follow-up verification for the cases the disposable run did not exercise: private transfers/inbox, IME/undo/copy-paste, background tabs, GM failover, locked restyle/copy/transfer/checkbox, and RU UI.

Read [handoff/note-system-update/README.md](handoff/note-system-update/README.md) for the design package and [OPENCODE-PROMPT.md](handoff/note-system-update/OPENCODE-PROMPT.md) for the delegation and approval workflow.
