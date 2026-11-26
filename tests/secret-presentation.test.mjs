import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeclassifiedNote, sanitizeHiddenLinkFields
} from "../scripts/secrets/secret-actions.mjs";

test("hidden-link cosmetics use the shared validation rules", () => {
  const clean = sanitizeHiddenLinkFields({
    id: "not-editable",
    targetId: "not-editable",
    origin: "typed",
    label: "x".repeat(250),
    direction: "three",
    color: "#A393F2",
    lineStyle: "dashed",
    material: "rope",
    thickness: 99,
    slack: -1,
    pattern: "alternating",
    ends: "loose",
    secondaryColor: "#d6a45c",
    sourceAnchorId: "main",
    targetAnchorId: 42,
    routeAnchors: [
      { noteId: "n1", anchorId: "main" },
      { noteId: "n1", anchorId: "main" },
      { noteId: "n2", anchorId: "" },
      null
    ]
  });

  assert.equal(clean.label.length, 200);
  assert.equal(clean.direction, undefined);
  assert.equal(clean.color, "link1", "legacy hex colors become theme slots");
  assert.equal(clean.lineStyle, "dashed");
  assert.equal(clean.material, undefined, "unknown materials are rejected");
  assert.equal(clean.thickness, 5, "thickness is clamped to the supported range");
  assert.equal(clean.slack, 0, "slack is clamped to the supported range");
  assert.equal(clean.pattern, "alternating");
  assert.equal(clean.ends, "loose");
  assert.equal(clean.secondaryColor, "link2");
  assert.equal(clean.sourceAnchorId, undefined, "hidden links never keep shared anchor references");
  assert.equal(clean.targetAnchorId, undefined);
  assert.equal(clean.routeAnchors, undefined, "hidden links never keep shared route waypoints");
  assert.equal(clean.id, undefined, "link identity is never cosmetic-editable");
  assert.equal(clean.targetId, undefined, "link targets are never cosmetic-editable");
  assert.equal(clean.origin, undefined);
});

test("legacy lineStyle and the pattern vocabulary stay in sync", () => {
  const legacy = sanitizeHiddenLinkFields({ lineStyle: "dashed" });
  assert.equal(legacy.lineStyle, "dashed");
  assert.equal(legacy.pattern, "interrupted");

  const modern = sanitizeHiddenLinkFields({ pattern: "alternating" });
  assert.equal(modern.pattern, "alternating");
  assert.equal(modern.lineStyle, "solid");

  const invalid = sanitizeHiddenLinkFields({
    color: "not-a-color", material: "linen", thickness: "3", slack: "0.2", pinMove: { index: 0 }
  });
  assert.deepEqual(invalid, { material: "linen" });

  const badSecondary = sanitizeHiddenLinkFields({ secondaryColor: "not-a-color" });
  assert.deepEqual(badSecondary, { secondaryColor: "" }, "a bad secondary dye degrades to none");
});

test("declassified payload preserves presentation, link ids and fallbacks but clears legacy anchors", () => {
  const note = {
    id: "secret-note-1",
    name: "GM-ABCD Lord Vex",
    kind: "note",
    style: "wanted",
    targetHeading: "Wanted",
    schemaVersion: 1,
    label: "Public label",
    presentation: {
      extendedStyle: "target", forceExtended: true, font: "serif",
      pictureLayout: "left", torn: true, heading: "Wanted", nameGenerated: false
    },
    attachment: {
      mainPinEnabled: false, mainSnapRadius: 18, minorSnapRadius: 3, pinStyle: "wax"
    },
    image: "https://example.com/vex.webp",
    backgroundImage: null,
    formerNames: ["GM-ABCD Old Vex", 42, "x".repeat(250)],
    blocks: [
      { blockId: "block-1", text: "Declassified body", authorId: "gm" }
    ],
    links: [
      {
        id: "link-a", targetId: "shared-a", label: "public thread", direction: "one",
        color: "link2", lineStyle: "dashed",
        sourceSide: "bottom", targetSide: "top",
        sourcePoint: { x: 0.1, y: 0 }, targetPoint: { x: 0.9, y: 1 },
        sourceAnchorId: "main", targetAnchorId: "minor-1",
        routeAnchors: [
          { noteId: "shared-a", anchorId: "main" },
          { noteId: "still-secret", anchorId: "main" },
          { noteId: "secret-note-1", anchorId: "main" }
        ],
        material: "double", thickness: 9, slack: 2,
        pattern: "alternating", ends: "loose", secondaryColor: "link3",
        origin: "drawn", edited: true, createdBy: "gm", hint: false
      },
      {
        id: "link-a", targetId: "shared-b", label: "duplicate id",
        material: "linen", thickness: 2.6, slack: 0.09,
        pattern: "continuous", ends: "standard"
      },
      {
        id: "typed-link", targetId: "shared-a", origin: "typed"
      },
      {
        id: "secret-target", targetId: "still-secret"
      },
      {
        id: "self-link", targetId: "secret-note-1"
      }
    ],
    card: {
      x: 50, y: 60, width: 200, height: 100, rotation: 2,
      ports: ["left"],
      anchors: {
        main: { kind: "main", x: 0.5, y: 0, createdBy: "gm" },
        minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "gm" }
      }
    }
  };

  const payload = buildDeclassifiedNote(note, "Lord Vex the Elder", new Set(["shared-a", "shared-b"]));

  assert.equal(payload.noteId, "secret-note-1");
  assert.equal(payload.title, "Lord Vex the Elder");
  assert.equal(payload.label, "Public label");
  assert.equal(payload.schemaVersion, 1);
  assert.deepEqual(payload.presentation, note.presentation);
  assert.deepEqual(payload.attachment, note.attachment);
  assert.deepEqual(payload.blocks, [{ blockId: "block-1", text: "Declassified body" }]);
  assert.equal(payload.image, note.image);
  assert.equal(payload.backgroundImage, null);

  assert.equal(payload.links.length, 2, "typed, secret-target and self links stay out of the public payload");
  const [first, second] = payload.links;
  assert.equal(first.id, "link-a", "a non-colliding link id is preserved");
  assert.notEqual(second.id, "link-a", "a duplicate id is regenerated");
  assert.ok(first.color);
  assert.equal(first.color, "link2");
  assert.equal(first.lineStyle, "dashed");
  assert.equal(first.pattern, "alternating");
  assert.equal(first.material, "double");
  assert.equal(first.thickness, 5);
  assert.equal(first.slack, 0.25);
  assert.equal(first.ends, "loose");
  assert.equal(first.secondaryColor, "link3");
  assert.equal(first.sourceAnchorId, "",
    "legacy vault anchor ids never become public shared references");
  assert.equal(first.targetAnchorId, "");
  assert.deepEqual(first.routeAnchors, [],
    "legacy route anchors are dropped along with still-secret waypoints");
  assert.deepEqual(first.sourcePoint, { x: 0.1, y: 0 },
    "the point/side fallback keeps the thread where the GM drew it");
  assert.deepEqual(first.pins, undefined);
  assert.deepEqual(payload.formerNames, ["GM-ABCD Old Vex", "x".repeat(200)],
    "former names are bounded strings");

  assert.deepEqual(payload.card.ports, ["left"]);
  assert.deepEqual(payload.card.anchors, note.card.anchors);
  assert.ok(!JSON.stringify(payload).includes(note.name),
    "the current secret title is not part of the public payload");
});
