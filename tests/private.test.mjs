import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";

const gm = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const first = makeUser("Player000000001", { name: "First" });
const second = makeUser("Player000000002", { name: "Second" });
const third = makeUser("Player000000003", { name: "Third" });
const env = installFoundry({ user: gm, users: [gm, first, second, third] });
const containers = await makeContainers(env);
const { privateStore, emptyWorkspace } = await import("../scripts/store/private-store.mjs");

test("creates one active workspace per profile", async () => {
  const page = await privateStore.createFor(first);
  assert.equal(page.type, "text", "uses a core page type so stale manifests can still create it");
  assert.ok(privateStore.flags(page).workspace, "workspace payload is stored in flags");
  assert.equal(privateStore.findActive(first.id)?.id, page.id);
  assert.equal(privateStore.flags(page).state, "active");
  assert.equal(privateStore.flags(page).ownerUserId, first.id);
  assert.equal(page.ownership[first.id], CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
  assert.equal(page.name, "First — Private");
  assert.deepEqual(privateStore.read(page), emptyWorkspace());
  assert.equal((await privateStore.createFor(first)).id, page.id, "does not create a duplicate");
});

test("workspace names are unique and renameable", async () => {
  const page = privateStore.findActive(first.id);
  await privateStore.rename(page, "Field notes");
  assert.equal(page.name, "Field notes");
  await assert.rejects(privateStore.rename(page, ""), /empty/);
  const secondPage = await privateStore.createFor(second);
  await assert.rejects(privateStore.rename(secondPage, "field notes"), /already/);
});

test("a detached workspace can be assigned and accepted by another player", async () => {
  const page = privateStore.findActive(first.id);
  await privateStore.detach(page);
  assert.equal(privateStore.flags(page).state, "orphaned");
  assert.equal(privateStore.findActive(first.id), null);

  await privateStore.assign(page, third.id);
  assert.equal(privateStore.findPending(third.id)?.id, page.id);
  assert.equal(privateStore.findActive(third.id), null);

  await privateStore.accept(page, third.id);
  assert.equal(privateStore.findActive(third.id)?.id, page.id);
  assert.equal(privateStore.findPending(third.id), null);
  assert.equal(page.ownership[third.id], CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
});

test("a player with a workspace cannot be assigned another", async () => {
  const page = privateStore.findActive(second.id);
  await privateStore.detach(page);
  await privateStore.createFor(second);
  await assert.rejects(privateStore.assign(page, second.id), /already/);
});

test("saving increments the revision and rejects a stale writer", async () => {
  const page = privateStore.findActive(second.id);
  const data = privateStore.read(page);
  data.notes.note = {
    id: "note", title: "Note", kind: "note", style: "sticky", targetHeading: "",
    image: null, backgroundImage: null,
    blocks: [{ blockId: "block", text: "hello" }], createdAt: 1, updatedAt: 1
  };
  const firstSave = await privateStore.save(page, data, 0);
  assert.equal(firstSave.rev, 1);
  await assert.rejects(privateStore.save(page, data, 0), /another session/);
  assert.equal(privateStore.read(page).notes.note.blocks[0].text, "hello");
});

test("archiving and deleting remove the workspace from active use", async () => {
  const page = privateStore.findActive(second.id);
  await privateStore.archive(page);
  assert.equal(privateStore.flags(page).state, "archived");
  assert.equal(privateStore.findActive(second.id), null);
  await privateStore.remove(page);
  assert.equal(privateStore.findById(page.id), null);
  assert.ok(containers.private);
});

test("a deleted player's workspace is kept and becomes orphaned", async () => {
  const orphan = makeUser("Player000000004", { name: "Orphan" });
  const page = await privateStore.createFor(orphan);
  assert.equal(await privateStore.orphanUser(orphan.id), 1);
  assert.equal(privateStore.flags(page).state, "orphaned");
  assert.equal(privateStore.flags(page).ownerUserId, null);
  assert.ok(privateStore.findById(page.id), "workspace data is not deleted");
});
