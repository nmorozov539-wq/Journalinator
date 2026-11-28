/**
 * Derived search, quick-switcher and trash labels.
 *
 * Everything here reads only the v2 note body plus its public author. The Foundry page name,
 * legacy label/blocks/kind/style/location and any hidden/secret metadata never participate:
 * labels are derived with the same T1 parser the canvas renders, so a note without a title is
 * labelled by its visible text (`Image note` / `Empty note` when there is none).
 */
import {
  deriveExcerpt,
  deriveTitle,
  parseDocument,
  plainVisibleText
} from "../document/index.mjs";
import { t } from "../i18n.mjs";

function noteBody(note) {
  if (typeof note?.system?.body === "string") return note.system.body;
  return typeof note?.body === "string" ? note.body : "";
}

function noteLayout(note) {
  const layout = note?.system?.layout ?? note?.layout;
  return layout === "profile" ? "profile" : "plain";
}

/** Parsed v2 document for a page or note-view object. Never throws on odd body values. */
export function parseNoteDocument(note) {
  try {
    return parseDocument(noteBody(note), { selectedLayout: noteLayout(note) });
  } catch {
    return null;
  }
}

/** Localized fallback labels for notes without a derived title. */
export function noteFallbackLabels() {
  return {
    emptyLabel: t("JN.Search.EmptyNote"),
    imageLabel: t("JN.Search.ImageNote")
  };
}

/** Primary human label: derived title, visible text excerpt, then Image/Empty note. */
export function noteSearchLabel(note) {
  return deriveTitle(parseNoteDocument(note), noteFallbackLabels());
}

/** Visible body excerpt (title line excluded). */
export function noteSearchExcerpt(note, maxLength = 70) {
  return deriveExcerpt(parseNoteDocument(note), maxLength);
}

/** Secondary line only when it adds information beyond the primary label. */
export function noteSecondaryExcerpt(note, maxLength = 70) {
  const excerpt = noteSearchExcerpt(note, maxLength);
  if (!excerpt) return "";
  return excerpt === noteSearchLabel(note) ? "" : excerpt;
}

/** Search matches the derived title, visible body text and the public author name. */
export function noteMatchesQuery(note, query, authorName = "") {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const parsed = parseNoteDocument(note);
  const text = [
    deriveTitle(parsed, noteFallbackLabels()),
    plainVisibleText(parsed),
    String(authorName ?? "")
  ].join("\n").toLowerCase();
  return text.includes(q);
}

/** Stored layout filter key (never the effective Profile fallback). */
export function noteFilterKey(note) {
  return noteLayout(note);
}

/** Localization key for a note's stored layout. */
export function noteLayoutLabelKey(note) {
  return noteFilterKey(note) === "profile" ? "JN.Layout.Profile" : "JN.Layout.Plain";
}

/**
 * Layout (All = `null`) plus optional author allow-list filter. Uses the stored layout, never
 * the effective Profile fallback.
 */
export function noteMatchesFilters(note, { layout = null, authorIds = null } = {}) {
  if (layout && noteFilterKey(note) !== layout) return false;
  if (authorIds && authorIds.size > 0 && !authorIds.has(note?.system?.authorId)) return false;
  return true;
}

/** Public author display name; never an internal user id. */
export function noteAuthorName(note, users = globalThis.game?.users) {
  const authorId = note?.system?.authorId ?? note?.authorId;
  return users?.get?.(authorId)?.name ?? "";
}

/** Public note date used in duplicate/trash metadata. */
export function noteDateText(note, dateStyle = "created") {
  const value = dateStyle === "updated"
    ? note?.system?.updatedAt ?? note?.updatedAt
    : note?.system?.createdAt ?? note?.createdAt;
  return Number.isFinite(value) && value > 0
    ? new Date(value).toLocaleString(globalThis.game?.i18n?.lang || undefined)
    : "";
}
