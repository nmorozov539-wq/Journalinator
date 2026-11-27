/**
 * Note-local attachment anchors.
 *
 * Anchor coordinates are normalized inside the unrotated card and are stored only in the layout
 * card registry. Links reference stable anchor ids, so moving, rotating or resizing a card never
 * duplicates or drifts coordinates. `pins` on a link remain free board-space waypoints.
 */
import { CARD_SIDES, cardEdgeAt, cardPointAnchor, validLinkPoint } from "./card-ports.mjs";
import { MAIN_PIN } from "./presentation.mjs";

export const MAIN_ANCHOR_ID = "main";
export const MAX_ANCHOR_ID_LENGTH = 100;
const ANCHOR_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const RESERVED_ANCHOR_IDS = new Set(["__proto__", "prototype", "constructor"]);

/** Anchor ids are opaque registry keys, never paths or prototype names. */
export function validAnchorId(value) {
  return typeof value === "string" && ANCHOR_ID_RE.test(value) && !RESERVED_ANCHOR_IDS.has(value);
}

export function isMainAnchor(anchor) {
  return anchor?.kind === "main";
}

/** Preserve a minor attachment's exact note-local position, including legacy interior pins. */
export function minorOnEdge(anchor, box = {}) {
  if (anchor?.kind !== "minor") return anchor;
  return { ...anchor, x: Math.min(1, Math.max(0, anchor.x)),
    y: Math.min(1, Math.max(0, anchor.y)) };
}

/** Nearest card side for a normalized anchor, matching `anchorWorld`'s outward normal choice. */
export function anchorSide(anchor, box) {
  if (!anchor) return undefined;
  const w = box?.w ?? 1, h = box?.h ?? 1;
  const distances = [
    { side: "top", value: anchor.y * h },
    { side: "right", value: (1 - anchor.x) * w },
    { side: "bottom", value: (1 - anchor.y) * h },
    { side: "left", value: anchor.x * w }
  ];
  return distances.reduce((best, item) => item.value < best.value ? item : best).side;
}

/** World point and outward normal for one normalized anchor. */
export function anchorWorld(box, anchor) {
  if (!anchor || !validLinkPoint(anchor)) return null;
  anchor = minorOnEdge(anchor, box);
  const point = cardPointAnchor(box, anchor);
  const distances = [
    { side: "top", value: anchor.y * box.h },
    { side: "right", value: (1 - anchor.x) * box.w },
    { side: "bottom", value: (1 - anchor.y) * box.h },
    { side: "left", value: anchor.x * box.w }
  ];
  const side = distances.reduce((best, item) => item.value < best.value ? item : best, distances[0]).side;
  const base = CARD_SIDES.indexOf(side);
  const dx = side === "left" ? -1 : side === "right" ? 1 : 0;
  const dy = side === "top" ? -1 : side === "bottom" ? 1 : 0;
  const angle = (box.rotation ?? 0) * Math.PI / 180;
  const nx = dx * Math.cos(angle) - dy * Math.sin(angle);
  const ny = dx * Math.sin(angle) + dy * Math.cos(angle);
  return { x: point.x, y: point.y, nx, ny, side, index: base };
}

/** Convert a world point to normalized unrotated card coordinates. */
export function cardNormalizedPoint(box, point) {
  if (!box || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
  const angle = -(box.rotation ?? 0) * Math.PI / 180;
  const dx = point.x - box.x - box.w / 2;
  const dy = point.y - box.y - box.h / 2;
  const x = (dx * Math.cos(angle) - dy * Math.sin(angle)) / box.w + 0.5;
  const y = (dx * Math.sin(angle) + dy * Math.cos(angle)) / box.h + 0.5;
  const clamp = value => Math.min(1, Math.max(0, value));
  return { x: clamp(x), y: clamp(y) };
}

/**
 * Closest anchor within its screen-space snap radius. Main and minor radii are CSS pixels and
 * are converted by zoom, so the magnet feels the same at every scale.
 */
export function nearestAnchor(box, anchors, world, { zoom = 1, mainRadius = 24, minorRadius = 6 } = {}) {
  let best = null;
  for (const [id, anchor] of Object.entries(anchors ?? {})) {
    if (!validAnchorId(id)) continue;
    const point = anchorWorld(box, anchor);
    if (!point) continue;
    const distance = Math.hypot(point.x - world.x, point.y - world.y) * zoom;
    const limit = isMainAnchor(anchor) ? mainRadius : minorRadius;
    if (distance > limit) continue;
    if (!best || distance < best.distance) best = { id, anchor, point, distance };
  }
  return best;
}

/** Project a target point onto the card boundary, for pin-off redistribution. */
export function projectToEdge(box, toward) {
  if (!box || !Number.isFinite(toward?.x) || !Number.isFinite(toward?.y)) return null;
  const { point, side, distance } = cardEdgeAt(box, toward);
  return { point, side, distance };
}

/** All anchor ids referenced by links, keyed by the note that owns the anchor. */
export function collectAnchorRefs(notes) {
  const refs = new Map();
  const add = (noteId, anchorId) => {
    if (!noteId || !validAnchorId(anchorId)) return;
    if (!refs.has(noteId)) refs.set(noteId, new Set());
    refs.get(noteId).add(anchorId);
  };
  for (const note of notes ?? []) {
    const sourceId = note?._id ?? note?.id ?? note?.noteId;
    for (const link of note?.system?.links ?? note?.links ?? []) {
      add(sourceId, link.sourceAnchorId);
      add(link.targetId, link.targetAnchorId);
      for (const route of link.routeAnchors ?? []) add(route.noteId, route.anchorId);
    }
  }
  return refs;
}

/**
 * Folds every non-canonical main entry into the single canonical `main` anchor at (0.5, 0) and
 * rewrites links/route waypoints that referenced the old ids. Legacy data could keep a main under
 * another key; pruning must never preserve two mains or strand a link on the removed id.
 * Returns the canonicalized card map, the cards that changed, and any link arrays to write.
 */
export function canonicalizeMainAnchors(cards, notes) {
  const next = { ...(cards ?? {}) };
  const aliasToMain = new Map();
  const changed = [];
  for (const [noteId, card] of Object.entries(next)) {
    if (!card?.anchors) continue;
    const mains = Object.entries(card.anchors)
      .filter(([id, anchor]) => validAnchorId(id) && isMainAnchor(anchor));
    if (!mains.length) continue;
    const canonicalEntry = mains.find(([id]) => id === MAIN_ANCHOR_ID);
    const canonical = canonicalEntry?.[1] ?? mains[0][1];
    const folded = {
      kind: "main", x: MAIN_PIN.x, y: MAIN_PIN.y,
      createdBy: typeof canonical.createdBy === "string"
        ? canonical.createdBy.slice(0, MAX_ANCHOR_ID_LENGTH) : ""
    };
    const aliases = mains.filter(([id]) => id !== MAIN_ANCHOR_ID).map(([id]) => id);
    const unchanged = canonicalEntry && mains.length === 1
      && canonical.x === folded.x && canonical.y === folded.y
      && canonical.createdBy === folded.createdBy;
    if (unchanged) continue;
    const anchors = { ...card.anchors };
    for (const [id] of mains) delete anchors[id];
    anchors[MAIN_ANCHOR_ID] = folded;
    next[noteId] = { ...card, anchors };
    changed.push({ noteId, anchors });
    if (aliases.length) aliasToMain.set(noteId, new Set(aliases));
  }

  const links = [];
  if (aliasToMain.size) {
    for (const note of notes ?? []) {
      const noteId = note?._id ?? note?.id ?? note?.noteId;
      const current = note?.system?.links ?? note?.links ?? [];
      let touched = false;
      const rewritten = current.map(link => {
        let nextLink = link;
        const sourceAliases = aliasToMain.get(noteId);
        if (sourceAliases?.has(link.sourceAnchorId)) {
          nextLink = { ...(nextLink === link ? link : nextLink), sourceAnchorId: MAIN_ANCHOR_ID };
        }
        const targetAliases = aliasToMain.get(link.targetId);
        if (targetAliases?.has(link.targetAnchorId)) {
          nextLink = { ...(nextLink === link ? link : nextLink), targetAnchorId: MAIN_ANCHOR_ID };
        }
        if (Array.isArray(link.routeAnchors)) {
          const routes = link.routeAnchors.map(entry => {
            const routeAliases = aliasToMain.get(entry?.noteId);
            return routeAliases?.has(entry?.anchorId)
              ? { ...entry, anchorId: MAIN_ANCHOR_ID } : entry;
          });
          if (routes.some((entry, index) => entry !== link.routeAnchors[index])) {
            nextLink = { ...(nextLink === link ? link : nextLink), routeAnchors: routes };
          }
        }
        if (nextLink !== link) touched = true;
        return nextLink;
      });
      if (touched) links.push({ noteId, links: rewritten });
    }
  }
  return { cards: next, changed, links };
}

/**
 * Removes unreferenced minor anchors from a card registry. The main anchor is never removed
 * (re-enabling a pin only shows it; it never reattaches links). Returns changed cards only.
 */
export function pruneAnchorRegistry(cards, notes) {
  const refs = collectAnchorRefs(notes);
  const changed = [];
  const next = { ...(cards ?? {}) };
  for (const [noteId, card] of Object.entries(next)) {
    if (!card?.anchors) continue;
    const keep = refs.get(noteId) ?? new Set();
    const entries = Object.entries(card.anchors);
    const mainEntries = entries
      .filter(([id, anchor]) => validAnchorId(id) && isMainAnchor(anchor));
    const canonical = mainEntries.find(([id]) => id === MAIN_ANCHOR_ID)?.[1] ?? mainEntries[0]?.[1];
    const main = canonical
      ? {
        kind: "main", x: MAIN_PIN.x, y: MAIN_PIN.y,
        createdBy: typeof canonical.createdBy === "string"
          ? canonical.createdBy.slice(0, MAX_ANCHOR_ID_LENGTH) : ""
      }
      : null;
    const anchors = {};
    let removed = false;
    for (const [id, anchor] of entries) {
      if (!validAnchorId(id)) { removed = true; continue; }
      // Any main is folded into the single canonical key below. Keeping a legacy/non-canonical
      // main under its old id would preserve two mains and could strand a link after pruning.
      if (isMainAnchor(anchor)) {
        if (id !== MAIN_ANCHOR_ID) removed = true;
        continue;
      }
      // A manually placed pin is a persistent canvas object even with no links.
      // Legacy cleanup must not erase it merely because no endpoint refers to it.
      anchors[id] = anchor;
    }
    if (main) {
      anchors.main = main;
      const original = card.anchors[MAIN_ANCHOR_ID];
      if (!original || original.kind !== "main"
          || original.x !== main.x || original.y !== main.y
          || original.createdBy !== main.createdBy) removed = true;
    }
    if (removed) {
      next[noteId] = { ...card, anchors };
      changed.push({ noteId, anchors });
    }
  }
  return changed;
}

/** Deterministic pick order for redistribution: reuse the closest minor, else project to edge. */
export function redistributionAnchor(box, anchors, toward, { zoom = 1, snap = 12 } = {}) {
  const nearest = nearestAnchor(box, anchors, toward, {
    zoom, mainRadius: 0, minorRadius: snap
  });
  if (nearest && !isMainAnchor(nearest.anchor)) return { anchorId: nearest.id, anchor: nearest.anchor };
  const edge = projectToEdge(box, toward);
  if (!edge) return null;
  return {
    anchorId: "",
    anchor: { kind: "minor", x: edge.point.x, y: edge.point.y, createdBy: "" }
  };
}

export function defaultMainAnchor(authorId = "") {
  return { kind: "main", x: MAIN_PIN.x, y: MAIN_PIN.y, createdBy: authorId };
}
