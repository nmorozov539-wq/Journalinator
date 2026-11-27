# Current development handoff

The active work is the note-system rewrite on `note-system-update`, starting from `main` commit `c1f2418e5efc8eabea06ac5fdc37fb836338e84f` (v0.9.6).

Read [handoff/note-system-update/README.md](handoff/note-system-update/README.md) and use [OPENCODE-PROMPT.md](handoff/note-system-update/OPENCODE-PROMPT.md) to start OpenCode. The package contains agreed decisions, a code inventory and phased technical contract, exact UI behavior, a visual reference and acceptance tests.

This documentation commit does not implement the rewrite. Runtime code still uses the previous note system. Historical specifications and stylized-canvas implementation instructions have been retired; do not reconstruct requirements from their old references in comments or release notes.

The coordinator must delegate substantial tasks, review their actual results, and authorize the authoring sub-agent to commit each approved task. The first runtime implementation gate remains owner approval of the phase-zero inventory/design. No push, main merge, release or live deployment.
