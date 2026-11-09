# Investigation Board

**Investigation Board** is a collaborative notes journal and infinite investigation canvas for Foundry Virtual Tabletop 14. Players can collect clues, arrange cards, connect evidence, and develop theories together during a session.

[Project page](https://larkar789.github.io/investigation-board/) · [Latest release](https://github.com/Larkar789/investigation-board/releases/latest) · [Functional specification](docs/Collaborative%20Notes%20Canvas%20Module%20Spec.md)

## Collaborative journal fork

The `fork/collaborative-notes-canvas` branch contains the current `0.3.0-alpha.1` architecture:

- one shared journal and infinite canvas;
- a three-region fullscreen workspace;
- GM-arbitrated block edit locks;
- sticky, document, and torn-paper cards;
- curved, labelled, directional connections;
- wikilinks and backlinks;
- search, filters, trash, restore, and contribution statistics;
- Russian and English localization;
- migration from the first board created by version 0.2.0.

The `main` branch preserves the compact floating-window version `0.2.0`.

## Install

1. Download the ZIP from the latest GitHub release.
2. Extract the `investigation-board` directory into `<Foundry user data>/Data/modules/`.
3. Restart Foundry and activate **Investigation Board** in your world.

The alpha is verified with Foundry VTT `14.367`. Back up the world before trying an alpha build.

## Development

The installable module is in [`investigation-board/`](investigation-board/). The static GitHub Pages site is in [`docs/`](docs/).

## License

The module is released under the [MIT License](investigation-board/LICENSE).
