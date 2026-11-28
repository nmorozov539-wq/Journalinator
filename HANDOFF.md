# Current development handoff

The note-system rewrite is released as **0.10.0** on `main`; the owner's 0.9.7 link-overhaul and visual-polish patches are included. The canonical working checkout may still be on an older branch until the owner checks out/deploys the release. Independent real Foundry v14 verification with a GM and two players passed the tested scope; remaining unverified cases are listed in [the ledger](handoff/note-system-update/PROGRESS.md).

## Status

Tasks T1 through T17 are implemented, reviewed and committed. Version **0.10.0** packages the note-system rewrite and includes the 0.9.7 link/visual release. The full Node suite is 610/610 with `npm run check` passing. Independent real Foundry v14 verification with a GM and two players passed the tested scope; remaining unverified cases are listed in [the ledger](handoff/note-system-update/PROGRESS.md).

[handoff/note-system-update/PROGRESS.md](handoff/note-system-update/PROGRESS.md) is the ledger of record for task status, commit hashes, scoped evidence, deviations and unverified real-Foundry cases. Read it before trusting any count or completion claim.

The rewrite uses one Markdown body per note, derived titles, Plain/Profile layouts, Cream/Amber/Parchment skins, in-place autosaving editing, live rendering for viewers, whole-note GM-mediated edit leases, history/recovery, a private canvas with local tab coordination, and a shared activity foundation without a statistics UI. The GM vault, secret notes, Location notes, actor linking, the old block/paragraph editor and typed wikilinks are removed.

There is a clean break: no migration, no legacy adapter and no compatibility mode. Incompatible shared or private data produces a read-only notice and is left unchanged. Use a fresh disposable world.

## Boundaries

- Release v0.10.0 is published by the owner's instruction. Deploying the new code into the canonical/live-symlinked checkout is still a separate owner action.
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

1. Review the 0.10.0 release and its archive; deploy it to the canonical/live-symlinked checkout only when ready.
2. To make the canonical working checkout/live symlink use the rewrite, merge/check out `note-system-update-impl` (or `main`) there only when ready to deploy.
3. Decide whether to reset the party's real Journalinator data or create a fresh world for the rewritten format.
4. Optional follow-up verification for the cases the disposable run did not exercise: private transfers/inbox, IME/undo/copy-paste, background tabs, GM failover, locked restyle/copy/transfer/checkbox, and RU UI.

Read [handoff/note-system-update/README.md](handoff/note-system-update/README.md) for the design package and [OPENCODE-PROMPT.md](handoff/note-system-update/OPENCODE-PROMPT.md) for the delegation and approval workflow.
