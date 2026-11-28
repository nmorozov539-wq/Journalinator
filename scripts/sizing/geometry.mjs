/**
 * Center-rotation geometry for automatic card sizing.
 *
 * A card has an unrotated top-left `{x,y}` and rotates around its center. The stable
 * `autoSizeOrigin` is the world point of the main pin (or the virtual top-center when the
 * main pin is disabled). Automatic width/height changes must not move that world point:
 *
 *   local top-center = (w/2, 0)
 *   center           = (x + w/2, y + h/2)
 *   origin           = center + R(rotation) * (0, -h/2)
 *
 * Solving for the new top-left gives:
 *
 *   x = origin.x - w/2 - (h/2) * sin(rotation)
 *   y = origin.y - h/2 + (h/2) * cos(rotation)
 *
 * This is the only supported compensation. `x -= deltaWidth/2` is wrong for rotated cards.
 * All angles are degrees, matching CSS `rotate()` and the stored layout rotation.
 */

const DEG = Math.PI / 180;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function rotationOf(card, box, rotation) {
  if (Number.isFinite(rotation)) return Number(rotation);
  if (Number.isFinite(box?.rotation)) return Number(box.rotation);
  return Number.isFinite(card?.rotation) ? Number(card.rotation) : 0;
}

function mainLocalPoint(card) {
  const enabled = card?.mainPinEnabled
    ?? card?.attachment?.mainPinEnabled
    ?? card?.system?.attachment?.mainPinEnabled
    ?? true;
  if (!enabled) return { x: 0.5, y: 0 };
  const anchors = card?.anchors && typeof card.anchors === "object" ? card.anchors : null;
  if (!anchors) return { x: 0.5, y: 0 };
  const main = anchors.main && anchors.main.kind === "main"
    ? anchors.main
    : Object.values(anchors).find(anchor => anchor?.kind === "main");
  if (!main) return { x: 0.5, y: 0 };
  // The main pin is canonically top-center; canonicalize corrupt legacy coordinates exactly
  // like `anchorWorld` so rendering, hit-testing and geometry agree.
  return { x: 0.5, y: 0 };
}

/** Project an unrotated local point to world space using the card's center rotation. */
export function localPointToWorld(box, point, rotation) {
  const angle = rotationOf(null, box, rotation) * DEG;
  const w = finite(box?.w, 0);
  const h = finite(box?.h, 0);
  const x = finite(box?.x, 0);
  const y = finite(box?.y, 0);
  const lx = finite(point?.x, 0.5) * w;
  const ly = finite(point?.y, 0) * h;
  const dx = lx - w / 2;
  const dy = ly - h / 2;
  return {
    x: x + w / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: y + h / 2 + dx * Math.sin(angle) + dy * Math.cos(angle)
  };
}

/**
 * World point of the card's main pin (or virtual top-center when the main pin is disabled).
 * The result is independent of automatic width/height when `box` was derived from the same
 * origin by `translateForAutoOrigin`.
 */
export function mainPinWorld(card, box, rotation) {
  return localPointToWorld(box, mainLocalPoint(card), rotationOf(card, box, rotation));
}

/** The origin implied by a currently rendered box: its main-pin (top-center) world point. */
export function originFromBox(box, rotation) {
  return localPointToWorld(box, { x: 0.5, y: 0 }, rotationOf(null, box, rotation));
}

/**
 * New top-left for an automatic origin and unrotated size. The main pin world point stays
 * exactly `origin` for any width, height and rotation.
 */
export function translateForAutoOrigin({ origin, w, h, rotation = 0 } = {}) {
  const width = Math.max(0, finite(w, 0));
  const height = Math.max(0, finite(h, 0));
  const angle = finite(rotation, 0) * DEG;
  const ox = finite(origin?.x, 0);
  const oy = finite(origin?.y, 0);
  return {
    x: ox - width / 2 - (height / 2) * Math.sin(angle),
    y: oy - height / 2 + (height / 2) * Math.cos(angle)
  };
}

/** Translates an origin by the same world delta as a card move. */
export function moveOrigin(origin, dx, dy) {
  return {
    x: finite(origin?.x, 0) + finite(dx, 0),
    y: finite(origin?.y, 0) + finite(dy, 0)
  };
}

/** Convenience: full box for an automatic card at a known size/rotation. */
export function boxForAutoOrigin({ origin, w, h, rotation = 0 } = {}) {
  return { ...translateForAutoOrigin({ origin, w, h, rotation }), w, h, rotation };
}

/** Whether a layout card carries a usable runtime origin. */
export function validAutoOrigin(value) {
  return !!value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

export default translateForAutoOrigin;
