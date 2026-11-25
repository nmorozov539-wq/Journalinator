# Private Workspaces — Design

Status: implemented in 0.8.x.

## Summary

Every Foundry user gets one private workspace: a separate Journalinator canvas that only that
profile can open through the UI. It is isolated from the shared board. There is no sharing, no
reader list, no import from the shared board, and no private content on the main canvas.

This is a **UI-private** feature, not encryption. See the security boundary below.

## Goals

- Give each user a personal canvas for notes they do not want on the shared board.
- Keep private notes out of the shared canvas, search, stats, history, links, and trash.
- Add a simple **Main canvas | Private canvas** switch.
- Let the owner rename their private workspace.
- Let the GM repair workspaces when a user is deleted, recreated, or needs reassignment.
- Let a private note be copied to the shared board as a one-time publication.

## Non-goals

- Encryption at rest.
- Sharing a private note with selected readers.
- Importing shared notes into a private workspace.
- Merging two private workspaces.
- Private links between notes in the first version.
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
- private links are out of scope for the first version; `[[...]]` text stays plain text;
- the private workspace has its own undo, trash, and restore behaviour.

### Publishing

A private note has one bridge to the shared board: **Publish to shared board**.

Publishing:

- asks for confirmation;
- copies only the title and text;
- preserves Markdown and paragraph text, but strips links, images, styles, stamps, card layout,
  and every other private detail;
- creates a new shared note on the main canvas;
- leaves the private note unchanged and independent;
- does not keep the two notes in sync.

If the title is already used on the shared board, the publish dialog asks the player to choose
another title. The private note is not changed.

Publishing requires an active GM, like every other shared write.

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
  - `state: "active" | "orphaned" | "pending" | "archived"`
  - `rev: number`
  - the private canvas payload:
    - notes (title, Markdown blocks, card style, card position)
    - layout and viewport
    - private trash
    - timestamps

The page name is intentionally public metadata. The note contents are not.

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
workspace ID, name, and contents remain until the GM explicitly archives or deletes it.

A newly created user gets a new user ID and therefore a fresh empty workspace. The GM can
reassign an orphaned workspace to that user, with player confirmation.

The system never matches workspaces by player name. Names are editable metadata, not identity.

## GM admin panel

The GM gets a **Private Journals** manager. Its list shows only workspace names — no owner,
state, note count, dates, or contents.

Per workspace actions:

- **Rename**
- **Assign to player…**
- **Detach from player**
- **Archive**
- **Delete…** with a strong confirmation

Rules:

- An active workspace must be detached before it can be assigned to someone else.
- Assignment is blocked if the target player already has an active or pending workspace.
- The GM never opens the workspace contents from this panel.
- The panel is the only place to repair or transfer orphaned workspaces.

Because status is not displayed, invalid actions are reported as short errors rather than
persistent status badges.

## Reassignment and player confirmation

When the GM assigns a workspace, it enters `pending` with a `pendingOwnerUserId`. It is not
visible to that player yet.

On opening the private tab, the player sees a prompt containing only the workspace name:

> The GM wants to give you the private journal “Old journal”. Accept or decline.

- **Accept** binds the workspace to the player and makes it active.
- **Decline** clears the pending owner and returns the workspace to orphaned.

No note count, dates, or contents are shown in the prompt. This protects the previous owner's
content and follows the name-only admin rule.

The confirmation prevents the common failure mode where a recreated user accidentally inherits
a stranger’s workspace.

## Workspace names

- New workspaces get a default name based on the player’s display name, e.g.
  `Богдан — Private`.
- The owner can rename their workspace.
- The GM can rename any workspace from the admin panel, so orphaned journals can be labelled.
- Workspace names are unique case-insensitively so the name-only admin list stays usable.
- The name is visible to the GM and in raw world data.

## Creation flow

1. A player opens the private tab.
2. The client looks for a workspace whose owner is `game.user.id`.
3. If one exists, it opens.
4. If not, the client asks the active GM to create one.
5. If there is no active GM, the private tab shows that a GM is needed to create the workspace.
6. Once created, the player sees an empty private canvas.

The GM admin panel can also create a workspace for a player.

## Publishing flow

1. The player saves any in-progress edit.
2. The player chooses **Publish to shared board** on a private note.
3. The confirmation explains that the title and text will become visible to everyone.
4. The player confirms or changes the title if it is already taken.
5. The active GM creates a new shared note with the title and text only.
6. The private note remains exactly as it was.

## Testing checklist

- Two different profiles see different private workspaces.
- Renaming a player keeps the same workspace.
- Deleting a player leaves an orphaned workspace, not a deleted one.
- A recreated player gets a fresh workspace by default.
- The GM can assign an orphaned workspace to a player; the player accepts or declines.
- A player with an existing workspace cannot be assigned another one.
- The admin panel lists only workspace names.
- Owners and the GM can rename a workspace; duplicate names are rejected.
- Private notes never appear in shared search, stats, history, backlinks, or the main canvas.
- Publishing copies title and text only; no links, images, styles, or layout.
- Publishing leaves the private note unchanged.
- Two sessions signed in as the same user do not overwrite each other silently.

## Explicitly deferred

- Encryption and per-profile keys.
- Sharing a private workspace or note with another player.
- Importing shared notes into a private workspace.
- Merging workspaces.
- Private links and private statistics.
- Hiding workspace existence from the GM or host.
