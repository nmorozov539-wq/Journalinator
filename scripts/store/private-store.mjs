import { getContainerIds } from "./containers.mjs";
import { CARD_STYLES, seedTilt } from "../styles/registry.mjs";
import {
  CARD_SIDES, DEFAULT_CARD_PORTS, MAX_THREAD_PINS, validCardPorts, validLinkPoint, validThreadPin
} from "../card-ports.mjs";
import { normalizeLinkColor } from "../link-colors.mjs";
import { validAnchorId } from "../anchors.mjs";
import { resolvePin, validPinPosition } from "../board-pins.mjs";
import { DEFAULT_STAMP_CORNER, STAMP_COLORS, isStampCorner, stampUrl } from "../stamps.mjs";
import {
  resolveAttachment, resolveLinkCosmetics, resolvePresentation, sanitizeCardAnchorsWithMain
} from "../presentation.mjs";
import { t } from "../i18n.mjs";
import {
  MAX_TRANSFER_NOTES, MAX_TRANSFER_TEXT, importPrivateTransfer, defaultCardSize,
  findFreeSpot as findPrivateFreeSpot
} from "../private-transfer.mjs";

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
const WORKSPACE_FORMAT = 2;
const NOTE_SCHEMA_VERSION = 1;

const randomID = () => foundry.utils.randomID();
const NONE = () => CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
const OWNER = () => CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;

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
    trash: []
  };
}

function normalizeBlock(block) {
  const clean = {
    blockId: typeof block?.blockId === "string" && block.blockId ? block.blockId : randomID(),
    text: typeof block?.text === "string" ? block.text : ""
  };
  if (typeof block?.authorId === "string") clean.authorId = block.authorId;
  return clean;
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
    hint: false,
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

function normalizeCard(card, mainPinEnabled = true) {
  if (!Number.isFinite(card?.x) || !Number.isFinite(card?.y)) return null;
  return {
    x: card.x,
    y: card.y,
    width: Number.isFinite(card.width) && card.width > 0 ? card.width : null,
    height: Number.isFinite(card.height) && card.height > 0 ? card.height : null,
    rotation: Number.isFinite(card.rotation) ? card.rotation : 0,
    ports: validCardPorts(card.ports) ? [...card.ports] : [...DEFAULT_CARD_PORTS],
    anchors: normalizeAnchors(card.anchors, mainPinEnabled)
  };
}

function normalizeLabel(label) {
  const stamp = typeof label?.stamp === "string" && stampUrl(label.stamp) ? label.stamp : "";
  const color = Object.values(STAMP_COLORS).includes(label?.color) ? label.color : "";
  return {
    text: typeof label?.text === "string" ? label.text.slice(0, 500) : "",
    x: Number.isFinite(label?.x) ? label.x : 0,
    y: Number.isFinite(label?.y) ? label.y : 0,
    size: Number.isFinite(label?.size) ? label.size : 14,
    color,
    stamp,
    noteId: typeof label?.noteId === "string" ? label.noteId : "",
    corner: isStampCorner(label?.corner) ? label.corner : DEFAULT_STAMP_CORNER
  };
}

function noteSchema(note, title) {
  const stored = note?.presentation && typeof note.presentation === "object" ? note.presentation : {};
  const presentation = resolvePresentation({
    name: title,
    system: {
      style: note?.style,
      targetHeading: note?.targetHeading,
      label: note?.label,
      presentation: stored
    }
  });
  const hasLabel = typeof note?.label === "string";
  const { label: _ignored, ...presentationFields } = presentation;
  return {
    schemaVersion: Number.isInteger(note?.schemaVersion) && note.schemaVersion > 0
      ? note.schemaVersion : NOTE_SCHEMA_VERSION,
    label: hasLabel
      ? note.label.slice(0, MAX_TITLE_LENGTH)
      : (presentation.nameGenerated ? "" : title.slice(0, MAX_TITLE_LENGTH)),
    presentation: presentationFields,
    attachment: resolveAttachment({ system: { attachment: note?.attachment } })
  };
}

function normalizeNote(note) {
  const style = Object.hasOwn(CARD_STYLES, note?.style) ? note.style : "sticky";
  const kind = note?.kind === "location" ? "location" : "note";
  const title = typeof note?.title === "string" ? note.title.slice(0, MAX_TITLE_LENGTH) : "";
  return {
    id: typeof note?.id === "string" && note.id ? note.id : randomID(),
    title,
    kind,
    style,
    targetHeading: typeof note?.targetHeading === "string" ? note.targetHeading.slice(0, 80) : "",
    ...noteSchema(note, title),
    image: typeof note?.image === "string" ? note.image : null,
    backgroundImage: typeof note?.backgroundImage === "string" ? note.backgroundImage : null,
    blocks: Array.isArray(note?.blocks) && note.blocks.length
      ? note.blocks.map(normalizeBlock)
      : [{ blockId: randomID(), text: "" }],
    links: (Array.isArray(note?.links) ? note.links : []).map(normalizeLink),
    createdAt: Number.isFinite(note?.createdAt) ? note.createdAt : Date.now(),
    updatedAt: Number.isFinite(note?.updatedAt) ? note.updatedAt : Date.now()
  };
}

function normalizeViewport(viewport) {
  if (!viewport || typeof viewport !== "object") return null;
  return {
    x: Number.isFinite(viewport.x) ? viewport.x : 0,
    y: Number.isFinite(viewport.y) ? viewport.y : 0,
    zoom: Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
  };
}

export function normalizeWorkspace(input) {
  const source = input && typeof input === "object" ? input : {};
  // Formats 1 and 2 share this reader; the normalized result is always format 2.
  const notes = {};
  for (const [id, note] of Object.entries(source.notes && typeof source.notes === "object" ? source.notes : {})) {
    const clean = normalizeNote({ ...note, id });
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
  const boxes = new Map(Object.entries(cards).map(([id, card]) => [id, {
    ...card, w: card.width ?? 190, h: card.height ?? 90
  }]));
  for (const [id, link] of Object.entries(source.layout?.pinLinks ?? {})) {
    if (!validAnchorId(id) || typeof link?.source !== "string"
        || typeof link?.target !== "string" || link.source === link.target) continue;
    if (resolvePin(link.source, pinLayout, boxes) && resolvePin(link.target, pinLayout, boxes)) {
      pinLinks[id] = { source: link.source, target: link.target };
    }
  }
  const trash = (Array.isArray(source.trash) ? source.trash : []).map(entry => {
    // A trash card without its note must not invent a main anchor: there is no attachment block
    // to tell us whether the note wanted one.
    const hasNote = !!entry?.note && typeof entry.note === "object" && !Array.isArray(entry.note);
    const note = normalizeNote(entry?.note);
    return {
      note,
      card: normalizeCard(entry?.card, hasNote ? resolveAttachment(note).mainPinEnabled : false),
      deletedAt: Number.isFinite(entry?.deletedAt) ? entry.deletedAt : Date.now(),
      undoId: typeof entry?.undoId === "string" ? entry.undoId : null
    };
  });
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
    trash
  };
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

  read(page) {
    const privateFlag = page?.flags?.[MODULE_ID]?.[FLAG] ?? {};
    const raw = privateFlag.workspace ?? page?.system?.workspace;
    let value = raw;
    if (typeof raw === "string") {
      try { value = JSON.parse(raw); } catch { value = null; }
    }
    return normalizeWorkspace(value);
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
      totalText += (Array.isArray(entry.note.blocks) ? entry.note.blocks : [])
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
      titles: notes.map(entry => String(entry.note.title ?? "").slice(0, MAX_TITLE_LENGTH)),
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
    const clean = normalizeWorkspace(workspace);
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

  async save(page, workspace, expectedRev = null) {
    const current = this.flags(page);
    const rev = Number.isFinite(current.rev) ? current.rev : 0;
    if (expectedRev !== null && expectedRev !== rev) {
      throw new Error(t("JN.Private.SaveConflict"));
    }
    const clean = normalizeWorkspace(workspace);
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

  noteView(page, note) {
    const ownerId = this.ownerId(page) || "";
    return {
      _id: note.id,
      id: note.id,
      name: note.title,
      secret: false,
      system: {
        kind: note.kind,
        style: note.style,
        targetHeading: note.targetHeading,
        schemaVersion: note.schemaVersion,
        label: note.label,
        presentation: note.presentation,
        attachment: note.attachment,
        image: note.image,
        backgroundImage: note.backgroundImage,
        blocks: note.blocks,
        links: note.links ?? [],
        authorId: ownerId,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        editCount: 0,
        contributions: {},
        hint: false,
        formerNames: [],
        deleted: null
      }
    };
  }

  noteViews(page, workspace = this.read(page)) {
    return Object.values(workspace.notes).map(note => this.noteView(page, note));
  }

  /**
   * Placement helper for the private canvas. Delegates to the transfer helper so both paths use
   * rotated AABBs and conservative style defaults for null (auto-sized) cards.
   */
  findFreeSpot(cards, w, h, nearX, nearY, rotation = 0, notes = null) {
    return findPrivateFreeSpot(cards, w, h, nearX, nearY, rotation, { notes });
  }

  makeNote({ title, kind = "note", style = "sticky", x = 0, y = 0, cards, notes = null }) {
    const resolvedStyle = Object.hasOwn(CARD_STYLES, style) ? style : "sticky";
    const resolvedKind = kind === "location" ? "location" : "note";
    const size = defaultCardSize(resolvedStyle);
    const spot = this.findFreeSpot(cards, size.width, size.height, x, y, 0, notes);
    const cleanTitle = String(title ?? "").trim().slice(0, MAX_TITLE_LENGTH);
    const storedTitle = cleanTitle || t("JN.Private.NewNoteTitle");
    const schema = noteSchema({ style: resolvedStyle }, storedTitle);
    const ownerId = game.user?.id ?? "";
    return {
      note: {
        id: randomID(),
        title: storedTitle,
        kind: resolvedKind,
        style: resolvedStyle,
        targetHeading: "",
        ...schema,
        image: null,
        backgroundImage: null,
        blocks: [{ blockId: randomID(), text: "" }],
        links: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      card: {
        x: spot.x,
        y: spot.y,
        width: null,
        height: null,
        rotation: seedTilt(resolvedStyle),
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
