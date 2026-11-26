# Journalinator Patch Notes

These notes start with the small board and toolbar polish patches and cover the follow-up fixes and features.

## Unreleased — Themes, images, and link styling

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
- **Prototype — actor status badges:** a GM can right-click a note and choose **Link actor…**.
  While the linked actor has the core **Dead** status, the card shows a small skull. Linking a
  scene follows that scene's tokens, so an unlinked actor can be dead in one scene and alive in
  another. The badge is derived per client from documents that client can already see; actor
  state is never copied into the shared journal.

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
