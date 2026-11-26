import { test } from "node:test";
import assert from "node:assert/strict";

import { isLinkColor, LEGACY_LINK_COLORS, LINK_COLOR_SLOTS, normalizeLinkColor } from "../scripts/link-colors.mjs";
import { sanitizeLinkFields } from "../scripts/socket.mjs";

test("normalizeLinkColor accepts only empty, slots and legacy hexes", () => {
  assert.equal(normalizeLinkColor(""), "");
  assert.equal(normalizeLinkColor("  "), "");

  for (const slot of LINK_COLOR_SLOTS) {
    assert.equal(normalizeLinkColor(slot), slot);
    assert.equal(normalizeLinkColor(` ${slot.toUpperCase()} `), slot);
  }

  for (const [hex, slot] of Object.entries(LEGACY_LINK_COLORS)) {
    assert.equal(normalizeLinkColor(hex), slot);
    assert.equal(normalizeLinkColor(hex.toUpperCase()), slot);
  }

  for (const bad of ["red", "url(https://evil.test/x)", "#123456", "link4", null, undefined, 42, {}]) {
    assert.equal(normalizeLinkColor(bad), "", String(bad));
  }
});

test("isLinkColor distinguishes mapped values from rejected ones", () => {
  assert.equal(isLinkColor(""), true);
  assert.equal(isLinkColor("link3"), true);
  assert.equal(isLinkColor("#D77B91"), true);
  assert.equal(isLinkColor("red"), false);
  assert.equal(isLinkColor("url(x)"), false);
  assert.equal(isLinkColor(7), false);
});

test("socket link sanitizer stores slots and rejects anything else", () => {
  assert.deepEqual(sanitizeLinkFields({ color: "" }), { color: "" });
  assert.deepEqual(sanitizeLinkFields({ color: "link2" }), { color: "link2" });
  assert.deepEqual(sanitizeLinkFields({ color: "#D6A45C" }), { color: "link2" });
  assert.deepEqual(
    sanitizeLinkFields({ problem: "color", color: "link1", label: "ok" }),
    { label: "ok", color: "link1" }
  );

  for (const bad of ["red", "url(https://evil.test/x)", "#123456", "link4", 5, null]) {
    assert.equal(sanitizeLinkFields({ color: bad }), null, String(bad));
  }
  assert.equal(sanitizeLinkFields({ color: undefined }), null);
});
