/**
 * Declarative skin registry.
 *
 * Papers and fonts are appearance-only. Tilt is derived deterministically from a
 * stable FNV-1a hash of the note id, so every client and reload agrees without
 * storing randomized rotation. CSS values are emitted with fixed names for the
 * rendering layer; they are plain values, never interpolated into HTML.
 */

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const UINT32_RANGE = 0x100000000;

export const PAPERS = deepFreeze({
  cream: {
    labelKey: "JN.Skin.PaperCream",
    paperToken: "--jn-sc-paper-document",
    tilt: [0, 0]
  },
  amber: {
    labelKey: "JN.Skin.PaperAmber",
    paperToken: "--jn-sc-paper-memo",
    tilt: [-2, 2]
  },
  parchment: {
    labelKey: "JN.Skin.PaperParchment",
    paperToken: "--jn-sc-paper-target",
    tilt: [-1, 1]
  }
});

export const FONTS = deepFreeze({
  default: { labelKey: "JN.Skin.FontDefault", stackToken: "--jn-sc-font-body" },
  serif: { labelKey: "JN.Skin.FontSerif", stackToken: "--jn-sc-font-formal" },
  handwritten: { labelKey: "JN.Skin.FontHandwritten", stackToken: "--jn-sc-font-hand" },
  display: { labelKey: "JN.Skin.FontDisplay", stackToken: "--jn-sc-font-display" }
});

export const DEFAULT_SKIN = deepFreeze({
  paper: "amber",
  font: "default",
  torn: false,
  backgroundImage: null,
  tiltSeed: 0
});

export function isPaper(value) {
  return typeof value === "string" && Object.hasOwn(PAPERS, value);
}

export function isFont(value) {
  return typeof value === "string" && Object.hasOwn(FONTS, value);
}

function skinSource(noteOrSkin) {
  if (!noteOrSkin || typeof noteOrSkin !== "object") return {};
  if (noteOrSkin.system && typeof noteOrSkin.system === "object") {
    return noteOrSkin.system.skin && typeof noteOrSkin.system.skin === "object"
      ? noteOrSkin.system.skin
      : {};
  }
  if (noteOrSkin.skin && typeof noteOrSkin.skin === "object") return noteOrSkin.skin;
  return noteOrSkin;
}

/**
 * Normalizes a note (shared or private), a raw `skin` object, or nothing at all to
 * a complete skin with known paper/font values. Invalid values fall back to the
 * defaults instead of being persisted as-is.
 */
export function resolveSkin(noteOrSkin) {
  const source = skinSource(noteOrSkin);
  const background = typeof source.backgroundImage === "string"
    && source.backgroundImage.trim().length > 0
    ? source.backgroundImage
    : null;
  const tiltSeed = Number.isInteger(source.tiltSeed) && source.tiltSeed >= 0
    ? source.tiltSeed
    : DEFAULT_SKIN.tiltSeed;
  return {
    paper: isPaper(source.paper) ? source.paper : DEFAULT_SKIN.paper,
    font: isFont(source.font) ? source.font : DEFAULT_SKIN.font,
    torn: source.torn === true,
    backgroundImage: background,
    tiltSeed
  };
}

/**
 * Stable unsigned 32-bit FNV-1a hash over the UTF-8 bytes of the note id.
 * Same id -> same seed in every browser and after reloads.
 */
export function seedForNote(noteId) {
  const bytes = new TextEncoder().encode(String(noteId ?? ""));
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Copy of a resolved skin with the deterministic seed for `noteId`. */
export function seededSkin(skin, noteId) {
  return { ...resolveSkin(skin), tiltSeed: seedForNote(noteId) };
}

/**
 * Deterministic tilt in degrees, rounded to 0.1. Cream is always flat; Amber and
 * Parchment map the seed uniformly into their registry ranges.
 */
export function tiltForSkin(skin) {
  const resolved = resolveSkin(skin);
  const paper = PAPERS[resolved.paper];
  const [min, max] = paper.tilt;
  if (min === 0 && max === 0) return 0;
  const fraction = resolved.tiltSeed / UINT32_RANGE;
  const value = Math.round((min + (max - min) * fraction) * 10) / 10;
  if (value === 0) return 0;
  return Math.min(max, Math.max(min, value));
}

function cssString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\f]/g, " ");
}

/**
 * Stable CSS custom properties consumed by the note renderer. `rotation` may be
 * supplied by a manual rotation override; otherwise the seeded paper tilt is used.
 */
export function skinToCssVars(skin, { rotation } = {}) {
  const resolved = resolveSkin(skin);
  const paper = PAPERS[resolved.paper];
  const font = FONTS[resolved.font];
  const tilt = Number.isFinite(rotation) ? rotation : tiltForSkin(resolved);
  return {
    "--jn-skin-paper-token": `var(${paper.paperToken})`,
    "--jn-note-font": `var(${font.stackToken})`,
    "--jn-note-rotation": `${tilt}deg`,
    "--jn-skin-torn": resolved.torn ? "1" : "0",
    "--jn-skin-bg": resolved.backgroundImage
      ? `url("${cssString(resolved.backgroundImage)}")`
      : "none"
  };
}
