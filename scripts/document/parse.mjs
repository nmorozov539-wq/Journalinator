/**
 * Structural parser for one Journalinator note body.
 *
 * The parser is deliberately DOM-free and pure: the same result feeds the
 * editor, preview, saved rendering, search, history and transfers.
 *
 * Newlines: CRLF and lone CR are normalised to LF before scanning. The
 * returned `body` is that normalised source and every offset/range in the
 * result refers to it (UTF-16 code units), so callers must not apply offsets
 * to the original CRLF text. Text itself is never otherwise rewritten.
 */

const ATX_RE = /^( {0,3})(#{1,6})(?:[ \t]+(.*))?$/;
const LIST_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const THEMATIC_RE = /^(?:\*{3,}|-{3,}|_{3,})$/;
const SETEXT_EQUALS_RE = /^ {0,3}=+[ \t]*$/;
const DEFINITION_RE = /^ {0,3}\[((?:\\.|[^\]\\])+)\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^)\\])*)\)))?[ \t]*$/;
const HTML_BLOCK_RE = /^ {0,3}<(?:(?:[A-Za-z][A-Za-z0-9-]*)(?=[\s/>])|\/[A-Za-z][A-Za-z0-9-]*|!DOCTYPE\b|!\[CDATA\[)/i;
const INLINE_IMAGE_RE = /!\[((?:\\.|[^\]\\])*)\]\(\s*(<(?:\\.|[^>\\])*>|(?:[^\s()\\]|\\.|\([^\s()\\]*\))*)?(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^)\\])*)\)))?\s*\)/g;
const REFERENCE_IMAGE_RE = /!\[((?:\\.|[^\]\\])*)\]\[((?:\\.|[^\]\\])*)\]/g;
const INLINE_IMAGE_EXACT_RE = /^!\[((?:\\.|[^\]\\])*)\]\(\s*(<(?:\\.|[^>\\])*>|(?:[^\s()\\]|\\.|\([^\s()\\]*\))*)?(?:\s+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^)\\])*)\)))?\s*\)$/;
const REFERENCE_IMAGE_EXACT_RE = /^!\[((?:\\.|[^\]\\])*)\]\[((?:\\.|[^\]\\])*)\]$/;

const PROFILE_MESSAGE_KEYS = Object.freeze({
  "missing-title": "JN.Profile.NeedsTitle",
  "title-not-first": "JN.Profile.MoveTitle",
  "missing-portrait": "JN.Profile.NeedsPortrait",
  "portrait-out-of-order": "JN.Profile.MovePortrait",
  "invalid-portrait": "JN.Profile.CompletePortrait"
});

export function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function isBlank(text) {
  return /^[ \t]*$/.test(text);
}

function isIndented(text) {
  return /^(?: {4}|\t)/.test(text);
}

function compactHorizontal(text) {
  return text.replace(/[ \t]/g, "");
}

/** Replaces absolute ranges by spaces without touching line feeds. */
export function maskRanges(source, ranges, replacement = " ") {
  if (!ranges?.length) return source;
  const chars = source.split("");
  const limit = chars.length;
  for (const [start, end] of ranges) {
    const from = Math.max(0, start);
    const to = Math.min(limit, end);
    for (let i = from; i < to; i += 1) {
      if (chars[i] !== "\n") chars[i] = replacement;
    }
  }
  return chars.join("");
}

/**
 * Parses an ATX heading line. Accepts up to three leading spaces, requires a
 * space (or end of line) after the opening run and strips a CommonMark closing
 * sequence.
 */
export function parseAtxHeading(text) {
  const match = ATX_RE.exec(text);
  if (!match) return null;
  let content = match[3] ?? "";
  if (/^#+[ \t]*$/.test(content)) {
    content = "";
  } else {
    content = content.replace(/[ \t]+#+[ \t]*$/, "");
  }
  content = content.replace(/[ \t]+$/, "");
  return { level: match[2].length, text: content, indent: match[1].length };
}

function isThematicBreak(text) {
  return THEMATIC_RE.test(compactHorizontal(text.trim()));
}

function isSetextEquals(text) {
  return SETEXT_EQUALS_RE.test(text);
}

function isListMarker(text) {
  return LIST_RE.test(text);
}

function isHtmlBlockStart(text) {
  return HTML_BLOCK_RE.test(text) && !text.trimStart().startsWith("<!--");
}

function splitTableCells(text) {
  if (!text.includes("|")) return null;
  let row = text.trim();
  const hadOuterPipe = row.startsWith("|") || row.endsWith("|");
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  if (!row.includes("|") && !hadOuterPipe) return null;
  return row.split("|").map(cell => cell.trim());
}

function isTableSeparator(text) {
  if (!text.includes("|")) return false;
  const cells = splitTableCells(text);
  if (!cells?.length) return false;
  return cells.every(cell => /^:?-+:?$/.test(cell));
}

function isTableHeaderCandidate(text) {
  return text.includes("|") && !isTableSeparator(text);
}

export function parseDefinition(text) {
  const match = DEFINITION_RE.exec(text);
  if (!match) return null;
  let destination = match[2];
  if (destination.startsWith("<") && destination.endsWith(">")) {
    destination = destination.slice(1, -1);
  }
  return {
    label: normalizeLabel(match[1]),
    rawLabel: match[1],
    destination: unescapeMarkdown(destination),
    title: match[3] ?? match[4] ?? match[5] ?? null
  };
}

export function normalizeLabel(label) {
  return String(label ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function unescapeMarkdown(value) {
  return String(value ?? "").replace(/\\([\\`*_{}\[\]()#+\-.!~<>])/g, "$1");
}

function buildLines(source) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= source.length; i += 1) {
    if (i === source.length || source[i] === "\n") {
      lines.push({ index: lines.length, start, end: i, text: source.slice(start, i) });
      start = i + 1;
    }
  }
  return lines;
}

/** Returns one line with the intersecting ranges removed (newlines stay put). */
function lineWithoutRanges(source, line, ranges) {
  if (!ranges?.length) return source.slice(line.start, line.end);
  let value = "";
  let cursor = line.start;
  for (const [start, end] of ranges) {
    if (end <= line.start || start >= line.end) continue;
    const from = Math.max(start, line.start);
    const to = Math.min(end, line.end);
    if (from > cursor) value += source.slice(cursor, from);
    cursor = Math.max(cursor, to);
  }
  if (cursor < line.end) value += source.slice(cursor, line.end);
  return value;
}

function openFence(text) {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(text);
  if (!match) return null;
  const run = match[2];
  if (run[0] === "`" && match[3].includes("`")) return null;
  return { char: run[0], length: run.length };
}

function closesFence(text, char, length) {
  const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(text);
  if (!match) return false;
  return match[2][0] === char && match[2].length >= length;
}

function inlineCodeSpansOnLine(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 1;
    while (text[i + run] === "`") run += 1;
    let j = i + run;
    let closed = false;
    while (j < text.length) {
      if (text[j] !== "`") {
        j += 1;
        continue;
      }
      let other = 1;
      while (text[j + other] === "`") other += 1;
      if (other === run) {
        spans.push([i, j + other]);
        i = j + other;
        closed = true;
        break;
      }
      j += other;
    }
    if (!closed) i += run;
  }
  return spans;
}

function inSpans(offset, spans) {
  return spans.some(([start, end]) => offset >= start && offset < end);
}

/**
 * One lexical pass: fenced code, indented code and HTML comments. Code wins
 * over comments, so comment-looking text inside code is never a comment.
 */
function scanLexical(source, lines) {
  const fenceRanges = [];
  const fenceBlocks = [];
  const indentedBlocks = [];
  const commentRanges = [];
  let fence = null;
  let comment = null;
  let indented = null;

  const closeIndented = () => {
    if (!indented) return;
    indentedBlocks.push({
      startLine: indented.startLine,
      endLine: indented.lastLine,
      start: indented.start,
      end: indented.lastEnd,
      kind: "indented"
    });
    indented = null;
  };

  for (const line of lines) {
    if (fence) {
      if (closesFence(line.text, fence.char, fence.length)) {
        fenceRanges.push([fence.start, line.end]);
        fenceBlocks.push({
          startLine: fence.startLine,
          endLine: line.index,
          start: fence.start,
          end: line.end,
          kind: "fenced"
        });
        fence = null;
      }
      continue;
    }

    if (comment) {
      const close = line.text.indexOf("-->");
      if (close < 0) continue;
      commentRanges.push([comment.start, line.start + close + 3]);
      comment = null;
      let from = close + 3;
      const spans = inlineCodeSpansOnLine(line.text);
      while (from < line.text.length) {
        const open = line.text.indexOf("<!--", from);
        if (open < 0) break;
        if (inSpans(open, spans)) {
          from = open + 4;
          continue;
        }
        const end = line.text.indexOf("-->", open + 4);
        if (end < 0) {
          comment = { start: line.start + open };
          break;
        }
        commentRanges.push([line.start + open, line.start + end + 3]);
        from = end + 3;
      }
      continue;
    }

    if (indented) {
      if (isBlank(line.text)) continue;
      if (isIndented(line.text)) {
        indented.lastLine = line.index;
        indented.lastEnd = line.end;
        continue;
      }
      closeIndented();
      // The current line is not indented; fall through to normal handling.
    }

    const previous = line.index > 0 ? lines[line.index - 1].text : "";
    const canOpenIndented = line.index === 0
      || isBlank(previous)
      || parseAtxHeading(previous)
      || isThematicBreak(previous)
      || isHtmlBlockStart(previous);
    if (canOpenIndented && isIndented(line.text)) {
      indented = {
        startLine: line.index,
        start: line.start,
        lastLine: line.index,
        lastEnd: line.end
      };
      continue;
    }

    const fenceOpen = openFence(line.text);
    if (fenceOpen) {
      fence = { ...fenceOpen, startLine: line.index, start: line.start };
      continue;
    }

    let from = 0;
    const spans = inlineCodeSpansOnLine(line.text);
    while (from < line.text.length) {
      const open = line.text.indexOf("<!--", from);
      if (open < 0) break;
      if (inSpans(open, spans)) {
        from = open + 4;
        continue;
      }
      const close = line.text.indexOf("-->", open + 4);
      if (close < 0) {
        comment = { start: line.start + open };
        break;
      }
      commentRanges.push([line.start + open, line.start + close + 3]);
      from = close + 3;
    }
  }

  if (fence) {
    fenceRanges.push([fence.start, source.length]);
    fenceBlocks.push({
      startLine: fence.startLine,
      endLine: lines.length - 1,
      start: fence.start,
      end: source.length,
      kind: "fenced"
    });
  }
  closeIndented();
  if (comment) commentRanges.push([comment.start, source.length]);

  commentRanges.sort((a, b) => a[0] - b[0]);
  return { fenceRanges, fenceBlocks, indentedBlocks, commentRanges };
}

function containerFenceRanges(lines, blocks) {
  const ranges = [];
  const endLineFor = end => {
    let line = 0;
    while (line + 1 < lines.length && lines[line + 1].start < end) line += 1;
    return line;
  };

  for (const block of blocks) {
    if (block.type !== "quote" && block.type !== "list") continue;
    const endLine = endLineFor(block.end);
    let fence = null;
    let fenceStart = null;
    for (let i = block.line; i <= endLine; i += 1) {
      let rest = lines[i].text;
      if (block.type === "quote") {
        const match = /^(?:\s*>\s?)+/.exec(rest);
        if (!match) continue;
        rest = rest.slice(match[0].length);
      } else {
        rest = rest.replace(/^[ \t]+/, "");
      }

      if (fence) {
        if (closesFence(rest, fence.char, fence.length)) {
          ranges.push([fenceStart, lines[i].end]);
          fence = null;
          fenceStart = null;
        }
        continue;
      }

      const opening = openFence(rest);
      if (opening) {
        fence = opening;
        fenceStart = lines[i].start;
      }
    }
    if (fence) ranges.push([fenceStart, lines[endLine].end]);
  }
  return ranges;
}

function findInlineCodeRanges(source, protectedRanges) {
  const masked = maskRanges(source, protectedRanges);
  const ranges = [];
  let i = 0;
  while (i < masked.length) {
    if (masked[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 1;
    while (masked[i + run] === "`") run += 1;
    let j = i + run;
    let closed = false;
    while (j < masked.length) {
      if (masked[j] !== "`") {
        j += 1;
        continue;
      }
      let otherRun = 1;
      while (masked[j + otherRun] === "`") otherRun += 1;
      if (otherRun === run) {
        ranges.push([i, j + otherRun]);
        i = j + otherRun;
        closed = true;
        break;
      }
      j += otherRun;
    }
    if (!closed) i += run;
  }
  return ranges;
}

function parseImageSource(rawDestination) {
  if (rawDestination == null) return "";
  let value = rawDestination.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  return unescapeMarkdown(value);
}

function imageInfoFromInlineMatch(match, defs) {
  const alt = unescapeMarkdown(match[1] ?? "");
  const src = parseImageSource(match[2] ?? "");
  return { kind: "inline", alt, src, valid: src.length > 0 };
}

function imageInfoFromReferenceMatch(match, defs) {
  const alt = unescapeMarkdown(match[1] ?? "");
  const rawLabel = match[2] ?? "";
  const label = normalizeLabel(rawLabel.length ? rawLabel : alt);
  const definition = defs.get(label);
  if (!definition) {
    return { kind: "reference", alt, src: null, valid: false, unresolved: true };
  }
  return { kind: "reference", alt, src: definition.destination, valid: definition.destination.length > 0 };
}

/**
 * Returns image metadata when the *whole* paragraph is one image token, or
 * null when it is ordinary text. Malformed image-looking markup returns an
 * `imageLike` object with `valid: false`, which the profile rules use for
 * `invalid-portrait`.
 */
function parseStandaloneImage(text, defs) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("![")) return null;

  const inline = INLINE_IMAGE_EXACT_RE.exec(trimmed);
  if (inline) return { ...imageInfoFromInlineMatch(inline, defs), imageLike: true };
  const reference = REFERENCE_IMAGE_EXACT_RE.exec(trimmed);
  if (reference) return { ...imageInfoFromReferenceMatch(reference, defs), imageLike: true };

  // A complete image token plus trailing text is an ordinary paragraph, not
  // an attempted portrait. Only genuinely incomplete markup at the expected
  // position counts as `invalid-portrait`.
  INLINE_IMAGE_RE.lastIndex = 0;
  REFERENCE_IMAGE_RE.lastIndex = 0;
  if (INLINE_IMAGE_RE.test(trimmed) || REFERENCE_IMAGE_RE.test(trimmed)) return null;

  return { kind: null, alt: "", src: null, valid: false, imageLike: true };
}

function createBlock(type, startLine, endLine, lines, extra = {}) {
  return {
    type,
    start: lines[startLine].start,
    end: lines[endLine].end,
    line: startLine,
    ...extra
  };
}

function startsNewBlock(index, { lines, maskedSource, codeBlocks, lineMasked }) {
  const line = lines[index];
  const text = lineMasked(index);
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (codeBlocks.has(index)) return true;
  if (parseAtxHeading(text)) return true;
  if (isThematicBreak(trimmed)) return true;
  if (isSetextEquals(text)) return true;
  if (isListMarker(text)) return true;
  if (trimmed.startsWith(">")) return true;
  if (parseDefinition(trimmed)) return true;
  if (isHtmlBlockStart(trimmed)) return true;
  if (isTableHeaderCandidate(trimmed)) {
    const next = lines[index + 1];
    if (next) {
      const nextText = lineMasked(index + 1).trim();
      if (isTableSeparator(nextText)) return true;
    }
  }
  return false;
}

function structuralScan(source, lines, lexical) {
  const blocks = [];
  const codeRanges = [...lexical.fenceRanges];
  const codeBlocks = new Map();
  for (const entry of [...lexical.fenceBlocks, ...lexical.indentedBlocks]) {
    codeBlocks.set(entry.startLine, entry);
    if (entry.kind === "indented") codeRanges.push([entry.start, entry.end]);
  }

  // Comments are invisible to Markdown structure. Remove their spans instead
  // of replacing them with spaces, which would otherwise create indentation
  // that changes how the following text is parsed.
  const maskedSource = maskRanges(source, lexical.commentRanges);
  const lineMasked = index => lineWithoutRanges(source, lines[index], lexical.commentRanges);

  let i = 0;
  while (i < lines.length) {
    const codeBlock = codeBlocks.get(i);
    if (codeBlock) {
      blocks.push(createBlock("code", codeBlock.startLine, codeBlock.endLine, lines, {
        codeKind: codeBlock.kind
      }));
      i = codeBlock.endLine + 1;
      continue;
    }

    const text = lineMasked(i);
    const trimmed = text.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    const atx = parseAtxHeading(text);
    if (atx) {
      const isTitleLine = i === 0
        && atx.level === 1
        && lines[0].text.trimStart().startsWith("#")
        && !/^\s*<!--/.test(lines[0].text);
      if (isTitleLine) {
        blocks.push(createBlock("title", i, i, lines, {
          level: 1,
          text: atx.text,
          raw: lines[i].text,
          empty: atx.text.trim().length === 0,
          present: true
        }));
      } else {
        blocks.push(createBlock("heading", i, i, lines, {
          level: atx.level,
          text: atx.text,
          raw: lines[i].text
        }));
      }
      i += 1;
      continue;
    }

    if (isThematicBreak(trimmed)) {
      blocks.push(createBlock("divider", i, i, lines));
      i += 1;
      continue;
    }

    if (isListMarker(text)) {
      let j = i;
      let last = i;
      while (j < lines.length) {
        if (codeBlocks.has(j)) break;
        const current = lineMasked(j);
        const currentTrimmed = current.trim();
        if (!currentTrimmed) {
          let next = j + 1;
          while (next < lines.length && !lineMasked(next).trim()) next += 1;
          if (next >= lines.length) break;
          const nextText = lineMasked(next);
          const nextTrimmed = nextText.trim();
          const continuesList = isListMarker(nextText)
            || isIndented(lines[next].text)
            || /^ {2,}/.test(lines[next].text)
            || nextTrimmed.startsWith(">");
          if (!continuesList) break;
          j += 1;
          continue;
        }
        if (j === i || isListMarker(current) || isIndented(lines[j].text) || /^ {1,3}\S/.test(current)) {
          last = j;
          j += 1;
          continue;
        }
        break;
      }
      blocks.push(createBlock("list", i, last, lines));
      i = last + 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      let j = i;
      let last = i;
      while (j < lines.length) {
        const currentTrimmed = lineMasked(j).trim();
        if (!currentTrimmed) {
          j += 1;
          continue;
        }
        if (!currentTrimmed.startsWith(">")) break;
        last = j;
        j += 1;
      }
      blocks.push(createBlock("quote", i, last, lines));
      i = last + 1;
      continue;
    }

    if (isTableHeaderCandidate(trimmed)) {
      const next = lines[i + 1];
      if (next && isTableSeparator(lineMasked(i + 1).trim())) {
        let j = i + 1;
        let last = j;
        while (j + 1 < lines.length) {
          if (codeBlocks.has(j + 1)) break;
          const row = lineMasked(j + 1).trim();
          if (!row || !row.includes("|")) break;
          last = j + 1;
          j += 1;
        }
        blocks.push(createBlock("table", i, last, lines));
        i = last + 1;
        continue;
      }
    }

    if (parseDefinition(trimmed)) {
      blocks.push(createBlock("definition", i, i, lines));
      i += 1;
      continue;
    }

    if (isHtmlBlockStart(trimmed)) {
      let j = i;
      let last = i;
      while (j + 1 < lines.length) {
        if (codeBlocks.has(j + 1)) break;
        const nextLine = lineMasked(j + 1);
        if (!nextLine.trim()) break;
        last = j + 1;
        j += 1;
      }
      blocks.push(createBlock("html", i, last, lines));
      i = last + 1;
      continue;
    }

    // Paragraph. A `===` underlining line is kept in its own block so the
    // renderer can emit it literally instead of letting Showdown form a setext
    // heading.
    if (isSetextEquals(text)) {
      blocks.push(createBlock("paragraph", i, i, lines));
      i += 1;
      continue;
    }

    let j = i;
    let last = i;
    while (j + 1 < lines.length) {
      if (startsNewBlock(j + 1, { lines, maskedSource, codeBlocks, lineMasked })) break;
      last = j + 1;
      j += 1;
    }
    blocks.push(createBlock("paragraph", i, last, lines));
    i = last + 1;
  }

  return { blocks, codeRanges, maskedSource };
}

function addCommentBlocks(blocks, source, lines, commentRanges) {
  const starts = lines.map(line => line.start);
  for (const [start, end] of commentRanges) {
    let startLine = 0;
    while (startLine + 1 < starts.length && starts[startLine + 1] <= start) startLine += 1;
    let endLine = startLine;
    while (endLine + 1 < lines.length && lines[endLine].end < end) endLine += 1;
    const prefix = source.slice(lines[startLine].start, start);
    const suffix = source.slice(end, lines[endLine].end);
    if (!/^[ \t]*$/.test(prefix) || !/^[ \t]*$/.test(suffix)) continue;
    blocks.push({
      type: "comment",
      start,
      end,
      line: startLine
    });
  }
}

function collectDefinitions(blocks, source, commentRanges) {
  const defs = new Map();
  for (const block of blocks) {
    if (block.type !== "definition") continue;
    const raw = maskRanges(source.slice(block.start, block.end), commentRanges.map(([s, e]) => [
      s - block.start,
      e - block.start
    ]));
    const definition = parseDefinition(raw.trim());
    if (definition && !defs.has(definition.label)) defs.set(definition.label, definition);
  }
  return defs;
}

function classifyParagraphs(blocks, source, commentRanges, defs) {
  for (const block of blocks) {
    if (block.type !== "paragraph") continue;
    const absolute = source.slice(block.start, block.end);
    const masked = maskRanges(absolute, commentRanges
      .filter(([start, end]) => end > block.start && start < block.end)
      .map(([start, end]) => [Math.max(0, start - block.start), Math.min(absolute.length, end - block.start)]));
    const info = parseStandaloneImage(masked, defs);
    if (!info) continue;
    block.type = "image";
    block.kind = info.kind;
    block.alt = info.alt;
    block.src = info.src;
    block.valid = info.valid;
    block.imageLike = true;
    if (info.unresolved) block.unresolved = true;
  }
}

function markCaptions(blocks) {
  let previous = null;
  for (const block of blocks) {
    if (block.type === "comment") continue;
    if (
      previous?.type === "image" && previous.valid
      && block.type === "heading" && block.level === 2
    ) {
      block.type = "caption";
    }
    previous = block;
  }
}

function markUnderlines(blocks, source) {
  let titleUnderline = null;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type !== "title" && block.type !== "heading") continue;
    let next = index + 1;
    while (next < blocks.length && blocks[next].type === "comment") next += 1;
    const divider = blocks[next];
    if (!divider || divider.type !== "divider") continue;
    if (source.slice(divider.start, divider.end).trim() !== "---") continue;
    divider.type = "underline";
    block.underlined = true;
    if (block.type === "title" && !titleUnderline) {
      titleUnderline = { start: divider.start, end: divider.end, line: divider.line };
    }
  }
  return titleUnderline;
}

function scanImages(source, defs, protectedRanges) {
  const masked = maskRanges(source, protectedRanges);
  const results = [];
  INLINE_IMAGE_RE.lastIndex = 0;
  let match;
  while ((match = INLINE_IMAGE_RE.exec(masked))) {
    const info = imageInfoFromInlineMatch(match, defs);
    if (info.valid) results.push({ index: match.index, src: info.src });
  }
  REFERENCE_IMAGE_RE.lastIndex = 0;
  while ((match = REFERENCE_IMAGE_RE.exec(masked))) {
    if (isInsideAny(match.index, protectedRanges)) continue;
    const info = imageInfoFromReferenceMatch(match, defs);
    if (info.valid) results.push({ index: match.index, src: info.src });
  }
  return results.sort((a, b) => a.index - b.index).map(entry => entry.src);
}

function isInsideAny(offset, ranges) {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * Finds a physical line that is exactly one resolvable image token. Used as a
 * Profile hint: a portrait-looking line can sit in the same soft-break
 * paragraph as ordinary text and still describe a misplaced portrait.
 */
function findStandaloneImageLine(lines, maskedSource, protectedRanges, defs) {
  for (const line of lines) {
    const text = maskedSource.slice(line.start, line.end);
    const trimmed = text.trim();
    if (!trimmed.startsWith("![")) continue;

    const inline = INLINE_IMAGE_EXACT_RE.exec(trimmed);
    const reference = inline ? null : REFERENCE_IMAGE_EXACT_RE.exec(trimmed);
    if (!inline && !reference) continue;

    const info = inline
      ? imageInfoFromInlineMatch(inline, defs)
      : imageInfoFromReferenceMatch(reference, defs);
    if (!info.valid) continue;

    const offset = line.start + text.indexOf(trimmed);
    if (isInsideAny(offset, protectedRanges)) continue;
    return { line: line.index, kind: info.kind, src: info.src };
  }
  return null;
}

function laterUsableHeading(blocks) {
  return blocks.some(block => (
    block.type === "heading"
    && block.level === 1
    && String(block.text ?? "").trim().length > 0
  ));
}

function visibleBlocks(blocks) {
  return blocks.filter(block => block.type !== "comment");
}

function blockTextForProfile(block, source) {
  const raw = source.slice(block.start, block.end);
  const atx = parseAtxHeading(raw);
  return { text: atx?.text ?? "", raw };
}

/**
 * Pure structural parse of one note body.
 *
 * @param {string} body
 * @param {{selectedLayout?: "plain"|"profile"}} [options]
 */
export function parseDocument(body, options = {}) {
  const source = normalizeNewlines(body);
  const selectedLayout = options?.selectedLayout === "profile" ? "profile" : "plain";
  const lines = buildLines(source);
  const lexical = scanLexical(source, lines);
  const { blocks, codeRanges, maskedSource } = structuralScan(source, lines, lexical);
  const containerRanges = containerFenceRanges(lines, blocks);
  const baseCodeRanges = [...codeRanges, ...containerRanges].sort((a, b) => a[0] - b[0]);
  const commentRanges = lexical.commentRanges.filter(([start, end]) => (
    !baseCodeRanges.some(([codeStart, codeEnd]) => start >= codeStart && end <= codeEnd)
  ));

  addCommentBlocks(blocks, source, lines, commentRanges);
  blocks.sort((a, b) => (a.start - b.start) || (a.type === "comment" ? 1 : -1));

  const defs = collectDefinitions(blocks, source, commentRanges);
  classifyParagraphs(blocks, source, commentRanges, defs);
  // Comment blocks can now be ahead of image blocks; re-sort after type changes.
  blocks.sort((a, b) => (a.start - b.start) || (a.type === "comment" ? 1 : -1));
  markCaptions(blocks);
  const underline = markUnderlines(blocks, source);

  const inlineCode = findInlineCodeRanges(source, [
    ...lexical.fenceRanges,
    ...commentRanges,
    ...lexical.indentedBlocks.map(entry => [entry.start, entry.end]),
    ...containerRanges
  ]);
  const allCodeRanges = [...baseCodeRanges, ...inlineCode].sort((a, b) => a[0] - b[0]);
  const imageSources = scanImages(source, defs, [...allCodeRanges, ...commentRanges]);

  const visible = visibleBlocks(blocks);
  const titleBlock = visible.find(block => block.type === "title") ?? null;
  const titleUsable = Boolean(titleBlock && !titleBlock.empty && titleBlock.text.trim().length > 0);
  const title = titleBlock
    ? {
      present: true,
      text: titleBlock.text,
      raw: titleBlock.raw,
      line: 0,
      start: titleBlock.start,
      end: titleBlock.end,
      empty: titleBlock.empty
    }
    : null;

  const titleIndex = titleBlock ? visible.indexOf(titleBlock) : -1;
  let cursor = titleIndex >= 0 ? titleIndex + 1 : 0;
  let underlineIndex = -1;
  if (titleBlock && visible[cursor]?.type === "underline") {
    underlineIndex = cursor;
    cursor += 1;
  }
  const expected = visible[cursor] ?? null;

  let portraitBlock = null;
  let captionBlock = null;
  if (titleUsable && expected?.type === "image" && expected.valid) {
    portraitBlock = expected;
    let next = cursor + 1;
    if (visible[next]?.type === "caption") {
      captionBlock = visible[next];
      next += 1;
    }
  }

  let restIndex;
  if (!titleUsable) {
    restIndex = 0;
  } else {
    restIndex = underlineIndex >= 0 ? underlineIndex : titleIndex;
    if (portraitBlock) {
      restIndex = visible.indexOf(portraitBlock);
      if (captionBlock) restIndex = visible.indexOf(captionBlock);
    }
    restIndex += 1;
  }
  const restBlock = visible[restIndex] ?? null;
  const restStart = titleUsable
    ? (restBlock ? restBlock.start : source.length)
    : (visible[0]?.start ?? 0);

  const profile = {
    portrait: portraitBlock
      ? {
        start: portraitBlock.start,
        end: portraitBlock.end,
        kind: portraitBlock.kind,
        src: portraitBlock.src,
        alt: portraitBlock.alt,
        valid: portraitBlock.valid
      }
      : null,
    caption: captionBlock
      ? {
        start: captionBlock.start,
        end: captionBlock.end,
        text: blockTextForProfile(captionBlock, source).text,
        raw: source.slice(captionBlock.start, captionBlock.end)
      }
      : null,
    restStart
  };

  const standaloneImageLine = titleUsable
    ? findStandaloneImageLine(
      lines,
      maskedSource,
      [...allCodeRanges, ...commentRanges],
      defs
    )
    : null;
  const textBeforeStandaloneImage = Boolean(standaloneImageLine && visible.some(block => (
    block.line < standaloneImageLine.line
    && !["title", "underline", "comment", "definition", "divider"].includes(block.type)
    && source.slice(block.start, block.end).trim().length > 0
  )));

  let profileIssue = null;
  if (selectedLayout === "profile" && !(titleUsable && portraitBlock)) {
    if (!titleUsable) {
      profileIssue = laterUsableHeading(visible)
        ? { code: "title-not-first", messageKey: PROFILE_MESSAGE_KEYS["title-not-first"] }
        : { code: "missing-title", messageKey: PROFILE_MESSAGE_KEYS["missing-title"] };
    } else if (expected?.type === "image") {
      profileIssue = { code: "invalid-portrait", messageKey: PROFILE_MESSAGE_KEYS["invalid-portrait"] };
    } else {
      const candidate = visible.some(block => block.type === "image" && block.valid)
        || textBeforeStandaloneImage;
      profileIssue = candidate
        ? { code: "portrait-out-of-order", messageKey: PROFILE_MESSAGE_KEYS["portrait-out-of-order"] }
        : { code: "missing-portrait", messageKey: PROFILE_MESSAGE_KEYS["missing-portrait"] };
    }
  }

  const validProfile = titleUsable && portraitBlock !== null;
  const effectiveLayout = selectedLayout === "profile" && validProfile ? "profile" : "plain";

  return {
    body: source,
    selectedLayout,
    effectiveLayout,
    title,
    underline,
    profile,
    profileIssue,
    blocks,
    definitions: Array.from(defs.values()),
    codeRanges: allCodeRanges,
    commentRanges,
    imageSources
  };
}

/** True when the offset sits inside fenced/indented/inline code or a comment. */
export function isOffsetInCodeOrComment(parsed, offset) {
  if (!parsed || !Number.isFinite(offset)) return false;
  const inside = ranges => ranges.some(([start, end]) => offset >= start && offset < end);
  return inside(parsed.codeRanges ?? []) || inside(parsed.commentRanges ?? []);
}
