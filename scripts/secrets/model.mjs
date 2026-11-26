/**
 * Plain-data helpers for the GM vault (spec §14). No Foundry globals: everything here takes and
 * returns JSON-shaped objects so it is unit-tested directly (tests/model.test.mjs).
 *
 * Vault shape (the decrypted plaintext):
 * {
 *   format: 2, rev: <int>,
 *   notes:        { [noteId]: SecretNote }             GM-only notes, card included
 *   hiddenBlocks: { [sharedNoteId]: { order: [blockId...], blocks: { [blockId]: Block } } }
 *   hiddenLinks:  { [sourceNoteId]: Link[] }           GM-only links whose source is a shared note
 *   labels:       { [labelId]: Label }                  GM-only canvas labels
 * }
 * SecretNote = { id, name, kind, style, targetHeading, schemaVersion, label, presentation, attachment,
 *                image, backgroundImage, blocks: Block[], links: Link[], authorId, createdAt,
 *                updatedAt, card: { x, y, width, height, rotation, ports, anchors }, formerNames }
 */

import { CARD_STYLES } from "../styles/registry.mjs";
import {
  CARD_SIDES, DEFAULT_CARD_PORTS, MAX_THREAD_PINS, validCardPorts, validLinkPoint, validThreadPin
} from "../card-ports.mjs";
import { normalizeLinkColor } from "../link-colors.mjs";
import { DEFAULT_STAMP_CORNER, STAMP_COLORS, isStampCorner, stampUrl } from "../stamps.mjs";
import {
  resolveAttachment, resolveLinkCosmetics, resolvePresentation, sanitizeCardAnchorsWithMain
} from "../presentation.mjs";

export const VAULT_DATA_FORMAT = 2;

const NOTE_SCHEMA_VERSION = 1;
const MAX_NAME_LENGTH = 200;
const MAX_ROUTE_ANCHORS = 24;
const MAX_ANCHOR_ID_LENGTH = 64;
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Secret note titles carry a `GM-XXXX ` prefix so they never collide with player titles. */
export const SECRET_PREFIX_RE = /^GM-[A-Z0-9]{4} /;
const PREFIX_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

/** Foundry-style id for data the vault has to invent while normalizing (pure, no globals). */
export function randomVaultId(length = 16) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

function normalizeAnchors(anchors, mainPinEnabled, createdBy) {
  return sanitizeCardAnchorsWithMain(anchors, mainPinEnabled, createdBy);
}

/** Geometry-only card, including ports and the local anchor registry. */
export function normalizeVaultCard(card, mainPinEnabled = true, createdBy = "") {
  if (!card || typeof card !== "object") return null;
  return {
    x: Number.isFinite(card.x) ? card.x : 0,
    y: Number.isFinite(card.y) ? card.y : 0,
    width: Number.isFinite(card.width) && card.width > 0 ? card.width : null,
    height: Number.isFinite(card.height) && card.height > 0 ? card.height : null,
    rotation: Number.isFinite(card.rotation) ? card.rotation : 0,
    ports: validCardPorts(card.ports) ? [...card.ports] : [...DEFAULT_CARD_PORTS],
    anchors: normalizeAnchors(card.anchors, mainPinEnabled, createdBy)
  };
}

function anchorId(value) {
  return typeof value === "string" ? value.slice(0, MAX_ANCHOR_ID_LENGTH) : "";
}

export function normalizeRouteAnchors(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const anchors = [];
  for (const anchor of list) {
    if (typeof anchor?.noteId !== "string" || !anchor.noteId) continue;
    if (typeof anchor?.anchorId !== "string" || !anchor.anchorId) continue;
    const key = `${anchor.noteId}:${anchor.anchorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({
      noteId: anchor.noteId.slice(0, MAX_ANCHOR_ID_LENGTH),
      anchorId: anchor.anchorId.slice(0, MAX_ANCHOR_ID_LENGTH)
    });
    if (anchors.length >= MAX_ROUTE_ANCHORS) break;
  }
  return anchors;
}

/** One link, including legacy fields and the new cosmetic/anchor fields. */
export function normalizeVaultLink(link) {
  link = link && typeof link === "object" ? link : {};
  const direction = ["none", "one", "two"].includes(link.direction) ? link.direction : "none";
  const lineStyle = link.lineStyle === "dashed" ? "dashed" : "solid";
  const cosmetics = resolveLinkCosmetics(link);
  const clean = {
    id: typeof link.id === "string" && link.id ? link.id : randomVaultId(),
    targetId: typeof link.targetId === "string" ? link.targetId : "",
    label: typeof link.label === "string" ? link.label.slice(0, 200) : "",
    direction,
    color: normalizeLinkColor(link.color),
    lineStyle,
    origin: link.origin === "typed" ? "typed" : "drawn",
    edited: link.edited === true,
    createdBy: typeof link.createdBy === "string" ? link.createdBy : "",
    hint: link.hint === true,
    sourceAnchorId: anchorId(link.sourceAnchorId),
    targetAnchorId: anchorId(link.targetAnchorId),
    routeAnchors: normalizeRouteAnchors(link.routeAnchors),
    material: cosmetics.material,
    thickness: cosmetics.thickness,
    slack: cosmetics.slack,
    pattern: cosmetics.pattern,
    ends: cosmetics.ends,
    secondaryColor: cosmetics.secondaryColor
  };
  for (const key of ["sourceSide", "targetSide"]) {
    if (CARD_SIDES.includes(link[key])) clean[key] = link[key];
  }
  for (const key of ["sourcePoint", "targetPoint"]) {
    if (validLinkPoint(link[key])) clean[key] = { x: link[key].x, y: link[key].y };
  }
  if (Array.isArray(link.pins)) {
    clean.pins = link.pins.slice(0, MAX_THREAD_PINS).filter(validThreadPin).map(({ x, y }) => ({ x, y }));
  }
  return clean;
}

export function normalizeVaultBlock(block, fallbackId = null) {
  const blockId = fallbackId
    ?? (typeof block?.blockId === "string" && block.blockId ? block.blockId : randomVaultId());
  return {
    blockId,
    text: typeof block?.text === "string" ? block.text : "",
    authorId: typeof block?.authorId === "string" ? block.authorId : ""
  };
}

/** A whole secret note: content, presentation and its card. */
export function normalizeVaultNote(note, fallbackId = null) {
  note = note && typeof note === "object" ? note : {};
  const name = typeof note.name === "string" ? note.name.slice(0, MAX_NAME_LENGTH) : "";
  const style = Object.hasOwn(CARD_STYLES, note.style) ? note.style : "sticky";
  const targetHeading = typeof note.targetHeading === "string" ? note.targetHeading.slice(0, 80) : "";
  const stored = note.presentation && typeof note.presentation === "object" ? note.presentation : {};
  const presentation = resolvePresentation({
    name,
    system: { style, targetHeading, label: note.label, presentation: stored }
  });
  const hasLabel = typeof note.label === "string";
  const humanTitle = stripSecretPrefix(name).trim();
  const { label: _ignored, ...presentationFields } = presentation;
  const id = fallbackId ?? (typeof note.id === "string" && note.id ? note.id : randomVaultId());
  const attachment = resolveAttachment({ system: { attachment: note.attachment } });
  return {
    id,
    name,
    kind: note.kind === "location" ? "location" : "note",
    style,
    targetHeading,
    schemaVersion: Number.isInteger(note.schemaVersion) && note.schemaVersion > 0
      ? note.schemaVersion : NOTE_SCHEMA_VERSION,
    label: hasLabel
      ? note.label.slice(0, MAX_NAME_LENGTH)
      : (presentation.nameGenerated || !humanTitle ? "" : humanTitle.slice(0, MAX_NAME_LENGTH)),
    presentation: presentationFields,
    attachment,
    image: typeof note.image === "string" ? note.image : null,
    backgroundImage: typeof note.backgroundImage === "string" ? note.backgroundImage : null,
    blocks: Array.isArray(note.blocks) ? note.blocks.map(block => normalizeVaultBlock(block)) : [],
    links: (Array.isArray(note.links) ? note.links : []).map(normalizeVaultLink),
    authorId: typeof note.authorId === "string" ? note.authorId : "",
    createdAt: Number.isFinite(note.createdAt) ? note.createdAt : Date.now(),
    updatedAt: Number.isFinite(note.updatedAt) ? note.updatedAt : Date.now(),
    card: normalizeVaultCard(note.card, attachment.mainPinEnabled, note.authorId),
    formerNames: (Array.isArray(note.formerNames) ? note.formerNames : [])
      .filter(name => typeof name === "string").slice(-20)
      .map(name => name.slice(0, MAX_NAME_LENGTH))
  };
}

export function normalizeVaultLabel(label) {
  label = label && typeof label === "object" ? label : {};
  return {
    text: typeof label.text === "string" ? label.text.slice(0, 500) : "",
    x: Number.isFinite(label.x) ? label.x : 0,
    y: Number.isFinite(label.y) ? label.y : 0,
    size: Number.isFinite(label.size) ? label.size : 14,
    color: Object.values(STAMP_COLORS).includes(label.color) ? label.color : "",
    stamp: typeof label.stamp === "string" && stampUrl(label.stamp) ? label.stamp : "",
    noteId: typeof label.noteId === "string" ? label.noteId : "",
    corner: isStampCorner(label.corner) ? label.corner : DEFAULT_STAMP_CORNER
  };
}

function normalizeHiddenEntry(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  const blocks = {};
  if (source.blocks && typeof source.blocks === "object") {
    for (const [id, block] of Object.entries(source.blocks)) {
      if (!id) continue;
      blocks[id] = normalizeVaultBlock(block, id);
    }
  }
  const seen = new Set();
  const order = (Array.isArray(source.order) ? source.order : []).filter(id => {
    if (typeof id !== "string" || !id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { order, blocks };
}

export function emptyVault() {
  return {
    format: VAULT_DATA_FORMAT, rev: 0, notes: {}, hiddenBlocks: {}, hiddenLinks: {}, labels: {}
  };
}

/**
 * Reads formats 1 and 2 and returns a complete format-2 tree in memory. Unknown fields are
 * dropped deliberately: the vault only trusts the schemas this version knows how to render.
 * The next vaultStore.mutate() re-encrypts the normalized tree.
 */
export function normalizeVault(data) {
  const vault = data && typeof data === "object" ? data : {};
  const notes = {};
  for (const [id, note] of Object.entries(vault.notes && typeof vault.notes === "object" ? vault.notes : {})) {
    if (!id || !note || typeof note !== "object") continue;
    notes[id] = normalizeVaultNote(note, id);
  }
  const hiddenBlocks = {};
  for (const [noteId, entry] of Object.entries(vault.hiddenBlocks && typeof vault.hiddenBlocks === "object" ? vault.hiddenBlocks : {})) {
    if (!noteId || !entry || typeof entry !== "object") continue;
    hiddenBlocks[noteId] = normalizeHiddenEntry(entry);
  }
  const hiddenLinks = {};
  for (const [noteId, links] of Object.entries(vault.hiddenLinks && typeof vault.hiddenLinks === "object" ? vault.hiddenLinks : {})) {
    if (!noteId || !Array.isArray(links)) continue;
    hiddenLinks[noteId] = links.map(normalizeVaultLink);
  }
  const labels = {};
  for (const [id, label] of Object.entries(vault.labels && typeof vault.labels === "object" ? vault.labels : {})) {
    if (!id || !label || typeof label !== "object") continue;
    labels[id] = normalizeVaultLabel(label);
  }
  return {
    format: VAULT_DATA_FORMAT,
    rev: Number.isFinite(vault.rev) ? vault.rev : 0,
    notes,
    hiddenBlocks,
    hiddenLinks,
    labels
  };
}

export function randomPrefixCode(random = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0]) {
  let code = "";
  for (let i = 0; i < 4; i++) code += PREFIX_ALPHABET[random() % PREFIX_ALPHABET.length];
  return code;
}

export function hasSecretPrefix(title) {
  return SECRET_PREFIX_RE.test(title ?? "");
}

export function stripSecretPrefix(title) {
  return (title ?? "").replace(SECRET_PREFIX_RE, "");
}

/** `Lord Vex` -> `GM-7KQ2 Lord Vex`. Keeps an existing prefix (used by rename). */
export function makeSecretTitle(base, existingTitle = null, code = randomPrefixCode()) {
  const clean = stripSecretPrefix((base ?? "").trim()) || "Untitled";
  const prefix = existingTitle && hasSecretPrefix(existingTitle)
    ? existingTitle.match(SECRET_PREFIX_RE)[0]
    : `GM-${code} `;
  return `${prefix}${clean}`;
}

/**
 * Interleaves GM-hidden blocks into a shared note's blocks.
 *
 * `entry.order` is the GM's last-known full order. Each hidden block is anchored to the next
 * shared block after it in that order that still exists ("insert before successor"); if none
 * survives it goes to the end. Anchoring to the successor keeps a hidden block in place when
 * players split or append to the block *before* it, which is the common case. Hidden blocks
 * missing from `order` are appended at the end.
 */
export function mergeBlocks(sharedBlocks, entry) {
  const shared = (sharedBlocks ?? []).map(b => ({ ...b, hidden: false }));
  const hidden = entry?.blocks ?? {};
  const hiddenIds = Object.keys(hidden);
  if (!hiddenIds.length) return shared;

  const sharedIds = new Set(shared.map(b => b.blockId));
  const before = new Map(); // sharedBlockId | null(end) -> hidden ids, in order
  const placed = new Set();
  const order = Array.isArray(entry.order) ? entry.order : [];

  let successor = null;
  const pendingReverse = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (sharedIds.has(id)) {
      successor = id;
    } else if (hidden[id] && !placed.has(id)) {
      placed.add(id);
      pendingReverse.push([successor, id]);
    }
  }
  for (const [anchor, id] of pendingReverse.reverse()) {
    if (!before.has(anchor)) before.set(anchor, []);
    before.get(anchor).push(id);
  }
  for (const id of hiddenIds) {
    if (placed.has(id)) continue;
    if (!before.has(null)) before.set(null, []);
    before.get(null).push(id);
  }

  const asHidden = id => ({ ...hidden[id], blockId: id, hidden: true });
  const merged = [];
  for (const block of shared) {
    for (const id of before.get(block.blockId) ?? []) merged.push(asHidden(id));
    merged.push(block);
  }
  for (const id of before.get(null) ?? []) merged.push(asHidden(id));
  return merged;
}

export function orderOf(mergedBlocks) {
  return mergedBlocks.map(b => b.blockId);
}

/** Where a declassified hidden block lands in the shared note: before this shared block id, or null for the end. */
export function declassifyAnchor(mergedBlocks, hiddenBlockId) {
  const index = mergedBlocks.findIndex(b => b.blockId === hiddenBlockId);
  if (index === -1) return null;
  for (let i = index + 1; i < mergedBlocks.length; i++) {
    if (!mergedBlocks[i].hidden) return mergedBlocks[i].blockId;
  }
  return null;
}

/**
 * Title resolution for `[[wikilinks]]` written in *secret* text. Secret notes win, by full title
 * and then by title without the GM prefix; then live shared notes. Shared text never uses this —
 * the shared write path only ever looks at shared notes, so a player cannot probe secret titles.
 */
export function resolveSecretTitle(title, { secretNotes, sharedNotes }) {
  const key = (title ?? "").trim().toLowerCase();
  if (!key) return null;
  const secrets = Object.values(secretNotes ?? {});
  return secrets.find(n => n.name.trim().toLowerCase() === key)
    ?? secrets.find(n => stripSecretPrefix(n.name).trim().toLowerCase() === key)
    ?? (sharedNotes ?? []).find(n => !n.deleted && n.name.trim().toLowerCase() === key)
    ?? null;
}

/**
 * Finishes interrupted declassifications and drops orphans. Declassify writes the shared copy
 * first (same id) and removes the secret copy second, so after a crash in between, the id is in
 * both places; the shared copy wins.
 *
 * `shared` is { notes: Map<id, { blockIds: Set<string>, deleted: boolean }> } describing every
 * shared note page that still exists (trash included). `null` means the shared container is
 * unavailable right now, so we cannot tell orphans from live content: prune nothing.
 */
export function reconcileVault(vault, shared) {
  if (!shared) return false;
  let changed = false;
  for (const id of Object.keys(vault.notes)) {
    if (shared.notes.has(id)) { delete vault.notes[id]; changed = true; }
  }
  for (const [noteId, entry] of Object.entries(vault.hiddenBlocks)) {
    const sharedNote = shared.notes.get(noteId);
    if (!sharedNote) { delete vault.hiddenBlocks[noteId]; changed = true; continue; }
    for (const blockId of Object.keys(entry.blocks ?? {})) {
      if (sharedNote.blockIds.has(blockId)) { delete entry.blocks[blockId]; changed = true; }
    }
    if (!Object.keys(entry.blocks ?? {}).length) { delete vault.hiddenBlocks[noteId]; changed = true; }
  }
  for (const noteId of Object.keys(vault.hiddenLinks)) {
    if (!shared.notes.has(noteId) || !vault.hiddenLinks[noteId]?.length) {
      delete vault.hiddenLinks[noteId];
      changed = true;
    }
  }
  for (const [id, label] of Object.entries(vault.labels)) {
    if (label.noteId && !vault.notes[label.noteId] && !shared.notes.has(label.noteId)) {
      delete vault.labels[id];
      changed = true;
    }
  }
  return changed;
}

/** Spiral search for a free spot (same as the shared path's), over any card map. */
export function findFreeSpot(cards, w, h, nearX, nearY) {
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
