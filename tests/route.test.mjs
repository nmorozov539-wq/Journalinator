import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ROUTE_ANCHORS, clampRouteIndex, endpointFields, hasBoardPins, hasRouteWaypoints,
  insertRouteWaypoint, removeRouteWaypointsFor, splitLinkPair
} from "../scripts/route-notes.mjs";

const noteA = "NoteA00000000001";
const noteB = "NoteB00000000001";
const noteC = "NoteC00000000001";

test("clampRouteIndex clamps to the array bounds and appends when absent", () => {
  assert.equal(clampRouteIndex(0, 3), 0);
  assert.equal(clampRouteIndex(2, 3), 2);
  assert.equal(clampRouteIndex(3, 3), 3);
  assert.equal(clampRouteIndex(99, 3), 3);
  assert.equal(clampRouteIndex(-4, 3), 0);
  assert.equal(clampRouteIndex(1.9, 3), 1);
  assert.equal(clampRouteIndex(undefined, 3), 3);
  assert.equal(clampRouteIndex("2", 3), 3);
  assert.equal(clampRouteIndex(1, -2), 0);
});

test("insertRouteWaypoint inserts at the clamped index, rejects duplicates and caps at 24", () => {
  const base = [{ noteId: noteA, anchorId: "main" }, { noteId: noteB, anchorId: "main" }];
  const front = insertRouteWaypoint(base, noteC, "main", -10);
  assert.equal(front.ok, true);
  assert.deepEqual(front.routeAnchors.map(entry => entry.noteId), [noteC, noteA, noteB]);
  assert.deepEqual(base.map(entry => entry.noteId), [noteA, noteB], "input is not mutated");

  const middle = insertRouteWaypoint(base, noteC, "main", 1);
  assert.deepEqual(middle.routeAnchors.map(entry => entry.noteId), [noteA, noteC, noteB]);

  const duplicate = insertRouteWaypoint(base, noteA, "main", 0);
  assert.deepEqual(duplicate, { ok: false, reason: "duplicate" });

  const full = Array.from({ length: MAX_ROUTE_ANCHORS }, (_, index) => ({
    noteId: `Note${String(index).padStart(12, "0")}`, anchorId: "main"
  }));
  assert.deepEqual(insertRouteWaypoint(full, noteC, "main", 0), { ok: false, reason: "limit" });
  assert.equal(insertRouteWaypoint([], noteC, "main", 0).routeAnchors.length, 1);
});

test("removeRouteWaypointsFor drops only that note and preserves order and shape", () => {
  const routes = [
    { noteId: noteA, anchorId: "main", extra: "ignored" },
    { noteId: noteB, anchorId: "main" },
    { noteId: noteC, anchorId: "main" }
  ];
  assert.deepEqual(removeRouteWaypointsFor(routes, noteB), [
    { noteId: noteA, anchorId: "main" },
    { noteId: noteC, anchorId: "main" }
  ]);
  assert.deepEqual(removeRouteWaypointsFor(undefined, noteB), []);
  assert.deepEqual(removeRouteWaypointsFor(routes, "missing"), [
    { noteId: noteA, anchorId: "main" },
    { noteId: noteB, anchorId: "main" },
    { noteId: noteC, anchorId: "main" }
  ]);
});

test("hasBoardPins/hasRouteWaypoints distinguish empty defaults from real waypoints", () => {
  assert.equal(hasBoardPins({ pins: [] }), false);
  assert.equal(hasBoardPins({ pins: [{ x: 1, y: 2 }] }), true);
  assert.equal(hasBoardPins({}), false);
  assert.equal(hasRouteWaypoints({ routeAnchors: [] }), false);
  assert.equal(hasRouteWaypoints({ routeAnchors: [{ noteId: noteA, anchorId: "main" }] }), true);
  assert.equal(hasRouteWaypoints({}), false);
});

test("endpointFields copies only a valid anchor/point/side fallback", () => {
  assert.deepEqual(endpointFields({
    sourceAnchorId: "main",
    sourcePoint: { x: 1, y: 0.5 },
    sourceSide: "right"
  }, "source"), {
    sourceAnchorId: "main", sourcePoint: { x: 1, y: 0.5 }, sourceSide: "right"
  });
  assert.deepEqual(endpointFields({
    targetAnchorId: "", targetPoint: { x: 2, y: 0 }, targetSide: "sideways"
  }, "target"), {});
  assert.deepEqual(endpointFields({ targetAnchorId: "minor" }, "target"), { targetAnchorId: "minor" });
  assert.deepEqual(endpointFields(null, "source"), {});
});

test("splitLinkPair copies style, keeps the label first, blanks the second and uses direction none", () => {
  const link = {
    id: "OriginalLink0001",
    targetId: noteB,
    label: "keep me",
    direction: "one",
    material: "double",
    thickness: 4,
    slack: 0.25,
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
    link, noteId: noteC, firstId: "FirstLink000001", secondId: "SecondLink00001",
    senderUserId: "Player0000000001",
    noteFirstEndpoint: { targetAnchorId: "main", targetPoint: { x: 0.5, y: 0 }, targetSide: "top" },
    noteSecondEndpoint: { sourceAnchorId: "main", sourcePoint: { x: 0.5, y: 0 }, sourceSide: "top" }
  });

  for (const item of [first, second]) {
    assert.equal(item.material, "double");
    assert.equal(item.thickness, 4);
    assert.equal(item.slack, 0.25);
    assert.equal(item.pattern, "alternating");
    assert.equal(item.ends, "loose");
    assert.equal(item.color, "link2");
    assert.equal(item.secondaryColor, "link3");
    assert.equal(item.lineStyle, "dashed");
    assert.equal(item.origin, "drawn");
    assert.equal(item.edited, true);
    assert.equal(item.createdBy, "Player0000000001");
    assert.equal(item.direction, "none");
    assert.equal(Object.hasOwn(item, "hint"), false, "the removed hint flag is not copied");
    assert.deepEqual(item.routeAnchors, []);
    assert.equal(item.pins, undefined, "no board pins are copied");
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
  assert.equal(second.label, "");
  assert.equal(second.sourceAnchorId, "main");
  assert.equal(second.sourceSide, "top");
  assert.equal(second.targetAnchorId, "target-pin");
  assert.deepEqual(second.targetPoint, { x: 0, y: 0.5 });
  assert.equal(second.targetSide, "left");
});
