import { MAIN_ANCHOR_ID, anchorWorld, validAnchorId } from "./anchors.mjs";
import { normalizeLinkColor } from "./link-colors.mjs";
import { resolveLinkCosmetics } from "./presentation.mjs";

export const PIN_WORLD_LIMIT = 1000000;
export const pinRef = (noteId, anchorId = MAIN_ANCHOR_ID) => `n:${noteId}:${anchorId}`;
export const boardPinRef = id => `p:${id}`;
const PIN_LINK_FIELDS = ["label", "color", "secondaryColor", "material", "thickness", "slack", "pattern", "ends"];

export function normalizePinLink(link, fields = {}) {
  const changes = Object.fromEntries(PIN_LINK_FIELDS.filter(key => Object.hasOwn(fields, key))
    .map(key => [key, fields[key]]));
  const next = { ...link, ...changes };
  const cosmetics = resolveLinkCosmetics(next);
  return {
    source: link.source, target: link.target,
    label: typeof next.label === "string" ? next.label.slice(0, 200) : "",
    color: normalizeLinkColor(next.color),
    ...cosmetics
  };
}

export function validPinPosition(noteId, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return noteId ? x >= 0 && x <= 1 && y >= 0 && y <= 1
    : Math.abs(x) <= PIN_WORLD_LIMIT && Math.abs(y) <= PIN_WORLD_LIMIT;
}

/** Resolve a stable pin reference against saved layout and live measured card boxes. */
export function resolvePin(ref, layout, boxes) {
  if (typeof ref !== "string") return null;
  if (ref.startsWith("p:")) {
    const id = ref.slice(2);
    const pin = layout?.pins?.[id];
    if (!pin || !validPinPosition(pin.noteId, pin.x, pin.y)) return null;
    if (!pin.noteId) return { x: pin.x, y: pin.y, ref, movable: true, noteId: "" };
    const box = boxes.get(pin.noteId);
    const point = box && anchorWorld(box, { ...pin, kind: "minor" });
    return point ? { ...point, ref, movable: true, noteId: pin.noteId } : null;
  }
  if (!ref.startsWith("n:")) return null;
  const split = ref.indexOf(":", 2);
  if (split < 0) return null;
  const noteId = ref.slice(2, split), anchorId = ref.slice(split + 1);
  if (!noteId || !validAnchorId(anchorId)) return null;
  const anchor = layout?.cards?.[noteId]?.anchors?.[anchorId];
  const box = boxes.get(noteId);
  const point = anchor && box && anchorWorld(box, anchor);
  return point ? { ...point, ref, noteId, movable: anchor.kind === "minor" } : null;
}
