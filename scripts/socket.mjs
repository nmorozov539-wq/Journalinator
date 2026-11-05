import { getContainerIds } from "./store/containers.mjs";
import { CARD_STYLES, seedTilt } from "./styles/registry.mjs";

const MODULE_ID = "fvtt-journalinator";
const CHANNEL = `module.${MODULE_ID}`;

/**
 * Phase 1 write path: no lock/arbitration queue yet (that's spec §6.6, Phase 4) — just a
 * direct "ask the active GM to do it" relay, enough to prove the socket channel and the
 * create/save flows work end to end. The server appends the sender's verified user id as
 * the socket relay's own trailing argument (see dist/server/sockets.mjs handleCustomSocket),
 * so `senderUserId` below is never something a client could spoof.
 *
 * Card drags/resizes are NOT streamed (spec §8.1) — the client only calls requestWrite once,
 * on drop/release, with the final position. There's also no "held by" pick-up marker yet
 * (that's part of the lock system in Phase 4), so two people dragging the same card at once
 * can still race; acceptable for now, revisit alongside block locking.
 */
export function registerSocket() {
  game.socket.on(CHANNEL, (message, senderUserId) => {
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;
    handleMessage(message, senderUserId);
  });
}

function layoutPage(shared) {
  const ids = getContainerIds();
  return ids ? shared.pages.get(ids.layoutPage) : null;
}

async function handleMessage(message, senderUserId) {
  const ids = getContainerIds();
  if (!ids) return;
  const shared = game.journal.get(ids.shared);
  if (!shared) return;

  switch (message.type) {
    case "createNote": {
      const style = CARD_STYLES[message.style] ? message.style : "sticky";
      const page = await JournalEntryPage.create({
        name: message.title,
        type: `${MODULE_ID}.note`,
        system: {
          style,
          blocks: [{ blockId: foundry.utils.randomID(), text: "New note. Click here and start writing." }],
          authorId: senderUserId,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      }, { parent: shared });

      const layout = layoutPage(shared);
      if (layout) {
        await layout.update({
          [`system.cards.${page.id}`]: {
            x: message.x ?? 0,
            y: message.y ?? 0,
            rotation: seedTilt(style)
          }
        });
      }
      return;
    }

    case "saveNote": {
      const page = shared.pages.get(message.noteId);
      if (!page) return;
      await page.update({
        "system.blocks": message.blocks,
        "system.updatedAt": Date.now(),
        "system.editCount": (page.system.editCount ?? 0) + 1
      });
      return;
    }

    case "setNoteStyle": {
      const page = shared.pages.get(message.noteId);
      if (!page) return;
      await page.update({ "system.style": message.style });
      return;
    }

    case "setNoteImage": {
      const page = shared.pages.get(message.noteId);
      if (!page) return;
      await page.update({ "system.image": message.image || null });
      return;
    }

    case "moveCard": {
      const layout = layoutPage(shared);
      if (!layout) return;
      await layout.update({
        [`system.cards.${message.noteId}.x`]: message.x,
        [`system.cards.${message.noteId}.y`]: message.y
      });
      return;
    }

    case "resizeCard": {
      const layout = layoutPage(shared);
      if (!layout) return;
      await layout.update({
        [`system.cards.${message.noteId}.width`]: message.width,
        [`system.cards.${message.noteId}.height`]: message.height
      });
      return;
    }

    case "addLabel": {
      const layout = layoutPage(shared);
      if (!layout) return;
      const labelId = foundry.utils.randomID();
      await layout.update({
        [`system.labels.${labelId}`]: {
          text: message.text ?? "Label",
          x: message.x ?? 0,
          y: message.y ?? 0,
          size: message.size ?? 14,
          color: message.color ?? ""
        }
      });
      return;
    }

    case "updateLabel": {
      const layout = layoutPage(shared);
      if (!layout) return;
      const updates = {};
      for (const field of ["text", "x", "y", "size", "color"]) {
        if (field in message) updates[`system.labels.${message.labelId}.${field}`] = message[field];
      }
      await layout.update(updates);
      return;
    }

    case "removeLabel": {
      const layout = layoutPage(shared);
      if (!layout) return;
      await layout.update({ [`system.labels.-=${message.labelId}`]: null });
      return;
    }
  }
}

/** Sends a write request to the active GM. If we are the active GM, applies it directly. */
export function requestWrite(message) {
  if (game.users.activeGM?.id === game.user.id) {
    return handleMessage(message, game.user.id);
  }
  game.socket.emit(CHANNEL, message);
}
