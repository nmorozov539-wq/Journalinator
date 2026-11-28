import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function modulesIn(directory) {
  const absolute = join(root, directory);
  return readdirSync(absolute)
    .filter(name => name.endsWith(".mjs"))
    .map(name => join(directory, name));
}

test("the removed secret, actor, migration and stats-schema paths are gone", () => {
  for (const path of [
    "scripts/secrets",
    "scripts/actor-status.mjs",
    "scripts/migrate.mjs",
    "scripts/data/stats-model.mjs",
    "scripts/data/private-model.mjs"
  ]) {
    assert.equal(existsSync(join(root, path)), false, `${path} must not exist`);
  }
});

test("module.json declares exactly the four current document types", () => {
  const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
  assert.equal(manifest.version, "0.9.7");
  assert.deepEqual(
    Object.keys(manifest.documentTypes.JournalEntryPage).sort(),
    ["activity", "history", "layout", "note"]
  );
});

test("runtime data, store, socket and init code has no removed-subsystem references", () => {
  const files = [
    "scripts/socket.mjs",
    "scripts/init.mjs",
    ...modulesIn("scripts/store"),
    ...modulesIn("scripts/data")
  ];
  const forbidden = [
    /secrets\//,
    /\bvaultStore\b/,
    /\bassistantSecrets\b/,
    /actor-status/,
    /stats-model/,
    /private-model/,
    /migrate\.mjs/
  ];

  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} still references ${pattern}`);
    }
  }
});
