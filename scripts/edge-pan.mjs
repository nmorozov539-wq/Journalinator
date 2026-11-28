/**
 * Camera auto-scroll while a link (or pin) is being dragged toward the edge of the board.
 * Pure math, so the canvas only has to feed it the pointer and apply the result.
 */

export const EDGE_PAN = Object.freeze({ zone: 56, maxSpeed: 16 });

const ramp = (distance, zone) => {
  if (distance >= zone) return 0;
  const t = Math.min(1, Math.max(0, (zone - Math.max(0, distance)) / zone));
  // Ease in: a pointer that merely brushes the zone drifts, one pinned to the edge flies.
  return t * t;
};

/**
 * Camera velocity in screen pixels per frame for a pointer at (x, y) inside `rect`. The camera
 * moves opposite to the pointer, so the world slides in from the side the pointer is pushing
 * toward. A pointer beyond the rect (captured drag) counts as at the edge.
 */
export function edgePanVelocity(x, y, rect, { zone = EDGE_PAN.zone, maxSpeed = EDGE_PAN.maxSpeed } = {}) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0 };
  // A tiny board must not be all edge: the zones can cover at most 40% of each side.
  const zx = Math.min(zone, rect.width * 0.4), zy = Math.min(zone, rect.height * 0.4);
  const left = ramp(x - rect.left, zx), right = ramp(rect.right - x, zx);
  const top = ramp(y - rect.top, zy), bottom = ramp(rect.bottom - y, zy);
  return {
    x: (left - right) * maxSpeed,
    y: (top - bottom) * maxSpeed
  };
}
