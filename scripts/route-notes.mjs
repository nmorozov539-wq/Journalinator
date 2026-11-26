/**
 * Pure helpers for Phase 6 "notes on thread routes".
 *
 * Two operations share these helpers:
 * - Route A inserts one note-local main anchor into a link's `routeAnchors`; the original link
 *   identity, endpoints, label and cosmetics are untouched.
 * - Route B replaces one link with two drawn links through an inserted note. The caller supplies
 *   the geometric C-side endpoints (main anchor or facing edge); this module owns the copy policy
 *   for style, label, hint and direction.
 *
 * No Foundry document access here, so the rules are directly testable.
 */
import { CARD_SIDES, validLinkPoint } from "./card-ports.mjs";
import { defaultLinkCosmetics } from "./presentation.mjs";

export const MAX_ROUTE_ANCHORS = 24;
export const ROUTE_UNDO_LIMIT = 20;

/** Link properties copied verbatim when Route B splits a thread. */
export const SPLIT_COPY_KEYS = Object.freeze([
  "material", "thickness", "slack", "pattern", "ends", "color", "secondaryColor", "lineStyle"
]);

/** Clamp an insertion index to `0..length`; a missing/non-finite index appends. */
export function clampRouteIndex(index, length) {
  const size = Number.isInteger(length) && length >= 0 ? length : 0;
  if (!Number.isFinite(index)) return size;
  return Math.max(0, Math.min(size, Math.trunc(index)));
}

/**
 * Inserts `{ noteId, anchorId }` at the clamped index. A note may appear at most once as a route
 * waypoint (the only dedicated-server anchor is the main pin, so duplicates would render twice).
 * Returns `{ ok: true, routeAnchors }` or `{ ok: false, reason: "duplicate" | "limit" }`.
 */
export function insertRouteWaypoint(routeAnchors, noteId, anchorId = "main", index) {
  const current = Array.isArray(routeAnchors) ? routeAnchors : [];
  if (current.some(entry => entry?.noteId === noteId)) return { ok: false, reason: "duplicate" };
  if (current.length >= MAX_ROUTE_ANCHORS) return { ok: false, reason: "limit" };
  const next = [...current];
  next.splice(clampRouteIndex(index, current.length), 0, { noteId, anchorId });
  return { ok: true, routeAnchors: next };
}

/** Drops every waypoint owned by `noteId`, preserving the order and shape of the rest. */
export function removeRouteWaypointsFor(routeAnchors, noteId) {
  return (Array.isArray(routeAnchors) ? routeAnchors : [])
    .filter(entry => entry?.noteId !== noteId)
    .map(entry => ({ noteId: entry.noteId, anchorId: entry.anchorId }));
}

export function hasBoardPins(link) {
  return Array.isArray(link?.pins) && link.pins.length > 0;
}

export function hasRouteWaypoints(link) {
  return Array.isArray(link?.routeAnchors) && link.routeAnchors.length > 0;
}

/**
 * Copies one endpoint's stored anchor/point/side fallback. Missing optional values stay absent so
 * the schema defaults apply; an explicit normalized point/side is preserved exactly.
 */
export function endpointFields(link, prefix) {
  const fields = {};
  const anchorId = link?.[`${prefix}AnchorId`];
  if (typeof anchorId === "string" && anchorId) fields[`${prefix}AnchorId`] = anchorId;
  if (validLinkPoint(link?.[`${prefix}Point`])) {
    fields[`${prefix}Point`] = { x: link[`${prefix}Point`].x, y: link[`${prefix}Point`].y };
  }
  const side = link?.[`${prefix}Side`];
  if (CARD_SIDES.includes(side)) fields[`${prefix}Side`] = side;
  return fields;
}

/**
 * Builds the two replacement links for Route B.
 *
 * Policy (DECISIONS E04 / open defaults):
 * - A side and B side keep the original endpoints exactly; the C side is supplied by the caller
 *   (`noteFirstEndpoint` = A→C target, `noteSecondEndpoint` = C→B source).
 * - Material/thickness/slack/pattern/ends/colors/legacy lineStyle are copied to both.
 * - The label is kept on the first (A→C) link only; the second is blank.
 * - `hint` is copied to both; direction is "none" because thread styles carry no semantics.
 * - Both are marked drawn/edited by the sender; route waypoints and board pins start empty.
 */
export function splitLinkPair({
  link, noteId, firstId, secondId, senderUserId,
  noteFirstEndpoint = {}, noteSecondEndpoint = {}
}) {
  const cosmetics = { ...defaultLinkCosmetics(), color: "", lineStyle: "solid" };
  for (const key of SPLIT_COPY_KEYS) {
    if (link?.[key] !== undefined && link[key] !== null) cosmetics[key] = link[key];
  }
  const shared = {
    origin: "drawn",
    edited: true,
    createdBy: senderUserId,
    direction: "none",
    hint: link?.hint === true,
    routeAnchors: []
  };
  return {
    first: {
      ...cosmetics,
      ...shared,
      id: firstId,
      targetId: noteId,
      label: typeof link?.label === "string" ? link.label : "",
      ...endpointFields(link, "source"),
      ...noteFirstEndpoint
    },
    second: {
      ...cosmetics,
      ...shared,
      id: secondId,
      targetId: link?.targetId,
      label: "",
      ...noteSecondEndpoint,
      ...endpointFields(link, "target")
    }
  };
}
