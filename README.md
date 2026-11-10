# Investigation Board — Collaborative Journal

An Obsidian-inspired shared notes journal and infinite investigation canvas for Foundry VTT v14.

> **This branch is frozen.** It contains an earlier, independent realization of the design that
> became [Journalinator](https://github.com/nmorozov539-wq/Journalinator), originally built by
> Larkar. Active development continues on `main`. This branch is a separate Foundry module
> (`investigation-board`, `0.3.0-alpha.1`), so it can be installed alongside Journalinator.

## Features

- One shared journal and one infinite canvas.
- Fullscreen three-region workspace: note drawer, canvas, and editor.
- Notes can stay in the drawer or be placed once on the canvas.
- Markdown-like blocks with stable IDs and GM-arbitrated edit locks.
- Sticky note, document, and torn-paper card styles.
- Card images, resizing, panning, zooming, and free text labels.
- Curved SVG links with labels, direction, color, and solid/dashed styles.
- Typed `[[wikilinks]]` and `[[Target|label]]` links with backlinks.
- Search, style/placement filters, and jump-to-note navigation.
- Trash with restore for everyone and permanent emptying for GMs only.
- Per-note contribution totals and journal-wide statistics.
- Migration of cards from the first board of version 0.2.0.
- Russian and English localization.

The alpha keeps future GM visibility fields in the data model, but hidden-content storage is not
enabled. For the encrypted GM tier, use Journalinator on `main`.

## Install

1. Download this branch as a ZIP:

   ```text
   https://github.com/nmorozov539-wq/Journalinator/archive/refs/heads/investigation-board.zip
   ```

2. Copy the `investigation-board/` directory from the archive into
   `<Foundry user data>/Data/modules/`.
3. Restart Foundry and activate **Investigation Board** in the world.

The alpha was verified with Foundry VTT `14.367`. Back up the world before trying it.

## Controls

- Mouse wheel: zoom toward the pointer.
- Right-drag anywhere on the canvas: pan.
- Drag a card header: move it.
- Drag the lower-right corner: resize it.
- Drag the round handle on a card to another card: create a link.
- Click a link: configure label, direction, color, and line style.
- `Ctrl+Shift+I`: open or close the journal.

## Development

The installable module is in [`investigation-board/`](investigation-board/). The static project
page in [`docs/`](docs/) is Russian-language.

There is no build step; Foundry loads `investigation-board/scripts/investigation-board.js` and
`investigation-board/styles/investigation-board.css` directly.

## Project

- Active module: [Journalinator](https://github.com/nmorozov539-wq/Journalinator)
- This branch: [investigation-board](https://github.com/nmorozov539-wq/Journalinator/tree/investigation-board)
- Specification: [Collaborative Notes Canvas](docs/Collaborative%20Notes%20Canvas%20Module%20Spec.md)

## License

MIT. See [`investigation-board/LICENSE`](investigation-board/LICENSE).
