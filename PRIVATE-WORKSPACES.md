# Private workspace boundary

Private canvases are part of the implemented note-system rewrite. This file records the boundary as built, not a competing implementation plan. Requirements and task history are in [handoff/note-system-update/](handoff/note-system-update/README.md).

## Storage and permissions

Each user has one owner-scoped private journal stored in the module's `Journalinator: Private Journals` container. Private notes use the same schema v2 body, layout, skin and sizing fields as shared notes. Access keeps the existing owner/document permission path: the player owns the page and edits it directly; a GM retains administration for create, rename, assign, detach and delete. Owner-only editing does not require a connected GM and does not acquire a shared edit lease.

The workspace page carries a revision (`rev`). Saves compare the loaded revision with the stored one and reject a stale write, so a GM change or a save from another tab cannot be silently overwritten. A rejected save reloads the latest workspace and reports that local changes were not saved.

## Local tab coordination

Multiple tabs for the same user are coordinated locally, not by the shared socket. A per-note localStorage lock record (with a heartbeat and expiry) names the editing tab; a `BroadcastChannel` with a `storage` event fallback provides prompt release notices. Another tab of the same user sees the note as locked rather than silently sharing it. The text editor is the same headless `NoteEditorSession` used on the shared canvas, with a local transport and a synthetic local epoch.

## History, recovery and isolation

Private history is workspace-local. It stores body/revision snapshots inside the private workspace and is unavailable from shared search, shared activity or the shared history dialog. The session-start checkpoint is written lazily with the first saved page update rather than when the editor opens. Local recovery drafts remain in the browser and are never broadcast. Private previews, private drafts, private activity and private history must not appear on the shared canvas or in shared counters.

## Copies, not live documents

Publishing to the Main Canvas, sending to another player, the incoming-notes inbox and clipboard copying are copies. The source stays in place and later edits do not synchronize. Copies get fresh note, card, link and label IDs; eligible connections to other copied notes and pins are remapped, while links or route waypoints to notes outside the selection are dropped with a counted notice. Reader eligibility, transfer limits, receipt/idempotency checks and trash behavior are preserved from the previous release, with schema v2 payloads.

## Not encryption

This is application-level privacy, not encryption. Foundry world data may be accessible to the host or a determined browser-console user. Do not promise cryptographic secrecy. The separate encrypted GM vault has been removed without replacement and is not part of the private workspace.

## Clean break

There is no migration or compatibility adapter for the old private workspace format. An incompatible private workspace shows a read-only notice, is left unchanged, and cannot be written. Use a fresh disposable world for tests and ask the host to reset private Journalinator data if needed; resetting real party data remains an owner action.
