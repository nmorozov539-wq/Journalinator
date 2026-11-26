import { getContainerIds } from "./store/containers.mjs";
import { privateStore } from "./store/private-store.mjs";
import { CARD_STYLES, seedTilt } from "./styles/registry.mjs";
import {
  CARD_SIDES, cardPointAnchor, cardPorts, linkAnchors, moveThreadPin, validCardPorts, validLinkPoint
} from "./card-ports.mjs";
import {
  MAIN_ANCHOR_ID, anchorSide, anchorWorld, canonicalizeMainAnchors, collectAnchorRefs,
  defaultMainAnchor, pruneAnchorRegistry, projectToEdge, redistributionAnchor, validAnchorId
} from "./anchors.mjs";
import { isLinkColor, normalizeLinkColor } from "./link-colors.mjs";
import { noteImagePath } from "./image-url.mjs";
import { reconcileTypedLinks } from "./wikilinks.mjs";
import { maybeSnapshot } from "./snapshots.mjs";
import { recordActivity, addSessionMarker } from "./stats.mjs";
import {
  authoritativeRequestLock, authoritativeReleaseLock, authoritativeHeartbeat,
  authoritativeHolds, authoritativeSnapshot, receiveLockBroadcast, authoritativeLockHolder
} from "./locks.mjs";
import { t } from "./i18n.mjs";
import { attachedStampIds, DEFAULT_STAMP_CORNER, isStampCorner, stampUrl } from "./stamps.mjs";
import { normalizeActorRef } from "./actor-status.mjs";
import {
  LINK_ENDS, LINK_MATERIALS, LINK_PATTERNS, LINK_SLACK, LINK_THICKNESS,
  MAIN_PIN, MAX_CARD_ANCHORS, NOTE_FONT_KEYS, PICTURE_LAYOUTS, PIN_STYLES, PRESENTATION_STYLES,
  classifyNote, defaultLinkCosmetics, isGeneratedTitle, legacyPresentation, legacyStylePresentation,
  resolveAttachment, resolvePresentation, sanitizeCardAnchors, stripSecretPrefix
} from "./presentation.mjs";

export { sanitizeCardAnchors };

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
const LINK_MATERIAL_SET = new Set(LINK_MATERIALS);
const LINK_PATTERN_SET = new Set(LINK_PATTERNS);
const LINK_END_SET = new Set(LINK_ENDS);
const PRESENTATION_STYLE_SET = new Set(PRESENTATION_STYLES);
const PICTURE_LAYOUT_SET = new Set(PICTURE_LAYOUTS);
const NOTE_FONT_SET = new Set(NOTE_FONT_KEYS);
const PIN_STYLE_SET = new Set(PIN_STYLES);
const PRESENTATION_KEYS = new Set([
  "extendedStyle", "forceExtended", "font", "pictureLayout", "torn", "heading", "nameGenerated"
]);
// `mainPinEnabled` is deliberately absent: the generic attachment batch path must never bypass
// destructive main-pin redistribution. Shared enabling/disabling goes through setMainPinEnabled.
const ATTACHMENT_KEYS = new Set(["mainSnapRadius", "minorSnapRadius", "pinStyle"]);
const DOCUMENT_ID_RE = /^[a-zA-Z0-9]{16}$/;
const MAX_DECLASSIFIED_BLOCKS = 500;
const MAX_DECLASSIFIED_LINKS = 200;
const MAX_NOTE_BATCH = 50;
const MAX_ANCHOR_ID_LENGTH = 100;
const MAX_ROUTE_ANCHORS = 24;
const MAX_HEADING_LENGTH = 80;
const MAX_FORMER_NAMES = 20;
const PIN_UNDO_LIMIT = 20;
const PIN_REDISTRIBUTION_SNAP = 12;

/**
 * In-memory, per-active-GM undo register for one atomic main-pin redistribution.
 *
 * Phase 5 limitation: undo is active-GM state only, in-memory, capped at PIN_UNDO_LIMIT and lost
 * on failover/reload. Each entry stores post-operation fingerprints; an undo whose affected
 * links/attachments/anchors changed afterwards is refused (JN.Pin.UndoStale) instead of
 * clobbering newer edits.
 */
const pinUndoEntries = new Map();

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

/** Tell the user once in a while why their edit did not apply while the board is read-only. */
function warnNoGM() {
  const now = Date.now();
  if (now - offlineNoticeAt < 5000) return;
  offlineNoticeAt = now;
  ui.notifications?.warn(t("JN.TopBar.Offline"));
}

/**
 * Case-insensitive lookup among live (non-deleted) notes.
 *
 * Everything in this file reads the *shared* journal only — never notesStore, never the vault —
 * even when this client is a GM with secrets unlocked. That is what keeps a player from probing
 * secret titles (a duplicate-title rejection, a typed [[link]] resolving to a hidden note, a
 * free-spot search that avoids hidden cards would each leak one).
 */
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
  const stem = (base ?? "").trim() || t("JN.Note.Untitled");
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
function attachmentRestoreChanges(state) {
  return state.attachmentPresent
    ? { "system.attachment": deepClone(state.attachment) }
    : { "system.-=attachment": null };
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
 * Presentation patches are strict: an unknown or malformed key rejects the whole patch instead of
 * silently storing a partially applied style change. Content, label and permissions are untouched.
 */
export function sanitizePresentationFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  if (Object.keys(fields).some(key => !PRESENTATION_KEYS.has(key))) return null;
  const clean = {};
  if ("extendedStyle" in fields) {
    if (!PRESENTATION_STYLE_SET.has(fields.extendedStyle)) return null;
    clean.extendedStyle = fields.extendedStyle;
  }
  if ("forceExtended" in fields) {
    if (typeof fields.forceExtended !== "boolean") return null;
    clean.forceExtended = fields.forceExtended;
  }
  if ("font" in fields) {
    if (!NOTE_FONT_SET.has(fields.font)) return null;
    clean.font = fields.font;
  }
  if ("pictureLayout" in fields) {
    if (!PICTURE_LAYOUT_SET.has(fields.pictureLayout)) return null;
    clean.pictureLayout = fields.pictureLayout;
  }
  if ("torn" in fields) {
    if (typeof fields.torn !== "boolean") return null;
    clean.torn = fields.torn;
  }
  if ("heading" in fields) {
    if (typeof fields.heading !== "string" || fields.heading.length > MAX_HEADING_LENGTH) return null;
    clean.heading = fields.heading.trim();
  }
  if ("nameGenerated" in fields) {
    if (typeof fields.nameGenerated !== "boolean") return null;
    clean.nameGenerated = fields.nameGenerated;
  }
  return Object.keys(clean).length ? clean : null;
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

/** Layout card plus sensible compact/extended fallback dimensions for redistribution. */
function cardBox(note, card) {
  const compact = classifyNote(note).mode === "compact";
  const style = resolvePresentation(note).extendedStyle;
  const defaults = style === "document"
    ? { w: 248, h: 320 }
    : style === "target" ? { w: 250, h: 290 } : { w: 360, h: 240 };
  return {
    x: Number.isFinite(card?.x) ? card.x : 0,
    y: Number.isFinite(card?.y) ? card.y : 0,
    w: Number.isFinite(card?.width) && card.width > 0
      ? card.width : (compact ? 190 : defaults.w),
    h: Number.isFinite(card?.height) && card.height > 0
      ? card.height : (compact ? 90 : defaults.h),
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

/**
 * Removes unreferenced minor anchors from every live shared card in one layout write. Reference
 * collection uses *all* shared notes (including trashed ones) because restoring a note brings its
 * links back; only the layout is updated.
 */
async function pruneSharedAnchors(shared, layout = layoutPage(shared)) {
  if (!layout) return;
  const notes = allSharedNoteList(shared);
  // Fold any legacy non-canonical main first and move its links to the canonical id. Otherwise
  // pruning would remove the referenced main and leave the link dangling on an unknown anchor.
  const canonical = canonicalizeMainAnchors(layout.system.cards ?? {}, notes);
  for (const { noteId, links } of canonical.links) {
    const page = shared.pages.get(noteId);
    if (page?.type === `${MODULE_ID}.note`) await page.update({ "system.links": links });
  }
  const changed = pruneAnchorRegistry(canonical.cards, allSharedNoteList(shared));
  const updates = {};
  for (const { noteId, anchors } of canonical.changed) {
    updates[`system.cards.${noteId}.anchors`] = anchors;
  }
  for (const { noteId, anchors } of changed) {
    updates[`system.cards.${noteId}.anchors`] = anchors;
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
    if (message.type === "writeApplied") {
      // Only the active GM may confirm a write, and only to the requester it names. The local
      // client uses this to commit undo entries; a rejected/rolled-back write sends no such ack.
      if (senderUserId !== game.users.activeGM?.id) return;
      if (message.forUserId && message.forUserId !== game.user.id) return;
      Hooks.callAll("journalinatorWriteApplied", message);
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

async function createNotePage(shared, {
  title, kind, style, x, y, authorId, autoTitle = false, presentation, label, attachment, targetHeading
}) {
  kind = kind === "location" ? "location" : "note";
  const styleProvided = typeof style === "string" && Object.hasOwn(CARD_STYLES, style);
  const defaultStyle = kind === "location" ? "document" : "memo";
  style = styleProvided ? style : defaultStyle;
  const defaultTitle = kind === "location" ? t("JN.Note.NewLocationTitle") : t("JN.Note.NewNoteTitle");
  const typedTitle = (title ?? "").trim();
  const requestedTitle = typedTitle || defaultTitle;
  const finalTitle = autoTitle ? uniqueTitle(shared, requestedTitle) : requestedTitle;

  if (finalTitle.length > MAX_TITLE_LENGTH) {
    notifyUser(authorId, t("JN.Socket.TitleTooLong", { max: MAX_TITLE_LENGTH }));
    return null;
  }
  if (!autoTitle && findNoteByTitle(shared, finalTitle)) {
    notifyUser(authorId, t("JN.Socket.TitleTaken", { title: finalTitle }));
    return null;
  }

  const layout = layoutPage(shared);
  const existingCards = layout?.system.cards ?? {};
  const cardWidth = CARD_STYLES[style]?.defaultWidth ?? 190;
  const nearX = Number.isFinite(x) ? x : 0;
  const nearY = Number.isFinite(y) ? y : 0;
  const spot = findFreeSpot(existingCards, cardWidth, CARD_STYLES[style]?.defaultHeight ?? 90, nearX, nearY);

  // New records start at schema 1, but keep legacy `style`/`targetHeading` so old editor calls and
  // wikilink/rename logic keep working. A plain new note defaults to automatic Memo (force false);
  // an explicit style is a creation preset and stays extended. Location is always Document/extended.
  const baseStyle = styleProvided ? style : "sticky";
  const presentationPatch = sanitizePresentationFields(presentation) ?? {};
  const nextPresentation = {
    ...legacyPresentation({ style: baseStyle, targetHeading }),
    ...presentationPatch,
    nameGenerated: "nameGenerated" in presentationPatch
      ? presentationPatch.nameGenerated
      : (autoTitle || !typedTitle)
  };
  if (kind === "location") {
    nextPresentation.extendedStyle = "document";
    nextPresentation.forceExtended = true;
  }
  const nextLabel = typeof label === "string" ? label.trim().slice(0, MAX_LABEL_LENGTH) : "";
  const nextAttachment = resolveAttachment({ system: { attachment } });

  const page = await JournalEntryPage.create({
    name: finalTitle,
    type: `${MODULE_ID}.note`,
    system: {
      kind,
      style,
      schemaVersion: 1,
      label: nextLabel,
      presentation: nextPresentation,
      attachment: nextAttachment,
      blocks: [{ blockId: foundry.utils.randomID(), text: "", authorId }],
      authorId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  }, { parent: shared });

  if (layout) {
    await layout.update({
      [`system.cards.${page.id}`]: {
        x: spot.x,
        y: spot.y,
        rotation: seedTilt(style),
        anchors: {
          main: { kind: "main", x: MAIN_PIN.x, y: MAIN_PIN.y, createdBy: authorId }
        }
      }
    });
  }
  await recordActivity(authorId, { notes: 1 });
  return page;
}

/** Re-runs typed-wikilink resolution against `blocks` and saves both blocks and links together. */
async function reconcileAndSave(shared, page, blocks, senderUserId, extraSystemUpdates = {}) {
  const layout = layoutPage(shared);
  const sourceCard = layout?.system.cards[page.id] ?? { x: 0, y: 0 };
  const existingLinkIds = new Set((page.system.links ?? []).map(link => link.id));
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

  const addedTypedLinks = links.filter(link => link.origin === "typed" && !existingLinkIds.has(link.id)).length;
  await page.update({
    "system.blocks": blocks,
    "system.links": links,
    "system.updatedAt": Date.now(),
    ...extraSystemUpdates
  });
  await maybeSnapshot(page);
  if (addedTypedLinks) await recordActivity(senderUserId, { links: addedTypedLinks });
}

/** Credits added characters (capped per save, spec §12) to whoever just saved. */
function creditContribution(page, senderUserId, oldText, newText) {
  const added = Math.max(0, newText.length - oldText.length);
  const credited = Math.min(CONTRIBUTION_CAP, added);
  const contributions = { ...(page.system.contributions ?? {}) };
  contributions[senderUserId] = (contributions[senderUserId] ?? 0) + credited;
  return { contributions, credited };
}

/**
 * Validates a declassified note sent by a GM (gmCreateNote). The GM client already knows the
 * content is going public, so this is ordinary hostile-payload validation, not secrecy.
 */
function cleanDeclassifiedNote(shared, message) {
  if (typeof message.noteId !== "string" || !DOCUMENT_ID_RE.test(message.noteId)) return null;
  if (shared.pages.get(message.noteId)) return null; // already declassified (idempotent)
  const title = (message.title ?? "").trim();
  if (!title || title.length > MAX_TITLE_LENGTH) return null;
  const kind = message.kind === "location" ? "location" : "note";
  const style = typeof message.style === "string" && Object.hasOwn(CARD_STYLES, message.style) ? message.style : "sticky";
  const image = noteImagePath(message.image);
  const backgroundImage = noteImagePath(message.backgroundImage);
  const targetHeading = typeof message.targetHeading === "string"
    ? message.targetHeading.trim().slice(0, MAX_HEADING_LENGTH) : "";
  const label = typeof message.label === "string"
    ? message.label.trim().slice(0, MAX_LABEL_LENGTH) : "";
  const presentation = {
    ...legacyPresentation({ style, targetHeading }),
    ...(sanitizePresentationFields(message.presentation) ?? {})
  };
  const attachment = resolveAttachment({ system: { attachment: message.attachment } });
  const formerNames = (Array.isArray(message.formerNames) ? message.formerNames : [])
    .filter(name => typeof name === "string")
    .slice(-MAX_FORMER_NAMES)
    .map(name => name.trim().slice(0, MAX_TITLE_LENGTH))
    .filter(Boolean);

  if (!Array.isArray(message.blocks) || !message.blocks.length || message.blocks.length > MAX_DECLASSIFIED_BLOCKS) return null;
  const blocks = [];
  const blockIds = new Set();
  for (const block of message.blocks) {
    if (!block || typeof block.text !== "string" || block.text.length > MAX_BLOCK_LENGTH) return null;
    const blockId = typeof block.blockId === "string" && DOCUMENT_ID_RE.test(block.blockId) && !blockIds.has(block.blockId)
      ? block.blockId : foundry.utils.randomID();
    blockIds.add(blockId);
    blocks.push({ blockId, text: block.text });
  }

  // Link ids are stable data, so keep a declassified link's id when it does not collide with an
  // id already present anywhere in the shared journal. Collisions regenerate rather than
  // overwriting another link's identity; declassification is otherwise additive.
  const existingLinkIds = new Set();
  for (const page of shared.pages) {
    if (page.type !== `${MODULE_ID}.note`) continue;
    for (const link of page.system.links ?? []) existingLinkIds.add(link.id);
  }

  const links = [];
  for (const link of (Array.isArray(message.links) ? message.links : []).slice(0, MAX_DECLASSIFIED_LINKS)) {
    const target = shared.pages.get(link?.targetId);
    if (!target || target.type !== `${MODULE_ID}.note` || target.system.deleted) continue;
    if (link.targetId === message.noteId || links.some(l => l.targetId === link.targetId)) continue;
    const preservedId = typeof link.id === "string" && DOCUMENT_ID_RE.test(link.id)
      && !existingLinkIds.has(link.id) ? link.id : foundry.utils.randomID();
    existingLinkIds.add(preservedId);
    const fields = { ...(sanitizeLinkFields(link) ?? {}) };
    // A declassified payload may originate from legacy vault data. Shared anchor ids and route
    // waypoints cannot be trusted there (shared pruning is vault-blind), so publish only the
    // validated point/side fallback.
    fields.sourceAnchorId = "";
    fields.targetAnchorId = "";
    links.push({
      id: preservedId,
      targetId: link.targetId,
      label: "", direction: "one", color: "", lineStyle: "solid",
      ...defaultLinkCosmetics(),
      ...fields,
      ...linkAnchors(link),
      routeAnchors: [],
      origin: "drawn",
      edited: link.edited === true,
      createdBy: "",
      hint: link.hint === true
    });
  }

  const card = message.card ?? {};
  const num = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const size = value => Number.isFinite(value) && value > 0 ? value : null;
  return {
    noteId: message.noteId, title, kind, style, image, backgroundImage, blocks, links,
    targetHeading, label, presentation, attachment, formerNames,
    card: {
      x: clampCoordinate(num(card.x, 0)), y: clampCoordinate(num(card.y, 0)),
      width: size(card.width), height: size(card.height),
      rotation: Math.max(-10, Math.min(10, num(card.rotation, 0))),
      ports: cardPorts(card),
      anchors: sanitizeCardAnchors(card.anchors)
    }
  };
}

async function handleMessage(message, senderUserId) {
  const ids = getContainerIds();
  if (!ids) return;
  const shared = game.journal.get(ids.shared);
  if (!shared) return;

  switch (message.type) {
    case "createNote": {
      await createNotePage(shared, {
        title: message.title, kind: message.kind, style: message.style, x: message.x, y: message.y,
        authorId: senderUserId, autoTitle: message.autoTitle === true,
        presentation: message.presentation, label: message.label
      });
      return;
    }

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
      const title = typeof message.title === "string" ? message.title.trim() : "";
      if (!title || title.length > MAX_TITLE_LENGTH) {
        notifyUser(senderUserId, title ? t("JN.Socket.TitleTooLong", { max: MAX_TITLE_LENGTH }) : t("JN.Socket.TitleEmpty"));
        return;
      }
      const texts = Array.isArray(message.blocks) ? message.blocks.slice(0, MAX_DECLASSIFIED_BLOCKS) : [];
      if (texts.some(text => typeof text !== "string" || text.length > MAX_BLOCK_LENGTH)) return;
      const kind = message.kind === "location" ? "location" : "note";
      const style = typeof message.style === "string" && Object.hasOwn(CARD_STYLES, message.style)
        ? message.style : undefined;
      const targetHeading = typeof message.targetHeading === "string"
        ? message.targetHeading.trim().slice(0, 80) : "";
      const page = await createNotePage(shared, {
        title, kind, style, x: message.x, y: message.y,
        authorId: senderUserId, autoTitle: message.autoTitle !== false,
        presentation: message.presentation, label: message.label,
        attachment: message.attachment, targetHeading
      });
      if (!page) return;
      const blocks = texts.length
        ? texts.map(text => ({ blockId: foundry.utils.randomID(), text, authorId: senderUserId }))
        : [{ blockId: foundry.utils.randomID(), text: "", authorId: senderUserId }];
      await page.update({
        "system.blocks": blocks,
        "system.updatedAt": Date.now(),
        ...(targetHeading ? { "system.targetHeading": targetHeading } : {})
      });
      // A future clipboard may carry the source card's anchor registry. Sanitize it, fold any
      // legacy/non-canonical main into `main`, and stamp the main creator from the sender rather
      // than trusting the pasted value. Copied minors may keep their original creator.
      const pastedAnchors = addMainAnchor(message.card?.anchors ?? message.anchors, senderUserId);
      const layout = layoutPage(shared);
      if (layout) {
        await layout.update({
          [`system.cards.${page.id}.anchors`]: pastedAnchors
        });
      }
      return;
    }

    case "renameNote": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      const title = (message.title ?? "").trim();
      if (!title) {
        notifyUser(senderUserId, t("JN.Socket.TitleEmpty"));
        return;
      }
      if (title.length > MAX_TITLE_LENGTH) {
        notifyUser(senderUserId, t("JN.Socket.TitleTooLong", { max: MAX_TITLE_LENGTH }));
        return;
      }
      if (findNoteByTitle(shared, title, page.id)) {
        notifyUser(senderUserId, t("JN.Socket.TitleTaken", { title }));
        return;
      }

      const oldTitle = (page.name ?? "").trim();
      const resolved = resolvePresentation(page);
      const formerNames = [...(page.system.formerNames ?? [])];
      if (oldTitle && !formerNames.some(name => name.trim().toLowerCase() === oldTitle.toLowerCase())) {
        formerNames.push(oldTitle);
      }
      // Keep former names bounded and never list the current title twice.
      const nextFormerNames = formerNames
        .filter(name => name.trim().toLowerCase() !== title.toLowerCase())
        .slice(-20);
      const updates = { name: title, "system.formerNames": nextFormerNames, "system.updatedAt": Date.now() };
      if (!isGeneratedTitle(title)) {
        const oldBare = stripSecretPrefix(oldTitle).trim();
        const { label: resolvedLabel, ...presentationFields } = resolved;
        updates["system.presentation"] = { ...presentationFields, nameGenerated: false };
        // A meaningful rename also migrates the record. NoteModel defaults schemaVersion to 0,
        // so reading `page.system.schemaVersion` here would write 0 back on a legacy page.
        updates["system.schemaVersion"] = 1;
        if (!resolvedLabel || resolvedLabel === oldBare) {
          updates["system.label"] = stripSecretPrefix(title).trim();
        }
      }
      await page.update(updates);
      return;
    }

    case "setNoteKind": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (!new Set(["note", "location"]).has(message.kind)) return;
      await page.update({ "system.kind": message.kind, "system.updatedAt": Date.now() });
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
      if (message.text !== undefined && (typeof message.text !== "string" || message.text.length > MAX_BLOCK_LENGTH)) return;
      const prevBlock = blocks[index - 1];
      if (!authoritativeHolds(message.noteId, message.blockId, senderUserId)) return;
      if (!authoritativeHolds(message.noteId, prevBlock.blockId, senderUserId)) return; // needs both locks (spec §6.4)
      const currentText = message.text ?? blocks[index].text;

      const nextBlocks = blocks.filter((_, i) => i !== index);
      nextBlocks[index - 1] = { ...prevBlock, text: prevBlock.text + currentText, authorId: senderUserId };
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
      if (message.kind !== undefined && !["note", "location"].includes(message.kind)) return;
      const resolved = resolvePresentation(page);
      const { label: _ignored, ...presentationFields } = resolved;
      // Legacy editor calls still store `style`; mirror it into the explicit presentation block so
      // the new canvas does not have to infer the renderer, and mark the record as migrated.
      await page.update({
        "system.style": message.style,
        "system.schemaVersion": 1,
        "system.presentation": {
          ...presentationFields,
          ...legacyStylePresentation(message.style)
        },
        ...(message.kind ? { "system.kind": message.kind } : {})
      });
      return;
    }

    case "setNotePresentation": {
      const pages = liveSharedNotePages(shared, message.noteIds);
      const fields = sanitizePresentationFields(message.fields);
      if (!pages || !fields) return;
      for (const page of pages) {
        // Base on the resolved record, not just the stored block: a partial patch on a legacy
        // note must keep its legacy style/force/torn instead of dropping them.
        const resolved = resolvePresentation(page);
        const { label: _ignored, ...existing } = resolved;
        const updates = {
          "system.presentation": { ...existing, ...fields },
          "system.schemaVersion": 1
        };
        // An explicitly empty heading clears the legacy key too; an absent heading leaves it alone.
        if (fields.heading === "") updates["system.targetHeading"] = "";
        await page.update(updates);
      }
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
          "system.attachment": { ...existing, ...fields },
          "system.schemaVersion": 1
        });
      }
      return;
    }

    case "setNoteLabel": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (typeof message.label !== "string") return;
      // The optional label is separate from the internal Foundry name; never rename the page here.
      await page.update({
        "system.label": message.label.trim().slice(0, MAX_LABEL_LENGTH),
        "system.schemaVersion": 1
      });
      return;
    }

    case "setTargetHeading": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (typeof message.heading !== "string" || message.heading.length > 80) return;
      const heading = message.heading.trim();
      const resolved = resolvePresentation(page);
      const { label: _ignored, ...presentationFields } = resolved;
      await page.update({
        "system.targetHeading": heading,
        "system.presentation": { ...presentationFields, heading },
        "system.schemaVersion": 1
      });
      return;
    }

    case "setNoteImage": {
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      const image = noteImagePath(message.image);
      if (message.image !== null && !image) return;
      const field = message.background === true ? "system.backgroundImage" : "system.image";
      await page.update({ [field]: image });
      return;
    }

    case "linkActor": {
      // Actor status is GM-facing information; players never get to choose which actor a shared
      // note observes. The badge itself is still derived per client, so this only stores the ref.
      if (!senderIsGM(senderUserId)) return;
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (message.actorRef === null) {
        await page.update({ "system.actorRef": null });
        return;
      }
      const ref = normalizeActorRef(message.actorRef);
      if (!ref || !DOCUMENT_ID_RE.test(ref.actorId)) return;
      if (ref.sceneId && !DOCUMENT_ID_RE.test(ref.sceneId)) return;
      if (ref.tokenId && !DOCUMENT_ID_RE.test(ref.tokenId)) return;
      if (!game.actors?.get?.(ref.actorId)) return;
      if (ref.sceneId) {
        const scene = game.scenes?.get?.(ref.sceneId);
        if (!scene) return;
        if (ref.tokenId) {
          const token = scene.tokens?.get?.(ref.tokenId);
          if (!token || token.actorId !== ref.actorId) return;
        }
      }
      await page.update({ "system.actorRef": ref });
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
      anchors[anchorId] = { kind: "minor", x: message.x, y: message.y, createdBy: senderUserId };
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
      const moved = { ...anchor, x: message.x, y: message.y };
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
      const anchors = { ...(card.anchors ?? {}) };
      delete anchors[message.anchorId];
      await layout.update({ [`system.cards.${page.id}.anchors`]: anchors });
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
            await layout.update({ [`system.cards.${page.id}.anchors`]: anchors });
          }
          if (!currentlyEnabled || page.system.attachment?.mainPinEnabled !== true) {
            await page.update({ "system.attachment": nextAttachment });
          }
        } catch (err) {
          await layout.update({
            [`system.cards.${page.id}.anchors`]: originalCard.anchors ?? {}
          }).catch(() => {});
          await page.update({ "system.attachment": storedAttachment }).catch(() => {});
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
          await layout.update({ [`system.cards.${page.id}.anchors`]: hubCard.anchors });
        }
      } catch (err) {
        // Restore the exact captured shared state; no link may be lost or half-redistributed.
        for (const state of beforeNotes) {
          await shared.pages.get(state.noteId)?.update({
            "system.links": deepClone(state.links),
            ...attachmentRestoreChanges(state)
          }).catch(() => {});
        }
        await layout.update({
          [`system.cards.${page.id}`]: deepClone(beforeCard)
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
            ...attachmentRestoreChanges(state)
          });
        }
        for (const state of entry.layout) {
          // Undo restores only the anchor registry it changed; geometry/labels stay untouched.
          await layout.update({ [`system.cards.${state.noteId}.anchors`]: deepClone(state.anchors ?? {}) });
        }
        pinUndoEntries.delete(message.undoId);
      } catch (err) {
        console.error("Journalinator: pin undo failed", err);
      }
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
      const addedNewLink = existing === -1;
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
      if (addedNewLink) await recordActivity(senderUserId, { links: 1 });
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
      await pruneSharedAnchors(shared);
      return;
    }

    case "newLinkedNote": {
      const sourcePage = shared.pages.get(message.sourceId);
      if (!sourcePage || sourcePage.type !== `${MODULE_ID}.note` || sourcePage.system.deleted) return;
      const layout = layoutPage(shared);
      const sourceCard = layout?.system.cards[message.sourceId] ?? { x: 0, y: 0 };
      const newPage = await createNotePage(shared, {
        title: message.title ?? t("JN.Note.Untitled"), style: message.style, autoTitle: message.autoTitle === true,
        x: sourceCard.x + 220, y: sourceCard.y, authorId: senderUserId
      });
      if (!newPage) return;
      const links = [...(sourcePage.system.links ?? []), {
        id: foundry.utils.randomID(),
        targetId: newPage.id,
        ...defaultLinkCosmetics(),
        routeAnchors: [],
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
      const undoId = typeof message.undoId === "string" && DOCUMENT_ID_RE.test(message.undoId)
        ? message.undoId : null;
      await page.update({ "system.deleted": { at: Date.now(), by: senderUserId, lastCard, undoId } });
      if (layout) await layout.update({ [`system.cards.-=${message.noteId}`]: null });
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
      if (layout) {
        // Copy the whole stored card back instead of hand-picking geometry, so anchor registries
        // (and any future card fields) survive a trash/restore roundtrip.
        const restoredCard = lastCard
          ? { ...foundry.utils.deepClone(lastCard), x: spot.x, y: spot.y, ports: cardPorts(lastCard) }
          : { x: spot.x, y: spot.y, width: null, height: null, rotation: 0, ports: cardPorts(lastCard) };
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

    // --- GM tier (spec §14). Hidden content never arrives here: these messages only carry
    // content at the moment it becomes public (declassification) or remove shared content.

    case "gmInsertBlock": {
      if (!senderIsGM(senderUserId)) return;
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      const block = message.block;
      if (!block || typeof block.text !== "string" || block.text.length > MAX_BLOCK_LENGTH) return;
      if (typeof block.blockId !== "string" || !DOCUMENT_ID_RE.test(block.blockId)) return;
      const blocks = page.system.blocks ?? [];
      if (blocks.some(b => b.blockId === block.blockId)) return; // already declassified
      let index = typeof message.beforeBlockId === "string"
        ? blocks.findIndex(b => b.blockId === message.beforeBlockId)
        : -1;
      if (index === -1) index = blocks.length;
      const nextBlocks = [...blocks];
      nextBlocks.splice(index, 0, { blockId: block.blockId, text: block.text, authorId: senderUserId });
      await reconcileAndSave(shared, page, nextBlocks, senderUserId, {
        "system.editCount": (page.system.editCount ?? 0) + 1
      });
      return;
    }

    case "gmRemoveBlock": {
      if (!senderIsGM(senderUserId)) return;
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      const blocks = page.system.blocks ?? [];
      if (!blocks.some(b => b.blockId === message.blockId)) return;
      if (blocks.length <= 1) {
        notifyUser(senderUserId, t("JN.Socket.LastBlockHidden"));
        return;
      }
      const holder = authoritativeLockHolder(message.noteId, message.blockId);
      if (holder && holder !== senderUserId) {
        notifyUser(senderUserId, t("JN.Socket.LockedByOther"));
        return;
      }
      await reconcileAndSave(shared, page, blocks.filter(b => b.blockId !== message.blockId), senderUserId);
      return;
    }

    case "gmCreateNote": {
      if (!senderIsGM(senderUserId)) return;
      const note = cleanDeclassifiedNote(shared, message);
      if (!note) return;
      if (findNoteByTitle(shared, note.title)) {
        notifyUser(senderUserId, t("JN.Socket.DeclassifyTitleTaken", { title: note.title }));
        return;
      }
      const page = await JournalEntryPage.create({
        _id: note.noteId,
        name: note.title,
        type: `${MODULE_ID}.note`,
        system: {
          kind: note.kind === "location" ? "location" : "note",
          style: note.style,
          targetHeading: note.targetHeading,
          schemaVersion: 1,
          label: note.label,
          presentation: note.presentation,
          attachment: note.attachment,
          image: note.image,
          backgroundImage: note.backgroundImage,
          blocks: note.blocks.map(b => ({ ...b, authorId: senderUserId })),
          links: note.links,
          formerNames: note.formerNames ?? [],
          authorId: senderUserId,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      }, { parent: shared, keepId: true });
      if (!page) return;
      const layout = layoutPage(shared);
      if (layout) {
        await layout.update({
          [`system.cards.${page.id}`]: {
            ...note.card,
            anchors: addMainAnchor(note.card.anchors ?? {}, senderUserId)
          }
        });
      }
      // Typed [[links]] in the now-public text resolve in the shared namespace only.
      await reconcileAndSave(shared, page, page.system.blocks, senderUserId);
      return;
    }

    case "gmAddLink": {
      if (!senderIsGM(senderUserId)) return;
      const page = shared.pages.get(message.sourceId);
      const target = shared.pages.get(message.link?.targetId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (!target || target.type !== `${MODULE_ID}.note` || target.system.deleted) return;
      if (page.id === target.id) return;
      const links = [...(page.system.links ?? [])];
      if (links.some(link => link.targetId === target.id)) return;
      links.push({
        id: foundry.utils.randomID(),
        targetId: target.id,
        label: "", direction: "one", color: "", lineStyle: "solid",
        ...defaultLinkCosmetics(),
        ...sanitizeLinkFields(message.link),
        ...linkAnchors(message.link),
        // This path copies a GM-only/declassified link into public data. Its endpoint anchor ids
        // may be legacy vault references that shared pruning cannot see; keep only the fallback.
        sourceAnchorId: "",
        targetAnchorId: "",
        routeAnchors: sanitizeSharedRouteAnchors(shared, message.link?.routeAnchors, page.id),
        origin: "drawn",
        edited: true,
        createdBy: senderUserId,
        hint: message.link?.hint === true
      });
      await page.update({ "system.links": links });
      return;
    }

    case "gmSetHint": {
      if (!senderIsGM(senderUserId)) return;
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (typeof message.hint !== "boolean") return;
      await page.update({ "system.hint": message.hint });
      return;
    }

    case "gmSetLinkHint": {
      if (!senderIsGM(senderUserId)) return;
      const page = shared.pages.get(message.noteId);
      if (!page || page.type !== `${MODULE_ID}.note` || page.system.deleted) return;
      if (typeof message.hint !== "boolean") return;
      const links = page.system.links ?? [];
      if (!links.some(link => link.id === message.linkId)) return;
      await page.update({
        "system.links": links.map(link => link.id === message.linkId ? { ...link, hint: message.hint } : link)
      });
      return;
    }

    case "addSessionMarker": {
      if (!game.users.get(senderUserId)?.isGM) return; // only the GM adds session markers (spec §10)
      await addSessionMarker(message.label);
      return;
    }
  }
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
