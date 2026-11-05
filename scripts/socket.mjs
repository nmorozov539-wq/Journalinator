import { getContainerIds } from "./store/containers.mjs";
import { CARD_STYLES, seedTilt } from "./styles/registry.mjs";
import { reconcileTypedLinks } from "./wikilinks.mjs";
import { maybeSnapshot } from "./snapshots.mjs";
import { recordActivity, addSessionMarker } from "./stats.mjs";
import {
  authoritativeRequestLock, authoritativeReleaseLock, authoritativeHeartbeat,
  authoritativeHolds, authoritativeSnapshot, receiveLockBroadcast
} from "./locks.mjs";

const MODULE_ID = "fvtt-journalinator";
const CHANNEL = `module.${MODULE_ID}`;
const CONTRIBUTION_CAP = 2000;
const MAX_TITLE_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;
const MAX_LABEL_TEXT_LENGTH = 500;
const MAX_BLOCK_LENGTH = 200000;
const MAX_COORDINATE = 1000000;
const MIN_LABEL_SIZE = 8;
const MAX_LABEL_SIZE = 96;
const LINK_DIRECTIONS = new Set(["none", "one", "two"]);
const LINK_LINE_STYLES = new Set(["solid", "dashed"]);
const LINK_COLORS = new Set(["", "#a393f2", "#d6a45c", "#d77b91"]);

/**
 * All GM-side write handling is serialized through this promise chain. Socket handlers are
 * async, so without it two messages can both read `page.system.blocks`/`links` before either
 * update lands, and the second whole-array write clobbers the first player's change. This is
 * what makes the spec's "the GM serializes writes" assumption true.
 */
let writeQueue = Promise.resolve();

function enqueueWrite(message, senderUserId) {
  writeQueue = writeQueue
    .then(() => {
      // A job can outlive the sender's active-GM status during a failover. Dropping it is
      // safer than letting a former GM apply world writes after the new GM takes over.
      if (game.users.activeGM?.id !== game.user.id) return;
      return handleMessage(message, senderUserId);
    })
    .catch(err => console.error("Journalinator: write failed", err));
  return writeQueue;
}

/** Case-insensitive lookup among live (non-deleted) notes. */
function findNoteByTitle(shared, title, excludeId = null) {
  const normalized = (title ?? "").trim().toLowerCase();
  if (!normalized) return null;
  return shared.pages.find(p =>
    p.type === `${MODULE_ID}.note` &&
    p.id !== excludeId &&
    !p.system.deleted &&
    (p.name ?? "").trim().toLowerCase() === normalized
  ) ?? null;
}

/** `Untitled`, then `Untitled 2`, `Untitled 3`, ... — used when the title is generated, not typed. */
function uniqueTitle(shared, base) {
  const stem = (base ?? "").trim() || "Untitled";
  if (!findNoteByTitle(shared, stem)) return stem;
  let suffix = 2;
  while (findNoteByTitle(shared, `${stem} ${suffix}`)) suffix++;
  return `${stem} ${suffix}`;
}

/** Shows a rejection to the requesting user. Socket broadcasts don't echo to the sender. */
function notifyUser(userId, reason) {
  if (!userId) return;
  const text = reason.startsWith("Journalinator:") ? reason : `Journalinator: ${reason}`;
  if (userId === game.user.id) {
    ui.notifications?.warn(text);
    return;
  }
  game.socket.emit(CHANNEL, { type: "writeRejected", forUserId: userId, reason: text });
}

/** Keeps only the fields a link toolbar is allowed to change, with validated values. */
function sanitizeLinkFields(fields) {
  if (!fields || typeof fields !== "object") return null;
  const clean = {};
  if (typeof fields.label === "string") clean.label = fields.label.slice(0, MAX_LABEL_LENGTH);
  if (LINK_DIRECTIONS.has(fields.direction)) clean.direction = fields.direction;
  if (typeof fields.color === "string") {
    const color = fields.color.toLowerCase();
    if (LINK_COLORS.has(color)) clean.color = color;
  }
  if (LINK_LINE_STYLES.has(fields.lineStyle)) clean.lineStyle = fields.lineStyle;
  return Object.keys(clean).length ? clean : null;
}

/** Accepts empty, a hex color, or a simple CSS color name; rejects anything else. */
function sanitizeLabelColor(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(color) ||
      /^[a-z]{3,20}$/.test(color)) return color;
  return null;
}

function clampCoordinate(value) {
  return Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, value));
}

function clampLabelSize(value) {
  return Math.max(MIN_LABEL_SIZE, Math.min(MAX_LABEL_SIZE, value));
}

/**
 * The server appends the sender's verified user id as the socket relay's own trailing argument
 * (see dist/server/sockets.mjs handleCustomSocket), so `senderUserId` below is never something
 * a client could spoof — this is what makes lock/write arbitration (spec §6.6) trustworthy.
 *
 * Lock broadcasts (`lockUpdate`/`lockState`) are applied by *every* client, GM or not — they're
 * just informational mirrors of the GM's ephemeral lock state (spec §6.6). Everything else is
 * a write request only the active GM's client acts on.
 *
 * Card drags/resizes are NOT streamed (spec §8.1) — the client only calls requestWrite once,
 * on drop/release, with the final position. There's also no "held by" pick-up marker on cards
 * (unlike blocks, which do have one now) — two people dragging the same card at once can still
 * race; acceptable for now.
 */
export function registerSocket() {
  game.socket.on(CHANNEL, (message, senderUserId) => {
    if (message.type === "lockUpdate" || message.type === "lockState") {
      // Only the current active GM owns lock truth. This also rejects a late broadcast from a
      // former GM arriving just after a failover, which would otherwise resurrect stale locks.
      if (senderUserId !== game.users.activeGM?.id) return;
      receiveLockBroadcast(message);
      return;
    }
    if (message.type === "writeRejected") {
      if (senderUserId !== game.users.activeGM?.id) return;
      if (message.forUserId === game.user.id) ui.notifications?.warn(message.reason);
      return;
    }
    if (!game.user.isGM) return;
    if (game.users.activeGM?.id !== game.user.id) return;
    enqueueWrite(message, senderUserId);
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
        return !(x + w + 16 < c.x || x > c.x + cw + 16 || y + h + 16 < c.y || y > c.y + ch + 16);
      });
      if (!overlaps) return { x, y };
    }
  }
  return { x: nearX, y: nearY };
}

async function createNotePage(shared, { title, style, x, y, authorId, autoTitle = false }) {
  style = typeof style === "string" && Object.hasOwn(CARD_STYLES, style) ? style : "sticky";
  const requestedTitle = (title ?? "").trim() || "Untitled";
  const finalTitle = autoTitle ? uniqueTitle(shared, requestedTitle) : requestedTitle;

  if (finalTitle.length > MAX_TITLE_LENGTH) {
    notifyUser(authorId, `Titles must be ${MAX_TITLE_LENGTH} characters or fewer.`);
    return null;
  }
  if (!autoTitle && findNoteByTitle(shared, finalTitle)) {
    notifyUser(authorId, `A note titled "${finalTitle}" already exists.`);
    return null;
  }

  const layout = layoutPage(shared);
  const existingCards = layout?.system.cards ?? {};
  const cardWidth = CARD_STYLES[style]?.defaultWidth ?? 190;
  const nearX = Number.isFinite(x) ? x : 0;
  const nearY = Number.isFinite(y) ? y : 0;
  const spot = findFreeSpot(existingCards, cardWidth, 90, nearX, nearY);

  const page = await JournalEntryPage.create({
    name: finalTitle,
    type: `${MODULE_ID}.note`,
    system: {
      style,
      blocks: [{ blockId: foundry.utils.randomID(), text: "New note. Click here and start writing.", authorId }],
      authorId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }, { parent: shared });

  if (layout) {
    await layout.update({
      [`system.cards.${page.id}`]: { x: spot.x, y: spot.y, rotation: seedTilt(style) }
    });
  }
  await recordActivity(authorId, { notes: 1 });
  return page;
}

/** Re-runs typed-wikilink resolution against `blocks` and saves both blocks and links together. */
async function reconcileAndSave(shared, page, blocks, senderUserId, extraSystemUpdates = {}) {
  const layout = layoutPage(shared);
  const sourceCard = layout?.system.cards[page.id] ?? { x: 0, y: 0 };
  const links = await reconcileTypedLinks(page, blocks, {
    senderUserId,
    findNoteByTitle: {
      byId: id => shared.pages.get(id),
      byTitle: title => findNoteByTitle(shared, title)
    },
    createNoteNear: async title => {
      const existing = findNoteByTitle(shared, title);
      if (existing) return existing;
      const page = await createNotePage(shared, {
        title, style: "sticky", x: sourceCard.x + 220, y: sourceCard.y, authorId: senderUserId
      });
      const fallback = page ?? findNoteByTitle(shared, title);
      if (!fallback) throw new Error(`Journalinator: could not create or resolve "${title}"`);
      return fallback;
    }
  });

  await page.update({
    "system.blocks": blocks,
    "system.links": links,
    "system.updatedAt": Date.now(),
    ...extraSystemUpdates
  });
  await maybeSnapshot(page);
}

/** Credits added characters (capped per save, spec §12) to whoever just saved. */
function creditContribution(page, senderUserId, oldText, newText) {
  const added = Math.max(0, newText.length - oldText.length);
  const credited = Math.min(CONTRIBUTION_CAP, added);
  const contributions = { ...(page.system.contributions ?? {}) };
  contributions[senderUserId] = (contributions[senderUserId] ?? 0) + credited;
  return { contributions, credited };
}

async function handleMessage(message, senderUserId) {
  const ids = getContainerIds();
  if (!ids) return;
  const shared = game.journal.get(ids.shared);
  if (!shared) return;

  switch (message.type) {
    case "createNote": {
      await createNotePage(shared, {
        title: message.title, style: message.style, x: message.x, y: message.y,
        authorId: senderUserId, autoTitle: message.autoTitle === true
      });
      return;
    }

    case "renameNote": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      const title = (message.title ?? "").trim();
      if (!title) {
        notifyUser(senderUserId, "A note title cannot be empty.");
        return;
      }
      if (title.length > MAX_TITLE_LENGTH) {
        notifyUser(senderUserId, `Titles must be ${MAX_TITLE_LENGTH} characters or fewer.`);
        return;
      }
      if (findNoteByTitle(shared, title, page.id)) {
        notifyUser(senderUserId, `A note titled "${title}" already exists.`);
        return;
      }

      const oldTitle = (page.name ?? "").trim();
      const formerNames = [...(page.system.formerNames ?? [])];
      if (oldTitle && !formerNames.some(name => name.trim().toLowerCase() === oldTitle.toLowerCase())) {
        formerNames.push(oldTitle);
      }
      // Keep former names bounded and never list the current title twice.
      const nextFormerNames = formerNames
        .filter(name => name.trim().toLowerCase() !== title.toLowerCase())
        .slice(-20);
      await page.update({ name: title, "system.formerNames": nextFormerNames, "system.updatedAt": Date.now() });
      return;
    }

    case "saveBlock": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (typeof message.text !== "string" || message.text.length > MAX_BLOCK_LENGTH) return;
      if (!authoritativeHolds(message.noteId, message.blockId, senderUserId)) return; // doesn't hold the lock — ignore
      const blocks = page.system.blocks ?? [];
      const index = blocks.findIndex(b => b.blockId === message.blockId);
      if (index === -1) return;

      const oldText = blocks[index].text;
      const nextBlocks = blocks.map((b, i) => i === index ? { ...b, text: message.text, authorId: senderUserId } : b);
      const { contributions, credited } = creditContribution(page, senderUserId, oldText, message.text);

      await reconcileAndSave(shared, page, nextBlocks, senderUserId, {
        "system.contributions": contributions,
        "system.editCount": (page.system.editCount ?? 0) + 1
      });
      await recordActivity(senderUserId, { chars: credited });
      return;
    }

    case "splitBlock": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (typeof message.beforeText !== "string" || typeof message.afterText !== "string") return;
      if (message.beforeText.length + message.afterText.length > MAX_BLOCK_LENGTH) return;
      if (!authoritativeHolds(message.noteId, message.blockId, senderUserId)) return;
      const blocks = page.system.blocks ?? [];
      const index = blocks.findIndex(b => b.blockId === message.blockId);
      if (index === -1) return;

      const nextBlocks = [...blocks];
      nextBlocks.splice(index, 1,
        { ...blocks[index], text: message.beforeText, authorId: senderUserId },
        { blockId: foundry.utils.randomID(), text: message.afterText, authorId: senderUserId }
      );
      await reconcileAndSave(shared, page, nextBlocks, senderUserId, {
        "system.editCount": (page.system.editCount ?? 0) + 1
      });
      return;
    }

    case "mergeBlockUp": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      const blocks = page.system.blocks ?? [];
      const index = blocks.findIndex(b => b.blockId === message.blockId);
      if (index <= 0) return; // no previous block to merge into
      const prevBlock = blocks[index - 1];
      if (!authoritativeHolds(message.noteId, message.blockId, senderUserId)) return;
      if (!authoritativeHolds(message.noteId, prevBlock.blockId, senderUserId)) return; // needs both locks (spec §6.4)

      const nextBlocks = blocks.filter((_, i) => i !== index);
      nextBlocks[index - 1] = { ...prevBlock, text: prevBlock.text + blocks[index].text, authorId: senderUserId };
      await reconcileAndSave(shared, page, nextBlocks, senderUserId, {
        "system.editCount": (page.system.editCount ?? 0) + 1
      });
      return;
    }

    case "requestLock": authoritativeRequestLock(message.noteId, message.blockId, senderUserId); return;
    case "releaseLock": authoritativeReleaseLock(message.noteId, message.blockId, senderUserId); return;
    case "heartbeat": authoritativeHeartbeat(message.noteId, message.blockId, senderUserId); return;
    case "requestLockState": {
      const snapshot = authoritativeSnapshot();
      game.socket.emit(CHANNEL, { type: "lockState", locks: snapshot });
      return;
    }

    case "setNoteStyle": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (typeof message.style !== "string" || !Object.hasOwn(CARD_STYLES, message.style)) return;
      await page.update({ "system.style": message.style });
      return;
    }

    case "setNoteImage": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (message.image !== null && typeof message.image !== "string") return;
      const image = typeof message.image === "string" ? message.image.trim() : null;
      if (image && image.length > 1000) return;
      await page.update({ "system.image": image || null });
      return;
    }

    case "moveCard": {
      const note = shared.pages.get(message.noteId);
      if (!note || note.type !== `${MODULE_ID}.note` || note.system.deleted) return;
      if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) return;
      const layout = layoutPage(shared);
      if (!layout) return;
      await layout.update({
        [`system.cards.${message.noteId}.x`]: message.x,
        [`system.cards.${message.noteId}.y`]: message.y
      });
      return;
    }

    case "resizeCard": {
      const note = shared.pages.get(message.noteId);
      if (!note || note.type !== `${MODULE_ID}.note` || note.system.deleted) return;
      const validSize = value => value === null || (Number.isFinite(value) && value > 0);
      if (!validSize(message.width) || !validSize(message.height)) return;
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
      if (message.text !== undefined && typeof message.text !== "string") return;
      const text = (message.text ?? "Label").slice(0, MAX_LABEL_TEXT_LENGTH);
      const x = message.x === undefined ? 0 : message.x;
      const y = message.y === undefined ? 0 : message.y;
      const size = message.size === undefined ? 14 : message.size;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(size)) return;
      const color = sanitizeLabelColor(message.color);
      if (color === null) return;
      const labelId = foundry.utils.randomID();
      await layout.update({
        [`system.labels.${labelId}`]: {
          text,
          x: clampCoordinate(x),
          y: clampCoordinate(y),
          size: clampLabelSize(size),
          color
        }
      });
      return;
    }

    case "updateLabel": {
      const layout = layoutPage(shared);
      if (!layout) return;
      if (typeof message.labelId !== "string" || !layout.system.labels?.[message.labelId]) return;
      const updates = {};
      let changed = false;

      if ("text" in message) {
        if (typeof message.text !== "string") return;
        updates[`system.labels.${message.labelId}.text`] = message.text.slice(0, MAX_LABEL_TEXT_LENGTH);
        changed = true;
      }
      for (const field of ["x", "y"]) {
        if (!(field in message)) continue;
        if (!Number.isFinite(message[field])) return;
        updates[`system.labels.${message.labelId}.${field}`] = clampCoordinate(message[field]);
        changed = true;
      }
      if ("size" in message) {
        if (!Number.isFinite(message.size)) return;
        updates[`system.labels.${message.labelId}.size`] = clampLabelSize(message.size);
        changed = true;
      }
      if ("color" in message) {
        const color = sanitizeLabelColor(message.color);
        if (color === null) return;
        updates[`system.labels.${message.labelId}.color`] = color;
        changed = true;
      }
      if (!changed) return;
      await layout.update(updates);
      return;
    }

    case "removeLabel": {
      const layout = layoutPage(shared);
      if (!layout) return;
      if (typeof message.labelId !== "string" || !layout.system.labels?.[message.labelId]) return;
      await layout.update({ [`system.labels.-=${message.labelId}`]: null });
      return;
    }

    case "createLink": {
      const page = shared.pages.get(message.sourceId);
      const target = shared.pages.get(message.targetId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (!target || target.type !== `${MODULE_ID}.note` || target.system.deleted) return;
      if (message.sourceId === message.targetId) return;
      const links = [...(page.system.links ?? [])];
      if (links.some(link => link.targetId === message.targetId)) return;
      links.push({
        id: foundry.utils.randomID(),
        targetId: message.targetId,
        label: "",
        direction: "one",
        color: "",
        lineStyle: "solid",
        origin: "drawn",
        edited: false,
        createdBy: senderUserId
      });
      await page.update({ "system.links": links });
      await recordActivity(senderUserId, { links: 1 });
      return;
    }

    case "updateLink": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      const links = page.system.links ?? [];
      if (!links.some(link => link.id === message.linkId)) return;
      const fields = sanitizeLinkFields(message.fields);
      if (!fields) return;
      const nextLinks = links.map(link =>
        link.id === message.linkId ? { ...link, ...fields, edited: true } : link
      );
      await page.update({ "system.links": nextLinks });
      return;
    }

    case "deleteLink": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      const links = (page.system.links ?? []).filter(link => link.id !== message.linkId);
      await page.update({ "system.links": links });
      return;
    }

    case "newLinkedNote": {
      const sourcePage = shared.pages.get(message.sourceId);
      if (!sourcePage || sourcePage.type !== `${MODULE_ID}.note` || sourcePage.system.deleted) return;
      const layout = layoutPage(shared);
      const sourceCard = layout?.system.cards[message.sourceId] ?? { x: 0, y: 0 };
      const newPage = await createNotePage(shared, {
        title: message.title ?? "Untitled", style: "sticky",
        x: sourceCard.x + 220, y: sourceCard.y, authorId: senderUserId
      });
      if (!newPage) return;
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
      await recordActivity(senderUserId, { links: 1 });
      return;
    }

    case "deleteNote": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      const layout = layoutPage(shared);
      const lastCard = layout?.system.cards[message.noteId] ?? null;
      await page.update({ "system.deleted": { at: Date.now(), by: senderUserId, lastCard } });
      if (layout) await layout.update({ [`system.cards.-=${message.noteId}`]: null });
      return;
    }

    case "restoreNote": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || !page.system.deleted) return;
      const layout = layoutPage(shared);
      const lastCard = page.system.deleted.lastCard;
      let spot;
      if (layout && lastCard) {
        const cards = layout.system.cards ?? {};
        const w = lastCard.width ?? 190, h = lastCard.height ?? 90;
        const occupied = Object.values(cards).some(c => {
          const cw = c.width ?? 200, ch = c.height ?? 90;
          return !(lastCard.x + w + 16 < c.x || lastCard.x > c.x + cw + 16 || lastCard.y + h + 16 < c.y || lastCard.y > c.y + ch + 16);
        });
        spot = occupied ? findFreeSpot(cards, w, h, lastCard.x, lastCard.y) : { x: lastCard.x, y: lastCard.y };
      } else {
        spot = findFreeSpot(layout?.system.cards ?? {}, 190, 90, 0, 0);
      }

      const oldTitle = (page.name ?? "").trim();
      const restoredTitle = findNoteByTitle(shared, oldTitle, page.id)
        ? uniqueTitle(shared, oldTitle)
        : page.name;
      const restoreUpdate = { "system.deleted": null };
      if (restoredTitle !== page.name) restoreUpdate.name = restoredTitle;
      await page.update(restoreUpdate);
      if (restoredTitle !== page.name) {
        notifyUser(senderUserId, `Restored as "${restoredTitle}" because another note already uses "${oldTitle}".`);
      }
      if (layout) {
        await layout.update({
          [`system.cards.${message.noteId}`]: { x: spot.x, y: spot.y, width: lastCard?.width ?? null, height: lastCard?.height ?? null, rotation: lastCard?.rotation ?? 0 }
        });
      }
      return;
    }

    case "emptyTrash": {
      if (!game.users.get(senderUserId)?.isGM) return; // only the GM may permanently empty the trash (spec §10/§11)
      const trashed = shared.pages.filter(p => p.type === `${MODULE_ID}.note` && p.system.deleted);
      await JournalEntryPage.deleteDocuments(trashed.map(p => p.id), { parent: shared });
      const ids2 = getContainerIds();
      const historyPage = ids2?.historyPage ? game.journal.get(ids2.history)?.pages.get(ids2.historyPage) : null;
      if (historyPage) {
        const updates = {};
        for (const p of trashed) updates[`system.snapshots.-=${p.id}`] = null;
        if (Object.keys(updates).length) await historyPage.update(updates);
      }
      return;
    }

    case "addSessionMarker": {
      if (!game.users.get(senderUserId)?.isGM) return; // only the GM adds session markers (spec §10)
      await addSessionMarker(message.label);
      return;
    }
  }
}

/** Sends a write request to the active GM. If we are the active GM, applies it directly. */
export function requestWrite(message) {
  if (game.users.activeGM?.id === game.user.id) {
    return enqueueWrite(message, game.user.id);
  }
  game.socket.emit(CHANNEL, message);
}
