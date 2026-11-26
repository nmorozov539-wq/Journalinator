import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arrowHead, clampThreadSlack, clampThreadThickness, DEFAULT_THREAD_PRESET, looseTails, pinnedThreadPath,
  ThreadMotion, threadLayerSpecs, threadPath, THREAD_PRESETS, THREAD_SLACK, THREAD_THICKNESS
} from "../scripts/link-thread.mjs";

const start = { x: 150, y: 90, nx: 1, ny: 0 };
const end = { x: 490, y: 90, nx: -1, ny: 0 };
const close = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≈ ${expected}`);
};

test("approved thread presets carry exact material, thickness and slack", () => {
  assert.deepEqual(THREAD_PRESETS, {
    fine: { material: "linen", thickness: 1.3, slack: 0.02 },
    standard: { material: "linen", thickness: 2.6, slack: 0.09 },
    double: { material: "double", thickness: 2.8, slack: 0.12 },
    heavy: { material: "double", thickness: 4, slack: 0.19 }
  });
  assert.deepEqual(THREAD_PRESETS.standard, {
    material: "linen", thickness: THREAD_THICKNESS.initial, slack: THREAD_SLACK.initial
  });
  assert.equal(THREAD_PRESETS.Standard, THREAD_PRESETS.standard, "display-name aliases stay compatible");
  assert.equal(DEFAULT_THREAD_PRESET, THREAD_PRESETS.standard);
});

test("thickness clamps to 0.8–5 px and slack to 0–25% of the horizontal span", () => {
  assert.equal(clampThreadThickness(0), 0.8);
  assert.equal(clampThreadThickness(99), 5);
  assert.equal(clampThreadThickness("wide"), 2.6);
  assert.equal(clampThreadThickness(2.25), 2.25);
  assert.equal(clampThreadSlack(-1), 0);
  assert.equal(clampThreadSlack(2), 0.25);
  assert.equal(clampThreadSlack("loose"), 0.09);
  assert.equal(clampThreadSlack(0.19), 0.19);
});

test("default slack produces 9% sag, capped at 100 px, and a vertical thread hangs straight", () => {
  const short = threadPath({ ...start, x: 0 }, { ...end, x: 100 });
  close(short.center.y, 90 + 9);
  const long = threadPath({ ...start, x: 0 }, { ...end, x: 2000 });
  close(long.center.y, 90 + 100);
  const vertical = threadPath(
    { x: 150, y: 90, nx: 0, ny: 1 },
    { x: 150, y: 300, nx: 0, ny: -1 }
  );
  assert.deepEqual(vertical.center, { x: 150, y: 195 });
});

test("a custom slack changes only the rest sag and keeps endpoints fixed", () => {
  const taut = threadPath(start, end, undefined, 0.02);
  const loose = threadPath(start, end, undefined, 0.25);
  close(taut.center.y, 90 + 340 * 0.02);
  close(loose.center.y, 90 + 340 * 0.25);
  assert.match(taut.path, /^M150 90 C/);
  assert.match(taut.path, / 490 90$/);
  assert.match(loose.path, / 490 90$/);
  assert.doesNotMatch(loose.path, /\sL/);
});

test("moving a socket pulls the thread, which settles while its endpoints stay fixed", () => {
  const motion = new ThreadMotion(start, end, 0.09);
  const moved = { ...end, x: 550, y: 135 };
  motion.retarget(start, moved, true, 0.09);
  const active = threadPath(start, moved, motion);
  const resting = threadPath(start, moved);
  assert.ok(motion.moving);
  assert.notDeepEqual(active.center, resting.center);
  for (let i = 0; i < 150 && motion.moving; i++) motion.step(1 / 60);
  assert.equal(motion.moving, false);
  assert.equal(threadPath(start, moved, motion).path, resting.path);
  assert.match(active.path, /^M150 90 /);
  assert.match(active.path, / 550 135$/);
  motion.retarget(start, end, false);
  assert.equal(motion.moving, false);
});

test("pinned segments share fixed endpoints and keep their own sag", () => {
  const pin = { x: 320, y: 210 };
  const pinned = pinnedThreadPath(start, end, [pin], undefined, 0.09);
  assert.equal((pinned.path.match(/M/g) ?? []).length, 2, "one curve per route segment");
  assert.match(pinned.path, /^M150 90 /);
  assert.match(pinned.path, / 490 90$/);
  assert.match(pinned.path, / M320 210 /, "the second segment starts on the fixed board pin");
  const vertical = pinnedThreadPath(
    { x: 150, y: 90, nx: 0, ny: 1 },
    { x: 150, y: 390, nx: 0, ny: -1 },
    [pin]
  );
  assert.ok(vertical.path.includes("M320 210 "), "routed segments stay connected");
});

test("L3 and L6 layer recipes match the configurator widths, offsets and opacities", () => {
  const linen = threadLayerSpecs("linen", 2.6);
  assert.equal(linen.k, 2.6 / 3.4);
  assert.deepEqual(linen.layers.map(layer => layer.role),
    ["shadow", "dark", "core", "highlight", "fine"]);
  assert.deepEqual(linen.layers.map(layer => layer.widthFactor), [4.3, 3.4, 2.55, 1, 0.38]);
  assert.deepEqual(linen.layers.map(layer => layer.opacity), [0.5, 1, 1, 0.74, 0.7]);
  close(linen.layers[0].offset.x, 0.7 * 2.6 / 3.4);
  close(linen.layers[0].offset.y, 1.5 * 2.6 / 3.4);
  close(linen.layers[3].offset.y, -0.65 * 2.6 / 3.4);
  close(linen.layers[0].width, 4.3 * 2.6 / 3.4);

  const doubled = threadLayerSpecs("double", 2.8);
  assert.equal(doubled.k, 2.8 / 3.9);
  assert.deepEqual(doubled.layers.map(layer => layer.role),
    ["shadow", "dark", "strandA", "strandB", "highlightA", "highlightB"]);
  assert.deepEqual(doubled.layers.map(layer => layer.widthFactor), [4.9, 3.9, 1.55, 1.55, 0.8, 0.65]);
  assert.deepEqual(doubled.layers.map(layer => layer.opacity), [0.55, 1, 1, 0.94, 0.65, 0.45]);
  assert.deepEqual(doubled.layers[4].dash, [1.5, 2]);
  assert.equal(doubled.layers[5].dashOffset, 1.75);
  close(doubled.layers[2].offset.y, -0.65 * 2.8 / 3.9);
  close(doubled.layers[3].offset.y, 0.65 * 2.8 / 3.9);
  assert.equal(threadLayerSpecs("rope", 2.6).material, "linen", "unknown material degrades safely");
});

test("loose ends produce two stacked tails at each fixed anchor", () => {
  const tails = looseTails(start, end);
  assert.equal(tails.length, 4);
  assert.deepEqual(tails.map(tail => tail.role), ["tail", "tailFine", "tail", "tailFine"]);
  for (const tail of tails) assert.match(tail.d, /^M(150 90|490 90) q/);
  assert.notEqual(tails[0].d, tails[1].d, "the second tail is a smaller stack");
});

test("arrowHead stays exported for compatibility even though the canvas never renders it", () => {
  const thread = threadPath(start, end);
  const [tip, base] = arrowHead(end, thread.lead).split(" ");
  assert.equal(tip, "490,90");
  assert.ok(Number(tip.split(",")[0]) > Number(base.split(",")[0]));
});

test("short links stay curved instead of turning into a straight lead near the target", () => {
  const near = threadPath(start, { x: 190, y: 90, nx: -1, ny: 0 });
  assert.doesNotMatch(near.path, /\sL/);
  assert.match(near.path, / C/);
  assert.notEqual(near.center.y, 90);
});
