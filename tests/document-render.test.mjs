import { test } from "node:test";
import assert from "node:assert/strict";
import showdown from "showdown";
import { parseDocument } from "../scripts/document/parse.mjs";
import { renderDocument, renderNoteBody } from "../scripts/document/render.mjs";

globalThis.showdown = showdown;
globalThis.foundry = {
  utils: {
    escapeHTML: value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`),
    cleanHTML: html => html
  }
};

const count = (html, fragment) => html.split(fragment).length - 1;

test("title renders as the note h1 and later/raw H1s become h2", () => {
  const html = renderNoteBody("# Ada\n\n# Later\n\n> # Quoted\n\n<h1>Raw</h1>").html;
  assert.match(html, /<h1 class="jn-note-title">Ada<\/h1>/);
  assert.match(html, /<h2>Later<\/h2>/);
  assert.match(html, /<blockquote>[\s\S]*<h2>Quoted<\/h2>/);
  assert.match(html, /<h2>Raw<\/h2>/);
  assert.equal(count(html, "<h1"), 1, "only the note title stays an h1");
  assert.doesNotMatch(html, /<h1[^>]*>(Later|Quoted|Raw)/);
});

test("leading-space titles and closing-hash headings render from canonical lines", () => {
  const threeSpaceTitle = renderNoteBody("   # Ada   ##\r\nBody\r\n").html;
  assert.match(threeSpaceTitle, /<h1 class="jn-note-title">Ada<\/h1>/);
  assert.match(threeSpaceTitle, /<p>Body<\/p>/);
  assert.doesNotMatch(threeSpaceTitle, /<p># Ada/);
  assert.doesNotMatch(threeSpaceTitle, /Ada   ##/);

  const spacedHeading = renderNoteBody("# Ada\n\n   ## Later   ##").html;
  assert.match(spacedHeading, /<h2>Later<\/h2>/);
  assert.doesNotMatch(spacedHeading, /Later   ##/);
});

test("comments are invisible to Markdown structure", () => {
  const leading = renderNoteBody("<!-- c --> # Ada\nbody").html;
  assert.match(leading, /<h2>Ada<\/h2>/);
  assert.match(leading, /<p>body<\/p>/);
  assert.doesNotMatch(leading, /<pre><code>/);
  assert.doesNotMatch(leading, /# Ada/);

  const multiline = renderNoteBody("# Ada\n<!--\nhidden\n-->\nbody").html;
  assert.match(multiline, /<h1 class="jn-note-title">Ada<\/h1>/);
  assert.doesNotMatch(multiline, /hidden/);
  assert.ok(multiline.indexOf("Ada") < multiline.indexOf("body"));

  const fenced = renderNoteBody("```\n<!-- keep -->\n```").html;
  assert.match(fenced, /&lt;!-- keep --&gt;/);
});

test("title underline uses classes instead of a separate hr", () => {
  const html = renderNoteBody("# Ada\n---\nbody").html;
  assert.match(html, /<h1 class="jn-note-title jn-title-underlined">Ada<\/h1>/);
  assert.doesNotMatch(html, /<hr/);

  const spaced = renderNoteBody("# Ada\n\n---\nbody").html;
  assert.match(spaced, /jn-title-underlined/);
});

test("the empty # affordance is not rendered as a reader title", () => {
  for (const body of ["#", "# ", "# \n\nbody"]) {
    const html = renderNoteBody(body).html;
    assert.doesNotMatch(html, /jn-note-title/, body);
    assert.doesNotMatch(html, /<h1/, body);
  }
});

test("heading rules and dividers follow note syntax", () => {
  const underlinedHeading = renderNoteBody("# A\n\n## B\n---\nbody").html;
  assert.match(underlinedHeading, /<h2 class="jn-heading-underlined">B<\/h2>/);
  assert.doesNotMatch(underlinedHeading, /<hr/);

  const paragraphRule = renderNoteBody("Text\n---\n\nmore").html;
  assert.match(paragraphRule, /<p>Text<\/p>/);
  assert.match(paragraphRule, /<hr \/>/);
  assert.match(paragraphRule, /<p>more<\/p>/);

  const divider = renderNoteBody("# A\n\nbody\n\n---").html;
  assert.match(divider, /<hr \/>/);

  const otherBreak = renderNoteBody("# A\n\n***\nbody").html;
  assert.match(otherBreak, /<hr \/>/);
  assert.doesNotMatch(otherBreak, /jn-heading-underlined/);
});

test("quoted heading followed by a quoted rule is underlined", () => {
  const html = renderNoteBody("> ## Sub\n> ---").html;
  assert.match(html, /<blockquote>[\s\S]*<h2 class="jn-heading-underlined">Sub<\/h2>[\s\S]*<\/blockquote>/);
  assert.doesNotMatch(html, /<hr/);
});

test("setext is forbidden: === stays literal text", () => {
  const html = renderNoteBody("Text\n===").html;
  assert.match(html, /<p>Text<\/p>/);
  assert.match(html, /<p>===<\/p>/);
  assert.doesNotMatch(html, /<h[12]/);

  const spaced = renderNoteBody("Text\n   ===").html;
  assert.match(spaced, /<p>===<\/p>/);
  assert.doesNotMatch(spaced, /<h[12]/);
});

test("tables, tasks, emphasis, code and links remain available", () => {
  const html = renderNoteBody([
    "**bold** and *italic* and ~~struck~~ and `inline`",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "- [ ] first",
    "- [x] second",
    "",
    "[Foundry](https://foundryvtt.com)",
    "",
    "```",
    "code line",
    "```"
  ].join("\n")).html;
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<del>struck<\/del>/);
  assert.match(html, /<code>inline<\/code>/);
  assert.match(html, /<table>/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*disabled/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*checked/);
  assert.match(html, /href="https:\/\/foundryvtt.com"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /<pre><code>code line\n<\/code><\/pre>/);
});

test("fenced code: longer closers and unclosed fences stay code", () => {
  const longer = renderNoteBody("```\n# not a heading\n````\n# Real heading").html;
  assert.match(longer, /<pre><code># not a heading\n<\/code><\/pre>/);
  assert.doesNotMatch(longer, /<p>`/);
  assert.match(longer, /<h2>Real heading<\/h2>/);

  const unclosed = renderNoteBody("```\n# not a heading\n![a](b)").html;
  assert.match(unclosed, /<pre><code># not a heading\n!\[a\]\(b\)\n<\/code><\/pre>/);
  assert.doesNotMatch(unclosed, /<h2>|<img/);
});

test("interactive task checkboxes can be enabled", () => {
  const readOnly = renderNoteBody("- [ ] first").html;
  assert.match(readOnly, /disabled/);
  assert.match(readOnly, /class="jn-task-checkbox"/);
  assert.doesNotMatch(readOnly, /<input[^>]*style=/i);

  const interactive = renderNoteBody("- [ ] first", { interactiveTasks: true }).html;
  assert.match(interactive, /class="jn-task-checkbox"/);
  assert.doesNotMatch(interactive, /disabled/);
  assert.doesNotMatch(interactive, /<input[^>]*style=/i);
});

test("code and comment text stay inert and comments are omitted from display", () => {
  const html = renderNoteBody("```html\n<h1>code</h1>\n![a](b)\n<!-- c -->\n```\n\n<!-- hidden -->\nvisible").html;
  assert.match(html, /&lt;h1&gt;code&lt;\/h1&gt;/);
  assert.match(html, /!\[a\]\(b\)/);
  assert.doesNotMatch(html, /<h1>code/);
  assert.doesNotMatch(html, /hidden/);
  assert.match(html, /<p>visible<\/p>/);
});

test("raw HTML passes through the sanitizer and raw h1 is demoted", () => {
  let calls = 0;
  const sanitizer = html => {
    calls += 1;
    return html.replace(/<script[\s\S]*?<\/script>/gi, "[script removed]");
  };
  const html = renderNoteBody("# A\n\n<h1>Raw</h1>\n\n<script>alert(1)<\/script>", { sanitizer }).html;
  assert.equal(calls, 1);
  assert.match(html, /<h2>Raw<\/h2>/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /\[script removed\]/);
});

test("raw img renders as ordinary content but never becomes a portrait", () => {
  const result = renderNoteBody("# Ada\n\n<img src=\"https://example.test/raw.png\">", {
    selectedLayout: "profile"
  });
  assert.equal(result.parsed.effectiveLayout, "plain");
  assert.equal(result.parsed.profileIssue.code, "missing-portrait");
  assert.match(result.html, /<img src="https:\/\/example\.test\/raw\.png">/);
});

test("valid Profile renders every source element exactly once in order", () => {
  const body = "# Ada\n---\n![Portrait](https://example.test/p.png)\n\n## Caption\n\nBody text";
  const { parsed, html } = renderNoteBody(body, { selectedLayout: "profile" });
  assert.equal(parsed.effectiveLayout, "profile");
  assert.match(html, /jn-note-title/);
  assert.match(html, /jn-title-underlined/);
  assert.match(html, /jn-profile-caption/);
  assert.equal(count(html, "Ada"), 1);
  assert.equal(count(html, "Portrait"), 1);
  assert.equal(count(html, "Caption"), 1);
  assert.equal(count(html, "Body text"), 1);
  assert.ok(html.indexOf("Ada") < html.indexOf("Portrait"));
  assert.ok(html.indexOf("Portrait") < html.indexOf("Caption"));
  assert.ok(html.indexOf("Caption") < html.indexOf("Body text"));
});

test("Profile fallback renders all source content exactly once in order", () => {
  const body = "# Ada\n\nVisible text\n\n![An image](https://example.test/i.png)\n\nRest of body";
  const { parsed, html } = renderNoteBody(body, { selectedLayout: "profile" });
  assert.equal(parsed.effectiveLayout, "plain");
  assert.equal(parsed.profileIssue.code, "portrait-out-of-order");
  assert.equal(count(html, "Ada"), 1);
  assert.equal(count(html, "Visible text"), 1);
  assert.equal(count(html, "<img"), 1);
  assert.equal(count(html, "Rest of body"), 1);
  assert.ok(html.indexOf("Ada") < html.indexOf("Visible text"));
  assert.ok(html.indexOf("Visible text") < html.indexOf("<img"));
  assert.ok(html.indexOf("<img") < html.indexOf("Rest of body"));
});

test("table separator rows are not turned into hr or emphasized text", () => {
  const html = renderNoteBody("| A | B |\n| --- | --- |\n| a | --- |").html;
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<hr/);
  assert.match(html, /<td>---<\/td>/);
});

test("braced wikilinks stay literal", () => {
  const html = renderNoteBody("[[Missing note]]").html;
  assert.match(html, /\[\[Missing note\]\]/);
});

test("reference links and images render using definitions anywhere in the body", () => {
  const html = renderNoteBody([
    "# Ada",
    "",
    "![Alt][pic]",
    "",
    "A [link][id] in text.",
    "",
    "[pic]: <https://example.test/p.png> \"Portrait title\"",
    "[id]: https://example.test/page"
  ].join("\n"), { selectedLayout: "profile" }).html;
  assert.match(html, /<img src="https:\/\/example\.test\/p\.png" alt="Alt" title="Portrait title"/);
  assert.match(html, /href="https:\/\/example\.test\/page"/);
  assert.match(html, />link<\/a>/);
  assert.doesNotMatch(html, /\[pic\]:/);
  assert.doesNotMatch(html, /\[id\]:/);
});

test("resolvable reference images render inline, including spaced and forward definitions", () => {
  const normal = renderNoteBody([
    "# Ada",
    "",
    "![Alt][pic]",
    "",
    "[pic]: https://example.test/p.png \"T\""
  ].join("\n")).html;
  assert.match(normal, /<img src="https:\/\/example\.test\/p\.png" alt="Alt" title="T" \/>/);
  assert.doesNotMatch(normal, /!\[Alt\]\[pic\]/);
  assert.doesNotMatch(normal, /\[pic\]:/);

  const spaced = renderNoteBody("![alt][id]\n\n[id]: <https://x/y z.png> \"T\"").html;
  assert.match(spaced, /<img src="https:\/\/x\/y z\.png" alt="alt" title="T" \/>/);
  assert.doesNotMatch(spaced, /!\[alt\]\[id\]/);
  assert.doesNotMatch(spaced, /\[id\]:/);

  const forward = renderNoteBody([
    "![one][later]",
    "",
    "[later]: https://example.test/later.png",
    "",
    "A [link][later] in text."
  ].join("\n")).html;
  assert.match(forward, /<img src="https:\/\/example\.test\/later\.png" alt="one" \/>/);
  assert.match(forward, /<a href="https:\/\/example\.test\/later\.png"[^>]*>link<\/a>/);
  assert.doesNotMatch(forward, /!\[one\]\[later\]/);
  assert.doesNotMatch(forward, /\[later\]:/);

  const unresolved = renderNoteBody("![alt][missing]").html;
  assert.match(unresolved, /!\[alt\]\[missing\]/);
  assert.doesNotMatch(unresolved, /<img/);
});

test("unused reference definitions are not shown as prose", () => {
  const html = renderNoteBody("# Ada\n\nbody\n\n[unused]: https://example.test/u").html;
  assert.match(html, /<p>body<\/p>/);
  assert.doesNotMatch(html, /unused\]|example\.test\/u/);
});

test("shortcut reference links keep working", () => {
  const html = renderNoteBody("# Ada\n\nSee [ref] here.\n\n[ref]: https://example.test/x").html;
  assert.match(html, /<a href="https:\/\/example\.test\/x"[^>]*>ref<\/a>/);
});

test("setext suppression also applies inside blockquotes", () => {
  const equals = renderNoteBody("> Text\n> ===").html;
  assert.doesNotMatch(equals, /<h[12]/);
  assert.match(equals, /===/);

  const dashes = renderNoteBody("> Text\n> ---").html;
  assert.doesNotMatch(dashes, /<h[12]/);
  assert.match(dashes, /<blockquote>[\s\S]*<p>Text<\/p>[\s\S]*<hr \/>/);
});

test("single-column tables render as tables", () => {
  const html = renderNoteBody("| A |\n| --- |\n| 1 |").html;
  assert.match(html, /<table>/);
  assert.match(html, /<th>A<\/th>/);
});

test("Showdown absence falls back to escaped plain text with line breaks", () => {
  const savedShowdown = globalThis.showdown;
  globalThis.showdown = undefined;
  try {
    const html = renderNoteBody("a < b & c\nsecond").html;
    assert.equal(html, "a &#60; b &#38; c<br>second");
  } finally {
    globalThis.showdown = savedShowdown;
  }
});

test("renderDocument returns a string and renderNoteBody returns parsed plus html", () => {
  const parsed = parseDocument("# A");
  assert.equal(typeof renderDocument(parsed), "string");
  const result = renderNoteBody("# A");
  assert.ok(result.parsed);
  assert.equal(typeof result.html, "string");
});
