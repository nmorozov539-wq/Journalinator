import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CARD_STYLES } from "../scripts/styles/registry.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const en = JSON.parse(readFileSync(join(root, "lang/en.json"), "utf8"));
const ru = JSON.parse(readFileSync(join(root, "lang/ru.json"), "utf8"));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

test("English and Russian define exactly the same keys", () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
});

test("no language string is empty", () => {
  for (const [key, value] of Object.entries(en)) assert.ok(value.length, `en: ${key}`);
  for (const [key, value] of Object.entries(ru)) assert.ok(value.length, `ru: ${key}`);
});

test("every t() call has an English key", () => {
  const used = new Set();
  for (const file of walk(join(root, "scripts"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bt\(\s*["'`]([A-Za-z0-9_.]+)["'`]/g)) used.add(match[1]);
  }
  assert.ok(used.size > 0, "no t() calls found");
  for (const key of used) assert.ok(Object.hasOwn(en, key), `missing key: ${key}`);
});

test("every card style has a localization key", () => {
  for (const [style, def] of Object.entries(CARD_STYLES)) {
    assert.ok(def.labelKey, `${style} has no labelKey`);
    assert.ok(Object.hasOwn(en, def.labelKey), `missing style key: ${def.labelKey}`);
  }
});
