import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDocument } from "../scripts/document/parse.mjs";
import {
  AUTO_MIN_HEIGHT,
  AUTO_WIDTH_STEPS,
  autoSizeCacheKey,
  autoSizing,
  clampManualSizing,
  clampSizingMinHeight,
  clampSizingWidth,
  computeAutoSize,
  measureIntrinsic,
  validateManualSizing
} from "../scripts/sizing/measure.mjs";

/**
 * Deterministic test measurement. Every glyph is 8 px; height grows with wrapped source
 * lines. It exercises the pure sizing contract without requiring fonts or a real layout.
 */
function stubMeasure({ kind, text, parsed, width }) {
  if (kind === "text") return String(text ?? "").length * 8;
  if (kind === "height") {
    const inner = Math.max(60, Number(width) - 40);
    let lines = 0;
    for (const line of String(parsed?.body ?? "").split("\n")) {
      lines += Math.max(1, Math.ceil((line.length * 8) / inner));
    }
    return 40 + lines * 24;
  }
  return null;
}

function size(body, { layout = "plain", measure = stubMeasure, availableWidth, skin } = {}) {
  const parsed = parseDocument(body, { selectedLayout: layout });
  return computeAutoSize({
    parsed,
    layout: parsed.effectiveLayout,
    measure,
    availableWidth,
    skin: skin ?? { paper: "cream", font: "default", torn: false, backgroundImage: null, tiltSeed: 0 }
  });
}

function intrinsic(body, options = {}) {
  const parsed = parseDocument(body, { selectedLayout: options.layout ?? "plain" });
  return measureIntrinsic({
    parsed,
    layout: parsed.effectiveLayout,
    measure: options.measure ?? stubMeasure,
    availableWidth: options.availableWidth
  });
}

test("automatic width steps come from the layout registry", () => {
  assert.deepEqual(AUTO_WIDTH_STEPS.plain, [220, 300, 380]);
  assert.deepEqual(AUTO_WIDTH_STEPS.profile, [300, 380]);
});

test("Plain chooses the smallest step that fits the longest unbreakable run", () => {
  assert.equal(intrinsic("# Hi\n\nshort prose"), 220);
  assert.equal(intrinsic("# Hi\n\n" + "x".repeat(20)), 220);
  assert.equal(intrinsic("# Hi\n\n" + "x".repeat(30)), 300);
  assert.equal(intrinsic("# Hi\n\n" + "x".repeat(40)), 380);
  assert.equal(intrinsic("# Hi\n\n" + "https://example.com/a/very/long/path/that/keeps/going"), 380);
});

test("long prose wraps at 220 instead of measuring the full paragraph width", () => {
  const prose = "word ".repeat(120).trim();
  assert.equal(intrinsic(`# Title\n\n${prose}`), 220);
  assert.equal(size(`# Title\n\n${prose}`).width, 220);
});

test("Profile starts at 300 and caps at 380", () => {
  const short = "# Ada\n\n![](https://example.test/a.png)";
  assert.equal(size(short, { layout: "profile" }).width, 300);
  const long = `# ${"W".repeat(60)}\n\n![](https://example.test/a.png)`;
  assert.equal(size(long, { layout: "profile" }).width, 380);
});

test("an invalid selected Profile measures with the rendered Plain steps", () => {
  const parsed = parseDocument("# Only a title", { selectedLayout: "profile" });
  assert.equal(parsed.effectiveLayout, "plain");
  assert.equal(measureIntrinsic({ parsed, layout: parsed.effectiveLayout, measure: stubMeasure }), 220);
});

test("images alone require at least the 300 step", () => {
  const imageMeasure = payload => payload.kind === "image" ? 10 : stubMeasure(payload);
  assert.equal(intrinsic("![](https://example.test/tiny.png)", { measure: imageMeasure }), 300);
  assert.equal(size("![](https://example.test/tiny.png)", { measure: imageMeasure }).width, 300);
});

test("tables and code blocks contribute a fixed-content minimum", () => {
  assert.equal(intrinsic("| a | b |\n|---|---|\n| 1 | 2 |"), 300);
  assert.equal(intrinsic("```\nshort\n```"), 300);
  assert.equal(intrinsic("    indented code\n"), 300);
});

test("long URLs and unbroken table cells cap at 380", () => {
  assert.equal(intrinsic("| " + "y".repeat(80) + " |\n|---|"), 380);
  assert.equal(size("| " + "y".repeat(80) + " |\n|---|").width, 380);
});

test("height is measured at the chosen width with a 120 minimum", () => {
  const short = size("tiny");
  assert.equal(short.width, 220);
  assert.equal(short.height, AUTO_MIN_HEIGHT);

  const long = size(Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n\n"));
  assert.ok(long.height > AUTO_MIN_HEIGHT, "tall content grows vertically");
});

test("explicit line breaks increase height without changing width", () => {
  const sameText = size("alpha beta gamma delta");
  const broken = size("alpha\n\nbeta\n\ngamma\n\ndelta");
  assert.equal(broken.width, sameText.width);
  assert.ok(broken.height > sameText.height, `${broken.height} > ${sameText.height}`);
});

test("a narrower available width caps the step without clipping the card", () => {
  const body = "# T\n\n" + "z".repeat(60);
  const full = size(body);
  const narrow = size(body, { availableWidth: 300 });
  assert.equal(full.width, 380);
  assert.equal(narrow.width, 300);
  assert.ok(narrow.height >= AUTO_MIN_HEIGHT);
});

test("the same document/layout/skin/font/image generation is deterministic", () => {
  const body = "# Ada\n\nA paragraph with ![](https://example.test/a.png) and text.";
  const first = size(body, { layout: "profile" });
  const second = size(body, { layout: "profile" });
  assert.deepEqual(first, second);
  const parsed = parseDocument(body, { selectedLayout: "profile" });
  const keyArgs = {
    parsed, layout: parsed.effectiveLayout, skin: { paper: "parchment", font: "serif" },
    availableWidth: 900, fontVersion: 2, imageVersion: 3
  };
  assert.equal(autoSizeCacheKey(keyArgs), autoSizeCacheKey({ ...keyArgs }));
  assert.notEqual(autoSizeCacheKey(keyArgs), autoSizeCacheKey({ ...keyArgs, fontVersion: 3 }));
  assert.notEqual(autoSizeCacheKey(keyArgs), autoSizeCacheKey({ ...keyArgs, imageVersion: 4 }));
});

test("manual sizing validates and clamps the documented ranges", () => {
  assert.equal(validateManualSizing({ width: 160, minHeight: 80 }), true);
  assert.equal(validateManualSizing({ width: 800, minHeight: 1600 }), true);
  assert.equal(validateManualSizing({ width: 159, minHeight: 200 }), false);
  assert.equal(validateManualSizing({ width: 801, minHeight: 200 }), false);
  assert.equal(validateManualSizing({ width: 320, minHeight: 79 }), false);
  assert.equal(validateManualSizing({ width: 320, minHeight: 1601 }), false);

  assert.equal(clampSizingWidth(159), 160);
  assert.equal(clampSizingWidth(801), 800);
  assert.equal(clampSizingMinHeight(79), 80);
  assert.equal(clampSizingMinHeight(1601), 1600);
  assert.deepEqual(clampManualSizing({ width: 159, minHeight: 79 }),
    { mode: "manual", width: 160, minHeight: 80 });
  assert.deepEqual(clampManualSizing({ width: 900, minHeight: 2000 }),
    { mode: "manual", width: 800, minHeight: 1600 });
  assert.equal(clampManualSizing({ width: Number.NaN, minHeight: 200 }), null);
});

test("automatic sizing clears every manual override", () => {
  assert.deepEqual(autoSizing(), { mode: "auto", width: null, minHeight: null });
  assert.deepEqual(autoSizing(), autoSizing());
  assert.equal(autoSizing().width, null);
  assert.equal(autoSizing().minHeight, null);
});
