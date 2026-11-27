import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  applyTheme, BOARD_BACKGROUND_IDS, BUILTIN_THEME_IDS, getTheme, listThemes, loadSavedThemes, MATERIAL_FONT_KEYS,
  MATERIAL_FONT_STACKS, normalizeTheme, registerTheme, savedThemes, STYLIZED_GRAIN_TILE,
  STYLIZED_MATERIALS, themeToVars
} from "../scripts/styles/themes.mjs";
import { CARD_STYLES } from "../scripts/styles/registry.mjs";

const varFor = (theme, name) => themeToVars(theme)[name];

/** The complete Stylized Canvas token contract (additive to the existing --jn-* API). */
const STYLIZED_TOKENS = [
  "--jn-sc-cork", "--jn-sc-cork-tile", "--jn-sc-cork-size", "--jn-sc-board-border",
  "--jn-sc-board-radius", "--jn-sc-board-light", "--jn-sc-board-vignette",
  "--jn-sc-board-vignette-start", "--jn-sc-board-vignette-end", "--jn-sc-grain",
  "--jn-sc-paper-compact", "--jn-sc-paper-memo", "--jn-sc-paper-document", "--jn-sc-paper-target",
  "--jn-sc-torn-fiber", "--jn-sc-ink", "--jn-sc-ink-face", "--jn-sc-rule", "--jn-sc-doc-margin",
  "--jn-sc-font-body", "--jn-sc-font-hand", "--jn-sc-font-display", "--jn-sc-font-formal",
  "--jn-sc-pin-main-size", "--jn-sc-pin-minor-size", "--jn-sc-pin-route-size", "--jn-sc-pin-rim",
  "--jn-sc-pin-default", "--jn-sc-thread-1", "--jn-sc-thread-2", "--jn-sc-thread-3",
  "--jn-sc-thread-4", "--jn-sc-thread-5", "--jn-sc-thread-6", "--jn-sc-thread-accent",
  "--jn-sc-thread-shadow", "--jn-sc-thread-fade", "--jn-sc-thread-fade-fill",
  "--jn-sc-thread-fade-time"
];

test("every built-in theme covers every card type and core role", () => {
  for (const theme of listThemes()) {
    for (const token of ["bg", "panel", "text", "muted", "line", "acc", "gm", "hint", "thread"]) {
      assert.match(theme.colors[token], /^(#|rgb|hsl)/, `${theme.id}.${token}`);
    }
    for (const style of Object.keys(CARD_STYLES)) {
      assert.ok(theme.styles[style], `${theme.id} is missing ${style}`);
      assert.ok(theme.styles[style].type, `${theme.id}.${style} has no typography`);
    }
    assert.ok(theme.materials, `${theme.id} has no materials block`);
  }
});

test("stylized is the built-in default and unknown ids fall back to it", () => {
  assert.ok(BUILTIN_THEME_IDS.includes("stylized"));
  assert.equal(BUILTIN_THEME_IDS[0], "stylized");
  assert.equal(getTheme("stylized").id, "stylized");
  assert.equal(getTheme("does-not-exist").id, "stylized");
  assert.equal(getTheme(undefined).id, "stylized");
  assert.equal(listThemes()[0].id, "stylized");
});

test("stylized uses the reference materials and emits the complete token contract", () => {
  const theme = getTheme("stylized");
  assert.equal(theme.nameKey, "JN.Theme.Stylized");
  const vars = themeToVars(theme);

  for (const name of STYLIZED_TOKENS) assert.ok(name in vars, `${name} missing`);

  assert.equal(vars["--jn-sc-cork"], "#7b5233");
  assert.equal(vars["--jn-sc-cork-size"], "320px");
  assert.match(vars["--jn-sc-cork-tile"], /^url\(".*assets\/stylized\/cork\.svg"\)$/);
  assert.equal(vars["--jn-sc-board-border"], "#5a402d");
  assert.equal(vars["--jn-sc-board-radius"], "8px");
  assert.match(vars["--jn-sc-board-light"], /^rgba\(255, 225, 160, 0\.12\)$/);
  assert.equal(vars["--jn-sc-board-vignette"], "rgba(8, 4, 0, 0.55)");
  assert.equal(vars["--jn-sc-board-vignette-start"], "38%");
  assert.equal(vars["--jn-sc-board-vignette-end"], "100%");
  assert.match(vars["--jn-sc-grain"], /^url\(".*assets\/stylized\/grain\.svg"\)$/);

  assert.equal(vars["--jn-sc-paper-compact"], "#d9c08f");
  assert.equal(vars["--jn-sc-paper-memo"], "#ead9b4");
  assert.equal(vars["--jn-sc-paper-document"], "#efe5c9");
  assert.equal(vars["--jn-sc-paper-target"], "#e8dbc0");
  assert.equal(vars["--jn-sc-torn-fiber"], "#f0e4c9");
  assert.equal(vars["--jn-sc-ink"], "#3c2b19");
  assert.equal(vars["--jn-sc-ink-face"], "#45321f");
  assert.equal(vars["--jn-sc-rule"], "rgba(107,81,37,.12)");
  assert.equal(vars["--jn-sc-doc-margin"], "rgba(139,102,55,.14)");

  assert.equal(vars["--jn-sc-font-body"], MATERIAL_FONT_STACKS.alegreya);
  assert.equal(vars["--jn-sc-font-hand"], MATERIAL_FONT_STACKS.caveat);
  assert.equal(vars["--jn-sc-font-display"], MATERIAL_FONT_STACKS.fell);
  assert.equal(vars["--jn-sc-font-formal"], MATERIAL_FONT_STACKS.oldstandard);
  assert.match(vars["--jn-sc-font-body"], /^Alegreya, Georgia/);
  assert.match(vars["--jn-sc-font-hand"], /^"Caveat"/);
  assert.match(vars["--jn-sc-font-display"], /^"IM Fell English"/);
  assert.match(vars["--jn-sc-font-formal"], /^"Old Standard TT"/);

  assert.equal(vars["--jn-sc-pin-main-size"], "20px");
  assert.equal(vars["--jn-sc-pin-minor-size"], "9px");
  assert.equal(vars["--jn-sc-pin-route-size"], "12px");
  assert.equal(vars["--jn-sc-pin-rim"], "#b69a67");
  assert.equal(vars["--jn-sc-pin-default"], "enamel");

  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(index => vars[`--jn-sc-thread-${index}`]),
    ["#b85d4d", "#c7a45e", "#8fa574", "#7297b2", "#ac89aa", "#d1c2a0"]
  );
  assert.equal(vars["--jn-sc-thread-accent"], "#d8c49d");
  assert.equal(vars["--jn-sc-thread-shadow"], "#21150c");
  assert.equal(vars["--jn-sc-thread-fade"], "0.15");
  assert.equal(vars["--jn-sc-thread-fade-fill"], "rgb(38,38,38)");
  assert.equal(vars["--jn-sc-thread-fade-time"], "160ms");

  // The stylized built-in adopts the dye palette instead of preserving the old toolbar colours.
  assert.deepEqual(theme.links.colors, { link1: "#b85d4d", link2: "#c7a45e", link3: "#8fa574" });
  assert.equal(theme.links.pinRadius, 4);
  assert.equal(vars["--jn-link-1"], "#b85d4d");
  assert.equal(vars["--jn-link-2"], "#c7a45e");
  assert.equal(vars["--jn-link-3"], "#8fa574");
  assert.equal(vars["--jn-link-pin-radius"], "4px");
});

test("thread fade emits a mask fill token that stylized.css consumes", () => {
  const theme = normalizeTheme({ materials: { threads: { fade: 0.5 } } }, { id: "fade" });
  assert.equal(varFor(theme, "--jn-sc-thread-fade"), "0.5");
  assert.equal(varFor(theme, "--jn-sc-thread-fade-fill"), "rgb(128,128,128)");

  const clamped = normalizeTheme({ materials: { threads: { fade: 9 } } }, { id: "fade-clamp" });
  assert.equal(clamped.materials.threads.fade, 1);
  assert.equal(varFor(clamped, "--jn-sc-thread-fade-fill"), "rgb(255,255,255)");

  const css = readFileSync(new URL("../styles/stylized.css", import.meta.url), "utf8");
  assert.match(css, /\.jn-thread-mask-shape\.jn-thread-mask-active\s*\{[^}]*fill:\s*var\(--jn-sc-thread-fade-fill/);
});

test("bundled cork and grain use module-prefixed routes, never a bare /assets URL", () => {
  assert.equal(STYLIZED_MATERIALS.board.corkTile, "modules/fvtt-journalinator/assets/stylized/cork.svg");
  assert.equal(STYLIZED_GRAIN_TILE, "modules/fvtt-journalinator/assets/stylized/grain.svg");

  const previous = globalThis.foundry;
  globalThis.foundry = { utils: { getRoute: path => `/${path}` } };
  try {
    const vars = themeToVars(getTheme("stylized"));
    for (const token of ["--jn-sc-cork-tile", "--jn-sc-grain"]) {
      const match = vars[token].match(/^url\("(.+)"\)$/);
      assert.ok(match, `${token} is a URL`);
      const pathname = new URL(match[1], "http://localhost/").pathname;
      assert.ok(pathname.startsWith("/modules/fvtt-journalinator/assets/stylized/"), `${token}: ${pathname}`);
      assert.equal(pathname.startsWith("/assets/"), false, `${token} is not a bare asset path`);
    }
  } finally {
    if (previous === undefined) delete globalThis.foundry;
    else globalThis.foundry = previous;
  }
});

test("custom cork tiles stay safe relative data paths", () => {
  const custom = normalizeTheme({ materials: { board: { corkTile: "worlds/cork/custom.svg" } } }, { id: "custom-tile" });
  assert.equal(custom.materials.board.corkTile, "worlds/cork/custom.svg");
});

test("classic keeps the pre-theme API colours but renders the new materials", () => {
  const classic = getTheme("classic");
  assert.equal(varFor(classic, "--jn-bg"), "#1b1b1d");
  assert.equal(varFor(classic, "--jn-style-sticky-surface"), "#2d2e32");
  assert.equal(varFor(classic, "--jn-style-sticky-radius"), "3px");
  assert.equal(varFor(classic, "--jn-style-sticky-edge-width"), "0px");
  assert.equal(varFor(classic, "--jn-style-document-title-font"), 'Georgia, "Times New Roman", serif');
  assert.equal(varFor(classic, "--jn-style-memo-surface"), "#252528");
  // No legacy palette preservation: the canvas materials are always the new defaults.
  assert.deepEqual(classic.materials, STYLIZED_MATERIALS);
});

test("old and custom theme inputs normalize to the material defaults", () => {
  const legacy = normalizeTheme({
    colors: { bg: "#111111", acc: "#ff0000" },
    board: { color: "bg", pattern: "grid", patternSize: 26 },
    styles: { sticky: { surface: "#222222", radius: 3 } }
  }, { id: "legacy" });
  assert.deepEqual(legacy.materials, STYLIZED_MATERIALS);
  assert.equal(legacy.colors.bg, "#111111");
  assert.equal(legacy.colors.acc, "#ff0000");
  assert.equal(legacy.board.pattern, "grid");

  for (const id of ["classic", "fantasy", "parchment", "stylized"]) {
    assert.deepEqual(getTheme(id).materials, STYLIZED_MATERIALS, `${id} materials`);
  }
});

test("legacy built-in themes render the 320px cork material scale", () => {
  for (const id of BUILTIN_THEME_IDS.filter(id => !BOARD_BACKGROUND_IDS.includes(id) || id === "stylized")) {
    assert.equal(getTheme(id).board.patternSize, 320, `${id} cork scale`);
    assert.equal(themeToVars(getTheme(id))["--jn-sc-cork-size"], "320px", `${id} token`);
  }
});

test("the picker offers the original cork first, then the two photo boards", () => {
  assert.deepEqual([...BOARD_BACKGROUND_IDS], ["stylized", "cork-photo", "grey-paper"]);
  for (const id of BOARD_BACKGROUND_IDS) assert.equal(getTheme(id).id, id);
  const original = themeToVars(getTheme("stylized"));
  const photo = themeToVars(getTheme("cork-photo"));
  const grey = themeToVars(getTheme("grey-paper"));
  assert.match(original["--jn-sc-cork-tile"], /stylized\/cork\.svg/);
  assert.match(original["--jn-sc-grain"], /stylized\/grain\.svg/, "the original keeps its paper grain");
  assert.match(photo["--jn-sc-cork-tile"], /boards\/cork-photo\.webp/);
  assert.match(grey["--jn-sc-cork-tile"], /boards\/grey-paper\.webp/);
  for (const vars of [photo, grey]) {
    assert.match(vars["--jn-sc-grain"], /stylized\/paper-fine\.svg/, "photo boards use their own paper grain");
    assert.notEqual(vars["--jn-sc-grain"], original["--jn-sc-grain"]);
  }
  // Only the board changes: paper, pins and threads stay the shared materials.
  for (const id of ["cork-photo", "grey-paper"]) {
    const { board, ...rest } = getTheme(id).materials;
    const { board: _ignored, ...base } = STYLIZED_MATERIALS;
    assert.deepEqual(rest, base, `${id} keeps the shared paper/pin/thread materials`);
  }
});

test("every bundled board image exists on disk", () => {
  for (const id of BOARD_BACKGROUND_IDS) {
    for (const key of ["corkTile", "grainTile"]) {
      const path = getTheme(id).materials.board[key];
      assert.ok(existsSync(new URL(`../${path.replace("modules/fvtt-journalinator/", "")}`, import.meta.url)), `${id}.${key}: ${path}`);
    }
  }
});

test("material values are clamped and unsafe inputs fall back to defaults", () => {
  const theme = normalizeTheme({
    materials: {
      board: {
        cork: "url(https://evil.test/cork.png)",
        corkTile: "https://evil.test/cork.svg",
        size: 9999,
        border: "javascript:alert(1)",
        radius: 99,
        lightOpacity: 5,
        vignetteColor: "url(https://evil.test/v)",
        vignetteStart: -4,
        vignetteEnd: 900
      },
      paper: {
        memo: "url(https://evil.test/paper)",
        ink: "expression(alert(1))",
        rule: "#123456"
      },
      fonts: { body: "Comic Sans", hand: "caveat", display: "url(x)", formal: "oldstandard" },
      pins: {
        mainSize: 99, minorSize: -1, routeSize: 999, rim: "javascript:alert(1)", defaultStyle: "rope"
      },
      threads: {
        dyes: ["#123456", "url(https://evil.test/dye)", "not a color", "#654321"],
        accent: "url(x)",
        shadow: "javascript:alert(1)",
        fade: 9,
        fadeTime: 9999
      },
      unknown: { injected: true }
    }
  }, { id: "evil-materials" });

  assert.equal(theme.materials.board.cork, STYLIZED_MATERIALS.board.cork);
  assert.equal(theme.materials.board.corkTile, STYLIZED_MATERIALS.board.corkTile);
  assert.equal(theme.materials.board.size, 640);
  assert.equal(theme.materials.board.border, STYLIZED_MATERIALS.board.border);
  assert.equal(theme.materials.board.radius, 24);
  assert.equal(theme.materials.board.lightOpacity, 0.6);
  assert.equal(theme.materials.board.vignetteColor, STYLIZED_MATERIALS.board.vignetteColor);
  assert.equal(theme.materials.board.vignetteStart, 0);
  assert.equal(theme.materials.board.vignetteEnd, 100);

  assert.equal(theme.materials.paper.memo, STYLIZED_MATERIALS.paper.memo);
  assert.equal(theme.materials.paper.ink, STYLIZED_MATERIALS.paper.ink);
  assert.equal(theme.materials.paper.rule, "#123456");

  assert.equal(theme.materials.fonts.body, "alegreya");
  assert.equal(theme.materials.fonts.hand, "caveat");
  assert.equal(theme.materials.fonts.display, "fell");
  assert.equal(theme.materials.fonts.formal, "oldstandard");

  assert.equal(theme.materials.pins.mainSize, 32);
  assert.equal(theme.materials.pins.minorSize, 5);
  assert.equal(theme.materials.pins.routeSize, 24);
  assert.equal(theme.materials.pins.rim, STYLIZED_MATERIALS.pins.rim);
  assert.equal(theme.materials.pins.defaultStyle, "enamel");

  // Only six validated dyes survive; invalid slots and slots past the cap are dropped.
  assert.deepEqual(theme.materials.threads.dyes, [
    "#123456", "#654321", "#8fa574", "#7297b2", "#ac89aa", "#d1c2a0"
  ]);
  assert.equal(theme.materials.threads.accent, STYLIZED_MATERIALS.threads.accent);
  assert.equal(theme.materials.threads.shadow, STYLIZED_MATERIALS.threads.shadow);
  assert.equal(theme.materials.threads.fade, 1);
  assert.equal(theme.materials.threads.fadeTime, 400);
  assert.equal(theme.materials.unknown, undefined);
  assert.equal(theme.materials.board.unknown, undefined);

  const vars = themeToVars(theme);
  for (const name of STYLIZED_TOKENS) assert.ok(name in vars, `${name} missing`);
  assert.doesNotMatch(Object.values(vars).join("\n"), /javascript:|expression\(|evil\.test/);
});

test("material fonts are a bounded enum", () => {
  assert.deepEqual(MATERIAL_FONT_KEYS, ["alegreya", "caveat", "fell", "oldstandard"]);
  for (const key of MATERIAL_FONT_KEYS) assert.ok(MATERIAL_FONT_STACKS[key], `${key} has no stack`);
  const theme = normalizeTheme({ materials: { fonts: { body: "curl", hand: "sans" } } }, { id: "fonts" });
  assert.equal(theme.materials.fonts.body, "alegreya");
  assert.equal(theme.materials.fonts.hand, "caveat");
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
  for (const id of BUILTIN_THEME_IDS) {
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

test("material colour roles resolve through the theme palette", () => {
  const theme = normalizeTheme({
    colors: { acc: "#ff0000", text: "#00ff00" },
    materials: {
      board: { cork: "acc", border: "text" },
      paper: { memo: "acc", ink: "text" },
      threads: { dyes: ["acc", "text"] }
    }
  }, { id: "material-refs" });
  const vars = themeToVars(theme);
  assert.equal(vars["--jn-sc-cork"], "#ff0000");
  assert.equal(vars["--jn-sc-board-border"], "#00ff00");
  assert.equal(vars["--jn-sc-paper-memo"], "#ff0000");
  assert.equal(vars["--jn-sc-ink"], "#00ff00");
  assert.equal(vars["--jn-sc-thread-1"], "#ff0000");
  assert.equal(vars["--jn-sc-thread-2"], "#00ff00");
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
  assert.equal(theme.board.patternSize, 640);
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

test("material cork tiles use the same safe local data-path rule", () => {
  const safe = normalizeTheme({ materials: { board: { corkTile: "uploads/cork.svg" } } }, { id: "tile-safe" });
  assert.equal(safe.materials.board.corkTile, "uploads/cork.svg");
  for (const hostile of ["../secrets/cork.svg", "/absolute/cork.svg", "http://evil.test/c.svg", "javascript:alert(1)"]) {
    const theme = normalizeTheme({ materials: { board: { corkTile: hostile } } }, { id: "tile-evil" });
    assert.equal(theme.materials.board.corkTile, STYLIZED_MATERIALS.board.corkTile, hostile);
  }
});

test("applyTheme writes data attributes and custom properties for the stylized presentation", () => {
  const root = {
    dataset: {},
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } }
  };
  const theme = getTheme("parchment");
  applyTheme(root, theme);
  assert.equal(root.dataset.theme, "parchment");
  assert.equal(root.dataset.visual, "stylized");
  // Old dot/grid presentations are never painted, regardless of the theme's legacy board block.
  assert.equal(root.dataset.boardPattern, "none");
  assert.equal(root.style.values["--jn-bg"], "#e7ddc6");
  assert.equal(root.style.values["--jn-style-sticky-surface"], "#f6e6a6");
  assert.equal(root.style.values["--jn-sc-cork"], "#7b5233");
  assert.equal(root.style.values["--jn-sc-paper-memo"], "#ead9b4");
});

test("pin heads and hit targets keep a stable screen size through zoom", () => {
  const css = readFileSync(new URL("../styles/stylized.css", import.meta.url), "utf8");
  assert.match(css,
    /\.jn-canvas \.jn-pin-layer \.jn-pin,[\s\S]*?\.jn-canvas \.jn-board-pin-control \{[^}]*width:\s*var\(--jn-main-pin-size, 14px\);[^}]*height:\s*var\(--jn-main-pin-size, 14px\);/);
  assert.doesNotMatch(css, /\.jn-pin-minor\b/, "there is no separate minor-pin visual");
  assert.match(css,
    /\.jn-canvas \.jn-pin-layer \.jn-pin::after,[\s\S]*?\.jn-canvas \.jn-board-pin-control::after \{[^}]*width:\s*max\(var\(--jn-pin-hit-size, 20px\), 100%\);/);

  for (const k of [0.25, 1, 4]) {
    const main = (14 / k) * k;
    assert.equal(main, 14);
    assert.equal((20 / k) * k, 20, `hit target stays 20px at k=${k}`);
  }
});

test("registration persists and reloads custom themes with material normalization", () => {
  registerTheme("saved-theme", { styles: { sticky: { surface: "#abcdef" } } }, { persist: true });
  const snapshot = savedThemes();
  assert.ok(snapshot["saved-theme"]);
  assert.ok(listThemes().some(theme => theme.id === "saved-theme"));

  const reloaded = loadSavedThemes(snapshot);
  assert.ok(reloaded.some(theme => theme.id === "saved-theme"));
  assert.equal(getTheme("saved-theme").styles.sticky.surface, "#abcdef");
  assert.deepEqual(getTheme("saved-theme").materials, STYLIZED_MATERIALS);
  // Registration/lookup API keeps resolving, with the new default as the fallback.
  assert.equal(getTheme("does-not-exist").id, "stylized");
});
