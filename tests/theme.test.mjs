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

test("link defaults reproduce the pre-theme look", () => {
  const classic = getTheme("classic");
  const vars = themeToVars(classic);
  assert.equal(vars["--jn-link-width"], "2");
  assert.equal(vars["--jn-link-width-selected"], "3.5");
  assert.equal(vars["--jn-link-dash"], "7 6");
  assert.equal(vars["--jn-link-dash-hidden"], "2 6");
  assert.equal(vars["--jn-link-dim-opacity"], "0.15");
  assert.match(vars["--jn-link-shadow"], /^drop-shadow\(0 1px 1px/);
  assert.equal(vars["--jn-link-arrow-scale"], "1");
  assert.equal(vars["--jn-link-pin-radius"], "3px");
  assert.equal(vars["--jn-link-pin-fill"], "#a393f2");
  assert.equal(vars["--jn-link-pin-stroke"], "#1b1b1d");
  assert.equal(vars["--jn-link-label-size"], "11px");
  assert.equal(vars["--jn-link-label-color"], "#8d8d97");
  assert.equal(vars["--jn-link-halo"], "#1b1b1d");
  assert.equal(vars["--jn-link-halo-width"], "7px");
  assert.equal(vars["--jn-link-select"], "#a393f2");
  assert.equal(vars["--jn-link-1"], "#a393f2");
  assert.equal(vars["--jn-link-2"], "#d6a45c");
  assert.equal(vars["--jn-link-3"], "#d77b91");
});

test("every built-in theme has complete link colors", () => {
  for (const id of ["classic", "fantasy", "parchment"]) {
    const theme = getTheme(id);
    assert.ok(theme.links, `${theme.id} has no links block`);
    for (const slot of ["link1", "link2", "link3"]) {
      assert.match(theme.links.colors[slot], /^(#|rgb|hsl)/, `${theme.id}.links.colors.${slot}`);
      assert.match(themeToVars(theme)[`--jn-link-${slot.slice(-1)}`], /^(#|rgb|hsl)/);
    }
  }
});

test("link values are clamped, and invalid values fall back", () => {
  const theme = normalizeTheme({
    links: {
      width: 999, selectedWidth: -5, dash: "url(https://evil.test)", hiddenDash: 42,
      dimOpacity: 3, shadow: "0 0 9px red", arrowScale: 99, pinRadius: 99,
      pinFill: "url(https://evil.test)", pinStroke: "javascript:alert(1)",
      labelSize: 999, labelColor: "javascript:alert(1)",
      halo: "url(https://evil.test)", haloWidth: -1, selectColor: "not a color",
      colors: { link1: "url(https://evil.test)", link2: "not a color", link3: "#123456" }
    }
  }, { id: "evil-links" });

  assert.equal(theme.links.width, 12);
  assert.equal(theme.links.selectedWidth, 0.5);
  assert.equal(theme.links.dash, "7 6");
  assert.equal(theme.links.hiddenDash, "2 6");
  assert.equal(theme.links.dimOpacity, 1);
  assert.equal(theme.links.shadow, "soft");
  assert.equal(theme.links.arrowScale, 1.8);
  assert.equal(theme.links.pinRadius, 6);
  assert.equal(theme.links.pinFill, "acc");
  assert.equal(theme.links.pinStroke, "bg");
  assert.equal(theme.links.labelSize, 32);
  assert.equal(theme.links.labelColor, "muted");
  assert.equal(theme.links.halo, "bg");
  assert.equal(theme.links.haloWidth, 0);
  assert.equal(theme.links.selectColor, "acc");
  assert.deepEqual(theme.links.colors, { link1: "acc", link2: "hint", link3: "#123456" });
  // A hostile dash string never reaches CSS or SVG.
  assert.equal(themeToVars(theme)["--jn-link-dash"], "7 6");
});

test("a theme without a links block normalizes to sane defaults", () => {
  const theme = normalizeTheme({}, { id: "bare-links" });
  assert.ok(theme.links);
  assert.equal(theme.links.width, 2);
  assert.equal(theme.links.shadow, "soft");
  assert.deepEqual(theme.links.colors, { link1: "acc", link2: "hint", link3: "danger" });
  assert.equal(themeToVars(theme)["--jn-link-1"], "#a393f2");
});

test("themeToVars emits every link variable", () => {
  const vars = themeToVars(getTheme("classic"));
  const names = [
    "--jn-link-width", "--jn-link-width-selected", "--jn-link-dash", "--jn-link-dash-hidden",
    "--jn-link-dim-opacity", "--jn-link-shadow", "--jn-link-arrow-scale", "--jn-link-pin-radius",
    "--jn-link-pin-fill", "--jn-link-pin-stroke", "--jn-link-label-size", "--jn-link-label-color",
    "--jn-link-halo", "--jn-link-halo-width", "--jn-link-select",
    "--jn-link-1", "--jn-link-2", "--jn-link-3"
  ];
  for (const name of names) assert.ok(name in vars, `${name} missing`);
});

test("link halo and pin stroke follow the board color unless overridden", () => {
  const theme = normalizeTheme({ board: { color: "panel" } }, { id: "board-halo" });
  const vars = themeToVars(theme);
  assert.equal(vars["--jn-board-color"], vars["--jn-link-halo"]);
  assert.equal(vars["--jn-board-color"], vars["--jn-link-pin-stroke"]);
  assert.notEqual(vars["--jn-link-halo"], vars["--jn-bg"]);

  const overridden = normalizeTheme({
    board: { color: "panel" },
    links: { halo: "#ff0000", pinStroke: "acc" }
  }, { id: "board-halo-override" });
  assert.equal(varFor(overridden, "--jn-link-halo"), "#ff0000");
  assert.equal(varFor(overridden, "--jn-link-pin-stroke"), "#a393f2");
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
