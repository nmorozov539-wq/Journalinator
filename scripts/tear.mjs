/**
 * Stable torn-paper silhouettes. The seed is the note's permanent document id, never its DOM
 * index, so reordering or another client cannot change the edge. Top edge stays straight: that
 * is the pin/attachment edge and must remain a reliable hit target.
 */
function hashString(value) {
  let hash = 2166136261;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One torn silhouette as normalized percentage points. This is the canonical shape used by both
 * the CSS `clip-path` and the thread-fade mask, so the paper edge and the fade edge can never
 * drift apart. Points stay in 0–100 and the top edge is exactly two corners.
 */
export function tearPoints(seed, { depth = 2.4, points = 9 } = {}) {
  const random = mulberry32(hashString(seed));
  const jitter = () => (0.35 + random() * 0.65);
  const step = (from, to, count) => Array.from({ length: count }, (_, index) =>
    from + (to - from) * ((index + 1) / (count + 1)));
  const round = value => Number(value.toFixed(2));
  const result = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const bite = (sideLength, index) => sideLength * (random() < 0.18 ? 0.55 : 0.18);
  const right = step(0, 100, points);
  right.forEach((y, index) => {
    if (index === right.length - 1) return;
    result.push({
      x: round(100 - depth * jitter() - bite(depth, index)),
      y: round(y)
    });
  });
  result.push({ x: 100, y: 100 });
  const bottom = step(100, 0, points + 4);
  bottom.forEach((x, index) => {
    if (index === 0 || index === bottom.length - 1) return;
    result.push({
      x: round(x),
      y: round(100 - depth * jitter() - bite(depth, index))
    });
  });
  result.push({ x: 0, y: 100 });
  const left = step(100, 0, points);
  left.forEach((y, index) => {
    if (index === 0 || index === left.length - 1) return;
    result.push({
      x: round(depth * jitter() + bite(depth, index)),
      y: round(y)
    });
  });
  return result;
}

/** CSS polygon for one torn edge profile, preserving the original two-decimal formatting. */
export function tearPolygon(seed, options) {
  const corner = (x, y) => (x === 0 || x === 100) && (y === 0 || y === 100);
  return `polygon(${tearPoints(seed, options).map(({ x, y }) =>
    corner(x, y) ? `${x}% ${y}%` : `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(", ")})`;
}

export function tearSeed(noteId) {
  return hashString(noteId) % 100000;
}
