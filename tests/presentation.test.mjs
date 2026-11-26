import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ATTACHMENT, DEFAULT_PRESENTATION, defaultLinkCosmetics, isGeneratedTitle,
  legacyPresentation, legacyStylePresentation, migrateNoteSystem, resolveAttachment,
  resolveLinkCosmetics, resolvePresentation, sanitizeCardAnchors, stripSecretPrefix
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
    "Memo", "Document", "Untitled", "Без названия", "Новая запись 2"
  ]) {
    assert.equal(isGeneratedTitle(name), true, name);
  }
  for (const name of [
    "Tavern", "Captain Vex", "GM-7KQ2 Lord Vex", "Новая таверна", "Memo notes"
  ]) {
    assert.equal(isGeneratedTitle(name), false, name);
  }
  assert.equal(stripSecretPrefix("GM-7KQ2 Lord Vex"), "Lord Vex");
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

function pick({ extendedStyle, forceExtended, torn, heading }) {
  return { extendedStyle, forceExtended, torn, heading };
}
