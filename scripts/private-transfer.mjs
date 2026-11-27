/**
 * Pure private-note transfer packing/importing.
 *
 * A transfer is always a *copy*: the sender keeps their notes. Only the selected notes, their
 * layout cards and labels attached to those notes travel. Free board labels and links whose
 * target is outside the selection are deliberately excluded. Nothing here touches Foundry
 * documents or the shared journal; `private-store.mjs` owns persistence and the socket handler
 * owns authority.
 *
 * Everything is plaintext in the private journal container (Foundry sends journal flags to every
 * connected client). This module adds no encryption and must never be used for vault content.
 */
import { CARD_STYLES } from "./styles/registry.mjs";
import { DEFAULT_CARD_PORTS, linkAnchors, validCardPorts } from "./card-ports.mjs";
import { validAnchorId } from "./anchors.mjs";
import { DEFAULT_STAMP_CORNER, STAMP_COLORS, isStampCorner, stampUrl } from "./stamps.mjs";
import {
  resolveAttachment, resolveLinkCosmetics, resolvePresentation, sanitizeCardAnchorsWithMain
} from "./presentation.mjs";
import { t } from "./i18n.mjs";

export const MAX_TRANSFER_NOTES = 50;
export const MAX_TRANSFER_TEXT = 250000;
export const MAX_TRANSFER_LABELS = 500;

const MAX_TITLE_LENGTH = 200;
const MAX_LABEL_TEXT_LENGTH = 500;
const MAX_BLOCK_TEXT_LENGTH = MAX_TRANSFER_TEXT;
const MAX_ID_LENGTH = 64;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Conservative placement sizes for cards whose stored width/height are null (auto-sized).
 *
 * Auto-sized cards are sized by CSS from their style and content, so a null card is *not* a
 * 200x90 rectangle. These values are deliberately at or above the rendered defaults: a memo is
 * 360x240, an extended document is 248 wide, a target is 252 wide, and compact paper can reach
 * 220x120. Unknown styles reserve the largest box so a placement can only err by leaving extra
 * breathing room, never by overlapping a real card.
 */
const CARD_PLACEMENT_SIZES = Object.freeze({
  sticky: Object.freeze({ width: 220, height: 120 }),
  document: Object.freeze({ width: 248, height: 240 }),
  torn: Object.freeze({ width: 225, height: 120 }),
  wanted: Object.freeze({ width: 252, height: 290 }),
  memo: Object.freeze({ width: 360, height: 240 })
});
const MAX_PLACEMENT_SIZE = Object.freeze({ width: 360, height: 290 });

/** Default size used to reason about an auto-sized card of `style` (unknown styles are largest). */
export function defaultCardSize(style) {
  const known = own(CARD_STYLES, style) ? CARD_PLACEMENT_SIZES[style] : null;
  return known ? { ...known } : { ...MAX_PLACEMENT_SIZE };
}

function randomId() {
  const foundryRandom = globalThis.foundry?.utils?.randomID;
  if (typeof foundryRandom === "function") return foundryRandom();
  const length = 16;
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(length));
  if (bytes) {
    let id = "";
    for (const byte of bytes) id += ALNUM[byte % ALNUM.length];
    return id;
  }
  let id = "";
  for (let i = 0; i < length; i++) id += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  return id;
}

function clone(value) {
  const deepClone = globalThis.foundry?.utils?.deepClone;
  if (typeof deepClone === "function") return deepClone(value);
  return structuredClone(value);
}

function own(value, key) {
  return !!value && typeof value === "object" && Object.hasOwn(value, key);
}

function freshId(taken) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = randomId();
    if (!taken.has(id) && !RESERVED_IDS.has(id)) {
      taken.add(id);
      return id;
    }
  }
  let id = `${randomId()}${randomId()}`.slice(0, MAX_ID_LENGTH);
  while (taken.has(id)) id = `${id.slice(0, MAX_ID_LENGTH - 1)}x`;
  taken.add(id);
  return id;
}

function noteTextLength(note) {
  return (Array.isArray(note?.blocks) ? note.blocks : [])
    .reduce((total, block) => total
      + (typeof block?.text === "string" ? block.text.length : 0), 0);
}

function sourceLabelEntries(labels) {
  if (Array.isArray(labels)) return labels.filter(label => label && typeof label === "object");
  if (!labels || typeof labels !== "object") return [];
  return Object.values(labels).filter(label => label && typeof label === "object");
}

function styleDefaults(style) {
  return defaultCardSize(style);
}

function cardSize(card, fallbackWidth = MAX_PLACEMENT_SIZE.width, fallbackHeight = MAX_PLACEMENT_SIZE.height) {
  return {
    width: Number.isFinite(card?.width) && card.width > 0 ? card.width : fallbackWidth,
    height: Number.isFinite(card?.height) && card.height > 0 ? card.height : fallbackHeight
  };
}

/**
 * World-space axis-aligned bounds of a card after rotation. Rotation is around the card centre,
 * matching the canvas renderer, so a 90° card swaps its visual width and height.
 */
export function rotatedCardBounds(card, fallbackWidth = MAX_PLACEMENT_SIZE.width, fallbackHeight = MAX_PLACEMENT_SIZE.height) {
  const { width, height } = cardSize(card, fallbackWidth, fallbackHeight);
  const rotation = Number.isFinite(card?.rotation) ? card.rotation : 0;
  const radians = rotation * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const rotatedWidth = width * cos + height * sin;
  const rotatedHeight = width * sin + height * cos;
  const centerX = (Number.isFinite(card?.x) ? card.x : 0) + width / 2;
  const centerY = (Number.isFinite(card?.y) ? card.y : 0) + height / 2;
  return {
    left: centerX - rotatedWidth / 2,
    top: centerY - rotatedHeight / 2,
    right: centerX + rotatedWidth / 2,
    bottom: centerY + rotatedHeight / 2
  };
}

function boundsOverlap(a, b, padding = 16) {
  return !(a.right + padding < b.left || a.left > b.right + padding
    || a.bottom + padding < b.top || a.top > b.bottom + padding);
}

/**
 * Spiral search for a free spot near `(x,y)` that does not overlap any card in `cards`.
 * Mirrors the shared/private canvas placement rule (16px breathing room, 45px steps). Both the
 * candidate and every existing card use their rotated world-space AABB, so slanted cards reserve
 * the space they actually occupy instead of their unrotated box. Auto-sized cards take their
 * conservative style default from `options.styles[id]` (or `options.notes[id].style`);
 * without metadata they reserve the largest known card box.
 */
export function findFreeSpot(cards, w, h, nearX = 0, nearY = 0, rotation = 0, options = {}) {
  const candidateFallback = defaultCardSize(options?.style);
  const width = Number.isFinite(w) && w > 0 ? w : candidateFallback.width;
  const height = Number.isFinite(h) && h > 0 ? h : candidateFallback.height;
  const originX = Number.isFinite(nearX) ? nearX : 0;
  const originY = Number.isFinite(nearY) ? nearY : 0;
  const styles = options?.styles && typeof options.styles === "object" ? options.styles : null;
  const notes = options?.notes && typeof options.notes === "object" ? options.notes : null;
  const existing = Object.entries(cards ?? {})
    .filter(([, card]) => card && Number.isFinite(card.x) && Number.isFinite(card.y))
    .map(([id, card]) => {
      const style = styles?.[id] ?? notes?.[id]?.style ?? card.style;
      const fallback = defaultCardSize(style);
      return rotatedCardBounds(card, fallback.width, fallback.height);
    });
  for (let radius = 0; radius < 40; radius++) {
    for (let step = 0; step < 8; step++) {
      const x = originX + Math.cos(step * 0.785) * radius * 45;
      const y = originY + Math.sin(step * 0.785) * radius * 45;
      const candidate = rotatedCardBounds({ x, y, width, height, rotation });
      if (!existing.some(bounds => boundsOverlap(candidate, bounds))) return { x, y };
    }
  }
  return { x: originX, y: originY };
}

/** Counts links and route waypoints that a copy of `noteIds` would have to drop. */
function countDrops(notes, selected) {
  let droppedLinks = 0;
  let droppedWaypoints = 0;
  for (const noteId of selected) {
    const note = notes[noteId];
    for (const link of Array.isArray(note?.links) ? note.links : []) {
      const targetId = typeof link?.targetId === "string" ? link.targetId : null;
      if (!targetId || !selected.has(targetId) || targetId === noteId) {
        droppedLinks += 1;
        continue;
      }
      for (const route of Array.isArray(link?.routeAnchors) ? link.routeAnchors : []) {
        if (typeof route?.noteId !== "string" || !selected.has(route.noteId)
            || !validAnchorId(route.anchorId)) {
          droppedWaypoints += 1;
        }
      }
    }
  }
  return { droppedLinks, droppedWaypoints };
}

/** Same accounting as a transfer build, exposed for the sender UI's pre-send warning. */
export function countTransferDrops(workspace, noteIds) {
  const notes = workspace?.notes && typeof workspace.notes === "object" ? workspace.notes : {};
  const selected = new Set((Array.isArray(noteIds) ? noteIds : [])
    .filter(id => typeof id === "string" && own(notes, id)));
  return countDrops(notes, selected);
}

/**
 * Packs a bounded, self-contained copy of selected private notes.
 *
 * The returned object still needs an `id` before it is stored as a pending transfer. It contains
 * `{fromUserId, toUserId, createdAt, notes:[{note,card,labels}],
 * summary:{count,titles,droppedLinks,droppedWaypoints}}`.
 */
export function buildPrivateTransfer(workspace, noteIds, { fromUserId, toUserId } = {}) {
  if (typeof fromUserId !== "string" || !fromUserId
      || typeof toUserId !== "string" || !toUserId) {
    throw new Error(t("JN.Transfer.UserMissing"));
  }
  if (fromUserId === toUserId) throw new Error(t("JN.Transfer.Self"));
  if (!Array.isArray(noteIds) || !noteIds.length) throw new Error(t("JN.Transfer.None"));
  if (noteIds.length > MAX_TRANSFER_NOTES) {
    throw new Error(t("JN.Transfer.TooMany", { max: MAX_TRANSFER_NOTES }));
  }

  const notes = workspace?.notes && typeof workspace.notes === "object" ? workspace.notes : {};
  const cards = workspace?.layout?.cards && typeof workspace.layout.cards === "object"
    ? workspace.layout.cards : {};
  const labels = workspace?.layout?.labels && typeof workspace.layout.labels === "object"
    ? workspace.layout.labels : {};
  const boardPins = workspace?.layout?.pins ?? {};
  const boardLinks = workspace?.layout?.pinLinks ?? {};

  const selected = [];
  const seen = new Set();
  let totalText = 0;
  for (const noteId of noteIds) {
    if (typeof noteId !== "string" || !noteId || seen.has(noteId) || !own(notes, noteId)) {
      throw new Error(t("JN.Transfer.Stale"));
    }
    const note = notes[noteId];
    if (!note || typeof note !== "object") throw new Error(t("JN.Transfer.Stale"));
    seen.add(noteId);
    totalText += noteTextLength(note);
    if (totalText > MAX_TRANSFER_TEXT) {
      throw new Error(t("JN.Transfer.TooLarge", { max: MAX_TRANSFER_TEXT }));
    }
    selected.push(noteId);
  }

  let labelCount = 0;
  const packed = selected.map(noteId => {
    const attached = {};
    const usedLabelIds = new Set();
    for (const [labelId, label] of Object.entries(labels)) {
      if (!label || typeof label !== "object" || label.noteId !== noteId) continue;
      labelCount += 1;
      if (labelCount > MAX_TRANSFER_LABELS) {
        throw new Error(t("JN.Transfer.TooManyLabels", { max: MAX_TRANSFER_LABELS }));
      }
      let safeLabelId = typeof labelId === "string"
        && SAFE_ID_RE.test(labelId) && !RESERVED_IDS.has(labelId) ? labelId : "";
      if (!safeLabelId || usedLabelIds.has(safeLabelId)) safeLabelId = freshId(usedLabelIds);
      else usedLabelIds.add(safeLabelId);
      attached[safeLabelId] = clone(label);
    }
    return {
      note: clone(notes[noteId]),
      card: own(cards, noteId) && cards[noteId] && typeof cards[noteId] === "object"
        ? clone(cards[noteId]) : null,
      labels: attached,
      pins: Object.fromEntries(Object.entries(boardPins)
        .filter(([, pin]) => pin?.noteId === noteId).map(([id, pin]) => [id, clone(pin)]))
    };
  });

  const refOwner = ref => {
    if (typeof ref !== "string") return "";
    if (ref.startsWith("n:")) return ref.slice(2, ref.indexOf(":", 2));
    if (ref.startsWith("p:")) return boardPins[ref.slice(2)]?.noteId ?? "";
    return "";
  };
  const packedPinLinks = Object.fromEntries(Object.entries(boardLinks)
    .filter(([, link]) => seen.has(refOwner(link?.source)) && seen.has(refOwner(link?.target)))
    .map(([id, link]) => [id, clone(link)]));

  const drops = countDrops(notes, new Set(selected));
  return {
    fromUserId,
    toUserId,
    createdAt: Date.now(),
    notes: packed,
    pinLinks: packedPinLinks,
    summary: {
      count: packed.length,
      titles: packed.map(entry => String(entry.note?.title ?? "").slice(0, MAX_TITLE_LENGTH)),
      droppedLinks: drops.droppedLinks,
      droppedWaypoints: drops.droppedWaypoints
    }
  };
}

function importBlocks(blocks) {
  const source = Array.isArray(blocks) && blocks.length ? blocks : [{ text: "" }];
  const used = new Set();
  return source.map(block => {
    // Block ids are local, but a copy gets fresh ones so repeated imports can never collide.
    const clean = {
      blockId: freshId(used),
      text: typeof block?.text === "string" ? block.text.slice(0, MAX_BLOCK_TEXT_LENGTH) : ""
    };
    if (typeof block?.authorId === "string") clean.authorId = block.authorId.slice(0, MAX_ID_LENGTH);
    return clean;
  });
}

function importLinks(links, { newId, noteIdMap, pinRefMap, recipientId, usedLinkIds }) {
  const imported = [];
  let dropped = 0;
  let droppedWaypoints = 0;
  for (const link of Array.isArray(links) ? links : []) {
    const targetId = typeof link?.targetId === "string" ? noteIdMap.get(link.targetId) : null;
    if (!targetId || targetId === newId) {
      dropped += 1;
      continue;
    }
    const routeAnchors = [];
    for (const route of Array.isArray(link?.routeAnchors) ? link.routeAnchors : []) {
      const mapped = typeof route?.noteId === "string" ? noteIdMap.get(route.noteId) : null;
      if (!mapped || !validAnchorId(route?.anchorId)) {
        droppedWaypoints += 1;
        continue;
      }
      routeAnchors.push({ noteId: mapped, anchorId: route.anchorId });
    }
    const cosmetics = resolveLinkCosmetics(link);
    imported.push({
      id: freshId(usedLinkIds),
      targetId,
      label: typeof link?.label === "string"
        ? link.label.slice(0, MAX_TITLE_LENGTH) : "",
      direction: ["none", "one", "two"].includes(link?.direction) ? link.direction : "none",
      color: typeof link?.color === "string" ? link.color : "",
      lineStyle: link?.lineStyle === "dashed" ? "dashed" : "solid",
      origin: link?.origin === "typed" ? "typed" : "drawn",
      edited: link?.edited === true,
      createdBy: recipientId,
      hint: false,
      sourceAnchorId: validAnchorId(link?.sourceAnchorId) ? link.sourceAnchorId : "",
      targetAnchorId: validAnchorId(link?.targetAnchorId) ? link.targetAnchorId : "",
      sourcePinRef: pinRefMap(link?.sourcePinRef) ?? "",
      targetPinRef: pinRefMap(link?.targetPinRef) ?? "",
      routeAnchors,
      ...cosmetics,
      ...linkAnchors(link)
    });
  }
  return { links: imported, dropped, droppedWaypoints };
}

function importLabels(labels, { oldNoteId, newNoteId, usedLabelIds }) {
  const imported = {};
  for (const label of sourceLabelEntries(labels)) {
    // Defensive: a free label or a label for another note must never ride along.
    if (label.noteId !== oldNoteId) continue;
    const stamp = typeof label.stamp === "string" && stampUrl(label.stamp) ? label.stamp : "";
    const color = Object.values(STAMP_COLORS).includes(label.color) ? label.color : "";
    const id = freshId(usedLabelIds);
    imported[id] = {
      text: typeof label.text === "string" ? label.text.slice(0, MAX_LABEL_TEXT_LENGTH) : "",
      x: Number.isFinite(label.x) ? label.x : 0,
      y: Number.isFinite(label.y) ? label.y : 0,
      size: Number.isFinite(label.size) ? label.size : 14,
      color,
      stamp,
      noteId: newNoteId,
      corner: isStampCorner(label.corner) ? label.corner : DEFAULT_STAMP_CORNER
    };
  }
  return imported;
}

function importCard(sourceCard, note, newId, recipientId, cards, notes) {
  const defaults = styleDefaults(note.style);
  const width = Number.isFinite(sourceCard?.width) && sourceCard.width > 0
    ? sourceCard.width : defaults.width;
  const height = Number.isFinite(sourceCard?.height) && sourceCard.height > 0
    ? sourceCard.height : defaults.height;
  const spot = findFreeSpot(
    cards, width, height,
    Number.isFinite(sourceCard?.x) ? sourceCard.x : 0,
    Number.isFinite(sourceCard?.y) ? sourceCard.y : 0,
    Number.isFinite(sourceCard?.rotation) ? sourceCard.rotation : 0,
    { notes }
  );
  const anchors = sanitizeCardAnchorsWithMain(
    sourceCard?.anchors, resolveAttachment(note).mainPinEnabled, recipientId
  );
  for (const [id, anchor] of Object.entries(anchors)) {
    anchors[id] = { ...anchor, createdBy: recipientId };
  }
  return {
    x: spot.x,
    y: spot.y,
    width: Number.isFinite(sourceCard?.width) && sourceCard.width > 0 ? sourceCard.width : null,
    height: Number.isFinite(sourceCard?.height) && sourceCard.height > 0 ? sourceCard.height : null,
    rotation: Number.isFinite(sourceCard?.rotation) ? sourceCard.rotation : 0,
    ports: validCardPorts(sourceCard?.ports) ? [...sourceCard.ports] : [...DEFAULT_CARD_PORTS],
    anchors
  };
}

/**
 * Deep-copies a transfer into `workspace`. Note, card, link and label ids are regenerated; links
 * and route waypoints are remapped only when their target note is part of the transfer. Cards are
 * placed near their original positions without overlapping destination cards. The recipient is
 * the new owner/author, and the input workspace/transfer are never mutated.
 *
 * Returns `{ workspace, imported, droppedLinks, droppedWaypoints }` where `imported` is the list
 * of new note ids. `droppedWaypoints` counts route anchors on otherwise-copied links whose
 * waypoint note stayed outside the selection.
 */
export function importPrivateTransfer(workspace, transfer, recipientId) {
  if (typeof recipientId !== "string" || !recipientId) {
    throw new Error(t("JN.Transfer.UserMissing"));
  }
  if (!transfer || !Array.isArray(transfer.notes) || !transfer.notes.length) {
    throw new Error(t("JN.Transfer.None"));
  }
  if (transfer.notes.length > MAX_TRANSFER_NOTES) {
    throw new Error(t("JN.Transfer.TooMany", { max: MAX_TRANSFER_NOTES }));
  }

  const result = clone(workspace && typeof workspace === "object" ? workspace : {});
  if (!result.notes || typeof result.notes !== "object") result.notes = {};
  if (!result.layout || typeof result.layout !== "object") result.layout = {};
  if (!result.layout.cards || typeof result.layout.cards !== "object") result.layout.cards = {};
  if (!result.layout.labels || typeof result.layout.labels !== "object") result.layout.labels = {};
  if (!result.layout.pins || typeof result.layout.pins !== "object") result.layout.pins = {};
  if (!result.layout.pinLinks || typeof result.layout.pinLinks !== "object") result.layout.pinLinks = {};
  if (!Array.isArray(result.trash)) result.trash = [];

  const noteIdMap = new Map();
  const usedNoteIds = new Set(Object.keys(result.notes));
  for (const entry of transfer.notes) {
    const oldId = entry?.note?.id;
    if (typeof oldId !== "string" || !oldId || noteIdMap.has(oldId)) {
      throw new Error(t("JN.Transfer.Stale"));
    }
    noteIdMap.set(oldId, freshId(usedNoteIds));
  }

  const usedPinIds = new Set(Object.keys(result.layout.pins));
  const pinIdMap = new Map();
  for (const entry of transfer.notes) {
    for (const oldId of Object.keys(entry?.pins ?? {})) {
      if (!validAnchorId(oldId) || pinIdMap.has(oldId)) continue;
      pinIdMap.set(oldId, freshId(usedPinIds));
    }
  }
  const pinRefMap = ref => {
    if (typeof ref !== "string") return null;
    if (ref.startsWith("p:")) {
      const id = pinIdMap.get(ref.slice(2));
      return id ? `p:${id}` : null;
    }
    if (ref.startsWith("n:")) {
      const split = ref.indexOf(":", 2);
      if (split < 0) return null;
      const noteId = noteIdMap.get(ref.slice(2, split));
      const anchorId = ref.slice(split + 1);
      return noteId && validAnchorId(anchorId) ? `n:${noteId}:${anchorId}` : null;
    }
    return null;
  };

  const usedLinkIds = new Set();
  for (const note of Object.values(result.notes)) {
    for (const link of Array.isArray(note?.links) ? note.links : []) {
      if (typeof link?.id === "string") usedLinkIds.add(link.id);
    }
  }
  const usedLabelIds = new Set(Object.keys(result.layout.labels));
  const imported = [];
  let droppedLinks = 0;
  let droppedWaypoints = 0;

  for (const entry of transfer.notes) {
    const sourceNote = entry.note;
    const oldId = sourceNote.id;
    const newId = noteIdMap.get(oldId);
    const title = typeof sourceNote.title === "string"
      ? sourceNote.title.slice(0, MAX_TITLE_LENGTH) : "";
    const presentation = resolvePresentation({
      name: title,
      system: {
        style: sourceNote.style,
        targetHeading: sourceNote.targetHeading,
        label: sourceNote.label,
        presentation: sourceNote.presentation
      }
    });
    const { label: _resolvedLabel, ...presentationFields } = presentation;
    const note = {
      id: newId,
      title,
      kind: sourceNote.kind === "location" ? "location" : "note",
      style: own(CARD_STYLES, sourceNote.style) ? sourceNote.style : "sticky",
      targetHeading: typeof sourceNote.targetHeading === "string"
        ? sourceNote.targetHeading.slice(0, 80) : "",
      label: typeof sourceNote.label === "string" ? sourceNote.label : "",
      schemaVersion: Number.isInteger(sourceNote.schemaVersion) && sourceNote.schemaVersion > 0
        ? sourceNote.schemaVersion : 1,
      presentation: presentationFields,
      attachment: resolveAttachment({ system: { attachment: sourceNote.attachment } }),
      image: typeof sourceNote.image === "string" ? sourceNote.image : null,
      backgroundImage: typeof sourceNote.backgroundImage === "string"
        ? sourceNote.backgroundImage : null,
      blocks: importBlocks(sourceNote.blocks),
      links: [],
      createdAt: Number.isFinite(sourceNote.createdAt) ? sourceNote.createdAt : Date.now(),
      updatedAt: Date.now()
    };

    const linkResult = importLinks(sourceNote.links, {
      newId, noteIdMap, pinRefMap, recipientId, usedLinkIds
    });
    note.links = linkResult.links;
    droppedLinks += linkResult.dropped;
    droppedWaypoints += linkResult.droppedWaypoints;

    const card = importCard(entry.card, note, newId, recipientId, result.layout.cards, result.notes);
    result.notes[newId] = note;
    result.layout.cards[newId] = card;
    for (const [oldPinId, pin] of Object.entries(entry.pins ?? {})) {
      const newPinId = pinIdMap.get(oldPinId);
      if (!newPinId || !Number.isFinite(pin?.x) || !Number.isFinite(pin?.y)
          || pin.x < 0 || pin.x > 1 || pin.y < 0 || pin.y > 1) continue;
      result.layout.pins[newPinId] = { noteId: newId, x: pin.x, y: pin.y,
        isDefault: false };
    }
    Object.assign(result.layout.labels, importLabels(entry.labels, {
      oldNoteId: oldId, newNoteId: newId, usedLabelIds
    }));
    imported.push(newId);
  }

  const usedPinLinkIds = new Set(Object.keys(result.layout.pinLinks));
  for (const link of Object.values(transfer.pinLinks ?? {})) {
    const source = pinRefMap(link?.source), target = pinRefMap(link?.target);
    if (!source || !target || source === target) continue;
    result.layout.pinLinks[freshId(usedPinLinkIds)] = { ...link, source, target };
  }

  return { workspace: result, imported, droppedLinks, droppedWaypoints };
}
