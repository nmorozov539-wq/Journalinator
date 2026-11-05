import { getContainerIds } from "./store/containers.mjs";
import { CARD_STYLES, seedTilt } from "./styles/registry.mjs";
import { reconcileTypedLinks } from "./wikilinks.mjs";

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

/** Spiral search for a free spot near `(x,y)` that doesn't overlap any existing card (prototype's `free()`). */
function findFreeSpot(cards, w, h, nearX, nearY) {
  for (let r = 0; r < 40; r++) {
    for (let k = 0; k < 8; k++) {
      const x = nearX + Math.cos(k * 0.785) * r * 45;
      const y = nearY + Math.sin(k * 0.785) * r * 45;
      const overlaps = Object.values(cards).some(c => {
        const cw = c.width ?? 200, ch = c.height ?? 90;
        return x + w + 16 < c.x || x > c.x + cw + 16 || y + h + 16 < c.y || y > c.y + ch + 16;
      });
      if (!overlaps) return { x, y };
    }
  }
  return { x: nearX, y: nearY };
}

async function createNotePage(shared, { title, style, x, y, authorId }) {
  style = CARD_STYLES[style] ? style : "sticky";
  const page = await JournalEntryPage.create({
    name: title,
    type: `${MODULE_ID}.note`,
    system: {
      style,
      blocks: [{ blockId: foundry.utils.randomID(), text: "New note. Click here and start writing." }],
      authorId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }, { parent: shared });

  const layout = layoutPage(shared);
  if (layout) {
    await layout.update({
      [`system.cards.${page.id}`]: { x: x ?? 0, y: y ?? 0, rotation: seedTilt(style) }
    });
  }
  return page;
}

async function handleMessage(message, senderUserId) {
  const ids = getContainerIds();
  if (!ids) return;
  const shared = game.journal.get(ids.shared);
  if (!shared) return;

  switch (message.type) {
    case "createNote": {
      await createNotePage(shared, { title: message.title, style: message.style, x: message.x, y: message.y, authorId: senderUserId });
      return;
    }

    case "saveNote": {
      const page = shared.pages.get(message.noteId);
      if (!page) return;

      const layout = layoutPage(shared);
      const sourceCard = layout?.system.cards[message.noteId] ?? { x: 0, y: 0 };
      const links = await reconcileTypedLinks(page, message.blocks, {
        senderUserId,
        findNoteByTitle: {
          byId: id => shared.pages.get(id),
          byTitle: title => shared.pages.find(p => p.type === `${MODULE_ID}.note` && p.name.toLowerCase() === title.toLowerCase())
        },
        createNoteNear: async title => {
          const existingCards = layout?.system.cards ?? {};
          const { x, y } = findFreeSpot(existingCards, 190, 90, sourceCard.x + 220, sourceCard.y);
          return createNotePage(shared, { title, style: "sticky", x, y, authorId: senderUserId });
        }
      });

      await page.update({
        "system.blocks": message.blocks,
        "system.links": links,
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

    case "createLink": {
      const page = shared.pages.get(message.sourceId);
      if (!page) return;
      const links = [...(page.system.links ?? []), {
        id: foundry.utils.randomID(),
        targetId: message.targetId,
        label: "",
        direction: "one",
        color: "",
        lineStyle: "solid",
        origin: "drawn",
        edited: false,
        createdBy: senderUserId
      }];
      await page.update({ "system.links": links });
      return;
    }

    case "updateLink": {
      const page = shared.pages.get(message.noteId);
      if (!page) return;
      const links = (page.system.links ?? []).map(link =>
        link.id === message.linkId ? { ...link, ...message.fields, edited: true } : link
      );
      await page.update({ "system.links": links });
      return;
    }

    case "deleteLink": {
      const page = shared.pages.get(message.noteId);
      if (!page) return;
      const links = (page.system.links ?? []).filter(link => link.id !== message.linkId);
      await page.update({ "system.links": links });
      return;
    }

    case "newLinkedNote": {
      const sourcePage = shared.pages.get(message.sourceId);
      if (!sourcePage) return;
      const layout = layoutPage(shared);
      const sourceCard = layout?.system.cards[message.sourceId] ?? { x: 0, y: 0 };
      const existingCards = layout?.system.cards ?? {};
      const { x, y } = findFreeSpot(existingCards, 190, 90, sourceCard.x + 220, sourceCard.y);
      const newPage = await createNotePage(shared, { title: message.title ?? "Untitled", style: "sticky", x, y, authorId: senderUserId });
      const links = [...(sourcePage.system.links ?? []), {
        id: foundry.utils.randomID(),
        targetId: newPage.id,
        label: "",
        direction: "one",
        color: "",
        lineStyle: "solid",
        origin: "drawn",
        edited: false,
        createdBy: senderUserId
      }];
      await sourcePage.update({ "system.links": links });
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
