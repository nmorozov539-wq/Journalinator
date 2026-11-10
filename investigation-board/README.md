# Investigation Board — Collaborative Journal

An Obsidian-inspired shared notes journal and investigation canvas for Foundry Virtual Tabletop
v14. This is the `investigation-board` branch of
[Journalinator](https://github.com/nmorozov539-wq/Journalinator): an earlier, independent
realization of the design, kept for reference. It is a separate module and does not include the
encrypted GM tier.

## Included in this alpha

- One shared journal and one infinite canvas.
- Fullscreen three-region layout: note drawer, canvas, and note editor.
- Notes may remain in the drawer or be placed once on the canvas.
- Markdown-like blocks with stable IDs and GM-arbitrated edit locks.
- Sticky note, document, and torn-paper styles from an extensible registry.
- Optional card images, resizing, panning, zooming, and free text labels.
- Curved SVG links created by dragging between cards.
- Link labels, arrow direction, color, and solid/dashed styles.
- Typed `[[wikilinks]]` and `[[Target|label]]` links resolved by stable note ID.
- Backlinks, search, style/placement filters, and jump-to-note navigation.
- Trash with restore for everyone and permanent emptying for GMs only.
- Per-note contribution totals and journal-wide activity statistics.
- Automatic migration of cards from the first board of version 0.2.0.
- Russian and English localization.

## Collaboration model

The first active GM is the authority for edits and world persistence. Block lock requests are
granted in arrival order. Players can read without a GM, but editing becomes read-only until a
GM connects. Locks expire after the configured timeout.

Updates are sent when an operation finishes; card dragging and cursor movement are not streamed
continuously.

## Installation

Copy the `investigation-board` directory to `<Foundry user data>/Data/modules/`, restart Foundry,
and activate the module in the world. Open it from the Scene Controls button or with
`Ctrl+Shift+I`.

## Controls

- Mouse wheel: zoom toward the pointer.
- Right-drag anywhere on the canvas: pan.
- Drag a card header: move it.
- Drag the lower-right corner: resize it.
- Drag the round handle on a card to another card: create a link.
- Click a link: configure label, direction, color, and line style.

## Links

- [Branch source](https://github.com/nmorozov539-wq/Journalinator/tree/investigation-board)
- [Download this branch](https://github.com/nmorozov539-wq/Journalinator/archive/refs/heads/investigation-board.zip)
- [Active module (Journalinator)](https://github.com/nmorozov539-wq/Journalinator)

The alpha keeps future GM visibility fields in the data model, but hidden-content storage is not
enabled yet. A later GM-tier implementation must use storage that is never delivered to player
clients.
