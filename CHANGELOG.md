# Journalinator Patch Notes

These notes start with the small board and toolbar polish patches and cover the follow-up fixes and features.

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
