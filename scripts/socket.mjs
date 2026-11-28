import { getContainerIds } from "./store/containers.mjs";
import { MAX_TRANSFER_STORAGE, privateStore } from "./store/private-store.mjs";
import {
  CARD_SIDES, cardPointAnchor, cardPorts, linkAnchors, moveThreadPin, validCardPorts, validLinkPoint
} from "./card-ports.mjs";
import {
  ANCHOR_MERGE_TOLERANCE, MAIN_ANCHOR_ID, anchorSide, anchorWorld, canonicalizeMainAnchors,
  collectAnchorRefs, defaultMainAnchor, mergeNearbyMinorAnchors, minorOnEdge, nearestMinorAnchor,
  promoteLegacyLinkAnchors, pruneAnchorRegistry, projectToEdge, redistributionAnchor, validAnchorId
} from "./anchors.mjs";
import { isLinkColor, normalizeLinkColor } from "./link-colors.mjs";
import { boardPinRef, normalizePinLink, resolvePin, validPinPosition } from "./board-pins.mjs";
import { noteImagePath } from "./image-url.mjs";
import { getLayout, isLayout } from "./layouts/registry.mjs";
import { isFont, isPaper, seededSkin, tiltForSkin } from "./skins/registry.mjs";
import { noteSchemaProblem, worldSchemaStatus } from "./store/schema-guard.mjs";
import {
  applyEditState, applyLeaseChanged, applyPreview, applyRevoked, assertUnlocked, authorityEpoch,
  authoritySnapshot, broadcastLeaseChanged, broadcastPreview, broadcastRevoked, clientSessionId,
  consumeLease, getAuthorityPreview, grantLease, heartbeat as heartbeatLease, initializeAuthority,
  isLeaseValid, leaseFor, noteBodyHash, releaseLease, setAuthorityRevision, setPreview
} from "./edit-session.mjs";
import { t } from "./i18n.mjs";
import {
  MAX_TRANSFER_NOTES, MAX_TRANSFER_TEXT, buildPrivateTransfer, buildSharedTransfer, importPrivateTransfer
} from "./private-transfer.mjs";
import { attachedStampIds, DEFAULT_STAMP_CORNER, isStampCorner, stampUrl } from "./stamps.mjs";
import {
  LINK_ENDS, LINK_MATERIALS, LINK_PATTERNS, LINK_SLACK, LINK_THICKNESS,
  MAIN_PIN, MAX_CARD_ANCHORS, PIN_STYLES,
  defaultLinkCosmetics, resolveAttachment, sanitizeCardAnchors
} from "./presentation.mjs";
import {
  MAX_ROUTE_ANCHORS, ROUTE_UNDO_LIMIT, endpointFields, hasBoardPins, hasRouteWaypoints,
  insertRouteWaypoint, removeRouteWaypointsFor, splitLinkPair
} from "./route-notes.mjs";

export { sanitizeCardAnchors };

const MODULE_ID = "fvtt-journalinator";
const CHANNEL = `module.${MODULE_ID}`;
const MAX_LABEL_LENGTH = 200;
const MAX_LABEL_TEXT_LENGTH = 500;
const MAX_NOTE_BODY_LENGTH = 200000;
const MAX_COORDINATE = 1000000;
const MIN_LABEL_SIZE = 8;
const MAX_LABEL_SIZE = 96;
const LINK_DIRECTIONS = new Set(["none", "one", "two"]);
const LINK_LINE_STYLES = new Set(["solid", "dashed"]);
const LINK_MATERIAL_SET = new Set(LINK_MATERIALS);
const LINK_PATTERN_SET = new Set(LINK_PATTERNS);
const LINK_END_SET = new Set(LINK_ENDS);
const PIN_STYLE_SET = new Set(PIN_STYLES);
// `mainPinEnabled` is deliberately absent: the generic attachment batch path must never bypass
// destructive main-pin redistribution. Shared enabling/disabling goes through setMainPinEnabled.
const ATTACHMENT_KEYS = new Set(["mainSnapRadius", "minorSnapRadius", "pinStyle"]);
const DOCUMENT_ID_RE = /^[a-zA-Z0-9]{16}$/;
const MAX_NOTE_BATCH = 50;
const MAX_ANCHOR_ID_LENGTH = 100;
const MAX_REQUEST_ID_LENGTH = 100;
const MAX_SESSION_ID_LENGTH = 100;
const MAX_EVENT_IDS = 32;
const SIZING_WIDTH_MIN = 160;
const SIZING_WIDTH_MAX = 800;
const SIZING_MIN_HEIGHT_MIN = 80;
const SIZING_MIN_HEIGHT_MAX = 1600;
const SKIN_KEYS = new Set(["paper", "font", "torn", "backgroundImage", "tiltSeed"]);
const GEOMETRY_KEYS = new Set(["sizing", "autoSizeOrigin", "x", "y"]);
const SIZING_KEYS = new Set(["mode", "width", "minHeight"]);
const ORIGIN_KEYS = new Set(["x", "y"]);
const PIN_UNDO_LIMIT = 20;
const PIN_REDISTRIBUTION_SNAP = 12;

/** Mutating whole-note protocol commands; all serialized through the GM write queue. */
const EDIT_COMMAND_TYPES = new Set([
  "createNote", "beginNoteEdit", "noteEditHeartbeat", "previewNoteBody", "saveNoteBody",
  "saveNoteAppearance", "endNoteEdit", "forceUnlockNote", "requestNoteEditState"
]);

/** Targeted reply types resolved by `requestEditReply` before the GM-only gate. */
const EDIT_REPLY_TYPES = new Set([
  "noteCreated", "noteCreateRejected", "noteEditGranted", "noteEditDenied",
  "noteEditHeartbeatAck", "noteSaveAck", "noteSaveRejected", "noteAppearanceAck",
  "noteAppearanceRejected", "noteEditEnded", "noteEditForced", "noteEditState"
]);

const pendingEditReplies = new Map();

/**
 * In-memory, per-active-GM undo register for one atomic main-pin redistribution.
 *
 * Phase 5 limitation: undo is active-GM state only, in-memory, capped at PIN_UNDO_LIMIT and lost
 * on failover/reload. Each entry stores post-operation fingerprints; an undo whose affected
 * links/attachments/anchors changed afterwards is refused (JN.Pin.UndoStale) instead of
 * clobbering newer edits.
 */
const pinUndoEntries = new Map();

/**
 * In-memory, per-active-GM undo register for one Phase-6 route operation (A insertion or B split).
 *
 * Same Phase-5 limitation: entries live only on the active GM, are capped, and disappear on
 * failover/reload. Each entry stores the raw link arrays before the operation plus fingerprints of
 * what the operation wrote. An undo is refused (JN.Route.UndoStale) when either page's links no
 * longer match, so a later edit/label change cannot be clobbered by a stale Ctrl+Z.
 */
const routeUndoEntries = new Map();

function pinsEnabled() {
  return game.settings.get(MODULE_ID, "pinsEnabled") !== false;
}

function deepClone(value) {
  return typeof foundry.utils.deepClone === "function"
    ? foundry.utils.deepClone(value)
    : structuredClone(value);
}

function senderIsGM(senderUserId) {
  return !!game.users.get(senderUserId)?.isGM;
}

/**
 * All GM-side write handling is serialized through this promise chain. Socket handlers are
 * async, so without it two messages can both read `page.system.blocks`/`links` before either
 * update lands, and the second whole-array write clobbers the first player's change. This is
 * what makes the spec's "the GM serializes writes" assumption true.
 */
let writeQueue = Promise.resolve();
let offlineNoticeAt = 0;

function enqueueWrite(message, senderUserId) {
  const task = writeQueue
    .then(() => {
      // A job can outlive the sender's active-GM status during a failover. Dropping it is
      // safer than letting a former GM apply world writes after the new GM takes over.
      if (game.users.activeGM?.id !== game.user.id) return null;
      return handleMessage(message, senderUserId);
    })
    .catch(err => {
      console.error("Journalinator: write failed", err);
      return null;
    });
  writeQueue = task.then(() => undefined, () => undefined);
  return task;
}

/** Tell the user once in a while why their edit did not apply while the board is read-only. */
function warnNoGM() {
  const now = Date.now();
  if (now - offlineNoticeAt < 5000) return;
  offlineNoticeAt = now;
  ui.notifications?.warn(t("JN.TopBar.Offline"));
}


/** Shows a rejection to the requesting user. Socket broadcasts don't echo to the sender. */
function notifyUser(userId, reason) {
  if (!userId) return;
  const text = reason.startsWith("Journalinator:") ? reason : `Journalinator: ${reason}`;
  if (userId === game.user.id) {
    ui.notifications?.warn(text);
    return;
  }
  // Addressed to the requester only: rejection reasons can name titles (e.g. a declassified
  // note's title that collided), which must not reach other clients.
  game.socket.emit(CHANNEL, { type: "writeRejected", forUserId: userId, reason: text }, { recipients: [userId] });
}

/**
 * Tells the requesting client that a write actually landed. A client must not push an undo entry
 * for a request that was rejected or rolled back, otherwise Ctrl+Z would silently consume a stale
 * operation. The active GM is the only sender of this acknowledgement.
 */
function acknowledgeWriteApplied(userId, payload) {
  if (!userId) return;
  const message = { type: "writeApplied", forUserId: userId, ...payload };
  if (userId === game.user.id) {
    Hooks.callAll("journalinatorWriteApplied", message);
    return;
  }
  game.socket.emit(CHANNEL, message, { recipients: [userId] });
}

/**
 * Captures the raw stored attachment, including the difference between absent and `null`.
 * `_source` is the pre-schema data; `system.attachment` would already have the schema's `{}`
 * default in a real Foundry document, which is exactly what must not be written back on undo.
 */
function rawAttachmentState(notePage) {
  const system = notePage?._source?.system ?? notePage?.system ?? {};
  const present = Object.hasOwn(system, "attachment");
  return {
    attachment: present ? deepClone(system.attachment) : undefined,
    attachmentPresent: present
  };
}

/** Update payload that restores an attachment exactly, including removing an absent key. */
function attachmentRestoreChanges(state, current) {
  if (!state.attachmentPresent) return { "system.-=attachment": null };
  return objectRestoreChanges("system.attachment", current, state.attachment);
}

/**
 * Restores a plain object exactly under Foundry's recursive-merge update semantics: keys added
 * since `current` are deleted explicitly before the captured value is merged back in.
 */
function objectRestoreChanges(prefix, current, target) {
  const changes = {};
  const next = target && typeof target === "object" ? target : {};
  for (const key of Object.keys(current ?? {})) {
    if (validAnchorId(key) && !Object.hasOwn(next, key)) changes[`${prefix}.-=${key}`] = null;
  }
  changes[prefix] = deepClone(target);
  return changes;
}

/** Exact registry restore, with deletion markers for anchors created after the snapshot. */
function anchorRestoreChanges(noteId, current, target) {
  return objectRestoreChanges(`system.cards.${noteId}.anchors`, current, target ?? {});
}

/**
 * Keeps only the cosmetic/endpoint fields a link editor is allowed to change, with validated
 * values. Colors accept "" (default), the three slot keys, or the three legacy hexes. In every
 * accepted case the stored value is a slot key, so newly written data never carries a hex.
 * Route waypoints are deliberately not here: `updateLink` must not accept client route changes
 * until the phase-6 transactional operation exists.
 *
 * `anchorContext` is optional: `{ source, target }` are the anchor registries of the source and
 * target cards. When supplied (as `updateLink` does), a non-empty anchor id must exist in the
 * matching registry; `""` clears a reference. An unknown id rejects the whole patch.
 */
export function sanitizeLinkFields(fields, anchorContext = null) {
  if (!fields || typeof fields !== "object") return null;
  const clean = {};
  if (typeof fields.label === "string") clean.label = fields.label.slice(0, MAX_LABEL_LENGTH);
  if (LINK_DIRECTIONS.has(fields.direction)) clean.direction = fields.direction;
  if (isLinkColor(fields.color)) clean.color = normalizeLinkColor(fields.color);
  if (LINK_LINE_STYLES.has(fields.lineStyle)) clean.lineStyle = fields.lineStyle;
  if (LINK_MATERIAL_SET.has(fields.material)) clean.material = fields.material;
  if (Number.isFinite(fields.thickness)) {
    clean.thickness = Math.min(LINK_THICKNESS.max, Math.max(LINK_THICKNESS.min, fields.thickness));
  }
  if (Number.isFinite(fields.slack)) {
    clean.slack = Math.min(LINK_SLACK.max, Math.max(LINK_SLACK.min, fields.slack));
  }
  if (LINK_PATTERN_SET.has(fields.pattern)) clean.pattern = fields.pattern;
  if (LINK_END_SET.has(fields.ends)) clean.ends = fields.ends;
  if (typeof fields.secondaryColor === "string") {
    // A bad secondary color degrades to "no secondary dye", while a bad primary color is rejected.
    clean.secondaryColor = isLinkColor(fields.secondaryColor)
      ? normalizeLinkColor(fields.secondaryColor) : "";
  }
  for (const [key, registry] of [
    ["sourceAnchorId", anchorContext?.source],
    ["targetAnchorId", anchorContext?.target]
  ]) {
    if (!(key in fields)) continue;
    const value = fields[key];
    if (typeof value !== "string") return null;
    if (value !== "" && !validAnchorId(value)) return null;
    if (value !== "" && anchorContext && !(registry && Object.hasOwn(registry, value) && registry[value])) {
      return null;
    }
    clean[key] = value;
  }
  return Object.keys(clean).length ? clean : null;
}

/** True when `id` names an own anchor on the given card registry (main included). */
function cardHasAnchor(card, id) {
  return validAnchorId(id) && !!card?.anchors && Object.hasOwn(card.anchors, id)
    && !!card.anchors[id];
}

/** Own, validated anchor lookup. Never follows `constructor`/`__proto__` or dotted paths. */
function cardAnchor(card, id) {
  return cardHasAnchor(card, id) ? card.anchors[id] : null;
}

/**
 * Attachment patches use the same reject-unknown rule; radii are clamped to their bounds.
 * `mainPinEnabled` is rejected here on purpose: it has a destructive, undoable operation of its
 * own and must not be toggled through the non-transactional generic path.
 */
export function sanitizeAttachmentFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  if (Object.keys(fields).some(key => !ATTACHMENT_KEYS.has(key))) return null;
  const clean = {};
  if ("mainSnapRadius" in fields) {
    if (!Number.isFinite(fields.mainSnapRadius)) return null;
    clean.mainSnapRadius = Math.min(64, Math.max(0, fields.mainSnapRadius));
  }
  if ("minorSnapRadius" in fields) {
    if (!Number.isFinite(fields.minorSnapRadius)) return null;
    clean.minorSnapRadius = Math.min(32, Math.max(0, fields.minorSnapRadius));
  }
  if ("pinStyle" in fields) {
    if (!PIN_STYLE_SET.has(fields.pinStyle)) return null;
    clean.pinStyle = fields.pinStyle;
  }
  return Object.keys(clean).length ? clean : null;
}

/**
 * Validates the note-local anchor waypoints of a routed thread. Route changes are not accepted by
 * `updateLink` yet; phase 6 adds the dedicated transactional operation. Creation paths still
 * schema-validate the array so no unvalidated route data can enter a new link.
 */
export function sanitizeRouteAnchors(value) {
  if (!Array.isArray(value) || value.length > MAX_ROUTE_ANCHORS) return null;
  const anchors = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (typeof entry.noteId !== "string" || !DOCUMENT_ID_RE.test(entry.noteId)) return null;
    if (!validAnchorId(entry.anchorId)) return null;
    anchors.push({ noteId: entry.noteId, anchorId: entry.anchorId });
  }
  return anchors;
}

/** Returns `{ routeAnchors }` only when the field is present and valid. */
export function sanitizeLinkRouteFields(fields) {
  if (!fields || typeof fields !== "object" || !("routeAnchors" in fields)) return null;
  const routeAnchors = sanitizeRouteAnchors(fields.routeAnchors);
  return routeAnchors ? { routeAnchors } : null;
}

/**
 * Route waypoints are safe to publish only when they point at the note itself or another live
 * shared note. A waypoint that names a still-secret note is dropped: publishing its id would let
 * players learn that a hidden note exists even though the note's content stays in the vault.
 */
export function sanitizeSharedRouteAnchors(shared, value, selfId) {
  if (!Array.isArray(value)) return [];
  const anchors = [];
  for (const entry of value) {
    if (anchors.length >= MAX_ROUTE_ANCHORS) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (typeof entry.noteId !== "string" || !entry.noteId) continue;
    if (!validAnchorId(entry.anchorId)) continue;
    if (entry.noteId !== selfId) {
      const page = shared?.pages?.get?.(entry.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) continue;
    }
    anchors.push({ noteId: entry.noteId, anchorId: entry.anchorId });
  }
  return anchors;
}

/**
 * Canonicalizes a copied registry and stamps the main anchor's creator from the trusted note
 * author/sender. Copied minor anchors may keep their original creator; only the main pin is
 * derived from the destination context, so a client cannot spoof its colour/identity.
 */
function addMainAnchor(anchors, authorId) {
  const clean = sanitizeCardAnchors(anchors);
  clean.main = defaultMainAnchor(typeof authorId === "string" ? authorId : "");
  if (Object.keys(clean).length > MAX_CARD_ANCHORS) {
    const overflow = Object.keys(clean).length - MAX_CARD_ANCHORS;
    for (const id of Object.keys(clean).filter(id => id !== MAIN_ANCHOR_ID).slice(0, overflow)) {
      delete clean[id];
    }
  }
  return clean;
}

/** All requested ids must be live shared notes; nothing is written if one is missing/secret. */
function liveSharedNotePages(shared, noteIds) {
  if (!Array.isArray(noteIds) || !noteIds.length || noteIds.length > MAX_NOTE_BATCH) return null;
  const pages = [];
  for (const noteId of noteIds) {
    if (typeof noteId !== "string") return null;
    const page = shared.pages.get(noteId);
    if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return null;
    pages.push(page);
  }
  return pages;
}

/** Every live shared note page, in deterministic document order. */
function liveSharedNoteList(shared) {
  return [...(shared?.pages?.values?.() ?? [])]
    .filter(page => page.type === `${MODULE_ID}.note` && !page.system.deleted);
}

/**
 * Every shared note page, including soft-deleted/trashed ones. Reference *collection* must see
 * trashed links too: restoring a note brings its links back, so their anchors cannot be pruned.
 * Layout writes still target live cards only.
 */
function allSharedNoteList(shared) {
  return [...(shared?.pages?.values?.() ?? [])]
    .filter(page => page.type === `${MODULE_ID}.note`);
}

function isLiveSharedNotePage(page) {
  return !!page && page.type === `${MODULE_ID}.note` && !page.system.deleted;
}

/**
 * Layout card plus fallback dimensions for pin/thread projection.
 *
 * T10 owns full measured geometry. Until then this reads the v2 manual sizing override,
 * the legacy stored width/height when present, and otherwise the smallest Plain card.
 */
function cardBox(note, card) {
  const manualWidth = card?.sizing?.mode === "manual" ? card.sizing.width : null;
  const manualHeight = card?.sizing?.mode === "manual" ? card.sizing.minHeight : null;
  const width = Number.isFinite(manualWidth) && manualWidth > 0
    ? manualWidth
    : Number.isFinite(card?.width) && card.width > 0 ? card.width : 220;
  const height = Number.isFinite(manualHeight) && manualHeight > 0
    ? manualHeight
    : Number.isFinite(card?.height) && card.height > 0 ? card.height : 120;
  return {
    x: Number.isFinite(card?.x) ? card.x : 0,
    y: Number.isFinite(card?.y) ? card.y : 0,
    w: width,
    h: height,
    rotation: Number.isFinite(card?.rotation) ? card.rotation : 0
  };
}

/**
 * Optional client measurement for projection. Only w/h are accepted; values are clamped so a
 * hostile payload cannot collapse or explode the redistribution geometry. x/y/rotation are never
 * taken from the client.
 */
export function sanitizeProjectionBox(box) {
  if (!box || typeof box !== "object" || Array.isArray(box)) return null;
  if (!Number.isFinite(box.w) || !Number.isFinite(box.h)) return null;
  return {
    w: Math.min(2000, Math.max(40, box.w)),
    h: Math.min(2000, Math.max(40, box.h))
  };
}

function freshAnchorId(anchors) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = foundry.utils.randomID();
    if (id !== MAIN_ANCHOR_ID && !Object.hasOwn(anchors ?? {}, id)) return id;
  }
  let id = foundry.utils.randomID();
  while (Object.hasOwn(anchors ?? {}, id)) id += "x";
  return id.slice(0, MAX_ANCHOR_ID_LENGTH);
}

/** A new minor pin request must be a strict normalized point. */
function cleanMinorAnchorSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  if (spec.kind !== undefined && spec.kind !== "minor") return null;
  if (!Number.isFinite(spec.x) || !Number.isFinite(spec.y)) return null;
  if (spec.x < 0 || spec.x > 1 || spec.y < 0 || spec.y > 1) return null;
  if (spec.x !== 0 && spec.x !== 1 && spec.y !== 0 && spec.y !== 1) return null;
  return { kind: "minor", x: spec.x, y: spec.y };
}

/**
 * Resolves one link endpoint. Returns `undefined` when the message has no endpoint field,
 * `null` when the request is invalid, or `{ anchorId, anchor, created }`.
 */
function planAnchorEndpoint({ card, note, anchorId, spec, senderUserId, allowCreate }) {
  if (spec !== undefined && spec !== null) {
    if (typeof anchorId === "string" && anchorId !== "") return null;
    if (!allowCreate || !card) return null;
    const clean = cleanMinorAnchorSpec(spec);
    if (!clean) return null;
    // Reuse an existing minor at the same physical point before allocating a new id. A client
    // can legitimately send the normalized spec again when its canvas has not caught up with a
    // previous anchor write, and repeated body clicks must share one pin.
    const reuse = nearestMinorAnchor(cardBox(note, card), card.anchors ?? {}, clean,
      ANCHOR_MERGE_TOLERANCE);
    if (reuse) return { anchorId: reuse.id, anchor: reuse.anchor, created: false };
    if (Object.keys(card.anchors ?? {}).length >= MAX_CARD_ANCHORS) return null;
    return {
      anchorId: freshAnchorId(card.anchors),
      anchor: { ...clean, createdBy: senderUserId },
      created: true
    };
  }
  if (anchorId === undefined || anchorId === null) return undefined;
  if (typeof anchorId !== "string") return null;
  if (anchorId === "") return { anchorId: "", anchor: null, created: false };
  if (!cardHasAnchor(card, anchorId)) return null;
  // A hidden/disabled main pin is not an endpoint a client may newly choose. Existing links that
  // already reference it keep rendering through the normal fallback/anchor path.
  if (anchorId === MAIN_ANCHOR_ID && note && resolveAttachment(note).mainPinEnabled === false) return null;
  return { anchorId, anchor: cardAnchor(card, anchorId), created: false };
}

function applyAnchorEndpoint(fields, prefix, plan, box) {
  if (plan === undefined) return;
  fields[`${prefix}AnchorId`] = plan.anchorId;
  if (!plan.anchor) return;
  fields[`${prefix}Point`] = { x: plan.anchor.x, y: plan.anchor.y };
  const side = anchorSide(plan.anchor, box);
  if (side) fields[`${prefix}Side`] = side;
}

/** Refreshes point/side fallback for an endpoint from its current anchor, when one exists. */
function applyEndpointFallback(link, prefix, note, card) {
  const anchor = link[`${prefix}AnchorId`] ? cardAnchor(card, link[`${prefix}AnchorId`]) : null;
  if (anchor) {
    link[`${prefix}Point`] = { x: anchor.x, y: anchor.y };
    const side = anchorSide(anchor, cardBox(note, card));
    if (side) link[`${prefix}Side`] = side;
    return;
  }
  const point = link[`${prefix}Point`];
  if (validLinkPoint(point)) link[`${prefix}Point`] = { x: point.x, y: point.y };
}

/** World point of an endpoint: its anchor, then its stored normalized point, then card centre. */
function endpointWorld(note, card, link, prefix) {
  const box = cardBox(note, card);
  const id = prefix === "source" ? link.sourceAnchorId : link.targetAnchorId;
  const anchor = id ? cardAnchor(card, id) : null;
  if (anchor) {
    const world = anchorWorld(box, anchor);
    if (world) return world;
  }
  const point = prefix === "source" ? link.sourcePoint : link.targetPoint;
  if (validLinkPoint(point)) {
    const world = anchorWorld(box, point);
    if (world) return world;
  }
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/**
 * Reuses a nearby minor pin at the boundary point facing `toward`, else creates a new minor pin
 * there. The working card's registry is updated in memory so later affected links can reuse it.
 */
function chooseRedistributionAnchor(card, box, toward, note, senderUserId) {
  const edge = projectToEdge(box, toward);
  if (!edge) return null;
  const snap = Math.max(PIN_REDISTRIBUTION_SNAP, resolveAttachment(note).minorSnapRadius ?? 0);
  const boundary = cardPointAnchor(box, edge.point);
  const pick = redistributionAnchor(box, card.anchors ?? {}, boundary, { zoom: 1, snap });
  if (!pick) return null;
  if (pick.anchorId) return { anchorId: pick.anchorId, anchor: pick.anchor };
  // A full registry must never grow past MAX_CARD_ANCHORS. The link still keeps its projected
  // point/side fallback, so redistribution loses no link and creates no over-cap anchor.
  if (Object.keys(card.anchors ?? {}).length >= MAX_CARD_ANCHORS) {
    return {
      anchorId: "",
      anchor: { kind: "minor", x: pick.anchor.x, y: pick.anchor.y, createdBy: senderUserId }
    };
  }
  const anchorId = freshAnchorId(card.anchors);
  const anchor = { kind: "minor", x: pick.anchor.x, y: pick.anchor.y, createdBy: senderUserId };
  card.anchors = { ...(card.anchors ?? {}), [anchorId]: anchor };
  return { anchorId, anchor };
}

/** Folds legacy/dotted main entries into the single canonical `main` anchor. */
function ensureCanonicalMainAnchor(anchors, authorId) {
  return addMainAnchor(anchors, authorId);
}

function rememberPinUndo(undoId, entry) {
  pinUndoEntries.delete(undoId);
  pinUndoEntries.set(undoId, entry);
  while (pinUndoEntries.size > PIN_UNDO_LIMIT) {
    pinUndoEntries.delete(pinUndoEntries.keys().next().value);
  }
}

/** Client-supplied undo ids are opaque; generate one when absent so every route ack is undoable. */
function routeUndoId(value) {
  return typeof value === "string" && value && value.length <= MAX_ANCHOR_ID_LENGTH
    ? value : foundry.utils.randomID();
}

function rememberRouteUndo(undoId, entry) {
  routeUndoEntries.delete(undoId);
  routeUndoEntries.set(undoId, entry);
  while (routeUndoEntries.size > ROUTE_UNDO_LIMIT) {
    routeUndoEntries.delete(routeUndoEntries.keys().next().value);
  }
}

/**
 * Normalizes an undo entry into the page arrays it must restore. Route A only touches the source
 * page; B touches both. Keeping this generic lets `undoRouteSplit` also undo an A insertion that
 * the requester acknowledged (detach exists, so A records a small entry too).
 */
function routeUndoStates(entry) {
  const states = [{ noteId: entry.sourceId, before: entry.sourceLinks, after: entry.after?.sourceLinks ?? [] }];
  if (entry.noteId !== entry.sourceId) {
    states.push({ noteId: entry.noteId, before: entry.noteLinks, after: entry.after?.noteLinks ?? [] });
  }
  return states;
}

/**
 * Removes route waypoints whose owner note is no longer a live shared note (trashed, missing, or
 * still secret) plus malformed/self entries. Route A calls this before inserting so one stale
 * waypoint cannot silently block every later routing attempt on that thread.
 */
function pruneStaleRouteAnchors(shared, value, selfId) {
  const current = Array.isArray(value) ? value : [];
  const routeAnchors = [];
  let dropped = false;
  for (const entry of current) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || typeof entry.noteId !== "string" || !DOCUMENT_ID_RE.test(entry.noteId)
        || !validAnchorId(entry.anchorId) || entry.noteId === selfId) {
      dropped = true;
      continue;
    }
    const page = shared.pages.get(entry.noteId);
    if (!isLiveSharedNotePage(page)) {
      dropped = true;
      continue;
    }
    routeAnchors.push({ noteId: entry.noteId, anchorId: entry.anchorId });
  }
  return { routeAnchors, dropped };
}

/** True when a live shared note already owns a drawn/typed link to `targetId`. */
function hasSharedRelationship(page, targetId) {
  return (page?.system?.links ?? []).some(link => link?.targetId === targetId && !link.hidden);
}

/**
 * Writes both link arrays for a Route B split.
 *
 * Foundry v14 supports `Document.updateDocuments` for embedded pages, so the live path commits
 * both pages in one database operation and has no crash window. Some harnesses (including this
 * repo's fake Foundry) only expose per-document `update`, so the fallback keeps the previous
 * two-write sequence: if the process dies between those two writes, the source page already has
 * the A→C link while C does not yet have C→B. The explicit catch below restores both arrays on a
 * normal rejection, and the next split/undo retry can repair the remainder (documented limitation).
 */
async function updateSplitLinkArrays(shared, sourcePage, sourceLinks, notePage, noteLinks) {
  const updates = [
    { _id: sourcePage.id, "system.links": deepClone(sourceLinks) },
    { _id: notePage.id, "system.links": deepClone(noteLinks) }
  ];
  if (typeof JournalEntryPage.updateDocuments === "function") {
    await JournalEntryPage.updateDocuments(updates, { parent: shared });
    return;
  }
  await sourcePage.update({ "system.links": deepClone(sourceLinks) });
  await notePage.update({ "system.links": deepClone(noteLinks) });
}

/** A shared link id no other shared page owns. Two calls in one operation share `used`. */
function freshLinkId(shared, used = new Set()) {
  const all = () => allSharedNoteList(shared)
    .flatMap(page => page.system.links ?? []);
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = foundry.utils.randomID();
    if (!used.has(id) && !all().some(link => link.id === id)) {
      used.add(id);
      return id;
    }
  }
  let id = foundry.utils.randomID();
  while (used.has(id) || all().some(link => link.id === id)) id += "x";
  used.add(id);
  return id.slice(0, MAX_ANCHOR_ID_LENGTH);
}

/**
 * Captures shared link arrays that reference `noteId` as a route waypoint and the cleaned arrays.
 * Includes trashed owners: their links return on restore, so the waypoint must be gone from the
 * stored array too. Only route entries are removed; every link (and its id/endpoints) survives.
 */
function routeWaypointCleanup(shared, noteId) {
  const before = [];
  const updates = [];
  for (const sourcePage of allSharedNoteList(shared)) {
    const links = sourcePage.system.links ?? [];
    let touched = false;
    const next = links.map(link => {
      const routes = Array.isArray(link.routeAnchors) ? link.routeAnchors : [];
      if (!routes.some(entry => entry?.noteId === noteId)) return link;
      touched = true;
      return { ...link, routeAnchors: removeRouteWaypointsFor(routes, noteId) };
    });
    if (!touched) continue;
    before.push({ noteId: sourcePage.id, links: deepClone(links) });
    updates.push({ noteId: sourcePage.id, links: next });
  }
  return { before, updates };
}

/**
 * One C-side split endpoint. A canonical main anchor is used only when pins are enabled both
 * globally and for the note; otherwise the thread meets the card boundary facing the far end.
 * Returns the endpoint fields or null when no card/edge exists.
 */
function splitNoteEndpoint(prefix, { note, card, toward }) {
  if (!card) return null;
  const box = cardBox(note, card);
  const main = pinsEnabled() && resolveAttachment(note).mainPinEnabled !== false
    ? cardAnchor(card, MAIN_ANCHOR_ID) : null;
  if (main?.kind === "main") {
    return {
      [`${prefix}AnchorId`]: MAIN_ANCHOR_ID,
      [`${prefix}Point`]: { x: main.x, y: main.y },
      [`${prefix}Side`]: anchorSide(main, box)
    };
  }
  const edge = projectToEdge(box, toward);
  if (!edge) return null;
  return {
    [`${prefix}AnchorId`]: "",
    [`${prefix}Point`]: { x: edge.point.x, y: edge.point.y },
    [`${prefix}Side`]: edge.side
  };
}

/** Clears a copied endpoint anchor id that no longer exists, keeping its point/side fallback. */
function clearMissingEndpointAnchor(link, prefix, card) {
  const key = `${prefix}AnchorId`;
  if (link[key] && !cardAnchor(card, link[key])) link[key] = "";
}

/**
 * Removes unreferenced minor anchors from every live shared card in one layout write. Reference
 * collection uses *all* shared notes (including trashed ones) because restoring a note brings its
 * links back; only the layout is updated.
 */
async function pruneSharedAnchors(shared, layout = layoutPage(shared), linkOverride = null) {
  if (!layout) return;
  // A Foundry page update can resolve before the collection exposes its new links. Use the
  // exact array we just wrote when pruning after a link edit or deletion.
  const notes = allSharedNoteList(shared).map(page => page.id === linkOverride?.noteId
    ? { _id: page.id, system: { links: linkOverride.links } } : page);
  // Promote legacy point-only endpoints first, so old links stop rendering as small SVG dots and
  // join the normal pin system. This may create anchors; the merge below then folds any that land
  // on the same physical point.
  const promoted = pinsEnabled()
    ? promoteLegacyLinkAnchors(layout.system.cards ?? {}, notes)
    : { cards: layout.system.cards ?? {}, changed: [], links: [] };
  const promotedLinks = new Map(promoted.links.map(entry => [entry.noteId, entry.links]));
  const promotedNotes = promotedLinks.size
    ? notes.map(note => {
      const noteId = note?._id ?? note?.id;
      const links = promotedLinks.get(noteId);
      return links ? { ...note, system: { ...(note.system ?? {}), links } } : note;
    })
    : notes;
  for (const { noteId, links } of promoted.links) {
    const page = shared.pages.get(noteId);
    if (page?.type === `${MODULE_ID}.note`) await page.update({ "system.links": links });
  }
  // Fold duplicate minors left by an older link-creation bug before any pruning. The rewritten
  // links are written first; canonicalizing mains below then works from the merged arrays so it
  // never rewrites a stale reference back.
  const merged = mergeNearbyMinorAnchors(promoted.cards, promotedNotes, {
    pinLinks: layout.system.pinLinks ?? {}
  });
  const mergedLinks = new Map(merged.links.map(entry => [entry.noteId, entry.links]));
  const mergedNotes = mergedLinks.size
    ? promotedNotes.map(note => {
      const noteId = note?._id ?? note?.id;
      const links = mergedLinks.get(noteId);
      return links ? { ...note, system: { ...(note.system ?? {}), links } } : note;
    })
    : promotedNotes;
  for (const { noteId, links } of merged.links) {
    const page = shared.pages.get(noteId);
    if (page?.type === `${MODULE_ID}.note`) await page.update({ "system.links": links });
  }
  // Fold any legacy non-canonical main next and move its links to the canonical id. Otherwise
  // pruning would remove the referenced main and leave the link dangling on an unknown anchor.
  const canonical = canonicalizeMainAnchors(merged.cards, mergedNotes);
  const canonicalLinks = new Map(canonical.links.map(entry => [entry.noteId, entry.links]));
  const finalNotes = canonicalLinks.size
    ? mergedNotes.map(note => {
      const noteId = note?._id ?? note?.id;
      const links = canonicalLinks.get(noteId);
      return links ? { ...note, system: { ...(note.system ?? {}), links } } : note;
    })
    : mergedNotes;
  for (const { noteId, links } of canonical.links) {
    const page = shared.pages.get(noteId);
    if (page?.type === `${MODULE_ID}.note`) await page.update({ "system.links": links });
  }
  const changed = pruneAnchorRegistry(canonical.cards, finalNotes);
  const updates = {};
  const setRegistry = (noteId, anchors) => {
    updates[`system.cards.${noteId}.anchors`] = anchors;
    // Foundry merges object fields on update. A replacement registry alone leaves removed
    // anchor keys behind; explicit deletion markers make the last-link cleanup persistent.
    for (const anchorId of Object.keys(layout.system.cards?.[noteId]?.anchors ?? {})) {
      if (validAnchorId(anchorId) && !Object.hasOwn(anchors, anchorId)) {
        updates[`system.cards.${noteId}.anchors.-=${anchorId}`] = null;
      }
    }
  };
  for (const { noteId, anchors } of promoted.changed) setRegistry(noteId, anchors);
  for (const { noteId, anchors } of merged.changed) setRegistry(noteId, anchors);
  for (const { noteId, anchors } of canonical.changed) {
    setRegistry(noteId, anchors);
  }
  for (const { noteId, anchors } of changed) {
    setRegistry(noteId, anchors);
  }
  for (const { id, source, target } of merged.pinLinks) {
    updates[`system.pinLinks.${id}.source`] = source;
    updates[`system.pinLinks.${id}.target`] = target;
  }
  if (Object.keys(updates).length) await layout.update(updates);
}

/**
 * Every shared link (including trashed owners, whose links return on restore) that references
 * `noteId`'s main anchor as an endpoint or waypoint.
 */
function mainPinAffectedLinks(shared, noteId) {
  const affected = [];
  for (const sourcePage of allSharedNoteList(shared)) {
    for (const link of sourcePage.system.links ?? []) {
      const sourceOnThis = sourcePage.id === noteId && link.sourceAnchorId === MAIN_ANCHOR_ID;
      const targetOnThis = link.targetId === noteId && link.targetAnchorId === MAIN_ANCHOR_ID;
      const routeOnThis = (link.routeAnchors ?? [])
        .some(entry => entry?.noteId === noteId && entry?.anchorId === MAIN_ANCHOR_ID);
      if (sourceOnThis || targetOnThis || routeOnThis) {
        affected.push({ sourcePage, link, sourceOnThis, targetOnThis, routeOnThis });
      }
    }
  }
  return affected;
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
    const activeGM = game.users.activeGM?.id ?? null;

    // Targeted protocol replies are resolved before the GM-only gate: a player never
    // handles writes, but it does receive its own acknowledgement.
    if (EDIT_REPLY_TYPES.has(message.type)) {
      if (senderUserId !== activeGM) return;
      if (message.forUserId !== game.user.id) return;
      if (message.type === "noteEditState") applyEditState(message.notes, message.gmEpoch);
      resolvePendingEditReply(message);
      return;
    }

    // Authority broadcasts are meaningful only from the current active GM. A late packet
    // from a former GM must not resurrect a lease or preview after failover.
    if (message.type === "notePreview") {
      if (senderUserId !== activeGM) return;
      applyPreview(message);
      return;
    }
    if (message.type === "noteEditLeaseChanged") {
      if (senderUserId !== activeGM) return;
      applyLeaseChanged(message);
      return;
    }
    if (message.type === "noteEditRevoked") {
      if (senderUserId !== activeGM) return;
      applyRevoked(message);
      return;
    }

    if (message.type === "writeRejected") {
      if (senderUserId !== activeGM) return;
      if (message.forUserId === game.user.id) ui.notifications?.warn(message.reason);
      return;
    }
    if (message.type === "writeApplied") {
      // Only the active GM may confirm a write, and only to the requester it names. The local
      // client uses this to commit undo entries; a rejected/rolled-back write sends no such ack.
      if (senderUserId !== activeGM) return;
      if (message.forUserId && message.forUserId !== game.user.id) return;
      Hooks.callAll("journalinatorWriteApplied", message);
      return;
    }

    if (!game.user.isGM) return;
    if (activeGM !== game.user.id) return;
    const task = enqueueWrite(message, senderUserId);
    if (EDIT_COMMAND_TYPES.has(message.type) && message.type !== "previewNoteBody") {
      task.then(reply => sendTargetedReply(reply, senderUserId));
    }
  });
}

function layoutPage(shared) {
  const ids = getContainerIds();
  return ids ? shared.pages.get(ids.layoutPage) : null;
}

/**
 * UI-SPEC write gate for incompatible stored data.
 *
 * One legacy/corrupt note or layout page makes the whole shared journal read-only, not just
 * the offending page. Reads and state requests stay available. A missing layout page is an
 * uninitialized fresh world, which `worldSchemaStatus` treats as compatible.
 */
function sharedWorldWritable(shared) {
  return worldSchemaStatus({
    notes: allSharedNoteList(shared),
    layout: layoutPage(shared)
  }).current;
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

function requestIdOf(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH
    ? value : null;
}

function sessionIdOf(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH
    ? value : null;
}

/** Stable, non-displayable Foundry page name. Set once at creation and never title-derived. */
export function notePageName(noteId) {
  return `jn-note-${String(noteId ?? "")}`;
}

/** Validates a v2 appearance skin; an invalid value rejects the whole write. */
function cleanNoteSkin(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => !SKIN_KEYS.has(key))) return null;
  if (!isPaper(value.paper) || !isFont(value.font)) return null;
  if (typeof value.torn !== "boolean") return null;
  if (!Number.isInteger(value.tiltSeed) || value.tiltSeed < 0) return null;
  let backgroundImage = null;
  if (value.backgroundImage !== null && value.backgroundImage !== undefined
      && value.backgroundImage !== "") {
    if (typeof value.backgroundImage !== "string") return null;
    backgroundImage = noteImagePath(value.backgroundImage);
    if (!backgroundImage) return null;
  }
  return {
    paper: value.paper,
    font: value.font,
    torn: value.torn,
    backgroundImage,
    tiltSeed: value.tiltSeed
  };
}

/**
 * Validates an optional geometry patch. Returns `undefined` when absent, `null` when
 * invalid, or a normalized object. Invalid geometry must reject before any body write.
 */
function cleanGeometry(value) {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value) || Object.keys(value).some(key => !GEOMETRY_KEYS.has(key))) return null;
  const clean = {};
  if (value.sizing !== undefined) {
    if (!isObject(value.sizing)
        || Object.keys(value.sizing).some(key => !SIZING_KEYS.has(key))) return null;
    const mode = value.sizing.mode;
    if (mode !== "auto" && mode !== "manual") return null;
    const width = value.sizing.width ?? null;
    const minHeight = value.sizing.minHeight ?? null;
    if (width !== null && (!Number.isFinite(width)
        || width < SIZING_WIDTH_MIN || width > SIZING_WIDTH_MAX)) return null;
    if (minHeight !== null && (!Number.isFinite(minHeight)
        || minHeight < SIZING_MIN_HEIGHT_MIN || minHeight > SIZING_MIN_HEIGHT_MAX)) return null;
    if (mode === "manual" && (width === null || minHeight === null)) return null;
    if (mode === "auto" && (width !== null || minHeight !== null)) return null;
    clean.sizing = { mode, width, minHeight };
  }
  if (value.autoSizeOrigin !== undefined) {
    const origin = value.autoSizeOrigin;
    if (!isObject(origin) || Object.keys(origin).some(key => !ORIGIN_KEYS.has(key))) return null;
    if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;
    clean.autoSizeOrigin = { x: origin.x, y: origin.y };
  }
  for (const field of ["x", "y"]) {
    if (value[field] === undefined) continue;
    if (!Number.isFinite(value[field])) return null;
    clean[field] = clampCoordinate(value[field]);
  }
  return clean;
}

function cleanEventIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_EVENT_IDS) return null;
  if (value.some(id => typeof id !== "string" || !id || id.length > 100)) return null;
  return [...new Set(value)];
}

/**
 * Creates a fresh v2 note and its layout card. Body/layout/skin/coordinate validation
 * happens before any document write. If the card cannot be created, the just-created
 * page is deleted again so no orphan note survives.
 */
async function createV2NotePage(shared, fields, senderUserId, { noteId, source = "create" } = {}) {
  const id = typeof noteId === "string" && DOCUMENT_ID_RE.test(noteId)
    ? noteId : foundry.utils.randomID();
  const body = typeof fields?.body === "string" ? fields.body : null;
  if (body === null || body.length > MAX_NOTE_BODY_LENGTH) return { error: "invalid" };
  if (!isLayout(fields?.layout)) return { error: "invalid" };
  const skin = cleanNoteSkin(fields?.skin);
  if (!skin) return { error: "invalid" };
  if (!Number.isFinite(fields?.x) || !Number.isFinite(fields?.y)) return { error: "invalid" };

  const layout = layoutPage(shared);
  if (!layout) return { error: "invalid" };

  const seeded = seededSkin(skin, id);
  const now = Date.now();
  let page;
  try {
    page = await JournalEntryPage.create({
      _id: id,
      name: notePageName(id),
      type: `${MODULE_ID}.note`,
      system: {
        schemaVersion: 2,
        body,
        revision: 0,
        layout: fields.layout,
        skin: seeded,
        attachment: {
          mainPinEnabled: true,
          mainSnapRadius: 24,
          minorSnapRadius: 6,
          pinStyle: "default"
        },
        links: [],
        authorId: senderUserId,
        createdAt: now,
        updatedAt: now,
        deleted: null,
        lastSave: null
      }
    }, { parent: shared, keepId: true });
  } catch (err) {
    console.error("Journalinator: note creation failed", err);
    return { error: "invalid" };
  }
  if (!page) return { error: "invalid" };

  const initialWidth = getLayout(fields.layout).widths[0];
  const x = clampCoordinate(fields.x);
  const y = clampCoordinate(fields.y);
  const card = {
    x,
    y,
    sizing: { mode: "auto", width: null, minHeight: null },
    // Initial top-center world point. T10 may recompute this on first measurement for
    // rotated cards; until then the main pin stays stable at this origin.
    autoSizeOrigin: { x: x + initialWidth / 2, y },
    rotation: tiltForSkin(seeded),
    ports: ["right"],
    anchors: {
      main: { kind: "main", x: MAIN_PIN.x, y: MAIN_PIN.y, createdBy: senderUserId }
    }
  };
  try {
    await layout.update({ [`system.cards.${page.id}`]: card });
  } catch (err) {
    console.error("Journalinator: note card creation failed", err);
    await page.delete().catch(() => {});
    return { error: "invalid" };
  }

  // Fired only after both the page and its card exist, so activity can count a real creation.
  Hooks.callAll("journalinatorNoteCreated", {
    noteId: page.id,
    authorId: senderUserId,
    body,
    previousBody: "",
    layout: fields.layout,
    skin: seeded,
    revision: 0,
    source: source === "paste" ? "paste" : "create",
    createdAt: now
  });
  return { page, card, skin: seeded };
}

/** A pending-transfer id that is not already stored on the private container. */
function freshTransferId() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = foundry.utils.randomID();
    if (!privateStore.transfer(id)) return id;
  }
  let id = foundry.utils.randomID();
  while (privateStore.transfer(id)) id += "x";
  return id.slice(0, 64);
}

/**
 * Private-to-private copies are GM-mediated like every other write, but never touch the shared
 * journal or the secrets vault. The active GM's write queue serializes send/accept/decline; the
 * sender/recipient below come from the verified socket relay, never from the message.
 */
async function handlePrivateTransferMessage(message, senderUserId) {
  if (!getContainerIds()) return;

  if (message.type === "sendPrivateTransfer") {
    if (typeof message.toUserId !== "string" || !message.toUserId) {
      notifyUser(senderUserId, t("JN.Transfer.UserMissing"));
      return;
    }
    if (message.toUserId === senderUserId) {
      notifyUser(senderUserId, t("JN.Transfer.Self"));
      return;
    }
    if (!game.users.get(message.toUserId)) {
      notifyUser(senderUserId, t("JN.Transfer.UserMissing"));
      return;
    }
    if (!game.users.get(senderUserId)) return;
    const page = privateStore.findActive(senderUserId);
    if (!page) {
      notifyUser(senderUserId, t("JN.Transfer.NoPrivateSpace"));
      return;
    }
    if (!Array.isArray(message.noteIds) || !message.noteIds.length) {
      notifyUser(senderUserId, t("JN.Transfer.None"));
      return;
    }
    if (message.noteIds.length > MAX_TRANSFER_NOTES) {
      notifyUser(senderUserId, t("JN.Transfer.TooMany", { max: MAX_TRANSFER_NOTES }));
      return;
    }

    let transfer;
    try {
      transfer = buildPrivateTransfer(privateStore.read(page), message.noteIds, {
        fromUserId: senderUserId,
        toUserId: message.toUserId
      });
    } catch (err) {
      notifyUser(senderUserId, err.message);
      return;
    }

    const transferId = freshTransferId();
    try {
      await privateStore.addTransfer({ id: transferId, ...transfer });
    } catch (err) {
      notifyUser(senderUserId, err.message);
      return;
    }
    acknowledgeWriteApplied(senderUserId, {
      kind: "privateTransfer",
      action: "sent",
      transferId,
      count: transfer.summary.count,
      droppedLinks: transfer.summary.droppedLinks ?? 0,
      droppedWaypoints: transfer.summary.droppedWaypoints ?? 0,
      toUserId: message.toUserId
    });
    return;
  }

  if (message.type === "acceptPrivateTransfer" || message.type === "declinePrivateTransfer") {
    const transferId = message.transferId;
    if (typeof transferId !== "string" || !transferId) {
      notifyUser(senderUserId, t("JN.Transfer.Stale"));
      return;
    }
    const record = privateStore.transfer(transferId);
    if (!record) {
      notifyUser(senderUserId, t("JN.Transfer.Stale"));
      return;
    }
    if (record.toUserId !== senderUserId) {
      notifyUser(senderUserId, t("JN.Transfer.NotYours"));
      return;
    }
    try {
      if (message.type === "acceptPrivateTransfer") {
        const result = await privateStore.acceptTransfer(transferId, senderUserId);
        acknowledgeWriteApplied(senderUserId, {
          kind: "privateTransfer",
          action: "accepted",
          count: result.count,
          droppedLinks: result.droppedLinks ?? 0,
          droppedWaypoints: result.droppedWaypoints ?? 0
        });
      } else {
        const result = await privateStore.declineTransfer(transferId, senderUserId);
        acknowledgeWriteApplied(senderUserId, {
          kind: "privateTransfer", action: "declined", count: result.count
        });
      }
    } catch (err) {
      notifyUser(senderUserId, err.message);
    }
  }
}

/**
 * Copies visible shared notes into a private workspace. The active GM reads only the shared
 * journal (never the vault or notesStore's merged view), so hidden blocks/links cannot leak even
 * when the sender is a GM with secrets unlocked. Another user's copy goes through the existing
 * pending-offer inbox; a self-copy imports directly into the sender's active private page.
 */
async function handleSharedTransferMessage(message, senderUserId) {
  const ids = getContainerIds();
  if (!ids) return;
  const shared = game.journal.get(ids.shared);
  if (!shared) return;

  const toUserId = message.toUserId;
  if (typeof toUserId !== "string" || !toUserId) {
    notifyUser(senderUserId, t("JN.Transfer.UserMissing"));
    return;
  }
  if (!game.users.get(senderUserId)) return;
  if (!game.users.get(toUserId)) {
    notifyUser(senderUserId, t("JN.Transfer.UserMissing"));
    return;
  }
  if (!Array.isArray(message.noteIds) || !message.noteIds.length) {
    notifyUser(senderUserId, t("JN.Transfer.None"));
    return;
  }
  if (message.noteIds.length > MAX_TRANSFER_NOTES) {
    notifyUser(senderUserId, t("JN.Transfer.TooMany", { max: MAX_TRANSFER_NOTES }));
    return;
  }

  const layout = layoutPage(shared)?.system ?? {};
  let transfer;
  try {
    transfer = buildSharedTransfer(shared.pages, layout, message.noteIds, {
      fromUserId: senderUserId,
      toUserId
    });
  } catch (err) {
    notifyUser(senderUserId, err.message);
    return;
  }

  const payload = {
    kind: "privateTransfer",
    count: transfer.summary.count,
    droppedLinks: transfer.summary.droppedLinks ?? 0,
    droppedWaypoints: transfer.summary.droppedWaypoints ?? 0,
    toUserId
  };

  if (toUserId === senderUserId) {
    const page = privateStore.findActive(senderUserId);
    if (!page) {
      notifyUser(senderUserId, t("JN.Transfer.NoPrivateSpace"));
      return;
    }
    let serialized;
    try {
      serialized = JSON.stringify(transfer);
    } catch {
      notifyUser(senderUserId, t("JN.Transfer.TooLarge", { max: MAX_TRANSFER_TEXT }));
      return;
    }
    if (serialized.length > MAX_TRANSFER_STORAGE) {
      notifyUser(senderUserId, t("JN.Transfer.TooLarge", { max: MAX_TRANSFER_TEXT }));
      return;
    }
    try {
      const result = importPrivateTransfer(privateStore.read(page), transfer, senderUserId);
      await privateStore.save(page, result.workspace, privateStore.flags(page).rev ?? 0);
      acknowledgeWriteApplied(senderUserId, { ...payload, action: "imported", count: result.imported.length });
    } catch (err) {
      notifyUser(senderUserId, err.message);
    }
    return;
  }

  const transferId = freshTransferId();
  try {
    await privateStore.addTransfer({ id: transferId, ...transfer });
  } catch (err) {
    notifyUser(senderUserId, err.message);
    return;
  }
  acknowledgeWriteApplied(senderUserId, { ...payload, action: "sent", transferId });
}

async function handleMessage(message, senderUserId) {
  if (message.type === "sendPrivateTransfer"
      || message.type === "acceptPrivateTransfer"
      || message.type === "declinePrivateTransfer") {
    await handlePrivateTransferMessage(message, senderUserId);
    return;
  }
  if (message.type === "sendSharedToPrivate") {
    await handleSharedTransferMessage(message, senderUserId);
    return;
  }

  const ids = getContainerIds();
  if (!ids) return;
  const shared = game.journal.get(ids.shared);
  if (!shared) return;

  if (EDIT_COMMAND_TYPES.has(message.type)) {
    return handleEditCommand(shared, message, senderUserId);
  }

  switch (message.type) {
    case "privateCreate": {
      const user = game.users.get(senderUserId);
      if (!user) return;
      try {
        await privateStore.createFor(user);
      } catch (err) {
        notifyUser(senderUserId, err.message);
      }
      return;
    }

    case "privateAccept": {
      const page = privateStore.findPending(senderUserId);
      if (!page) return;
      try {
        await privateStore.accept(page, senderUserId);
      } catch (err) {
        notifyUser(senderUserId, err.message);
      }
      return;
    }

    case "privateDecline": {
      const page = privateStore.findPending(senderUserId);
      if (!page) return;
      try {
        await privateStore.decline(page, senderUserId);
      } catch (err) {
        notifyUser(senderUserId, err.message);
      }
      return;
    }

    case "pasteNote": {
      // Clipboard/publish carries the current v2 payload only. Fresh page, fresh card,
      // revision 0; no legacy block arrays and no source identity are accepted.
      if (!sharedWorldWritable(shared)) {
        notifyUser(senderUserId, "Incompatible note data.");
        return;
      }
      const created = await createV2NotePage(shared, {
        body: message.body, layout: message.layout, skin: message.skin, x: message.x, y: message.y
      }, senderUserId, { source: "paste" });
      if (created.error) {
        notifyUser(senderUserId, "Invalid note payload.");
        return;
      }
      acknowledgeWriteApplied(senderUserId, { kind: "paste", noteId: created.page.id });
      return;
    }



    case "setNoteAttachment": {
      // Phase 5 owns destructive main-pin redistribution and its undo. Until then this handler
      // must not be used by bulk UI operations; it only stores the validated attachment fields.
      const pages = liveSharedNotePages(shared, message.noteIds);
      const fields = sanitizeAttachmentFields(message.fields);
      if (!pages || !fields) return;
      for (const page of pages) {
        const existing = page.system.attachment && typeof page.system.attachment === "object"
          ? page.system.attachment : {};
        await page.update({
          "system.attachment": { ...existing, ...fields }
        });
      }
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

    case "setCardPorts": {
      const layout = layoutPage(shared);
      const note = shared.pages.get(message.noteId);
      if (!note || note.type !== `${MODULE_ID}.note` || note.system.deleted
          || !layout?.system.cards?.[message.noteId] || !validCardPorts(message.ports)) return;
      await layout.update({ [`system.cards.${message.noteId}.ports`]: message.ports });
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
      const stamp = message.stamp ?? "";
      if (!layout) {
        if (stamp) notifyUser(senderUserId, t("JN.Stamp.SaveFailed"));
        return;
      }
      const noteId = message.noteId ?? "";
      if (stamp !== "" && !stampUrl(stamp)) return;
      if (noteId !== "") {
        if (!stamp || typeof noteId !== "string" || !DOCUMENT_ID_RE.test(noteId)) return;
        const note = shared.pages.get(noteId);
        if (!note || note.type !== `${MODULE_ID}.note` || note.system.deleted) return;
      }
      if (message.text !== undefined && typeof message.text !== "string") return;
      const text = stamp ? "" : (message.text ?? t("JN.Label.Default")).slice(0, MAX_LABEL_TEXT_LENGTH);
      const x = message.x === undefined ? 0 : message.x;
      const y = message.y === undefined ? 0 : message.y;
      const size = message.size === undefined ? 14 : message.size;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(size)) return;
      const color = sanitizeLabelColor(message.color);
      if (color === null) return;
      const [existingId, ...duplicates] = attachedStampIds(layout.system.labels, noteId);
      if (message.corner !== undefined && (!noteId || !isStampCorner(message.corner))) return;
      const corner = message.corner ?? layout.system.labels?.[existingId]?.corner ?? DEFAULT_STAMP_CORNER;
      const labelId = existingId ?? foundry.utils.randomID();
      await layout.update({
        ...Object.fromEntries(duplicates.map(id => [`system.labels.-=${id}`, null])),
        [`system.labels.${labelId}`]: {
          text,
          x: clampCoordinate(x),
          y: clampCoordinate(y),
          size: clampLabelSize(size),
          color,
          stamp,
          noteId,
          ...(noteId ? { corner } : {})
        }
      }).catch(error => {
        if (stamp) notifyUser(senderUserId, t("JN.Stamp.SaveFailed"));
        throw error;
      });
      if (stamp && layout.system.labels?.[labelId]?.stamp !== stamp) {
        notifyUser(senderUserId, t("JN.Stamp.SaveFailed"));
      }
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
      if ("corner" in message) {
        const label = layout.system.labels[message.labelId];
        if (!label.noteId || !stampUrl(label.stamp) || !isStampCorner(message.corner)) return;
        updates[`system.labels.${message.labelId}.corner`] = message.corner;
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
      const label = layout.system.labels[message.labelId];
      const ids = label.noteId && stampUrl(label.stamp)
        ? attachedStampIds(layout.system.labels, label.noteId) : [message.labelId];
      await layout.update(Object.fromEntries(ids.map(id => [`system.labels.-=${id}`, null])));
      return;
    }

    case "boardPinAction": {
      const action = message.action;
      if (!["add", "move", "connect", "delete", "updateLink", "deleteLink"].includes(action?.type) || !pinsEnabled()) return;
      const layout = layoutPage(shared);
      if (!layout) return;
      const cards = layout.system.cards ?? {};
      const pins = { ...(layout.system.pins ?? {}) };
      const pinLinks = { ...(layout.system.pinLinks ?? {}) };
      const live = new Map(allSharedNoteList(shared).filter(isLiveSharedNotePage)
        .map(page => [page.id, page]));
      const boxes = new Map([...live].filter(([id]) => cards[id])
        .map(([id, page]) => [id, cardBox(page, cards[id])]));
      const current = { cards, pins, pinLinks };
      if (action.type === "add") {
        const noteId = action.noteId || "";
        if (noteId && !live.has(noteId)) return;
        if (!validPinPosition(noteId, action.x, action.y)
            || Object.keys(pins).length >= 2000) return;
        pins[foundry.utils.randomID()] = { noteId, x: action.x, y: action.y,
          isDefault: false };
        await layout.update({ "system.pins": pins });
        return;
      }
      if (action.type === "connect") {
        if (typeof action.source !== "string" || typeof action.target !== "string"
            || action.source === action.target || Object.keys(pinLinks).length >= 4000
            || !resolvePin(action.source, current, boxes)
            || !resolvePin(action.target, current, boxes)) return;
        if (Object.values(pinLinks).some(link => link.source === action.source
            && link.target === action.target || link.source === action.target
            && link.target === action.source)) return;
        pinLinks[foundry.utils.randomID()] = normalizePinLink({ source: action.source, target: action.target });
        await layout.update({ "system.pinLinks": pinLinks });
        return;
      }
      if (action.type === "updateLink" || action.type === "deleteLink") {
        if (typeof action.linkId !== "string" || !validAnchorId(action.linkId)
            || !pinLinks[action.linkId]) return;
        if (action.type === "deleteLink") {
          // Foundry merges object updates; leaving the key out of a new pinLinks object would
          // keep the old entry. Delete it explicitly, with the id validated for a dotted path.
          await layout.update({ [`system.pinLinks.-=${action.linkId}`]: null });
          return;
        }
        pinLinks[action.linkId] = normalizePinLink(pinLinks[action.linkId], action.fields);
        await layout.update({ "system.pinLinks": pinLinks });
        return;
      }
      if (action.type === "delete") {
        const ref = action.ref;
        if (typeof ref !== "string" || ref.length > 200) return;
        let cardUpdate = null;
        let deletedPinId = "";
        if (ref.startsWith("p:")) {
          const id = ref.slice(2);
          if (!validAnchorId(id) || !pins[id] || pins[id].isDefault) return;
          deletedPinId = id;
          delete pins[id];
        } else if (ref.startsWith("n:")) {
          const split = ref.indexOf(":", 2);
          if (split < 0) return;
          const ownerId = ref.slice(2, split), anchorId = ref.slice(split + 1);
          const card = cards[ownerId];
          if (!DOCUMENT_ID_RE.test(ownerId) || !live.has(ownerId)
              || !validAnchorId(anchorId) || card?.anchors?.[anchorId]?.kind !== "minor") return;
          const anchors = { ...card.anchors };
          delete anchors[anchorId];
          cardUpdate = { ownerId, anchorId, anchors };
        } else return;
        const removedLinkIds = [];
        for (const [id, link] of Object.entries(pinLinks)) {
          if (link.source === ref || link.target === ref) {
            if (validAnchorId(id)) removedLinkIds.push(id);
            delete pinLinks[id];
          }
        }
        const pageUpdates = [];
        for (const owner of allSharedNoteList(shared)) {
          const links = (owner.system.links ?? []).filter(link => {
            if (link.sourcePinRef === ref || link.targetPinRef === ref) return false;
            if (!cardUpdate) return true;
            return !(owner.id === cardUpdate.ownerId && link.sourceAnchorId === cardUpdate.anchorId)
              && !(link.targetId === cardUpdate.ownerId && link.targetAnchorId === cardUpdate.anchorId);
          });
          if (links.length !== (owner.system.links ?? []).length) pageUpdates.push([owner, links]);
        }
        const updates = {};
        if (deletedPinId) updates[`system.pins.-=${deletedPinId}`] = null;
        for (const id of removedLinkIds) updates[`system.pinLinks.-=${id}`] = null;
        if (cardUpdate) {
          updates[`system.cards.${cardUpdate.ownerId}.anchors`] = cardUpdate.anchors;
          updates[`system.cards.${cardUpdate.ownerId}.anchors.-=${cardUpdate.anchorId}`] = null;
        }
        await layout.update(updates);
        for (const [owner, links] of pageUpdates) await owner.update({ "system.links": links });
        return;
      }
      const noteId = action.noteId || "";
      if (noteId && !live.has(noteId)) return;
      if (!validPinPosition(noteId, action.x, action.y)) return;
      const ref = action.ref;
      if (typeof ref !== "string" || ref.length > 200) return;
      let id = ref.startsWith("p:") ? ref.slice(2) : "";
      const pageUpdates = new Map();
      if (!id && ref.startsWith("n:")) {
        const split = ref.indexOf(":", 2);
        if (split < 0) return;
        const oldNoteId = ref.slice(2, split), anchorId = ref.slice(split + 1);
        if (!DOCUMENT_ID_RE.test(oldNoteId) || !live.has(oldNoteId)
            || !validAnchorId(anchorId)) return;
        const card = cards[oldNoteId], anchor = card?.anchors?.[anchorId];
        if (!anchor || anchor.kind !== "minor") return;
        id = foundry.utils.randomID();
        const anchors = { ...card.anchors };
        delete anchors[anchorId];
        const newRef = boardPinRef(id);
        for (const owner of allSharedNoteList(shared)) {
          let touched = false;
          const links = (owner.system.links ?? []).map(link => {
            let next = link;
            if (owner.id === oldNoteId && link.sourceAnchorId === anchorId) {
              next = { ...next, sourcePinRef: newRef, sourceAnchorId: "" };
            }
            if (link.targetId === oldNoteId && link.targetAnchorId === anchorId) {
              next = { ...next, targetPinRef: newRef, targetAnchorId: "" };
            }
            if (next !== link) touched = true;
            return next;
          });
          if (touched) pageUpdates.set(owner.id, links);
        }
        for (const link of Object.values(pinLinks)) {
          if (link.source === ref) link.source = newRef;
          if (link.target === ref) link.target = newRef;
        }
        pins[id] = { noteId, x: action.x, y: action.y, isDefault: false };
        await layout.update({
          [`system.cards.${oldNoteId}.anchors`]: anchors,
          // The converted minor is now a board pin; the old anchor key must be deleted too.
          [`system.cards.${oldNoteId}.anchors.-=${anchorId}`]: null,
          "system.pins": pins, "system.pinLinks": pinLinks
        });
        for (const [ownerId, links] of pageUpdates) {
          await shared.pages.get(ownerId)?.update({ "system.links": links });
        }
        return;
      }
      if (!validAnchorId(id) || !pins[id] || pins[id].isDefault) return;
      pins[id] = { noteId, x: action.x, y: action.y, isDefault: false };
      await layout.update({ "system.pins": pins });
      return;
    }

    case "normalizePins": {
      // One-shot cleanup request from an opened canvas: folds duplicate/legacy anchors, promotes
      // old point-only link endpoints, and prunes anything no longer referenced. Idempotent; a
      // no-op when the board is already clean.
      if (!pinsEnabled()) return;
      const layout = layoutPage(shared);
      if (layout) await pruneSharedAnchors(shared, layout);
      return;
    }

    case "addCardAnchor": {
      const page = shared.pages.get(message.noteId);
      if (!isLiveSharedNotePage(page) || message.kind !== "minor" || !pinsEnabled()) return;
      if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) return;
      if (message.x < 0 || message.x > 1 || message.y < 0 || message.y > 1) return;
      const layout = layoutPage(shared);
      const card = layout?.system.cards?.[page.id];
      if (!card) return;
      const anchors = { ...(card.anchors ?? {}) };
      if (Object.keys(anchors).length >= MAX_CARD_ANCHORS) return;
      const anchorId = freshAnchorId(anchors);
      const point = minorOnEdge({ kind: "minor", x: message.x, y: message.y }, cardBox(page, card));
      anchors[anchorId] = { ...point, createdBy: senderUserId };
      await layout.update({ [`system.cards.${page.id}.anchors`]: anchors });
      return;
    }

    case "moveCardAnchor": {
      if (!pinsEnabled()) return;
      const page = shared.pages.get(message.noteId);
      if (!isLiveSharedNotePage(page) || !validAnchorId(message.anchorId)) return;
      if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) return;
      if (message.x < 0 || message.x > 1 || message.y < 0 || message.y > 1) return;
      const layout = layoutPage(shared);
      const card = layout?.system.cards?.[page.id];
      const anchor = cardAnchor(card, message.anchorId);
      if (!anchor || anchor.kind !== "minor") return; // main pins move the note, not an anchor
      // Clone the registry and rewrite it whole. A client id never becomes a dotted update path
      // (which could otherwise reach `__proto__`/`constructor` or unrelated keys).
      const moved = minorOnEdge({ ...anchor, x: message.x, y: message.y }, cardBox(page, card));
      const anchors = { ...(card.anchors ?? {}), [message.anchorId]: moved };
      const box = cardBox(page, card);
      const side = anchorSide(moved, box);
      // Links keep a normalized point/side fallback for hidden/legacy rendering. Refresh every
      // shared reference (trashed owners included) in this same serialized write so a later
      // hide/reveal still draws the thread at its new position.
      const pageUpdates = new Map();
      for (const notePage of allSharedNoteList(shared)) {
        let touched = false;
        const links = (notePage.system.links ?? []).map(link => {
          let next = link;
          if (notePage.id === page.id && link.sourceAnchorId === message.anchorId) {
            next = { ...next, sourcePoint: { x: moved.x, y: moved.y } };
            if (side) next.sourceSide = side;
          }
          if (link.targetId === page.id && link.targetAnchorId === message.anchorId) {
            next = { ...(next === link ? link : next), targetPoint: { x: moved.x, y: moved.y } };
            if (side) next.targetSide = side;
          }
          if (next !== link) touched = true;
          return next;
        });
        if (touched) pageUpdates.set(notePage.id, links);
      }
      await layout.update({ [`system.cards.${page.id}.anchors`]: anchors });
      for (const [noteId, links] of pageUpdates) {
        await shared.pages.get(noteId)?.update({ "system.links": links });
      }
      return;
    }

    case "removeCardAnchor": {
      if (!pinsEnabled()) return;
      const page = shared.pages.get(message.noteId);
      if (!isLiveSharedNotePage(page) || !validAnchorId(message.anchorId)) return;
      const layout = layoutPage(shared);
      const card = layout?.system.cards?.[page.id];
      const anchor = cardAnchor(card, message.anchorId);
      if (!anchor || anchor.kind !== "minor") return;
      // Shared pruning cannot see vault links; hidden links are therefore forced to drop anchor
      // references when stored. Count every shared reference (trashed notes included, since a
      // restore brings their links back) before deleting a shared pin.
      const refs = collectAnchorRefs(allSharedNoteList(shared));
      if (refs.get(page.id)?.has(message.anchorId)) return;
      await layout.update({ [`system.cards.${page.id}.anchors.-=${message.anchorId}`]: null });
      return;
    }

    case "setMainPinEnabled": {
      if (!pinsEnabled()) return;
      const page = shared.pages.get(message.noteId);
      if (!isLiveSharedNotePage(page)) return;
      if (typeof message.enabled !== "boolean") return;
      const layout = layoutPage(shared);
      const originalCard = layout?.system.cards?.[page.id];
      if (!layout || !originalCard) return;
      const storedAttachment = page.system.attachment && typeof page.system.attachment === "object"
        ? deepClone(page.system.attachment) : {};
      const currentlyEnabled = resolveAttachment(page).mainPinEnabled !== false;
      const undoId = typeof message.undoId === "string" && message.undoId
        && message.undoId.length <= MAX_ANCHOR_ID_LENGTH
        ? message.undoId : foundry.utils.randomID();

      if (message.enabled) {
        const hasMain = originalCard.anchors?.main?.kind === "main";
        if (currentlyEnabled && hasMain) return; // already in the requested state
        const anchors = ensureCanonicalMainAnchor(originalCard.anchors, page.system.authorId ?? senderUserId);
        const nextAttachment = { ...storedAttachment, mainPinEnabled: true };
        try {
          if (JSON.stringify(anchors) !== JSON.stringify(originalCard.anchors ?? {})) {
            await layout.update(anchorRestoreChanges(
              page.id, layout.system.cards?.[page.id]?.anchors, anchors));
          }
          if (!currentlyEnabled || page.system.attachment?.mainPinEnabled !== true) {
            await page.update({ "system.attachment": nextAttachment });
          }
        } catch (err) {
          await layout.update(anchorRestoreChanges(
            page.id, layout.system.cards?.[page.id]?.anchors, originalCard.anchors ?? {})).catch(() => {});
          await page.update(objectRestoreChanges(
            "system.attachment", page.system.attachment, storedAttachment)).catch(() => {});
          console.error("Journalinator: enabling the main pin failed", err);
        }
        return;
      }

      // Disabling is destructive for endpoint references: redistribute them atomically.
      const affected = mainPinAffectedLinks(shared, page.id);
      if (!currentlyEnabled && affected.length === 0) return; // already in the requested state
      const originalCards = layout.system.cards ?? {};
      // Validate every affected page/card before generating or writing anything. A trashed source
      // has no live layout card (delete stores it under `system.deleted.lastCard`); its links must
      // still be redistributed so restoring the note cannot reattach them to a disabled main.
      for (const item of affected) {
        if (!item.sourcePage.system.deleted && !originalCards[item.sourcePage.id]) return;
        if (item.sourceOnThis) {
          const targetPage = shared.pages.get(item.link.targetId);
          if (!isLiveSharedNotePage(targetPage) || !originalCards[targetPage.id]) return;
        }
      }

      const workingCards = deepClone(originalCards);
      const hubCard = workingCards[page.id];
      const hubBox = cardBox(page, hubCard);
      // The requesting canvas may know the real measured card size better than the stored card
      // (auto-sized compact/extended cards often have no width/height). Trust only w/h, clamp
      // them, and keep x/y/rotation server-authoritative.
      const clientBox = sanitizeProjectionBox(message.box);
      if (clientBox) {
        hubBox.w = clientBox.w;
        hubBox.h = clientBox.h;
      }
      const pageUpdates = new Map();
      for (const item of affected) {
        const current = pageUpdates.get(item.sourcePage.id) ?? [...(item.sourcePage.system.links ?? [])];
        const index = current.findIndex(link => link.id === item.link.id);
        if (index === -1) return;
        const next = { ...current[index] };
        if (item.routeOnThis) {
          // Route A pin-off policy: keep the original link, drop only the waypoint.
          next.routeAnchors = (next.routeAnchors ?? []).filter(entry =>
            !(entry?.noteId === page.id && entry?.anchorId === MAIN_ANCHOR_ID));
        }
        if (item.sourceOnThis) {
          const targetPage = shared.pages.get(next.targetId);
          const targetCard = workingCards[targetPage.id];
          const toward = endpointWorld(targetPage, targetCard, next, "target");
          const replacement = chooseRedistributionAnchor(hubCard, hubBox, toward, page, senderUserId);
          if (!replacement) return;
          next.sourceAnchorId = replacement.anchorId;
          next.sourcePoint = { x: replacement.anchor.x, y: replacement.anchor.y };
          next.sourceSide = anchorSide(replacement.anchor, hubBox);
          applyEndpointFallback(next, "target", targetPage, targetCard);
        }
        if (item.targetOnThis) {
          const sourceCard = workingCards[item.sourcePage.id]
            ?? item.sourcePage.system?.deleted?.lastCard ?? null;
          const toward = endpointWorld(item.sourcePage, sourceCard, next, "source");
          const replacement = chooseRedistributionAnchor(hubCard, hubBox, toward, page, senderUserId);
          if (!replacement) return;
          next.targetAnchorId = replacement.anchorId;
          next.targetPoint = { x: replacement.anchor.x, y: replacement.anchor.y };
          next.targetSide = anchorSide(replacement.anchor, hubBox);
          applyEndpointFallback(next, "source", item.sourcePage, sourceCard);
        }
        current[index] = next;
        pageUpdates.set(item.sourcePage.id, current);
      }

      const anchorsChanged =
        JSON.stringify(hubCard.anchors ?? {}) !== JSON.stringify(originalCard.anchors ?? {});
      const stateNoteIds = new Set([page.id, ...pageUpdates.keys()]);
      // Capture the raw stored attachment, not resolved defaults: a partial/legacy attachment
      // block must round-trip exactly on undo, including fields this phase does not understand.
      const beforeNotes = [...stateNoteIds].map(noteId => {
        const notePage = shared.pages.get(noteId);
        return {
          noteId,
          links: deepClone(notePage.system.links ?? []),
          ...rawAttachmentState(notePage)
        };
      });
      const beforeAnchors = deepClone(originalCard.anchors ?? {});
      const beforeCard = deepClone(originalCard);
      const nextAttachment = { ...storedAttachment, mainPinEnabled: false };

      try {
        for (const [noteId, nextLinks] of pageUpdates) {
          const notePage = shared.pages.get(noteId);
          const changes = { "system.links": nextLinks };
          if (noteId === page.id) changes["system.attachment"] = nextAttachment;
          await notePage.update(changes);
        }
        if (!pageUpdates.has(page.id)) {
          await page.update({ "system.attachment": nextAttachment });
        }
        if (anchorsChanged) {
          await layout.update(anchorRestoreChanges(
            page.id, layout.system.cards?.[page.id]?.anchors, hubCard.anchors));
        }
      } catch (err) {
        // Restore the exact captured shared state; no link may be lost or half-redistributed.
        for (const state of beforeNotes) {
          const notePage = shared.pages.get(state.noteId);
          await notePage?.update({
            "system.links": deepClone(state.links),
            ...attachmentRestoreChanges(state, notePage.system.attachment)
          }).catch(() => {});
        }
        await layout.update({
          [`system.cards.${page.id}`]: deepClone(beforeCard),
          ...anchorRestoreChanges(
            page.id, layout.system.cards?.[page.id]?.anchors, beforeCard.anchors ?? {})
        }).catch(() => {});
        console.error("Journalinator: disabling the main pin failed", err);
        return;
      }

      // Fingerprints of exactly what this transaction writes. Undo is allowed only while the
      // live links/attachment/anchors still match, so a later edit or re-enable cannot be
      // silently clobbered by a stale Ctrl+Z.
      const afterNotes = [...stateNoteIds].map(noteId => {
        const notePage = shared.pages.get(noteId);
        return {
          noteId,
          links: deepClone(notePage.system.links ?? []),
          ...rawAttachmentState(notePage)
        };
      });
      const afterAnchors = deepClone(layout.system.cards?.[page.id]?.anchors ?? {});
      rememberPinUndo(undoId, {
        noteId: page.id,
        notes: beforeNotes,
        layout: [{ noteId: page.id, anchors: beforeAnchors }],
        after: { notes: afterNotes, anchors: afterAnchors }
      });
      // Acknowledge only after every write landed. The requester pushes its Ctrl+Z entry on this
      // message, so a failed/rolled-back operation never consumes an undo step.
      acknowledgeWriteApplied(senderUserId, { kind: "pin", undoId });
      return;
    }

    case "undoPinChange": {
      // Any client holding the undo id may restore it; the id is client-generated and never
      // broadcast beyond the requesting client's own history stack.
      if (typeof message.undoId !== "string" || !message.undoId) return;
      const entry = pinUndoEntries.get(message.undoId);
      if (!entry) return;
      const layout = layoutPage(shared);
      if (!layout) return;
      for (const state of entry.notes) {
        const notePage = shared.pages.get(state.noteId);
        // A trashed owner is still restorable state; its links were part of the transaction.
        if (!notePage || notePage.type !== `${MODULE_ID}.note`) return;
      }

      // Refuse a stale undo: if any link array, raw attachment or the hub anchor registry has
      // changed since the disable operation, restoring would erase a newer edit or reattach a
      // main pin the user explicitly re-enabled.
      const afterNotes = new Map((entry.after?.notes ?? []).map(state => [state.noteId, state]));
      for (const state of entry.notes) {
        const notePage = shared.pages.get(state.noteId);
        const after = afterNotes.get(state.noteId);
        const currentLinks = notePage.system.links ?? [];
        const currentAttachment = rawAttachmentState(notePage);
        if (!after
            || JSON.stringify(currentLinks) !== JSON.stringify(after.links)
            || currentAttachment.attachmentPresent !== after.attachmentPresent
            || JSON.stringify(currentAttachment.attachment) !== JSON.stringify(after.attachment)) {
          notifyUser(senderUserId, t("JN.Pin.UndoStale"));
          return;
        }
      }
      const card = layout.system.cards?.[entry.noteId];
      if (!card || JSON.stringify(card.anchors ?? {}) !== JSON.stringify(entry.after?.anchors ?? {})) {
        notifyUser(senderUserId, t("JN.Pin.UndoStale"));
        return;
      }

      try {
        for (const state of entry.notes) {
          const notePage = shared.pages.get(state.noteId);
          await notePage.update({
            "system.links": deepClone(state.links),
            ...attachmentRestoreChanges(state, notePage.system.attachment)
          });
        }
        for (const state of entry.layout) {
          // Undo restores only the anchor registry it changed; geometry/labels stay untouched.
          await layout.update(anchorRestoreChanges(
            state.noteId, layout.system.cards?.[state.noteId]?.anchors, state.anchors ?? {}));
        }
        pinUndoEntries.delete(message.undoId);
      } catch (err) {
        console.error("Journalinator: pin undo failed", err);
      }
      return;
    }

    case "routeNoteOnLink": {
      // Shared-only operation. A secret source note or a vault-hidden link is simply absent from
      // the shared journal, so it can never be routed: secret/hidden routing stays out of scope.
      const sourcePage = shared.pages.get(message.sourceId);
      const notePage = shared.pages.get(message.noteId);
      if (!isLiveSharedNotePage(sourcePage) || !isLiveSharedNotePage(notePage)) {
        notifyUser(senderUserId, t("JN.Route.Missing"));
        return;
      }
      if (sourcePage.id === notePage.id) {
        notifyUser(senderUserId, t("JN.Route.Self"));
        return;
      }
      const link = (sourcePage.system.links ?? []).find(item => item.id === message.linkId);
      if (!link) {
        notifyUser(senderUserId, t("JN.Route.Missing"));
        return;
      }
      const targetPage = shared.pages.get(link.targetId);
      if (!isLiveSharedNotePage(targetPage)) {
        notifyUser(senderUserId, t("JN.Route.Missing"));
        return;
      }
      // The inserted note must be neither endpoint of the original relationship.
      if (notePage.id === link.targetId) {
        notifyUser(senderUserId, t("JN.Route.Endpoint"));
        return;
      }
      if (message.mode !== "route" && message.mode !== "split") {
        notifyUser(senderUserId, t("JN.Route.Failed"));
        return;
      }

      if (message.mode === "route") {
        // Route A is a visual waypoint through the note's MAIN pin. It requires the experiment to
        // be on, this note's pin enabled, and a real canonical main anchor on the layout card.
        if (!pinsEnabled()) {
          notifyUser(senderUserId, t("JN.Route.PinOff"));
          return;
        }
        if (resolveAttachment(notePage).mainPinEnabled === false) {
          notifyUser(senderUserId, t("JN.Route.PinOff"));
          return;
        }
        const layout = layoutPage(shared);
        const noteCard = layout?.system.cards?.[notePage.id];
        if (!noteCard || cardAnchor(noteCard, MAIN_ANCHOR_ID)?.kind !== "main") {
          notifyUser(senderUserId, t("JN.Route.PinOff"));
          return;
        }
        const pruned = pruneStaleRouteAnchors(shared, link.routeAnchors, sourcePage.id);
        const insertion = insertRouteWaypoint(pruned.routeAnchors, notePage.id, MAIN_ANCHOR_ID, message.index);
        if (!insertion.ok) {
          notifyUser(senderUserId, t(insertion.reason === "limit"
            ? "JN.Route.Limit" : "JN.Route.Duplicate"));
          return;
        }
        // Server-side validation: only main anchors of live shared notes may enter route data, and
        // a still-secret id can never be published. Keep no route changes on any failure.
        const validated = sanitizeRouteAnchors(insertion.routeAnchors);
        const scoped = validated && sanitizeSharedRouteAnchors(shared, validated, sourcePage.id);
        if (!scoped || scoped.length !== validated.length) {
          notifyUser(senderUserId, t("JN.Route.Stale"));
          return;
        }

        const beforeLinks = deepClone(sourcePage.system.links ?? []);
        const nextLinks = beforeLinks.map(item =>
          item.id === link.id ? { ...item, routeAnchors: scoped } : item);
        try {
          await sourcePage.update({ "system.links": nextLinks });
        } catch (err) {
          await sourcePage.update({ "system.links": deepClone(beforeLinks) }).catch(() => {});
          console.error("Journalinator: route insertion failed", err);
          notifyUser(senderUserId, t("JN.Route.Failed"));
          return;
        }
        const afterLinks = deepClone(sourcePage.system.links ?? []);
        const undoId = routeUndoId(message.undoId);
        rememberRouteUndo(undoId, {
          requesterId: senderUserId,
          kind: "route",
          sourceId: sourcePage.id,
          noteId: sourcePage.id,
          sourceLinks: beforeLinks,
          noteLinks: beforeLinks,
          after: { sourceLinks: afterLinks, noteLinks: afterLinks }
        });
        acknowledgeWriteApplied(senderUserId, { kind: "route", action: "route", undoId });
        // The insertion still succeeded; tell the requester that stale waypoints were cleaned up.
        if (pruned.dropped) notifyUser(senderUserId, t("JN.Route.Stale"));
        return;
      }

      // Route B actually replaces the relationship. Typed links come from note text and must be
      // edited there; board pins/routes would be silently dropped by a split, so require detaching
      // those waypoints first.
      if (link.origin === "typed") {
        notifyUser(senderUserId, t("JN.Route.TypedBlocked"));
        return;
      }
      if (hasBoardPins(link) || hasRouteWaypoints(link)) {
        notifyUser(senderUserId, t("JN.Route.SplitHint"));
        return;
      }
      // A split must not create a relationship that already exists. Either A→C or C→B would be a
      // duplicate link, so the user has to remove the old relationship first instead of silently
      // producing two parallel threads.
      if (hasSharedRelationship(sourcePage, notePage.id) || hasSharedRelationship(notePage, targetPage.id)) {
        notifyUser(senderUserId, t("JN.Route.DuplicateRelationship"));
        return;
      }
      const layout = layoutPage(shared);
      const sourceCard = layout?.system.cards?.[sourcePage.id];
      const targetCard = layout?.system.cards?.[targetPage.id];
      const noteCard = layout?.system.cards?.[notePage.id];
      if (!sourceCard || !targetCard || !noteCard) {
        notifyUser(senderUserId, t("JN.Route.Missing"));
        return;
      }

      const noteTarget = splitNoteEndpoint("target", {
        note: notePage, card: noteCard, toward: endpointWorld(sourcePage, sourceCard, link, "source")
      });
      const noteSource = splitNoteEndpoint("source", {
        note: notePage, card: noteCard, toward: endpointWorld(targetPage, targetCard, link, "target")
      });
      if (!noteTarget || !noteSource) {
        notifyUser(senderUserId, t("JN.Route.Missing"));
        return;
      }

      const usedIds = new Set();
      const firstId = freshLinkId(shared, usedIds);
      const secondId = freshLinkId(shared, usedIds);
      const { first, second } = splitLinkPair({
        link, noteId: notePage.id, firstId, secondId, senderUserId,
        noteFirstEndpoint: noteTarget, noteSecondEndpoint: noteSource
      });
      // Preserve A/B endpoints, but never carry an anchor id whose registry entry vanished.
      clearMissingEndpointAnchor(first, "source", sourceCard);
      clearMissingEndpointAnchor(first, "target", noteCard);
      clearMissingEndpointAnchor(second, "source", noteCard);
      clearMissingEndpointAnchor(second, "target", targetCard);

      const beforeSource = deepClone(sourcePage.system.links ?? []);
      const beforeNote = deepClone(notePage.system.links ?? []);
      const nextSource = beforeSource.filter(item => item.id !== link.id);
      nextSource.push(first);
      const nextNote = [...beforeNote, second];

      // Foundry v14 writes both pages atomically; the fake harness uses the documented fallback.
      try {
        await updateSplitLinkArrays(shared, sourcePage, nextSource, notePage, nextNote);
      } catch (err) {
        await sourcePage.update({ "system.links": deepClone(beforeSource) }).catch(() => {});
        await notePage.update({ "system.links": deepClone(beforeNote) }).catch(() => {});
        console.error("Journalinator: route split failed", err);
        notifyUser(senderUserId, t("JN.Route.Failed"));
        return;
      }

      const afterSource = deepClone(sourcePage.system.links ?? []);
      const afterNote = deepClone(notePage.system.links ?? []);
      const undoId = routeUndoId(message.undoId);
      rememberRouteUndo(undoId, {
        requesterId: senderUserId,
        kind: "split",
        sourceId: sourcePage.id,
        noteId: notePage.id,
        sourceLinks: beforeSource,
        noteLinks: beforeNote,
        after: { sourceLinks: afterSource, noteLinks: afterNote }
      });
      acknowledgeWriteApplied(senderUserId, { kind: "route", action: "split", undoId });
      return;
    }

    case "undoRouteSplit": {
      if (typeof message.undoId !== "string" || !message.undoId) return;
      const entry = routeUndoEntries.get(message.undoId);
      // Missing/consumed ids are an idempotent no-op. Only the client that requested the operation
      // may spend its undo entry; another sender is ignored without a status leak.
      if (!entry) return;
      if (entry.requesterId !== senderUserId) return;
      const states = routeUndoStates(entry);
      for (const state of states) {
        const notePage = shared.pages.get(state.noteId);
        if (!isLiveSharedNotePage(notePage)) {
          notifyUser(senderUserId, t("JN.Route.UndoStale"));
          return;
        }
        // Refuse a stale undo: restoring would erase a later edit to either link array.
        if (JSON.stringify(notePage.system.links ?? []) !== JSON.stringify(state.after)) {
          notifyUser(senderUserId, t("JN.Route.UndoStale"));
          return;
        }
      }
      try {
        for (const state of states) {
          await shared.pages.get(state.noteId).update({ "system.links": deepClone(state.before) });
        }
        routeUndoEntries.delete(message.undoId);
      } catch (err) {
        // Keep the entry so a transient failure can be retried; put back the post-operation state.
        for (const state of states) {
          await shared.pages.get(state.noteId)?.update({
            "system.links": deepClone(state.after)
          }).catch(() => {});
        }
        console.error("Journalinator: route undo failed", err);
      }
      return;
    }

    case "detachRouteNote": {
      const page = shared.pages.get(message.sourceId);
      if (!isLiveSharedNotePage(page)) {
        notifyUser(senderUserId, t("JN.Route.Missing"));
        return;
      }
      if (typeof message.linkId !== "string"
          || typeof message.noteId !== "string" || !DOCUMENT_ID_RE.test(message.noteId)) {
        notifyUser(senderUserId, t("JN.Route.Missing"));
        return;
      }
      const links = page.system.links ?? [];
      const link = links.find(item => item.id === message.linkId);
      if (!link) {
        notifyUser(senderUserId, t("JN.Route.Missing"));
        return;
      }
      const routes = Array.isArray(link.routeAnchors) ? link.routeAnchors : [];
      if (!routes.some(entry => entry?.noteId === message.noteId)) {
        notifyUser(senderUserId, t("JN.Route.NotRouted"));
        return;
      }
      // Only the waypoint goes away. Link id, endpoints, label, cosmetics and direction stay.
      const beforeLinks = deepClone(links);
      const next = links.map(item => item.id === link.id
        ? { ...item, routeAnchors: removeRouteWaypointsFor(routes, message.noteId) }
        : item);
      try {
        await page.update({ "system.links": next });
      } catch (err) {
        await page.update({ "system.links": deepClone(beforeLinks) }).catch(() => {});
        console.error("Journalinator: route detach failed", err);
        notifyUser(senderUserId, t("JN.Route.Failed"));
        return;
      }
      const afterLinks = deepClone(page.system.links ?? []);
      const undoId = routeUndoId(message.undoId);
      rememberRouteUndo(undoId, {
        requesterId: senderUserId,
        kind: "detach",
        sourceId: page.id,
        noteId: page.id,
        sourceLinks: beforeLinks,
        noteLinks: beforeLinks,
        after: { sourceLinks: afterLinks, noteLinks: afterLinks }
      });
      acknowledgeWriteApplied(senderUserId, { kind: "route", action: "detach", undoId });
      return;
    }

    case "clearThreadPins": {
      // Clears only the free board waypoints. Route waypoints, endpoints and cosmetics are
      // untouched; this is the escape hatch for the split policy that refuses pinned threads.
      const page = shared.pages.get(message.noteId);
      if (!isLiveSharedNotePage(page)) {
        notifyUser(senderUserId, t("JN.Route.Missing"));
        return;
      }
      if (typeof message.linkId !== "string") {
        notifyUser(senderUserId, t("JN.Route.Missing"));
        return;
      }
      const links = page.system.links ?? [];
      const link = links.find(item => item.id === message.linkId);
      if (!link) {
        notifyUser(senderUserId, t("JN.Route.Missing"));
        return;
      }
      if (!hasBoardPins(link)) {
        notifyUser(senderUserId, t("JN.Route.NoPins"));
        return;
      }
      const next = links.map(item => item.id === link.id ? { ...item, pins: [] } : item);
      await page.update({ "system.links": next });
      return;
    }

    case "createLink": {
      const page = shared.pages.get(message.sourceId);
      const target = shared.pages.get(message.targetId);
      if (!isLiveSharedNotePage(page) || !isLiveSharedNotePage(target)) return;
      if (page.id === target.id) return;
      const layout = layoutPage(shared);
      const sourceCard = layout?.system.cards?.[page.id];
      const targetCard = layout?.system.cards?.[target.id];
      const allowCreate = pinsEnabled();
      const sourcePlan = planAnchorEndpoint({
        card: sourceCard, note: page, anchorId: message.sourceAnchorId, spec: message.sourceAnchor,
        senderUserId, allowCreate
      });
      const targetPlan = planAnchorEndpoint({
        card: targetCard, note: target, anchorId: message.targetAnchorId, spec: message.targetAnchor,
        senderUserId, allowCreate
      });
      // Validate both endpoints and both cards before any write; a bad second endpoint must not
      // leave a newly generated anchor or a half-written link behind.
      if (sourcePlan === null || targetPlan === null) return;
      if ((sourcePlan?.created || targetPlan?.created) && (!layout || !sourceCard || !targetCard)) return;

      const fields = { ...linkAnchors(message) };
      applyAnchorEndpoint(fields, "source", sourcePlan, cardBox(page, sourceCard));
      applyAnchorEndpoint(fields, "target", targetPlan, cardBox(target, targetCard));

      const links = [...(page.system.links ?? [])];
      const existing = links.findIndex(link => link.targetId === message.targetId);
      const sourceHasEndpoint = !!fields.sourcePoint || !!sourcePlan?.anchor;
      const targetHasEndpoint = !!fields.targetPoint || !!targetPlan?.anchor;
      if (existing !== -1) {
        if (!sourceHasEndpoint || !targetHasEndpoint) return;
        links[existing] = { ...links[existing], ...fields, origin: "drawn", edited: true };
      } else {
        links.push({
          id: foundry.utils.randomID(),
          targetId: message.targetId,
          ...fields,
          // Always store explicit endpoint references. Empty means "use point/side fallback".
          sourceAnchorId: sourcePlan?.anchorId ?? "",
          targetAnchorId: targetPlan?.anchorId ?? "",
          ...defaultLinkCosmetics(),
          // Route authoring is a Phase 6 transactional operation; a client-created link never
          // carries route waypoints until then.
          routeAnchors: [],
          label: "",
          direction: "one",
          color: "",
          lineStyle: "solid",
          origin: "drawn",
          edited: false,
          createdBy: senderUserId
        });
      }

      const layoutChanges = {};
      const originalSourceAnchors = sourceCard?.anchors ?? {};
      const originalTargetAnchors = targetCard?.anchors ?? {};
      if (sourcePlan?.created) {
        layoutChanges[`system.cards.${page.id}.anchors`] = {
          ...originalSourceAnchors, [sourcePlan.anchorId]: sourcePlan.anchor
        };
      }
      if (targetPlan?.created) {
        layoutChanges[`system.cards.${target.id}.anchors`] = {
          ...originalTargetAnchors, [targetPlan.anchorId]: targetPlan.anchor
        };
      }
      try {
        if (Object.keys(layoutChanges).length) await layout.update(layoutChanges);
        await page.update({ "system.links": links });
      } catch (err) {
        // Roll the anchor registry back if the link write (or the layout write) failed.
        const restore = {};
        if (sourcePlan?.created) restore[`system.cards.${page.id}.anchors`] = originalSourceAnchors;
        if (targetPlan?.created) restore[`system.cards.${target.id}.anchors`] = originalTargetAnchors;
        if (Object.keys(restore).length) await layout.update(restore).catch(() => {});
        console.error("Journalinator: link anchor write failed", err);
        return;
      }
      if (existing !== -1) await pruneSharedAnchors(shared, layout, { noteId: page.id, links });
      return;
    }

    case "updateLink": {
      const page = shared.pages.get(message.noteId);
      if (!isLiveSharedNotePage(page)) return;
      const links = page.system.links ?? [];
      const existing = links.find(link => link.id === message.linkId);
      if (!existing) return;
      const layout = layoutPage(shared);
      const targetPage = shared.pages.get(existing.targetId);
      const anchorContext = {
        source: layout?.system.cards?.[page.id]?.anchors ?? {},
        target: isLiveSharedNotePage(targetPage)
          ? layout?.system.cards?.[targetPage.id]?.anchors ?? null : null
      };
      const pins = moveThreadPin(existing.pins, message.fields?.pinMove);
      const fields = pins ? { pins } : sanitizeLinkFields(message.fields, anchorContext);
      if (!fields) return;
      // New endpoint choices may not select a main pin that the owning note has disabled.
      // Existing links that already point there keep rendering; only changing to it is refused.
      if (fields.sourceAnchorId === MAIN_ANCHOR_ID
          && resolveAttachment(page).mainPinEnabled === false) return;
      if (fields.targetAnchorId === MAIN_ANCHOR_ID
          && targetPage && resolveAttachment(targetPage).mainPinEnabled === false) return;
      const nextLinks = links.map(link => {
        if (link.id !== message.linkId) return link;
        const next = { ...link, ...fields, edited: true };
        // Keep the hidden/declassify/legacy fallback in sync with a changed endpoint anchor.
        // Without this, clearing an anchor leaves the old point/side and a later hide/restore
        // would draw the thread at the wrong place.
        if ("sourceAnchorId" in fields) {
          applyEndpointFallback(next, "source", page, layout?.system.cards?.[page.id]);
        }
        if ("targetAnchorId" in fields) {
          applyEndpointFallback(next, "target", targetPage, layout?.system.cards?.[targetPage?.id]);
        }
        return next;
      });
      await page.update({ "system.links": nextLinks });
      // Clearing or moving an endpoint may orphan a minor pin; never remove a main pin here.
      if ("sourceAnchorId" in fields || "targetAnchorId" in fields) {
        await pruneSharedAnchors(shared, layout);
      }
      return;
    }

    case "deleteLink": {
      const page = shared.pages.get(message.noteId);
      if (!isLiveSharedNotePage(page)) return;
      const links = (page.system.links ?? []).filter(link => link.id !== message.linkId);
      await page.update({ "system.links": links });
      await pruneSharedAnchors(shared, layoutPage(shared), { noteId: page.id, links });
      return;
    }


    case "deleteNote": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      const layout = layoutPage(shared);
      const lastCard = layout?.system.cards[message.noteId] ?? null;
      const undoId = typeof message.undoId === "string" && DOCUMENT_ID_RE.test(message.undoId)
        ? message.undoId : null;
      // Route A deletion policy: remove only this note's waypoints from every shared link (trashed
      // owners included, so a later restore cannot reattach them). Links and their ids survive.
      const cleanup = routeWaypointCleanup(shared, page.id);
      try {
        for (const update of cleanup.updates) {
          await shared.pages.get(update.noteId)?.update({ "system.links": update.links });
        }
        await page.update({ "system.deleted": { at: Date.now(), by: senderUserId, lastCard, undoId } });
      } catch (err) {
        // Roll the route arrays back; a failed delete must not silently strip waypoints.
        for (const state of cleanup.before) {
          await shared.pages.get(state.noteId)?.update({
            "system.links": deepClone(state.links)
          }).catch(() => {});
        }
        console.error("Journalinator: note deletion failed", err);
        return;
      }
      if (layout) await layout.update({ [`system.cards.-=${message.noteId}`]: null });
      // Confirm only after the note and its card both landed. The requester shows the recovery
      // notice from this ack, so a failed or rolled-back delete never claims success.
      acknowledgeWriteApplied(senderUserId, { kind: "delete", undoId });
      return;
    }

    case "restoreNote": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || !page.system.deleted) return;
      if (message.undoId !== undefined
          && (typeof message.undoId !== "string" || !DOCUMENT_ID_RE.test(message.undoId)
            || page.system.deleted.undoId !== message.undoId || page.system.deleted.by !== senderUserId)) return;
      const layout = layoutPage(shared);
      const lastCard = page.system.deleted.lastCard;
      const cardSize = card => {
        const width = card?.sizing?.mode === "manual" ? card.sizing.width : card?.width;
        const height = card?.sizing?.mode === "manual" ? card.sizing.minHeight : card?.height;
        return {
          w: Number.isFinite(width) && width > 0 ? width : 220,
          h: Number.isFinite(height) && height > 0 ? height : 120
        };
      };
      let spot;
      if (layout && lastCard) {
        const cards = layout.system.cards ?? {};
        const { w, h } = cardSize(lastCard);
        const occupied = Object.values(cards).some(c => {
          const size = cardSize(c);
          return !(lastCard.x + w + 16 < c.x || lastCard.x > c.x + size.w + 16
            || lastCard.y + h + 16 < c.y || lastCard.y > c.y + size.h + 16);
        });
        spot = occupied ? findFreeSpot(cards, w, h, lastCard.x, lastCard.y) : { x: lastCard.x, y: lastCard.y };
      } else {
        spot = findFreeSpot(layout?.system.cards ?? {}, 220, 120, 0, 0);
      }

      // The Foundry page name is a permanent `jn-note-<id>` value; restore never renames it.
      await page.update({ "system.deleted": null });
      if (layout) {
        // Copy the whole stored card back instead of hand-picking geometry, so anchor registries
        // (and any future card fields) survive a trash/restore roundtrip.
        const restoredCard = lastCard
          ? { ...foundry.utils.deepClone(lastCard), x: spot.x, y: spot.y, ports: cardPorts(lastCard) }
          : {
            x: spot.x, y: spot.y,
            sizing: { mode: "auto", width: null, minHeight: null },
            autoSizeOrigin: { x: spot.x + 110, y: spot.y },
            rotation: 0, ports: cardPorts(lastCard)
          };
        // Restoring an old main pin must not reattach a main the note had deliberately disabled.
        // Stored anchors (including a retained main) are copied; only a missing main is invented
        // when the attachment still wants one.
        const restoredAnchors = sanitizeCardAnchors(restoredCard.anchors);
        restoredCard.anchors = resolveAttachment(page).mainPinEnabled
          ? addMainAnchor(restoredAnchors, page.system.authorId ?? "")
          : restoredAnchors;
        await layout.update({ [`system.cards.${message.noteId}`]: restoredCard });
      }
      return;
    }

    case "emptyTrash": {
      if (!game.users.get(senderUserId)?.isGM) return; // only the GM may permanently empty the trash (spec §10/§11)
      const trashed = shared.pages.filter(p => p.type === `${MODULE_ID}.note` && p.system.deleted);
      const trashedIds = new Set(trashed.map(p => p.id));
      await JournalEntryPage.deleteDocuments([...trashedIds], { parent: shared });
      const layout = layoutPage(shared);
      const labelUpdates = Object.fromEntries(Object.entries(layout?.system.labels ?? {})
        .filter(([, label]) => trashedIds.has(label.noteId))
        .map(([id]) => [`system.labels.-=${id}`, null]));
      if (Object.keys(labelUpdates).length) await layout.update(labelUpdates);
      // Permanent deletion can leave a live shared link pointing at a card that no longer exists;
      // prune any minor anchors that lost their last reference. Soft delete keeps its stored card.
      if (layout) await pruneSharedAnchors(shared, layout);
      const ids2 = getContainerIds();
      const historyPage = ids2?.historyPage ? game.journal.get(ids2.history)?.pages.get(ids2.historyPage) : null;
      if (historyPage) {
        const updates = {};
        for (const p of trashed) updates[`system.snapshots.-=${p.id}`] = null;
        if (Object.keys(updates).length) await historyPage.update(updates);
      }
      return;
    }

  }
}

// --- Whole-note edit protocol ---------------------------------------------------------------

function publicLeaseFor(noteId) {
  return authoritySnapshot(noteId)[0]?.lease ?? null;
}

function replyBase(requestId, senderUserId, noteId) {
  return { requestId, forUserId: senderUserId, noteId };
}

function rejectedBody(requestId, senderUserId, noteId, reason, revision, receipt) {
  return {
    type: "noteSaveRejected",
    ...replyBase(requestId, senderUserId, noteId),
    reason,
    revision: Number.isInteger(revision) ? revision : 0,
    ...(receipt ? { receipt } : {})
  };
}

function notePageIn(shared, noteId) {
  if (typeof noteId !== "string") return null;
  const page = shared.pages.get(noteId);
  return page?.type === `${MODULE_ID}.note` ? page : null;
}

/** The verified socket sender must be the lease's user; a payload `userId` proves nothing. */
function senderOwnsLease(lease, senderUserId) {
  return !!lease && typeof lease === "object" && lease.userId === senderUserId;
}

async function applyGeometryPatch(layout, noteId, geometry) {
  const changes = {};
  if (geometry.sizing) changes[`system.cards.${noteId}.sizing`] = geometry.sizing;
  if (geometry.autoSizeOrigin) changes[`system.cards.${noteId}.autoSizeOrigin`] = geometry.autoSizeOrigin;
  for (const field of ["x", "y"]) {
    if (geometry[field] !== undefined) changes[`system.cards.${noteId}.${field}`] = geometry[field];
  }
  if (Object.keys(changes).length) await layout.update(changes);
}

async function handleCreateNote(shared, message, senderUserId) {
  const requestId = requestIdOf(message.requestId) ?? foundry.utils.randomID();
  if (!sharedWorldWritable(shared)) {
    return {
      type: "noteCreateRejected",
      ...replyBase(requestId, senderUserId, null),
      reason: "incompatible"
    };
  }
  const created = await createV2NotePage(shared, message, senderUserId);
  if (created.error) {
    return {
      type: "noteCreateRejected",
      ...replyBase(requestId, senderUserId, null),
      reason: created.error
    };
  }

  const { page, card, skin } = created;
  const reply = {
    type: "noteCreated",
    ...replyBase(requestId, senderUserId, page.id),
    revision: 0,
    body: page.system.body,
    layout: page.system.layout,
    skin,
    card,
    authorId: page.system.authorId,
    createdAt: page.system.createdAt,
    updatedAt: page.system.updatedAt,
    attachment: deepClone(page.system.attachment ?? null),
    links: deepClone(page.system.links ?? []),
    deleted: page.system.deleted ?? false,
    lastSave: page.system.lastSave ? deepClone(page.system.lastSave) : null
  };

  if (message.requestEdit === true) {
    const session = sessionIdOf(message.clientSessionId) ?? requestId;
    const user = game.users.get(senderUserId);
    const grant = grantLease({
      noteId: page.id,
      userId: senderUserId,
      userName: user?.name ?? "",
      userColor: user?.color ?? "",
      clientSessionId: session,
      requestId,
      revision: 0
    });
    if (grant.lease) {
      reply.lease = grant.lease;
      reply.expiresAt = grant.expiresAt;
      broadcastLeaseChanged(page.id, publicLeaseFor(page.id), null, authorityEpoch());
      Hooks.callAll("journalinatorNoteEditBegan", {
        noteId: page.id,
        authorId: senderUserId,
        revision: 0,
        body: page.system.body
      });
    }
  }
  return reply;
}

async function handleBeginNoteEdit(shared, message, senderUserId) {
  const requestId = requestIdOf(message.requestId) ?? foundry.utils.randomID();
  const deny = (reason, extra = {}) => ({
    type: "noteEditDenied",
    ...replyBase(requestId, senderUserId, message.noteId),
    reason,
    ...extra
  });

  if (!sharedWorldWritable(shared)) return deny("incompatible");
  if (typeof message.noteId !== "string") return deny("missing");
  const page = notePageIn(shared, message.noteId);
  if (!page) return deny("missing");
  const problem = noteSchemaProblem(page);
  if (problem) return deny("incompatible");
  if (page.system.deleted) return deny("trashed");

  const session = sessionIdOf(message.clientSessionId);
  if (!session) return deny("invalid");
  const user = game.users.get(senderUserId);
  if (!user) return deny("invalid");

  const grant = grantLease({
    noteId: page.id,
    userId: senderUserId,
    userName: user.name ?? "",
    userColor: user.color ?? "",
    clientSessionId: session,
    requestId,
    revision: page.system.revision
  });
  if (!grant.lease) {
    return deny(grant.reason ?? "locked", grant.holder ? { holder: grant.holder } : {});
  }

  setAuthorityRevision(page.id, page.system.revision);
  if (!grant.existing) {
    broadcastLeaseChanged(page.id, publicLeaseFor(page.id), null, authorityEpoch());
    Hooks.callAll("journalinatorNoteEditBegan", {
      noteId: page.id,
      authorId: senderUserId,
      revision: page.system.revision,
      body: page.system.body
    });
  }

  return {
    type: "noteEditGranted",
    ...replyBase(requestId, senderUserId, page.id),
    lease: grant.lease,
    revision: page.system.revision,
    body: page.system.body,
    layout: page.system.layout,
    skin: page.system.skin,
    deleted: false,
    lastSave: page.system.lastSave ?? null,
    expiresAt: grant.expiresAt
  };
}

function handleNoteHeartbeat(shared, message, senderUserId) {
  const requestId = requestIdOf(message.requestId) ?? foundry.utils.randomID();
  const lease = message.lease;
  const result = senderOwnsLease(lease, senderUserId)
    ? heartbeatLease(lease)
    : { ok: false, reason: "leaseLost" };
  if (!result.ok) {
    if (lease && typeof lease.noteId === "string") {
      // A stale heartbeat (same user's old tab, or a token superseded by force/re-grant)
      // must not clear a newer authoritative lease from every client mirror. Only revoke
      // when authority has no lease left or still holds exactly this lease.
      const current = leaseFor(lease.noteId);
      const authorityGone = !current
        || (current.leaseToken === lease.leaseToken
          && current.clientSessionId === lease.clientSessionId
          && current.userId === lease.userId);
      if (authorityGone) {
        const page = notePageIn(shared, lease.noteId);
        broadcastRevoked({
          noteId: lease.noteId,
          leaseToken: lease.leaseToken,
          gmEpoch: lease.gmEpoch,
          reason: result.reason === "failover" ? "failover" : "expired",
          revision: page?.system?.revision ?? 0
        });
        broadcastLeaseChanged(lease.noteId, null, null, authorityEpoch());
      }
    }
    return null;
  }

  const page = notePageIn(shared, lease.noteId);
  if (!page || page.system.deleted) {
    broadcastRevoked({
      noteId: lease.noteId,
      leaseToken: lease.leaseToken,
      gmEpoch: lease.gmEpoch,
      reason: "ended",
      revision: page?.system?.revision ?? 0
    });
    return null;
  }
  setAuthorityRevision(page.id, page.system.revision);
  return {
    type: "noteEditHeartbeatAck",
    ...replyBase(requestId, senderUserId, page.id),
    leaseToken: lease.leaseToken,
    gmEpoch: authorityEpoch(),
    revision: page.system.revision,
    expiresAt: result.expiresAt
  };
}

function handlePreview(shared, message, senderUserId) {
  const lease = message.lease;
  if (!senderOwnsLease(lease, senderUserId)) return null;
  const result = setPreview(lease, message.sequence, message.body);
  if (!result.ok) return null;
  const page = notePageIn(shared, lease.noteId);
  if (!page || page.system.deleted) return null;
  broadcastPreview(result.preview, senderUserId);
  return null;
}

async function performBodySave(shared, message, senderUserId) {
  const requestId = requestIdOf(message.requestId) ?? foundry.utils.randomID();
  const noteId = message.noteId;
  const page = notePageIn(shared, noteId);
  if (!sharedWorldWritable(shared)) {
    return rejectedBody(requestId, senderUserId, noteId, "incompatible", page?.system.revision ?? 0);
  }
  if (!page) return rejectedBody(requestId, senderUserId, noteId, "missing", 0);
  const problem = noteSchemaProblem(page);
  if (problem) return rejectedBody(requestId, senderUserId, noteId, "incompatible", page.system.revision ?? 0);
  if (page.system.deleted) return rejectedBody(requestId, senderUserId, noteId, "trashed", page.system.revision ?? 0);

  const lease = message.lease;
  if (!isLeaseValid(lease) || !senderOwnsLease(lease, senderUserId)) {
    return rejectedBody(requestId, senderUserId, noteId, "leaseLost", page.system.revision ?? 0,
      page.system.lastSave ?? undefined);
  }

  const sequence = message.sequence;
  const baseRevision = message.baseRevision;
  const body = message.body;
  if (!Number.isInteger(sequence) || sequence < 0) {
    return rejectedBody(requestId, senderUserId, noteId, "invalid", page.system.revision ?? 0);
  }
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    return rejectedBody(requestId, senderUserId, noteId, "invalid", page.system.revision ?? 0);
  }
  if (typeof body !== "string") {
    return rejectedBody(requestId, senderUserId, noteId, "invalid", page.system.revision ?? 0);
  }
  if (body.length > MAX_NOTE_BODY_LENGTH) {
    return rejectedBody(requestId, senderUserId, noteId, "tooLarge", page.system.revision ?? 0);
  }
  const eventIds = cleanEventIds(message.eventIds);
  if (eventIds === null) {
    return rejectedBody(requestId, senderUserId, noteId, "invalid", page.system.revision ?? 0);
  }
  const geometry = cleanGeometry(message.geometry);
  if (geometry === null) {
    return rejectedBody(requestId, senderUserId, noteId, "invalid", page.system.revision ?? 0);
  }
  const layout = geometry ? layoutPage(shared) : null;
  if (geometry && (!layout || !layout.system.cards?.[noteId])) {
    return rejectedBody(requestId, senderUserId, noteId, "invalid", page.system.revision ?? 0);
  }

  const bodyHash = noteBodyHash(body);
  const currentRevision = page.system.revision ?? 0;
  const previousBody = page.system.body ?? "";
  const last = page.system.lastSave;

  if (last && last.requestId === requestId
      && last.clientSessionId === lease.clientSessionId
      && last.sequence === sequence
      && last.bodyHash === bodyHash) {
    return {
      type: "noteSaveAck",
      ...replyBase(requestId, senderUserId, noteId),
      leaseToken: lease.leaseToken,
      gmEpoch: authorityEpoch(),
      revision: last.revision,
      sequence: last.sequence,
      bodyHash: last.bodyHash,
      acceptedAt: last.at,
      receipt: last
    };
  }

  if (last && last.clientSessionId === lease.clientSessionId
      && Number.isInteger(last.sequence) && sequence < last.sequence) {
    return rejectedBody(requestId, senderUserId, noteId, "sequenceOutOfOrder", currentRevision, last);
  }

  if (body === previousBody) {
    return {
      type: "noteSaveAck",
      ...replyBase(requestId, senderUserId, noteId),
      leaseToken: lease.leaseToken,
      gmEpoch: authorityEpoch(),
      revision: currentRevision,
      sequence,
      bodyHash,
      acceptedAt: Date.now(),
      ...(last ? { receipt: last } : {})
    };
  }

  if (baseRevision !== currentRevision) {
    return rejectedBody(requestId, senderUserId, noteId, "staleRevision", currentRevision, last ?? undefined);
  }

  const revision = currentRevision + 1;
  const acceptedAt = Date.now();
  const saveIdentity = {
    requestId,
    clientSessionId: lease.clientSessionId,
    sequence,
    revision,
    bodyHash,
    at: acceptedAt,
    eventIds
  };
  try {
    if (geometry) await applyGeometryPatch(layout, noteId, geometry);
    await page.update({
      "system.body": body,
      "system.revision": revision,
      "system.updatedAt": acceptedAt,
      "system.lastSave": saveIdentity
    });
  } catch (err) {
    console.error("Journalinator: note body save failed", err);
    return rejectedBody(requestId, senderUserId, noteId, "invalid", page.system.revision ?? currentRevision);
  }

  setAuthorityRevision(noteId, revision);
  Hooks.callAll("journalinatorNoteSaved", {
    noteId,
    page,
    previousBody,
    body,
    previousRevision: currentRevision,
    revision,
    authorId: senderUserId,
    saveIdentity
  });
  return {
    type: "noteSaveAck",
    ...replyBase(requestId, senderUserId, noteId),
    leaseToken: lease.leaseToken,
    gmEpoch: authorityEpoch(),
    revision,
    sequence,
    bodyHash,
    acceptedAt,
    receipt: saveIdentity
  };
}

async function handleAppearanceSave(shared, message, senderUserId) {
  const requestId = requestIdOf(message.requestId) ?? foundry.utils.randomID();
  const noteId = message.noteId;
  const reject = reason => ({
    type: "noteAppearanceRejected",
    ...replyBase(requestId, senderUserId, noteId),
    reason
  });
  if (!sharedWorldWritable(shared)) return reject("incompatible");
  const page = notePageIn(shared, noteId);
  if (!page) return reject("missing");
  if (noteSchemaProblem(page)) return reject("incompatible");
  if (page.system.deleted) return reject("trashed");
  if (!isLeaseValid(message.lease) || !senderOwnsLease(message.lease, senderUserId)) {
    return reject("leaseLost");
  }
  if (!isLayout(message.layout)) return reject("invalid");
  const skin = cleanNoteSkin(message.skin);
  if (!skin) return reject("invalid");

  const updatedAt = Date.now();
  try {
    await page.update({
      "system.layout": message.layout,
      "system.skin": skin,
      "system.updatedAt": updatedAt
    });
  } catch (err) {
    console.error("Journalinator: note appearance save failed", err);
    return reject("invalid");
  }
  return {
    type: "noteAppearanceAck",
    ...replyBase(requestId, senderUserId, noteId),
    layout: message.layout,
    skin,
    updatedAt
  };
}

async function handleEndNoteEdit(shared, message, senderUserId) {
  const requestId = requestIdOf(message.requestId) ?? foundry.utils.randomID();
  const page = notePageIn(shared, message.noteId);
  const lease = message.lease;
  const ended = (revision, saved, released) => ({
    type: "noteEditEnded",
    ...replyBase(requestId, senderUserId, message.noteId),
    revision,
    saved,
    released
  });
  if (!page) return ended(0, false, false);
  if (noteSchemaProblem(page)) {
    return {
      type: "noteEditEnded",
      ...replyBase(requestId, senderUserId, message.noteId),
      revision: page.system.revision ?? 0,
      saved: false,
      released: false
    };
  }
  if (!isLeaseValid(lease) || !senderOwnsLease(lease, senderUserId)) {
    return ended(page.system.revision ?? 0, false, false);
  }

  const priorRevision = page.system.revision ?? 0;
  let saved = false;
  if (message.body !== undefined) {
    const flush = await performBodySave(shared, {
      ...message,
      requestId,
      sequence: message.sequence ?? 0,
      baseRevision: message.baseRevision ?? priorRevision
    }, senderUserId);
    if (flush.type === "noteSaveRejected") return flush;
    saved = flush.revision > priorRevision;
  }

  const revision = page.system.revision ?? priorRevision;
  const released = releaseLease(lease, "ended").ok;
  broadcastRevoked({
    noteId: message.noteId,
    leaseToken: lease.leaseToken,
    gmEpoch: authorityEpoch(),
    reason: "ended",
    revision
  });
  broadcastLeaseChanged(message.noteId, null, null, authorityEpoch());
  Hooks.callAll("journalinatorNoteEditEnded", {
    noteId: message.noteId,
    authorId: senderUserId,
    revision,
    saved
  });
  return ended(revision, saved, released);
}

function handleForceUnlock(shared, message, senderUserId) {
  const requestId = requestIdOf(message.requestId) ?? foundry.utils.randomID();
  if (!senderIsGM(senderUserId)) {
    return {
      type: "noteEditDenied",
      ...replyBase(requestId, senderUserId, message.noteId),
      reason: "invalid"
    };
  }
  const page = notePageIn(shared, message.noteId);
  const revision = page?.system.revision ?? 0;
  const previous = leaseFor(message.noteId);
  if (previous) {
    consumeLease(message.noteId);
    broadcastRevoked({
      noteId: message.noteId,
      leaseToken: previous.leaseToken,
      gmEpoch: authorityEpoch(),
      reason: "forced",
      revision,
      byUserId: senderUserId
    });
    broadcastLeaseChanged(message.noteId, null, null, authorityEpoch());
    Hooks.callAll("journalinatorNoteForceUnlocked", {
      noteId: message.noteId,
      previousUserId: previous.userId,
      byUserId: senderUserId
    });
  }
  return {
    type: "noteEditForced",
    ...replyBase(requestId, senderUserId, message.noteId),
    previousLease: previous,
    revision,
    byUserId: senderUserId
  };
}

function handleEditState(shared, message, senderUserId) {
  const requestId = requestIdOf(message.requestId) ?? foundry.utils.randomID();
  if (!authorityEpoch()) initializeAuthority();
  const pages = message.noteId === undefined
    ? allSharedNoteList(shared)
    : [notePageIn(shared, message.noteId)].filter(Boolean);
  const notes = pages.map(page => {
    const snapshot = authoritySnapshot(page.id)[0];
    return {
      noteId: page.id,
      revision: Number.isInteger(page.system.revision) ? page.system.revision : 0,
      deleted: !!page.system.deleted,
      lease: snapshot?.lease ?? null,
      preview: getAuthorityPreview(page.id)
    };
  });
  return {
    type: "noteEditState",
    requestId,
    forUserId: senderUserId,
    gmEpoch: authorityEpoch(),
    at: Date.now(),
    notes
  };
}

async function handleEditCommand(shared, message, senderUserId) {
  switch (message.type) {
    case "createNote": return handleCreateNote(shared, message, senderUserId);
    case "beginNoteEdit": return handleBeginNoteEdit(shared, message, senderUserId);
    case "noteEditHeartbeat": return handleNoteHeartbeat(shared, message, senderUserId);
    case "previewNoteBody": return handlePreview(shared, message, senderUserId);
    case "saveNoteBody": return performBodySave(shared, message, senderUserId);
    case "saveNoteAppearance": return handleAppearanceSave(shared, message, senderUserId);
    case "endNoteEdit": return handleEndNoteEdit(shared, message, senderUserId);
    case "forceUnlockNote": return handleForceUnlock(shared, message, senderUserId);
    case "requestNoteEditState": return handleEditState(shared, message, senderUserId);
    default: return null;
  }
}

function noActiveGMReply(message) {
  const requestId = requestIdOf(message.requestId) ?? foundry.utils.randomID();
  const base = { requestId, forUserId: game.user.id };
  switch (message.type) {
    case "createNote":
      return { type: "noteCreateRejected", ...base, noteId: null, reason: "noActiveGM" };
    case "beginNoteEdit":
    case "saveNoteBody":
    case "saveNoteAppearance":
    case "endNoteEdit":
    case "forceUnlockNote":
      return {
        type: "noteEditDenied", ...base, noteId: message.noteId ?? null, reason: "noActiveGM"
      };
    case "requestNoteEditState":
      return {
        type: "noteEditState", ...base, gmEpoch: null, at: Date.now(), notes: []
      };
    default:
      return { type: "timeout", requestId };
  }
}

/** Resolves a targeted edit reply. Replies from a non-active GM are rejected by the caller. */
function resolvePendingEditReply(message) {
  if (!message?.requestId) return false;
  const pending = pendingEditReplies.get(message.requestId);
  if (!pending || pending.forUserId !== message.forUserId) return false;
  pendingEditReplies.delete(message.requestId);
  clearTimeout(pending.timer);
  pending.resolve(message);
  return true;
}

function sendTargetedReply(reply, senderUserId) {
  if (!reply || !reply.type || reply.type === "timeout") return;
  reply.forUserId = reply.forUserId ?? senderUserId;
  if (reply.forUserId !== senderUserId) return;
  if (senderUserId === game.user.id) return;
  game.socket.emit(CHANNEL, reply, { recipients: [senderUserId] });
}

/**
 * Sends a protocol request and waits for the targeted reply with the same `requestId`.
 * A timeout resolves with `{type:"timeout",requestId}` instead of rejecting, because a
 * missing acknowledgement is uncertain (retry/reconcile), not proof of failure.
 */
export async function requestEditReply(message, { timeoutMs = 10000 } = {}) {
  const requestId = requestIdOf(message?.requestId) ?? foundry.utils.randomID();
  const payload = { ...message, requestId };
  if ((payload.type === "beginNoteEdit" || payload.type === "createNote")
      && !sessionIdOf(payload.clientSessionId)) {
    payload.clientSessionId = clientSessionId;
  }

  const activeGM = game.users.activeGM;
  if (!activeGM) return noActiveGMReply(payload);

  if (activeGM.id === game.user.id) {
    const reply = await enqueueWrite(payload, game.user.id);
    if (reply?.type === "noteEditState") applyEditState(reply.notes, reply.gmEpoch);
    return reply ?? { type: "timeout", requestId };
  }

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (!pendingEditReplies.has(requestId)) return;
      pendingEditReplies.delete(requestId);
      resolve({ type: "timeout", requestId });
    }, Math.max(0, timeoutMs));
    timer.unref?.();
    pendingEditReplies.set(requestId, {
      forUserId: game.user.id,
      resolve,
      timer
    });
    game.socket.emit(CHANNEL, payload, { recipients: [activeGM.id] });
  });
}

/**
 * Sends a write request to the active GM. If we are the active GM, applies it directly.
 *
 * Requests are addressed to the active GM only (the server's custom-socket relay honours
 * `recipients`, see dist/server/sockets.mjs handleCustomSocket). Plain emits are broadcast to
 * every client, which would hand a GM's declassification payload to players before the active
 * GM had accepted it.
 */
export function requestWrite(message) {
  const activeGM = game.users.activeGM;
  if (!activeGM) {
    warnNoGM();
    return Promise.resolve(false);
  }
  if (activeGM.id === game.user.id) {
    return enqueueWrite(message, game.user.id);
  }
  game.socket.emit(CHANNEL, message, { recipients: [activeGM.id] });
}

/**
 * T4b guard helpers. Not applied to pin/link/route/transfer/delete/geometry handlers yet;
 * those get the guard in the lock-enforcement task.
 */
export function assertNoteUnlocked(noteId) {
  return assertUnlocked([noteId]);
}

export function assertNotesUnlocked(noteIds) {
  return assertUnlocked(noteIds);
}

export { noteBodyHash };
