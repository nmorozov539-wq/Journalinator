import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyTheme, getTheme, listThemes, loadSavedThemes, normalizeTheme,
  registerTheme, savedThemes, themeToVars
} from "../scripts/styles/themes.mjs";
import { CARD_STYLES } from "../scripts/styles/registry.mjs";

const varFor = (theme, name) => themeToVars(theme)[name];

test("every built-in theme covers every card type and core role", () => {
  for (const theme of listThemes()) {
    for (const token of ["bg", "panel", "text", "muted", "line", "acc", "gm", "hint", "thread"]) {
      assert.match(theme.colors[token], /^(#|rgb|hsl)/, `${theme.id}.${token}`);
    }
    for (const style of Object.keys(CARD_STYLES)) {
      assert.ok(theme.styles[style], `${theme.id} is missing ${style}`);
      assert.ok(theme.styles[style].type, `${theme.id}.${style} has no typography`);
    }
  }
});

test("classic keeps the pre-theme look", () => {
  const classic = getTheme("classic");
  assert.equal(varFor(classic, "--jn-bg"), "#1b1b1d");
  assert.equal(varFor(classic, "--jn-style-sticky-surface"), "#2d2e32");
  assert.equal(varFor(classic, "--jn-style-sticky-radius"), "3px");
  assert.equal(varFor(classic, "--jn-style-sticky-edge-width"), "0px");
  assert.equal(varFor(classic, "--jn-style-document-title-font"), 'Georgia, "Times New Roman", serif');
  assert.equal(varFor(classic, "--jn-style-memo-surface"), "#252528");
});

test("a theme can change note type visuals without touching structure", () => {
  const theme = normalizeTheme({
    styles: {
      sticky: { surface: "#123456", radius: 12, shadow: "deep", stripe: 0, type: { titleSize: 20 } },
      document: { edgeStyle: "dashed", edgeWidth: 2 }
    }
  }, { id: "test" });
  const vars = themeToVars(theme);
  assert.equal(vars["--jn-style-sticky-surface"], "#123456");
  assert.equal(vars["--jn-style-sticky-radius"], "12px");
  assert.equal(vars["--jn-style-sticky-stripe"], "0px");
  assert.equal(vars["--jn-style-sticky-title-size"], "20px");
  assert.match(vars["--jn-style-sticky-shadow"], /14px/);
  assert.equal(vars["--jn-style-document-edge-style"], "dashed");
  assert.equal(vars["--jn-style-document-edge-width"], "2px");
  // Structure is untouched by the theme layer.
  assert.equal(CARD_STYLES.sticky.defaultWidth, 190);
  assert.equal(CARD_STYLES.sticky.tilt, true);
});

test("unmentioned style values fall back to classic, not to the hard defaults", () => {
  const theme = normalizeTheme({ styles: { sticky: { radius: 9 } } }, { id: "partial" });
  assert.equal(varFor(theme, "--jn-style-sticky-surface"), "#2d2e32");
  assert.equal(varFor(theme, "--jn-style-sticky-edge-width"), "0px");
  assert.equal(varFor(theme, "--jn-style-sticky-radius"), "9px");
  assert.equal(varFor(theme, "--jn-style-wanted-align"), "center");
});

test("colour roles resolve by reference, so overriding text repaints defaults", () => {
  const theme = normalizeTheme({
    colors: { text: "#00ff00", acc: "#ff0000" },
    styles: { sticky: { titleColor: "text", edge: "acc" } }
  }, { id: "refs" });
  assert.equal(varFor(theme, "--jn-style-sticky-title-color"), "#00ff00");
  assert.equal(varFor(theme, "--jn-style-sticky-edge"), "#ff0000");
});

test("board background supports colour, pattern size, opacity, image and vignette", () => {
  const theme = normalizeTheme({
    board: {
      color: "panel", pattern: "grid", patternColor: "#102030", patternSize: 48,
      patternOpacity: 0.4, image: "modules/fvtt-journalinator/assets/cork.webp",
      imageOpacity: 0.5, imageSize: "tile", vignette: 0.3
    }
  }, { id: "board" });
  const vars = themeToVars(theme);
  assert.equal(vars["--jn-board-color"], "#252528");
  assert.equal(vars["--jn-board-pattern-size"], "48px");
  assert.equal(vars["--jn-board-pattern-opacity"], "0.4");
  assert.equal(vars["--jn-board-image-fade"], "0.5");
  assert.equal(vars["--jn-board-image-repeat"], "repeat");
  assert.match(vars["--jn-board-image"], /url\(".*cork\.webp"\)/);
  assert.equal(vars["--jn-board-vignette"], "0.3");
});

test("unsafe themes are clamped to safe values", () => {
  const theme = normalizeTheme({
    colors: { bg: "url(https://evil.test/x)" },
    board: { image: "https://evil.test/x.png", pattern: "javascript:alert(1)", patternSize: 9999, vignette: -5 },
    styles: { sticky: { radius: 9999, shadow: "0 0 999px red" } }
  }, { id: "evil" });
  assert.equal(theme.colors.bg, "#1b1b1d");
  assert.equal(theme.board.image, null);
  assert.equal(theme.board.pattern, "dots");
  assert.equal(theme.board.patternSize, 200);
  assert.equal(theme.board.vignette, 0);
  assert.equal(theme.styles.sticky.radius, 48);
  assert.equal(theme.styles.sticky.shadow, "paper");
});

test("theme board images accept any safe local data path, not just the built-in roots", () => {
  assert.equal(normalizeTheme({ board: { image: "uploads/cork.webp" } }, { id: "a" }).board.image, "uploads/cork.webp");
  assert.equal(normalizeTheme({ board: { image: "icons/svg/mystery.svg" } }, { id: "b" }).board.image, "icons/svg/mystery.svg");
  assert.equal(normalizeTheme({ board: { image: "../secrets/x.png" } }, { id: "c" }).board.image, null);
  assert.equal(normalizeTheme({ board: { image: "/absolute/x.png" } }, { id: "d" }).board.image, null);
});

test("applyTheme writes data attributes and custom properties", () => {
  const root = {
    dataset: {},
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } }
  };
  const theme = getTheme("parchment");
  applyTheme(root, theme);
  assert.equal(root.dataset.theme, "parchment");
  assert.equal(root.dataset.boardPattern, "grid");
  assert.equal(root.style.values["--jn-bg"], "#e7ddc6");
  assert.equal(root.style.values["--jn-style-sticky-surface"], "#f6e6a6");
});

test("registration persists and reloads custom themes", () => {
  registerTheme("saved-theme", { styles: { sticky: { surface: "#abcdef" } } }, { persist: true });
  const snapshot = savedThemes();
  assert.ok(snapshot["saved-theme"]);
  assert.ok(listThemes().some(theme => theme.id === "saved-theme"));

  const reloaded = loadSavedThemes(snapshot);
  assert.ok(reloaded.some(theme => theme.id === "saved-theme"));
  assert.equal(getTheme("saved-theme").styles.sticky.surface, "#abcdef");
  assert.equal(getTheme("does-not-exist").id, "classic");
});
