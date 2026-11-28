/**
 * Derived plain text for search, trash, transfers and history.
 *
 * `plainVisibleText` deliberately excludes the first-line title so excerpts do
 * not repeat it, and it excludes Markdown syntax, code, comments, image
 * destinations and reference definitions. It still includes visible body
 * content: later headings, list item text, blockquote text and HTML text.
 */
import { parseAtxHeading } from "./parse.mjs";

function collapse(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function codePoints(text, maxLength) {
  return Array.from(String(text ?? "")).slice(0, Math.max(0, maxLength)).join("");
}

/** Removes inline syntax while keeping human-visible characters. */
export function stripInlineSyntax(text) {
  let value = String(text ?? "");
  value = value.replace(/<!--[\s\S]*?-->/g, " ");
  value = value.replace(/(`+)([\s\S]*?)\1/g, " ");
  value = value.replace(/!\[((?:\\.|[^\]\\])*)\]\((?:[^()]|\([^()]*\))*\)/g, " ");
  value = value.replace(/!\[((?:\\.|[^\]\\])*)\]\[((?:\\.|[^\]\\])*)\]/g, " ");
  value = value.replace(/\[((?:\\.|[^\]\\])*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
  value = value.replace(/\[((?:\\.|[^\]\\])*)\]\[((?:\\.|[^\]\\])*)\]/g, "$1");
  value = value.replace(/<(?:https?|mailto|ftp):[^>]*>/gi, " ");
  value = value.replace(/<[^>]*>/g, " ");
  value = value.replace(/\\([\\`*_{}\[\]()#+\-.!~<>])/g, "$1");
  value = value.replace(/[*_~]+/g, " ");
  value = value.replace(/^\s{0,3}#{1,6}[ \t]*/gm, " ");
  return collapse(value);
}

function tableText(raw) {
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim() || /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) continue;
    const cells = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");
    const text = stripInlineSyntax(cells.join(" "));
    if (text) rows.push(text);
  }
  return rows.join(" ");
}

function listText(raw) {
  const parts = [];
  for (const line of raw.split("\n")) {
    let text = line;
    text = text.replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/, "");
    text = text.replace(/^\[[ xX]\][ \t]*/, "");
    text = text.replace(/^\s+/, "");
    const plain = stripInlineSyntax(text);
    if (plain) parts.push(plain);
  }
  return parts.join(" ");
}

function quoteText(raw) {
  const parts = [];
  for (const line of raw.split("\n")) {
    const text = stripInlineSyntax(line.replace(/^\s*>\s?/, ""));
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

function headingText(raw) {
  const atx = parseAtxHeading(raw);
  return atx ? stripInlineSyntax(atx.text) : "";
}

function htmlText(raw) {
  return stripInlineSyntax(raw.replace(/<[^>]*>/g, " "));
}

function blockVisibleText(block, source) {
  const raw = source.slice(block.start, block.end);
  switch (block.type) {
    case "title":
    case "code":
    case "comment":
    case "definition":
    case "divider":
    case "underline":
    case "image":
      return "";
    case "heading":
    case "caption":
      return headingText(raw);
    case "paragraph":
      return stripInlineSyntax(raw);
    case "list":
      return listText(raw);
    case "quote":
      return quoteText(raw);
    case "table":
      return tableText(raw);
    case "html":
      return htmlText(raw);
    default:
      return stripInlineSyntax(raw);
  }
}

/** Human-visible body text (title line excluded), with whitespace collapsed. */
export function plainVisibleText(parsed) {
  if (!parsed) return "";
  const source = parsed.body ?? "";
  const parts = [];
  for (const block of parsed.blocks ?? []) {
    if (block.type === "title") continue;
    const text = blockVisibleText(block, source);
    if (text) parts.push(text);
  }
  return collapse(parts.join(" "));
}

/**
 * Search/trash label: nonempty title text, else the first 70 code points of
 * visible body text, else `Image note` when the document has images, else
 * `Empty note`.
 */
export function deriveTitle(parsed, { emptyLabel = "Empty note", imageLabel = "Image note" } = {}) {
  if (!parsed) return emptyLabel;
  const titleText = parsed.title?.present && !parsed.title.empty
    ? stripInlineSyntax(parsed.title.text)
    : "";
  if (titleText) return titleText;

  const visible = plainVisibleText(parsed);
  if (visible) return codePoints(visible, 70).trim();

  if ((parsed.imageSources?.length ?? 0) > 0) return imageLabel;
  return emptyLabel;
}

/** Up to `maxLength` Unicode code points of visible body text. */
export function deriveExcerpt(parsed, maxLength = 70) {
  return codePoints(plainVisibleText(parsed), maxLength).trim();
}
