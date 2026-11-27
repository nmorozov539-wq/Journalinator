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
/** World-pixel tolerance for treating separately placed minor anchors as the same pin. */
export const ANCHOR_MERGE_TOLERANCE = 2;
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
  // The main pin is a constant at the top-centre of the note. Older/corrupt records could carry
  // different coordinates; geometry must always canonicalize them so threads, hit tests and the
  // visible pin cannot disagree about where the main pin lives.
  anchor = isMainAnchor(anchor)
    ? { ...anchor, x: MAIN_PIN.x, y: MAIN_PIN.y }
    : minorOnEdge(anchor, box);
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

/**
 * Closest existing minor anchor to a normalized card point, in world pixels. This is the single
 * reuse rule for both UI gestures and data creation: a click on an edge that already carries a
 * minor pin must share that pin id instead of minting a stacked duplicate. Mains are excluded so a
 * newly requested minor can never collapse into the note handle.
 */
export function nearestMinorAnchor(box, anchors, point, tolerance = ANCHOR_MERGE_TOLERANCE) {
  if (!box || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const target = cardPointAnchor(box, point);
  const limit = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : ANCHOR_MERGE_TOLERANCE;
  let best = null;
  for (const [id, anchor] of Object.entries(anchors ?? {})) {
    if (!validAnchorId(id) || anchor?.kind !== "minor") continue;
    const world = anchorWorld(box, anchor);
    if (!world) continue;
    const distance = Math.hypot(world.x - target.x, world.y - target.y);
    if (distance > limit) continue;
    if (!best || distance < best.distance || (distance === best.distance && id < best.id)) {
      best = { id, anchor, point: world, distance };
    }
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
 * Folds minor anchors that occupy the same physical point on one card into a single canonical
 * pin. Link creation used to mint a fresh minor for every edge click, so boards can already
 * carry several stacked anchors at one spot. Merging is deliberately conservative: only minor
 * anchors within `tolerance` world pixels (measured through width/height/rotation) are folded,
 * the lexicographically first id wins for determinism, and every reference is rewritten.
 *
 * Returns the next card map, changed cards, rewritten note link arrays, and changed pin-link
 * refs. Nothing is deleted except the duplicate registry entries; links keep their connections.
 */
export function mergeNearbyMinorAnchors(cards, notes, {
  tolerance = ANCHOR_MERGE_TOLERANCE, pinLinks = {}
} = {}) {
  const next = { ...(cards ?? {}) };
  const aliases = new Map();
  const changed = [];
  const boxFor = card => ({
    x: Number.isFinite(card?.x) ? card.x : 0,
    y: Number.isFinite(card?.y) ? card.y : 0,
    w: Number.isFinite(card?.width) && card.width > 0 ? card.width : 190,
    h: Number.isFinite(card?.height) && card.height > 0 ? card.height : 90,
    rotation: Number.isFinite(card?.rotation) ? card.rotation : 0
  });

  for (const [noteId, card] of Object.entries(next)) {
    const entries = Object.entries(card?.anchors ?? {})
      .filter(([id, anchor]) => validAnchorId(id) && anchor?.kind === "minor"
        && Number.isFinite(anchor.x) && Number.isFinite(anchor.y))
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (entries.length < 2) continue;
    const box = boxFor(card);
    const points = new Map();
    for (const [id, anchor] of entries) {
      const world = anchorWorld(box, anchor);
      if (world) points.set(id, world);
    }
    const ids = [...points.keys()];
    if (ids.length < 2) continue;
    const parent = new Map(ids.map(id => [id, id]));
    const find = id => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(id) !== root) {
        const up = parent.get(id);
        parent.set(id, root);
        id = up;
      }
      return root;
    };
    const union = (left, right) => {
      const a = find(left), b = find(right);
      if (a === b) return;
      // The smallest id is the component root, so the canonical pin is deterministic.
      if (a < b) parent.set(b, a); else parent.set(a, b);
    };
    const limit = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : ANCHOR_MERGE_TOLERANCE;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = points.get(ids[i]), b = points.get(ids[j]);
        if (Math.hypot(a.x - b.x, a.y - b.y) <= limit) union(ids[i], ids[j]);
      }
    }
    const anchors = { ...card.anchors };
    let touched = false;
    for (const id of ids) {
      const canonical = find(id);
      if (canonical === id) continue;
      delete anchors[id];
      aliases.set(`${noteId}\u0000${id}`, canonical);
      touched = true;
    }
    if (!touched) continue;
    next[noteId] = { ...card, anchors };
    changed.push({ noteId, anchors });
  }

  const links = [];
  if (aliases.size) {
    const aliasFor = (noteId, anchorId) => noteId && anchorId
      ? aliases.get(`${noteId}\u0000${anchorId}`) : undefined;
    for (const note of notes ?? []) {
      const noteId = note?._id ?? note?.id ?? note?.noteId;
      const current = note?.system?.links ?? note?.links ?? [];
      let touched = false;
      const rewritten = current.map(link => {
        let nextLink = link;
        const source = aliasFor(noteId, link.sourceAnchorId);
        if (source) nextLink = { ...nextLink, sourceAnchorId: source };
        const target = aliasFor(link.targetId, link.targetAnchorId);
        if (target) nextLink = { ...nextLink, targetAnchorId: target };
        if (Array.isArray(link.routeAnchors)) {
          const routes = link.routeAnchors.map(entry => {
            const canonical = aliasFor(entry?.noteId, entry?.anchorId);
            return canonical ? { ...entry, anchorId: canonical } : entry;
          });
          if (routes.some((entry, index) => entry !== link.routeAnchors[index])) {
            nextLink = { ...nextLink, routeAnchors: routes };
          }
        }
        if (nextLink !== link) touched = true;
        return nextLink;
      });
      if (touched) links.push({ noteId, links: rewritten });
    }
  }

  const rewiredPinLinks = [];
  if (aliases.size) {
    const repoint = ref => {
      if (typeof ref !== "string" || !ref.startsWith("n:")) return undefined;
      const split = ref.indexOf(":", 2);
      if (split < 0) return undefined;
      const noteId = ref.slice(2, split);
      const canonical = aliases.get(`${noteId}\u0000${ref.slice(split + 1)}`);
      return canonical ? `n:${noteId}:${canonical}` : undefined;
    };
    for (const [id, link] of Object.entries(pinLinks ?? {})) {
      const source = repoint(link?.source);
      const target = repoint(link?.target);
      if (source || target) {
        rewiredPinLinks.push({ id, source: source ?? link.source, target: target ?? link.target });
      }
    }
  }

  return { cards: next, changed, links, pinLinks: rewiredPinLinks };
}

function freshAnchorId(anchors) {
  const taken = new Set(Object.keys(anchors ?? {}));
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = globalThis.foundry?.utils?.randomID?.()
      ?? `pin${Math.random().toString(36).slice(2, 10)}`;
    if (id !== MAIN_ANCHOR_ID && !taken.has(id) && validAnchorId(id)) return id.slice(0, MAX_ANCHOR_ID_LENGTH);
  }
  let id = `pin${Date.now().toString(36)}`;
  while (taken.has(id)) id += "x";
  return id.slice(0, MAX_ANCHOR_ID_LENGTH);
}

/**
 * Converts legacy point-only link endpoints into stable anchor references. Older boards stored
 * `sourcePoint`/`targetPoint` without an anchor id, which made each endpoint paint as a small SVG
 * dot even after the pin system existed. Reusing an existing main/minor pin at the same physical
 * point (or creating one minor) gives those links the single normal pin visual and lets the old
 * endpoint dots disappear. Returns changed anchor registries and rewritten link arrays.
 */
export function promoteLegacyLinkAnchors(cards, notes, {
  tolerance = ANCHOR_MERGE_TOLERANCE
} = {}) {
  const next = { ...(cards ?? {}) };
  const noteById = new Map();
  for (const note of notes ?? []) {
    const id = note?._id ?? note?.id ?? note?.noteId;
    if (id) noteById.set(id, note);
  }
  const states = new Map();
  const stateFor = noteId => {
    if (states.has(noteId)) return states.get(noteId);
    const card = next[noteId];
    if (!card || typeof card !== "object" || Array.isArray(card)) return null;
    const state = {
      card,
      anchors: { ...(card.anchors ?? {}) },
      changed: false,
      box: {
        x: Number.isFinite(card.x) ? card.x : 0,
        y: Number.isFinite(card.y) ? card.y : 0,
        w: Number.isFinite(card.width) && card.width > 0 ? card.width : 190,
        h: Number.isFinite(card.height) && card.height > 0 ? card.height : 90,
        rotation: Number.isFinite(card.rotation) ? card.rotation : 0
      }
    };
    states.set(noteId, state);
    return state;
  };

  for (const [noteId, card] of Object.entries(next)) {
    if (!card || typeof card !== "object" || Array.isArray(card)) continue;
    // Validate the card before it can receive a promoted endpoint.
    stateFor(noteId);
  }

  const links = [];
  for (const note of notes ?? []) {
    const noteId = note?._id ?? note?.id ?? note?.noteId;
    if (!noteId) continue;
    const current = note?.system?.links ?? note?.links ?? [];
    if (!Array.isArray(current) || !current.length) continue;
    let touched = false;
    const rewritten = current.map(link => {
      let nextLink = link;
      for (const prefix of ["source", "target"]) {
        const endpointNoteId = prefix === "source" ? noteId : link?.targetId;
        const state = endpointNoteId ? stateFor(endpointNoteId) : null;
        if (!state) continue;
        const anchorKey = `${prefix}AnchorId`;
        const pointKey = `${prefix}Point`;
        const existingId = link?.[anchorKey];
        const hasAnchorField = Object.hasOwn(link ?? {}, anchorKey);
        if (existingId && validAnchorId(existingId)
            && Object.hasOwn(state.anchors, existingId) && state.anchors[existingId]) continue;
        // An explicit empty id means the author deliberately cleared the anchor and wants the
        // point/side fallback. Only old records that do not have the field at all are promoted.
        if (hasAnchorField && !existingId) continue;
        const point = link?.[pointKey];
        if (!validLinkPoint(point)) continue;
        const endpointNote = noteById.get(endpointNoteId);
        const mainEntry = Object.entries(state.anchors).find(([, anchor]) => isMainAnchor(anchor));
        let anchorId = "";
        if (mainEntry && endpointNote?.system?.attachment?.mainPinEnabled !== false) {
          const mainWorld = anchorWorld(state.box, mainEntry[1]);
          const pointWorld = cardPointAnchor(state.box, point);
          if (mainWorld && Math.hypot(mainWorld.x - pointWorld.x, mainWorld.y - pointWorld.y) <= tolerance) {
            anchorId = mainEntry[0];
          }
        }
        if (!anchorId) {
          const reuse = nearestMinorAnchor(state.box, state.anchors, point, tolerance);
          if (reuse) anchorId = reuse.id;
        }
        if (!anchorId) {
          anchorId = freshAnchorId(state.anchors);
          state.anchors[anchorId] = {
            kind: "minor", x: point.x, y: point.y,
            createdBy: typeof link?.createdBy === "string" ? link.createdBy.slice(0, MAX_ANCHOR_ID_LENGTH) : ""
          };
          state.changed = true;
        }
        nextLink = { ...nextLink, [anchorKey]: anchorId };
        touched = true;
      }
      return nextLink;
    });
    if (touched) links.push({ noteId, links: rewritten });
  }

  const changed = [];
  for (const [noteId, state] of states) {
    if (!state.changed) continue;
    next[noteId] = { ...state.card, anchors: state.anchors };
    changed.push({ noteId, anchors: state.anchors });
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
