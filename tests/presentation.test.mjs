import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ATTACHMENT, DEFAULT_PRESENTATION, analyzeMarkdown, classifyNote, defaultLinkCosmetics,
  isGeneratedTitle, legacyPresentation, legacyStylePresentation, migrateNoteSystem, noteExcerpt,
  resolveAttachment, resolveLinkCosmetics, resolvePresentation, sanitizeCardAnchors, stripSecretPrefix
} from "../scripts/presentation.mjs";
import { migrateCardAnchors } from "../scripts/migrate.mjs";

test("legacy styles resolve into the new presentation vocabulary", () => {
  assert.deepEqual(
    pick(resolvePresentation({ system: { style: "sticky" } })),
    { extendedStyle: "memo", forceExtended: false, torn: false, heading: "" }
  );
  assert.deepEqual(
    pick(resolvePresentation({ system: { style: "memo" } })),
    { extendedStyle: "memo", forceExtended: true, torn: false, heading: "" }
  );
  assert.deepEqual(
    pick(resolvePresentation({ system: { style: "document" } })),
    { extendedStyle: "document", forceExtended: true, torn: false, heading: "" }
  );
  assert.deepEqual(
    pick(resolvePresentation({ system: { style: "wanted", targetHeading: "  Bounty  " } })),
    { extendedStyle: "target", forceExtended: true, torn: false, heading: "  Bounty  " }
  );
  assert.deepEqual(
    pick(resolvePresentation({ system: { style: "torn" } })),
    { extendedStyle: "memo", forceExtended: true, torn: true, heading: "" }
  );
});

test("legacyStylePresentation mirrors the legacy style resolver", () => {
  assert.deepEqual(legacyStylePresentation("sticky"), { extendedStyle: "memo", forceExtended: false, torn: false });
  assert.deepEqual(legacyStylePresentation("memo"), { extendedStyle: "memo", forceExtended: true, torn: false });
  assert.deepEqual(legacyStylePresentation("document"), { extendedStyle: "document", forceExtended: true, torn: false });
  assert.deepEqual(legacyStylePresentation("wanted"), { extendedStyle: "target", forceExtended: true, torn: false });
  assert.deepEqual(legacyStylePresentation("torn"), { extendedStyle: "memo", forceExtended: true, torn: true });
  assert.deepEqual(legacyStylePresentation("unknown"), legacyStylePresentation("sticky"));
});

test("stored presentation wins over the legacy style fallback", () => {
  const presentation = resolvePresentation({
    system: {
      style: "wanted", targetHeading: "old",
      label: "Captain Vex",
      presentation: {
        extendedStyle: "document", forceExtended: false, font: "hand",
        pictureLayout: "left", torn: true, heading: "Current heading", nameGenerated: false
      }
    }
  });
  assert.deepEqual(presentation, {
    label: "Captain Vex",
    extendedStyle: "document",
    forceExtended: false,
    font: "hand",
    pictureLayout: "left",
    torn: true,
    heading: "Current heading",
    nameGenerated: false
  });
  assert.deepEqual(legacyPresentation({ style: "unknown" }), DEFAULT_PRESENTATION);
});

test("generated titles are detected in EN and RU, with suffixes and the GM prefix", () => {
  for (const name of [
    "", "New Note", "New Note 12", "new note 3", "Новая заметка", "Новая заметка 4",
    "GM-7KQ2 New Note", "GM-7KQ2 New Note 2",
    "Memo", "Document", "Untitled", "Без названия", "Новая запись 2",
    "Character name", "Character name 3", "Имя персонажа", "GM-7KQ2 Имя персонажа"
  ]) {
    assert.equal(isGeneratedTitle(name), true, name);
  }
  for (const name of [
    "Tavern", "Captain Vex", "GM-7KQ2 Lord Vex", "Новая таверна", "Memo notes",
    "Character names", "Имя персонажа таверны"
  ]) {
    assert.equal(isGeneratedTitle(name), false, name);
  }
  assert.equal(stripSecretPrefix("GM-7KQ2 Lord Vex"), "Lord Vex");
});

test("legacy Target placeholder names migrate to an empty label", () => {
  for (const name of [
    "Character name", "Character name 2", "Имя персонажа", "GM-7KQ2 Character name"
  ]) {
    const migrated = migrateNoteSystem({ style: "wanted" }, name);
    assert.equal(migrated.presentation.nameGenerated, true, name);
    assert.equal(migrated.label, "", `${name} must not become a visible label`);
  }
  const real = migrateNoteSystem({ style: "wanted" }, "Captain Vex");
  assert.equal(real.presentation.nameGenerated, false);
  assert.equal(real.label, "Captain Vex");
});

test("migrateNoteSystem is additive and idempotent", () => {
  const first = migrateNoteSystem(
    { style: "wanted", targetHeading: "Bounty", label: "", blocks: [{ blockId: "b", text: "x" }] },
    "Captain Vex"
  );
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.label, "Captain Vex");
  assert.equal(first.presentation.extendedStyle, "target");
  assert.equal(first.presentation.forceExtended, true);
  assert.deepEqual(first.attachment, DEFAULT_ATTACHMENT);

  const second = migrateNoteSystem(
    { ...first, style: "wanted", targetHeading: "Bounty", blocks: [{ blockId: "b", text: "x" }] },
    "Captain Vex"
  );
  assert.deepEqual(second, first);

  const generated = migrateNoteSystem({ style: "sticky" }, "New Note 5");
  assert.equal(generated.label, "", "generated placeholder names never become labels");
  const explicit = migrateNoteSystem({ style: "sticky", label: "Keep me" }, "New Note 5");
  assert.equal(explicit.label, "Keep me", "an existing explicit label is preserved");
});

test("attachment defaults and clamping are safe", () => {
  assert.deepEqual(resolveAttachment({}), DEFAULT_ATTACHMENT);
  assert.deepEqual(
    resolveAttachment({
      system: { attachment: { mainPinEnabled: false, mainSnapRadius: 999, minorSnapRadius: -5, pinStyle: "brass" } }
    }),
    { mainPinEnabled: false, mainSnapRadius: 64, minorSnapRadius: 0, pinStyle: "brass" }
  );
  assert.deepEqual(
    resolveAttachment({ system: { attachment: { mainSnapRadius: "far", minorSnapRadius: "near", pinStyle: "rope" } } }),
    DEFAULT_ATTACHMENT
  );
});

test("link cosmetics resolve legacy dashed lines and clamp experimental bounds", () => {
  assert.deepEqual(defaultLinkCosmetics(), {
    material: "linen", thickness: 2.6, slack: 0.09, pattern: "continuous",
    ends: "standard", secondaryColor: ""
  });
  assert.equal(resolveLinkCosmetics({ lineStyle: "dashed" }).pattern, "interrupted");
  assert.deepEqual(
    resolveLinkCosmetics({
      material: "double", thickness: 0, slack: 1, pattern: "alternating",
      ends: "loose", secondaryColor: "link2"
    }),
    {
      material: "double", thickness: 0.8, slack: 0.25, pattern: "alternating",
      ends: "loose", secondaryColor: "link2"
    }
  );
  assert.deepEqual(resolveLinkCosmetics({ material: "rope", thickness: "wide" }), defaultLinkCosmetics());
  assert.equal(resolveLinkCosmetics({ secondaryColor: "url(javascript:alert(1))" }).secondaryColor, "");
  assert.equal(resolveLinkCosmetics({ secondaryColor: "#d6a45c" }).secondaryColor, "link2");
  assert.equal(resolveLinkCosmetics({ secondaryColor: "LINK3" }).secondaryColor, "link3");
});

test("card anchor sanitizing enforces bounds and the main-anchor convention", () => {
  assert.deepEqual(sanitizeCardAnchors({
    main: { kind: "main", x: 0.1, y: 0.9, createdBy: "u" },
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" },
    badKind: { kind: "other", x: 0.1, y: 0.1 },
    offCard: { kind: "minor", x: 2, y: 0.5 },
    ["i".repeat(101)]: { kind: "minor", x: 0.1, y: 0.1 }
  }), {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" }
  });
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) =>
    [`a${i}`, { kind: "minor", x: 0.5, y: 0.5 }]));
  assert.equal(Object.keys(sanitizeCardAnchors(many)).length, 256);

  // Non-canonical mains fold to the single `main` key; the following mains are dropped.
  assert.deepEqual(sanitizeCardAnchors({
    legacyMain: { kind: "main", x: 0.1, y: 0.1, createdBy: "first" },
    anotherMain: { kind: "main", x: 0.9, y: 0.9, createdBy: "second" },
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" }
  }), {
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" },
    main: { kind: "main", x: 0.5, y: 0, createdBy: "first" }
  });
  // Hostile prototype/path keys never become registry entries.
  const hostile = JSON.parse('{"constructor":{"kind":"minor","x":0.1,"y":0.1},"a.b":{"kind":"minor","x":0.1,"y":0.1},"ok":{"kind":"minor","x":0.1,"y":0.1}}');
  assert.deepEqual(sanitizeCardAnchors(hostile), {
    ok: { kind: "minor", x: 0.1, y: 0.1, createdBy: "" }
  });
});

test("card anchor migration adds a main anchor without losing minors", () => {
  const cards = {
    a: { x: 0, y: 0 },
    b: { x: 0, y: 0, anchors: { main: { kind: "main", x: 0.5, y: 0, createdBy: "u1" } } },
    c: { x: 0, y: 0 },
    d: { x: 0, y: 0 },
    minors: { x: 0, y: 0, anchors: { minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u1" } } }
  };
  const notes = [
    { id: "a", system: { authorId: "u1", attachment: { mainPinEnabled: true } } },
    { id: "b", system: { authorId: "u1", attachment: { mainPinEnabled: true } } },
    { id: "c", system: { authorId: "u2", attachment: { mainPinEnabled: false } } },
    { id: "d", system: { authorId: "u3", deleted: { at: 1, by: "u3" } } },
    { id: "minors", system: { authorId: "u1", attachment: { mainPinEnabled: true } } }
  ];
  assert.deepEqual(migrateCardAnchors(cards, notes), [
    {
      noteId: "a",
      anchors: { main: { kind: "main", x: 0.5, y: 0, createdBy: "u1" } }
    },
    {
      noteId: "minors",
      anchors: {
        minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u1" },
        main: { kind: "main", x: 0.5, y: 0, createdBy: "u1" }
      }
    }
  ]);
  assert.deepEqual(migrateCardAnchors({ a: { anchors: {} } }, notes)[0].noteId, "a");

  // Existing anchors are sanitized too: a canonical main stays, malformed entries disappear.
  const dirty = {
    x: 0, y: 0,
    anchors: {
      main: { kind: "main", x: 0.9, y: 0.9, createdBy: "u5" },
      minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u5" },
      bad: { kind: "other", x: 0.1, y: 0.1 }
    }
  };
  assert.deepEqual(migrateCardAnchors({ dirty }, [
    { id: "dirty", system: { authorId: "u5", attachment: { mainPinEnabled: true } } }
  ]), [{
    noteId: "dirty",
    anchors: {
      main: { kind: "main", x: 0.5, y: 0, createdBy: "u5" },
      minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u5" }
    }
  }]);

  // An existing malformed main is canonicalized even when the note has its main pin disabled.
  assert.deepEqual(migrateCardAnchors({
    c: { x: 0, y: 0, anchors: { main: { kind: "main", x: 0.2, y: 0.8 } } }
  }, [{ id: "c", system: { attachment: { mainPinEnabled: false } } }]), [{
    noteId: "c",
    anchors: { main: { kind: "main", x: 0.5, y: 0, createdBy: "" } }
  }]);

  // One malformed card is skipped without losing the valid cards in the batch.
  assert.deepEqual(
    migrateCardAnchors({ broken: null, alsoBroken: "nope", a: { x: 0, y: 0 } }, notes).map(u => u.noteId),
    ["a"]
  );

  // A Foundry data model may default the attachment block to enabled; stored source data wins.
  const sourced = [{
    id: "e",
    _source: { system: { authorId: "u4", attachment: { mainPinEnabled: false } } },
    system: { authorId: "u4", attachment: { mainPinEnabled: true } }
  }];
  assert.deepEqual(migrateCardAnchors({ e: {} }, sourced), []);
});

test("classifyNote keeps a short unlabelled note compact", () => {
  const result = classifyNote(shortNote("three short words"));
  assert.equal(result.mode, "compact");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.words, 3);
});

test("each qualifying condition promotes a note to extended", () => {
  const label = classifyNote(shortNote("short", { label: "Captain Vex" }));
  assert.equal(label.mode, "extended");
  assert.ok(label.reasons.includes("label"));

  const heading = classifyNote(shortNote("short", { presentation: { heading: "Bounty" } }));
  assert.equal(heading.mode, "extended");
  assert.deepEqual(heading.reasons, ["heading"]);

  const image = classifyNote(shortNote("short", { image: "worlds/test/portrait.webp" }));
  assert.equal(image.mode, "extended");
  assert.deepEqual(image.reasons, ["image"]);

  const forced = classifyNote(shortNote("short", { presentation: { forceExtended: true } }));
  assert.equal(forced.mode, "extended");
  assert.deepEqual(forced.reasons, ["forced"]);

  const words = Array.from({ length: 101 }, (_, i) => `w${i}`);
  const longText = Array.from({ length: Math.ceil(words.length / 10) }, (_, i) =>
    words.slice(i * 10, i * 10 + 10).join(" ")).join("\n");
  const long = classifyNote(shortNote(longText));
  assert.equal(long.mode, "extended");
  assert.deepEqual(long.reasons, ["long"]);

  const table = classifyNote(shortNote("| a | b |\n| --- | --- |\n| 1 | 2 |"));
  assert.equal(table.mode, "extended");
  assert.deepEqual(table.reasons, ["complex"]);
});

test("code, escaped hashes and whitespace-only labels do not promote", () => {
  assert.equal(classifyNote(shortNote("```\n# not a heading\n```")).mode, "extended",
    "a fenced code block is complex structure");
  assert.equal(classifyNote(shortNote("```\n# not a heading\n```")).reasons.includes("markdown-heading"), false);

  const escaped = classifyNote(shortNote("\\# this is not a heading"));
  assert.equal(escaped.mode, "compact");
  assert.deepEqual(escaped.reasons, []);

  const inlineCode = classifyNote(shortNote("`# also not a heading`"));
  assert.equal(inlineCode.mode, "compact");
  assert.deepEqual(inlineCode.reasons, []);

  const blankLabel = classifyNote(shortNote("short", { label: "   " }));
  assert.equal(blankLabel.mode, "compact");
  assert.deepEqual(blankLabel.reasons, []);
});

test("real Markdown headings, including setext, promote", () => {
  const atx = classifyNote(shortNote("# Bounty"));
  assert.equal(atx.mode, "extended");
  assert.deepEqual(atx.reasons, ["markdown-heading"]);

  const setext = classifyNote(shortNote("Bounty\n======"));
  assert.equal(setext.mode, "extended");
  assert.deepEqual(setext.reasons, ["markdown-heading"]);

  assert.equal(analyzeMarkdown("Bounty\n------").headings, 1);
});

test("only viewer-visible blocks influence compact classification", () => {
  const note = shortNote("three short words");
  note.system.blocks.push({ blockId: "hidden", text: "# Hidden\n\n| a | b |\n| --- | --- |", hidden: true });
  const result = classifyNote(note);
  assert.equal(result.mode, "compact", "hidden headings and tables must not change public geometry");
  assert.equal(result.words, 3);

  const hiddenOnly = shortNote("ignored");
  hiddenOnly.system.blocks = [{ blockId: "hidden", text: "# Hidden", hidden: true }];
  assert.equal(classifyNote(hiddenOnly).mode, "compact");
});

test("inline code spans of any backtick length never count as headings", () => {
  for (const text of [
    "text ``# still code`` here",
    "text ```# still code``` here",
    "text `````# still code````` here"
  ]) {
    const result = classifyNote(shortNote(text));
    assert.equal(result.mode, "compact", text);
    assert.equal(result.headings, 0, text);
  }
  assert.equal(analyzeMarkdown("prefix ``a ` b`` suffix").headings, 0);
});

test("all image syntaxes, including references and HTML, promote a note", () => {
  const inline = classifyNote(shortNote("![alt](https://example.com/a.png)"));
  assert.deepEqual(inline.reasons, ["inline-image"]);
  assert.equal(inline.images, 1);

  const reference = classifyNote(shortNote("![alt][portrait]\n\n[portrait]: https://example.com/a.png"));
  assert.deepEqual(reference.reasons, ["inline-image"]);
  assert.equal(reference.images, 1);

  const shortcut = classifyNote(shortNote("![portrait]\n\n[portrait]: /assets/a.png"));
  assert.deepEqual(shortcut.reasons, ["inline-image"]);
  assert.equal(shortcut.images, 1);

  const collapsed = classifyNote(shortNote("![portrait][]\n\n[portrait]: /assets/a.png"));
  assert.deepEqual(collapsed.reasons, ["inline-image"]);

  const html = classifyNote(shortNote('<img src="https://example.com/a.png" alt="">'));
  assert.deepEqual(html.reasons, ["inline-image"]);
  assert.equal(html.images, 1);

  const undefinedShortcut = classifyNote(shortNote("![portrait]"));
  assert.equal(undefinedShortcut.images, 0, "a shortcut image needs a matching reference definition");
});

test("four-space and tab indented code is complex but list continuations are not", () => {
  const indented = classifyNote(shortNote("    # not a heading\n    code sample"));
  assert.equal(indented.mode, "extended");
  assert.deepEqual(indented.reasons, ["complex"]);
  assert.equal(indented.headings, 0);

  const tabbed = classifyNote(shortNote("\tcode sample"));
  assert.deepEqual(tabbed.reasons, ["complex"]);

  const continuation = classifyNote(shortNote("- item\n    continuation text"));
  assert.equal(continuation.mode, "compact", "indented list continuation is ordinary prose");
  assert.deepEqual(continuation.reasons, []);

  const nested = classifyNote(shortNote("- item\n    - nested\n        continuation"));
  assert.equal(nested.mode, "compact");
  assert.deepEqual(nested.reasons, []);
});

test("headings inside blockquotes and HTML headings promote", () => {
  const quote = classifyNote(shortNote("> # Bounty"));
  assert.equal(quote.mode, "extended");
  assert.deepEqual(quote.reasons, ["markdown-heading"]);

  const nestedQuote = classifyNote(shortNote("> > ## Bounty"));
  assert.equal(nestedQuote.mode, "extended");
  assert.deepEqual(nestedQuote.reasons, ["markdown-heading"]);

  const html = classifyNote(shortNote("<h2>Bounty</h2>"));
  assert.equal(html.mode, "extended");
  assert.deepEqual(html.reasons, ["markdown-heading"]);

  const quoteSetext = classifyNote(shortNote("> Bounty\n> ======"));
  assert.equal(quoteSetext.mode, "extended");
  assert.deepEqual(quoteSetext.reasons, ["markdown-heading"]);
});

test("HTML comments and reference definitions stay out of headings and word counts", () => {
  const comment = classifyNote(shortNote("<!-- # not a heading -->\nshort text"));
  assert.equal(comment.mode, "compact");
  assert.deepEqual(comment.reasons, []);
  assert.equal(comment.words, 2);

  const multilineComment = classifyNote(shortNote("<!--\n# not a heading\n-->\nshort"));
  assert.equal(multilineComment.mode, "compact");
  assert.equal(multilineComment.headings, 0);

  const definitions = classifyNote(shortNote("[ref]: https://example.com/very/long/target\nshort text"));
  assert.equal(definitions.mode, "compact");
  assert.equal(definitions.words, 2, "reference definition lines are not prose");
});

test("an empty note stays compact", () => {
  const result = classifyNote(shortNote(""));
  assert.equal(result.mode, "compact");
  assert.deepEqual(result.reasons, []);
  assert.equal(result.words, 0);
  assert.equal(result.headings, 0);
  assert.equal(result.images, 0);
  assert.deepEqual(analyzeMarkdown(""), {
    headings: 0, images: 0, complex: false, words: 0, lines: 0, longestLine: 0, maxUnbroken: 0
  });
});

test("search excerpts fall back to the presentation heading", () => {
  const note = shortNote("visible body", { presentation: { heading: "Bounty" } });
  assert.equal(noteExcerpt(note), "Bounty");
  const labelled = shortNote("visible body", {
    label: "Captain Vex", presentation: { heading: "Bounty" }
  });
  assert.equal(noteExcerpt(labelled), "Captain Vex");
  const noisy = shortNote("<!-- hidden comment --> see https://example.com/secretpath visible");
  assert.equal(noteExcerpt(noisy), "see visible", "excerpts drop comments and raw URLs");
});

test("invisible source lines and reference definitions do not inflate the line budget", () => {
  assert.equal(classifyNote(shortNote(`${"\n".repeat(20)}short text`)).mode, "compact");
  assert.equal(classifyNote(shortNote(`${"\n".repeat(20)}`)).mode, "compact");
  const defs = Array.from({ length: 16 }, (_, index) =>
    `[ref${index}]: https://example.com/${index}`).join("\n");
  assert.equal(classifyNote(shortNote(`${defs}\nshort text`)).mode, "compact");
  assert.equal(classifyNote(shortNote(`<!--\n${"# hidden\n".repeat(16)}-->\nshort`)).mode, "compact");
});

test("indented code, list indentation and paragraph continuation are distinguished", () => {
  assert.equal(classifyNote(shortNote("    # code\n    text")).reasons.includes("complex"), true);
  assert.equal(classifyNote(shortNote("- item\n\n        # list code")).reasons.includes("complex"), true);
  // A four-space continuation of a paragraph is not a code block in Showdown.
  assert.equal(classifyNote(shortNote("text\n    continuation")).mode, "compact");
  // A four-space continuation of a list item is still prose.
  assert.equal(classifyNote(shortNote("- item\n    continuation")).mode, "compact");
});

test("inline code at line start and fenced code in a blockquote are not headings", () => {
  assert.equal(classifyNote(shortNote("`code` # not a heading")).mode, "compact");
  assert.equal(classifyNote(shortNote("> ```\n> # not a heading\n> ```")).headings, 0);
});

test("single-column tables and shortcut reference images promote", () => {
  assert.equal(classifyNote(shortNote("| a |\n| --- |")).mode, "extended");
  const ref = classifyNote(shortNote("![portrait][pic]\n\n[pic]: https://example.com/a.png"));
  assert.equal(ref.mode, "extended");
  assert.deepEqual(ref.reasons, ["inline-image"]);
});

test("generated legacy Target placeholders stay unlabelled", () => {
  for (const name of ["Character name", "Character name 2", "Имя персонажа"]) {
    const patch = migrateNoteSystem({ style: "wanted", targetHeading: "Bounty" }, name);
    assert.equal(patch.label, "", name);
    assert.equal(patch.presentation.nameGenerated, true, name);
    assert.equal(patch.presentation.heading, "Bounty");
  }
  assert.equal(migrateNoteSystem({ style: "wanted" }, "Character names").label, "Character names");
});

test("the Showdown-backed path agrees on headings, images and code", async () => {
  let showdown = null;
  try { showdown = (await import("showdown")).default; } catch { /* bare checkout */ }
  if (!showdown) return;
  const previous = globalThis.showdown;
  globalThis.showdown = showdown;
  try {
    assert.equal(classifyNote(shortNote("```\n# code\n```")).headings, 0);
    assert.equal(classifyNote(shortNote("`code` # not heading")).mode, "compact");
    assert.equal(classifyNote(shortNote("> # Quoted heading")).mode, "extended");
    assert.equal(classifyNote(shortNote("![alt][pic]\n\n[pic]: https://example.com/a.png")).mode, "extended");
    assert.equal(classifyNote(shortNote("<!-- # hidden -->\nshort")).mode, "compact");
    assert.equal(classifyNote(shortNote("| a |\n| --- |")).mode, "extended");
    assert.equal(classifyNote(shortNote("text\n    continuation")).mode, "compact");
  } finally {
    if (previous === undefined) delete globalThis.showdown;
    else globalThis.showdown = previous;
  }
});

function shortNote(text, system = {}) {
  return {
    name: "New Note",
    system: {
      style: "sticky",
      blocks: [{ blockId: "block", text }],
      ...system
    }
  };
}

function pick({ extendedStyle, forceExtended, torn, heading }) {
  return { extendedStyle, forceExtended, torn, heading };
}
