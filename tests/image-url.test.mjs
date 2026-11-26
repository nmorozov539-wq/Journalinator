import { test } from "node:test";
import assert from "node:assert/strict";

import { noteImagePath, noteImageSource, noteImageUrl } from "../scripts/image-url.mjs";

test("external http(s) image links are accepted and normalized", () => {
  assert.equal(noteImagePath("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(noteImagePath("  HTTP://Example.COM/a b.png  "), "http://example.com/a%20b.png");
  assert.equal(noteImagePath("https://user:pass@example.com/a.png"), null);
});

test("Foundry data paths are accepted as note image values", () => {
  for (const path of [
    "worlds/my-world/portrait.webp",
    "modules/fvtt-journalinator/assets/stamps/skull.png",
    "systems/pf2e/icons/mystery.webp",
    "assets/cork.jpg",
    "uploads/2026/06/photo 1.png"
  ]) {
    assert.equal(noteImagePath(path), path, path);
    assert.equal(noteImageSource(path), path, path);
  }
});

test("unsafe or ambiguous values are rejected", () => {
  for (const value of [
    "javascript:alert(1)",
    "//evil.test/a.png",
    "data:image/png;base64,AAAA",
    "C:\\images\\a.png",
    "worlds/a\u0000b.png",
    "",
    "   ",
    null,
    undefined,
    42
  ]) {
    assert.equal(noteImagePath(value), null, String(value));
  }
});

test("noteImageUrl still accepts only http(s) URLs", () => {
  assert.equal(noteImageUrl("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(noteImageUrl("worlds/a.png"), null);
});
