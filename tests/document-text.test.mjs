import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../scripts/document/parse.mjs";
import {
  deriveTitle,
  deriveExcerpt,
  plainVisibleText,
  stripInlineSyntax
} from "../scripts/document/text.mjs";

test("deriveTitle uses nonempty title text and collapses whitespace", () => {
  assert.equal(deriveTitle(parseDocument("#   Ada   Lovelace  ")), "Ada Lovelace");
  assert.equal(deriveTitle(parseDocument("# **Bold** Ada")), "Bold Ada");
  assert.equal(deriveTitle(parseDocument("# Same\n\n# Same")), "Same");
});

test("deriveTitle ignores the empty H1 affordance", () => {
  assert.equal(deriveTitle(parseDocument("# ")), "Empty note");
  assert.equal(deriveTitle(parseDocument("# \n\nSome body")), "Some body");
});

test("deriveTitle falls back to the first 70 code points of visible text", () => {
  const long = "x".repeat(100);
  assert.equal(deriveTitle(parseDocument(`Body ${long}`)), "Body " + "x".repeat(65));
  assert.equal(deriveTitle(parseDocument(`# Title\n\nbody text`)), "Title");
});

test("deriveTitle counts Unicode code points, not UTF-16 units", () => {
  const emoji = "😀".repeat(80);
  const title = deriveTitle(parseDocument(emoji));
  assert.equal(Array.from(title).length, 70);
  assert.equal(title, "😀".repeat(70));
});

test("deriveTitle returns Image note for image-only bodies and Empty note for empty bodies", () => {
  assert.equal(deriveTitle(parseDocument("![alt](https://example.test/a.png)")), "Image note");
  assert.equal(deriveTitle(parseDocument("")), "Empty note");
  assert.equal(deriveTitle(parseDocument("   \n\n  ")), "Empty note");
  assert.equal(deriveTitle(parseDocument("```\n![a](b)\n```")), "Empty note");
});

test("derived labels can be overridden", () => {
  assert.equal(deriveTitle(parseDocument(""), { emptyLabel: "Nothing" }), "Nothing");
  assert.equal(deriveTitle(parseDocument("![a](b)"), { imageLabel: "Picture" }), "Picture");
});

test("plainVisibleText excludes title, syntax, URLs, code, comments and definitions", () => {
  const body = [
    "# Title line",
    "",
    "Some **bold** and *italic* and ~~struck~~ and `inline code`.",
    "",
    "[Link label](https://example.test/url)",
    "",
    "```",
    "code block text",
    "```",
    "",
    "<!-- hidden comment -->",
    "",
    "[ref]: https://example.test/definition",
    "",
    "---",
    "",
    "[[Missing note]]"
  ].join("\n");
  const text = plainVisibleText(parseDocument(body));
  assert.equal(
    text,
    "Some bold and italic and struck and . Link label [[Missing note]]"
  );
  assert.doesNotMatch(text, /Title line|inline code|code block|hidden comment|example\.test|ref:/);
  assert.match(text, /\[\[Missing note\]\]/, "wikilinks stay literal");
});

test("plainVisibleText includes headings, lists, quotes, tables and HTML text", () => {
  const body = [
    "## Heading",
    "",
    "- one",
    "- [x] two",
    "",
    "> quote",
    "",
    "| A | B |",
    "| --- | --- |",
    "| cell one | cell two |",
    "",
    "<div>html text</div>"
  ].join("\n");
  const text = plainVisibleText(parseDocument(body));
  assert.match(text, /Heading/);
  assert.match(text, /one two/);
  assert.match(text, /quote/);
  assert.match(text, /cell one cell two/);
  assert.match(text, /html text/);
});

test("plainVisibleText excludes image destinations and alt syntax", () => {
  const parsed = parseDocument("# A\n\nBefore ![alt](https://example.test/a.png) after");
  assert.equal(plainVisibleText(parsed), "Before after");
});

test("deriveExcerpt truncates by code points and excludes the title line", () => {
  const parsed = parseDocument("# Title\n\n" + "😀".repeat(100));
  const excerpt = deriveExcerpt(parsed, 20);
  assert.equal(Array.from(excerpt).length, 20);
  assert.equal(excerpt, "😀".repeat(20));
  assert.equal(deriveExcerpt(parsed, 0), "");
});

test("deriveExcerpt defaults to 70 code points", () => {
  const parsed = parseDocument("x".repeat(100));
  assert.equal(deriveExcerpt(parsed), "x".repeat(70));
});

test("stripInlineSyntax leaves no markers or URL destinations", () => {
  assert.equal(stripInlineSyntax("**a** [b](https://e.test) `c` ![d](e)"), "a b");
  assert.equal(stripInlineSyntax("<!-- x --> visible"), "visible");
  assert.equal(stripInlineSyntax("## Heading"), "Heading");
});
