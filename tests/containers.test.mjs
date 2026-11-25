import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";

const gmUser = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const env = installFoundry({ user: gmUser, users: [gmUser] });
const containers = await makeContainers(env);
const { ensureContainers, getContainerIds } = await import("../scripts/store/containers.mjs");

test("repairs missing layout and stats pages without replacing the containers", async () => {
  containers.shared.pages.delete(containers.ids.layoutPage);
  containers.shared.pages.delete(containers.ids.statsPage);

  const ids = await ensureContainers();
  assert.equal(ids.shared, containers.ids.shared);
  assert.equal(ids.history, containers.ids.history);
  assert.equal(ids.secrets, containers.ids.secrets);
  assert.notEqual(ids.layoutPage, containers.ids.layoutPage);
  assert.notEqual(ids.statsPage, containers.ids.statsPage);
  assert.equal(containers.shared.pages.get(ids.layoutPage).type, "fvtt-journalinator.layout");
  assert.equal(containers.shared.pages.get(ids.statsPage).type, "fvtt-journalinator.stats");
  assert.deepEqual(getContainerIds(), ids);
});

test("recreates a deleted container and its history page", async () => {
  const oldHistory = containers.ids.history;
  env.journal.delete(oldHistory);

  const ids = await ensureContainers();
  assert.notEqual(ids.history, oldHistory);
  assert.ok(env.journal.get(ids.history));
  assert.equal(env.journal.get(ids.history).flags["fvtt-journalinator"].container, "history");
  assert.equal(env.journal.get(ids.history).pages.get(ids.historyPage).type, "fvtt-journalinator.history");
  assert.deepEqual(getContainerIds(), ids);
});
