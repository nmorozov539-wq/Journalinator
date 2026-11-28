# Current development handoff

The note-system rewrite is implemented on `note-system-update-impl`, the child of `note-system-update`, and the owner's 0.9.7 link-overhaul and visual-polish patches from `main` are merged into it. Local `main` has been fast-forwarded to the verified implementation tip. The canonical working checkout `/home/Riv/Projects/fvtt-journalinator` remains on `note-system-update` at `c778b35` and was not checked out/deployed. Nothing has been pushed, released or deployed.

## Status

Tasks T1 through T17 are implemented, reviewed and committed. Version is 0.9.7 (the owner's link/visual release) with the note-system rewrite documented under Unreleased. The full Node suite is 610/610 with `npm run check` passing. Independent real Foundry v14 verification with a GM and two players passed the tested scope, including the 0.9.7 link overhaul/visual polish and the T17 link-UX fixes; remaining unverified cases are listed in [the ledger](handoff/note-system-update/PROGRESS.md). Screenshots and logs are under `/tmp/opencode/note-system-evidence/`.

[handoff/note-system-update/PROGRESS.md](handoff/note-system-update/PROGRESS.md) is the ledger of record for task status, commit hashes, scoped evidence, deviations and unverified real-Foundry cases. Read it before trusting any count or completion claim.

The rewrite uses one Markdown body per note, derived titles, Plain/Profile layouts, Cream/Amber/Parchment skins, in-place autosaving editing, live rendering for viewers, whole-note GM-mediated edit leases, history/recovery, a private canvas with local tab coordination, and a shared activity foundation without a statistics UI. The GM vault, secret notes, Location notes, actor linking, the old block/paragraph editor and typed wikilinks are removed.

There is a clean break: no migration, no legacy adapter and no compatibility mode. Incompatible shared or private data produces a read-only notice and is left unchanged. Use a fresh disposable world.

## Boundaries

- Do not push, release, package for distribution or deploy. Local `main` has been fast-forwarded at the owner's request; the canonical working checkout/live symlink was not changed.
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

1. Review the implementation branch/ledger and decide whether the Unreleased note-system section becomes a versioned release.
2. To make the canonical working checkout/live symlink use the rewrite, merge/check out `note-system-update-impl` (or `main`) there only when ready to deploy.
3. Decide whether to reset the party's real Journalinator data or create a fresh world for the rewritten format.
4. Optional follow-up verification for the cases the disposable run did not exercise: private transfers/inbox, IME/undo/copy-paste, background tabs, GM failover, locked restyle/copy/transfer/checkbox, and RU UI.

Read [handoff/note-system-update/README.md](handoff/note-system-update/README.md) for the design package and [OPENCODE-PROMPT.md](handoff/note-system-update/OPENCODE-PROMPT.md) for the delegation and approval workflow.
