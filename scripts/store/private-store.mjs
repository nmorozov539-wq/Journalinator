import { getContainerIds } from "./containers.mjs";
import {
  CARD_SIDES, DEFAULT_CARD_PORTS, MAX_THREAD_PINS, validCardPorts, validLinkPoint, validThreadPin
} from "../card-ports.mjs";
import { normalizeLinkColor } from "../link-colors.mjs";
import { validAnchorId } from "../anchors.mjs";
import { normalizePinLink, resolvePin, validPinPosition } from "../board-pins.mjs";
import { DEFAULT_STAMP_CORNER, STAMP_COLORS, isStampCorner, stampUrl } from "../stamps.mjs";
import {
  resolveAttachment, resolveLinkCosmetics, sanitizeCardAnchorsWithMain
} from "../presentation.mjs";
import { t } from "../i18n.mjs";
import { parseDocument, deriveTitle } from "../document/index.mjs";
import { getLayout, isLayout } from "../layouts/registry.mjs";
import {
  isFont, isPaper, resolveSkin, seededSkin, tiltForSkin
} from "../skins/registry.mjs";
import { templateSkin } from "../templates.mjs";
import {
  MAX_TRANSFER_NOTES, MAX_TRANSFER_TEXT, importPrivateTransfer
} from "../private-transfer.mjs";
import {
  appendPrivateSnapshot, checkpointPrivateHistory, deletePrivateHistory,
  privateHistoryList, privateSnapshot
} from "../private/private-history.mjs";

const MODULE_ID = "fvtt-journalinator";
const PRIVATE_TYPE = "text";
const FLAG = "private";
const TRANSFERS_FLAG = "transfers";
const MAX_NAME_LENGTH = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_ROUTE_ANCHORS = 24;
const MAX_ANCHOR_ID_LENGTH = 64;
const MAX_PENDING_TRANSFERS = 20;
const MAX_PENDING_PER_SENDER = 5;
const TRANSFER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRANSFER_STORAGE = 4000000;
const MAX_ACCEPTED_TRANSFERS = 50;
const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_TRANSFER_IDS = new Set(["__proto__", "prototype", "constructor"]);

export const WORKSPACE_FORMAT = 3;
export const NOTE_SCHEMA_VERSION = 2;

const SIZING_WIDTH_MIN = 160;
const SIZING_WIDTH_MAX = 800;
const SIZING_MIN_HEIGHT_MIN = 80;
const SIZING_MIN_HEIGHT_MAX = 1600;
const CARD_PADDING = 16;
const PLACEMENT_STEP = 45;

const randomID = () => foundry.utils.randomID();
const NONE = () => CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
const OWNER = () => CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  const deepClone = globalThis.foundry?.utils?.deepClone;
  if (typeof deepClone === "function") return deepClone(value);
  return structuredClone(value);
}

function hasOwn(value, key) {
  return !!value && typeof value === "object" && Object.hasOwn(value, key);
}

function finite(value) {
  return Number.isFinite(value);
}

function clamp(value, min, max, fallback) {
  return finite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Typed non-destructive guard error: old private data is never normalized into empty v2 notes. */
export class PrivateIncompatibleFormat extends Error {
  constructor(reason = "legacy-format", details = {}) {
    super(t("JN.Private.IncompatibleFormat"));
    this.name = "JN.Private.IncompatibleFormat";
    this.code = reason;
    this.reason = reason;
    this.format = details.format ?? null;
    this.rev = details.rev ?? 0;
  }
}

export function isIncompatibleFormat(error) {
  return error?.name === "JN.Private.IncompatibleFormat";
}

/**
 * Pure expiry partition for pending transfers. Records older than the TTL are returned separately
 * so a read can hide them immediately and a later write can delete their flag keys. Invalid or
 * future timestamps stay until a valid clock catches up; the sender handler always stamps `now`.
 */
export function partitionExpiredTransfers(transfers, now = Date.now(), ttl = TRANSFER_TTL_MS) {
  const fresh = {};
  const expired = [];
  for (const [id, record] of Object.entries(transfers ?? {})) {
    if (record && typeof record === "object"
        && Number.isFinite(record.createdAt) && now - record.createdAt > ttl) {
      expired.push(id);
    } else {
      fresh[id] = record;
    }
  }
  return { fresh, expired };
}

export function emptyWorkspace() {
  return {
    format: WORKSPACE_FORMAT,
    notes: {},
    layout: { cards: {}, labels: {}, pins: {}, pinLinks: {}, viewport: null },
    trash: [],
    history: {}
  };
}

function anchorId(value) {
  return validAnchorId(value) ? value : "";
}

function normalizeRouteAnchors(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const anchors = [];
  for (const anchor of list) {
    if (typeof anchor?.noteId !== "string" || !anchor.noteId) continue;
    if (!validAnchorId(anchor?.anchorId)) continue;
    const key = `${anchor.noteId}:${anchor.anchorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({
      noteId: anchor.noteId.slice(0, MAX_ANCHOR_ID_LENGTH),
      anchorId: anchor.anchorId
    });
    if (anchors.length >= MAX_ROUTE_ANCHORS) break;
  }
  return anchors;
}

function normalizeLink(link) {
  const direction = ["none", "one", "two"].includes(link?.direction) ? link.direction : "none";
  const lineStyle = link?.lineStyle === "dashed" ? "dashed" : "solid";
  const cosmetics = resolveLinkCosmetics(link);
  const clean = {
    id: typeof link?.id === "string" && link.id ? link.id : randomID(),
    targetId: typeof link?.targetId === "string" ? link.targetId : "",
    label: typeof link?.label === "string" ? link.label.slice(0, MAX_TITLE_LENGTH) : "",
    direction,
    color: normalizeLinkColor(link?.color),
    lineStyle,
    origin: link?.origin === "typed" ? "typed" : "drawn",
    edited: link?.edited === true,
    createdBy: typeof link?.createdBy === "string" ? link.createdBy : "",
    sourceAnchorId: anchorId(link?.sourceAnchorId),
    targetAnchorId: anchorId(link?.targetAnchorId),
    sourcePinRef: typeof link?.sourcePinRef === "string" ? link.sourcePinRef.slice(0, 200) : "",
    targetPinRef: typeof link?.targetPinRef === "string" ? link.targetPinRef.slice(0, 200) : "",
    routeAnchors: normalizeRouteAnchors(link?.routeAnchors),
    material: cosmetics.material,
    thickness: cosmetics.thickness,
    slack: cosmetics.slack,
    pattern: cosmetics.pattern,
    ends: cosmetics.ends,
    secondaryColor: cosmetics.secondaryColor
  };
  for (const key of ["sourceSide", "targetSide"]) {
    if (CARD_SIDES.includes(link?.[key])) clean[key] = link[key];
  }
  for (const key of ["sourcePoint", "targetPoint"]) {
    if (validLinkPoint(link?.[key])) clean[key] = { x: link[key].x, y: link[key].y };
  }
  if (Array.isArray(link?.pins)) {
    clean.pins = link.pins.slice(0, MAX_THREAD_PINS).filter(validThreadPin).map(({ x, y }) => ({ x, y }));
  }
  return clean;
}

function normalizeAnchors(anchors, mainPinEnabled = true) {
  return sanitizeCardAnchorsWithMain(anchors, mainPinEnabled);
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

function normalizeCard(card, mainPinEnabled = true) {
  if (!finite(card?.x) || !finite(card?.y)) return null;
  const origin = card?.autoSizeOrigin;
  return {
    x: card.x,
    y: card.y,
    sizing: normalizeSizing(card?.sizing),
    autoSizeOrigin: finite(origin?.x) && finite(origin?.y)
      ? { x: origin.x, y: origin.y } : null,
    rotation: finite(card.rotation) ? card.rotation : 0,
    ports: validCardPorts(card.ports) ? [...card.ports] : [...DEFAULT_CARD_PORTS],
    anchors: normalizeAnchors(card.anchors, mainPinEnabled)
  };
}

function normalizeLabel(label) {
  const stamp = typeof label?.stamp === "string" && stampUrl(label.stamp) ? label.stamp : "";
  const color = Object.values(STAMP_COLORS).includes(label?.color) ? label.color : "";
  return {
    text: typeof label?.text === "string" ? label.text.slice(0, 500) : "",
    x: finite(label?.x) ? label.x : 0,
    y: finite(label?.y) ? label.y : 0,
    size: finite(label?.size) ? label.size : 14,
    color,
    stamp,
    noteId: typeof label?.noteId === "string" ? label.noteId : "",
    corner: isStampCorner(label?.corner) ? label.corner : DEFAULT_STAMP_CORNER
  };
}

function normalizeDeleted(deleted) {
  if (!isObject(deleted)) return null;
  return {
    at: finite(deleted.at) ? deleted.at : 0,
    by: typeof deleted.by === "string" ? deleted.by : "",
    undoId: typeof deleted.undoId === "string" ? deleted.undoId : null,
    ...(isObject(deleted.lastCard) ? { lastCard: clone(deleted.lastCard) } : {})
  };
}

function normalizeLastSave(lastSave) {
  if (!isObject(lastSave)) return null;
  return {
    requestId: typeof lastSave.requestId === "string" ? lastSave.requestId : "",
    clientSessionId: typeof lastSave.clientSessionId === "string" ? lastSave.clientSessionId : "",
    sequence: Number.isInteger(lastSave.sequence) && lastSave.sequence >= 0 ? lastSave.sequence : 0,
    revision: Number.isInteger(lastSave.revision) && lastSave.revision >= 0 ? lastSave.revision : 0,
    bodyHash: typeof lastSave.bodyHash === "string" ? lastSave.bodyHash : "",
    at: finite(lastSave.at) ? lastSave.at : 0,
    eventIds: Array.isArray(lastSave.eventIds)
      ? lastSave.eventIds.filter(id => typeof id === "string").slice(0, 32) : []
  };
}

/** A complete current-schema private note, with no legacy content fields. */
export function normalizeNoteV2(note, id = null) {
  const noteId = typeof note?.id === "string" && note.id
    ? note.id : (typeof id === "string" && id ? id : randomID());
  return {
    id: noteId,
    body: typeof note?.body === "string" ? note.body : "",
    revision: Number.isInteger(note?.revision) && note.revision >= 0 ? note.revision : 0,
    layout: isLayout(note?.layout) ? note.layout : "plain",
    skin: resolveSkin(note?.skin),
    attachment: resolveAttachment({ attachment: note?.attachment }),
    links: (Array.isArray(note?.links) ? note.links : []).map(normalizeLink),
    authorId: typeof note?.authorId === "string" ? note.authorId : "",
    createdAt: finite(note?.createdAt) ? note.createdAt : Date.now(),
    updatedAt: finite(note?.updatedAt) ? note.updatedAt : Date.now(),
    schemaVersion: NOTE_SCHEMA_VERSION,
    deleted: normalizeDeleted(note?.deleted),
    lastSave: normalizeLastSave(note?.lastSave)
  };
}

function isV2Note(note) {
  if (!isObject(note)) return false;
  if (note.schemaVersion !== NOTE_SCHEMA_VERSION) return false;
  if (typeof note.body !== "string") return false;
  if (!Number.isInteger(note.revision) || note.revision < 0) return false;
  if (!isLayout(note.layout)) return false;
  if (!isObject(note.skin) || !isPaper(note.skin.paper) || !isFont(note.skin.font)) return false;
  if (typeof note.skin.torn !== "boolean") return false;
  if (note.skin.backgroundImage !== null && note.skin.backgroundImage !== undefined
      && typeof note.skin.backgroundImage !== "string") return false;
  if (!Number.isInteger(note.skin.tiltSeed) || note.skin.tiltSeed < 0) return false;
  if (!isObject(note.attachment)) return false;
  if (!Array.isArray(note.links)) return false;
  if (typeof note.authorId !== "string") return false;
  if (!finite(note.createdAt) || !finite(note.updatedAt)) return false;
  if (note.deleted !== undefined && note.deleted !== null && !isObject(note.deleted)) return false;
  if (note.lastSave !== undefined && note.lastSave !== null && !isObject(note.lastSave)) return false;
  return true;
}

function isSnapshot(entry) {
  return isObject(entry)
    && typeof entry.id === "string" && entry.id.length > 0
    && typeof entry.body === "string"
    && finite(entry.at)
    && typeof entry.authorId === "string"
    && Number.isInteger(entry.revision) && entry.revision >= 0;
}

function isCurrentWorkspace(value) {
  if (!isObject(value) || value.format !== WORKSPACE_FORMAT) return false;
  if (!isObject(value.notes) || !isObject(value.layout)) return false;
  if (!isObject(value.layout.cards) || !isObject(value.layout.labels)
      || !isObject(value.layout.pins) || !isObject(value.layout.pinLinks)) return false;
  if (value.layout.viewport !== null && value.layout.viewport !== undefined
      && !isObject(value.layout.viewport)) return false;
  if (!Array.isArray(value.trash)) return false;
  if (!isObject(value.history)) return false;

  for (const [id, note] of Object.entries(value.notes)) {
    if (!id || !isV2Note(note)) return false;
    if (note.id !== undefined && note.id !== id) return false;
  }
  for (const list of Object.values(value.history)) {
    if (!Array.isArray(list)) return false;
    if (list.some(entry => !isSnapshot(entry))) return false;
  }
  for (const entry of value.trash) {
    if (!isObject(entry) || !isV2Note(entry.note)) return false;
    if (entry.card !== null && entry.card !== undefined && !isObject(entry.card)) return false;
    if (!finite(entry.deletedAt)) return false;
    if (entry.undoId !== null && entry.undoId !== undefined && typeof entry.undoId !== "string") {
      return false;
    }
  }
  return true;
}

function normalizeViewport(viewport) {
  if (!isObject(viewport)) return null;
  return {
    x: finite(viewport.x) ? viewport.x : 0,
    y: finite(viewport.y) ? viewport.y : 0,
    zoom: finite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
  };
}

/** Normalizes already-validated format 3 data. Never invents notes. */
function normalizeCurrentWorkspace(input) {
  const source = input && typeof input === "object" ? input : {};
  const notes = {};
  for (const [id, note] of Object.entries(source.notes ?? {})) {
    const clean = normalizeNoteV2(note, id);
    notes[clean.id] = clean;
  }

  const cards = {};
  for (const [id, card] of Object.entries(source.layout?.cards ?? {})) {
    const note = notes[id];
    const clean = normalizeCard(card, note ? resolveAttachment(note).mainPinEnabled : false);
    if (clean) cards[id] = clean;
  }

  const labels = {};
  for (const [id, label] of Object.entries(source.layout?.labels ?? {})) {
    labels[id] = normalizeLabel(label);
  }

  const pins = {};
  for (const [id, pin] of Object.entries(source.layout?.pins ?? {})) {
    if (!validAnchorId(id) || typeof pin?.noteId !== "string"
        || !validPinPosition(pin.noteId, pin.x, pin.y)
        || (pin.noteId && !cards[pin.noteId])) continue;
    pins[id] = { noteId: pin.noteId, x: pin.x, y: pin.y, isDefault: false };
  }

  const pinLinks = {};
  const pinLayout = { cards, pins };
  const boxes = new Map(Object.entries(cards).map(([id, card]) => {
    const size = cardPlacementSize(card, notes[id]);
    return [id, { ...card, w: size.width, h: size.height }];
  }));
  for (const [id, link] of Object.entries(source.layout?.pinLinks ?? {})) {
    if (!validAnchorId(id) || typeof link?.source !== "string"
        || typeof link?.target !== "string" || link.source === link.target) continue;
    if (resolvePin(link.source, pinLayout, boxes) && resolvePin(link.target, pinLayout, boxes)) {
      pinLinks[id] = normalizePinLink(link);
    }
  }

  const trash = (Array.isArray(source.trash) ? source.trash : []).map(entry => {
    const note = normalizeNoteV2(entry?.note);
    return {
      note,
      card: normalizeCard(entry?.card, resolveAttachment(note).mainPinEnabled),
      deletedAt: finite(entry?.deletedAt) ? entry.deletedAt : Date.now(),
      undoId: typeof entry?.undoId === "string" ? entry.undoId : null
    };
  });

  const history = {};
  for (const [noteId, list] of Object.entries(source.history ?? {})) {
    const normalized = privateHistoryList({ history: { [noteId]: list } }, noteId);
    if (normalized.length) history[noteId] = normalized;
  }

  return {
    format: WORKSPACE_FORMAT,
    notes,
    layout: {
      cards,
      labels,
      pins,
      pinLinks,
      viewport: normalizeViewport(source.layout?.viewport)
    },
    trash,
    history
  };
}

/** Normalizes current format 3 data, or throws the typed incompatibility error. */
export function normalizeWorkspace(input) {
  if (!isObject(input) || input.format !== WORKSPACE_FORMAT) {
    throw new PrivateIncompatibleFormat("legacy-format", { format: input?.format ?? null });
  }
  if (!isCurrentWorkspace(input)) {
    throw new PrivateIncompatibleFormat("invalid-workspace", { format: input.format });
  }
  return normalizeCurrentWorkspace(input);
}

function deriveNoteName(note) {
  let parsed = null;
  try {
    parsed = parseDocument(note?.body ?? "", { selectedLayout: note?.layout });
  } catch {
    parsed = null;
  }
  return deriveTitle(parsed, {
    emptyLabel: t("JN.Search.EmptyNote"),
    imageLabel: t("JN.Search.ImageNote")
  });
}

function positive(value) {
  return finite(value) && value > 0 ? value : null;
}

/** Rendered size hint for placement from v2 `sizing`, never old width/height. */
function cardPlacementSize(card, note) {
  const layout = getLayout(note?.layout ?? "plain");
  if (card?.sizing?.mode === "manual"
      && positive(card.sizing.width) && positive(card.sizing.minHeight)) {
    return { width: card.sizing.width, height: card.sizing.minHeight };
  }
  // Automatic cards have no stored rendered box. Reserve the layout's widest step so
  // placement can only err by leaving breathing room, never by overlapping measured text.
  return { width: layout.widths[layout.widths.length - 1], height: layout.minHeight };
}

function rotatedCardBounds(card, note) {
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

function boundsOverlap(a, b, padding = CARD_PADDING) {
  return !(a.right + padding < b.left || a.left > b.right + padding
    || a.bottom + padding < b.top || a.top > b.bottom + padding);
}

/**
 * Non-destructive format inspection for a private page.
 *
 * Returns `{ ok: true, workspace, rev }` only for current format 3 data with v2 notes.
 * Anything older or corrupt returns a bounded reason with `workspace: null`. It never
 * writes, migrates or fabricates notes. The private workspace is read from
 * `flags.private.workspace`; `page.system.workspace` is a legacy inspection fallback
 * only and is never written.
 */
export function inspectWorkspace(page) {
  const privateFlag = page?.flags?.[MODULE_ID]?.[FLAG] ?? {};
  const rev = finite(privateFlag.rev) ? privateFlag.rev : 0;
  const raw = privateFlag.workspace ?? page?.system?.workspace;
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "invalid-workspace", format: null, rev, workspace: null };
  }
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "invalid-workspace", format: null, rev, workspace: null };
    }
  }
  const format = Number.isInteger(value?.format) ? value.format : null;
  if (format !== WORKSPACE_FORMAT) {
    return { ok: false, reason: "legacy-format", format, rev, workspace: null };
  }
  if (!isCurrentWorkspace(value)) {
    return { ok: false, reason: "invalid-workspace", format, rev, workspace: null };
  }
  try {
    return { ok: true, workspace: normalizeCurrentWorkspace(value), rev };
  } catch {
    return { ok: false, reason: "invalid-workspace", format, rev, workspace: null };
  }
}

class PrivateStore {
  /** The private journal container entry. Also hosts pending transfer flags. */
  container() {
    const ids = getContainerIds();
    return ids?.private ? game.journal.get(ids.private) ?? null : null;
  }

  pages() {
    return [...(this.container()?.pages ?? [])]
      .filter(page => page.flags?.[MODULE_ID]?.[FLAG]?.ownerUserId !== undefined
        || page.flags?.[MODULE_ID]?.[FLAG]?.state !== undefined
        || page.flags?.[MODULE_ID]?.[FLAG]?.workspace !== undefined);
  }

  flags(page) {
    return page?.flags?.[MODULE_ID]?.[FLAG] ?? {};
  }

  state(page) {
    return this.flags(page).state ?? "orphaned";
  }

  ownerId(page) {
    return this.flags(page).ownerUserId ?? null;
  }

  findActive(userId) {
    return this.pages().find(page => this.ownerId(page) === userId && this.state(page) === "active") ?? null;
  }

  findPending(userId) {
    return this.pages().find(page => this.flags(page).pendingOwnerUserId === userId && this.state(page) === "pending") ?? null;
  }

  findById(pageId) {
    return this.pages().find(page => page.id === pageId) ?? null;
  }

  /** Standalone `inspectWorkspace()` bound as a store method for callers/tests. */
  inspectWorkspace(page) {
    return inspectWorkspace(page);
  }

  /** Current workspace, or a typed incompatibility throw for old/corrupt data. */
  read(page) {
    const status = this.inspectWorkspace(page);
    if (!status.ok) {
      throw new PrivateIncompatibleFormat(status.reason, {
        format: status.format,
        rev: status.rev
      });
    }
    return status.workspace;
  }

  /**
   * Pending private-to-private copies, stored on the private container so they travel with the
   * journal data. Foundry sends journal flags to every client; private data here is plaintext and
   * UI-private, exactly like the private workspaces themselves. Transfers never enter the shared
   * journal or the secrets vault.
   */
  transfers() {
    return partitionExpiredTransfers(this.rawTransfers()).fresh;
  }

  /** Valid transfer records before TTL filtering, so add/remove can physically drop old keys. */
  rawTransfers() {
    const value = this.container()?.flags?.[MODULE_ID]?.[TRANSFERS_FLAG];
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const clean = {};
    for (const [id, record] of Object.entries(value)) {
      if (TRANSFER_ID_RE.test(id) && !RESERVED_TRANSFER_IDS.has(id)
          && record && typeof record === "object") {
        clean[id] = record;
      }
    }
    return clean;
  }

  pendingTransfers(userId) {
    if (typeof userId !== "string" || !userId) return [];
    return Object.values(this.transfers())
      .filter(record => record && typeof record === "object" && record.toUserId === userId)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  transfer(id) {
    if (typeof id !== "string" || !TRANSFER_ID_RE.test(id)) return null;
    const all = this.transfers();
    return Object.hasOwn(all, id) ? all[id] : null;
  }

  /** Stores one already-built transfer, enforcing the per-recipient pending cap and size bounds. */
  async addTransfer(record) {
    const container = this.container();
    if (!container) throw new Error(t("JN.Private.ContainerMissing"));
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(t("JN.Transfer.Stale"));
    }
    if (typeof record.id !== "string" || !TRANSFER_ID_RE.test(record.id)
        || RESERVED_TRANSFER_IDS.has(record.id)) {
      throw new Error(t("JN.Transfer.Stale"));
    }
    if (typeof record.fromUserId !== "string" || !record.fromUserId
        || typeof record.toUserId !== "string" || !record.toUserId) {
      throw new Error(t("JN.Transfer.UserMissing"));
    }
    if (record.fromUserId === record.toUserId) throw new Error(t("JN.Transfer.Self"));
    const notes = Array.isArray(record.notes) ? record.notes : null;
    if (!notes || !notes.length) throw new Error(t("JN.Transfer.None"));
    if (notes.length > MAX_TRANSFER_NOTES) {
      throw new Error(t("JN.Transfer.TooMany", { max: MAX_TRANSFER_NOTES }));
    }
    let totalText = 0;
    for (const entry of notes) {
      if (!entry || typeof entry !== "object" || !entry.note || typeof entry.note !== "object") {
        throw new Error(t("JN.Transfer.Stale"));
      }
      totalText += typeof entry.note.body === "string"
        ? entry.note.body.length
        : (Array.isArray(entry.note.blocks) ? entry.note.blocks : [])
          .reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : 0), 0);
    }
    if (totalText > MAX_TRANSFER_TEXT) {
      throw new Error(t("JN.Transfer.TooLarge", { max: MAX_TRANSFER_TEXT }));
    }
    let serialized;
    try {
      serialized = JSON.stringify(record);
    } catch {
      throw new Error(t("JN.Transfer.TooLarge", { max: MAX_TRANSFER_TEXT }));
    }
    if (serialized.length > MAX_TRANSFER_STORAGE) {
      throw new Error(t("JN.Transfer.TooLarge", { max: MAX_TRANSFER_TEXT }));
    }

    const before = this.rawTransfers();
    if (Object.hasOwn(before, record.id)) throw new Error(t("JN.Transfer.Stale"));
    const { fresh: current, expired } = partitionExpiredTransfers(before);
    const pendingForRecipient = Object.values(current)
      .filter(item => item && typeof item === "object" && item.toUserId === record.toUserId).length;
    if (pendingForRecipient >= MAX_PENDING_TRANSFERS) {
      throw new Error(t("JN.Transfer.InboxFull", { max: MAX_PENDING_TRANSFERS }));
    }
    const pendingFromSender = Object.values(current)
      .filter(item => item && typeof item === "object"
        && item.toUserId === record.toUserId && item.fromUserId === record.fromUserId).length;
    if (pendingFromSender >= MAX_PENDING_PER_SENDER) {
      throw new Error(t("JN.Transfer.SenderInboxFull", { max: MAX_PENDING_PER_SENDER }));
    }

    const clean = foundry.utils.deepClone(record);
    clean.summary = {
      count: notes.length,
      titles: notes.map(entry => deriveNoteName(entry.note).slice(0, MAX_TITLE_LENGTH)),
      droppedLinks: Number.isFinite(record.summary?.droppedLinks)
        ? Math.max(0, Math.trunc(record.summary.droppedLinks)) : 0,
      droppedWaypoints: Number.isFinite(record.summary?.droppedWaypoints)
        ? Math.max(0, Math.trunc(record.summary.droppedWaypoints)) : 0
    };
    if (!Number.isFinite(clean.createdAt)) clean.createdAt = Date.now();
    const changes = {};
    for (const id of expired) {
      changes[`flags.${MODULE_ID}.${TRANSFERS_FLAG}.-=${id}`] = null;
    }
    changes[`flags.${MODULE_ID}.${TRANSFERS_FLAG}.${clean.id}`] = clean;
    await container.update(changes);
    return clean;
  }

  /**
   * Deletes one pending transfer from the container.
   *
   * Foundry deep-merges object updates, so writing a smaller `transfers` object leaves omitted
   * keys in place. The deletion key (`transfers.-=<id>`) is what actually removes the entry on a
   * real server; re-reading afterwards catches a server that ignored the deletion.
   */
  async removeTransfer(id) {
    if (typeof id !== "string" || !TRANSFER_ID_RE.test(id)) return false;
    const current = this.transfers();
    if (!Object.hasOwn(current, id)) return false;
    const container = this.container();
    if (!container) throw new Error(t("JN.Private.ContainerMissing"));
    await container.update({ [`flags.${MODULE_ID}.${TRANSFERS_FLAG}.-=${id}`]: null });
    if (Object.hasOwn(this.transfers(), id)) {
      throw new Error(t("JN.Transfer.RemoveFailed"));
    }
    return true;
  }

  acceptedTransfers(page) {
    const value = this.flags(page)?.acceptedTransfers;
    return Array.isArray(value) ? value.filter(id => typeof id === "string" && TRANSFER_ID_RE.test(id)) : [];
  }

  /** Note ids saved alongside each acceptance receipt, used to detect a stale overwrite. */
  acceptedTransferNotes(page) {
    const value = this.flags(page)?.acceptedTransferNotes;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const clean = {};
    for (const [id, ids] of Object.entries(value)) {
      if (!TRANSFER_ID_RE.test(id) || RESERVED_TRANSFER_IDS.has(id) || !Array.isArray(ids)) continue;
      clean[id] = ids.filter(noteId => typeof noteId === "string" && noteId && noteId.length <= 64);
    }
    return clean;
  }

  acceptedTransferNoteIds(page, transferId) {
    const all = this.acceptedTransferNotes(page);
    return Object.hasOwn(all, transferId) ? all[transferId] : [];
  }

  workspaceHasNotes(page, noteIds) {
    if (!Array.isArray(noteIds) || !noteIds.length) return false;
    const notes = this.read(page).notes;
    return noteIds.every(id => Object.hasOwn(notes, id));
  }

  #requireCurrent(workspace, details = {}) {
    if (!isObject(workspace) || workspace.format !== WORKSPACE_FORMAT) {
      throw new PrivateIncompatibleFormat("legacy-format", {
        format: workspace?.format ?? null,
        rev: details.rev ?? 0
      });
    }
    if (!isCurrentWorkspace(workspace)) {
      throw new PrivateIncompatibleFormat("invalid-workspace", {
        format: workspace.format,
        rev: details.rev ?? 0
      });
    }
    return normalizeCurrentWorkspace(workspace);
  }

  #inspectOrThrow(page) {
    const status = this.inspectWorkspace(page);
    if (!status.ok) {
      throw new PrivateIncompatibleFormat(status.reason, {
        format: status.format,
        rev: status.rev
      });
    }
    return status;
  }

  /**
   * Saves the imported workspace and the acceptance receipt in one page update. If the later
   * transfer removal fails, a retry finds the receipt and only removes the pending record instead
   * of importing a duplicate copy. Receipts are capped so the page flag cannot grow forever.
   *
   * This is a best-effort compare-and-set, not a server-side CAS: Foundry's journal update has no
   * last-writer guard, so a stale owner save can still land after this write. `acceptTransfer`
   * re-reads and re-imports once when that happens, but a write arriving after that verification
   * remains possible. The receipt also records the imported note ids so a later retry can tell a
   * confirmed import from a workspace that was overwritten.
   */
  async saveAccepted(page, workspace, expectedRev, transferId, importedNoteIds = []) {
    const current = this.flags(page);
    const rev = Number.isFinite(current.rev) ? current.rev : 0;
    if (expectedRev !== null && expectedRev !== rev) {
      throw new Error(t("JN.Private.SaveConflict"));
    }
    const clean = this.#requireCurrent(workspace, { rev });
    const receipts = this.acceptedTransfers(page).filter(id => id !== transferId);
    receipts.push(transferId);
    while (receipts.length > MAX_ACCEPTED_TRANSFERS) receipts.shift();
    const notesByReceipt = this.acceptedTransferNotes(page);
    for (const id of Object.keys(notesByReceipt)) {
      if (!receipts.includes(id)) delete notesByReceipt[id];
    }
    notesByReceipt[transferId] = [...new Set(importedNoteIds.filter(id =>
      typeof id === "string" && id && id.length <= 64))];
    await page.update({
      [`flags.${MODULE_ID}.${FLAG}.workspace`]: JSON.stringify(clean),
      [`flags.${MODULE_ID}.${FLAG}.rev`]: rev + 1,
      [`flags.${MODULE_ID}.${FLAG}.acceptedTransfers`]: receipts,
      [`flags.${MODULE_ID}.${FLAG}.acceptedTransferNotes`]: notesByReceipt
    });
    return { workspace: clean, rev: rev + 1 };
  }

  /**
   * Imports a pending transfer into the recipient's private workspace.
   *
   * A recipient with only a pending offer activates that same page; otherwise an active page is
   * used, or one is created through the normal `createFor` path. The workspace save and the
   * acceptance receipt land together, then the transfer is removed. If removal fails, a retry
   * sees the receipt, confirms its imported note ids still exist, skips the import and only
   * deletes the stale pending record.
   *
   * If a stale owner save overwrites the imported notes after our save, we re-read, re-import once
   * and save with the fresh revision. If the notes are still missing, the transfer is kept and a
   * localized retry error is raised rather than reporting success or silently dropping the copy.
   * The remaining race is the unavoidable last-writer window after the final verification; this
   * is mitigation, not full CAS.
   */
  async acceptTransfer(transferId, userId) {
    const record = this.transfer(transferId);
    if (!record) throw new Error(t("JN.Transfer.Stale"));
    if (record.toUserId !== userId) throw new Error(t("JN.Transfer.NotYours"));
    const user = game.users.get(userId);
    if (!user) throw new Error(t("JN.Transfer.UserMissing"));
    let page = this.findActive(userId);
    if (!page) {
      const pending = this.findPending(userId);
      if (pending) {
        await this.accept(pending, userId);
        page = pending;
      } else {
        page = await this.createFor(user);
      }
    }
    const summary = record.summary ?? {};
    const receiptIds = this.acceptedTransferNoteIds(page, transferId);
    if (this.acceptedTransfers(page).includes(transferId)
        && (!receiptIds.length || this.workspaceHasNotes(page, receiptIds))) {
      await this.removeTransfer(transferId);
      return {
        transfer: record,
        count: Array.isArray(record.notes) ? record.notes.length : 0,
        droppedLinks: Number.isFinite(summary.droppedLinks) ? summary.droppedLinks : 0,
        droppedWaypoints: Number.isFinite(summary.droppedWaypoints) ? summary.droppedWaypoints : 0,
        alreadyAccepted: true,
        page
      };
    }

    const first = importPrivateTransfer(this.read(page), record, userId);
    // T11 replaces transfer payloads with body/layout/skin. Until then the legacy importer
    // produces old note shapes; refuse loudly rather than storing old blocks as private notes.
    this.#requireCurrent(first.workspace, { rev: this.flags(page).rev ?? 0 });
    await this.saveAccepted(
      page, first.workspace, this.flags(page).rev ?? 0, transferId, first.imported
    );
    page = this.findById(page.id) ?? page;
    let accepted = this.workspaceHasNotes(page, first.imported);
    let result = first;
    if (!accepted) {
      // A stale workspace save overwrote the imported notes. Try once more against the latest
      // page state and a fresh revision; if that still does not stick, keep the offer.
      result = importPrivateTransfer(this.read(page), record, userId);
      this.#requireCurrent(result.workspace, { rev: this.flags(page).rev ?? 0 });
      await this.saveAccepted(
        page, result.workspace, this.flags(page).rev ?? 0, transferId, result.imported
      );
      page = this.findById(page.id) ?? page;
      accepted = this.workspaceHasNotes(page, result.imported);
    }
    if (!accepted) throw new Error(t("JN.Transfer.SaveRaced"));
    await this.removeTransfer(transferId);
    return {
      transfer: record,
      count: result.imported.length,
      droppedLinks: result.droppedLinks,
      droppedWaypoints: result.droppedWaypoints,
      page
    };
  }

  async declineTransfer(transferId, userId) {
    const record = this.transfer(transferId);
    if (!record) throw new Error(t("JN.Transfer.Stale"));
    if (record.toUserId !== userId) throw new Error(t("JN.Transfer.NotYours"));
    await this.removeTransfer(transferId);
    return {
      transfer: record,
      count: Array.isArray(record.notes) ? record.notes.length : 0
    };
  }

  /** Drops every pending transfer involving a removed user; workspace pages are kept separately. */
  async pruneTransfersForUser(userId) {
    if (typeof userId !== "string" || !userId) return 0;
    const current = this.transfers();
    const removedIds = [];
    for (const [id, record] of Object.entries(current)) {
      if (record?.fromUserId === userId || record?.toUserId === userId) removedIds.push(id);
    }
    if (!removedIds.length) return 0;
    const container = this.container();
    if (!container) throw new Error(t("JN.Private.ContainerMissing"));
    const changes = {};
    for (const id of removedIds) {
      changes[`flags.${MODULE_ID}.${TRANSFERS_FLAG}.-=${id}`] = null;
    }
    await container.update(changes);
    const after = this.transfers();
    if (removedIds.some(id => Object.hasOwn(after, id))) {
      throw new Error(t("JN.Transfer.RemoveFailed"));
    }
    return removedIds.length;
  }

  defaultName(user) {
    return t("JN.Private.DefaultName", { name: user?.name ?? t("JN.Common.Unknown") });
  }

  uniqueName(base, excludeId = null) {
    const clean = String(base ?? "").trim() || t("JN.Private.DefaultName", { name: t("JN.Common.Unknown") });
    const names = new Set(this.pages()
      .filter(page => page.id !== excludeId)
      .map(page => page.name.trim().toLowerCase()));
    if (!names.has(clean.toLowerCase())) return clean;
    let suffix = 2;
    while (names.has(`${clean} ${suffix}`.toLowerCase())) suffix++;
    return `${clean} ${suffix}`;
  }

  async createFor(user) {
    if (!user) throw new Error(t("JN.Private.UserMissing"));
    const existing = this.findActive(user.id) ?? this.findPending(user.id);
    if (existing) return existing;
    const container = this.container();
    if (!container) throw new Error(t("JN.Private.ContainerMissing"));
    const name = this.uniqueName(this.defaultName(user)).slice(0, MAX_NAME_LENGTH);
    return JournalEntryPage.create({
      name,
      type: PRIVATE_TYPE,
      system: {},
      ownership: { default: NONE(), [user.id]: OWNER() },
      flags: {
        [MODULE_ID]: {
          [FLAG]: {
            ownerUserId: user.id, pendingOwnerUserId: null, state: "active", rev: 0,
            workspace: JSON.stringify(emptyWorkspace())
          }
        }
      }
    }, { parent: container });
  }

  /**
   * CAS write of a validated current workspace. Anything older than format 3 or carrying a
   * non-v2 note is rejected before the document update, so old data can never be silently
   * replaced by an empty v2 workspace.
   */
  async save(page, workspace, expectedRev = null) {
    const current = this.flags(page);
    const rev = Number.isFinite(current.rev) ? current.rev : 0;
    if (expectedRev !== null && expectedRev !== rev) {
      throw new Error(t("JN.Private.SaveConflict"));
    }
    const clean = this.#requireCurrent(workspace, { rev });
    await page.update({
      [`flags.${MODULE_ID}.${FLAG}.workspace`]: JSON.stringify(clean),
      [`flags.${MODULE_ID}.${FLAG}.rev`]: rev + 1
    });
    return { workspace: clean, rev: rev + 1 };
  }

  async rename(page, name) {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error(t("JN.Private.NameEmpty"));
    if (clean.length > MAX_NAME_LENGTH) throw new Error(t("JN.Private.NameTooLong", { max: MAX_NAME_LENGTH }));
    if (this.pages().some(other => other.id !== page.id
        && other.name.trim().toLowerCase() === clean.toLowerCase())) {
      throw new Error(t("JN.Private.NameTaken"));
    }
    await page.update({ name: clean });
    return clean;
  }

  async assign(page, userId) {
    const state = this.state(page);
    if (state === "active" || this.ownerId(page)) throw new Error(t("JN.Private.DetachFirst"));
    const target = game.users.get(userId);
    if (!target) throw new Error(t("JN.Private.UserMissing"));
    if (this.findActive(userId) || this.findPending(userId)) throw new Error(t("JN.Private.AlreadyHas"));
    await page.update({
      [`flags.${MODULE_ID}.${FLAG}.ownerUserId`]: null,
      [`flags.${MODULE_ID}.${FLAG}.pendingOwnerUserId`]: userId,
      [`flags.${MODULE_ID}.${FLAG}.state`]: "pending"
    });
  }

  async detach(page) {
    await page.update({
      [`flags.${MODULE_ID}.${FLAG}.ownerUserId`]: null,
      [`flags.${MODULE_ID}.${FLAG}.pendingOwnerUserId`]: null,
      [`flags.${MODULE_ID}.${FLAG}.state`]: "orphaned",
      ownership: { default: NONE() }
    });
  }

  async accept(page, userId) {
    if (this.flags(page).pendingOwnerUserId !== userId) throw new Error(t("JN.Private.NotYours"));
    if (this.findActive(userId)) throw new Error(t("JN.Private.AlreadyHas"));
    await page.update({
      [`flags.${MODULE_ID}.${FLAG}.ownerUserId`]: userId,
      [`flags.${MODULE_ID}.${FLAG}.pendingOwnerUserId`]: null,
      [`flags.${MODULE_ID}.${FLAG}.state`]: "active",
      ownership: { default: NONE(), [userId]: OWNER() }
    });
  }

  async decline(page, userId) {
    if (this.flags(page).pendingOwnerUserId !== userId) throw new Error(t("JN.Private.NotYours"));
    await page.update({
      [`flags.${MODULE_ID}.${FLAG}.pendingOwnerUserId`]: null,
      [`flags.${MODULE_ID}.${FLAG}.state`]: "orphaned"
    });
  }

  async remove(page) {
    await page.delete();
  }

  /** Keeps the workspace when a user disappears, but marks it ready for admin reassignment. */
  async orphanUser(userId) {
    const affected = this.pages().filter(page =>
      this.ownerId(page) === userId || this.flags(page).pendingOwnerUserId === userId);
    for (const page of affected) {
      await page.update({
        [`flags.${MODULE_ID}.${FLAG}.ownerUserId`]: null,
        [`flags.${MODULE_ID}.${FLAG}.pendingOwnerUserId`]: null,
        [`flags.${MODULE_ID}.${FLAG}.state`]: "orphaned",
        ownership: { default: NONE() }
      });
    }
    // A removed user must not leave an undeliverable copy in someone's pending inbox.
    await this.pruneTransfersForUser(userId);
    return affected.length;
  }

  /** Repairs workspaces whose owner was removed while this GM was offline. */
  async orphanMissingUsers() {
    const existing = new Set([...game.users].map(user => user.id));
    const missing = new Set();
    for (const page of this.pages()) {
      const owner = this.ownerId(page);
      const pending = this.flags(page).pendingOwnerUserId;
      if (owner && !existing.has(owner)) missing.add(owner);
      if (pending && !existing.has(pending)) missing.add(pending);
    }
    for (const record of Object.values(this.transfers())) {
      if (typeof record?.fromUserId === "string" && !existing.has(record.fromUserId)) {
        missing.add(record.fromUserId);
      }
      if (typeof record?.toUserId === "string" && !existing.has(record.toUserId)) {
        missing.add(record.toUserId);
      }
    }
    let count = 0;
    for (const userId of missing) count += await this.orphanUser(userId);
    return count;
  }

  /**
   * v2 note view for the canvas. `name` is derived from the body on read and never stored.
   * Legacy secrecy/type/hint fields are absent by construction.
   */
  noteView(page, note) {
    const id = note.id;
    return {
      _id: id,
      id,
      name: deriveNoteName(note),
      system: {
        schemaVersion: NOTE_SCHEMA_VERSION,
        body: note.body,
        revision: note.revision,
        layout: note.layout,
        skin: resolveSkin(note.skin),
        attachment: resolveAttachment({ attachment: note.attachment }),
        links: (note.links ?? []).map(link => clone(link)),
        authorId: typeof note.authorId === "string" ? note.authorId : (this.ownerId(page) || ""),
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        deleted: note.deleted ?? null,
        lastSave: note.lastSave ? clone(note.lastSave) : null
      }
    };
  }

  noteViews(page, workspace = undefined) {
    const data = workspace === undefined ? this.read(page) : workspace;
    return Object.values(data.notes).map(note => this.noteView(page, note));
  }

  // --- Workspace-local recovery history ------------------------------------------------

  /** Newest-first private history for a note. Legacy workspaces read as `[]`. */
  listHistory(page, noteId) {
    const status = this.inspectWorkspace(page);
    if (!status.ok) return [];
    return privateHistoryList(status.workspace, noteId);
  }

  /**
   * Appends one history snapshot in its own workspace update. Prefer the private transport's
   * combined body+history write when a note body changes; this method is for explicit captures.
   */
  async recordHistory(page, noteId, entry, { expectedRev = null } = {}) {
    const status = this.#inspectOrThrow(page);
    const result = appendPrivateSnapshot(status.workspace, noteId, entry);
    if (!result.recorded) {
      return { recorded: false, entry: null, workspace: status.workspace, rev: status.rev };
    }
    const saved = await this.save(page, result.workspace, expectedRev ?? status.rev);
    return { recorded: true, entry: result.entry, workspace: saved.workspace, rev: saved.rev };
  }

  /** Periodic checkpoint honoring the shared 60-second cooldown. */
  async checkpointHistoryIfDue(page, noteId, entry, { expectedRev = null, now } = {}) {
    const status = this.#inspectOrThrow(page);
    const result = checkpointPrivateHistory(status.workspace, noteId, entry, { now });
    if (!result.recorded) {
      return { recorded: false, entry: null, workspace: status.workspace, rev: status.rev };
    }
    const saved = await this.save(page, result.workspace, expectedRev ?? status.rev);
    return { recorded: true, entry: result.entry, workspace: saved.workspace, rev: saved.rev };
  }

  /** Mandatory pre-restore capture, ignoring the cooldown. */
  async recordPreRestore(page, noteId, entry, { expectedRev = null } = {}) {
    const status = this.#inspectOrThrow(page);
    const result = checkpointPrivateHistory(status.workspace, noteId, entry, {
      now: entry?.at,
      force: true
    });
    if (!result.recorded) {
      return { recorded: false, entry: null, workspace: status.workspace, rev: status.rev };
    }
    const saved = await this.save(page, result.workspace, expectedRev ?? status.rev);
    return { recorded: true, entry: result.entry, workspace: saved.workspace, rev: saved.rev };
  }

  /** Removes history only for permanently deleted notes. Trash keeps history. */
  async deleteHistory(page, noteIds, { expectedRev = null } = {}) {
    const status = this.#inspectOrThrow(page);
    const result = deletePrivateHistory(status.workspace, noteIds);
    if (!result.removed) {
      return { removed: 0, workspace: status.workspace, rev: status.rev };
    }
    const saved = await this.save(page, result.workspace, expectedRev ?? status.rev);
    return { removed: result.removed, workspace: saved.workspace, rev: saved.rev };
  }

  // --- Placement and creation -----------------------------------------------------------

  /**
   * Placement helper for the private canvas. Uses v2 `sizing` for existing cards and
   * rotated world-space bounds for every box, matching the board placement rule.
   */
  findFreeSpot(cards, w, h, nearX, nearY, rotation = 0, notes = null) {
    const width = positive(w) ?? getLayout("plain").widths[0];
    const height = positive(h) ?? getLayout("plain").minHeight;
    const originX = finite(nearX) ? nearX : 0;
    const originY = finite(nearY) ? nearY : 0;
    const existing = Object.entries(cards ?? {})
      .filter(([, card]) => card && finite(card.x) && finite(card.y))
      .map(([id, card]) => rotatedCardBounds(card, notes?.[id]));
    for (let radius = 0; radius < 40; radius++) {
      for (let step = 0; step < 8; step += 1) {
        const x = originX + Math.cos(step * 0.785) * radius * PLACEMENT_STEP;
        const y = originY + Math.sin(step * 0.785) * radius * PLACEMENT_STEP;
        const candidate = rotatedCardBounds({ x, y, sizing: {
          mode: "manual", width, minHeight: height
        } });
        if (!existing.some(bounds => boundsOverlap(candidate, bounds))) return { x, y };
      }
    }
    return { x: originX, y: originY };
  }

  /**
   * Builds a fresh v2 private note and card. Body is the only content authority: title,
   * layout presentation and portrait are derived on read. Skins seed deterministic tilt.
   */
  makeNote({ body = "", layout = "plain", skin = null, noteId, x = 0, y = 0, cards = {}, notes = null } = {}) {
    const id = typeof noteId === "string" && noteId ? noteId : randomID();
    const resolvedLayout = isLayout(layout) ? layout : "plain";
    const bodyText = typeof body === "string" ? body : "";
    // No explicit skin: use the creation-template defaults (Blank -> Amber, Document ->
    // Cream, Profile -> Parchment), seeded from the note id for stable tilt.
    const templateId = resolvedLayout === "profile"
      ? "profile"
      : (/^ {0,3}#[ \t]/.test(bodyText) ? "document" : "blank");
    const resolvedSkin = skin
      ? seededSkin(resolveSkin(skin), id)
      : templateSkin(templateId, { noteId: id });
    const size = getLayout(resolvedLayout);
    const width = size.widths[0];
    const height = size.minHeight;
    const rotation = tiltForSkin(resolvedSkin);
    const spot = this.findFreeSpot(cards, width, height, x, y, rotation, notes);
    const ownerId = game.user?.id ?? "";
    const now = Date.now();
    return {
      note: {
        id,
        body: bodyText,
        revision: 0,
        layout: resolvedLayout,
        skin: resolvedSkin,
        attachment: resolveAttachment({}),
        links: [],
        authorId: ownerId,
        createdAt: now,
        updatedAt: now,
        schemaVersion: NOTE_SCHEMA_VERSION,
        deleted: null,
        lastSave: null
      },
      card: {
        x: spot.x,
        y: spot.y,
        sizing: { mode: "auto", width: null, minHeight: null },
        autoSizeOrigin: { x: spot.x + width / 2, y: spot.y },
        rotation,
        ports: [...DEFAULT_CARD_PORTS],
        anchors: {
          main: { kind: "main", x: 0.5, y: 0, createdBy: ownerId }
        }
      }
    };
  }
}

export const privateStore = new PrivateStore();
export {
  MAX_NAME_LENGTH, MAX_TITLE_LENGTH, MAX_PENDING_TRANSFERS, MAX_PENDING_PER_SENDER,
  MAX_TRANSFER_STORAGE, MAX_ACCEPTED_TRANSFERS, TRANSFER_TTL_MS
};
