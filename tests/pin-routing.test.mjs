import { test } from "node:test";
import assert from "node:assert/strict";
import { threadPath } from "../scripts/link-thread.mjs";
import { anchorWorld } from "../scripts/anchors.mjs";
import { resolvePin } from "../scripts/board-pins.mjs";

const box = { x: 100, y: 100, w: 200, h: 100, rotation: 0 };
const top = anchorWorld(box, { kind: "main", x: 0.5, y: 0 });

test("threads approach a top pin from every direction without an outward hook", () => {
  for (const source of [
    { x: 200, y: 300 }, { x: 20, y: 100 }, { x: 380, y: 100 }, { x: 200, y: 0 }
  ]) {
    const { path } = threadPath({ ...source, nx: 0, ny: 0 }, top, null, 0);
    const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
    const lastControl = { x: numbers.at(-4), y: numbers.at(-3) };
    const toward = { x: source.x - top.x, y: source.y - top.y };
    const control = { x: lastControl.x - top.x, y: lastControl.y - top.y };
    assert.ok(control.x * toward.x + control.y * toward.y > 0,
      `end tangent approaches from the source side: ${path}`);
  }
});

test("a note-owned pin retains its interior position and follows its note", () => {
  const layout = { cards: {}, pins: { p1: { noteId: "n1", x: 0.3, y: 0.7 } } };
  const a = resolvePin("p:p1", layout, new Map([["n1", box]]));
  const moved = resolvePin("p:p1", layout, new Map([["n1", { ...box, x: 150, y: 130 }]]));
  assert.deepEqual([a.x, a.y], [160, 170]);
  assert.deepEqual([moved.x, moved.y], [210, 200]);
});
