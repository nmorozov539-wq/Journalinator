import { test } from "node:test";
import assert from "node:assert/strict";

let JSDOM = null;
let showdown = null;
try {
  ({ JSDOM } = await import("jsdom"));
  showdown = (await import("showdown")).default;
} catch {
  // Bare checkout without npm install: skip the dependency-backed renderer tests.
}

if (!JSDOM || !showdown) {
  test("Markdown tests (run `npm install` to enable)", { skip: true }, () => {});
} else {
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.showdown = showdown;
globalThis.foundry = {
  utils: {
    escapeHTML: value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`),
    cleanHTML: html => html
  }
};

const { renderMarkdown, toggleTaskListItem } = await import("../scripts/markdown.mjs");
const { applyMarkdownAutocomplete } = await import("../scripts/markdown-edit.mjs");

test("renders headings, emphasis, lists, quotes, code, and tables", () => {
  const html = renderMarkdown([
    "# Heading",
    "",
    "A **bold** and *italic* and ~~struck~~ paragraph.",
    "",
    "- one",
    "- two",
    "",
    "> quoted",
    "",
    "`inline`",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |"
  ].join("\n"));
  assert.match(html, /<h1[^>]*>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<del>struck<\/del>/);
  assert.match(html, /<ul>[\s\S]*<li>one<\/li>/);
  assert.match(html, /<blockquote>[\s\S]*quoted/);
  assert.match(html, /<code>inline<\/code>/);
  assert.match(html, /<table>/);
});

test("renders task lists and only enables them for interactive contexts", () => {
  const source = "- [ ] first\n- [x] second";
  const readOnly = renderMarkdown(source);
  assert.match(readOnly, /<input[^>]*type="checkbox"[^>]*disabled/);
  assert.match(readOnly, /<input[^>]*type="checkbox"[^>]*checked/);

  const interactive = renderMarkdown(source, { interactiveTasks: true });
  assert.match(interactive, /class="jn-task-checkbox"/);
  assert.doesNotMatch(interactive, /disabled/);
});

test("opens rendered links safely in a new tab", () => {
  const html = renderMarkdown("[Foundry](https://foundryvtt.com)");
  assert.match(html, /href="https:\/\/foundryvtt.com"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("toggles task list items by rendered order", () => {
  const source = "- [ ] first\n  - [x] nested\n1. [ ] ordered";
  assert.equal(toggleTaskListItem(source, 0), "- [x] first\n  - [x] nested\n1. [ ] ordered");
  assert.equal(toggleTaskListItem(source, 1), "- [ ] first\n  - [ ] nested\n1. [ ] ordered");
  assert.equal(toggleTaskListItem(source, 2), "- [ ] first\n  - [x] nested\n1. [x] ordered");
  assert.equal(toggleTaskListItem(source, 9), null);
  assert.equal(toggleTaskListItem("plain text", 0), null);
});

test("typing ( inserts the closing bracket", () => {
  const textarea = document.createElement("textarea");
  textarea.value = "hello ";
  textarea.selectionStart = textarea.selectionEnd = 6;
  const event = new dom.window.KeyboardEvent("keydown", { key: "(", cancelable: true });
  assert.equal(applyMarkdownAutocomplete(event, textarea), true);
  assert.equal(textarea.value, "hello ()");
  assert.equal(textarea.selectionStart, 7);
});

test("typing the second * completes a bold pair", () => {
  const textarea = document.createElement("textarea");
  textarea.value = "bold *";
  textarea.selectionStart = textarea.selectionEnd = 6;
  const event = new dom.window.KeyboardEvent("keydown", { key: "*", cancelable: true });
  assert.equal(applyMarkdownAutocomplete(event, textarea), true);
  assert.equal(textarea.value, "bold ****");
  assert.equal(textarea.selectionStart, 7);
});

test("typing a closing * after a word is left to native typing", () => {
  const textarea = document.createElement("textarea");
  textarea.value = "**bold*";
  textarea.selectionStart = textarea.selectionEnd = 7;
  const event = new dom.window.KeyboardEvent("keydown", { key: "*", cancelable: true });
  assert.equal(applyMarkdownAutocomplete(event, textarea), false);
  assert.equal(textarea.value, "**bold*");
});

test("typing a closing pair steps over the inserted character", () => {
  const textarea = document.createElement("textarea");
  textarea.value = "hello ()";
  textarea.selectionStart = textarea.selectionEnd = 7;
  const event = new dom.window.KeyboardEvent("keydown", { key: ")", cancelable: true });
  assert.equal(applyMarkdownAutocomplete(event, textarea), true);
  assert.equal(textarea.value, "hello ()");
  assert.equal(textarea.selectionStart, 8);
});

test("a selection is wrapped by brackets and quotes", () => {
  const textarea = document.createElement("textarea");
  textarea.value = "word";
  textarea.selectionStart = 0;
  textarea.selectionEnd = 4;
  const event = new dom.window.KeyboardEvent("keydown", { key: "(", cancelable: true });
  assert.equal(applyMarkdownAutocomplete(event, textarea), true);
  assert.equal(textarea.value, "(word)");
  assert.deepEqual([textarea.selectionStart, textarea.selectionEnd], [1, 5]);

  textarea.value = "word";
  textarea.selectionStart = 0;
  textarea.selectionEnd = 4;
  const quote = new dom.window.KeyboardEvent("keydown", { key: "\"", cancelable: true });
  assert.equal(applyMarkdownAutocomplete(quote, textarea), true);
  assert.equal(textarea.value, "\"word\"");
});

test("missing Showdown falls back to escaped text instead of dropping the block", () => {
  const saved = globalThis.showdown;
  globalThis.showdown = undefined;
  try {
    assert.equal(renderMarkdown("a < b & c"), "a &#60; b &#38; c");
  } finally {
    globalThis.showdown = saved;
  }
});
}
