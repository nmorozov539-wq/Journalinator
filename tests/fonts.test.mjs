/**
 * Font asset contract: the module ships local webfonts only. Alegreya and Caveat are variable
 * fonts, so one file per subset covers 400-700; the old 700 copies were byte-identical and are
 * gone. Old Standard TT remains a static 400/700 pair for Cyrillic formal headings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const fontsCss = readFileSync(new URL("styles/fonts.css", root), "utf8");
const moduleJson = JSON.parse(readFileSync(new URL("module.json", root), "utf8"));

const faces = [...fontsCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(match => match[1]);
const familyOf = face => face.match(/font-family:\s*"([^"]+)"/)?.[1];
const weightOf = face => face.match(/font-weight:\s*([^;]+);/)?.[1].trim();
const srcOf = face => face.match(/url\("([^"]+)"\)/)?.[1];

test("fonts.css is registered with the module stylesheet list", () => {
  assert.ok(moduleJson.styles.includes("styles/fonts.css"));
});

test("every font source is a local, existing woff2 file", () => {
  const sources = faces.map(srcOf).filter(Boolean);
  assert.ok(sources.length > 0);
  for (const source of sources) {
    assert.match(source, /^\.\.\/assets\/fonts\/[a-z0-9-]+\.woff2$/, source);
    assert.equal(existsSync(new URL(source.replace("../", ""), root)), true, `${source} exists`);
  }
  assert.doesNotMatch(fontsCss, /https?:|url\(\s*\/\//, "no remote font URLs");
});

test("Alegreya and Caveat declare one variable face per subset at 400 700", () => {
  for (const family of ["Alegreya", "Caveat"]) {
    const familyFaces = faces.filter(face => familyOf(face) === family);
    assert.equal(familyFaces.length, 2, `${family} has Latin and Cyrillic faces`);
    for (const face of familyFaces) {
      assert.equal(weightOf(face), "400 700", `${family} covers the variable weight range`);
      assert.doesNotMatch(srcOf(face), /-700\.woff2$/, `${family} does not need a duplicate 700 file`);
    }
  }
  for (const file of ["alegreya-latin-700.woff2", "alegreya-cyrillic-700.woff2",
    "caveat-latin-700.woff2", "caveat-cyrillic-700.woff2"]) {
    assert.equal(existsSync(new URL(`assets/fonts/${file}`, root)), false, `${file} was removed`);
  }
});

test("Old Standard TT keeps true 400 and 700 files", () => {
  const facesOfFamily = faces.filter(face => familyOf(face) === "Old Standard TT");
  const weights = facesOfFamily.map(weightOf).sort();
  assert.deepEqual(weights, ["400", "400", "700", "700"]);
  for (const file of ["oldstandardtt-latin-400.woff2", "oldstandardtt-cyrillic-400.woff2",
    "oldstandardtt-latin-700.woff2", "oldstandardtt-cyrillic-700.woff2"]) {
    assert.equal(existsSync(new URL(`assets/fonts/${file}`, root)), true, `${file} exists`);
  }
});

test("each bundled family ships its SIL OFL license", () => {
  for (const license of ["OFL-alegreya.txt", "OFL-caveat.txt", "OFL-imfellenglish.txt", "OFL-oldstandardtt.txt"]) {
    assert.equal(existsSync(new URL(`assets/fonts/${license}`, root)), true, `${license} exists`);
  }
});
