/**
 * Paper contrast contract for the Stylized Canvas materials. The table border is a translucent
 * ink mix, so it is composited against each paper before measuring; links and task controls use
 * fixed markdown colours. This guards the Phase 3 a11y pass (no low-contrast link slots).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { STYLIZED_MATERIALS } from "../scripts/styles/themes.mjs";

const css = readFileSync(new URL("../styles/stylized.css", import.meta.url), "utf8");
const PAPER_TOKENS = ["compact", "memo", "document", "target"];

function parseHex(hex) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map(char => char + char).join("") : value;
  return [0, 2, 4].map(offset => parseInt(full.slice(offset, offset + 2), 16));
}

function linear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb) {
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** color-mix(in srgb, ink N%, transparent) drawn over an opaque paper. */
function composite(ink, paper, alpha) {
  return ink.map((channel, index) => channel * alpha + paper[index] * (1 - alpha));
}

test("table borders clear ~2.5:1 against every paper token", () => {
  const tableRule = css.match(
    /\.jn-canvas \.jn-card \.jn-card-block-body th,\s*\.jn-canvas \.jn-card \.jn-card-block-body td\s*\{[^}]*\}/
  )?.[0] ?? "";
  const match = tableRule.match(/border:\s*1px solid color-mix\(in srgb, var\(--jn-paper-ink\) (\d+)%, transparent\)/);
  assert.ok(match, "the table border is an ink mix");
  const alpha = Number(match[1]) / 100;
  assert.ok(alpha >= 0.5, `border ink mix is at least 50% (got ${match[1]}%)`);

  const ink = parseHex(STYLIZED_MATERIALS.paper.ink);
  for (const token of PAPER_TOKENS) {
    const paper = parseHex(STYLIZED_MATERIALS.paper[token]);
    const ratio = contrast(composite(ink, paper, alpha), paper);
    assert.ok(ratio >= 2.5, `table border on ${token} paper is ${ratio.toFixed(2)}:1, expected >= 2.5:1`);
  }
});

test("markdown links clear 4.5:1 and task controls clear 3:1 on every paper", () => {
  const link = parseHex(css.match(/\.jn-card-block-body a \{\s*color:\s*(#[0-9a-f]{6})/i)[1]);
  const checkbox = parseHex(css.match(/accent-color:\s*(#[0-9a-f]{6})/i)[1]);

  for (const token of PAPER_TOKENS) {
    const paper = parseHex(STYLIZED_MATERIALS.paper[token]);
    const linkRatio = contrast(link, paper);
    const checkboxRatio = contrast(checkbox, paper);
    assert.ok(linkRatio >= 4.5, `link on ${token} paper is ${linkRatio.toFixed(2)}:1, expected >= 4.5:1`);
    assert.ok(checkboxRatio >= 3, `task control on ${token} paper is ${checkboxRatio.toFixed(2)}:1, expected >= 3:1`);
  }
});
