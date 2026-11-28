import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPenPreset, builtInPresets, defaultPenStyle, findPenPreset, MAX_PEN_PRESETS, normalizePen,
  normalizePenStyle, PEN_STYLE_KEYS, removePenPreset, sameStyle, savePenPreset, updatePenStyle,
  wheelAdjust, wheelSteps
} from "../scripts/link-pen.mjs";
import { edgePanVelocity, EDGE_PAN } from "../scripts/edge-pan.mjs";
import { resolveLinkCosmetics } from "../scripts/presentation.mjs";
import { threadClasses, threadStrokes } from "../scripts/thread-render.mjs";

const rect = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };

test("a pen coerces corrupt data into a complete valid style and never throws", () => {
  assert.deepEqual(normalizePen(undefined).current, defaultPenStyle());
  assert.deepEqual(normalizePen("junk"), { current: defaultPenStyle(), presets: [] });
  const style = normalizePenStyle({
    material: "__proto__", thickness: 99, slack: -4, pattern: "zigzag", ends: 7,
    color: "#ff00ff", secondaryColor: { evil: true }
  });
  assert.equal(style.material, "linen");
  assert.equal(style.thickness, 5);
  assert.equal(style.slack, 0);
  assert.equal(style.pattern, "continuous");
  assert.equal(style.ends, "standard");
  assert.ok(["", "link1", "link2", "link3"].includes(style.color));
  assert.equal(style.secondaryColor, "");
  assert.deepEqual(Object.keys(style).sort(), [...PEN_STYLE_KEYS].sort(), "no stray fields survive");
});

test("saved presets are named, unique, capped and cannot shadow a built-in", () => {
  let pen = normalizePen(null);
  pen = savePenPreset(pen, "  Red   rope  ", { ...pen.current, color: "link2", thickness: 3.3 });
  assert.deepEqual(pen.presets.map(preset => preset.name), ["Red rope"]);
  const id = pen.presets[0].id;
  pen = savePenPreset(pen, "red ROPE", { ...pen.current, thickness: 4.4 });
  assert.equal(pen.presets.length, 1, "same name (any case) replaces instead of duplicating");
  assert.equal(pen.presets[0].id, id);
  assert.equal(pen.presets[0].style.thickness, 4.4);
  assert.equal(savePenPreset(pen, "   ").presets.length, 1, "an empty name saves nothing");
  const hostile = normalizePen({ presets: [
    { id: "heavy", name: "Fake built-in", style: {} }, { id: "x", name: "" },
    { id: "ok", name: "x".repeat(200), style: { thickness: 2 } }, { id: "ok", name: "dup" }
  ] });
  assert.deepEqual(hostile.presets.map(preset => preset.id), ["ok"]);
  assert.equal(hostile.presets[0].name.length, 40);
  let many = normalizePen(null);
  for (let i = 0; i < MAX_PEN_PRESETS + 5; i++) many = savePenPreset(many, `p${i}`);
  assert.equal(many.presets.length, MAX_PEN_PRESETS);
  assert.equal(removePenPreset(pen, id).presets.length, 0);
});

test("a built-in preset keeps the player's dyes; a saved preset restores its own", () => {
  let pen = updatePenStyle(normalizePen(null), { color: "link3", secondaryColor: "link1", pattern: "interrupted" });
  const heavy = applyPenPreset(pen, "heavy").current;
  assert.deepEqual([heavy.material, heavy.thickness, heavy.slack], ["double", 4, 0.19]);
  assert.deepEqual([heavy.color, heavy.secondaryColor], ["link3", "link1"]);
  assert.equal(heavy.pattern, "continuous", "built-ins reset pattern and ends to neutral, as before");
  pen = savePenPreset(pen, "Mine");
  const mine = pen.presets[0];
  const other = updatePenStyle(pen, { color: "", thickness: 1, pattern: "continuous" });
  const restored = applyPenPreset(other, mine.id).current;
  assert.equal(restored.color, "link3");
  assert.equal(restored.pattern, "interrupted");
  assert.equal(findPenPreset(pen, "nope"), null);
  assert.equal(builtInPresets().length, 4);
  assert.ok(sameStyle(restored, mine.style));
});

test("wheel adjusts thickness by 0.2 px and hang by 1%, clamped and rounded", () => {
  const base = defaultPenStyle();
  assert.deepEqual(wheelAdjust(base, { steps: 1 }), { thickness: 2.8 });
  assert.deepEqual(wheelAdjust(base, { steps: -3 }), { thickness: 2 });
  assert.deepEqual(wheelAdjust({ ...base, thickness: 4.9 }, { steps: 5 }), { thickness: 5 });
  assert.deepEqual(wheelAdjust({ ...base, thickness: 0.9 }, { steps: -5 }), { thickness: 0.8 });
  assert.deepEqual(wheelAdjust(base, { alt: true, steps: 2 }), { slack: 0.11 });
  assert.deepEqual(wheelAdjust({ ...base, slack: 0.24 }, { alt: true, steps: 9 }), { slack: 0.25 });
  assert.deepEqual(wheelAdjust({ ...base, slack: 0.02 }, { alt: true, steps: -9 }), { slack: 0 });
  assert.equal(wheelSteps({ deltaY: -120 }), 1, "scroll up thickens");
  assert.equal(wheelSteps({ deltaY: 100 }), -1);
  assert.equal(wheelSteps({ deltaY: 0 }), 0);
  assert.equal(wheelSteps({ deltaY: -450 }), 5, "a fast trackpad flick is several notches");
});

test("edge pan is still in the middle, flies at the edge and moves opposite the pointer", () => {
  assert.deepEqual(edgePanVelocity(500, 400, rect), { x: 0, y: 0 });
  assert.deepEqual(edgePanVelocity(0, 0, rect).x, EDGE_PAN.maxSpeed);
  const right = edgePanVelocity(1000, 400, rect);
  assert.equal(right.x, -EDGE_PAN.maxSpeed, "pointer at the right edge pulls the world left");
  assert.equal(right.y, 0);
  assert.equal(edgePanVelocity(500, 800, rect).y, -EDGE_PAN.maxSpeed);
  assert.equal(edgePanVelocity(500, 0, rect).y, EDGE_PAN.maxSpeed);
  const gentle = Math.abs(edgePanVelocity(1000 - 20, 400, rect).x);
  const fast = Math.abs(edgePanVelocity(1000 - 4, 400, rect).x);
  assert.ok(gentle > 0 && gentle < fast, "speed ramps up toward the edge");
  assert.equal(edgePanVelocity(1500, 400, rect).x, -EDGE_PAN.maxSpeed, "a captured drag beyond the rect counts as at the edge");
  assert.deepEqual(edgePanVelocity(10, 10, { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }), { x: 0, y: 0 });
  const tiny = { left: 0, top: 0, right: 60, bottom: 60, width: 60, height: 60 };
  assert.deepEqual(edgePanVelocity(30, 30, tiny), { x: 0, y: 0 }, "a tiny board keeps a still center");
});

test("the shared renderer gives every link the same cosmetics and hides patterns on hidden links", () => {
  const cosmetics = resolveLinkCosmetics({ material: "double", pattern: "alternating", ends: "loose", secondaryColor: "link2" });
  const classes = threadClasses({ color: "link1", cosmetics });
  for (const expected of ["jn-link-color-link1", "jn-link-accent-link2", "jn-link-material-double",
    "jn-link-pattern-alternating", "jn-link-ends-loose"]) assert.ok(classes.split(" ").includes(expected), expected);
  assert.ok(threadClasses({ color: "", cosmetics, hidden: true }).includes("jn-link-pattern-continuous"));
  const endpoints = { start: { x: 0, y: 0, nx: 1, ny: 0 }, end: { x: 100, y: 0, nx: -1, ny: 0 } };
  const markup = threadStrokes({ d: "M0 0 Q50 20 100 0", cosmetics, ...endpoints });
  assert.equal((markup.match(/jn-link-stack /g) ?? []).length, 2, "primary + accent stack");
  assert.equal((markup.match(/jn-thread-layer/g) ?? []).length, 12);
  assert.equal((markup.match(/<path class="jn-thread-tail/g) ?? []).length, 4, "two stacked tails at each end");
  const plain = threadStrokes({ d: "M0 0 Q50 20 100 0", cosmetics: resolveLinkCosmetics({}), ...endpoints });
  assert.equal((plain.match(/<path class="jn-thread-tail/g) ?? []).length, 0);
  assert.equal((plain.match(/jn-link-stack /g) ?? []).length, 1);
});
