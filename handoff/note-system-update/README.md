# Note system update handover

This is the implementation contract for replacing Journalinator's overlapping note fields and paragraph editor with one Markdown document per note. It includes the owner's decisions from the design discussion and concrete interface defaults designed with the owner's authorization.

## Start here

Read [OPENCODE-PROMPT.md](OPENCODE-PROMPT.md), then [DECISIONS.md](DECISIONS.md), [IMPLEMENTATION.md](IMPLEMENTATION.md), [UI-SPEC.md](UI-SPEC.md), and [ACCEPTANCE.md](ACCEPTANCE.md). Open [UI-REFERENCE.html](UI-REFERENCE.html) alongside the interface specification.

- Repository: `/home/Riv/Projects/fvtt-journalinator`.
- Implementation branch: `note-system-update`.
- Fetched baseline: `c1f2418e5efc8eabea06ac5fdc37fb836338e84f`, `origin/main`, release 0.9.6; verified 2026-11-28.
- This handover changes documentation only. Runtime code still implements the old system.
- No push, merge, release, live deployment, or world-data reset is authorized by this package.
- The branch is already created. Do not recreate it from another revision or use `stylized-canvas`.

## Authority

The owner's later instructions override this package. Otherwise DECISIONS defines scope, UI-SPEC defines interface behavior, IMPLEMENTATION defines technical contracts, and ACCEPTANCE defines verification. The HTML illustrates UI-SPEC; it is not a second specification or production implementation. If these disagree, report the precise conflict to the coordinator before implementing that portion. Do not fill gaps with a new interface design.

The older Claude brief, historical specs, and stylized-canvas handover are superseded. Their migration, secret-vault, Location, actor-linking, manual-save, paragraph-lock, and ranking requirements must not be reintroduced. Historical release notes remain history, not instructions.

## Approval boundary

First perform the delegated read-only inventory and baseline checks, then present the coordinator's integrated design and task plan to the owner. Wait for approval before the runtime rewrite. This gate comes from the original brief and remains part of this handover. After approval, the coordinator approves individual task results and authorizes their sub-agents to commit; do not interrupt the owner for each routine task.

## Delivery ledger

During implementation create `PROGRESS.md` here with task owner, owned paths, dependencies, review result, test evidence, and commit. Record deviations explicitly. Update README, CHANGELOG and HANDOFF to describe the implemented result before completion; do not mark planned functionality as shipped in advance.

## Retired instructions

The old `handoff/` package, `Foundry VTT Collaborative Notes Canvas Module Spec.md`, `Notes Canvas_ Round 1.html`, and `STYLIZED-PROGRESS.md` were removed from the active repository. README, HANDOFF and PRIVATE-WORKSPACES were rewritten as current entry points/boundaries. STYLIZED-CANVAS is now a short pointer because the existing packaging script includes it. Runtime code, tests, assets, package scripts and historical CHANGELOG were not changed.

An exact, hash-verified archive of all replaced/removed documents, including the previously untracked handover files, is outside the repository at `/home/Riv/Documents/ChatGPT/Journalinator/retired-instructions/journalinator-instructions-before-note-system-update-2026-11-28.tar.gz`. Do not load it as current requirements.
