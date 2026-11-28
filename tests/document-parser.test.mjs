import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument, isOffsetInCodeOrComment } from "../scripts/document/parse.mjs";

const blockTypes = parsed => parsed.blocks.map(block => block.type);

test("title: only a top-level ATX H1 on physical line 1", () => {
  const plain = parseDocument("# Ada");
  assert.equal(plain.title.present, true);
  assert.equal(plain.title.empty, false);
  assert.equal(plain.title.text, "Ada");
  assert.equal(plain.title.raw, "# Ada");
  assert.equal(plain.title.line, 0);

  assert.equal(parseDocument("# Ada ##").title.text, "Ada");
  assert.equal(parseDocument("# Ada#").title.text, "Ada#");
  assert.equal(parseDocument("   # Ada").title.text, "Ada");
  assert.equal(parseDocument("#\tAda").title.text, "Ada");
  assert.equal(parseDocument("## Ada").title, null);
  assert.equal(parseDocument("#Ada").title, null, "ATX needs a space after the hashes");
  assert.equal(parseDocument("    # Ada").title, null, "four spaces is indented code");
  assert.equal(parseDocument("> # Ada").title, null);
  assert.equal(parseDocument("- # Ada").title, null);
  assert.equal(parseDocument("\n# Ada").title, null, "a leading blank line blocks the title");
  assert.equal(parseDocument("<!-- comment -->\n# Ada").title, null, "a leading comment blocks the title");
  assert.equal(parseDocument("<!-- comment -->\n# Ada").title, null);
});

test("title: CRLF and lone CR are normalised while offsets stay meaningful", () => {
  const crlf = parseDocument("# Ada\r\n---\r\nbody");
  assert.equal(crlf.body, "# Ada\n---\nbody");
  assert.equal(crlf.title.text, "Ada");
  assert.deepEqual(crlf.underline, { start: 6, end: 9, line: 1 });
  assert.equal(crlf.body.slice(crlf.title.start, crlf.title.end), "# Ada");

  const cr = parseDocument("# Ada\r---\rbody");
  assert.equal(cr.body, "# Ada\n---\nbody");
  assert.equal(cr.title.text, "Ada");
  assert.equal(cr.underline.line, 1);
});

test("title: empty H1 is an editing affordance, not usable title text", () => {
  for (const body of ["#", "# ", "#   "]) {
    const parsed = parseDocument(body);
    assert.equal(parsed.title.present, true, body);
    assert.equal(parsed.title.empty, true, body);
    assert.equal(parsed.title.text, "", body);
  }
});

test("headings: later and non-top-level H1s are not titles", () => {
  const later = parseDocument("# Ada\n\n# Later");
  assert.equal(later.title.text, "Ada");
  const laterHeading = later.blocks.find(block => block.type === "heading");
  assert.equal(laterHeading.level, 1);
  assert.equal(laterHeading.text, "Later");

  const quoted = parseDocument("> # Quoted");
  assert.equal(quoted.title, null);
  assert.deepEqual(blockTypes(quoted), ["quote"]);

  const listed = parseDocument("- # Listed");
  assert.equal(listed.title, null);
  assert.deepEqual(blockTypes(listed), ["list"]);

  const raw = parseDocument("<h1>Raw HTML</h1>");
  assert.equal(raw.title, null);
  assert.deepEqual(blockTypes(raw), ["html"]);

  const duplicate = parseDocument("# Same\n\n# Same");
  assert.equal(duplicate.title.text, "Same");
  assert.equal(duplicate.blocks.filter(block => block.type === "heading")[0].text, "Same");
});

test("underline: a standalone --- after a heading is an underline", () => {
  const adjacent = parseDocument("# Ada\n---\nbody");
  assert.deepEqual(adjacent.underline, { start: 6, end: 9, line: 1 });
  assert.deepEqual(blockTypes(adjacent), ["title", "underline", "paragraph"]);

  const blankBetween = parseDocument("# Ada\n\n---\nbody");
  assert.deepEqual(blankBetween.underline, { start: 7, end: 10, line: 2 });
  assert.equal(blankBetween.effectiveLayout, "plain");

  const commentBetween = parseDocument("# Ada\n<!-- c -->\n---");
  assert.equal(commentBetween.underline.line, 2);
  assert.equal(commentBetween.blocks.find(block => block.type === "underline").type, "underline");

  const heading = parseDocument("# Ada\n\n## Sub\n---");
  assert.equal(heading.underline, null, "only the note title underline is exposed");
  assert.equal(heading.blocks.find(block => block.type === "heading").underlined, true);

  const otherBreak = parseDocument("# Ada\n***");
  assert.equal(otherBreak.underline, null);
  assert.deepEqual(blockTypes(otherBreak), ["title", "divider"]);

  const twice = parseDocument("# Ada\n---\n---");
  assert.equal(twice.blocks.filter(block => block.type === "underline").length, 1);
  assert.equal(twice.blocks.filter(block => block.type === "divider").length, 1);
});

test("divider: --- after plain text never forms a setext heading", () => {
  const dashed = parseDocument("Text\n---\nmore");
  assert.equal(dashed.underline, null);
  assert.deepEqual(blockTypes(dashed), ["paragraph", "divider", "paragraph"]);

  const equals = parseDocument("Text\n===");
  assert.equal(equals.underline, null);
  assert.ok(!equals.blocks.some(block => block.type === "heading"));
  assert.deepEqual(blockTypes(equals), ["paragraph", "paragraph"]);

  const indentedEquals = parseDocument("Text\n   ===");
  assert.deepEqual(blockTypes(indentedEquals), ["paragraph", "paragraph"]);

  const divider = parseDocument("---");
  assert.deepEqual(blockTypes(divider), ["divider"]);
});

test("tables: separator rows stay inside tables and are never dividers", () => {
  const table = parseDocument("| A | B |\n| --- | --- |\n| a | --- |");
  assert.deepEqual(blockTypes(table), ["table"]);

  const bare = parseDocument("a | ---");
  assert.deepEqual(blockTypes(bare), ["paragraph"]);
  assert.ok(!bare.blocks.some(block => block.type === "divider"));

  const separatorOnly = parseDocument("| --- |");
  assert.deepEqual(blockTypes(separatorOnly), ["paragraph"]);

  const singleColumn = parseDocument("| A |\n| --- |\n| 1 |");
  assert.deepEqual(blockTypes(singleColumn), ["table"]);
});

test("fenced code: matching lengths, longer closers and both fence characters", () => {
  const backticks = parseDocument("```js\n# Not title\n---\n![a](b)\n```\n# Real");
  assert.equal(backticks.title, null, "the H1 after a fence is not on line 1");
  assert.deepEqual(backticks.imageSources, []);
  assert.ok(!backticks.blocks.some(block => block.type === "divider"));
  assert.equal(backticks.blocks[0].type, "code");
  assert.equal(backticks.blocks[0].codeKind, "fenced");
  assert.equal(backticks.codeRanges.length, 1);

  const longerCloser = parseDocument("```\n# no\n````\n# Real");
  assert.equal(longerCloser.blocks[0].type, "code");
  assert.equal(longerCloser.blocks[1].type, "heading");

  const tildes = parseDocument("~~~~\n<!-- not a comment -->\n~~~\n~~~~\n# Real");
  assert.equal(tildes.commentRanges.length, 0, "comment syntax inside a tilde fence is code");
  assert.equal(tildes.blocks[0].type, "code");
  assert.equal(tildes.blocks[0].end, tildes.body.indexOf("\n# Real"));

  const unclosed = parseDocument("```\n# not\n![a](b)");
  assert.equal(unclosed.blocks.length, 1);
  assert.equal(unclosed.blocks[0].type, "code");
  assert.deepEqual(unclosed.imageSources, []);
});

test("indented code: four spaces is code, including comment-looking lines", () => {
  const parsed = parseDocument("    # Not title\n    <!-- not comment -->\n    ![a](b)\n\n# Real");
  assert.equal(parsed.title, null);
  assert.equal(parsed.blocks[0].type, "code");
  assert.equal(parsed.blocks[0].codeKind, "indented");
  assert.deepEqual(parsed.commentRanges, []);
  assert.deepEqual(parsed.imageSources, []);
  assert.equal(parsed.blocks[1].type, "heading");
  assert.equal(isOffsetInCodeOrComment(parsed, 4), true);
  assert.equal(isOffsetInCodeOrComment(parsed, parsed.blocks[0].end + 2), false);
});

test("comments: multi-line comments are inert and tolerated between profile slots", () => {
  const comment = parseDocument("<!--\n# Not title\n---\n![a](b)\n-->");
  assert.equal(comment.title, null);
  assert.deepEqual(comment.imageSources, []);
  assert.equal(comment.commentRanges.length, 1);
  assert.equal(comment.commentRanges[0][0], 0);
  assert.equal(comment.commentRanges[0][1], comment.body.length);

  const between = parseDocument("# Ada\n\n<!-- note -->\n\n![a](b)", { selectedLayout: "profile" });
  assert.equal(between.effectiveLayout, "profile");
  assert.equal(between.profile.portrait.src, "b");
  assert.equal(between.profileIssue, null);

  const inline = parseDocument("# Ada <!-- hidden -->\n\nbody");
  assert.equal(inline.title.text, "Ada");
  assert.equal(inline.commentRanges.length, 1);

  const leadingInline = parseDocument("<!-- c --> # Ada\nbody");
  assert.equal(leadingInline.title, null, "line 1 still starts with a comment");
  assert.equal(leadingInline.blocks[0].type, "heading");
  assert.equal(leadingInline.blocks[0].text, "Ada");
  assert.equal(leadingInline.blocks[0].level, 1);

  const inlineCode = parseDocument("`<!-- not a comment -->`");
  assert.deepEqual(inlineCode.commentRanges, [], "comment syntax inside inline code is inert");
});

test("blockquotes, lists, task lists and reference definitions are contextual", () => {
  const quote = parseDocument("> # Quoted\n> ---\n> ![a](b)");
  assert.deepEqual(blockTypes(quote), ["quote"]);
  assert.deepEqual(quote.imageSources, ["b"], "images in quotes are still ordinary body images");
  assert.equal(quote.title, null);
  assert.ok(!quote.blocks.some(block => block.type === "heading"));

  const list = parseDocument("- one\n  - [x] nested\n- [ ] two");
  assert.deepEqual(blockTypes(list), ["list"]);

  const nestedHeading = parseDocument("- item\n\n  # Nested heading");
  assert.deepEqual(blockTypes(nestedHeading), ["list"], "an indented heading stays inside the list block");

  const definitions = parseDocument("[id]: <https://example.test/a.png> \"Title\"");
  assert.deepEqual(blockTypes(definitions), ["definition"]);
});

test("profile: valid inline structure consumes title, portrait, caption and rest", () => {
  const body = "# Ada\n---\n![Portrait](https://example.test/p.png \"Me\")\n\n## Caption\n\nBody text";
  const parsed = parseDocument(body, { selectedLayout: "profile" });
  assert.equal(parsed.effectiveLayout, "profile");
  assert.equal(parsed.selectedLayout, "profile");
  assert.equal(parsed.profileIssue, null);
  assert.equal(parsed.profile.portrait.kind, "inline");
  assert.equal(parsed.profile.portrait.src, "https://example.test/p.png");
  assert.equal(parsed.profile.portrait.alt, "Portrait");
  assert.equal(parsed.profile.portrait.valid, true);
  assert.equal(parsed.profile.caption.text, "Caption");
  assert.equal(parsed.profile.caption.raw, "## Caption");
  assert.equal(parsed.body.slice(parsed.profile.restStart).trim(), "Body text");
});

test("profile: reference portraits resolve definitions later and keep source exact", () => {
  const bodies = [
    "# Ada\n\n![Alt][pic]\n\n[pic]: <https://example.test/p.png> \"T\"",
    "# Ada\n\n![Alt][]\n\n[alt]: https://example.test/p.png",
    "# Ada\n\n![Alt][PIC]\n\n[Pic]: https://example.test/p.png (Paren title)"
  ];
  for (const body of bodies) {
    const parsed = parseDocument(body, { selectedLayout: "profile" });
    assert.equal(parsed.effectiveLayout, "profile", body);
    assert.equal(parsed.profile.portrait.kind, "reference", body);
    assert.equal(parsed.profile.portrait.src, "https://example.test/p.png", body);
    assert.equal(parsed.profile.portrait.alt, "Alt", body);
  }
});

test("definitions are exposed additively for render-time image resolution", () => {
  const parsed = parseDocument([
    "# Ada",
    "",
    "![Alt][pic]",
    "",
    "[pic]: <https://x/y z.png> \"T\""
  ].join("\n"));
  assert.deepEqual(parsed.definitions, [{
    label: "pic",
    rawLabel: "pic",
    destination: "https://x/y z.png",
    title: "T"
  }]);
});

test("profile: broken URLs are structurally valid, extra images are ordinary content", () => {
  const parsed = parseDocument("# Ada\n\n![a](https://broken.invalid/nope.png)\n\n![b](https://example.test/b.png)", {
    selectedLayout: "profile"
  });
  assert.equal(parsed.effectiveLayout, "profile");
  assert.equal(parsed.profileIssue, null);
  assert.equal(parsed.profile.portrait.src, "https://broken.invalid/nope.png");
  assert.deepEqual(parsed.imageSources, [
    "https://broken.invalid/nope.png",
    "https://example.test/b.png"
  ]);
});

test("profile: missing optional divider or caption never invalidates", () => {
  const noDivider = parseDocument("# Ada\n![a](b)", { selectedLayout: "profile" });
  assert.equal(noDivider.effectiveLayout, "profile");
  assert.equal(noDivider.underline, null);
  assert.equal(noDivider.profile.caption, null);

  const emptyCaption = parseDocument("# Ada\n![a](b)\n## ", { selectedLayout: "profile" });
  assert.equal(emptyCaption.effectiveLayout, "profile");
  assert.equal(emptyCaption.profile.caption.text, "");
});

test("profile issue: missing-title", () => {
  const parsed = parseDocument("Just body text", { selectedLayout: "profile" });
  assert.equal(parsed.effectiveLayout, "plain");
  assert.equal(parsed.selectedLayout, "profile");
  assert.deepEqual(parsed.profileIssue, {
    code: "missing-title",
    messageKey: "JN.Profile.NeedsTitle"
  });
});

test("profile issue: title-not-first, including image-first order", () => {
  const text = parseDocument("Some text\n\n# Later title", { selectedLayout: "profile" });
  assert.equal(text.profileIssue.code, "title-not-first");
  assert.equal(text.profileIssue.messageKey, "JN.Profile.MoveTitle");
  assert.equal(text.effectiveLayout, "plain");

  const imageFirst = parseDocument("![a](b)\n\n# Later title", { selectedLayout: "profile" });
  assert.equal(imageFirst.profileIssue.code, "title-not-first");

  const emptyAffordance = parseDocument("# \n\n# Later", { selectedLayout: "profile" });
  assert.equal(emptyAffordance.profileIssue.code, "title-not-first");
});

test("profile issue: missing-portrait", () => {
  const parsed = parseDocument("# Ada\n\nBody only", { selectedLayout: "profile" });
  assert.equal(parsed.effectiveLayout, "plain");
  assert.deepEqual(parsed.profileIssue, {
    code: "missing-portrait",
    messageKey: "JN.Profile.NeedsPortrait"
  });
  assert.equal(parsed.profile.portrait, null);
});

test("profile issue: portrait-out-of-order", () => {
  const parsed = parseDocument("# Ada\n\nVisible text\n\n![a](b)", { selectedLayout: "profile" });
  assert.equal(parsed.effectiveLayout, "plain");
  assert.deepEqual(parsed.profileIssue, {
    code: "portrait-out-of-order",
    messageKey: "JN.Profile.MovePortrait"
  });
  assert.equal(parsed.profile.portrait, null, "an out-of-order image is not the profile portrait");
});

test("profile issue: standalone portrait in a soft-break paragraph is out of order", () => {
  const parsed = parseDocument("# Ada\nhello\n![p](a.png)", { selectedLayout: "profile" });
  assert.equal(parsed.effectiveLayout, "plain");
  assert.deepEqual(parsed.profileIssue, {
    code: "portrait-out-of-order",
    messageKey: "JN.Profile.MovePortrait"
  });
  assert.equal(parsed.profile.portrait, null);

  const noImage = parseDocument("# Ada\nhello", { selectedLayout: "profile" });
  assert.equal(noImage.profileIssue.code, "missing-portrait");
});

test("profile issue: invalid-portrait", () => {
  for (const portrait of ["![a](b", "![]()", "![a][missing]"]) {
    const parsed = parseDocument(`# Ada\n\n${portrait}`, { selectedLayout: "profile" });
    assert.equal(parsed.effectiveLayout, "plain", portrait);
    assert.deepEqual(parsed.profileIssue, {
      code: "invalid-portrait",
      messageKey: "JN.Profile.CompletePortrait"
    }, portrait);
  }
});

test("layout switching never mutates body and keeps the selected layout", () => {
  const body = "# Ada\r\n\r\nbody without a portrait";
  const before = body;
  const plain = parseDocument(body, { selectedLayout: "plain" });
  const profile = parseDocument(body, { selectedLayout: "profile" });
  assert.equal(body, before);
  assert.equal(plain.body, profile.body);
  assert.equal(plain.selectedLayout, "plain");
  assert.equal(profile.selectedLayout, "profile");
  assert.equal(profile.effectiveLayout, "plain");
});

test("imageSources: source order, duplicates, and outside code/comments/inline code", () => {
  const body = [
    "# Ada",
    "",
    "`![inline](https://example.test/inline.png)`",
    "",
    "![one](https://example.test/one.png) ![one again](https://example.test/one.png)",
    "",
    "<!-- ![comment](https://example.test/comment.png) -->",
    "",
    "```",
    "![code](https://example.test/code.png)",
    "```",
    "",
    "![ref][later]",
    "",
    "<img src=\"https://example.test/raw.png\">",
    "",
    "[later]: https://example.test/later.png"
  ].join("\n");
  const parsed = parseDocument(body);
  assert.deepEqual(parsed.imageSources, [
    "https://example.test/one.png",
    "https://example.test/one.png",
    "https://example.test/later.png"
  ]);
});

test("fenced code inside a blockquote is inert for images and comments", () => {
  const parsed = parseDocument("> ```\n> # not title\n> ![a](https://example.test/in-quote.png)\n> <!-- code -->\n> ```");
  assert.deepEqual(parsed.imageSources, []);
  assert.deepEqual(parsed.commentRanges, []);
  assert.equal(parsed.codeRanges.length, 1);
  assert.equal(parsed.title, null);
});

test("raw HTML h1/img never become title or portrait slots", () => {
  const raw = parseDocument("<h1>Raw</h1>\n\n<img src=\"https://example.test/x.png\">", {
    selectedLayout: "profile"
  });
  assert.equal(raw.title, null);
  assert.equal(raw.profile.portrait, null);
  assert.deepEqual(raw.imageSources, []);
  assert.ok(raw.blocks.every(block => block.type === "html"));
  assert.equal(raw.profileIssue.code, "missing-title");

  const rawAfterTitle = parseDocument("# Ada\n\n<img src=\"https://example.test/x.png\">", {
    selectedLayout: "profile"
  });
  assert.equal(rawAfterTitle.profileIssue.code, "missing-portrait");
});

test("isOffsetInCodeOrComment handles fenced, indented, inline code and comments", () => {
  const body = "# A\n\n`inline`\n\n<!-- comment -->\n\n```\nfenced\n```";
  const parsed = parseDocument(body);
  const inline = body.indexOf("inline");
  const comment = body.indexOf("comment");
  const fenced = body.indexOf("fenced");
  assert.equal(isOffsetInCodeOrComment(parsed, inline), true);
  assert.equal(isOffsetInCodeOrComment(parsed, comment), true);
  assert.equal(isOffsetInCodeOrComment(parsed, fenced), true);
  assert.equal(isOffsetInCodeOrComment(parsed, body.indexOf("A")), false);
  assert.equal(isOffsetInCodeOrComment(parsed, -1), false);
  assert.equal(isOffsetInCodeOrComment(parsed, undefined), false);
});
