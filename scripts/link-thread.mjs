const offset = (point, x, y) => ({ x: point.x + x, y: point.y + y });
const interpolate = (a, b, t) => (1 - t) * a + t * b;
const coordinates = point => `${point.x} ${point.y}`;

/** Experimental thread bounds and the approved configurator presets. */
export const THREAD_THICKNESS = Object.freeze({ min: 0.8, max: 5, initial: 2.6 });
export const THREAD_SLACK = Object.freeze({ min: 0, max: 0.25, initial: 0.09 });
export const THREAD_MAX_SAG = 100;

export const THREAD_PRESETS = (() => {
  const presets = {
    fine: Object.freeze({ material: "linen", thickness: 1.3, slack: 0.02 }),
    standard: Object.freeze({ material: "linen", thickness: 2.6, slack: 0.09 }),
    double: Object.freeze({ material: "double", thickness: 2.8, slack: 0.12 }),
    heavy: Object.freeze({ material: "double", thickness: 4, slack: 0.19 })
  };
  // Display-name aliases stay non-enumerable so iteration/deep equality sees only the four
  // writable preset ids while `THREAD_PRESETS.Standard` remains available to callers.
  for (const [id, preset] of Object.entries(presets)) {
    Object.defineProperty(presets, id.charAt(0).toUpperCase() + id.slice(1), {
      value: preset, enumerable: false
    });
  }
  return Object.freeze(presets);
})();

export const THREAD_PRESET_IDS = Object.freeze(Object.keys(THREAD_PRESETS));
export const DEFAULT_THREAD_PRESET = THREAD_PRESETS.standard;

/** Unknown/invalid thickness falls back to the Standard size, like the schema resolver. */
export function clampThreadThickness(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return THREAD_THICKNESS.initial;
  return Math.min(THREAD_THICKNESS.max, Math.max(THREAD_THICKNESS.min, n));
}

/** Slack is a fraction of the horizontal span: 0–0.25 (0–25%). */
export function clampThreadSlack(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return THREAD_SLACK.initial;
  return Math.min(THREAD_SLACK.max, Math.max(THREAD_SLACK.min, n));
}

/*
 * Layer recipes measured from the approved thread configurator. A recipe is pure geometry and
 * paint metadata; colours stay in CSS so one theme token drives every layer.
 *
 * L3 waxed linen: k = width / 3.4, five layers (shadow, dark edge, core, highlight, fine).
 * L6 double strand: k = width / 3.9, six layers (shadow, dark core, two strands, two highlights).
 */
const LINEN_RECIPE = Object.freeze({
  base: 3.4,
  layers: Object.freeze([
    Object.freeze({ role: "shadow", widthFactor: 4.3, opacity: 0.5, dx: 0.7, dy: 1.5 }),
    Object.freeze({ role: "dark", widthFactor: 3.4, opacity: 1, dx: 0, dy: 0 }),
    Object.freeze({ role: "core", widthFactor: 2.55, opacity: 1, dx: 0, dy: 0 }),
    Object.freeze({ role: "highlight", widthFactor: 1, opacity: 0.74, dx: 0, dy: -0.65 }),
    Object.freeze({ role: "fine", widthFactor: 0.38, opacity: 0.7, dx: 0, dy: -0.9 })
  ])
});

const DOUBLE_RECIPE = Object.freeze({
  base: 3.9,
  layers: Object.freeze([
    Object.freeze({ role: "shadow", widthFactor: 4.9, opacity: 0.55, dx: 0.8, dy: 1.6 }),
    Object.freeze({ role: "dark", widthFactor: 3.9, opacity: 1, dx: 0, dy: 0 }),
    Object.freeze({ role: "strandA", widthFactor: 1.55, opacity: 1, dx: 0, dy: -0.65 }),
    Object.freeze({ role: "strandB", widthFactor: 1.55, opacity: 0.94, dx: 0, dy: 0.65 }),
    Object.freeze({ role: "highlightA", widthFactor: 0.8, opacity: 0.65, dx: 0, dy: -0.8, dash: Object.freeze([1.5, 2]), dashOffset: 0 }),
    Object.freeze({ role: "highlightB", widthFactor: 0.65, opacity: 0.45, dx: 0, dy: 0.6, dash: Object.freeze([1.5, 2]), dashOffset: 1.75 })
  ])
});

/**
 * Resolved layer stack for one thread. Widths and offsets are in world units at 1x; the canvas
 * feeds the factors through CSS custom properties so zoom can compensate without rebuilding.
 */
export function threadLayerSpecs(material, thickness) {
  const recipe = material === "double" ? DOUBLE_RECIPE : LINEN_RECIPE;
  const width = clampThreadThickness(thickness);
  const k = width / recipe.base;
  return {
    material: material === "double" ? "double" : "linen",
    thickness: width,
    base: recipe.base,
    k,
    layers: recipe.layers.map(layer => ({
      role: layer.role,
      widthFactor: layer.widthFactor,
      width: layer.widthFactor * k,
      opacity: layer.opacity,
      dx: layer.dx,
      dy: layer.dy,
      offset: { x: layer.dx * k, y: layer.dy * k },
      dash: layer.dash ? [...layer.dash] : null,
      dashOffset: layer.dashOffset ?? 0
    }))
  };
}

function aim(anchor, toward) {
  const dx = toward.x - anchor.x, dy = toward.y - anchor.y;
  const distance = Math.hypot(dx, dy) || 1;
  return { ...anchor, nx: dx / distance, ny: dy / distance };
}

function restPoint(start, end, slack = THREAD_SLACK.initial) {
  // Gravity bends an outstretched thread by a fraction of its horizontal span. A vertical
  // thread has no horizontal span and therefore hangs straight.
  const sag = Math.min(THREAD_MAX_SAG, Math.abs(end.x - start.x) * clampThreadSlack(slack));
  return {
    x: interpolate(start.x, end.x, 0.5),
    y: interpolate(start.y, end.y, 0.5) + sag
  };
}

export class ThreadMotion {
  constructor(start, end, slack = THREAD_SLACK.initial) {
    this.slack = clampThreadSlack(slack);
    this.rest = restPoint(start, end, this.slack);
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
  }

  /** Keeps the spring state; only the rest target (and optionally the slack) moves. */
  retarget(start, end, animate, slack = this.slack) {
    this.slack = clampThreadSlack(slack);
    const next = restPoint(start, end, this.slack);
    if (animate) {
      const span = Math.hypot(end.x - start.x, end.y - start.y);
      const limit = Math.min(84, span * 0.28);
      this.x = Math.max(-limit, Math.min(limit, this.x + (this.rest.x - next.x) * 0.8));
      this.y = Math.max(-limit, Math.min(limit, this.y + (this.rest.y - next.y) * 0.8));
    } else {
      this.x = this.y = this.vx = this.vy = 0;
    }
    this.rest = next;
  }

  get moving() {
    return this.x !== 0 || this.y !== 0 || this.vx !== 0 || this.vy !== 0;
  }

  pull(dx, dy, span) {
    const distance = Math.hypot(dx, dy);
    const scale = distance ? Math.min(1, Math.min(220, span * 0.55) / distance) : 0;
    this.x = dx * scale;
    this.y = dy * scale;
    this.vx = this.vy = 0;
  }

  step(seconds) {
    this.vx += (-108 * this.x - 13 * this.vx) * seconds;
    this.vy += (-108 * this.y - 13 * this.vy) * seconds;
    this.x += this.vx * seconds;
    this.y += this.vy * seconds;
    if (Math.hypot(this.x, this.y) < 0.1 && Math.hypot(this.vx, this.vy) < 1) {
      this.x = this.y = this.vx = this.vy = 0;
    }
  }
}

/**
 * Draws the whole thread as a continuous curve. The endpoint tangents still follow the socket
 * normals (so pins meet their sides cleanly), but there is no straight lead-in segment that
 * would make the link visibly snap straight as it approaches a nearby card.
 */
export function threadPath(start, end, motion, slack) {
  const fallbackSlack = motion?.slack ?? THREAD_SLACK.initial;
  // An explicit slack always wins; otherwise a live motion's settled rest target is reused so
  // the spring can animate toward it without recomputing from the endpoints.
  const rest = slack === undefined
    ? (motion?.rest ?? restPoint(start, end, fallbackSlack))
    : restPoint(start, end, slack);
  // A pin is a point, not an edge port. Aim each end toward the other end so a
  // thread may cross a note to reach a pin on its far side.
  start = aim(start, end);
  end = aim(end, start);
  const span = Math.hypot(end.x - start.x, end.y - start.y);
  const lead = Math.min(22, span * 0.24);
  const reach = Math.min(74, span * 0.22);
  const a = offset(start, start.nx * lead, start.ny * lead);
  const b = offset(end, end.nx * lead, end.ny * lead);
  const center = offset(rest, motion?.x ?? 0, motion?.y ?? 0);
  const tx = (b.x - a.x) * 0.18, ty = (b.y - a.y) * 0.18;
  const c1 = offset(start, start.nx * reach, start.ny * reach);
  const c2 = offset(center, -tx, -ty);
  const c3 = offset(center, tx, ty);
  const c4 = offset(end, end.nx * reach, end.ny * reach);
  const path = `M${coordinates(start)} C${coordinates(c1)} ${coordinates(c2)} ${coordinates(center)}`
    + ` C${coordinates(c3)} ${coordinates(c4)} ${coordinates(end)}`;
  return { path, center, lead, start, end };
}

/**
 * Kept for data/tests that still expect the old geometry helper. Canvas 2 never renders an
 * arrowhead and never implies a reading direction.
 */
export function arrowHead(anchor, available) {
  const length = Math.min(12, available);
  if (length < 2) return null;
  const tip = anchor;
  const base = offset(anchor, anchor.nx * length, anchor.ny * length);
  const halfWidth = length * 0.4;
  const left = offset(base, -anchor.ny * halfWidth, anchor.nx * halfWidth);
  const right = offset(base, anchor.ny * halfWidth, -anchor.nx * halfWidth);
  return [tip, left, right].map(point => `${point.x},${point.y}`).join(" ");
}

/**
 * Small stacked tails for the "loose" end treatment. Each tail starts at a fixed anchor and
 * curls along the thread's inward tangent; endpoints never move with spring motion.
 */
export function looseTails(start, end) {
  const build = (anchor, scale) => {
    const nx = anchor.nx || 0, ny = anchor.ny || 0;
    // Perpendicular to the inward tangent: (-ny, nx).
    const px = -ny, py = nx;
    const point = (along, lateral) => ({
      x: anchor.x + (nx * along + px * lateral) * scale,
      y: anchor.y + (ny * along + py * lateral) * scale
    });
    const control = point(15, -12);
    const first = point(12, 8);
    const second = point(20, 14);
    const rel = (from, to) => `${to.x - from.x} ${to.y - from.y}`;
    return `M${coordinates(anchor)} q${rel(anchor, control)} ${rel(anchor, first)}`
      + ` t${rel(first, second)}`;
  };
  return [
    { role: "tail", d: build(start, 1) },
    { role: "tailFine", d: build(start, 0.72) },
    { role: "tail", d: build(end, 1) },
    { role: "tailFine", d: build(end, 0.72) }
  ];
}

/** Build consecutive spans whose shared endpoints stay fixed during motion. */
export function pinnedThreadPath(start, end, pins, motion, slack) {
  const segmentSlack = slack ?? motion?.slack ?? THREAD_SLACK.initial;
  if (!pins.length) {
    const segment = threadPath(start, end, motion, segmentSlack);
    return { ...segment, startLead: segment.lead, endLead: segment.lead };
  }
  const points = [start, ...pins, end];
  const segments = points.slice(1).map((to, index) => {
    const from = points[index];
    if (!motion) return threadPath(from, to, undefined, segmentSlack);
    const limit = Math.min(220, Math.hypot(to.x - from.x, to.y - from.y) * 0.55);
    const scale = Math.min(1, limit / (Math.hypot(motion.x, motion.y) || 1));
    return threadPath(from, to, { x: motion.x * scale, y: motion.y * scale }, segmentSlack);
  });
  return {
    path: segments.map(segment => segment.path).join(" "),
    center: segments[Math.floor(segments.length / 2)].center,
    start: segments[0].start,
    end: segments.at(-1).end,
    startLead: segments[0].lead,
    endLead: segments.at(-1).lead
  };
}
