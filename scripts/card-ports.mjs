export const CARD_SIDES = Object.freeze(["top", "right", "bottom", "left"]);
export const DEFAULT_CARD_PORTS = Object.freeze(["right"]);
export const THREAD_PIN_RADIUS = 3;
export const MAX_THREAD_PINS = 24;
export const MAX_THREAD_PIN_COORDINATE = 1000000;

export function validThreadPin(pin) {
  return !!pin && Number.isFinite(pin.x) && Number.isFinite(pin.y)
    && Math.abs(pin.x) <= MAX_THREAD_PIN_COORDINATE && Math.abs(pin.y) <= MAX_THREAD_PIN_COORDINATE;
}

export function moveThreadPin(pins, move) {
  if (!Array.isArray(pins) || !Number.isInteger(move?.index) || !pins[move.index] || !validThreadPin(move)) return null;
  return pins.map((pin, index) => index === move.index ? { x: move.x, y: move.y } : pin);
}

export function validCardPorts(ports) {
  return Array.isArray(ports) && ports.length > 0 && ports.length <= CARD_SIDES.length
    && new Set(ports).size === ports.length && ports.every(side => CARD_SIDES.includes(side));
}

export function cardPorts(card) {
  return validCardPorts(card?.ports) ? card.ports : DEFAULT_CARD_PORTS;
}

export function linkAnchors(link) {
  const anchors = Object.fromEntries(["sourceSide", "targetSide"]
    .filter(key => CARD_SIDES.includes(link?.[key]))
    .map(key => [key, link[key]]));
  for (const key of ["sourcePoint", "targetPoint"]) {
    const point = link?.[key];
    if (validLinkPoint(point)) anchors[key] = { x: point.x, y: point.y };
  }
  if (Array.isArray(link?.pins)) {
    anchors.pins = link.pins.slice(0, MAX_THREAD_PINS).filter(validThreadPin).map(({ x, y }) => ({ x, y }));
  }
  return anchors;
}

export function validLinkPoint(point) {
  return !!point && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1
    && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1;
}

/** Convert a board point to coordinates on the unrotated card. */
function cardPoint(box, point) {
  const angle = -(box.rotation ?? 0) * Math.PI / 180;
  const dx = point.x - box.x - box.w / 2, dy = point.y - box.y - box.h / 2;
  return {
    x: dx * Math.cos(angle) - dy * Math.sin(angle) + box.w / 2,
    y: dx * Math.sin(angle) + dy * Math.cos(angle) + box.h / 2
  };
}

export function cardPointAnchor(box, point) {
  const angle = (box.rotation ?? 0) * Math.PI / 180;
  const dx = (point.x - 0.5) * box.w, dy = (point.y - 0.5) * box.h;
  return {
    x: box.x + box.w / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: box.y + box.h / 2 + dx * Math.sin(angle) + dy * Math.cos(angle),
    nx: 0, ny: 0
  };
}

/** Preserve old free anchors by projecting them onto the closest edge. */
export function threadAttachment(box, point, side) {
  if (!validLinkPoint(point)) {
    const edge = portAnchor(box, side);
    return { ...edge, x: edge.x + edge.nx * THREAD_PIN_RADIUS, y: edge.y + edge.ny * THREAD_PIN_RADIUS };
  }
  const { x, y } = point;
  const edge = { x, y };
  let nx = Number(x === 1) - Number(x === 0);
  let ny = Number(y === 1) - Number(y === 0);
  if (!nx && !ny) {
    const nearest = cardEdgeAt(box, cardPointAnchor(box, point)).point;
    Object.assign(edge, nearest);
    nx = Number(edge.x === 1) - Number(edge.x === 0);
    ny = Number(edge.y === 1) - Number(edge.y === 0);
  }
  const anchor = cardPointAnchor(box, edge);
  const angle = (box.rotation ?? 0) * Math.PI / 180;
  const length = Math.hypot(nx, ny);
  const dx = (nx * Math.cos(angle) - ny * Math.sin(angle)) / length;
  const dy = (nx * Math.sin(angle) + ny * Math.cos(angle)) / length;
  return { x: anchor.x + dx * THREAD_PIN_RADIUS, y: anchor.y + dy * THREAD_PIN_RADIUS, nx: dx, ny: dy };
}

export function cardEdgeAt(box, point) {
  const { x, y } = cardPoint(box, point);
  const clamp = (value, max) => Math.min(max, Math.max(0, value));
  const px = clamp(x, box.w);
  const py = clamp(y, box.h);
  const edges = [{ x: px, y: 0 }, { x: box.w, y: py }, { x: px, y: box.h }, { x: 0, y: py }];
  const distances = edges.map(edge => Math.hypot(x - edge.x, y - edge.y));
  const distance = Math.min(...distances);
  const index = distances.indexOf(distance);
  const edge = edges[index];
  return { side: CARD_SIDES[index], distance, point: { x: edge.x / box.w, y: edge.y / box.h } };
}

export function portAnchor(box, side) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const dx = side === "left" ? -1 : side === "top" || side === "bottom" ? 0 : 1;
  const dy = side === "top" ? -1 : side === "bottom" ? 1 : 0;
  const angle = (box.rotation ?? 0) * Math.PI / 180;
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const radius = dx ? box.w / 2 : box.h / 2;
  const nx = dx * cosine - dy * sine, ny = dx * sine + dy * cosine;
  return { x: cx + nx * radius, y: cy + ny * radius, nx, ny };
}
