import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ROUTE_ANCHORS, clampRouteIndex, endpointFields, hasBoardPins, hasRouteWaypoints,
  insertRouteWaypoint, removeRouteWaypointsFor, splitLinkPair
} from "../scripts/route-notes.mjs";
import { buildPrivateTransfer, importPrivateTransfer } from "../scripts/private-transfer.mjs";

const noteA = "NoteA00000000001";
const noteB = "NoteB00000000001";
const noteC = "NoteC00000000001";
const noteOutside = "NoteOutside00001";

test("route split copies style/label/endpoints without a hint or hidden field", () => {
  const link = {
    id: "OriginalLink0001",
    targetId: noteB,
    label: "keep me",
    hint: true,
    hidden: true,
    direction: "one",
    material: "double",
    thickness: 4,
    slack: 20,
    pattern: "alternating",
    ends: "loose",
    color: "link2",
    secondaryColor: "link3",
    lineStyle: "dashed",
    sourceAnchorId: "source-pin",
    sourcePoint: { x: 1, y: 0.5 },
    sourceSide: "right",
    targetAnchorId: "target-pin",
    targetPoint: { x: 0, y: 0.5 },
    targetSide: "left",
    pins: [],
    routeAnchors: []
  };
  const { first, second } = splitLinkPair({
    link,
    noteId: noteC,
    firstId: "FirstLink000001",
    secondId: "SecondLink00001",
    senderUserId: "Player0000000001",
    noteFirstEndpoint: { targetAnchorId: "main", targetPoint: { x: 0.5, y: 0 }, targetSide: "top" },
    noteSecondEndpoint: { sourceAnchorId: "main", sourcePoint: { x: 0.5, y: 0 }, sourceSide: "top" }
  });

  for (const item of [first, second]) {
    assert.equal(item.material, "double");
    assert.equal(item.thickness, 4);
    assert.equal(item.slack, 20);
    assert.equal(item.pattern, "alternating");
    assert.equal(item.ends, "loose");
    assert.equal(item.color, "link2");
    assert.equal(item.secondaryColor, "link3");
    assert.equal(item.lineStyle, "dashed");
    assert.equal(item.origin, "drawn");
    assert.equal(item.edited, true);
    assert.equal(item.createdBy, "Player0000000001");
    assert.equal(item.direction, "none", "the split direction policy is unchanged");
    assert.equal(Object.hasOwn(item, "hint"), false, "hint is a removed schema field");
    assert.equal(Object.hasOwn(item, "hidden"), false, "hidden vault markers never travel");
    assert.deepEqual(item.routeAnchors, []);
    assert.equal(item.pins, undefined, "board pins are not copied by the split");
  }

  assert.equal(first.id, "FirstLink000001");
  assert.equal(first.targetId, noteC);
  assert.equal(first.label, "keep me");
  assert.equal(first.sourceAnchorId, "source-pin");
  assert.deepEqual(first.sourcePoint, { x: 1, y: 0.5 });
  assert.equal(first.sourceSide, "right");
  assert.equal(first.targetAnchorId, "main");
  assert.equal(first.targetSide, "top");

  assert.equal(second.id, "SecondLink00001");
  assert.equal(second.targetId, noteB);
  assert.equal(second.label, "", "only the first leg keeps the label");
  assert.equal(second.sourceAnchorId, "main");
  assert.equal(second.sourceSide, "top");
  assert.equal(second.targetAnchorId, "target-pin");
  assert.deepEqual(second.targetPoint, { x: 0, y: 0.5 });
  assert.equal(second.targetSide, "left");
});

test("route insertion, clamping and detach keep their existing semantics", () => {
  assert.equal(clampRouteIndex(1.9, 3), 1);
  assert.equal(clampRouteIndex(99, 3), 3);
  assert.equal(clampRouteIndex(undefined, 3), 3);

  const base = [{ noteId: noteA, anchorId: "main" }, { noteId: noteB, anchorId: "main" }];
  const middle = insertRouteWaypoint(base, noteC, "main", 1);
  assert.deepEqual(middle.routeAnchors.map(entry => entry.noteId), [noteA, noteC, noteB]);
  assert.deepEqual(base.map(entry => entry.noteId), [noteA, noteB], "input is not mutated");
  assert.deepEqual(insertRouteWaypoint(base, noteA), { ok: false, reason: "duplicate" });
  const full = Array.from({ length: MAX_ROUTE_ANCHORS }, (_, index) => ({
    noteId: `Note${String(index).padStart(12, "0")}`, anchorId: "main"
  }));
  assert.deepEqual(insertRouteWaypoint(full, noteC), { ok: false, reason: "limit" });

  const detached = removeRouteWaypointsFor([
    { noteId: noteA, anchorId: "main", legacy: true },
    { noteId: noteB, anchorId: "main" },
    { noteId: noteC, anchorId: "main" }
  ], noteB);
  assert.deepEqual(detached, [
    { noteId: noteA, anchorId: "main" },
    { noteId: noteC, anchorId: "main" }
  ]);
  assert.deepEqual(removeRouteWaypointsFor(undefined, noteB), []);
  assert.equal(hasRouteWaypoints({ routeAnchors: [] }), false);
  assert.equal(hasBoardPins({ pins: [] }), false);
  assert.deepEqual(endpointFields({
    sourceAnchorId: "main", sourcePoint: { x: 1, y: 0.5 }, sourceSide: "right"
  }, "source"), {
    sourceAnchorId: "main", sourcePoint: { x: 1, y: 0.5 }, sourceSide: "right"
  });
});

test("transfer packing/import filters and remaps route waypoints", () => {
  const source = {
    format: 3,
    notes: {
      a: {
        schemaVersion: 2,
        id: "a",
        body: "Alpha",
        revision: 2,
        layout: "plain",
        skin: { paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 1 },
        attachment: { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "default" },
        links: [{
          id: "route-link",
          targetId: "b",
          routeAnchors: [
            { noteId: "b", anchorId: "main" },
            { noteId: "outside", anchorId: "main" }
          ]
        }],
        authorId: "SenderRoute00001",
        createdAt: 1,
        updatedAt: 2
      },
      b: {
        schemaVersion: 2,
        id: "b",
        body: "Beta",
        revision: 0,
        layout: "plain",
        skin: { paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 2 },
        attachment: { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "default" },
        links: [],
        authorId: "SenderRoute00001",
        createdAt: 1,
        updatedAt: 2
      },
      outside: {
        schemaVersion: 2,
        id: "outside",
        body: "Outside",
        revision: 0,
        layout: "plain",
        skin: { paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 3 },
        attachment: { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "default" },
        links: [],
        authorId: "SenderRoute00001",
        createdAt: 1,
        updatedAt: 2
      }
    },
    layout: {
      cards: {
        a: { x: 0, y: 0, sizing: { mode: "manual", width: 220, minHeight: 120 }, autoSizeOrigin: { x: 110, y: 0 }, rotation: 0, ports: ["right"], anchors: {} },
        b: { x: 300, y: 0, sizing: { mode: "manual", width: 220, minHeight: 120 }, autoSizeOrigin: { x: 410, y: 0 }, rotation: 0, ports: ["right"], anchors: {} }
      },
      labels: {},
      pins: {},
      pinLinks: {},
      viewport: null
    },
    trash: [],
    history: {}
  };
  const packed = buildPrivateTransfer(source, ["a", "b"], {
    fromUserId: "SenderRoute00001", toUserId: "RecipientRoute01"
  });
  assert.equal(packed.summary.droppedWaypoints, 1);
  const imported = importPrivateTransfer({
    format: 3,
    notes: {},
    layout: { cards: {}, labels: {}, pins: {}, pinLinks: {}, viewport: null },
    trash: [],
    history: {}
  }, packed, "RecipientRoute01");
  assert.equal(imported.droppedWaypoints, 1);
  const importedA = imported.workspace.notes[imported.imported[0]];
  const importedB = imported.workspace.notes[imported.imported[1]];
  assert.deepEqual(importedA.links[0].routeAnchors, [
    { noteId: importedB.id, anchorId: "main" }
  ], "only the selected waypoint survives and it points at the remapped note");
  assert.notEqual(importedA.links[0].routeAnchors[0].noteId, noteOutside);
});
