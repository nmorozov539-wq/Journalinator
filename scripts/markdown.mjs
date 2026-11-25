/**
 * Markdown rendering for note blocks.
 *
 * Foundry ships Showdown as `window.showdown` (it powers the core Markdown journal pages), so the
 * module does not need to bundle or build a converter. The HTML is passed through Foundry's own
 * `cleanHTML` allowlist before it reaches the DOM.
 */
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
    ? escape(text) : text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
  return escaped.replace(/\n/g, "<br>");
}

/** Adds clickable task boxes and safe link targets to already-sanitized HTML. */
function polishHtml(html, interactiveTasks) {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;

  for (const link of template.content.querySelectorAll("a[href]")) {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  for (const box of template.content.querySelectorAll('input[type="checkbox"]')) {
    box.classList.add("jn-task-checkbox");
    box.removeAttribute("style");
    if (interactiveTasks) box.removeAttribute("disabled");
  }
  return template.innerHTML;
}

/**
 * Renders one note block as Markdown. Returns escaped plain text when Showdown is unavailable so
 * an unexpected load order can never make note text disappear.
 */
export function renderMarkdown(text, { interactiveTasks = false } = {}) {
  const source = String(text ?? "");
  if (!source.trim()) return "";
  const active = getConverter();
  const html = active ? active.makeHtml(source) : escapePlainText(source);
  if (!active) return html;

  const clean = globalThis.foundry?.utils?.cleanHTML;
  const safe = typeof clean === "function" ? clean(html) : html;
  return polishHtml(safe, interactiveTasks);
}

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;

/**
 * Toggles the nth GFM task-list checkbox in a block. Returns the updated source, or null when the
 * index does not exist (e.g. the rendered HTML is older than the text).
 */
export function toggleTaskListItem(text, index) {
  let seen = 0;
  let changed = false;
  const lines = String(text ?? "").split("\n").map(line => {
    const match = line.match(TASK_RE);
    if (!match) return line;
    if (seen++ !== index) return line;
    changed = true;
    const markAt = match[1].length;
    return line.slice(0, markAt) + (match[2] === " " ? "x" : " ") + line.slice(markAt + 1);
  });
  return changed ? lines.join("\n") : null;
}
