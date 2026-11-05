import { getContainerIds } from "./store/containers.mjs";

const MODULE_ID = "fvtt-journalinator";
const CHANNEL = `module.${MODULE_ID}`;

/**
 * Phase 1 write path: no lock/arbitration queue yet (that's spec §6.6, Phase 4) — just a
 * direct "ask the active GM to do it" relay, enough to prove the socket channel and the
 * create/save flows work end to end. The server appends the sender's verified user id as
 * the socket relay's own trailing argument (see dist/server/sockets.mjs handleCustomSocket),
 * so `senderUserId` below is never something a client could spoof.
 */
export function registerSocket() {
  game.socket.on(CHANNEL, (message, senderUserId) => {
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;
    handleMessage(message, senderUserId);
  });
}

async function handleMessage(message, senderUserId) {
  const ids = getContainerIds();
  if (!ids) return;
  const shared = game.journal.get(ids.shared);
  if (!shared) return;

  if (message.type === "createNote") {
    await JournalEntryPage.create({
      name: message.title,
      type: `${MODULE_ID}.note`,
      system: {
        style: "sticky",
        blocks: [{ blockId: foundry.utils.randomID(), text: "New note. Click here and start writing." }],
        authorId: senderUserId,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    }, { parent: shared });
    return;
  }

  if (message.type === "saveNote") {
    const page = shared.pages.get(message.noteId);
    if (!page) return;
    await page.update({
      "system.blocks": message.blocks,
      "system.updatedAt": Date.now(),
      "system.editCount": (page.system.editCount ?? 0) + 1
    });
    return;
  }
}

/** Sends a write request to the active GM. If we are the active GM, applies it directly. */
export function requestWrite(message) {
  if (game.users.activeGM?.id === game.user.id) {
    return handleMessage(message, game.user.id);
  }
  game.socket.emit(CHANNEL, message);
}
