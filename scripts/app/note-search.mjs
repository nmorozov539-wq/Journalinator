/**
 * Safe note search/result helpers shared by the quick switcher and canvas dimming.
 *
 * Search never reads the internal Foundry name, hidden blocks or vault metadata: players and GMs
 * may see different merged notes, but only the optional label, viewer-visible Markdown text and
 * the public author name participate. Result labels use the deterministic excerpt fallback so an
 * unlabelled note never masquerades as a generated internal title.
 */
import { noteExcerpt, resolvePresentation, stripSearchNoise, visibleBlocks } from "../presentation.mjs";
import { t } from "../i18n.mjs";

/** True when `note` has a visible label/heading/text or author name containing the query. */
export function noteMatchesQuery(note, query, authorName = "") {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const presentation = resolvePresentation(note);
  const text = stripSearchNoise(visibleBlocks(note).map(block => block.text).join("\n"));
  return `${presentation.label} ${presentation.heading} ${text} ${authorName}`.toLowerCase().includes(q);
}

/** Human result label: optional label, then a plain visible excerpt, then a neutral fallback. */
export function noteSearchLabel(note) {
  const label = resolvePresentation(note).label.trim();
  if (label) return label;
  return noteExcerpt(note) || t("JN.Search.Untitled");
}

/** Localization key for the presentation style shown as secondary switcher metadata. */
export function notePresentationLabelKey(note) {
  if (note?.system?.kind === "location") return "JN.Kind.Location";
  const style = resolvePresentation(note).extendedStyle;
  if (style === "document") return "JN.Style.Document";
  if (style === "target") return "JN.Style.Target";
  return "JN.Style.Memo";
}

/** Filter key: the semantic kind for locations, otherwise the resolved extended presentation. */
export function noteFilterKey(note) {
  if (note?.system?.kind === "location") return "location";
  return resolvePresentation(note).extendedStyle;
}
