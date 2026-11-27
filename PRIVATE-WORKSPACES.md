# Private workspace boundary

Private canvases remain in the note-system rewrite. This file records their retained boundaries, not a competing implementation plan. The active requirements are in [handoff/note-system-update/](handoff/note-system-update/README.md).

Each user has an owner-scoped workspace with its own notes, geometry, labels, pins, threads, search and trash. Shared canvas UI must not include private content. GM workspace administration retains existing repair/reassignment powers; it is not a new private-note reading interface.

This is application-level privacy, not encryption. Foundry world data may be accessible to the host or a determined browser-console user. Do not promise cryptographic secrecy. The separate encrypted GM vault is being removed without replacement.

Keep clipboard copying, publishing to Main Canvas, private-to-private Send to/inbox behavior and their existing eligibility checks. These are copies, not live shared documents: the source remains and later edits do not synchronize. Copying remaps IDs and eligible internal connections; preserve the current pin/route drop rules and transfer receipt/idempotency protections.

Owner-only editing must not acquire a new GM-online dependency. Preserve workspace revision checks, add local multi-tab editing coordination, and reuse the new body/editor rules through a private persistence adapter. Private history stays in its workspace; private drafts stay local. Do not broadcast private previews or include private activity in shared counters.

No compatibility adapter or migration from the old workspace format is required. Existing data must not be silently overwritten or reset. Use a fresh disposable world for implementation tests.
