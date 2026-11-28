import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LAYOUTS, isLayout, getLayout, resolveLayout, chooseAutoWidth, autoWidthSteps
} from "../scripts/layouts/registry.mjs";
import {
  PAPERS, FONTS, DEFAULT_SKIN, isPaper, isFont, resolveSkin, seedForNote,
  seededSkin, tiltForSkin, skinToCssVars
} from "../scripts/skins/registry.mjs";
import {
  TEMPLATES, getTemplate, templateSkin, createNoteFromTemplate, createNoteFromQuery
} from "../scripts/templates.mjs";

const tiltTenths = value => Math.round(value * 10) / 10;

test("layout registry exposes the two declarative layouts", () => {
  assert.deepEqual(Object.keys(LAYOUTS), ["plain", "profile"]);
  assert.deepEqual(LAYOUTS.plain, {
    id: "plain",
    labelKey: "JN.Layout.Plain",
    widths: [220, 300, 380],
    minHeight: 120,
    padding: 20,
    requiredSlots: ["title"]
  });
  assert.deepEqual(LAYOUTS.profile, {
    id: "profile",
    labelKey: "JN.Layout.Profile",
    widths: [300, 380],
    minHeight: 120,
    padding: 20,
    requiredSlots: ["title", "portrait"]
  });
  assert.equal(Object.isFrozen(LAYOUTS), true);
  assert.equal(Object.isFrozen(LAYOUTS.plain.widths), true);
  assert.equal(Object.isFrozen(LAYOUTS.plain.requiredSlots), true);
});

test("layout lookup falls back to Plain and resolves note or definition objects", () => {
  assert.equal(isLayout("plain"), true);
  assert.equal(isLayout("document"), false);
  assert.equal(getLayout("profile"), LAYOUTS.profile);
  assert.equal(getLayout("nope"), LAYOUTS.plain);
  assert.equal(getLayout(undefined), LAYOUTS.plain);
  assert.equal(resolveLayout("profile"), LAYOUTS.profile);
  assert.equal(resolveLayout({ system: { layout: "profile" } }), LAYOUTS.profile);
  assert.equal(resolveLayout({ layout: "profile" }), LAYOUTS.profile);
  assert.equal(resolveLayout({ system: { layout: "broken" } }), LAYOUTS.plain);
  assert.equal(resolveLayout(null), LAYOUTS.plain);
});

test("automatic width steps are copies of the registry values", () => {
  assert.deepEqual(autoWidthSteps("plain"), [220, 300, 380]);
  assert.deepEqual(autoWidthSteps(LAYOUTS.profile), [300, 380]);
  const copy = autoWidthSteps("plain");
  copy[0] = 1;
  assert.equal(LAYOUTS.plain.widths[0], 220);
});

test("chooseAutoWidth picks the smallest containing step with 40 px padding", () => {
  assert.equal(chooseAutoWidth({ layout: "plain" }), 220);
  assert.equal(chooseAutoWidth({ layout: "plain", intrinsicWidth: 180 }), 220);
  assert.equal(chooseAutoWidth({ layout: "plain", intrinsicWidth: 181 }), 300);
  assert.equal(chooseAutoWidth({ layout: "plain", intrinsicWidth: 260 }), 300);
  assert.equal(chooseAutoWidth({ layout: "plain", intrinsicWidth: 261 }), 380);
  assert.equal(chooseAutoWidth({ layout: "plain", intrinsicWidth: 1000 }), 380);
  assert.equal(chooseAutoWidth({ layout: "plain", intrinsicWidth: -5 }), 220);
  assert.equal(chooseAutoWidth({ layout: "plain", intrinsicWidth: Number.NaN }), 220);

  assert.equal(chooseAutoWidth({ layout: "profile" }), 300);
  assert.equal(chooseAutoWidth({ layout: "profile", intrinsicWidth: 260 }), 300);
  assert.equal(chooseAutoWidth({ layout: "profile", intrinsicWidth: 261 }), 380);
  assert.equal(chooseAutoWidth({ layout: LAYOUTS.profile, intrinsicWidth: 0 }), 300);

  assert.equal(chooseAutoWidth({ layout: "plain", intrinsicWidth: 220, padding: 0 }), 220);
  assert.equal(chooseAutoWidth({ layout: "plain", intrinsicWidth: 221, padding: 0 }), 300);
  assert.equal(chooseAutoWidth({ layout: "not-a-layout", intrinsicWidth: 0 }), 220);
});

test("skin defaults and allowlists are declarative and frozen", () => {
  assert.deepEqual(DEFAULT_SKIN, {
    paper: "amber",
    font: "default",
    torn: false,
    backgroundImage: null,
    tiltSeed: 0
  });
  assert.equal(Object.isFrozen(DEFAULT_SKIN), true);
  assert.equal(Object.isFrozen(PAPERS), true);
  assert.equal(Object.isFrozen(FONTS), true);
  assert.deepEqual(Object.keys(PAPERS), ["cream", "amber", "parchment"]);
  assert.deepEqual(Object.keys(FONTS), ["default", "serif", "handwritten", "display"]);
  assert.equal(PAPERS.cream.paperToken, "--jn-sc-paper-document");
  assert.equal(PAPERS.amber.tilt[0], -2);
  assert.equal(PAPERS.parchment.tilt[1], 1);
  assert.equal(FONTS.handwritten.stackToken, "--jn-sc-font-hand");
  assert.equal(isPaper("cream"), true);
  assert.equal(isPaper("document"), false);
  assert.equal(isFont("handwritten"), true);
  assert.equal(isFont("hand"), false);
});

test("resolveSkin fills defaults, accepts note wrappers and rejects unknown values", () => {
  assert.deepEqual(resolveSkin(), DEFAULT_SKIN);
  assert.deepEqual(resolveSkin({}), DEFAULT_SKIN);
  assert.deepEqual(resolveSkin({
    paper: "nope", font: "comic", torn: "yes", backgroundImage: "   ", tiltSeed: -1
  }), DEFAULT_SKIN);

  const raw = {
    paper: "parchment", font: "display", torn: true,
    backgroundImage: "worlds/test/bg.png", tiltSeed: 42
  };
  assert.deepEqual(resolveSkin(raw), raw);
  assert.deepEqual(resolveSkin({ skin: raw }), raw);
  assert.deepEqual(resolveSkin({ system: { skin: raw } }), raw);
  assert.deepEqual(resolveSkin({ system: { skin: { paper: "cream" } } }), {
    paper: "cream",
    font: "default",
    torn: false,
    backgroundImage: null,
    tiltSeed: 0
  });
  assert.deepEqual(resolveSkin({ system: {} }), DEFAULT_SKIN);
  assert.deepEqual(resolveSkin({ skin: null }), DEFAULT_SKIN);
});

test("seedForNote is a stable unsigned 32-bit FNV-1a hash", () => {
  assert.equal(seedForNote(""), 2166136261);
  assert.equal(seedForNote("a"), 3826002220);
  assert.equal(seedForNote("note-123"), seedForNote("note-123"));
  assert.notEqual(seedForNote("note-123"), seedForNote("note-124"));
  for (const id of ["", "a", "note-123", "заметка", "x".repeat(500)]) {
    const seed = seedForNote(id);
    assert.equal(Number.isInteger(seed), true);
    assert.equal(seed >= 0 && seed <= 0xFFFFFFFF, true);
  }
  assert.equal(seedForNote(undefined), seedForNote(""));
});

test("seededSkin and tiltForSkin are deterministic and respect paper ranges", () => {
  const base = resolveSkin({ paper: "amber", font: "serif" });
  const seeded = seededSkin(base, "note-123");
  assert.equal(seeded.tiltSeed, seedForNote("note-123"));
  assert.equal(base.tiltSeed, 0);
  assert.deepEqual(seededSkin(base, "note-123"), seeded);

  const cream = { paper: "cream", font: "default", torn: false, backgroundImage: null, tiltSeed: 123456 };
  assert.equal(tiltForSkin(cream), 0);

  const amberValues = new Set();
  const parchmentValues = new Set();
  for (let i = 0; i < 40; i += 1) {
    const amber = tiltForSkin(seededSkin({ paper: "amber" }, `note-${i}`));
    const parchment = tiltForSkin(seededSkin({ paper: "parchment" }, `note-${i}`));
    assert.equal(amber >= -2 && amber <= 2, true);
    assert.equal(parchment >= -1 && parchment <= 1, true);
    assert.equal(amber, tiltTenths(amber));
    assert.equal(parchment, tiltTenths(parchment));
    assert.equal(tiltForSkin(seededSkin({ paper: "amber" }, `note-${i}`)), amber);
    amberValues.add(amber);
    parchmentValues.add(parchment);
  }
  assert.equal(amberValues.size > 1, true);
  assert.equal(parchmentValues.size > 1, true);
  assert.equal(tiltForSkin({ paper: "amber", tiltSeed: 0 }), -2);
  assert.equal(tiltForSkin({ paper: "parchment", tiltSeed: 0xFFFFFFFF }), 1);
});

test("skinToCssVars emits stable names and escapes background URLs", () => {
  const vars = skinToCssVars({
    paper: "cream", font: "serif", torn: true, backgroundImage: null, tiltSeed: 77
  });
  assert.deepEqual(vars, {
    "--jn-skin-paper-token": "var(--jn-sc-paper-document)",
    "--jn-note-font": "var(--jn-sc-font-formal)",
    "--jn-note-rotation": "0deg",
    "--jn-skin-torn": "1",
    "--jn-skin-bg": "none"
  });

  const rotated = skinToCssVars(
    { paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 0 },
    { rotation: 4.25 }
  );
  assert.equal(rotated["--jn-note-rotation"], "4.25deg");
  assert.equal(rotated["--jn-skin-torn"], "0");

  const seeded = skinToCssVars(seededSkin({ paper: "amber" }, "note-123"));
  assert.equal(seeded["--jn-note-rotation"], `${tiltForSkin(seededSkin({ paper: "amber" }, "note-123"))}deg`);

  const url = `worlds/a"b\\c.png`;
  const withBackground = skinToCssVars({
    paper: "parchment", font: "display", torn: false, backgroundImage: url, tiltSeed: 5
  });
  assert.equal(withBackground["--jn-skin-bg"], `url("worlds/a\\"b\\\\c.png")`);
  assert.equal(withBackground["--jn-note-font"], "var(--jn-sc-font-display)");
  assert.equal(withBackground["--jn-skin-paper-token"], "var(--jn-sc-paper-target)");

  const multiline = skinToCssVars({ backgroundImage: "a\nb\rc" });
  assert.equal(multiline["--jn-skin-bg"], `url("a b c")`);
});

test("templates are ordered, frozen and contain no prose or external assets", () => {
  assert.deepEqual(TEMPLATES.map(template => template.id), ["blank", "document", "profile"]);
  assert.equal(Object.isFrozen(TEMPLATES), true);
  for (const template of TEMPLATES) {
    assert.equal(Object.isFrozen(template), true);
    assert.equal(["", "# "].includes(template.body), true);
    assert.equal(["plain", "profile"].includes(template.layout), true);
    assert.equal(typeof template.labelKey, "string");
    assert.equal(typeof template.descriptionKey, "string");
    assert.equal(typeof template.focus, "string");
  }
  assert.deepEqual(
    TEMPLATES.map(template => [template.body, template.layout, template.paper, template.font, template.focus]),
    [
      ["", "plain", "amber", "handwritten", "body-start"],
      ["# ", "plain", "cream", "default", "after-title-marker"],
      ["# ", "profile", "parchment", "serif", "after-title-marker"]
    ]
  );

  const serialized = JSON.stringify({ LAYOUTS, PAPERS, FONTS, TEMPLATES });
  assert.equal(/https?:\/\//.test(serialized), false);
  assert.equal(/url\s*\(/i.test(serialized), false);
  assert.equal(/<[a-z]/i.test(serialized), false);
});

test("registry ids and localization keys are unique", () => {
  const layoutIds = Object.keys(LAYOUTS);
  const templateIds = TEMPLATES.map(template => template.id);
  assert.equal(new Set(layoutIds).size, layoutIds.length);
  assert.equal(new Set(templateIds).size, templateIds.length);

  const keys = [
    ...Object.values(LAYOUTS).map(value => value.labelKey),
    ...Object.values(PAPERS).map(value => value.labelKey),
    ...Object.values(FONTS).map(value => value.labelKey),
    ...TEMPLATES.flatMap(template => [template.labelKey, template.descriptionKey])
  ];
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.equal(/^JN\.[A-Za-z.]+$/.test(key), true, key);
});

test("template lookup falls back to Blank", () => {
  assert.equal(getTemplate("document").paper, "cream");
  assert.equal(getTemplate("missing"), TEMPLATES[0]);
});

test("templateSkin seeds from the note id and uses seed 0 without one", () => {
  assert.deepEqual(templateSkin("blank"), {
    paper: "amber", font: "handwritten", torn: false, backgroundImage: null, tiltSeed: 0
  });
  assert.deepEqual(templateSkin("document"), {
    paper: "cream", font: "default", torn: false, backgroundImage: null, tiltSeed: 0
  });
  assert.deepEqual(templateSkin("profile"), {
    paper: "parchment", font: "serif", torn: false, backgroundImage: null, tiltSeed: 0
  });
  const seeded = templateSkin("profile", { noteId: "abc" });
  assert.equal(seeded.tiltSeed, seedForNote("abc"));
  assert.equal(seeded.paper, "parchment");
});

test("createNoteFromTemplate applies the title rule and ignores it for Blank", () => {
  assert.deepEqual(createNoteFromTemplate("blank", { noteId: "n1", title: "Ignored" }), {
    body: "",
    layout: "plain",
    skin: templateSkin("blank", { noteId: "n1" }),
    focus: "body-start"
  });

  assert.equal(createNoteFromTemplate("document", { title: "  Session 4  " }).body, "# Session 4");
  assert.equal(createNoteFromTemplate("document", { title: "   " }).body, "# ");
  assert.equal(createNoteFromTemplate("document", {}).body, "# ");
  const profile = createNoteFromTemplate("profile", { noteId: "n2", title: "Aria" });
  assert.equal(profile.body, "# Aria");
  assert.equal(profile.layout, "profile");
  assert.equal(profile.focus, "after-title-marker");
  assert.equal(profile.skin.paper, "parchment");
  assert.equal(profile.skin.font, "serif");
  assert.equal(profile.skin.tiltSeed, seedForNote("n2"));

  assert.deepEqual(createNoteFromTemplate("missing"), createNoteFromTemplate("blank"));
});

test("createNoteFromQuery maps text to a Plain/Cream title and empty input to Blank", () => {
  assert.deepEqual(createNoteFromQuery("   "), {
    body: "",
    layout: "plain",
    skin: templateSkin("blank"),
    focus: "body-start"
  });

  const note = createNoteFromQuery("  Session 4  ", { noteId: "n3" });
  assert.equal(note.body, "# Session 4");
  assert.equal(note.layout, "plain");
  assert.equal(note.focus, "body-start");
  assert.deepEqual(note.skin, {
    paper: "cream",
    font: "default",
    torn: false,
    backgroundImage: null,
    tiltSeed: seedForNote("n3")
  });

  const first = createNoteFromQuery("Same title", { noteId: "one" });
  const second = createNoteFromQuery("Same title", { noteId: "two" });
  assert.equal(first.body, second.body);
  assert.equal(first.layout, second.layout);
  assert.equal(first.skin.paper, "cream");
  assert.equal(second.skin.paper, "cream");
});
