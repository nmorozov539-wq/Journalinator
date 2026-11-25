const offset = (point, x, y) => ({ x: point.x + x, y: point.y + y });
const interpolate = (a, b, t) => (1 - t) * a + t * b;
const coordinates = point => `${point.x} ${point.y}`;

function aim(anchor, toward) {
  if (anchor.nx || anchor.ny) return anchor;
  const dx = toward.x - anchor.x, dy = toward.y - anchor.y;
  const distance = Math.hypot(dx, dy) || 1;
  return { ...anchor, nx: dx / distance, ny: dy / distance };
}

function restPoint(start, end) {
  // Gravity bends an outstretched thread. A vertical thread hangs straight.
  const sag = Math.min(42, Math.abs(end.x - start.x) * 0.09);
  return {
    x: interpolate(start.x, end.x, 0.5),
    y: interpolate(start.y, end.y, 0.5) + sag
  };
}

export class ThreadMotion {
  constructor(start, end) {
    this.rest = restPoint(start, end);
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
  }

  retarget(start, end, animate) {
    const next = restPoint(start, end);
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

/** Keep the end segments straight so each thread meets its socket and arrow cleanly. */
export function threadPath(start, end, motion) {
  const rest = motion?.rest ?? restPoint(start, end);
  start = aim(start, rest);
  end = aim(end, rest);
  const span = Math.hypot(end.x - start.x, end.y - start.y);
  const lead = Math.min(22, span * 0.24);
  const reach = Math.min(74, span * 0.22);
  const a = offset(start, start.nx * lead, start.ny * lead);
  const b = offset(end, end.nx * lead, end.ny * lead);
  const center = offset(rest, motion?.x ?? 0, motion?.y ?? 0);
  const tx = (b.x - a.x) * 0.18, ty = (b.y - a.y) * 0.18;
  const c1 = offset(a, start.nx * reach, start.ny * reach);
  const c2 = offset(center, -tx, -ty);
  const c3 = offset(center, tx, ty);
  const c4 = offset(b, end.nx * reach, end.ny * reach);
  const path = `M${coordinates(start)} L${coordinates(a)} C${coordinates(c1)} ${coordinates(c2)} ${coordinates(center)}`
    + ` C${coordinates(c3)} ${coordinates(c4)} ${coordinates(b)} L${coordinates(end)}`;
  return { path, center, lead, start, end };
}

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

/** Build consecutive spans whose shared endpoints stay fixed during motion. */
export function pinnedThreadPath(start, end, pins, motion) {
  if (!pins.length) {
    const segment = threadPath(start, end, motion);
    return { ...segment, startLead: segment.lead, endLead: segment.lead };
  }
  const points = [start, ...pins, end];
  const segments = points.slice(1).map((to, index) => {
    const from = points[index];
    if (!motion) return threadPath(from, to);
    const limit = Math.min(220, Math.hypot(to.x - from.x, to.y - from.y) * 0.55);
    const scale = Math.min(1, limit / (Math.hypot(motion.x, motion.y) || 1));
    return threadPath(from, to, { x: motion.x * scale, y: motion.y * scale });
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
