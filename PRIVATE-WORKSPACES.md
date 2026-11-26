# Private Workspaces — Design

Status: implemented in 0.8.x; one-way private-to-private copies added in 0.9.0.

## Summary

Every Foundry user gets one private workspace: a separate Journalinator canvas that only that
profile can open through the UI. It is isolated from the shared board. There is no live sharing
and no reader list. Notes move between canvases through an explicit Ctrl/Cmd+C and Ctrl/Cmd+V
copy, and a player can send a one-way copy of selected private notes to another player's private
inbox.

This is a **UI-private** feature, not encryption. See the security boundary below.

## Goals

- Give each user a personal canvas for notes they do not want on the shared board.
- Keep private notes out of the shared canvas, search, stats, history, links, and trash.
- Add a simple **Main canvas | Private canvas** switch.
- Let the owner rename their private workspace.
- Let the GM repair workspaces when a user is deleted, recreated, or needs reassignment.
- Let notes be copied between the shared and private canvases with Ctrl/Cmd+C and Ctrl/Cmd+V.
- Let a player send an explicit one-way copy of selected private notes to another player.

## Non-goals

- Encryption at rest.
- Live shared editing or in-place sharing of a private note. Transfers are copies; the two
  private workspaces are never linked or kept in sync.
- Merging two private workspaces.
- Hiding the existence of a workspace from the GM or the host.

## Security boundary

Private workspaces are isolated by UI and document ownership, not cryptography.

Foundry sends journal data to every client. A player who opens the browser console, or the host,
can read the underlying note data. The GM is trusted not to go looking through raw world data.
This design protects against accidental or casual access through the normal interface, not
against a determined user with console access.

The workspace **name is public metadata** because it is all the GM admin panel is allowed to
show. Do not put secrets in a workspace name.

## User experience

### Workspace switch

The top bar gets a simple switch:

- **Main canvas**
- **Private canvas**

The private canvas has its own cards, positions, zoom, labels, search, and trash. Switching tabs
does not change the shared board. The private view should have a subtly different visual accent
so it is always obvious which canvas is open.

Private notes are reached only from the private tab. They never appear in the main quick
switcher or shared search.

### Private notes

Private notes use the same editor, Markdown rendering, card styles, and interactions as shared
notes, but:

- no block locks are needed — the profile owner is the only writer;
- private notes do not appear in shared stats or history;
- private notes can be linked to each other; those links never leave the workspace;
- the private workspace has its own undo, trash, and restore behaviour.

### Copying between canvases

Select one or more notes and use Ctrl/Cmd+C. Switch to the other canvas and use Ctrl/Cmd+V.

Copying:

- works in both directions: shared → private and private → shared;
- also duplicates notes within the same canvas;
- copies the title, text, and note type (card style, location kind, and target heading);
- preserves Markdown and paragraph text, but strips links, images, stamps, card layout,
  and every other private detail;
- creates a new note and leaves the source unchanged and independent;
- does not keep the two notes in sync.

When pasting onto the shared canvas, the active GM creates the notes. If a title is already used
there, the new copy gets a numeric suffix.

## Data model

### Container

Add one hidden journal container, **Private Journals**, alongside the shared, history, and
secrets containers. It is hidden from the sidebar like the module's other containers.

### Workspace record

One `JournalEntryPage` per workspace. The page is the workspace. New pages use the core `text` page
type so they do not depend on a module-specific page type being registered by the manifest. The
old `fvtt-journalinator.private` type stays registered so pages created during the beta can still
be opened and saved.

- `page.id` is the stable workspace ID. It is not the user ID and never changes.
- `page.name` is the workspace name. This is the only metadata the GM admin panel shows.
- `page.ownership` gives the current owner `OWNER` and defaults to `NONE`.
- `page.flags` stores:
  - `ownerUserId: string | null`
  - `pendingOwnerUserId: string | null`
  - `state: "active" | "orphaned" | "pending"`
  - `rev: number`
  - `acceptedTransfers: string[]` — recent transfer ids imported into this page (capped at 50),
    used to make the save-then-remove sequence idempotent
  - the private canvas payload:
    - notes (title, Markdown blocks, card style, card position)
    - layout and viewport
    - private trash
    - timestamps

The page name is intentionally public metadata. The note contents are not.

The **Private Journals** container also carries a `flags.fvtt-journalinator.transfers` object of
pending private-to-private copies until the recipient accepts or declines them. Removal uses
Foundry's per-key deletion syntax because ordinary object updates deep-merge on a real server.

### Ownership rules

- A user can have at most one workspace in an active or pending state.
- The owner's client writes directly to the owned page.
- The GM creates the page because ordinary players do not have journal-create permission.
- If the page cannot be written directly by its owner under Foundry page permissions, the write
  falls back to the existing GM-mediated write path.
- Two sessions signed in as the same user share the same workspace. A revision check prevents
  one session from silently overwriting the other; on a mismatch the client refreshes and
  re-applies its change.

## Identity and lifecycle

Foundry user IDs are stable across renames. Renaming a player keeps the same workspace.

Deleting a user does **not** delete their workspace. It becomes orphaned internally. The
workspace ID, name, and contents remain until the GM explicitly deletes it.

A newly created user gets a new user ID and therefore a fresh empty workspace. The GM can
reassign an orphaned workspace to that user, with player confirmation.

The system never matches workspaces by player name. Names are editable metadata, not identity.

## GM admin panel

The GM gets a **Private Journals** manager with two columns: players on the left, journals on the
right. A connector shows who owns which journal. Solid lines are active; dashed lines are waiting
for the player to accept. Journals without an owner appear after the linked ones under an
**Unassigned** divider. Players are shown by name and color only.

Right-clicking a journal (or using its menu button) opens the actions:

- **Rename**
- **Assign to player…**
- **Detach from player**
- **Delete…** with a strong confirmation

Rules:

- An active workspace must be detached before it can be assigned to someone else.
- Assignment is blocked if the target player already has an active or pending workspace.
- The GM never opens the workspace contents from this panel.
- The panel is the only place to repair or transfer orphaned workspaces.

Invalid actions are reported as short errors.

## Reassignment and player confirmation

When the GM assigns a workspace, it enters `pending` with a `pendingOwnerUserId`. It is not
visible to that player yet.

On opening the private tab, the player sees a prompt containing only the workspace name:

> The GM wants to give you the private journal “Old journal”. Accept or decline.

- **Accept** binds the workspace to the player and makes it active.
- **Decline** clears the pending owner and returns the workspace to orphaned.

No note count, dates, or contents are shown in the prompt. This protects the previous owner's
content.

The confirmation prevents the common failure mode where a recreated user accidentally inherits
a stranger’s workspace.

## Workspace names

- New workspaces get a default name based on the player’s display name, e.g.
  `Богдан — Private`.
- The owner can rename their workspace.
- The GM can rename any workspace from the admin panel, so orphaned journals can be labelled.
- Workspace names are unique case-insensitively so the admin lists stay readable.
- The name is visible to the GM and in raw world data.

## Creation flow

1. A player opens the private tab.
2. The client looks for a workspace whose owner is `game.user.id`.
3. If one exists, it opens.
4. If not, the client asks the active GM to create one.
5. If there is no active GM, the private tab shows that a GM is needed to create the workspace.
6. Once created, the player sees an empty private canvas.

The GM admin panel can also create a workspace for a player.

## Copy/paste flow

1. Select one or more notes on either canvas.
2. Press Ctrl/Cmd+C.
3. Switch to the other canvas.
4. Press Ctrl/Cmd+V.
5. The destination creates new notes with the copied title and text.
6. If the destination is shared, the active GM writes them; duplicate titles get a suffix.

The source notes remain exactly as they were.

## Private transfer flow

The 0.9.0 transfer feature adds a one-way copy between two private canvases; it is not live
sharing.

1. The sender selects one or more notes on their private canvas and chooses **Send to…**.
2. The active GM packs only those notes, their cards, and labels or stamps attached to them into a
   pending record on the **Private Journals** container. The sender keeps the originals.
3. The recipient sees the pending copy in their private inbox and can accept or decline it.
4. Accepting imports fresh note/card/link/label ids into the recipient's private workspace. If the
   recipient already has a pending workspace offer, that page is activated first; otherwise the
   active workspace is used or created.
5. Links to notes outside the selection are dropped, as are route waypoints whose note is outside
   the selection. The sender and recipient see the dropped-link and dropped-waypoint counts.
6. The workspace save and an acceptance receipt (`acceptedTransfers`, capped at 50 ids) are
   written together. The receipt also records the imported note ids. Immediately after the save,
   the importer re-reads the page; if a stale owner save overwrote any imported note, it
   re-imports once against the latest revision. If the notes are still missing, the pending
   transfer is kept and the recipient gets a localized retry error. The pending record is removed
   afterwards with Foundry deletion keys. If removal fails, a retry sees the receipt, verifies its
   note ids still exist, skips the import and only removes the stale offer, so no duplicate notes
   appear. This is best-effort: Foundry journal updates have no server-side compare-and-set, so a
   stale write arriving after the final verification can still overwrite a copy.

Transfers never include shared-journal content or vault/secret content. Pending records are
plaintext flags on the private container, just like the workspaces themselves, and can be read by
any client that can read raw journal flags. Inboxes are capped at 20 pending offers per recipient
and 5 pending offers from one sender to one recipient. Offers older than 30 days are treated as
expired: reads hide them immediately, and the next add deletes their flag keys.

## Testing checklist

- Two different profiles see different private workspaces.
- Renaming a player keeps the same workspace.
- Deleting a player leaves an orphaned workspace, not a deleted one.
- A recreated player gets a fresh workspace by default.
- The GM can assign an orphaned workspace to a player; the player accepts or declines.
- A player with an existing workspace cannot be assigned another one.
- The admin panel shows player names/colors and journal names, with ownership links.
- Owners and the GM can rename a workspace; duplicate names are rejected.
- Private notes never appear in shared search, stats, history, backlinks, or the main canvas.
- Ctrl/Cmd+C and Ctrl/Cmd+V copy notes in both directions; note types survive, while links,
  images, stamps, and layout do not.
- Copying leaves the source note unchanged.
- A player can send selected private notes to another player; the recipient accepts or declines a
  copy, the sender keeps the originals, and a failed removal cannot duplicate the import.
- Two sessions signed in as the same user do not overwrite each other silently.

## Explicitly deferred

- Encryption and per-profile keys.
- Live shared editing or in-place sharing of a private workspace or note.
- Merging workspaces.
- Private statistics across sessions.
- Hiding workspace existence from the GM or host.
