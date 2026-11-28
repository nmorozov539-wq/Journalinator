/**
 * Sanitised rendering for one parsed note body.
 *
 * The whole source is rendered in one Showdown pass so reference links and
 * images resolve exactly as they do in ordinary Markdown. The parser's block
 * map is then used only to neutralise note-syntax ambiguities in the temporary
 * render source (never in stored text):
 *  - a heading followed by `---` gets a class; the rule line becomes a marker;
 *  - any other `---` becomes an `<hr>` marker;
 *  - `===` is escaped so Showdown cannot form a setext heading;
 *  - empty `# ` affordances and empty headings are omitted;
 *  - unused reference definitions are omitted;
 *  - comments are masked (code/comment text stays inert).
 * After rendering, markers are resolved, every non-title H1 is demoted to H2,
 * the result is sanitised and then links/task boxes are polished.
 */
import {
  parseDocument,
  maskRanges,
  parseDefinition,
  normalizeLabel
} from "./parse.mjs";

const OPTIONS = Object.freeze({
  tasklists: true,
  tables: true,
  strikethrough: true,
  simpleLineBreaks: true,
  noHeaderId: true,
  tablesHeaderId: false,
  ghCodeBlocks: true,
  parseImgDimensions: true,
  simplifiedAutoLink: true,
  excludeTrailingPunctuationFromURLs: true,
  literalMidWordUnderscores: true,
  literalMidWordAsterisks: true,
  disableForced4SpacesIndentedSublists: true,
  openLinksInNewWindow: true
});

const HR_MARKER = "<!--JN_HR-->";
const UNDERLINE_TITLE_MARKER = "<!--JN_UNDERLINE_TITLE-->";
const UNDERLINE_HEADING_MARKER = "<!--JN_UNDERLINE_HEADING-->";
const CAPTION_MARKER = "<!--JN_CAPTION-->";
const TITLE_TOKEN = "\u0000JN_TITLE\u0000";
const REFERENCE_IMAGE_RE = /!\[((?:\\.|[^\]\\])*)\]\[((?:\\.|[^\]\\])*)\]/g;

let converter = null;
let converterSource = null;

function getConverter() {
  const showdown = globalThis.showdown;
  if (!showdown?.Converter) return null;
  if (!converter || converterSource !== showdown) {
    converterSource = showdown;
    converter = new showdown.Converter(OPTIONS);
  }
  return converter;
}

function escapePlainText(text) {
  const escape = globalThis.foundry?.utils?.escapeHTML;
  const escaped = typeof escape === "function"
    ? escape(text)
    : String(text).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
  return escaped.replace(/\n/g, "<br>");
}

function previousVisibleBlock(parsed, block) {
  const index = parsed.blocks.indexOf(block);
  for (let i = index - 1; i >= 0; i -= 1) {
    if (parsed.blocks[i].type !== "comment") return parsed.blocks[i];
  }
  return null;
}

function blockIsEmpty(block) {
  return block.type === "title"
    ? block.empty || !String(block.text ?? "").trim()
    : !String(block.text ?? "").trim();
}

function quoteFenceOpens(text) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
  if (!match) return null;
  if (match[1][0] === "`" && match[2].includes("`")) return null;
  return { char: match[1][0], length: match[1].length };
}

function quoteFenceCloses(text, fence) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(text);
  return Boolean(match && match[1][0] === fence.char && match[1].length >= fence.length);
}

function collectUsedReferenceLabels(source, protectedRanges, definitionRanges) {
  const visible = maskRanges(source, [...(protectedRanges ?? []), ...(definitionRanges ?? [])]);
  const used = new Set();
  // Ordinary reference links only: reference *images* are rewritten to inline
  // images, so their definitions can be blanked afterwards.
  const pattern = /(!?)\[((?:\\.|[^\]\\])*)\]\[((?:\\.|[^\]\\])*)\]/g;
  let match;
  while ((match = pattern.exec(visible))) {
    if (match[1]) continue;
    const label = normalizeLabel(match[3].length ? match[3] : match[2]);
    if (label) used.add(label);
  }

  // Shortcut references (`[label]`) are ordinary Markdown too. Definition
  // lines are masked above, and complete image tokens are hidden so their
  // brackets are not mistaken for link uses.
  const withoutImages = visible.replace(
    /!\[(?:\\.|[^\]\\])*\](?:\([^)]*\)|\[(?:\\.|[^\]\\])*\])/g,
    " "
  );
  const shortcut = /(?<!!)\[((?:\\.|[^\]\\])+)\](?!\s*[\(\[])/g;
  while ((match = shortcut.exec(withoutImages))) {
    const label = normalizeLabel(match[1]);
    if (label) used.add(label);
  }
  return used;
}

function overlapsAny(start, end, ranges) {
  return (ranges ?? []).some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

function inlineImageSyntax(rawAlt, definition) {
  const destination = String(definition.destination ?? "").replace(/[<>]/g, character => `\\${character}`);
  const title = definition.title == null
    ? ""
    : ` "${String(definition.title).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `![${rawAlt}](<${destination}>${title})`;
}

/**
 * Rewrites resolvable reference images to inline image syntax and removes
 * comment spans from each physical line. Offsets are still the original ones,
 * so block.line and lineAtOffset keep referring to the stored source.
 */
function prepareRenderLines(parsed, lineStarts) {
  const body = parsed.body ?? "";
  const originalLines = body.split("\n");
  const codeRanges = parsed.codeRanges ?? [];
  const commentRanges = parsed.commentRanges ?? [];
  const protectedRanges = [...codeRanges, ...commentRanges];
  const definitions = new Map(
    (parsed.definitions ?? []).map(definition => [definition.label, definition])
  );

  return originalLines.map((line, index) => {
    const lineStart = lineStarts[index];
    const lineEnd = lineStart + line.length;
    const operations = [];

    REFERENCE_IMAGE_RE.lastIndex = 0;
    let match;
    while ((match = REFERENCE_IMAGE_RE.exec(line))) {
      const start = lineStart + match.index;
      const end = start + match[0].length;
      if (overlapsAny(start, end, protectedRanges)) continue;

      const rawLabel = match[2] ?? "";
      const label = normalizeLabel(rawLabel.length ? rawLabel : match[1]);
      const definition = label ? definitions.get(label) : null;
      if (!definition || !String(definition.destination ?? "").length) continue;
      operations.push([match.index, match.index + match[0].length, inlineImageSyntax(match[1] ?? "", definition)]);
    }

    for (const [start, end] of commentRanges) {
      if (end <= lineStart || start >= lineEnd) continue;
      operations.push([
        Math.max(start, lineStart) - lineStart,
        Math.min(end, lineEnd) - lineStart,
        ""
      ]);
    }

    operations.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
    let result = line;
    for (const [start, end, replacement] of operations) {
      result = result.slice(0, start) + replacement + result.slice(end);
    }
    return result;
  });
}

/**
 * Builds the temporary Markdown passed to Showdown. Stored source is never
 * modified; this string only exists for one render pass.
 */
function buildRenderSource(parsed) {
  const originalLines = (parsed.body ?? "").split("\n");
  const lineStarts = [];
  let offset = 0;
  for (const line of originalLines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lines = prepareRenderLines(parsed, lineStarts);
  const definitionRanges = (parsed.blocks ?? [])
    .filter(block => block.type === "definition")
    .map(block => [block.start, block.end]);
  const usedLabels = collectUsedReferenceLabels(
    parsed.body ?? "",
    [...(parsed.codeRanges ?? []), ...(parsed.commentRanges ?? [])],
    definitionRanges
  );
  const captionStart = parsed.effectiveLayout === "profile" ? parsed.profile?.caption?.start : null;
  const markersAfter = new Map();
  const lineAtOffset = value => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= value) line += 1;
    return line;
  };

  for (const block of parsed.blocks ?? []) {
    if (block.type === "code" && block.codeKind === "fenced") {
      const opening = quoteFenceOpens(lines[block.line]);
      if (opening) {
        const endLine = lineAtOffset(Math.max(block.start, block.end - 1));
        let closingLine = -1;
        for (let line = block.line + 1; line <= endLine; line += 1) {
          if (quoteFenceCloses(lines[line], opening)) {
            closingLine = line;
            break;
          }
        }
        if (closingLine >= 0) {
          // Showdown treats characters beyond the opening fence length as
          // prose. Normalise only the temporary render source to the opening
          // length; the stored code text is untouched.
          const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(lines[closingLine]);
          if (match) {
            lines[closingLine] = `${match[1]}${opening.char.repeat(opening.length)}`;
          }
        } else {
          // Showdown requires a closing fence; add one only to the temporary
          // render source so unclosed code never leaks into Markdown output.
          lines[endLine] = `${lines[endLine]}\n${opening.char.repeat(opening.length)}`;
        }
      }
      continue;
    }

    if (block.type === "title" || block.type === "heading" || block.type === "caption") {
      if (blockIsEmpty(block)) {
        lines[block.line] = "";
      } else {
        // Canonicalise only the temporary render line: the parser accepts up
        // to three leading spaces and strips closing hashes, but Showdown does
        // not accept the same indentation, so the stored source is untouched.
        const level = Number(block.level) || 1;
        lines[block.line] = `${"#".repeat(level)} ${block.text}`;
        if (block.type === "caption" && captionStart === block.start) {
          markersAfter.set(block.line, CAPTION_MARKER);
        }
      }
      continue;
    }

    if (block.type === "divider") {
      lines[block.line] = HR_MARKER;
      continue;
    }

    if (block.type === "underline") {
      const previous = previousVisibleBlock(parsed, block);
      if (previous && blockIsEmpty(previous)) {
        lines[block.line] = HR_MARKER;
      } else if (previous?.type === "title") {
        lines[block.line] = UNDERLINE_TITLE_MARKER;
      } else {
        lines[block.line] = UNDERLINE_HEADING_MARKER;
      }
      continue;
    }

    if (block.type === "definition") {
      const definition = parseDefinition(lines[block.line]);
      if (definition && !usedLabels.has(definition.label)) lines[block.line] = "";
      continue;
    }

    if (block.type === "paragraph" && /^ {0,3}=+[ \t]*$/.test(lines[block.line])) {
      // Backslash escaping keeps the literal text while preventing Showdown's
      // setext-heading interpretation. A leading blank line makes the literal
      // its own paragraph instead of a soft break after the previous line.
      lines[block.line] = `\n${lines[block.line].replace(/=/g, "\\=")}`;
      continue;
    }

    if (block.type === "quote") {
      const endLine = lineAtOffset(Math.max(block.start, block.end - 1));
      let fence = null;
      for (let line = block.line; line <= endLine; line += 1) {
        const match = /^(\s*(?:>\s*)+)(.*)$/.exec(lines[line]);
        if (!match) continue;
        const prefix = match[1];
        const rest = match[2];

        if (fence) {
          if (quoteFenceCloses(rest, fence)) fence = null;
          continue;
        }
        const opening = quoteFenceOpens(rest);
        if (opening) {
          fence = opening;
          continue;
        }

        if (/^ {0,3}=+[ \t]*$/.test(rest)) {
          lines[line] = prefix + rest.replace(/=/g, "\\=");
        } else if (/^ {0,3}-{3,}[ \t]*$/.test(rest)) {
          // A quoted rule becomes the underline marker. resolveMarkers adds
          // the underline class to a preceding quoted heading, or falls back
          // to <hr> for ordinary quoted text.
          lines[line] = prefix + UNDERLINE_HEADING_MARKER;
        }
      }
    }
  }

  for (const [line, marker] of markersAfter) {
    lines[line] = `${lines[line]}\n${marker}`;
  }
  return lines.join("\n");
}

function addClassesToFirstTag(html, tag, classNames) {
  const pattern = new RegExp(`<${tag}([^>]*)>`, "i");
  return String(html).replace(pattern, (_match, attributes) => {
    const classAttribute = /\bclass="([^"]*)"/i.exec(attributes);
    let nextAttributes;
    if (classAttribute) {
      const existing = classAttribute[1].split(/\s+/).filter(Boolean);
      for (const name of classNames) if (!existing.includes(name)) existing.push(name);
      nextAttributes = attributes.replace(classAttribute[0], `class="${existing.join(" ")}"`);
    } else {
      nextAttributes = `${attributes} class="${classNames.join(" ")}"`;
    }
    return `<${tag}${nextAttributes}>`;
  });
}

function attachClassToPrecedingHeading(html, marker, className) {
  let result = String(html);
  let searchFrom = 0;
  while (true) {
    const markerIndex = result.indexOf(marker, searchFrom);
    if (markerIndex < 0) break;
    const before = result.slice(0, markerIndex);
    const openings = [...before.matchAll(/<h([12])\b[^>]*>/g)];
    const opening = openings.at(-1);
    if (opening) {
      const level = opening[1];
      const openingStart = opening.index;
      const openingEnd = openingStart + opening[0].length;
      const closing = result.indexOf(`</h${level}>`, openingEnd);
      if (closing >= 0 && /^\s*$/.test(result.slice(closing + 5, markerIndex))) {
        const newOpening = addClassesToFirstTag(opening[0], `h${level}`, [className]);
        result = result.slice(0, openingStart) + newOpening + result.slice(openingEnd);
        const shiftedMarker = markerIndex + (newOpening.length - opening[0].length);
        result = result.slice(0, shiftedMarker) + result.slice(shiftedMarker + marker.length);
        searchFrom = openingStart + newOpening.length;
        continue;
      }
    }
    result = result.slice(0, markerIndex) + "<hr />" + result.slice(markerIndex + marker.length);
    searchFrom = markerIndex + 6;
  }
  return result;
}

function resolveMarkers(html) {
  let result = String(html);
  result = attachClassToPrecedingHeading(result, UNDERLINE_HEADING_MARKER, "jn-heading-underlined");
  result = attachClassToPrecedingHeading(result, CAPTION_MARKER, "jn-profile-caption");
  result = result.replace(/\s*<!--JN_UNDERLINE_TITLE-->/g, "");
  result = result.replace(/<!--JN_HR-->/g, "<hr />");
  result = result.replace(/<!--JN_UNDERLINE_(?:TITLE|HEADING)-->/g, "<hr />");
  result = result.replace(/<!--JN_CAPTION-->/g, "");
  return result;
}

function hasRenderableTitle(parsed) {
  return Boolean(parsed.title?.present && !parsed.title.empty && String(parsed.title.text ?? "").trim());
}

function finaliseHeadings(html, parsed) {
  let result = String(html);
  if (hasRenderableTitle(parsed)) {
    const classes = parsed.underline ? ["jn-note-title", "jn-title-underlined"] : ["jn-note-title"];
    result = addClassesToFirstTag(result, "h1", classes);
  }

  let protectedTitle = null;
  if (hasRenderableTitle(parsed)) {
    const match = /<h1\b[^>]*>[\s\S]*?<\/h1>/i.exec(result);
    if (match) {
      protectedTitle = match[0];
      result = result.slice(0, match.index) + TITLE_TOKEN + result.slice(match.index + match[0].length);
    }
  }

  result = result.replace(/<(\/?)h1(\s|>)/gi, (_match, slash, separator) => `<${slash}h2${separator}`);
  if (protectedTitle) result = result.replace(TITLE_TOKEN, protectedTitle);
  return result;
}

function polishTaskCheckboxes(html, interactiveTasks) {
  return String(html).replace(/<input\b[^>]*type="checkbox"[^>]*>/gi, tag => {
    let next = tag
      .replace(/\s+style=(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "");
    if (!/\bclass=/.test(next)) next = next.replace(/^<input\b/i, '<input class="jn-task-checkbox"');
    if (interactiveTasks) {
      next = next.replace(/\s+disabled(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?/gi, "");
    } else if (!/\bdisabled\b/.test(next)) {
      next = next.replace(/\s*\/?>$/, match => ` disabled${match}`);
    }
    return next;
  });
}

function polishLinks(html) {
  return String(html).replace(/<a\b([^>]*)>/gi, (_match, attributes) => {
    const cleaned = String(attributes)
      .replace(/\s+target=(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "")
      .replace(/\s+rel=(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "");
    return `<a${cleaned} target="_blank" rel="noopener noreferrer">`;
  });
}

function defaultSanitizer() {
  return globalThis.foundry?.utils?.cleanHTML;
}

/**
 * Renders a parsed document and returns sanitised HTML.
 *
 * @param {ReturnType<typeof parseDocument>} parsed
 * @param {{sanitizer?: (html: string) => string, interactiveTasks?: boolean}} [options]
 * @returns {string}
 */
export function renderDocument(parsed, { sanitizer, interactiveTasks = false } = {}) {
  if (!parsed) return "";
  const converter = getConverter();
  let html;

  if (!converter) {
    html = escapePlainText(parsed.body ?? "");
  } else {
    html = finaliseHeadings(resolveMarkers(converter.makeHtml(buildRenderSource(parsed))), parsed);
  }

  const clean = typeof sanitizer === "function" ? sanitizer : defaultSanitizer();
  html = typeof clean === "function" ? String(clean(html)) : String(html);
  html = polishTaskCheckboxes(html, interactiveTasks);
  html = polishLinks(html);
  return html;
}

/** Convenience wrapper: parse then render one body. */
export function renderNoteBody(body, { selectedLayout, sanitizer, interactiveTasks = false } = {}) {
  const parsed = parseDocument(body, { selectedLayout });
  return {
    parsed,
    html: renderDocument(parsed, { sanitizer, interactiveTasks })
  };
}
