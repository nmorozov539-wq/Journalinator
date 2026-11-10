# Journalinator

A shared, Obsidian-style corkboard journal for Foundry VTT v14. Notes are cards on one canvas.
Everyone writes together with per-paragraph locking, links notes by drawing or by typing
`[[Title]]`, and the GM can keep secrets and reveal them as the players discover things.

Status: pre-alpha (0.1.0).

## Using it

Open it from the sticky-note button in the scene controls.

- **Notes:** double-click the canvas or use **+ New Note**. Click a paragraph to edit it. A blank
  line + Enter splits a paragraph; Backspace at the start merges it into the one above.
- **Links:** drag from a card's link handle to another card, or type `[[Another Note]]`. Unknown
  titles become new notes.
- **Search:** Ctrl/Cmd+K jumps to a note or creates one.
- **Trash:** anyone can delete and restore notes; only the GM can empty the trash.

Players hold Observer permission. Every change is carried out by the active GM's client, so
**while no GM is connected the journal is read-only**.

## GM secrets

GMs (and Assistant GMs, unless the world setting turns that off) get extra controls in the top
bar.

1. Click **Set up secrets** and choose a mode:
   - **Passphrase (recommended).** Secrets are encrypted with a key only your passphrase opens.
     Players' browsers receive the encrypted vault but can't read it. Use something long, like
     four or five random words: a player could copy the vault and try guesses offline.
   - **No passphrase.** Still encrypted, but the key is stored next to it, so a player with the
     browser console can read everything. Only stops casual peeking.
2. Write secret things:
   - **+ Secret Note** (or Alt + double-click the canvas). Secret notes get a `GM-XXXX` prefix so
     you can tell them apart from player notes.
   - **+ Hidden block** in any shared note, or hover a paragraph and click **+**.
   - **Hide** on a shared paragraph or link moves it into your secrets. Players have already seen
     it, so this is for tidying the board, not undoing a slip.
   - **+ GM Label**, and any link touching a secret note, are GM-only.
3. Reveal things as players discover them:
   - **Reveal** on a hidden paragraph publishes it in the same spot.
   - **Declassify…** on a secret note publishes it under a title you choose (without the prefix).
   - **Reveal** on a GM-only link between two shared notes publishes the link.
4. **Mark as hint** (notes) and **✦** (links) show players a gold "from the GM" marker.

**GM view / Player view** switches between your merged view and exactly what players see.

### What players can and can't learn

Players never receive hidden text, secret titles or ids, or hidden links in readable form. Their
notes simply don't contain the hidden parts, so there are no gaps or length hints. A player can
create a note with the same title as one of your secret notes; nothing tells them it exists.

Images on secret notes are ordinary files on the server: the vault hides which image a note
uses, not the file itself.

They *can* see that the encrypted vault changed (so they can tell that you edited secrets), and
roughly how big it is, in steps that double (16 KB, 32 KB, ...).

Changing the passphrase, or switching modes, makes a brand-new key; old passphrases stop
working. "Remember on this browser" keeps the key in that browser's local storage for this world.
**If you forget the passphrase and no browser remembers it, the secrets are gone.**

## Known trade-off: deactivating the module

The module stores notes as its own `JournalEntryPage` sub-types. If you deactivate it, those
pages become invalid and disappear from view until the module is enabled again. The data is not
lost. The module's three journal entries are hidden from the Journal sidebar on purpose; don't
edit them by hand.

## Development

No build step: Foundry loads `scripts/init.mjs` and `styles/journal.css` directly.

```sh
node --test tests/*.test.mjs   # crypto, model, and integration tests (no dependencies)
npm install && npm test        # also runs the jsdom UI smoke test
npm run check                  # node --check over every script
```

See `HANDOFF.md` for the architecture, known bugs, and the testing checklist, and the spec for
the design.
