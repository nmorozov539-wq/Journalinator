import { test } from "node:test";
import assert from "node:assert/strict";

import { tearPoints, tearPolygon, tearSeed } from "../scripts/tear.mjs";

const POINT = /^(\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/;

/** Parses the generated CSS polygon into numeric percentage points for geometric checks. */
function parsePolygon(polygon) {
  assert.equal(typeof polygon, "string");
  assert.ok(polygon.startsWith("polygon("), "polygon CSS function");
  assert.ok(polygon.endsWith(")"), "closed CSS polygon function");
  const body = polygon.slice("polygon(".length, -1).trim();
  assert.ok(body.length > 0, "polygon has points");
  const points = body.split(",").map(part => {
    const text = part.trim();
    const match = POINT.exec(text);
    assert.ok(match, `valid percentage point: ${text}`);
    return { x: Number(match[1]), y: Number(match[2]) };
  });
  assert.ok(points.length >= 4, "a usable silhouette needs at least four points");
  for (const { x, y } of points) {
    assert.ok(x >= 0 && x <= 100, `x in range: ${x}`);
    assert.ok(y >= 0 && y <= 100, `y in range: ${y}`);
  }
  return points;
}

test("tearPolygon is deterministic for one stable note id", () => {
  for (const id of ["note-0001", "AbCdEf123456", "капля-бумаги-1"]) {
    const first = tearPolygon(id);
    const second = tearPolygon(id);
    assert.equal(first, second);
    assert.equal(JSON.stringify(parsePolygon(first)), JSON.stringify(parsePolygon(second)));
  }
});

test("different note ids produce different torn edges", () => {
  const ids = ["note-a", "note-b", "note-c", "note-d", "note-e", "note-f"];
  const polygons = ids.map(id => tearPolygon(id));
  assert.equal(new Set(polygons).size, ids.length, "ids must not share a silhouette");
});

test("the top edge stays straight for the pin/attachment edge", () => {
  for (const id of ["pinned-1", "pinned-2", "pinned-3", "torn-target", "torn-memo"]) {
    const points = parsePolygon(tearPolygon(id));
    assert.deepEqual(points[0], { x: 0, y: 0 }, "top-left corner is square");
    assert.deepEqual(points[1], { x: 100, y: 0 }, "top-right corner is square");
    const topEdge = points.filter(point => point.y === 0);
    assert.equal(topEdge.length, 2, "no additional points break the top edge");
  }
});

test("tear silhouettes are bounded, non-degenerate polygons", () => {
  for (const id of ["one", "two", "three", "four"]) {
    const points = parsePolygon(tearPolygon(id));
    assert.ok(points.some(point => point.x >= 99), "reaches the right edge");
    assert.ok(points.some(point => point.x <= 1), "reaches the left edge");
    assert.ok(points.some(point => point.y >= 99), "reaches the bottom edge");
    assert.ok(points.filter(point => point.x < 100 && point.y > 0).length > 4,
      "both sides carry torn detail");
  }
});

test("tearSeed is stable and bounded for the same id", () => {
  for (const id of ["seed-a", "seed-b", "seed-стабильный"]) {
    const first = tearSeed(id);
    assert.equal(first, tearSeed(id));
    assert.ok(Number.isInteger(first));
    assert.ok(first >= 0 && first < 100000);
  }
});

test("tearPoints exposes the same silhouette the CSS polygon clips", () => {
  for (const id of ["shared-shape-1", "shared-shape-2", "общая-форма"]) {
    const points = tearPoints(id);
    const parsed = parsePolygon(tearPolygon(id));
    assert.equal(points.length, parsed.length, "one point per polygon vertex");
    assert.deepEqual(
      points.map(point => ({ x: Number(point.x.toFixed(2)), y: Number(point.y.toFixed(2)) })),
      parsed,
      "the mask helper and clip-path cannot drift"
    );
    for (const { x, y } of points) {
      assert.ok(Number.isFinite(x) && x >= 0 && x <= 100);
      assert.ok(Number.isFinite(y) && y >= 0 && y <= 100);
    }
    assert.deepEqual(points[0], { x: 0, y: 0 });
    assert.deepEqual(points[1], { x: 100, y: 0 });
    assert.equal(points.filter(point => point.y === 0).length, 2, "straight pin edge");
    assert.deepEqual(tearPoints(id), points, "stable and reusable across renders");
  }
});
