# Journalinator Patch Notes

These notes start with the small board and toolbar polish patches and cover the follow-up fixes and features.

## Unreleased — Note system rewrite

This development build replaces the note system. It is not a release and has not been verified in real Foundry multiplayer yet.

- One note is one Markdown body. The first-line H1 is the title; later H1s render as headings. The old separate note name, label, title/heading fields, block list and paragraph widgets are gone. Duplicate and empty titles are allowed, and Foundry's page name is hidden.
- Notes open directly on the card as a single Markdown source surface. Title, Divider and Portrait tools edit the source; native undo/redo, selection, copy/paste and IME remain available. The editor autosaves, shows `Saved`/`Saving…`/offline/failure states, and keeps unsaved text in a local recovery draft.
- Other viewers see the rendered text update while the editor types. Cards grow automatically with their content up to the layout width cap, then vertically. Manual resize overrides Auto, and automatic resizing keeps the main pin fixed.
- Plain and Profile layouts replace note types. Profile requires a first-line title, an optional underline, a portrait image and an optional `## Caption`; an incomplete Profile renders as Plain and shows one editor-only hint. Blank, Document and Profile creation templates choose the initial body, layout and skin.
- Appearance is a skin: Cream, Amber or Parchment paper, Default/Serif/Handwritten/Display font, torn edges and an optional decorative background. Tilt is seeded from the note ID and stays stable. Changing layout or skin never rewrites the note text.
- A whole-note edit lease replaces paragraph locks. One client edits at a time; other clients can read but cannot mutate, drag, resize, restyle, delete or transfer a locked note. A missing GM leaves shared notes read-only, and a GM can force-unlock after confirmation.
- History keeps up to 20 distinct text snapshots per note with session-start, periodic and pre-restore checkpoints. The history dialog previews versions and restores text only; it does not restore pins, threads, appearance or geometry.
- Search and the quick switcher use derived titles and excerpts, falling back to `Image note` or `Empty note`. Filters are All/Plain/Profile plus author; the old Location and style-as-type filters are gone.
- Transfers, clipboard, publishing and route notes use the schema v2 payload. Copies get fresh identities, remap eligible internal connections, and report dropped external links or route waypoints. Private canvases keep their owner/admin path and add local tab coordination plus a workspace revision guard; their history stays workspace-local.
- Removed: the GM secret/vault system, secret notes and hidden blocks/links, Location notes, actor linking, the statistics window and rankings, the old block/paragraph editor, and typed `[[wikilink]]` creation.
- Clean break: there is no migration or legacy adapter. Older shared or private data is shown with a read-only notice and is left unchanged. Use a fresh test world or ask the host to reset Journalinator data.

## 0.9.7 — Link overhaul

- Thread controls now live only on the right panel, next to the note controls. The floating menu
  that opened when you tapped a thread is gone. The panel works on every kind of thread (drawn
  between pins, or note links), shows each control's current value, and has a new actions group
  for delete, GM hide/hint, route detach and clearing free pins.
- Fixed the controls that appeared to do nothing. Threads drawn between pins used a separate,
  stripped-down renderer; they now share one with note links, so ends (loose tails), alternating
  colors, material and pattern all show. The alternating pattern finally has an accent-color
  picker in the Pattern group.
- Threads no longer carry text labels (place a small note next to a thread instead). Existing
  labels disappear from the board; the stored data is kept.
- Loose threads now hang like a rope: the thread is a single smooth curve that leaves each pin
  steeply and sags under gravity, instead of being pulled down in the middle. Hang is the old
  Slack, as a share of the span with no 100 px cap; near-vertical threads bow sideways.
- New link style (the "pen"): a menu next to the Pin tool picks the style new threads start with,
  from the four built-in presets or your own saved presets. With the Pin tool on and nothing
  selected, the right panel tunes it. The draw preview now shows the real thread.
- Shortcuts: while dragging a new thread, the mouse wheel changes thickness and Alt+wheel changes
  hang. The same keys work over the selected thread.
- Dragging a thread or pin to the edge of the board now scrolls the camera.
- Fixed dropping a note onto a thread to route it, which needed an update for the new curve.

## 0.9.6 — Pin selection

- Box selection now includes free board pins. Selecting an attached pin selects its owning note,
  because attached pins are handles for the note rather than separate board objects.
- Selected free pins move with the selected note group during card dragging, and their final
  positions are saved with the notes.
- Pins with no transferable connection are treated as orphaned and never cross canvases. A
  note-owned pin only travels when a packed pin link references it, even when its note is
  selected; free pins and pins connected only to unselected objects stay behind.

## 0.9.5 — Pin stability and scaling

- Deleting a manually placed pin now removes the pin and all of its connected pin links from the
  saved board, and they stay deleted after reopening. Main pins keep their protected behavior.
- Pin conversion during a move now removes the old note anchor explicitly, and pin undo/rollback
  restores the exact previous anchor and attachment state.
- Pins no longer jump after save/sync rerenders or reconnection. Deferred renders measure the
  finished card before positioning pins and thread endpoints, including auto-sized cards.
- Pin heads keep a fixed board size so they scale naturally with the cards. Their hit targets and
  the link magnet stay screen-sized, so links snap when they touch a pin at any zoom.
- Pin buttons and the drag ghost no longer inherit Foundry's 500 ms button transition, so pins
  track card movement and pin dragging immediately.

## 0.9.4 — Canvas interaction polish

- Notes no longer show a player signature; authorship and permissions remain in saved data.
- Pins draw above existing and preview threads, keep a steady screen size while zooming, and
  remain the first pointer target where they overlap a thread.
- The Pin tool stays visibly selected while active. Manually placed pins can be removed with
  Backspace, which also removes their attached connections; default pins are protected.
- Moving a pin now updates its position and connected threads with the pointer before saving
  its final owner and position.
- Existing threads can be selected through a wider invisible hit area, and their settings are
  saved and restored on both canvases.
- Double-clicking note text edits that note. Double-clicking empty canvas opens a single-level
  note-type menu and creates a note only after a type is chosen.
- The module zip now contains the `fvtt-journalinator` folder expected by Foundry.

## 0.9.3 — Canvas gestures and free pins

- Double-click a note's text to edit it, or double-click empty canvas to create a note there.
  A single click selects without opening the editor, and a double-click on a note or pin does
  not create a note underneath it.
- Right-button dragging pans the camera even when it starts on a note or pin. Note actions
  moved to the right panel, and the interactive canvas no longer opens a browser context menu.
- The Connection tool was replaced by one **Pin** tool. Every new note has a fixed top-center
  default pin. Extra pins can be placed anywhere on a note or on empty canvas without edge
  snapping. All pins share the primary pin appearance.
- Start connections from any pin with a click or a drag. A click leaves a preview thread
  following the pointer; click a destination pin or note body to finish. Dropping on a note body
  uses that note's default pin. Clicking empty canvas or the source pin cancels the preview.
- Move a manually placed pin by double-clicking it to pick it up, or by dragging on the second
  press of a double-click. Pins can move between notes and the canvas without losing their
  connections. The fixed default pin cannot be moved.
- Threads may reach pins from any direction and cross notes without an outside-edge hook.
- The selected private note has one **Send to…** action in the right panel. It offers the Main
  Canvas and eligible private canvases. Publishing or transferring a private note leaves the
  source in place; a GM's existing secret-note publication still removes its secret source.
- Saved canvases retain pin identity, ownership, exact position, and connection endpoints.
  Existing notes and legacy anchor-linked connections remain readable; moving a legacy pin
  converts its endpoints to the new pin reference format.

## 0.9.2 — Themes, images, and canvas fixes

- Themes are now data, not a two-value switch: a theme controls the board background (colour,
  dots/grid pattern, size, opacity, vignette, local image), every note type's surface, edge,
  radius, shadow, author stripe, and title/heading/body typography, and all shared colour roles.
- The palette menu lists registered themes dynamically. Classic and Warm keep their look; a new
  light **Parchment** theme ships as a demonstration.
- `game.journalinator.themes.register(id, theme, { persist })` adds a theme from a macro or another
  module. Saved themes load from a client setting. `journalinatorThemeChanged` and
  `journalinatorRegisterThemes` hooks are available.
- Theme values are validated and clamped; images are restricted to Foundry data routes.
- Note portraits and card backgrounds now accept a path inside Foundry's data folder as well
  as an external `http(s)` URL, and the image dialog has a **Browse…** button that opens the
  Foundry file picker.
- **From scene** generates a theme from the active scene's background: OKLab clustering, a
  scene-tuned role picker, automatic dark/light mode, contrast-corrected text, and semantic
  GM/hint/danger colours preserved. It follows the active scene and falls back to Classic when
  the image is unreadable.
- Link colors are theme slots now. Classic keeps its old three colors; other themes pick their
  own, and **From scene** derives three link colors from the map.
- Selected links get a soft ring, a thicker line, and larger pins and arrowheads.
- Link labels and pins follow the board color, so custom boards no longer show bright patches.
- Link pins, arrows, and labels keep a steadier size while zooming.
- A **Patch notes** button in the bottom-left corner of the canvas opens this changelog. Versions
  are grouped into foldable series and shown one at a time.
- Pin rendering now measures the finished note, keeping attachments aligned with notes whose
  text or images change their size. Existing pins stay visible as the primary thread endpoints.
- Pin and link writes refresh the final canvas state after Foundry document updates, reducing
  brief endpoint jumps. Removing a connection cleans up stale legacy minor anchors.
- Scene-control activation checks handle Foundry's tool collections consistently, and the
  toolbar's Trash button is available on the private canvas when it has a workspace.

## 0.9.1 — Safe deletion and control-mode fixes

- **Scene control no longer reopens on deactivation.** Foundry calls a scene control's
  `onChange(event, active)` on both activation and deactivation. Journalinator now opens only for
  the activating call, reuses the one rendered window, brings it to the front, and never renders a
  closed instance. Closing the window returns the left control bar to **Tokens**; choosing another
  control leaves Journalinator closed.
- **Deletion confirmation and recovery.** Deleting a single note stays immediate but now says
  **"Deleted N note(s). Restore from Trash or press Ctrl+Z."** Selecting several notes (shared or
  private) asks for confirmation first; cancelling deletes nothing, including selected labels.
- **Trash shows deletion details.** Each trash row now names who deleted a shared note and when,
  or shows a neutral fallback when older data has no deletion metadata. Private trash rows show
  when the notes were deleted. Both dialogs explain that trash contents are recoverable.
- **Trash badge.** The Trash toolbar button shows a count badge while the shared or private trash
  is non-empty, so missing notes are discoverable without opening the dialog. The badge floats in
  the toolbar and reserves no canvas space.
- **Private save conflicts are clearer.** The revision guard still refuses stale writes, and the
  warning now explains that another tab or GM changed the private space, that the latest data was
  reloaded, and that unsaved local changes were not saved.
- **Filter state is visible.** A compact top-bar indicator reports **"N hidden by filter"** (or
  **"Filtered"**) while search or style/author filters are active, so dimmed cards are not mistaken
  for deleted notes. The stats window continues to disclose **trash not counted**.

## 0.9.0 — Fit view, private transfers, and live stats

- **Fit all:** a new canvas control frames every note at once, with a safe zoom limit so tiny and
  huge boards both stay usable.
- **Private note transfers:** select notes on your private canvas and send a copy to another
  player. The recipient accepts or declines from an incoming-notes list. Transfers wait in the
  private journal container until accepted. A failed save leaves the offer intact, and if the
  copy saves but its inbox removal fails, retrying recognises the acceptance receipt and removes
  the stale offer without importing duplicate notes. After an accept save, the importer re-reads
  the workspace and re-imports once if a stale owner save overwrote the copied notes; if they are
  still missing, the offer is kept and the recipient sees a localized retry error instead of a
  false success. This is best-effort mitigation: Foundry's journal update has no server-side CAS,
  so a write landing after the final verification can still overwrite a copy.
- Pending inboxes are bounded: at most 20 offers per recipient, at most 5 from one sender to one
  recipient, and offers older than 30 days are hidden on read and their flag keys deleted on the
  next add.
- Transfers copy only the selected notes, their cards, and stamps or labels attached to those
  notes. Images, backgrounds, presentation, attachment settings, and note text travel with the
  copy; links to notes outside the selection and route waypoints on outside notes are dropped,
  and the sender/recipient see the actual dropped-link and dropped-waypoint counts. Free board
  labels are never included, and shared or vault content is never copied.
- Imported notes get fresh note, card, link, and label ids, keep their original spacing near the
  source positions without overlapping existing cards (rotated cards use their true rotated
  bounds), and belong to the recipient. A recipient with a pending private page activates it
  before importing so the copy is visible immediately. Private journals and their pending
  transfers remain plaintext: Foundry sends journal flags to every connected client, so this is
  UI privacy, not encryption.
- **Main-canvas stats count live shared notes only.** Trash is disclosed separately, and private
  notes, private trash, pending transfers, and vault/secret notes are never counted in the shared
  statistics window, even when the GM vault is unlocked and merged into the canvas.

## 0.8.4 — Keep the note type when copying

- Ctrl/Cmd+C and Ctrl/Cmd+V now preserve the card type between the main and private canvases,
  including the Target card's heading. Content links, images, stamps, and layout are still left
  behind.

## 0.8.3 — Private canvas controls and journal manager

- Private notes now have the same canvas controls as the main board: note types, labels, stamps,
  card backgrounds, links, style filters, theme, stats, and trash.
- Deleting a private note now correctly removes its card and keeps a restorable trash copy.
- The workspace picker is a proper dropdown. The button beside New Note is gone, and the private
  entry has a pencil icon for renaming the workspace.
- The Private Journals manager is now a two-column layout: players on the left, journals on the
  right, with lines showing ownership. Right-click a journal for rename, assign, detach, and
  delete.
- Archived journals were removed; unowned journals are simply listed as unassigned.

## 0.8.2 — Copy and paste notes

- Select notes and use Ctrl/Cmd+C and Ctrl/Cmd+V to copy them between the main canvas and the
  private canvas, in either direction. The same shortcut duplicates notes inside one canvas.
- Copies contain only the title and text. Links, images, styles, and card layout are not copied.
- Pasting onto the shared canvas needs a GM; duplicate titles get a numeric suffix.

## 0.8.1 — Private canvas fix

- Private workspaces now use a standard Foundry journal page type. This fixes the
  “private is not a valid page type” error when the Foundry server was started before the
  module update.
- Existing private pages created during the beta still open and save.
- Restart Foundry after updating so the browser, server manifest, and module files all match.

## 0.8.0 — Private canvases

- Every player profile gets a **Private canvas** next to the main board. Private notes, cards,
  search, and trash stay out of the shared canvas.
- Private journals can be renamed. Players get their own; the GM can create, detach, assign, or
  delete them from the management panel.
- If a player is deleted or recreated, their old private journal is kept and can be reassigned.
  The receiving player must accept the offer first.
- A private note can be published to the shared board as a new copy. Only the title and text are
  copied; links, images, styles, and layout stay private.
- Private workspaces are UI-private, not encrypted.

## UI polish and fixes

- Card images are smaller and have rounded corners, so they take up less room on the board.
- The little pencil badge that shows someone is editing a note now sits in the top-right corner and no longer jumps when you hover.
- Link labels have a stronger outline, so they stay readable over busy backgrounds.
- The toolbar is grouped into clearer sections. New note, label, link, filters, theme, trash, and stats are easier to scan and each button has a proper tooltip.
- The search box no longer stretches across the whole toolbar on wide screens.

## Writing notes

- Note text now displays Markdown: headings, bold and italic text, lists, quotes, tables, code, links, images, and task checkboxes.
- Task checkboxes work. Click one to mark it done or not done, and the note saves the change.
- Typing an opening bracket, quote, or bold marker adds the matching closing character for you. Selected text can be wrapped the same way.
- Joining two paragraphs no longer throws away text that was typed but not saved yet.
- Before a hidden paragraph or secret note is made public, the confirmation now checks what is currently in the editor, including unsaved typing.

## Finding things and moving around

- The quick switcher now respects the author and note-style filters, not just the search text.
- Links between notes stay curved all the way to the card. They no longer snap into a straight line when two cards are close together.
- Session summaries in the statistics window now include every day up to the next session marker, not only the marker day itself.
- Links created by typing `[[Note]]` now count toward “links drawn” in the statistics.

## Reliability

- If one of the journal’s helper pages or containers goes missing, it is restored automatically the next time the world loads.
- When no GM is connected, the board clearly switches to read-only. Editing buttons are disabled, card and label changes are blocked, and anyone who tries a write gets a short warning instead of silence.
- Two GMs editing the secrets vault at the same time no longer silently overwrite each other’s work. Recent changes are kept and re-applied.
- The board re-checks itself when players connect or disconnect, so the read-only state and controls update without a reload.
- Long sessions are less likely to build up stale background work after repeated board redraws.
