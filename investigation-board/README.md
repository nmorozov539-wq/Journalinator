# Investigation Board

System-independent shared investigation canvas for Foundry Virtual Tabletop 14.367.

## Features

- Multiple investigation boards in one world.
- Infinite pan-and-zoom canvas with a dot grid.
- Notes, clues, people, locations, and image cards.
- Visual links between cards.
- Real-time player collaboration through Foundry's module socket.
- Persistent world storage, written by the active GM.
- Search, resize, fit-to-content, JSON import/export, and Russian/English UI.

## Installation for local testing

1. Copy the `investigation-board` folder to `<Foundry user data>/Data/modules/`.
2. The folder name must match the manifest id: `investigation-board`.
3. Restart Foundry, enable **Investigation Board** in the world, and reload.
4. Open it with the floating button at the lower-left, the scene control button, or `Ctrl+Shift+I`.

If this source folder is named `Investigation board`, rename the copied folder to `investigation-board` before starting Foundry.

## Collaboration model

All connected clients receive changes immediately. The first active GM acts as the persistence authority and stores the current board data in a hidden world setting. Players can edit by default; a GM can disable this in **Configure Settings → Module Settings**.

Card images are stored as URLs, not embedded files. This keeps world data small and makes exports portable when the URLs remain available.

## Controls

- Mouse wheel: zoom toward the pointer.
- Drag empty space or right-drag anywhere: pan.
- Double-click empty space: create a note.
- Drag a card by its header: move it. Double-click a card to edit it.
- Drag the lower-right corner: resize it.
- Link tool: select two cards to connect them.
- `Delete`: delete the selected card.
- `Escape`: return to select mode or close the editor.

## Data safety

Use **Export** periodically to download a JSON backup. Only GMs can import a backup or create, rename, and delete whole boards.
