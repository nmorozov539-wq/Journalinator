# Current development handoff

The note-system rewrite is implemented on the development branch `note-system-update-impl`, which is the child of `note-system-update`. At the start of T12 the implementation branch head is `3d4ccc2`; T12 itself works on `task/t12-docs` and does not change runtime code.

The canonical checkout `/home/Riv/Projects/fvtt-journalinator` remains on `note-system-update` at `c778b35` and has not been integrated. Nothing has been pushed, merged, released or deployed. The canonical branch must stay untouched until the coordinator approves final integration.

## Status

Tasks T1 through T11 are implemented and committed. T12 adds the final EN/RU localization and this documentation update. The independent verification task, T13, is queued.

[handoff/note-system-update/PROGRESS.md](handoff/note-system-update/PROGRESS.md) is the ledger of record for task status, commit hashes, scoped evidence, deviations and unverified real-Foundry cases. Read it before trusting any count or completion claim.

The rewrite uses one Markdown body per note, derived titles, Plain/Profile layouts, Cream/Amber/Parchment skins, in-place autosaving editing, live rendering for viewers, whole-note GM-mediated edit leases, history/recovery, a private canvas with local tab coordination, and a shared activity foundation without a statistics UI. The GM vault, secret notes, Location notes, actor linking, the old block/paragraph editor and typed wikilinks are removed.

There is a clean break: no migration, no legacy adapter and no compatibility mode. Incompatible shared or private data produces a read-only notice and is left unchanged. Use a fresh disposable world.

## Boundaries

- Do not push, merge to `main`/`note-system-update`, release, package for distribution or deploy.
- Do not install this branch into live Foundry data or point it at the canonical checkout.
- Commit only after coordinator review of the exact result, and only the task's owned files.
- Real Foundry multiplayer verification is T13, not part of T12.

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

1. Review and approve the T12 localization/docs diff.
2. Run T13 on a fresh disposable Foundry world with at least one GM and two players, including reconnect, GM failover, simultaneous editing, private tabs and old-format notices.
3. Decide when and how to integrate `note-system-update-impl` into `note-system-update`; keep the canonical branch untouched until then.
4. Decide whether to reset the party's real Journalinator data or create a fresh world for the rewritten format.

Read [handoff/note-system-update/README.md](handoff/note-system-update/README.md) for the design package and [OPENCODE-PROMPT.md](handoff/note-system-update/OPENCODE-PROMPT.md) for the delegation and approval workflow.
