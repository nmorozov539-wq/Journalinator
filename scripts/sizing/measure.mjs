/**
 * Deterministic automatic card measurement for v2 notes.
 *
 * A note never persists its automatic width or height. This module derives both from the
 * parsed body plus the selected/layout appearance:
 *
 * - width comes from the layout registry's fixed steps (Plain 220/300/380, Profile 300/380);
 *   the chosen step is the smallest one that contains the longest *unbreakable* run plus
 *   40 px horizontal padding. Prose is allowed to wrap, so a long paragraph does not force
 *   the widest card.
 * - height comes from measuring the rendered content at that width; it is never clipped and
 *   has a 120 px floor. Explicit source line breaks therefore increase height through the
 *   normal rendered markup.
 *
 * `measure` is injectable. Tests pass a plain function; production uses the offscreen DOM
 * adapter created by `createDomMeasure()`. A function is called with:
 *
 *   measure({ kind: "text", text, style, skin, layout }) -> width (number)
 *   measure({ kind: "height", html, parsed, width, layout, skin, style }) -> height (number)
 *
 * An object with `textWidth(text, style, context)` / `heightAtWidth({...})` is accepted too.
 * Missing/failed measurement falls back to a deterministic character estimate, which keeps
 * jsdom and pre-font startup usable without producing random sizes.
 */

import { resolveLayout } from "../layouts/registry.mjs";
import { resolveSkin, skinToCssVars } from "../skins/registry.mjs";

/** Horizontal paper padding (20 px each side) added to intrinsic content width. */
export const SIZING_PADDING = 40;
export const AUTO_MAX_WIDTH = 380;
export const AUTO_MIN_HEIGHT = 120;
/** An image (or table/code block) keeps at least the 300 px Plain step. */
export const WIDE_CONTENT_MIN_INTRINSIC = 260;

export const SIZING_WIDTH_MIN = 160;
export const SIZING_WIDTH_MAX = 800;
export const SIZING_MIN_HEIGHT_MIN = 80;
export const SIZING_MIN_HEIGHT_MAX = 1600;

/** Width steps by effective layout, copied from the layout registry. */
export const AUTO_WIDTH_STEPS = Object.freeze({
  plain: Object.freeze(getWidths("plain")),
  profile: Object.freeze(getWidths("profile"))
});

function getWidths(id) {
  return resolveLayout(id).widths;
}

const TITLE_STYLE = Object.freeze({ size: 26, weight: 700, lineHeight: 1.15 });
const H2_STYLE = Object.freeze({ size: 20, weight: 700, lineHeight: 1.25 });
const BODY_STYLE = Object.freeze({ size: 16, weight: 400, lineHeight: 1.5 });
const CODE_STYLE = Object.freeze({
  size: 14, weight: 400, lineHeight: 1.4, family: "ui-monospace, SFMono-Regular, Menlo, monospace"
});

function finite(value) {
  return Number.isFinite(Number(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(value);
}

// --- Manual sizing -------------------------------------------------------------------------

/** Fresh automatic sizing with no persisted width/height overrides. */
export function autoSizing() {
  return { mode: "auto", width: null, minHeight: null };
}

export function isAutomaticSizing(sizing) {
  return sizing?.mode !== "manual";
}

/** Clamps a user width to the manual range (160–800). */
export function clampSizingWidth(value, fallback = 300) {
  return finite(value) ? round(clamp(Number(value), SIZING_WIDTH_MIN, SIZING_WIDTH_MAX)) : fallback;
}

/** Clamps a user minimum height to the manual range (80–1600). */
export function clampSizingMinHeight(value, fallback = 120) {
  return finite(value)
    ? round(clamp(Number(value), SIZING_MIN_HEIGHT_MIN, SIZING_MIN_HEIGHT_MAX))
    : fallback;
}

/** True only for finite values inside the persisted manual bounds. */
export function validateManualSizing({ width, minHeight } = {}) {
  return finite(width) && finite(minHeight)
    && Number(width) >= SIZING_WIDTH_MIN && Number(width) <= SIZING_WIDTH_MAX
    && Number(minHeight) >= SIZING_MIN_HEIGHT_MIN && Number(minHeight) <= SIZING_MIN_HEIGHT_MAX;
}

/**
 * Normalizes a manual resize request. Out-of-range finite values are clamped rather than
 * rejected (the drag handler calls this every pointer move); non-finite values return null
 * so a broken gesture cannot persist a partial override.
 */
export function clampManualSizing({ width, minHeight } = {}) {
  if (!finite(width) || !finite(minHeight)) return null;
  return {
    mode: "manual",
    width: clampSizingWidth(width, 300),
    minHeight: clampSizingMinHeight(minHeight, 120)
  };
}

/**
 * Card sizing for rendering and mutation. Manual values are clamped to the supported range;
 * anything else is automatic, which clears every manual override.
 */
export function normalizeSizing(sizing) {
  if (sizing?.mode !== "manual") return autoSizing();
  return clampManualSizing({ width: sizing.width, minHeight: sizing.minHeight }) ?? autoSizing();
}

// --- Intrinsic text ------------------------------------------------------------------------

const BLOCK_PREFIX_RE = /^\s{0,3}(?:#{1,6}\s+|>\s?|(?:[-*+]|\d{1,9}[.)])\s+|\[[ xX]\]\s*)/;
const INLINE_MARKER_RE = /[*_~`]/g;

function cleanRun(text) {
  return String(text ?? "").replace(INLINE_MARKER_RE, "");
}

function textRuns(text) {
  const runs = [];
  for (const rawLine of String(text ?? "").split(/\n/)) {
    const line = rawLine.replace(BLOCK_PREFIX_RE, "").replace(/\|/g, " ");
    for (const part of line.split(/[ \t]+/)) {
      const run = cleanRun(part).trim();
      if (run) runs.push(run);
    }
  }
  return runs;
}

function codeLines(text) {
  const lines = String(text ?? "").split(/\n/);
  if (/^\s*(```|~~~)/.test(lines[0] ?? "")) lines.shift();
  if (/^\s*(```|~~~)/.test(lines[lines.length - 1] ?? "")) lines.pop();
  return lines;
}

function tableRuns(text) {
  const runs = [];
  for (const line of String(text ?? "").split(/\n/)) {
    if (/^\s*\|?\s*:?-{3,}/.test(line)) continue;
    for (const cell of line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|")) {
      runs.push(...textRuns(cell));
    }
  }
  return runs;
}

function styleForBlock(block) {
  if (block?.type === "title") return TITLE_STYLE;
  if (block?.type === "caption") return H2_STYLE;
  if (block?.type === "heading" && Number(block.level) <= 2) return H2_STYLE;
  if (block?.type === "code") return CODE_STYLE;
  return BODY_STYLE;
}

function textOfBlock(parsed, block) {
  if (typeof block?.text === "string") return block.text;
  if (block?.type === "image") return block.alt ?? "";
  const start = Number.isFinite(block?.start) ? block.start : 0;
  const end = Number.isFinite(block?.end) ? block.end : start;
  return String(parsed?.body ?? "").slice(start, end);
}

function fallbackTextWidth(text, style) {
  const value = String(text ?? "");
  const size = finite(style?.size) ? Number(style.size) : 16;
  const weight = Number(style?.weight) || 400;
  // Deliberately generous: a missing font metric must not choose a card that clips an
  // unbreakable run. The DOM adapter replaces this once fonts are ready.
  const factor = weight >= 600 ? 0.6 : 0.55;
  return value.length * size * factor;
}

function callTextMeasure(measure, text, style, context) {
  if (typeof measure === "function") {
    const result = measure({ kind: "text", text, style, ...context });
    if (finite(result)) return Math.max(0, Number(result));
    if (finite(result?.width)) return Math.max(0, Number(result.width));
    return fallbackTextWidth(text, style);
  }
  if (typeof measure?.textWidth === "function") {
    const result = measure.textWidth(text, style, context);
    if (finite(result)) return Math.max(0, Number(result));
    if (finite(result?.width)) return Math.max(0, Number(result.width));
    return fallbackTextWidth(text, style);
  }
  return fallbackTextWidth(text, style);
}

function callImageWidth(measure, src, context) {
  if (typeof measure === "function") {
    const result = measure({ kind: "image", src, ...context });
    return finite(result) ? Math.max(0, Number(result)) : null;
  }
  if (typeof measure?.imageWidth === "function") {
    const result = measure.imageWidth(src, context);
    return finite(result) ? Math.max(0, Number(result)) : null;
  }
  return null;
}

/**
 * Longest intrinsic content width in board pixels, excluding prose wrapping. Title, headings
 * and body runs use their real typography; images and fixed-content blocks contribute a
 * 300 px-step minimum plus any measured media width up to the automatic cap.
 */
export function intrinsicContentWidth({ parsed, layout, skin, measure, availableWidth } = {}) {
  const definition = resolveLayout(layout ?? parsed?.effectiveLayout ?? parsed?.selectedLayout);
  const context = { skin: resolveSkin(skin), layout: definition.id };
  const body = String(parsed?.body ?? "");
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  let intrinsic = 0;
  let hasWideContent = false;

  const consider = (text, style) => {
    for (const run of textRuns(text)) {
      intrinsic = Math.max(intrinsic, callTextMeasure(measure, run, style, context));
    }
  };

  for (const block of blocks) {
    if (!block || block.type === "comment" || block.type === "definition") continue;
    if (block.type === "image") {
      hasWideContent = true;
      const natural = callImageWidth(measure, block.src, context);
      if (natural === null) {
        intrinsic = Math.max(intrinsic, WIDE_CONTENT_MIN_INTRINSIC);
      } else {
        intrinsic = Math.max(intrinsic,
          Math.min(AUTO_MAX_WIDTH, Math.max(WIDE_CONTENT_MIN_INTRINSIC, natural)));
      }
      continue;
    }
    if (block.type === "code") {
      hasWideContent = true;
      intrinsic = Math.max(intrinsic, WIDE_CONTENT_MIN_INTRINSIC);
      for (const line of codeLines(body.slice(block.start, block.end))) {
        if (!line) continue;
        intrinsic = Math.max(intrinsic,
          Math.min(AUTO_MAX_WIDTH, callTextMeasure(measure, line, CODE_STYLE, context)));
      }
      continue;
    }
    if (block.type === "table") {
      hasWideContent = true;
      intrinsic = Math.max(intrinsic, WIDE_CONTENT_MIN_INTRINSIC);
      for (const run of tableRuns(body.slice(block.start, block.end))) {
        // Cell padding + border; the table itself may scroll horizontally beyond the cap.
        intrinsic = Math.max(intrinsic,
          Math.min(AUTO_MAX_WIDTH, callTextMeasure(measure, run, BODY_STYLE, context) + 24));
      }
      continue;
    }
    const style = styleForBlock(block);
    const text = textOfBlock(parsed, block);
    if (block.type === "list" || block.type === "quote") {
      for (const run of textRuns(text)) {
        intrinsic = Math.max(intrinsic, callTextMeasure(measure, run, style, context));
      }
    } else {
      consider(text, style);
    }
  }

  // Images in reference definitions or raw image paragraphs are not always block entries.
  for (const src of parsed?.imageSources ?? []) {
    hasWideContent = true;
    const natural = callImageWidth(measure, src, context);
    intrinsic = Math.max(intrinsic, natural === null
      ? WIDE_CONTENT_MIN_INTRINSIC
      : Math.min(AUTO_MAX_WIDTH, Math.max(WIDE_CONTENT_MIN_INTRINSIC, natural)));
  }

  if (hasWideContent) intrinsic = Math.max(intrinsic, WIDE_CONTENT_MIN_INTRINSIC);
  return intrinsic;
}

function allowedSteps(definition, availableWidth) {
  const steps = definition.widths;
  const available = Number(availableWidth);
  if (!finite(available) || available <= 0) return steps;
  const fitting = steps.filter(step => step <= available);
  return fitting.length ? fitting : [steps[0]];
}

function chooseStep(steps, required) {
  return steps.find(step => step >= required) ?? steps[steps.length - 1];
}

/**
 * Chooses the smallest permitted automatic width containing the longest unbreakable run plus
 * 40 px padding. Content past the 380 px cap wraps (prose) or scrolls (tables/code); the card
 * never grows past the available inner width when one is supplied.
 */
export function measureIntrinsic({ parsed, layout, skin, measure, availableWidth } = {}) {
  const definition = resolveLayout(layout ?? parsed?.effectiveLayout ?? parsed?.selectedLayout);
  const intrinsic = intrinsicContentWidth({ parsed, layout: definition, skin, measure, availableWidth });
  const steps = allowedSteps(definition, availableWidth);
  return chooseStep(steps, intrinsic + SIZING_PADDING);
}

// --- Height --------------------------------------------------------------------------------

function fallbackHeight({ parsed, width, layout }) {
  const inner = Math.max(60, Number(width) - SIZING_PADDING);
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  let height = SIZING_PADDING + 2;
  const wrapped = (text, style) => {
    const per = Math.max(1, Math.floor(inner / Math.max(1, style.size * 0.55)));
    let lines = 0;
    for (const line of String(text ?? "").split(/\n/)) {
      lines += Math.max(1, Math.ceil(cleanRun(line).length / per));
    }
    return lines;
  };
  for (const block of blocks) {
    if (!block || block.type === "comment" || block.type === "definition") continue;
    if (block.type === "image") {
      height += block.type === "image" && layout === "profile" ? 220 : 180;
      continue;
    }
    if (block.type === "code") {
      const lines = Math.max(1, codeLines(parsed.body.slice(block.start, block.end)).length);
      height += lines * 20 + 16;
      continue;
    }
    if (block.type === "table") {
      const rows = Math.max(1, parsed.body.slice(block.start, block.end).split(/\n/).length);
      height += rows * 28;
      continue;
    }
    const style = styleForBlock(block);
    const text = textOfBlock(parsed, block);
    height += wrapped(text, style) * (style.size * style.lineHeight) + 2;
    if (block.type === "paragraph" || block.type === "list" || block.type === "quote") height += 8;
  }
  return height;
}

function callHeightMeasure(measure, payload) {
  if (typeof measure === "function") {
    const result = measure({ kind: "height", ...payload });
    if (finite(result)) return Math.max(0, Number(result));
    if (finite(result?.height)) return Math.max(0, Number(result.height));
    return null;
  }
  if (typeof measure?.heightAtWidth === "function") {
    const result = measure.heightAtWidth(payload);
    if (finite(result)) return Math.max(0, Number(result));
    if (finite(result?.height)) return Math.max(0, Number(result.height));
    return null;
  }
  if (typeof measure?.height === "function") {
    const result = measure.height(payload);
    if (finite(result)) return Math.max(0, Number(result));
    if (finite(result?.height)) return Math.max(0, Number(result.height));
    return null;
  }
  return null;
}

/**
 * Automatic card size: width from the deterministic steps, height from rendered content at
 * that width (minimum 120). No height cap and no fixed-height body: content is never cropped.
 */
export function computeAutoSize({ parsed, layout, skin, measure, availableWidth, html } = {}) {
  const definition = resolveLayout(layout ?? parsed?.effectiveLayout ?? parsed?.selectedLayout);
  const width = measureIntrinsic({ parsed, layout: definition, skin, measure, availableWidth });
  const resolvedSkin = resolveSkin(skin);
  const measured = callHeightMeasure(measure, {
    html: typeof html === "string" ? html : undefined,
    parsed,
    width,
    layout: definition.id,
    skin: resolvedSkin,
    style: BODY_STYLE
  });
  const height = Math.max(definition.minHeight ?? AUTO_MIN_HEIGHT,
    Math.ceil(measured ?? fallbackHeight({ parsed, width, layout: definition.id })));
  return { width, height };
}

// --- Cache ---------------------------------------------------------------------------------

/** Deterministic FNV-1a hash over UTF-16 code units. */
export function sizingHash(value) {
  const text = String(value ?? "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Cache identity for one automatic size. Body, effective layout, appearance, available width
 * and the font/image generations must all agree before a cached size may be reused.
 */
export function autoSizeCacheKey({
  parsed, layout, skin, availableWidth, fontVersion = 0, imageVersion = 0
} = {}) {
  const definition = resolveLayout(layout ?? parsed?.effectiveLayout ?? parsed?.selectedLayout);
  const resolved = resolveSkin(skin);
  return [
    sizingHash(parsed?.body ?? ""),
    definition.id,
    resolved.paper,
    resolved.font,
    resolved.torn ? "1" : "0",
    resolved.backgroundImage ?? "",
    finite(availableWidth) ? String(availableWidth) : "full",
    String(fontVersion ?? 0),
    String(imageVersion ?? 0)
  ].join("|");
}

// --- DOM measurement adapter ---------------------------------------------------------------

function setCssVars(element, vars) {
  for (const [property, value] of Object.entries(vars ?? {})) {
    element.style.setProperty(property, value);
  }
}

function numericFont(style) {
  const size = finite(style?.size) ? Number(style.size) : 16;
  const weight = Number(style?.weight) || 400;
  const family = style?.family || "inherit";
  return `${weight} ${size}px ${family}`;
}

/**
 * Offscreen measurement surface using the real card CSS and bundled fonts.
 *
 * `document.fonts.ready`/`loadingdone`, image load and ResizeObserver callbacks live in the
 * canvas; this adapter is deliberately synchronous and stateless between calls except for one
 * reusable hidden node. Tests never need it and should inject their own `measure` function.
 */
export function createDomMeasure({ document: doc = globalThis.document, className = "jn-card-measure" } = {}) {
  let surface = null;
  let paper = null;
  let body = null;
  let contextKey = "";

  const ensure = () => {
    if (surface?.isConnected) return surface;
    if (!doc?.createElement || !doc.body) return null;
    surface = doc.createElement("div");
    surface.className = `jn-card ${className} jn-card-plain`;
    surface.setAttribute("aria-hidden", "true");
    surface.style.position = "absolute";
    surface.style.left = "-100000px";
    surface.style.top = "0";
    surface.style.visibility = "hidden";
    surface.style.pointerEvents = "none";
    surface.style.transform = "none";
    surface.style.transition = "none";
    surface.style.contain = "layout style";
    paper = doc.createElement("div");
    paper.className = "jn-card-paper";
    body = doc.createElement("div");
    body.className = "jn-note-body";
    paper.append(body);
    surface.append(paper);
    doc.body.append(surface);
    contextKey = "";
    return surface;
  };

  const applyContext = ({ skin, layout } = {}) => {
    const node = ensure();
    if (!node) return null;
    const definition = resolveLayout(layout ?? "plain");
    const resolved = resolveSkin(skin);
    const key = `${definition.id}|${JSON.stringify(resolved)}`;
    if (key !== contextKey) {
      contextKey = key;
      node.classList.toggle("jn-card-profile", definition.id === "profile");
      node.classList.toggle("jn-card-plain", definition.id !== "profile");
      setCssVars(node, skinToCssVars(resolved));
    }
    return node;
  };

  return {
    /** Measures one unbreakable text run with the current skin font. */
    textWidth(text, style = {}, context = {}) {
      const node = applyContext(context);
      if (!node || !doc?.createElement) return fallbackTextWidth(text, style);
      const span = doc.createElement("span");
      span.style.position = "absolute";
      span.style.whiteSpace = "pre";
      span.style.visibility = "hidden";
      span.style.font = numericFont(style);
      span.style.fontFamily = style.family || "";
      span.style.lineHeight = String(style.lineHeight ?? 1.5);
      span.textContent = String(text ?? "");
      body.append(span);
      const width = span.getBoundingClientRect?.().width || span.offsetWidth || 0;
      span.remove();
      return width > 0 ? width : fallbackTextWidth(text, style);
    },

    /** Natural media width when the browser exposes it; null keeps the 300 px-step minimum. */
    imageWidth(src) {
      if (!src || typeof Image !== "function") return null;
      const image = new Image();
      image.src = src;
      const width = Number(image.naturalWidth);
      return Number.isFinite(width) && width > 0 ? width : null;
    },

    /** Rendered content height at a fixed card width, including paper padding. */
    heightAtWidth({ html, width, layout, skin } = {}) {
      const node = applyContext({ skin, layout });
      if (!node) return null;
      node.style.width = `${Math.max(1, Number(width) || 220)}px`;
      node.style.minHeight = "0";
      body.innerHTML = typeof html === "string" ? html : "";
      if (layout === "profile") {
        body.querySelector("img")?.classList.add("jn-profile-portrait");
      }
      const height = node.getBoundingClientRect?.().height || node.offsetHeight || 0;
      body.replaceChildren();
      return height > 0 ? height : null;
    },

    /** Removes the hidden node; called when a canvas disconnects. */
    dispose() {
      surface?.remove();
      surface = paper = body = null;
      contextKey = "";
    }
  };
}

export default computeAutoSize;
