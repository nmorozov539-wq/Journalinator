/**
 * Pure private-note transfer packing/importing for schema v2 notes.
 *
 * A transfer is always a *copy*: the sender keeps their notes. Only the selected notes, their
 * layout cards, attached labels and pins referenced by a packed pin link travel. Free board
 * labels and links whose target is outside the selection are deliberately excluded. Nothing here
 * touches Foundry documents or the shared journal; `private-store.mjs` owns persistence and the
 * socket handler owns authority.
 *
 * The payload is plaintext in the private journal container (Foundry sends journal flags to every
 * connected client). This module is UI-private copy plumbing, not an encryption boundary.
 *
 * Payload contract (there is no migration or compatibility adapter):
 *   transferVersion: 2
 *   note: { schemaVersion: 2, id, body, revision: 0, layout, skin, attachment, links,
 *           authorId, createdAt, updatedAt }
 *   card: { x, y, sizing: { mode, width, minHeight }, autoSizeOrigin, rotation, ports, anchors }
 *
 * Legacy title/kind/style/presentation/blocks/image/hint/hidden payloads are rejected.
 */
import { DEFAULT_CARD_PORTS, linkAnchors, validCardPorts } from "./card-ports.mjs";
import { validAnchorId } from "./anchors.mjs";
import { normalizePinLink, validPinPosition } from "./board-pins.mjs";
import { DEFAULT_STAMP_CORNER, STAMP_COLORS, isStampCorner, stampUrl } from "./stamps.mjs";
import {
  resolveAttachment, resolveLinkCosmetics, sanitizeCardAnchorsWithMain
} from "./presentation.mjs";
import { parseDocument, deriveTitle } from "./document/index.mjs";
import { getLayout, isLayout } from "./layouts/registry.mjs";
import { resolveSkin } from "./skins/registry.mjs";
import { t } from "./i18n.mjs";

export const TRANSFER_VERSION = 2;
export const NOTE_SCHEMA_VERSION = 2;
export const MAX_TRANSFER_NOTES = 50;
export const MAX_TRANSFER_TEXT = 250000;
export const MAX_TRANSFER_BODY = 200000;
export const MAX_TRANSFER_LABELS = 500;

const MAX_TITLE_LENGTH = 200;
const MAX_LABEL_TEXT_LENGTH = 500;
const MAX_ID_LENGTH = 64;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);
const NOTE_TYPE = "fvtt-journalinator.note";

const SIZING_WIDTH_MIN = 160;
const SIZING_WIDTH_MAX = 800;
const SIZING_MIN_HEIGHT_MIN = 80;
const SIZING_MIN_HEIGHT_MAX = 1600;
const CARD_PADDING = 16;
const PLACEMENT_STEP = 45;

const UNSUPPORTED_TRANSFER =
  "Unsupported transfer format. This build accepts v2 note transfers only.";
const UNSUPPORTED_NOTE =
  "Unsupported note format. This build accepts schema v2 notes only.";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Typed non-migrating rejection shared with private-store's incompatibility guard. */
function incompatibleError(message) {
  const error = new Error(message);
  error.name = "JN.Private.IncompatibleFormat";
  error.code = "unsupported-transfer";
  return error;
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

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  return Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0 ? value : null;
}

function clamp(value, min, max, fallback) {
  return finite(value) ? Math.min(max, Math.max(min, value)) : fallback;
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

/** Rendered-size estimate for a v2 card; manual sizing wins, auto uses the widest layout step. */
export function cardPlacementSize(card, note) {
  const sizing = card?.sizing;
  if (sizing?.mode === "manual") {
    const width = positive(sizing.width);
    const height = positive(sizing.minHeight);
    if (width !== null && height !== null) return { width, height };
  }
  const layout = getLayout(note?.layout ?? "plain");
  return {
    width: layout.widths[layout.widths.length - 1],
    height: layout.minHeight
  };
}

/**
 * World-space axis-aligned bounds of a card after rotation. Rotation is around the card centre,
 * matching the canvas renderer, so a 90° card swaps its visual width and height.
 */
export function rotatedCardBounds(card, note = null) {
  const { width, height } = cardPlacementSize(card, note);
  const rotation = finite(card?.rotation) ? card.rotation : 0;
  const radians = rotation * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const rotatedWidth = width * cos + height * sin;
  const rotatedHeight = width * sin + height * cos;
  const centerX = (finite(card?.x) ? card.x : 0) + width / 2;
  const centerY = (finite(card?.y) ? card.y : 0) + height / 2;
  return {
    left: centerX - rotatedWidth / 2,
    top: centerY - rotatedHeight / 2,
    right: centerX + rotatedWidth / 2,
    bottom: centerY + rotatedHeight / 2
  };
}

export function boundsOverlap(a, b, padding = CARD_PADDING) {
  return !(a.right + padding < b.left || a.left > b.right + padding
    || a.bottom + padding < b.top || a.top > b.bottom + padding);
}

/**
 * Spiral search for a free spot near `(x,y)` that does not overlap any card in `cards`.
 * Mirrors the shared/private canvas placement rule (16px breathing room, 45px steps). Both the
 * candidate and every existing card use their rotated world-space AABB. Existing v2 cards are
 * measured from `card.sizing`; automatic cards reserve their layout's widest step, so a
 * placement can only err by leaving extra breathing room.
 */
export function findFreeSpot(cards, w, h, nearX = 0, nearY = 0, rotation = 0, options = {}) {
  const fallback = getLayout("plain");
  const width = positive(w) ?? fallback.widths[0];
  const height = positive(h) ?? fallback.minHeight;
  const originX = finite(nearX) ? nearX : 0;
  const originY = finite(nearY) ? nearY : 0;
  const notes = options?.notes && typeof options.notes === "object" ? options.notes : null;
  const existing = Object.entries(cards ?? {})
    .filter(([, card]) => card && finite(card.x) && finite(card.y))
    .map(([id, card]) => rotatedCardBounds(card, notes?.[id]));
  for (let radius = 0; radius < 40; radius++) {
    for (let step = 0; step < 8; step++) {
      const x = originX + Math.cos(step * 0.785) * radius * PLACEMENT_STEP;
      const y = originY + Math.sin(step * 0.785) * radius * PLACEMENT_STEP;
      const candidate = rotatedCardBounds({
        x,
        y,
        sizing: { mode: "manual", width, minHeight: height },
        rotation
      });
      if (!existing.some(bounds => boundsOverlap(candidate, bounds))) return { x, y };
    }
  }
  return { x: originX, y: originY };
}

function normalizeSizing(sizing) {
  if (sizing?.mode === "manual") {
    const width = finite(sizing.width)
      ? clamp(sizing.width, SIZING_WIDTH_MIN, SIZING_WIDTH_MAX, null) : null;
    const minHeight = finite(sizing.minHeight)
      ? clamp(sizing.minHeight, SIZING_MIN_HEIGHT_MIN, SIZING_MIN_HEIGHT_MAX, null) : null;
    if (width !== null && minHeight !== null) {
      return { mode: "manual", width, minHeight };
    }
  }
  return { mode: "auto", width: null, minHeight: null };
}

function deriveNoteTitle(note) {
  let parsed = null;
  try {
    parsed = parseDocument(note?.body ?? "", { selectedLayout: note?.layout });
  } catch {
    parsed = null;
  }
  return deriveTitle(parsed, {
    emptyLabel: t("JN.Search.EmptyNote"),
    imageLabel: t("JN.Search.ImageNote")
  }).slice(0, MAX_TITLE_LENGTH);
}

function noteBody(note) {
  return typeof note?.body === "string" ? note.body : "";
}

function assertV2Note(note) {
  if (!isObject(note) || note.schemaVersion !== NOTE_SCHEMA_VERSION) {
    throw incompatibleError(UNSUPPORTED_NOTE);
  }
  if (typeof note.body !== "string") throw incompatibleError(UNSUPPORTED_NOTE);
  if (!isLayout(note.layout)) throw incompatibleError(UNSUPPORTED_NOTE);
  if (note.body.length > MAX_TRANSFER_BODY) {
    throw new Error(t("JN.Transfer.TooLarge", { max: MAX_TRANSFER_BODY }));
  }
}

function cleanRouteAnchors(list) {
  const anchors = [];
  for (const route of Array.isArray(list) ? list : []) {
    if (typeof route?.noteId !== "string" || !route.noteId) continue;
    if (!validAnchorId(route.anchorId)) continue;
    anchors.push({ noteId: route.noteId, anchorId: route.anchorId });
  }
  return anchors;
}

/** Copies only current v2 link fields; removed legacy markers never travel. */
function packLink(link) {
  const cosmetics = resolveLinkCosmetics(link);
  return {
    id: typeof link?.id === "string" ? link.id : "",
    targetId: typeof link?.targetId === "string" ? link.targetId : "",
    label: typeof link?.label === "string" ? link.label.slice(0, MAX_TITLE_LENGTH) : "",
    direction: ["none", "one", "two"].includes(link?.direction) ? link.direction : "none",
    color: typeof link?.color === "string" ? link.color : "",
    lineStyle: link?.lineStyle === "dashed" ? "dashed" : "solid",
    origin: link?.origin === "typed" ? "typed" : "drawn",
    edited: link?.edited === true,
    createdBy: typeof link?.createdBy === "string" ? link.createdBy : "",
    sourceAnchorId: validAnchorId(link?.sourceAnchorId) ? link.sourceAnchorId : "",
    targetAnchorId: validAnchorId(link?.targetAnchorId) ? link.targetAnchorId : "",
    sourcePinRef: typeof link?.sourcePinRef === "string"
      ? link.sourcePinRef.slice(0, 200) : "",
    targetPinRef: typeof link?.targetPinRef === "string"
      ? link.targetPinRef.slice(0, 200) : "",
    routeAnchors: cleanRouteAnchors(link?.routeAnchors),
    ...cosmetics,
    ...linkAnchors(link)
  };
}

function packCard(card, note) {
  if (!isObject(card) || !finite(card.x) || !finite(card.y)) return null;
  const sizing = normalizeSizing(card.sizing);
  const size = cardPlacementSize({ ...card, sizing }, note);
  const origin = card.autoSizeOrigin;
  return {
    x: card.x,
    y: card.y,
    sizing,
    autoSizeOrigin: finite(origin?.x) && finite(origin?.y)
      ? { x: origin.x, y: origin.y }
      : { x: card.x + size.width / 2, y: card.y },
    rotation: finite(card.rotation) ? card.rotation : 0,
    ports: validCardPorts(card.ports) ? [...card.ports] : [...DEFAULT_CARD_PORTS],
    anchors: sanitizeCardAnchorsWithMain(
      card.anchors, resolveAttachment({ attachment: note?.attachment }).mainPinEnabled,
      typeof note?.authorId === "string" ? note.authorId : ""
    )
  };
}

function packLabel(label) {
  const stamp = typeof label?.stamp === "string" && stampUrl(label.stamp) ? label.stamp : "";
  const color = Object.values(STAMP_COLORS).includes(label?.color) ? label.color : "";
  return {
    text: typeof label?.text === "string" ? label.text.slice(0, MAX_LABEL_TEXT_LENGTH) : "",
    x: finite(label?.x) ? label.x : 0,
    y: finite(label?.y) ? label.y : 0,
    size: finite(label?.size) ? label.size : 14,
    color,
    stamp,
    noteId: typeof label?.noteId === "string" ? label.noteId : "",
    corner: isStampCorner(label?.corner) ? label.corner : DEFAULT_STAMP_CORNER
  };
}

function packPin(pin, noteId, pinId) {
  if (!validAnchorId(pinId) || !isObject(pin)) return null;
  const owner = typeof pin.noteId === "string" ? pin.noteId : "";
  // Free board pins (no note owner) are deliberately not transported.
  if (!owner || owner !== noteId) return null;
  if (!validPinPosition(owner, pin.x, pin.y)) return null;
  return { noteId: owner, x: pin.x, y: pin.y, isDefault: false };
}

function packPinLink(link) {
  if (!isObject(link) || typeof link.source !== "string" || typeof link.target !== "string") {
    return null;
  }
  const clean = normalizePinLink(link);
  clean.source = link.source;
  clean.target = link.target;
  return clean;
}

function refOwner(ref, boardPins) {
  if (typeof ref !== "string") return "";
  if (ref.startsWith("n:")) {
    const split = ref.indexOf(":", 2);
    return split > 0 ? ref.slice(2, split) : "";
  }
  if (ref.startsWith("p:")) return boardPins[ref.slice(2)]?.noteId ?? "";
  return "";
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

/** Reads shared pages from a Foundry PageCollection, a Map, an array or an id-keyed object. */
function sharedPageMap(sharedPages) {
  const pages = new Map();
  if (!sharedPages || typeof sharedPages !== "object") return pages;
  let entries;
  if (Array.isArray(sharedPages)) entries = sharedPages.map(page => [page?.id ?? page?._id, page]);
  else if (typeof sharedPages.entries === "function") entries = [...sharedPages.entries()];
  else entries = Object.entries(sharedPages);
  for (const [id, page] of entries) {
    if (typeof id === "string" && id && page && typeof page === "object") pages.set(id, page);
  }
  return pages;
}

function liveSharedPage(page) {
  if (!page || typeof page !== "object") return false;
  if (page.type && page.type !== NOTE_TYPE) return false;
  const system = page.system;
  return !!system && typeof system === "object" && !system.deleted;
}

function sharedSystem(page) {
  return page?.system && typeof page.system === "object" ? page.system : {};
}

/** External-link/waypoint accounting for a shared→private copy, for the sender UI warning. */
export function countSharedTransferDrops(sharedPages, noteIds) {
  const pages = sharedPageMap(sharedPages);
  const selected = new Set((Array.isArray(noteIds) ? noteIds : [])
    .filter(id => typeof id === "string" && liveSharedPage(pages.get(id))));
  const notes = {};
  for (const id of selected) {
    const system = sharedSystem(pages.get(id));
    notes[id] = { links: Array.isArray(system.links) ? system.links : [] };
  }
  return countDrops(notes, selected);
}

/** Converts one shared v2 page into the note payload shape `importPrivateTransfer` expects. */
function sharedTransferNote(page) {
  const system = sharedSystem(page);
  const note = {
    schemaVersion: NOTE_SCHEMA_VERSION,
    id: typeof page?.id === "string" ? page.id : page?._id,
    body: typeof system.body === "string" ? system.body : "",
    revision: 0,
    layout: system.layout,
    skin: resolveSkin(system.skin),
    attachment: resolveAttachment({ attachment: system.attachment }),
    links: (Array.isArray(system.links) ? system.links : []).map(packLink),
    authorId: typeof system.authorId === "string" ? system.authorId : "",
    createdAt: finite(system.createdAt) ? system.createdAt : Date.now(),
    updatedAt: finite(system.updatedAt) ? system.updatedAt : Date.now()
  };
  assertV2Note({ ...note, schemaVersion: system.schemaVersion });
  return note;
}

/**
 * Packs a bounded, self-contained private copy of selected shared v2 notes.
 *
 * The shared journal is authoritative input. Only current v2 body/layout/skin/attachment/links
 * are read; explicit selection determines which relationships survive. Attached labels and board
 * pins referenced by a packed pin link travel; orphaned/free pins and links to notes outside the
 * selection stay behind. `toUserId` may equal `fromUserId`: the socket handler uses that shape for
 * a direct self-import and never stores it as a pending offer.
 */
export function buildSharedTransfer(sharedPages, layout, noteIds, { fromUserId, toUserId } = {}) {
  if (typeof fromUserId !== "string" || !fromUserId
      || typeof toUserId !== "string" || !toUserId) {
    throw new Error(t("JN.Transfer.UserMissing"));
  }
  if (!Array.isArray(noteIds) || !noteIds.length) throw new Error(t("JN.Transfer.None"));
  if (noteIds.length > MAX_TRANSFER_NOTES) {
    throw new Error(t("JN.Transfer.TooMany", { max: MAX_TRANSFER_NOTES }));
  }

  const pages = sharedPageMap(sharedPages);
  const cards = layout?.cards && typeof layout.cards === "object" ? layout.cards : {};
  const labels = layout?.labels && typeof layout.labels === "object" ? layout.labels : {};
  const boardPins = layout?.pins && typeof layout.pins === "object" ? layout.pins : {};
  const boardLinks = layout?.pinLinks && typeof layout.pinLinks === "object" ? layout.pinLinks : {};

  const selected = [];
  const seen = new Set();
  let totalText = 0;
  for (const noteId of noteIds) {
    if (typeof noteId !== "string" || !noteId || seen.has(noteId)
        || !liveSharedPage(pages.get(noteId))) {
      throw new Error(t("JN.Transfer.Stale"));
    }
    const note = sharedTransferNote(pages.get(noteId));
    seen.add(noteId);
    totalText += note.body.length;
    if (totalText > MAX_TRANSFER_TEXT) {
      throw new Error(t("JN.Transfer.TooLarge", { max: MAX_TRANSFER_TEXT }));
    }
    selected.push(noteId);
  }

  let labelCount = 0;
  const transferablePinLinks = Object.entries(boardLinks)
    .filter(([, link]) => isObject(link)
      && seen.has(refOwner(link.source, boardPins))
      && seen.has(refOwner(link.target, boardPins)));
  const linkedPinIds = new Set();
  for (const [, link] of transferablePinLinks) {
    for (const ref of [link.source, link.target]) {
      if (typeof ref === "string" && ref.startsWith("p:")) linkedPinIds.add(ref.slice(2));
    }
  }

  const packed = selected.map(noteId => {
    const page = pages.get(noteId);
    const note = sharedTransferNote(page);
    const attached = {};
    const usedLabelIds = new Set();
    for (const [labelId, label] of Object.entries(labels)) {
      if (!isObject(label) || label.noteId !== noteId) continue;
      labelCount += 1;
      if (labelCount > MAX_TRANSFER_LABELS) {
        throw new Error(t("JN.Transfer.TooManyLabels", { max: MAX_TRANSFER_LABELS }));
      }
      let safeLabelId = typeof labelId === "string"
        && SAFE_ID_RE.test(labelId) && !RESERVED_IDS.has(labelId) ? labelId : "";
      if (!safeLabelId || usedLabelIds.has(safeLabelId)) safeLabelId = freshId(usedLabelIds);
      else usedLabelIds.add(safeLabelId);
      attached[safeLabelId] = packLabel(label);
    }
    const pins = {};
    for (const [id, pin] of Object.entries(boardPins)) {
      if (!linkedPinIds.has(id)) continue;
      const clean = packPin(pin, noteId, id);
      if (clean) pins[id] = clean;
    }
    return {
      note,
      card: own(cards, noteId) ? packCard(cards[noteId], note) : null,
      labels: attached,
      pins
    };
  });

  const packedPinLinks = Object.fromEntries(transferablePinLinks
    .map(([id, link]) => [id, packPinLink(link)])
    .filter(([, link]) => link));

  const drops = countSharedTransferDrops(pages, selected);
  return {
    transferVersion: TRANSFER_VERSION,
    fromUserId,
    toUserId,
    createdAt: Date.now(),
    notes: packed,
    pinLinks: packedPinLinks,
    summary: {
      count: packed.length,
      titles: packed.map(entry => deriveNoteTitle(entry.note)),
      droppedLinks: drops.droppedLinks,
      droppedWaypoints: drops.droppedWaypoints
    }
  };
}

/**
 * Packs a bounded, self-contained copy of selected private v2 notes.
 *
 * `allowSelf` is only for private→shared publication, which reuses the importer to allocate fresh
 * ids and remap internal relationships without creating a pending inbox offer.
 */
export function buildPrivateTransfer(workspace, noteIds, {
  fromUserId, toUserId, allowSelf = false
} = {}) {
  if (typeof fromUserId !== "string" || !fromUserId
      || typeof toUserId !== "string" || !toUserId) {
    throw new Error(t("JN.Transfer.UserMissing"));
  }
  if (fromUserId === toUserId && !allowSelf) throw new Error(t("JN.Transfer.Self"));
  if (!Array.isArray(noteIds) || !noteIds.length) throw new Error(t("JN.Transfer.None"));
  if (noteIds.length > MAX_TRANSFER_NOTES) {
    throw new Error(t("JN.Transfer.TooMany", { max: MAX_TRANSFER_NOTES }));
  }

  const notes = workspace?.notes && typeof workspace.notes === "object" ? workspace.notes : {};
  const cards = workspace?.layout?.cards && typeof workspace.layout.cards === "object"
    ? workspace.layout.cards : {};
  const labels = workspace?.layout?.labels && typeof workspace.layout.labels === "object"
    ? workspace.layout.labels : {};
  const boardPins = workspace?.layout?.pins && typeof workspace.layout.pins === "object"
    ? workspace.layout.pins : {};
  const boardLinks = workspace?.layout?.pinLinks && typeof workspace.layout.pinLinks === "object"
    ? workspace.layout.pinLinks : {};

  const selected = [];
  const seen = new Set();
  let totalText = 0;
  for (const noteId of noteIds) {
    if (typeof noteId !== "string" || !noteId || seen.has(noteId) || !own(notes, noteId)) {
      throw new Error(t("JN.Transfer.Stale"));
    }
    const note = notes[noteId];
    assertV2Note(note);
    seen.add(noteId);
    totalText += note.body.length;
    if (totalText > MAX_TRANSFER_TEXT) {
      throw new Error(t("JN.Transfer.TooLarge", { max: MAX_TRANSFER_TEXT }));
    }
    selected.push(noteId);
  }

  let labelCount = 0;
  const transferablePinLinks = Object.entries(boardLinks)
    .filter(([, link]) => isObject(link)
      && seen.has(refOwner(link.source, boardPins))
      && seen.has(refOwner(link.target, boardPins)));
  const linkedPinIds = new Set();
  for (const [, link] of transferablePinLinks) {
    for (const ref of [link.source, link.target]) {
      if (typeof ref === "string" && ref.startsWith("p:")) linkedPinIds.add(ref.slice(2));
    }
  }

  const packed = selected.map(noteId => {
    const source = notes[noteId];
    const note = {
      schemaVersion: NOTE_SCHEMA_VERSION,
      id: source.id,
      body: source.body,
      revision: 0,
      layout: source.layout,
      skin: resolveSkin(source.skin),
      attachment: resolveAttachment({ attachment: source.attachment }),
      links: (Array.isArray(source.links) ? source.links : []).map(packLink),
      authorId: typeof source.authorId === "string" ? source.authorId : "",
      createdAt: finite(source.createdAt) ? source.createdAt : Date.now(),
      updatedAt: finite(source.updatedAt) ? source.updatedAt : Date.now()
    };
    const attached = {};
    const usedLabelIds = new Set();
    for (const [labelId, label] of Object.entries(labels)) {
      if (!isObject(label) || label.noteId !== noteId) continue;
      labelCount += 1;
      if (labelCount > MAX_TRANSFER_LABELS) {
        throw new Error(t("JN.Transfer.TooManyLabels", { max: MAX_TRANSFER_LABELS }));
      }
      let safeLabelId = typeof labelId === "string"
        && SAFE_ID_RE.test(labelId) && !RESERVED_IDS.has(labelId) ? labelId : "";
      if (!safeLabelId || usedLabelIds.has(safeLabelId)) safeLabelId = freshId(usedLabelIds);
      else usedLabelIds.add(safeLabelId);
      attached[safeLabelId] = packLabel(label);
    }
    const pins = {};
    for (const [id, pin] of Object.entries(boardPins)) {
      if (!linkedPinIds.has(id)) continue;
      const clean = packPin(pin, noteId, id);
      if (clean) pins[id] = clean;
    }
    return {
      note,
      card: own(cards, noteId) ? packCard(cards[noteId], note) : null,
      labels: attached,
      pins
    };
  });

  const packedPinLinks = Object.fromEntries(transferablePinLinks
    .map(([id, link]) => [id, packPinLink(link)])
    .filter(([, link]) => link));

  const drops = countDrops(notes, new Set(selected));
  return {
    transferVersion: TRANSFER_VERSION,
    fromUserId,
    toUserId,
    createdAt: Date.now(),
    notes: packed,
    pinLinks: packedPinLinks,
    summary: {
      count: packed.length,
      titles: packed.map(entry => deriveNoteTitle(entry.note)),
      droppedLinks: drops.droppedLinks,
      droppedWaypoints: drops.droppedWaypoints
    }
  };
}

function sourceLabelEntries(labels) {
  if (Array.isArray(labels)) return labels.filter(label => label && typeof label === "object");
  if (!labels || typeof labels !== "object") return [];
  return Object.values(labels).filter(label => label && typeof label === "object");
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
    const clean = packLink(link);
    imported.push({
      ...clean,
      id: freshId(usedLinkIds),
      targetId,
      createdBy: recipientId,
      sourcePinRef: pinRefMap(link?.sourcePinRef) ?? "",
      targetPinRef: pinRefMap(link?.targetPinRef) ?? "",
      routeAnchors
    });
  }
  return { links: imported, dropped, droppedWaypoints };
}

function importLabels(labels, { oldNoteId, newNoteId, usedLabelIds }) {
  const imported = {};
  for (const label of sourceLabelEntries(labels)) {
    if (label.noteId !== oldNoteId) continue;
    const clean = packLabel({ ...label, noteId: newNoteId });
    imported[freshId(usedLabelIds)] = clean;
  }
  return imported;
}

function importCard(sourceCard, note, recipientId, cards, notes) {
  const sizing = normalizeSizing(sourceCard?.sizing);
  const size = cardPlacementSize({ ...sourceCard, sizing }, note);
  const sourceX = finite(sourceCard?.x) ? sourceCard.x : 0;
  const sourceY = finite(sourceCard?.y) ? sourceCard.y : 0;
  const rotation = finite(sourceCard?.rotation) ? sourceCard.rotation : 0;
  const spot = findFreeSpot(cards, size.width, size.height, sourceX, sourceY, rotation, { notes });
  const sourceOrigin = sourceCard?.autoSizeOrigin;
  const origin = finite(sourceOrigin?.x) && finite(sourceOrigin?.y)
    ? { x: sourceOrigin.x + (spot.x - sourceX), y: sourceOrigin.y + (spot.y - sourceY) }
    : { x: spot.x + size.width / 2, y: spot.y };
  const anchors = sanitizeCardAnchorsWithMain(
    sourceCard?.anchors,
    resolveAttachment({ attachment: note.attachment }).mainPinEnabled,
    recipientId
  );
  for (const [id, anchor] of Object.entries(anchors)) {
    anchors[id] = { ...anchor, createdBy: recipientId };
  }
  return {
    x: spot.x,
    y: spot.y,
    sizing,
    autoSizeOrigin: origin,
    rotation,
    ports: validCardPorts(sourceCard?.ports) ? [...sourceCard.ports] : [...DEFAULT_CARD_PORTS],
    anchors
  };
}

function assertTransfer(transfer) {
  if (!isObject(transfer) || transfer.transferVersion !== TRANSFER_VERSION) {
    throw incompatibleError(UNSUPPORTED_TRANSFER);
  }
  if (!Array.isArray(transfer.notes) || !transfer.notes.length) {
    throw new Error(t("JN.Transfer.None"));
  }
  if (transfer.notes.length > MAX_TRANSFER_NOTES) {
    throw new Error(t("JN.Transfer.TooMany", { max: MAX_TRANSFER_NOTES }));
  }
}

/**
 * Deep-copies a v2 transfer into `workspace`. Note, card, link, label, pin and pin-link ids are
 * regenerated; links and route waypoints are remapped only when their target note is part of the
 * transfer. Cards keep sizing/origin/rotation/anchors but are placed near their original positions
 * using rotated AABB footprints without overlapping destination cards. The recipient is the new
 * owner/author; the input workspace/transfer are never mutated.
 *
 * Returns `{ workspace, imported, droppedLinks, droppedWaypoints }` where `imported` is the list
 * of new note ids. Revision/history/activity identities are fresh because none are carried in the
 * payload.
 */
export function importPrivateTransfer(workspace, transfer, recipientId) {
  if (typeof recipientId !== "string" || !recipientId) {
    throw new Error(t("JN.Transfer.UserMissing"));
  }
  assertTransfer(transfer);

  let totalText = 0;
  let labelCount = 0;
  for (const entry of transfer.notes) {
    const note = entry?.note;
    assertV2Note(note);
    totalText += note.body.length;
    if (totalText > MAX_TRANSFER_TEXT) {
      throw new Error(t("JN.Transfer.TooLarge", { max: MAX_TRANSFER_TEXT }));
    }
    labelCount += sourceLabelEntries(entry?.labels).length;
    if (labelCount > MAX_TRANSFER_LABELS) {
      throw new Error(t("JN.Transfer.TooManyLabels", { max: MAX_TRANSFER_LABELS }));
    }
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
    const note = {
      id: newId,
      body: sourceNote.body,
      revision: 0,
      layout: sourceNote.layout,
      skin: resolveSkin(sourceNote.skin),
      attachment: resolveAttachment({ attachment: sourceNote.attachment }),
      links: [],
      authorId: recipientId,
      createdAt: finite(sourceNote.createdAt) ? sourceNote.createdAt : Date.now(),
      updatedAt: Date.now(),
      schemaVersion: NOTE_SCHEMA_VERSION,
      deleted: null,
      lastSave: null
    };

    const linkResult = importLinks(sourceNote.links, {
      newId, noteIdMap, pinRefMap, recipientId, usedLinkIds
    });
    note.links = linkResult.links;
    droppedLinks += linkResult.dropped;
    droppedWaypoints += linkResult.droppedWaypoints;

    const card = importCard(entry.card, note, recipientId, result.layout.cards, result.notes);
    result.notes[newId] = note;
    result.layout.cards[newId] = card;
    for (const [oldPinId, pin] of Object.entries(entry.pins ?? {})) {
      const newPinId = pinIdMap.get(oldPinId);
      if (!newPinId || !isObject(pin) || !validPinPosition(newId, pin.x, pin.y)) continue;
      result.layout.pins[newPinId] = {
        noteId: newId, x: pin.x, y: pin.y, isDefault: false
      };
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
    const clean = packPinLink({ ...link, source, target });
    if (clean) result.layout.pinLinks[freshId(usedPinLinkIds)] = clean;
  }

  return { workspace: result, imported, droppedLinks, droppedWaypoints };
}
