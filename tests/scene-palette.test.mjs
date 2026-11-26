import { test } from "node:test";
import assert from "node:assert/strict";

import {
  activeSceneSource, analyzePixels, clearSceneThemeCache, contrastRatio, labToHex,
  oklabToRgb, paletteToTheme, rgbToOklab, sceneCacheKey, sceneTheme
} from "../scripts/scene-palette.mjs";
import { CARD_STYLES } from "../scripts/styles/registry.mjs";

function buildPixels(entries, size = 64) {
  const total = size * size;
  const data = new Uint8ClampedArray(total * 4);
  let index = 0;
  for (const [rgb, weight] of entries) {
    const count = Math.round(total * weight);
    for (let i = 0; i < count && index < total; i++, index++) {
      data[index * 4] = rgb[0];
      data[index * 4 + 1] = rgb[1];
      data[index * 4 + 2] = rgb[2];
      data[index * 4 + 3] = 255;
    }
  }
  while (index < total) {
    const rgb = entries[0][0];
    data[index * 4] = rgb[0];
    data[index * 4 + 1] = rgb[1];
    data[index * 4 + 2] = rgb[2];
    data[index * 4 + 3] = 255;
    index++;
  }
  return data;
}

test("OKLab round-trips sRGB within a channel", () => {
  for (const [r, g, b] of [[255, 0, 0], [0, 128, 255], [230, 220, 200], [12, 12, 14]]) {
    const back = oklabToRgb(rgbToOklab(r, g, b));
    assert.ok(Math.abs(back.r - r) <= 1, `${r} -> ${back.r}`);
    assert.ok(Math.abs(back.g - g) <= 1, `${g} -> ${back.g}`);
    assert.ok(Math.abs(back.b - b) <= 1, `${b} -> ${back.b}`);
  }
  assert.match(labToHex(rgbToOklab(255, 0, 0)), /^#[0-9a-f]{6}$/);
});

test("a dark scene yields a dark, readable theme with the scene's accent", () => {
  const palette = analyzePixels(buildPixels([
    [[24, 28, 42], 0.75],   // night map / dark terrain
    [[210, 110, 35], 0.25]  // torchlight / markers
  ]), 64, 64);

  assert.equal(palette.mode, "dark");
  assert.ok(palette.labs.bg.L < 0.30, `bg L ${palette.labs.bg.L}`);
  assert.ok(palette.labs.panel.L > palette.labs.bg.L);
  assert.ok(contrastRatio(palette.labs.text, palette.labs.panel) >= 7);
  assert.ok(contrastRatio(palette.labs.muted, palette.labs.panel) >= 4.5);
  assert.ok(contrastRatio(palette.labs.accent, palette.labs.panel) >= 3);
  assert.ok(palette.meta.accent.C >= 0.08);
  assert.ok(palette.meta.accent.h > 30 && palette.meta.accent.h < 95, `accent hue ${palette.meta.accent.h}`);
  assert.match(palette.colors.acc, /^#[0-9a-f]{6}$/);
  assert.notEqual(palette.colors.acc, "#a393f2");
});

test("a bright scene flips to a light theme with dark text", () => {
  const palette = analyzePixels(buildPixels([
    [[232, 228, 218], 0.8], // snow / parchment
    [[45, 85, 175], 0.2]    // cold water / markers
  ]), 64, 64);

  assert.equal(palette.mode, "light");
  assert.ok(palette.labs.bg.L > 0.80, `bg L ${palette.labs.bg.L}`);
  assert.ok(palette.labs.text.L < 0.30, `text L ${palette.labs.text.L}`);
  assert.ok(contrastRatio(palette.labs.text, palette.labs.panel) >= 7);
  assert.ok(contrastRatio(palette.labs.muted, palette.labs.panel) >= 4.5);
  assert.ok(palette.meta.accent.h > 220 && palette.meta.accent.h < 310, `accent hue ${palette.meta.accent.h}`);
});

test("a monochrome scene still gets a distinct, usable accent", () => {
  const palette = analyzePixels(buildPixels([[[128, 128, 128], 1]]), 64, 64);
  assert.ok(palette);
  assert.ok(palette.meta.accent.C >= 0.07, `accent C ${palette.meta.accent.C}`);
  assert.ok(contrastRatio(palette.labs.accent, palette.labs.panel) >= 3);
  assert.ok(contrastRatio(palette.labs.text, palette.labs.panel) >= 7);
});

test("semantic GM, hint and danger colours stay distinct", () => {
  const palette = analyzePixels(buildPixels([
    [[30, 140, 130], 0.5],
    [[180, 60, 70], 0.5]
  ]), 64, 64);
  // Teal and red should not be swallowed by the scene accent or the board colour.
  assert.ok(Math.abs(palette.labs.gm.a - palette.labs.bg.a) + Math.abs(palette.labs.gm.b - palette.labs.bg.b) > 0.02);
  assert.equal(palette.colors.gm, labToHex(palette.labs.gm));
  assert.equal(palette.colors.hint, labToHex(palette.labs.hint));
  assert.notEqual(palette.colors.danger, palette.colors.hint);
});

test("a palette maps to a complete normalized theme", () => {
  const palette = analyzePixels(buildPixels([
    [[20, 24, 36], 0.7],
    [[200, 90, 50], 0.3]
  ]), 64, 64);
  const theme = paletteToTheme(palette);

  assert.equal(theme.id, "scene");
  assert.match(theme.colors.bg, /^#[0-9a-f]{6}$/);
  assert.match(theme.board.patternColor, /^#[0-9a-f]{6}$/);
  assert.equal(theme.board.pattern, "dots");
  for (const style of Object.keys(CARD_STYLES)) {
    assert.ok(theme.styles[style], `missing ${style}`);
    assert.ok(theme.styles[style].type, `${style} has no typography`);
  }
});

test("fully transparent or empty input is rejected", () => {
  const empty = new Uint8ClampedArray(64 * 64 * 4);
  assert.equal(analyzePixels(empty, 64, 64), null);
  assert.equal(analyzePixels(new Uint8ClampedArray(0), 0, 0), null);
});

test("cache keys include the scene, image path and background colour", () => {
  assert.equal(
    sceneCacheKey({ id: "abc", src: "worlds/x.webp", color: "#000" }),
    "abc|worlds/x.webp|#000"
  );
  assert.notEqual(
    sceneCacheKey({ id: "abc", src: "worlds/x.webp" }),
    sceneCacheKey({ id: "abc", src: "worlds/y.webp" })
  );
});

test("activeSceneSource reads the v14 initial level and the legacy fields", () => {  const previous = { canvas: globalThis.canvas, game: globalThis.game };
  try {
    globalThis.canvas = {
      scene: {
        id: "v14",
        initialLevel: { background: { src: "worlds/map/level-1.webp" } },
        backgroundColor: "#101418"
      }
    };
    assert.deepEqual(activeSceneSource(), {
      id: "v14", src: "worlds/map/level-1.webp", color: "#101418"
    });

    globalThis.canvas = { scene: { id: "legacy", img: "worlds/map/old.webp", backgroundColor: "#222" } };
    assert.equal(activeSceneSource().src, "worlds/map/old.webp");

    globalThis.canvas = { scene: { id: "legacy-object", background: { src: "worlds/map/obj.webp" } } };
    assert.equal(activeSceneSource().src, "worlds/map/obj.webp");

    globalThis.canvas = { scene: { id: "empty" } };
    assert.equal(activeSceneSource(), null);

    globalThis.canvas = undefined;
    globalThis.game = undefined;
    assert.equal(activeSceneSource(), null);
  } finally {
    globalThis.canvas = previous.canvas;
    globalThis.game = previous.game;
  }
});

test("sceneTheme builds from a background colour and caches the result", async () => {
  clearSceneThemeCache();
  const source = { id: "colour-only", src: "", color: "#223344" };
  const theme = await sceneTheme(source);
  assert.equal(theme.id, "scene");
  assert.match(theme.colors.bg, /^#[0-9a-f]{6}$/);
  assert.equal(await sceneTheme(source), theme);
});

test("sceneTheme returns null when a source image cannot be decoded", async () => {
  clearSceneThemeCache();
  // Plain Node has no Image/document; the loader must fail closed, not throw.
  assert.equal(await sceneTheme({ id: "no-dom", src: "worlds/x.webp", color: null }), null);
});
