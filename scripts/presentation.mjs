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
  // Target placeholders used by older creation dialogs for the internal page name.
  "character name", "имя персонажа",
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

export const COMPACT_LIMITS = Object.freeze({
  maxWords: 100,
  maxLines: 14,
  maxLineLength: 120,
  maxUnbroken: 48
});

/** Viewer-visible blocks only: hidden GM paragraphs must never influence public geometry. */
export function visibleBlocks(note) {
  return (note?.system?.blocks ?? []).filter(block => block && !block.hidden
    && typeof block.text === "string");
}

const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*\S/;
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const INDENTED_CODE = /^(?: {4}|\t)/;

/**
 * Blanks HTML comments while preserving line breaks, so line-based Markdown analysis stays
 * aligned. `<!-- # -->` must never be mistaken for a heading and comment text is invisible.
 */
export function stripHtmlComments(text) {
  return String(text ?? "").replace(HTML_COMMENT, comment => comment.replace(/[^\r\n]/g, " "));
}

/**
 * Removes inline code spans delimited by equal-length backtick runs of any length. The
 * replacement is a word, not whitespace: `` `code` # x `` must not become a heading.
 */
function stripInlineCode(text) {
  return String(text ?? "").replace(/(`+)([\s\S]*?)\1/g, "code");
}

function normalizeReferenceId(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function collectReferenceIds(lines) {
  const ids = new Set();
  let fence = false;
  for (const line of lines) {
    const unquoted = line.replace(/^ {0,3}(?:>[ \t]?)+/, "");
    if (/^ {0,3}(```|~~~)/.test(unquoted)) { fence = !fence; continue; }
    if (fence) continue;
    const match = REFERENCE_DEFINITION.exec(line);
    if (match) ids.add(normalizeReferenceId(match[1]));
  }
  return ids;
}

let analysisConverter = null;
let analysisSource = null;
function getAnalysisConverter() {
  const g = globalThis.showdown;
  if (!g?.Converter) return null;
  if (!analysisConverter || analysisSource !== g) {
    analysisSource = g;
    analysisConverter = new g.Converter({
      tables: true, strikethrough: true, simpleLineBreaks: true, noHeaderId: true,
      ghCodeBlocks: true, tasklists: true
    });
  }
  return analysisConverter;
}

function decodeEntities(html) {
  return String(html).replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[name.toLowerCase()] ?? " ";
  });
}

function htmlToText(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Visible source lines for the line budget: no blanks, comments or reference definitions. */
function visibleSourceLines(source) {
  let fence = false;
  const visible = [];
  for (const line of stripHtmlComments(source).split(/\r?\n/)) {
    const unquoted = line.replace(/^ {0,3}(?:>[ \t]?)+/, "");
    if (/^ {0,3}(```|~~~)/.test(unquoted)) { fence = !fence; visible.push(line); continue; }
    if (!line.trim()) continue;
    if (!fence && REFERENCE_DEFINITION.test(line)) continue;
    visible.push(line);
  }
  return visible;
}

/**
 * Rendered-structure analysis used whenever Foundry's Showdown is present (always in the real
 * runtime). This is the authority for headings, images, tables and code: a `#` in fenced,
 * indented or inline code, inside a comment, or in a reference definition cannot promote a note.
 */
function analyzeRendered(html, source, limits) {
  const visible = visibleSourceLines(source);
  let longestLine = 0;
  let maxUnbroken = 0;
  for (const line of visible) {
    longestLine = Math.max(longestLine, line.length);
    for (const token of line.split(/\s+/)) {
      maxUnbroken = Math.max(maxUnbroken, token.replace(/[^\p{L}\p{N}_-]/gu, "").length);
    }
  }
  const complexStructure = /<\s*(table|pre)\b/i.test(html);
  const tooManyLines = visible.length > limits.maxLines;
  const tooLong = longestLine > limits.maxLineLength || maxUnbroken > limits.maxUnbroken;
  return {
    headings: (html.match(/<h[1-6]\b/gi) ?? []).length,
    images: (html.match(/<img\b/gi) ?? []).length,
    complex: complexStructure || tooManyLines || tooLong,
    words: countWords(htmlToText(html)),
    lines: visible.length,
    longestLine,
    maxUnbroken
  };
}

/** Counts inline, reference, collapsed/shortcut (when defined) and HTML images on one line. */
function countImages(line, references) {
  let rest = line;
  let count = 0;
  const take = pattern => {
    rest = rest.replace(pattern, () => { count += 1; return " "; });
  };
  take(/!\[[^\]]*\]\([^)]*\)/g);
  take(/!\[[^\]]*\]\[[^\]]*\]/g);
  rest = rest.replace(/!\[([^\]]*)\](?!\s*[\[(])/g, (match, alt) =>
    references.has(normalizeReferenceId(alt)) ? (count += 1, " ") : match);
  count += (rest.match(/<img\b/gi) ?? []).length;
  return count;
}

function stripImageSyntax(line, references) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ")
    .replace(/!\[([^\]]*)\]/g, (match, alt) =>
      references.has(normalizeReferenceId(alt)) ? " " : match);
}

/**
 * Structural Markdown analysis without a DOM. Fenced/indented/inline code is removed before
 * heading detection, so `#` inside a code sample never promotes a note. Reference definitions
 * and HTML comments are invisible. Returns the facts the compact classifier needs; the
 * renderer still uses the real Showdown output.
 */
export function analyzeMarkdown(text, limits = COMPACT_LIMITS) {
  const raw = String(text ?? "");
  const converter = getAnalysisConverter();
  if (converter) return analyzeRendered(converter.makeHtml(raw), raw, limits);

  // Fallback for bare Node/CI runs without Showdown. Kept structurally conservative so a note
  // may be promoted (safe, wraps) but is not incorrectly compacted (would clip).
  const source = stripHtmlComments(raw);
  const lines = source.split(/\r?\n/);
  const references = collectReferenceIds(lines);
  let fence = false;
  let headings = 0;
  let images = 0;
  let complex = false;
  let previousText = false;
  let previousBlank = true;
  let previousPipe = false;
  let lineCount = 0;
  let longestLine = 0;
  let maxUnbroken = 0;
  let listIndent = null;
  const prose = [];

  for (const line of lines) {
    if (!line.trim()) { previousBlank = true; previousText = false; continue; }
    const fenceLine = line.replace(/^ {0,3}(?:>[ \t]?)+/, "");
    if (/^ {0,3}(```|~~~)/.test(fenceLine)) {
      fence = !fence;
      complex = true;
      previousText = false;
      previousBlank = false;
      previousPipe = false;
      continue;
    }
    if (fence) { previousBlank = false; continue; }

    // `[id]: url` is a reference definition, not prose. Shortcut images resolve against these.
    if (REFERENCE_DEFINITION.test(line)) { previousBlank = false; previousText = false; continue; }
    lineCount += 1;
    longestLine = Math.max(longestLine, line.length);

    const marker = LIST_ITEM.exec(line);
    if (marker) listIndent = marker[1].replace(/\t/g, "    ").length;
    const indentColumns = (line.match(/^[ \t]*/) ?? [""])[0].replace(/\t/g, "    ").length;
    const indented = INDENTED_CODE.test(line);

    // Indented code needs a block start (document start or a blank line) and is never a plain
    // paragraph continuation. Inside a list, four extra columns is still a continuation.
    if (indented && !marker && previousBlank) {
      const listCode = listIndent !== null && indentColumns >= listIndent + 4;
      if (listIndent === null || listCode) {
        complex = true;
        previousText = false;
        previousBlank = false;
        previousPipe = false;
        continue;
      }
    }
    if (!marker && listIndent !== null && indentColumns <= listIndent && !previousBlank) listIndent = null;

    const inlineFree = stripInlineCode(line);
    const quoted = inlineFree.replace(/^ {0,3}(?:>[ \t]?)+/, "");
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(quoted)) headings += 1;
    else if (/^ {0,3}(=+|-+)\s*$/.test(quoted) && previousText) headings += 1;
    headings += (inlineFree.match(/<h[1-6]\b[^>]*>/gi) ?? []).length;
    images += countImages(inlineFree, references);
    const singleColumnTable = previousPipe && /^\s*\|?\s*:?-{2,}:?\s*\|?\s*$/.test(line);
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)
        || singleColumnTable || /<\s*(table|pre)\b/i.test(line)) complex = true;
    if (line.length > limits.maxLineLength) complex = true;
    const cleaned = stripImageSyntax(quoted, references).replace(/<[^>]+>/g, " ");
    for (const token of cleaned.split(/\s+/)) {
      maxUnbroken = Math.max(maxUnbroken, token.replace(/[^\p{L}\p{N}_-]/gu, "").length);
    }
    prose.push(cleaned);
    previousText = !/^\s*\|?\s*:?-{2,}/.test(line);
    previousBlank = false;
    previousPipe = line.includes("|");
  }

  if (lineCount > limits.maxLines) complex = true;
  if (maxUnbroken > limits.maxUnbroken) complex = true;

  return {
    headings,
    images,
    complex,
    words: countWords(prose.join(" ")),
    lines: lineCount,
    longestLine,
    maxUnbroken
  };
}

/** Visible Markdown as plain text: no code, comments, images, reference definitions or tags. */
export function plainMarkdownText(text) {
  let plain = stripHtmlComments(String(text ?? ""));
  plain = plain.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
  plain = stripInlineCode(plain);
  plain = plain.replace(/^ {0,3}\[[^\]]+\]:.*$/gm, " ");
  plain = plain.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  plain = plain.replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ");
  plain = plain.replace(/!\[[^\]]*\]/g, " ");
  plain = plain.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  plain = plain.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  plain = plain.replace(/\[([^\]]+)\]/g, "$1");
  return plain.replace(/<[^>]+>/g, " ");
}

/** Search text drops invisible URLs and HTML comments so they cannot match a query. */
export function stripSearchNoise(text) {
  return stripHtmlComments(String(text ?? ""))
    .replace(/^ {0,3}\[[^\]]+\]:.*$/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ");
}

export function countWords(text) {
  const prose = plainMarkdownText(text)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#>*_~|\\-]+/g, " ");
  return prose.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * Compact iff the note has no visible label/heading/picture, no real Markdown heading, no
 * complex rendered structure, and short visible content. `forceExtended` is the only override;
 * there is deliberately no force-compact that could clip text.
 */
export function classifyNote(note, limits = COMPACT_LIMITS) {
  const presentation = resolvePresentation(note);
  const system = note?.system ?? {};
  const reasons = [];
  if (presentation.label.trim()) reasons.push("label");
  if (presentation.heading.trim()) reasons.push("heading");
  if (system.image) reasons.push("image");
  if (system.backgroundImage) reasons.push("background");
  if (presentation.forceExtended) reasons.push("forced");
  let words = 0;
  let headings = 0;
  let images = 0;
  let complex = false;
  for (const block of visibleBlocks(note)) {
    const analysis = analyzeMarkdown(block.text, limits);
    words += analysis.words;
    headings += analysis.headings;
    images += analysis.images;
    complex ||= analysis.complex;
  }
  if (headings) reasons.push("markdown-heading");
  if (images) reasons.push("inline-image");
  if (complex) reasons.push("complex");
  if (words > limits.maxWords) reasons.push("long");
  return {
    mode: reasons.length ? "extended" : "compact",
    reasons,
    words,
    headings,
    images,
    complex
  };
}

/** Permission-safe plain excerpt for search/results. Never returns a placeholder title. */
export function noteExcerpt(note, maxLength = 70) {
  const presentation = resolvePresentation(note);
  if (presentation.label.trim()) return presentation.label.trim().slice(0, maxLength);
  if (presentation.heading.trim()) return presentation.heading.trim().slice(0, maxLength);
  const text = visibleBlocks(note).map(block => block.text).join("\n");
  const plain = plainMarkdownText(text)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
    .replace(/[#>*_`~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.slice(0, maxLength).trim();
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
