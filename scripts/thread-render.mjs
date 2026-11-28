import { looseTails, threadLayerSpecs } from "./link-thread.mjs";
import { normalizeLinkColor } from "./link-colors.mjs";

/**
 * One thread look, one renderer. Note links and board-pin links used to be drawn by two
 * separate copies of this markup, and the pin-link copy silently ignored most cosmetics. Both
 * now go through these helpers, so a cosmetic added here shows up on every kind of link.
 *
 * The helpers are pure string builders: callers own the wrapper element, the hit path and any
 * extras (endpoint pins, board-pin markers), and keep their own fast geometry-only paths.
 */

const roleClass = role => `jn-thread-${role.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;

/** Classes that select the dye, material, pattern and end treatment of one thread group. */
export function threadClasses({ color = "", cosmetics, hidden = false, extra = [] }) {
  const slot = normalizeLinkColor(color);
  return [
    slot ? `jn-link-color-${slot}` : "jn-link-color-default",
    `jn-link-accent-${cosmetics.secondaryColor || "default"}`,
    `jn-link-material-${cosmetics.material === "double" ? "double" : "linen"}`,
    // A hidden link keeps its hidden treatment regardless of the chosen pattern.
    `jn-link-pattern-${hidden ? "continuous" : cosmetics.pattern}`,
    `jn-link-ends-${cosmetics.ends}`,
    ...extra
  ].filter(Boolean).join(" ");
}

/** Inline custom properties read by the layer CSS. */
export function threadStyle(specs) {
  const k = Math.round(specs.k * 10000) / 10000;
  return `--jn-thread-k:${k};--jn-thread-width:${specs.thickness}`;
}

function layerPaths(specs, d) {
  return specs.layers.map(layer => `<path class="jn-thread-layer ${roleClass(layer.role)}" d="${d}"
    style="--jn-layer-width:${layer.widthFactor};--jn-layer-opacity:${layer.opacity};--jn-layer-dx:${layer.dx};--jn-layer-dy:${layer.dy}"/>`).join("");
}

/**
 * The stroke stack: the primary dye, an accent stack for the alternating pattern and the loose
 * tails. `start` and `end` are the aimed endpoints returned by `pinnedThreadPath`.
 */
export function threadStrokes({ d, cosmetics, start, end, hidden = false }) {
  const specs = threadLayerSpecs(cosmetics.material, cosmetics.thickness);
  const accent = cosmetics.pattern === "alternating" && !hidden
    ? `<g class="jn-link-stack jn-link-stack-accent">${layerPaths(specs, d)}</g>` : "";
  const tails = cosmetics.ends === "loose"
    ? looseTails(start, end).map(tail =>
      `<path class="jn-thread-tail${tail.role === "tailFine" ? " jn-thread-tail-fine" : ""}" d="${tail.d}"/>`).join("")
    : "";
  return `<g class="jn-link-strokes">
    <g class="jn-link-stack jn-link-stack-primary">${layerPaths(specs, d)}</g>
    ${accent}
    ${tails}
  </g>`;
}

/** Re-aim already-drawn loose tails after a geometry-only update. */
export function updateThreadTails(tails, start, end) {
  if (!tails?.length) return;
  const paths = looseTails(start, end);
  tails.forEach((tail, index) => {
    if (paths[index]) tail.setAttribute("d", paths[index].d);
  });
}
