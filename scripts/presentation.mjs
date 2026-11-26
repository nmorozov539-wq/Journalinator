/**
 * Universal note presentation model.
 *
 * A note is one primitive. `system.style` and `system.targetHeading` are legacy storage keys;
 * new records carry an explicit `system.presentation` block. Everything reading presentation
 * goes through `resolvePresentation()` so an unmigrated record still renders in the new canvas.
 */
import { isLinkColor, normalizeLinkColor } from "./link-colors.mjs";

export const PRESENTATION_STYLES = Object.freeze(["memo", "document", "target"]);
export const PICTURE_LAYOUTS = Object.freeze(["above", "below", "left", "right"]);
export const NOTE_FONT_KEYS = Object.freeze(["default", "serif", "hand", "display"]);
export const PIN_STYLES = Object.freeze(["default", "enamel", "brass", "iron", "wood", "decorative", "wax"]);
export const LINK_MATERIALS = Object.freeze(["linen", "double"]);
export const LINK_PATTERNS = Object.freeze(["continuous", "interrupted", "alternating"]);
export const LINK_ENDS = Object.freeze(["standard", "loose"]);
export const LINK_THICKNESS = Object.freeze({ min: 0.8, max: 5, initial: 2.6 });
export const LINK_SLACK = Object.freeze({ min: 0, max: 0.25, initial: 0.09 });
export const MAIN_PIN = Object.freeze({ x: 0.5, y: 0 });
export const MAIN_SNAP_RADIUS = 24;
export const MINOR_SNAP_RADIUS = 6;
export const MAX_CARD_ANCHORS = 256;
export const MAX_CARD_ANCHOR_ID_LENGTH = 100;

export const LEGACY_STYLE_MAP = Object.freeze({
  sticky: "memo",
  memo: "memo",
  document: "document",
  wanted: "target",
  torn: "memo"
});

export const DEFAULT_PRESENTATION = Object.freeze({
  extendedStyle: "memo",
  forceExtended: false,
  font: "default",
  pictureLayout: "above",
  torn: false,
  heading: "",
  nameGenerated: false
});

export const DEFAULT_ATTACHMENT = Object.freeze({
  mainPinEnabled: true,
  mainSnapRadius: MAIN_SNAP_RADIUS,
  minorSnapRadius: MINOR_SNAP_RADIUS,
  pinStyle: "default"
});

/** The presentation half of a legacy style change, matching `legacyPresentation`. */
export function legacyStylePresentation(style) {
  const legacy = Object.hasOwn(LEGACY_STYLE_MAP, style) ? style : "sticky";
  return {
    extendedStyle: LEGACY_STYLE_MAP[legacy],
    forceExtended: legacy !== "sticky",
    torn: legacy === "torn"
  };
}

/**
 * Keeps a card's anchor registry bounded and safe. Invalid entries are dropped; a main anchor
 * always sits at the canonical top-centre point, while minor anchors keep their clamped point.
 */
export function sanitizeCardAnchors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const clean = {};
  for (const [id, anchor] of Object.entries(value).slice(0, MAX_CARD_ANCHORS)) {
    if (typeof id !== "string" || !id || id.length > MAX_CARD_ANCHOR_ID_LENGTH) continue;
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) continue;
    const kind = anchor.kind === "main" || anchor.kind === "minor" ? anchor.kind : null;
    if (!kind || !Number.isFinite(anchor.x) || anchor.x < 0 || anchor.x > 1) continue;
    if (!Number.isFinite(anchor.y) || anchor.y < 0 || anchor.y > 1) continue;
    clean[id] = {
      kind,
      x: kind === "main" ? MAIN_PIN.x : anchor.x,
      y: kind === "main" ? MAIN_PIN.y : anchor.y,
      createdBy: typeof anchor.createdBy === "string"
        ? anchor.createdBy.slice(0, MAX_CARD_ANCHOR_ID_LENGTH) : ""
    };
  }
  return clean;
}

/**
 * Sanitizes a card's anchor registry and, when the note wants a main pin, adds the canonical main
 * anchor if the card has none. Existing valid minors are preserved. Callers without note context
 * pass `false` so a card cannot gain an anchor that has no owning note (e.g. a trash card whose
 * note is missing); the default `true` keeps the standalone card normalizers conventional.
 */
export function sanitizeCardAnchorsWithMain(value, mainPinEnabled = true, createdBy = "") {
  const anchors = sanitizeCardAnchors(value);
  if (!mainPinEnabled || Object.values(anchors).some(anchor => anchor.kind === "main")) return anchors;
  return {
    ...anchors,
    main: {
      kind: "main", x: MAIN_PIN.x, y: MAIN_PIN.y,
      createdBy: typeof createdBy === "string" ? createdBy.slice(0, MAX_CARD_ANCHOR_ID_LENGTH) : ""
    }
  };
}

export function defaultLinkCosmetics() {
  return {
    material: "linen",
    thickness: LINK_THICKNESS.initial,
    slack: LINK_SLACK.initial,
    pattern: "continuous",
    ends: "standard",
    secondaryColor: ""
  };
}

const GENERATED_TITLES = Object.freeze([
  "new note", "new location", "memo", "target", "wanted", "document", "torn paper",
  "sticky note", "untitled", "new entry", "new page",
  "новая заметка", "новая локация", "заметка", "цель", "документ", "мятая бумага",
  "стикер", "без названия", "новая запись", "новая страница"
]);

/** The GM vault prefixes secret names; the prefix is not part of the human title. */
export function stripSecretPrefix(name) {
  return String(name ?? "").replace(/^GM-[A-Z0-9]{3,}\s+/i, "").trim();
}

/**
 * A best-effort legacy placeholder test. New records get an explicit `nameGenerated` flag, so
 * this heuristic is only used while migrating old data. It intentionally errs toward "not
 * generated": keeping a real title visible is safer than hiding it.
 */
export function isGeneratedTitle(name) {
  const bare = stripSecretPrefix(name).replace(/\s+\d+$/, "").trim().toLowerCase();
  return !bare || GENERATED_TITLES.includes(bare);
}

export function legacyPresentation(system = {}) {
  const style = Object.hasOwn(LEGACY_STYLE_MAP, system.style) ? system.style : "sticky";
  const extendedStyle = LEGACY_STYLE_MAP[style];
  return {
    ...DEFAULT_PRESENTATION,
    extendedStyle,
    // Legacy memo/document/target/torn notes were explicitly extended; keep that intent.
    forceExtended: style !== "sticky",
    torn: style === "torn",
    heading: typeof system.targetHeading === "string" ? system.targetHeading : ""
  };
}

/** Resolves stored presentation + legacy fallbacks into one complete, safe object. */
export function resolvePresentation(note) {
  const system = note?.system ?? note ?? {};
  const stored = system.presentation && typeof system.presentation === "object" ? system.presentation : {};
  const legacy = legacyPresentation(system);
  const extendedStyle = PRESENTATION_STYLES.includes(stored.extendedStyle)
    ? stored.extendedStyle : legacy.extendedStyle;
  return {
    label: typeof system.label === "string" ? system.label : "",
    extendedStyle,
    forceExtended: typeof stored.forceExtended === "boolean" ? stored.forceExtended : legacy.forceExtended,
    font: NOTE_FONT_KEYS.includes(stored.font) ? stored.font : "default",
    pictureLayout: PICTURE_LAYOUTS.includes(stored.pictureLayout)
      ? stored.pictureLayout : "above",
    torn: typeof stored.torn === "boolean" ? stored.torn : legacy.torn,
    heading: typeof stored.heading === "string" && stored.heading.trim()
      ? stored.heading : legacy.heading,
    nameGenerated: typeof stored.nameGenerated === "boolean"
      ? stored.nameGenerated : isGeneratedTitle(note?.name)
  };
}

/** Resolves the optional attachment block with safe defaults. */
export function resolveAttachment(note) {
  const system = note?.system ?? note ?? {};
  const stored = system.attachment && typeof system.attachment === "object" ? system.attachment : {};
  return {
    mainPinEnabled: typeof stored.mainPinEnabled === "boolean" ? stored.mainPinEnabled : true,
    mainSnapRadius: clampNumber(stored.mainSnapRadius, 0, 64, MAIN_SNAP_RADIUS),
    minorSnapRadius: clampNumber(stored.minorSnapRadius, 0, 32, MINOR_SNAP_RADIUS),
    pinStyle: PIN_STYLES.includes(stored.pinStyle) ? stored.pinStyle : "default"
  };
}

/** Link cosmetics resolve old `lineStyle` into the new pattern vocabulary. */
export function resolveLinkCosmetics(link = {}) {
  const defaults = defaultLinkCosmetics();
  return {
    material: LINK_MATERIALS.includes(link.material) ? link.material : defaults.material,
    thickness: clampNumber(link.thickness, LINK_THICKNESS.min, LINK_THICKNESS.max, defaults.thickness),
    slack: clampNumber(link.slack, LINK_SLACK.min, LINK_SLACK.max, defaults.slack),
    pattern: LINK_PATTERNS.includes(link.pattern)
      ? link.pattern : (link.lineStyle === "dashed" ? "interrupted" : defaults.pattern),
    ends: LINK_ENDS.includes(link.ends) ? link.ends : defaults.ends,
    secondaryColor: isLinkColor(link.secondaryColor) ? normalizeLinkColor(link.secondaryColor) : ""
  };
}

/** Additive migration patch for one legacy note. Safe to call repeatedly; never rewrites content. */
export function migrateNoteSystem(system = {}, name = "") {
  const presentation = resolvePresentation({ name, system });
  const label = typeof system.label === "string" && system.label.trim()
    ? system.label
    : (presentation.nameGenerated ? "" : String(name ?? "").trim());
  const { label: _ignored, ...presentationFields } = presentation;
  return {
    schemaVersion: 1,
    label,
    presentation: presentationFields,
    attachment: resolveAttachment({ system })
  };
}

export function isCurrentNoteSchema(system = {}) {
  return system.schemaVersion === 1 && !!system.presentation && !!system.attachment;
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
