/**
 * Theme system (spec §4.5 extension).
 *
 * A theme is a declarative token set, never arbitrary CSS. It can restyle the board
 * background, every note type's surface/frame/typography, and the shared colour roles.
 * That keeps themes portable, testable and safe to load from settings or another module:
 * a theme can express a look, but it cannot inject a stylesheet, fetch a remote URL from
 * `url()`, or smuggle in an `expression`.
 *
 * Two layers are kept separate on purpose:
 *   - `CARD_STYLES` (styles/registry.mjs) is structure + behaviour: class name, tilt, size.
 *   - a theme's `styles[key]` is the skin for that structure: surface, edge, radius, shadow,
 *     title/heading/body type. Note types never change; only their visuals do.
 *
 * Colour values may be literals ("#2d2e32") or references to another role ("panel", "text").
 * References are resolved when the theme is applied, so overriding `text` automatically
 * repaints everything that defaults to `text`.
 */
import { CARD_STYLES } from "./registry.mjs";
import { LINK_COLOR_SLOTS } from "../link-colors.mjs";
import { PIN_STYLES } from "../presentation.mjs";

export const COLOR_TOKENS = Object.freeze([
  "bg", "panel", "text", "muted", "line", "acc", "gm", "hint", "thread",
  "danger", "dangerBg", "dangerText", "onAccent", "shadow", "stamp"
]);

export const BOARD_PATTERNS = Object.freeze(["none", "dots", "grid"]);
export const EDGE_STYLES = Object.freeze(["solid", "dashed", "dotted", "none"]);
export const IMAGE_SIZES = Object.freeze(["cover", "contain", "tile"]);
export const TEXT_TRANSFORMS = Object.freeze(["none", "uppercase", "lowercase", "capitalize"]);
export const ALIGNMENTS = Object.freeze(["left", "center", "right"]);
export const FONT_KEYS = Object.freeze(["system", "serif", "mono", "rounded"]);
export const SHADOW_KEYS = Object.freeze(["none", "flat", "paper", "raised", "deep"]);
export const LINK_SHADOW_KEYS = Object.freeze(["none", "soft"]);

/**
 * Material typography is a bounded enum, never a raw CSS font stack. The keys map to the
 * locally bundled families (see styles/fonts.css); unknown or misspelled keys fall back.
 */
export const MATERIAL_FONT_KEYS = Object.freeze(["alegreya", "caveat", "fell", "oldstandard"]);

export const MATERIAL_FONT_STACKS = Object.freeze({
  alegreya: 'Alegreya, Georgia, "Times New Roman", serif',
  caveat: '"Caveat", "Segoe Print", "Bradley Hand", Georgia, serif',
  fell: '"IM Fell English", "Old Standard TT", Georgia, serif',
  oldstandard: '"Old Standard TT", Georgia, serif'
});

const MATERIAL_FONT_DEFAULTS = Object.freeze({
  body: "alegreya",
  hand: "caveat",
  display: "fell",
  formal: "oldstandard"
});

/**
 * The grain layer is a fixed bundled asset; it is not a theme-controlled URL.
 * Foundry resolves module assets from a module-prefixed data path, so the module id must be
 * part of the stored value (`getRoute` then yields `/modules/...`, not a bare `/assets/...`).
 */
export const STYLIZED_GRAIN_TILE = "modules/fvtt-journalinator/assets/stylized/grain.svg";

const FONTS = Object.freeze({
  system: "system-ui, sans-serif",
  serif: 'Georgia, "Times New Roman", serif',
  mono: "ui-monospace, monospace",
  rounded: '"Trebuchet MS", "Segoe UI", system-ui, sans-serif'
});

const SHADOWS = Object.freeze({
  none: "none",
  flat: "0 2px 6px color-mix(in srgb, var(--jn-shadow) 38%, transparent)",
  paper: "0 7px 14px color-mix(in srgb, var(--jn-shadow) 47%, transparent)",
  raised: "0 5px 12px color-mix(in srgb, var(--jn-shadow) 40%, transparent)",
  deep: "0 14px 30px color-mix(in srgb, var(--jn-shadow) 58%, transparent)"
});

/** Link threads reuse soft drop shadows; `soft` is the pre-theme look. */
const LINK_SHADOWS = Object.freeze({
  none: "drop-shadow(0 0 0 transparent)",
  soft: "drop-shadow(0 1px 1px color-mix(in srgb, var(--jn-shadow) 60%, transparent))"
});

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NAMED = /^[a-z]{3,20}$/i;
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\([0-9a-z.%\s,/+-]+\)$/i;
// Board images are local data paths only: a safe relative path inside Foundry's data folder.
const SAFE_PATH = /^[A-Za-z0-9 _./@-]+$/;
const THEME_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

const isObject = value => !!value && typeof value === "object" && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));

export function isColor(value) {
  if (typeof value !== "string" || value.length > 80) return false;
  return HEX.test(value) || NAMED.test(value) || FUNCTIONAL.test(value);
}

/** Theme ids are picker keys and setting values, so keep them to a conservative charset. */
export function isThemeId(value) {
  return typeof value === "string" && THEME_ID.test(value);
}

/** A role name (resolved later) or a literal colour. */
export function isColorRef(value) {
  return COLOR_TOKENS.includes(value) || isColor(value);
}

function colorRef(value, fallback) {
  return isColorRef(value) ? value : fallback;
}

function pickEnum(value, keys, fallback) {
  return keys.includes(value) ? value : fallback;
}

function num(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** SVG dash arrays are strings of short numbers; anything else falls back. */
function dashPattern(value, fallback) {
  if (typeof value !== "string") return fallback;
  const pattern = value.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  return /^\d{1,3}(?: \d{1,3}){0,7}$/.test(pattern) ? pattern : fallback;
}

function safeName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[<>&"']/g, "").trim().slice(0, 60);
  return trimmed || null;
}

function imagePath(value) {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (!path || path.length > 200) return null;
  if (path.startsWith("/") || path.includes("..")) return null;
  return SAFE_PATH.test(path) ? path : null;
}

/** Merges a partial `type` block over a full one, clamping every value. */
function normalizeType(raw, base) {
  const type = { ...base };
  if (!isObject(raw)) return type;
  if (FONT_KEYS.includes(raw.uiFont)) type.uiFont = raw.uiFont;
  if (FONT_KEYS.includes(raw.titleFont)) type.titleFont = raw.titleFont;
  if (FONT_KEYS.includes(raw.headingFont)) type.headingFont = raw.headingFont;
  if (FONT_KEYS.includes(raw.bodyFont)) type.bodyFont = raw.bodyFont;
  type.titleSize = num(raw.titleSize, 8, 40, type.titleSize);
  type.headingSize = num(raw.headingSize, 10, 60, type.headingSize);
  type.bodySize = num(raw.bodySize, 8, 26, type.bodySize);
  type.titleWeight = num(raw.titleWeight, 100, 900, type.titleWeight);
  type.headingWeight = num(raw.headingWeight, 100, 900, type.headingWeight);
  type.titleSpacing = num(raw.titleSpacing, -0.1, 0.4, type.titleSpacing);
  type.headingSpacing = num(raw.headingSpacing, -0.1, 0.5, type.headingSpacing);
  type.titleColor = colorRef(raw.titleColor, type.titleColor);
  type.headingColor = colorRef(raw.headingColor, type.headingColor);
  type.bodyColor = colorRef(raw.bodyColor, type.bodyColor);
  type.titleTransform = pickEnum(raw.titleTransform, TEXT_TRANSFORMS, type.titleTransform);
  type.headingTransform = pickEnum(raw.headingTransform, TEXT_TRANSFORMS, type.headingTransform);
  type.align = pickEnum(raw.align, ALIGNMENTS, type.align);
  return type;
}

/** Merges a partial `links` block over the defaults, clamping every value. */
function normalizeLinks(raw, board) {
  const input = isObject(raw) ? raw : {};
  const colorInput = isObject(input.colors) ? input.colors : {};
  const colors = {};
  for (const slot of LINK_COLOR_SLOTS) {
    colors[slot] = colorRef(colorInput[slot], DEFAULT_LINK_COLORS[slot]);
  }
  return {
    width: num(input.width, 0.5, 12, BASE_LINKS.width),
    selectedWidth: num(input.selectedWidth, 0.5, 16, BASE_LINKS.selectedWidth),
    dash: dashPattern(input.dash, BASE_LINKS.dash),
    hiddenDash: dashPattern(input.hiddenDash, BASE_LINKS.hiddenDash),
    dimOpacity: num(input.dimOpacity, 0, 1, BASE_LINKS.dimOpacity),
    shadow: pickEnum(input.shadow, LINK_SHADOW_KEYS, BASE_LINKS.shadow),
    arrowScale: num(input.arrowScale, 0.6, 1.8, BASE_LINKS.arrowScale),
    pinRadius: num(input.pinRadius, 2, 6, BASE_LINKS.pinRadius),
    pinFill: colorRef(input.pinFill, BASE_LINKS.pinFill),
    // Board-colored by default: on custom/image boards a --jn-bg halo leaves visible patches.
    pinStroke: colorRef(input.pinStroke, board.color),
    labelSize: num(input.labelSize, 6, 32, BASE_LINKS.labelSize),
    labelColor: colorRef(input.labelColor, BASE_LINKS.labelColor),
    halo: colorRef(input.halo, board.color),
    haloWidth: num(input.haloWidth, 0, 24, BASE_LINKS.haloWidth),
    selectColor: colorRef(input.selectColor, BASE_LINKS.selectColor),
    colors
  };
}

/**
 * Merges a partial `materials` block over the fixed Stylized Canvas defaults. Unknown keys are
 * dropped, numbers are clamped, paths go through the same safe data-path check as board images,
 * and font choices are limited to the bundled enum. No raw CSS or remote URL survives.
 */
function normalizeMaterials(raw) {
  const input = isObject(raw) ? raw : {};
  const base = BASE_MATERIALS;

  const rawBoard = isObject(input.board) ? input.board : {};
  const board = {
    cork: colorRef(rawBoard.cork, base.board.cork),
    corkTile: imagePath(rawBoard.corkTile) ?? base.board.corkTile,
    grainTile: imagePath(rawBoard.grainTile) ?? base.board.grainTile,
    size: num(rawBoard.size, 64, 640, base.board.size),
    border: colorRef(rawBoard.border, base.board.border),
    radius: num(rawBoard.radius, 0, 24, base.board.radius),
    lightOpacity: num(rawBoard.lightOpacity, 0, 0.6, base.board.lightOpacity),
    vignetteColor: colorRef(rawBoard.vignetteColor, base.board.vignetteColor),
    vignetteStart: num(rawBoard.vignetteStart, 0, 90, base.board.vignetteStart),
    vignetteEnd: num(rawBoard.vignetteEnd, 0, 100, base.board.vignetteEnd)
  };

  const rawPaper = isObject(input.paper) ? input.paper : {};
  const paper = {};
  for (const key of Object.keys(base.paper)) paper[key] = colorRef(rawPaper[key], base.paper[key]);

  const rawFonts = isObject(input.fonts) ? input.fonts : {};
  const fonts = {};
  for (const key of Object.keys(MATERIAL_FONT_DEFAULTS)) {
    fonts[key] = pickEnum(rawFonts[key], MATERIAL_FONT_KEYS, MATERIAL_FONT_DEFAULTS[key]);
  }

  const rawPins = isObject(input.pins) ? input.pins : {};
  const pins = {
    mainSize: num(rawPins.mainSize, 12, 32, base.pins.mainSize),
    minorSize: num(rawPins.minorSize, 5, 16, base.pins.minorSize),
    routeSize: num(rawPins.routeSize, 6, 24, base.pins.routeSize),
    rim: colorRef(rawPins.rim, base.pins.rim),
    defaultStyle: pickEnum(rawPins.defaultStyle, PIN_STYLES, base.pins.defaultStyle)
  };

  const rawThreads = isObject(input.threads) ? input.threads : {};
  let dyes = [...base.threads.dyes];
  if (Array.isArray(rawThreads.dyes)) {
    const valid = rawThreads.dyes.filter(isColorRef).slice(0, 6);
    dyes = Array.from({ length: 6 }, (_, index) => valid[index] ?? base.threads.dyes[index]);
  }
  const threads = {
    dyes,
    accent: colorRef(rawThreads.accent, base.threads.accent),
    shadow: colorRef(rawThreads.shadow, base.threads.shadow),
    fade: num(rawThreads.fade, 0, 1, base.threads.fade),
    fadeTime: Math.round(num(rawThreads.fadeTime, 0, 400, base.threads.fadeTime))
  };

  return { board, paper, fonts, pins, threads };
}

const BASE_TYPE = Object.freeze({
  uiFont: "system",
  titleFont: "system", titleSize: 14, titleWeight: 600, titleSpacing: 0,
  titleColor: "text", titleTransform: "none",
  headingFont: "serif", headingSize: 23, headingWeight: 800, headingSpacing: 0.075,
  headingColor: "muted", headingTransform: "uppercase",
  bodyFont: "system", bodySize: 11.5, bodyColor: "muted",
  align: "left"
});

const BASE_STYLE = Object.freeze({
  surface: "panel", surfaceAlpha: 1,
  edge: "line", edgeWidth: 1, edgeStyle: "solid",
  radius: 6, shadow: "raised",
  text: "text", imageOpacity: 0.78, stripe: 3,
  rule: "line", ruleWidth: 0
});

const DEFAULT_LINK_COLORS = Object.freeze({ link1: "acc", link2: "hint", link3: "danger" });

/** Link defaults match the pre-theme rendering. Colors are overridden per built-in theme. */
const BASE_LINKS = Object.freeze({
  width: 2,
  selectedWidth: 3.5,
  dash: "7 6",
  hiddenDash: "2 6",
  dimOpacity: 0.15,
  shadow: "soft",
  arrowScale: 1,
  pinRadius: 3,
  pinFill: "acc",
  labelSize: 11,
  labelColor: "muted",
  haloWidth: 7,
  selectColor: "acc",
  colors: DEFAULT_LINK_COLORS
});

/**
 * Selected Stylized Canvas materials (spec §2, visual reference). These are the only
 * defaults: legacy and custom theme inputs normalize to them, because the new presentation
 * deliberately does not preserve old palettes or card surfaces.
 */
export const STYLIZED_MATERIALS = Object.freeze({
  board: {
    cork: "#7b5233",
    // Module-prefixed so `foundry.utils.getRoute` produces a working module URL. Custom themes
    // still pass through `imagePath` and remain safe relative data paths (no module rewrite).
    corkTile: "modules/fvtt-journalinator/assets/stylized/cork.svg",
    // Paper grain multiplied over every note. A board background may bring its own so the paper
    // never shares the board's texture.
    grainTile: STYLIZED_GRAIN_TILE,
    size: 320,
    border: "#5a402d",
    radius: 8,
    lightOpacity: 0.12,
    vignetteColor: "rgba(8, 4, 0, 0.55)",
    vignetteStart: 38,
    vignetteEnd: 100
  },
  paper: {
    compact: "#d9c08f",
    memo: "#ead9b4",
    document: "#efe5c9",
    target: "#e8dbc0",
    fiber: "#f0e4c9",
    ink: "#3c2b19",
    inkFace: "#45321f",
    rule: "rgba(107,81,37,.12)",
    docMargin: "rgba(139,102,55,.14)"
  },
  fonts: { ...MATERIAL_FONT_DEFAULTS },
  pins: { mainSize: 20, minorSize: 9, routeSize: 12, rim: "#b69a67", defaultStyle: "enamel" },
  threads: {
    dyes: ["#b85d4d", "#c7a45e", "#8fa574", "#7297b2", "#ac89aa", "#d1c2a0"],
    accent: "#d8c49d",
    shadow: "#21150c",
    fade: 0.15,
    fadeTime: 160
  }
});

const BASE_MATERIALS = STYLIZED_MATERIALS;

/** The current look, expressed in the new token vocabulary. */
export const CLASSIC_THEME = Object.freeze({
  id: "classic",
  nameKey: "JN.Theme.Classic",
  colors: {
    bg: "#1b1b1d", panel: "#252528", text: "#dcdce0", muted: "#8d8d97",
    line: "#3a3a41", acc: "#a393f2", gm: "#6fb3c4", hint: "#d6a45c",
    thread: "#8e8e9a", danger: "#a85a5a", dangerBg: "#4a2a2a",
    dangerText: "#e8b9b9", onAccent: "#17171a", shadow: "#000000", stamp: "#e8d9b9"
  },
  board: {
    color: "bg", pattern: "dots", patternColor: "#2d2d33", patternSize: 320,
    patternOpacity: 1, image: null, imageOpacity: 1, imageSize: "cover", vignette: 0
  },
  // The old toolbar palette, kept verbatim so existing worlds look untouched.
  links: {
    ...BASE_LINKS,
    colors: { link1: "#a393f2", link2: "#d6a45c", link3: "#d77b91" }
  },
  type: {},
  styles: {
    sticky: { surface: "#2d2e32", surfaceAlpha: 1, edgeWidth: 0, edgeStyle: "none", radius: 3, shadow: "paper" },
    document: {
      surface: "#2b2b31", edge: "#3f3f47", edgeWidth: 1, edgeStyle: "solid", radius: 6,
      shadow: "raised", rule: "#46464f", ruleWidth: 1,
      type: { titleFont: "serif", titleSize: 15 }
    },
    torn: { surface: "#35302a", edgeWidth: 0, edgeStyle: "none", radius: 0, shadow: "none" },
    wanted: {
      surface: "panel", edge: "line", edgeWidth: 1, radius: 6, shadow: "raised",
      rule: "line", ruleWidth: 1,
      type: { align: "center", titleFont: "system", titleSize: 16, titleWeight: 650, headingColor: "muted", bodySize: 12 }
    },
    memo: {
      surface: "panel", edge: "line", edgeWidth: 1, radius: 6, shadow: "raised",
      type: { bodySize: 14, bodyColor: "text" }
    }
  }
});

export const WARM_THEME = Object.freeze({
  id: "fantasy",
  nameKey: "JN.Theme.Fantasy",
  colors: {
    bg: "#211912", panel: "#33251a", text: "#f1e4c9", muted: "#cbb38e",
    line: "#674b32", acc: "#e1b66e", gm: "#90b9a7", hint: "#f0c47a",
    thread: "#bb5d69", danger: "#b85347", dangerBg: "#43201c",
    dangerText: "#f0c6bd", onAccent: "#17171a", shadow: "#150906", stamp: "#e6d6b4"
  },
  board: {
    color: "#281e18", pattern: "dots", patternColor: "#4a3628", patternSize: 320,
    patternOpacity: 1, image: null, imageOpacity: 1, imageSize: "cover", vignette: 0.22
  },
  links: {
    colors: { link1: "#c98a52", link2: "#93a86b", link3: "#a97ba8" }
  },
  type: { uiFont: "system" },
  styles: {
    sticky: { surface: "#49372b", radius: 4, shadow: "paper" },
    document: { surface: "#3e3027", edge: "line", rule: "line" },
    torn: { surface: "#48372b" },
    wanted: { surface: "panel" },
    memo: { surface: "panel" }
  }
});

/** Light, printed-paper theme. Exists to prove a theme can leave the dark palette entirely. */
export const PARCHMENT_THEME = Object.freeze({
  id: "parchment",
  nameKey: "JN.Theme.Parchment",
  colors: {
    bg: "#e7ddc6", panel: "#f4eddd", text: "#3a2f23", muted: "#6d5c46",
    line: "#c6b795", acc: "#8a5a2b", gm: "#3f7a63", hint: "#a9741c",
    thread: "#99694a", danger: "#a33b3b", dangerBg: "#f1d3d0",
    dangerText: "#6b1f1f", onAccent: "#fff8ec", shadow: "#2b1d0f", stamp: "#f6efdc"
  },
  board: {
    color: "#e7ddc6", pattern: "grid", patternColor: "#c6b795", patternSize: 320,
    patternOpacity: 0.55, image: null, imageOpacity: 1, imageSize: "cover", vignette: 0.08
  },
  links: {
    colors: { link1: "#7a4fa0", link2: "#2f6f8f", link3: "#a8443f" }
  },
  type: {
    uiFont: "system", titleFont: "serif", headingFont: "serif", bodyFont: "serif",
    titleWeight: 700, titleSize: 15, bodySize: 12
  },
  styles: {
    sticky: {
      surface: "#f6e6a6", surfaceAlpha: 1, edge: "#d8c37a", edgeWidth: 1, edgeStyle: "solid",
      radius: 2, shadow: "flat", ruleWidth: 0, text: "#3a2f23",
      type: { titleFont: "serif", titleSize: 14, bodyColor: "#6a573a" }
    },
    document: {
      surface: "#fbf6ea", edge: "#c6b795", edgeWidth: 1, radius: 3, shadow: "flat",
      rule: "#d8cbb0", ruleWidth: 1, text: "#3a2f23",
      type: { titleFont: "serif", titleSize: 15 }
    },
    torn: { surface: "#f1e6cf", edgeWidth: 0, edgeStyle: "none", radius: 0, shadow: "none", text: "#3a2f23" },
    wanted: {
      surface: "#fbf6ea", edge: "#c6b795", edgeWidth: 1, radius: 3, shadow: "flat",
      rule: "#d8cbb0", ruleWidth: 1, text: "#3a2f23",
      type: { align: "center", headingColor: "#6d5c46", titleColor: "#3a2f23" }
    },
    memo: {
      surface: "#fbf6ea", edge: "#c6b795", edgeWidth: 1, radius: 3, shadow: "flat", text: "#3a2f23"
    }
  }
});

/**
 * The new default. Chrome/colour roles stay on the compatible classic palette so the existing
 * CSS-variable API keeps working; all canvas surfaces come from `materials`, and the old board
 * pattern is disabled by `applyTheme`.
 */
export const STYLIZED_THEME = Object.freeze({
  id: "stylized",
  nameKey: "JN.Theme.Stylized",
  colors: { ...CLASSIC_THEME.colors },
  board: { ...CLASSIC_THEME.board, pattern: "none" },
  // Dye-based link defaults replace the old toolbar palette; the reference endpoint pin is 4px.
  links: {
    ...CLASSIC_THEME.links,
    pinRadius: 4,
    colors: { link1: "#b85d4d", link2: "#c7a45e", link3: "#8fa574" }
  },
  type: {},
  materials: STYLIZED_MATERIALS,
  styles: {}
});

/** Fine, neutral paper fibre used by the photo-based boards (the cork SVG noise stays on the original). */
export const PAPER_FINE_GRAIN_TILE = "modules/fvtt-journalinator/assets/stylized/paper-fine.svg";

/**
 * Board backgrounds. Only the board surface differs; paper, pins, threads and fonts stay the
 * shared Stylized materials, so a background is a pure picker choice.
 */
function boardBackground(id, nameKey, board) {
  return Object.freeze({
    ...STYLIZED_THEME,
    id,
    nameKey,
    materials: { ...STYLIZED_MATERIALS, board: { ...STYLIZED_MATERIALS.board, ...board } }
  });
}

export const CORK_PHOTO_THEME = boardBackground("cork-photo", "JN.Theme.CorkPhoto", {
  cork: "#6f4d33",
  corkTile: "modules/fvtt-journalinator/assets/boards/cork-photo.webp",
  grainTile: PAPER_FINE_GRAIN_TILE,
  size: 480,
  border: "#4a3322"
});

export const GREY_PAPER_THEME = boardBackground("grey-paper", "JN.Theme.GreyPaper", {
  cork: "#69635a",
  corkTile: "modules/fvtt-journalinator/assets/boards/grey-paper.webp",
  grainTile: PAPER_FINE_GRAIN_TILE,
  size: 400,
  border: "#3f3b35",
  lightOpacity: 0.06,
  vignetteColor: "rgba(10, 8, 6, 0.5)"
});

/**
 * Fills a partial theme out to a complete, safe one. Unknown keys are dropped; every number
 * is clamped; images are restricted to Foundry data paths.
 */
export function normalizeTheme(raw, { id = "custom", name = null } = {}) {
  const input = isObject(raw) ? raw : {};
  const base = CLASSIC_THEME;

  const colors = {};
  for (const token of COLOR_TOKENS) {
    colors[token] = colorRef(isObject(input.colors) ? input.colors[token] : null, base.colors[token]);
  }

  const rawBoard = isObject(input.board) ? input.board : {};
  const board = {
    color: colorRef(rawBoard.color, base.board.color),
    pattern: pickEnum(rawBoard.pattern, BOARD_PATTERNS, base.board.pattern),
    patternColor: colorRef(rawBoard.patternColor, base.board.patternColor),
    patternSize: num(rawBoard.patternSize, 4, 640, base.board.patternSize),
    patternOpacity: num(rawBoard.patternOpacity, 0, 1, base.board.patternOpacity),
    image: imagePath(rawBoard.image),
    imageOpacity: num(rawBoard.imageOpacity, 0, 1, base.board.imageOpacity),
    imageSize: pickEnum(rawBoard.imageSize, IMAGE_SIZES, base.board.imageSize),
    vignette: num(rawBoard.vignette, 0, 1, base.board.vignette)
  };
  const links = normalizeLinks(input.links, board);

  const globalType = normalizeType(input.type, { ...BASE_TYPE, ...(base.type ?? {}) });
  const styleInput = isObject(input.styles) ? input.styles : {};
  const styles = {};
  for (const styleKey of Object.keys(CARD_STYLES)) {
    const baseStyle = base.styles[styleKey] ?? {};
    // File defaults → this theme's defaults for the style → the style override.
    const frameDefaults = {
      surface: baseStyle.surface ?? BASE_STYLE.surface,
      surfaceAlpha: baseStyle.surfaceAlpha ?? BASE_STYLE.surfaceAlpha,
      edge: baseStyle.edge ?? BASE_STYLE.edge,
      edgeWidth: baseStyle.edgeWidth ?? BASE_STYLE.edgeWidth,
      edgeStyle: baseStyle.edgeStyle ?? BASE_STYLE.edgeStyle,
      radius: baseStyle.radius ?? BASE_STYLE.radius,
      shadow: baseStyle.shadow ?? BASE_STYLE.shadow,
      text: baseStyle.text ?? BASE_STYLE.text,
      imageOpacity: baseStyle.imageOpacity ?? BASE_STYLE.imageOpacity,
      stripe: baseStyle.stripe ?? BASE_STYLE.stripe,
      rule: baseStyle.rule ?? BASE_STYLE.rule,
      ruleWidth: baseStyle.ruleWidth ?? BASE_STYLE.ruleWidth
    };
    const styleType = normalizeType(baseStyle.type, globalType);
    styles[styleKey] = normalizeStyle(styleInput[styleKey], styleType, frameDefaults);
  }

  return {
    id: THEME_ID.test(id) ? id : "custom",
    name: safeName(name),
    nameKey: typeof input.nameKey === "string" ? input.nameKey : null,
    colors,
    board,
    links,
    materials: normalizeMaterials(input.materials),
    type: globalType,
    styles
  };
}

function normalizeStyle(raw, inheritedType, frameDefaults = BASE_STYLE) {
  const input = isObject(raw) ? raw : {};
  const defaults = frameDefaults;
  return {
    surface: colorRef(input.surface, defaults.surface),
    surfaceAlpha: num(input.surfaceAlpha, 0, 1, defaults.surfaceAlpha),
    edge: colorRef(input.edge, defaults.edge),
    edgeWidth: num(input.edgeWidth, 0, 12, defaults.edgeWidth),
    edgeStyle: pickEnum(input.edgeStyle, EDGE_STYLES, defaults.edgeStyle),
    radius: num(input.radius, 0, 48, defaults.radius),
    shadow: pickEnum(input.shadow, SHADOW_KEYS, defaults.shadow),
    text: colorRef(input.text, defaults.text),
    imageOpacity: num(input.imageOpacity, 0, 1, defaults.imageOpacity),
    stripe: num(input.stripe, 0, 10, defaults.stripe),
    rule: colorRef(input.rule, defaults.rule),
    ruleWidth: num(input.ruleWidth, 0, 8, defaults.ruleWidth),
    type: normalizeType(input.type, inheritedType)
  };
}

function resolveColor(value, colors) {
  return COLOR_TOKENS.includes(value) ? (colors[value] ?? "#000000") : value;
}

function pixel(n) {
  return `${Math.round(n * 100) / 100}px`;
}

/** Mask luminance is painted as an opaque gray, so a fade of .15 becomes rgb(38,38,38). */
function maskFill(value) {
  const fade = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const channel = Math.round(fade * 255);
  return `rgb(${channel},${channel},${channel})`;
}

/** A data path as an inline `url()`; theme images never leave the Foundry routes. */
function cssUrl(path) {
  if (!path) return "none";
  let route = path;
  try {
    route = globalThis.foundry?.utils?.getRoute?.(path) ?? path;
    route = new URL(route, globalThis.document?.baseURI ?? "http://localhost/").href;
  } catch {
    // jsdom / about:blank: keep the route as-is, it is still a safe relative path.
  }
  return `url("${String(route).replace(/"/g, "%22")}")`;
}

/** Theme → CSS custom properties. Pure: safe to unit-test without a DOM. */
export function themeToVars(theme) {
  const vars = {};
  const { colors, board } = theme;

  vars["--jn-bg"] = colors.bg;
  vars["--jn-panel"] = colors.panel;
  vars["--jn-text"] = colors.text;
  vars["--jn-muted"] = colors.muted;
  vars["--jn-line"] = colors.line;
  vars["--jn-acc"] = colors.acc;
  vars["--jn-gm"] = colors.gm;
  vars["--jn-hint"] = colors.hint;
  vars["--jn-thread"] = colors.thread;
  vars["--jn-danger"] = colors.danger;
  vars["--jn-danger-bg"] = colors.dangerBg;
  vars["--jn-danger-text"] = colors.dangerText;
  vars["--jn-on-accent"] = colors.onAccent;
  vars["--jn-shadow"] = colors.shadow;
  vars["--jn-stamp-bg"] = colors.stamp;

  const boardColor = resolveColor(board.color, colors);
  vars["--jn-board-color"] = boardColor;
  vars["--jn-board-pattern-color"] = resolveColor(board.patternColor, colors);
  vars["--jn-board-pattern-size"] = pixel(board.patternSize);
  vars["--jn-board-pattern-opacity"] = String(board.patternOpacity);
  vars["--jn-board-image"] = cssUrl(board.image);
  vars["--jn-board-image-fade"] = String(1 - board.imageOpacity);
  vars["--jn-board-image-size"] = board.imageSize === "tile" ? "auto" : board.imageSize;
  vars["--jn-board-image-repeat"] = board.imageSize === "tile" ? "repeat" : "no-repeat";
  vars["--jn-board-vignette"] = String(board.vignette);

  const links = theme.links ?? {};
  const linkColors = links.colors ?? DEFAULT_LINK_COLORS;
  vars["--jn-link-width"] = String(links.width ?? BASE_LINKS.width);
  vars["--jn-link-width-selected"] = String(links.selectedWidth ?? BASE_LINKS.selectedWidth);
  vars["--jn-link-dash"] = links.dash ?? BASE_LINKS.dash;
  vars["--jn-link-dash-hidden"] = links.hiddenDash ?? BASE_LINKS.hiddenDash;
  vars["--jn-link-dim-opacity"] = String(links.dimOpacity ?? BASE_LINKS.dimOpacity);
  vars["--jn-link-shadow"] = LINK_SHADOWS[links.shadow] ?? LINK_SHADOWS[BASE_LINKS.shadow];
  vars["--jn-link-arrow-scale"] = String(links.arrowScale ?? BASE_LINKS.arrowScale);
  vars["--jn-link-pin-radius"] = pixel(links.pinRadius ?? BASE_LINKS.pinRadius);
  vars["--jn-link-pin-fill"] = resolveColor(links.pinFill ?? BASE_LINKS.pinFill, colors);
  vars["--jn-link-pin-stroke"] = resolveColor(links.pinStroke ?? board.color, colors);
  vars["--jn-link-label-size"] = pixel(links.labelSize ?? BASE_LINKS.labelSize);
  vars["--jn-link-label-color"] = resolveColor(links.labelColor ?? BASE_LINKS.labelColor, colors);
  vars["--jn-link-halo"] = resolveColor(links.halo ?? board.color, colors);
  vars["--jn-link-halo-width"] = pixel(links.haloWidth ?? BASE_LINKS.haloWidth);
  vars["--jn-link-select"] = resolveColor(links.selectColor ?? BASE_LINKS.selectColor, colors);
  for (const [index, slot] of LINK_COLOR_SLOTS.entries()) {
    vars[`--jn-link-${index + 1}`] = resolveColor(linkColors[slot] ?? DEFAULT_LINK_COLORS[slot], colors);
  }

  const uiFont = theme.type?.uiFont ?? "system";
  vars["--jn-ui-font"] = FONTS[uiFont] ?? FONTS.system;

  // --- Stylized Canvas material tokens -------------------------------------------------------
  // A normalized theme always has `materials`; re-normalizing here also makes the emitter safe
  // for the exported frozen theme constants and for callers that pass a raw theme.
  const materials = normalizeMaterials(theme.materials);
  const materialBoard = materials.board;
  const materialPaper = materials.paper;

  vars["--jn-sc-cork"] = resolveColor(materialBoard.cork, colors);
  vars["--jn-sc-cork-tile"] = cssUrl(materialBoard.corkTile);
  vars["--jn-sc-cork-size"] = pixel(materialBoard.size);
  vars["--jn-sc-board-border"] = resolveColor(materialBoard.border, colors);
  vars["--jn-sc-board-radius"] = pixel(materialBoard.radius);
  // `stylized.css` composes these colours and the normalized stops into its highlight/vignette
  // layers, so a theme can move the vignette without editing CSS.
  vars["--jn-sc-board-light"] = `rgba(255, 225, 160, ${materialBoard.lightOpacity})`;
  vars["--jn-sc-board-vignette"] = resolveColor(materialBoard.vignetteColor, colors);
  vars["--jn-sc-board-vignette-start"] = `${materialBoard.vignetteStart}%`;
  vars["--jn-sc-board-vignette-end"] = `${materialBoard.vignetteEnd}%`;
  vars["--jn-sc-grain"] = cssUrl(materialBoard.grainTile);

  vars["--jn-sc-paper-compact"] = resolveColor(materialPaper.compact, colors);
  vars["--jn-sc-paper-memo"] = resolveColor(materialPaper.memo, colors);
  vars["--jn-sc-paper-document"] = resolveColor(materialPaper.document, colors);
  vars["--jn-sc-paper-target"] = resolveColor(materialPaper.target, colors);
  vars["--jn-sc-torn-fiber"] = resolveColor(materialPaper.fiber, colors);
  vars["--jn-sc-ink"] = resolveColor(materialPaper.ink, colors);
  vars["--jn-sc-ink-face"] = resolveColor(materialPaper.inkFace, colors);
  vars["--jn-sc-rule"] = resolveColor(materialPaper.rule, colors);
  vars["--jn-sc-doc-margin"] = resolveColor(materialPaper.docMargin, colors);

  vars["--jn-sc-font-body"] = MATERIAL_FONT_STACKS[materials.fonts.body];
  vars["--jn-sc-font-hand"] = MATERIAL_FONT_STACKS[materials.fonts.hand];
  vars["--jn-sc-font-display"] = MATERIAL_FONT_STACKS[materials.fonts.display];
  vars["--jn-sc-font-formal"] = MATERIAL_FONT_STACKS[materials.fonts.formal];

  // Pins and thread materials are part of the public theme API now; the canvas consumes them in
  // Phases 4/5. Keep emitting them so themes written today keep working then.
  vars["--jn-sc-pin-main-size"] = pixel(materials.pins.mainSize);
  vars["--jn-sc-pin-minor-size"] = pixel(materials.pins.minorSize);
  vars["--jn-sc-pin-route-size"] = pixel(materials.pins.routeSize);
  vars["--jn-sc-pin-rim"] = resolveColor(materials.pins.rim, colors);
  vars["--jn-sc-pin-default"] = materials.pins.defaultStyle;

  for (const [index, dye] of materials.threads.dyes.entries()) {
    vars[`--jn-sc-thread-${index + 1}`] = resolveColor(dye, colors);
  }
  vars["--jn-sc-thread-accent"] = resolveColor(materials.threads.accent, colors);
  vars["--jn-sc-thread-shadow"] = resolveColor(materials.threads.shadow, colors);
  vars["--jn-sc-thread-fade"] = String(materials.threads.fade);
  // The mask needs a paint value, not the opacity fraction: a theme fade of .15 paints the
  // active silhouette at 15% luminance (rgb(38,38,38)) instead of a hard-coded gray.
  vars["--jn-sc-thread-fade-fill"] = maskFill(materials.threads.fade);
  vars["--jn-sc-thread-fade-time"] = `${materials.threads.fadeTime}ms`;

  for (const [styleKey, style] of Object.entries(theme.styles)) {
    const prefix = `--jn-style-${styleKey}-`;
    const type = style.type;
    vars[`${prefix}surface`] = resolveColor(style.surface, colors);
    vars[`${prefix}surface-alpha`] = String(style.surfaceAlpha);
    vars[`${prefix}edge`] = resolveColor(style.edge, colors);
    vars[`${prefix}edge-width`] = pixel(style.edgeWidth);
    vars[`${prefix}edge-style`] = style.edgeStyle;
    vars[`${prefix}radius`] = pixel(style.radius);
    vars[`${prefix}shadow`] = SHADOWS[style.shadow] ?? SHADOWS.raised;
    vars[`${prefix}text`] = resolveColor(style.text, colors);
    vars[`${prefix}image-opacity`] = String(style.imageOpacity);
    vars[`${prefix}stripe`] = pixel(style.stripe);
    vars[`${prefix}rule`] = resolveColor(style.rule, colors);
    vars[`${prefix}rule-width`] = pixel(style.ruleWidth);

    vars[`${prefix}title-font`] = FONTS[type.titleFont] ?? FONTS.system;
    vars[`${prefix}title-size`] = pixel(type.titleSize);
    vars[`${prefix}title-weight`] = String(type.titleWeight);
    vars[`${prefix}title-spacing`] = String(type.titleSpacing);
    vars[`${prefix}title-transform`] = type.titleTransform;
    vars[`${prefix}title-color`] = resolveColor(type.titleColor, colors);

    vars[`${prefix}heading-font`] = FONTS[type.headingFont] ?? FONTS.serif;
    vars[`${prefix}heading-size`] = pixel(type.headingSize);
    vars[`${prefix}heading-weight`] = String(type.headingWeight);
    vars[`${prefix}heading-spacing`] = String(type.headingSpacing);
    vars[`${prefix}heading-transform`] = type.headingTransform;
    vars[`${prefix}heading-color`] = resolveColor(type.headingColor, colors);

    vars[`${prefix}body-font`] = FONTS[type.bodyFont] ?? FONTS.system;
    vars[`${prefix}body-size`] = pixel(type.bodySize);
    vars[`${prefix}body-color`] = resolveColor(type.bodyColor, colors);
    vars[`${prefix}align`] = type.align;
  }

  return vars;
}

/**
 * Applies a normalized theme to a root element. All state lives on `data-*` attributes and
 * CSS custom properties, so switching themes never re-renders the canvas.
 */
export function applyTheme(root, theme) {
  if (!root) return theme;
  root.dataset.theme = theme.id;
  // Stylized Canvas is the only presentation: old dot/grid boards are never painted.
  root.dataset.visual = "stylized";
  root.dataset.boardPattern = "none";
  root.dataset.boardImage = theme.board.image ? "on" : "off";
  const vars = themeToVars(theme);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  return theme;
}

// --- registry -------------------------------------------------------------------------------

const registry = new Map();
const customSources = new Map();
const REGISTERED_ORDER = [];
export const BUILTIN_THEME_IDS = Object.freeze(["stylized", "cork-photo", "grey-paper", "classic", "fantasy", "parchment"]);
/** What the toolbar picker offers: the original procedural cork, then the two photo boards. */
export const BOARD_BACKGROUND_IDS = Object.freeze(["stylized", "cork-photo", "grey-paper"]);

/**
 * Registers (or replaces) a theme. Used by the built-ins at load time and by other modules
 * through `game.journalinator.themes.register`.
 */
export function registerTheme(id, theme, { persist = false, name = null } = {}) {
  const source = isObject(theme) ? theme : {};
  const normalized = normalizeTheme(source, { id, name: name ?? source.name ?? null });
  registry.set(normalized.id, normalized);
  if (!REGISTERED_ORDER.includes(normalized.id)) REGISTERED_ORDER.push(normalized.id);
  if (persist) customSources.set(normalized.id, clone(source));
  return normalized;
}

export function listThemes() {
  return REGISTERED_ORDER.map(id => registry.get(id)).filter(Boolean);
}

export function getTheme(id) {
  return registry.get(id) ?? registry.get(STYLIZED_THEME.id) ?? registry.get(CLASSIC_THEME.id);
}

/** Re-registers themes saved to the client setting, preserving their picker order. */
export function loadSavedThemes(saved) {
  if (!isObject(saved)) return [];
  const loaded = [];
  for (const [id, source] of Object.entries(saved)) {
    if (!isThemeId(id) || BUILTIN_THEME_IDS.includes(id)) continue;
    try {
      loaded.push(registerTheme(id, source, { persist: true }));
    } catch (err) {
      console.error(`Journalinator: could not load theme "${id}"`, err);
    }
  }
  return loaded;
}

/** Serializable copy of every theme registered with `persist: true`. */
export function savedThemes() {
  return Object.fromEntries(customSources);
}

registerTheme("stylized", STYLIZED_THEME);
registerTheme("cork-photo", CORK_PHOTO_THEME);
registerTheme("grey-paper", GREY_PAPER_THEME);
registerTheme("classic", CLASSIC_THEME);
registerTheme("fantasy", WARM_THEME);
registerTheme("parchment", PARCHMENT_THEME);
