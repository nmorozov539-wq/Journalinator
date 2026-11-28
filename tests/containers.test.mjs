import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";
import {
  ensureContainers, getContainerIds, registerSidebarHiding
} from "../scripts/store/containers.mjs";

const MODULE_ID = "fvtt-journalinator";
const CURRENT_KEYS = ["shared", "history", "private", "layoutPage", "activityPage", "historyPage"];

const gmUser = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const env = installFoundry({ user: gmUser, users: [gmUser] });
const containers = await makeContainers(env);

function containerKinds() {
  return [...env.journal.values()]
    .map(entry => entry.flags?.[MODULE_ID]?.container)
    .filter(Boolean)
    .sort();
}

function pageTypes() {
  return [...env.journal.values()]
    .flatMap(entry => [...entry.pages.values()])
    .map(page => page.type)
    .sort();
}

test("ensureContainers creates and reuses exactly three containers and three pages", async () => {
  const ids = await ensureContainers();
  assert.deepEqual(Object.keys(ids).sort(), [...CURRENT_KEYS].sort());
  assert.deepEqual(ids, containers.ids);
  assert.equal(env.journal.size, 3);
  assert.deepEqual(containerKinds(), ["history", "private", "shared"]);
  assert.deepEqual(pageTypes(), [
    "fvtt-journalinator.activity",
    "fvtt-journalinator.history",
    "fvtt-journalinator.layout"
  ]);

  const again = await ensureContainers();
  assert.deepEqual(again, ids);
  assert.deepEqual(getContainerIds(), ids);
  assert.equal(env.journal.size, 3);
  assert.equal(pageTypes().length, 3);

  assert.equal(containers.shared.pages.get(ids.layoutPage).type, "fvtt-journalinator.layout");
  assert.equal(containers.shared.pages.get(ids.activityPage).type, "fvtt-journalinator.activity");
  assert.equal(containers.history.pages.get(ids.historyPage).type, "fvtt-journalinator.history");
});

test("repairs missing pages and a deleted container without replacing current ones", async () => {
  const before = getContainerIds();
  containers.shared.pages.delete(before.activityPage);

  let ids = await ensureContainers();
  assert.notEqual(ids.activityPage, before.activityPage);
  assert.equal(containers.shared.pages.get(ids.activityPage).type, "fvtt-journalinator.activity");
  assert.equal(containers.shared.pages.get(ids.activityPage).system.schemaVersion, 2);
  assert.equal(ids.layoutPage, before.layoutPage);
  assert.equal(ids.shared, before.shared);

  const oldHistory = ids.history;
  env.journal.delete(oldHistory);
  ids = await ensureContainers();
  assert.notEqual(ids.history, oldHistory);
  assert.equal(env.journal.get(ids.history).flags[MODULE_ID].container, "history");
  assert.equal(env.journal.get(ids.history).pages.get(ids.historyPage).type, "fvtt-journalinator.history");
  assert.deepEqual(getContainerIds(), ids);
});

test("a legacy secrets container is preserved in settings and only hidden from the sidebar", async () => {
  const legacy = await JournalEntry.create({
    name: "Journalinator: GM Secrets",
    flags: { [MODULE_ID]: { container: "secrets" } }
  });
  const oldStats = await JournalEntryPage.create({
    name: "__stats__",
    type: "fvtt-journalinator.stats",
    system: {}
  }, { parent: containers.shared });
  const pageCount = pageTypes().length;
  const before = getContainerIds();
  const withLegacy = { ...before, secrets: legacy.id };
  await game.settings.set(MODULE_ID, "containerIds", withLegacy);

  const ids = await ensureContainers();
  assert.equal(ids.secrets, legacy.id);
  assert.equal(ids.shared, before.shared);
  assert.equal(ids.history, before.history);
  assert.equal(ids.private, before.private);
  assert.ok(env.journal.get(legacy.id), "legacy container must not be deleted");
  assert.ok(containers.shared.pages.get(oldStats.id), "legacy stats page must not be deleted");
  assert.deepEqual(getContainerIds().secrets, legacy.id);
  assert.equal(pageTypes().length, pageCount, "ensureContainers must not recreate or delete legacy pages");

  globalThis.HTMLElement ??= class HTMLElement {};
  const removed = [];
  const element = {
    querySelector(selector) {
      const match = /data-entry-id="([^"]+)"/.exec(selector);
      return match ? { remove: () => removed.push(match[1]) } : null;
    }
  };

  registerSidebarHiding();
  Hooks.callAll("renderJournalDirectory", {}, [element]);

  assert.deepEqual(new Set(removed), new Set([
    ids.shared, ids.history, ids.private, ids.secrets
  ]));
});
