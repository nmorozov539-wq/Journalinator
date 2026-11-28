import { test } from "node:test";
import assert from "node:assert/strict";
import { Hooks, installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";
import {
  MAX_SNAPSHOTS, CHECKPOINT_MS,
  listHistory, addHistorySnapshot, captureSessionStart, checkpointIfDue,
  recordPreRestore, deleteHistory, registerHistoryHooks
} from "../scripts/history.mjs";
import { getContainerIds } from "../scripts/store/containers.mjs";

const MODULE_ID = "fvtt-journalinator";
const gm = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const player = makeUser("Player0000000001", { name: "Player" });
const env = installFoundry({ user: gm, users: [gm, player] });
const containers = await makeContainers(env);
registerHistoryHooks();

let noteSeq = 0;
function nextNoteId(label) {
  noteSeq += 1;
  return `${label}${String(noteSeq).padStart(8, "0")}`;
}

async function createNote(body = "", revision = 0) {
  return JournalEntryPage.create({
    name: `note-${noteSeq}`,
    type: `${MODULE_ID}.note`,
    system: { body, revision }
  }, { parent: containers.shared });
}

async function waitFor(check, message = "condition") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${message}`);
}

test("add/list keeps snapshots newest-first with text-only fields", async () => {
  const noteId = nextNoteId("HistList");
  assert.deepEqual(listHistory(noteId), []);

  assert.equal(await addHistorySnapshot(noteId, {
    body: "first", revision: 1, authorId: "user-a", at: 1000
  }), true);
  assert.equal(await addHistorySnapshot(noteId, {
    body: "second", revision: 2, authorId: "user-b", at: 2000
  }), true);

  const list = listHistory(noteId);
  assert.deepEqual(list.map(entry => entry.body), ["second", "first"]);
  assert.deepEqual(Object.keys(list[0]).sort(), ["at", "authorId", "body", "id", "revision"]);
  assert.equal(list[0].revision, 2);
  assert.equal(list[0].authorId, "user-b");
  assert.equal(typeof list[0].id, "string");
});

test("the ring keeps at most 20 distinct bodies", async () => {
  const noteId = nextNoteId("HistCap");
  for (let index = 0; index < 25; index += 1) {
    await addHistorySnapshot(noteId, {
      body: `version ${index}`, revision: index, authorId: "user", at: 10_000 + index
    });
  }
  const list = listHistory(noteId);
  assert.equal(list.length, MAX_SNAPSHOTS);
  assert.equal(list[0].body, "version 24");
  assert.equal(list.at(-1).body, "version 5");
  assert.equal(new Set(list.map(entry => entry.body)).size, MAX_SNAPSHOTS);
});

test("a duplicate body is never stored twice; an older duplicate moves to newest", async () => {
  const noteId = nextNoteId("HistDup");
  await addHistorySnapshot(noteId, { body: "alpha", revision: 1, authorId: "user", at: 100 });
  await addHistorySnapshot(noteId, { body: "beta", revision: 2, authorId: "user", at: 200 });
  await addHistorySnapshot(noteId, { body: "alpha", revision: 3, authorId: "user", at: 300 });

  let list = listHistory(noteId);
  assert.deepEqual(list.map(entry => entry.body), ["alpha", "beta"]);
  assert.equal(list.length, 2);
  assert.equal(list[0].revision, 3);

  // Adding the body that is already newest is a no-op.
  assert.equal(await addHistorySnapshot(noteId, {
    body: "alpha", revision: 4, authorId: "user", at: 400
  }), false);
  list = listHistory(noteId);
  assert.deepEqual(list.map(entry => entry.body), ["alpha", "beta"]);
  assert.equal(list[0].revision, 3);
});

test("periodic checkpoints wait 60 seconds and skip unchanged bodies", async () => {
  const noteId = nextNoteId("HistCheckpoint");
  await addHistorySnapshot(noteId, { body: "base", revision: 1, authorId: "user", at: 0 });

  assert.equal(await checkpointIfDue(noteId, "next", 2, "user", 30_000), false);
  assert.equal(await checkpointIfDue(noteId, "next", 2, "user", CHECKPOINT_MS), true);
  assert.deepEqual(listHistory(noteId).map(entry => entry.body), ["next", "base"]);

  assert.equal(await checkpointIfDue(noteId, "next-2", 3, "user", CHECKPOINT_MS + 59_999), false);
  assert.equal(await checkpointIfDue(noteId, "next", 3, "user", CHECKPOINT_MS * 10), false,
    "an unchanged body is skipped even after the cooldown");
  assert.equal(await checkpointIfDue(noteId, "next-2", 3, "user", CHECKPOINT_MS * 2), true);
  assert.deepEqual(listHistory(noteId).map(entry => entry.body), ["next-2", "next", "base"]);
});

test("edit begin captures the confirmed body and edit end captures the final body", async () => {
  const noteId = nextNoteId("HistHooks");
  const page = await createNote("confirmed start", 4);

  Hooks.callAll("journalinatorNoteEditBegan", {
    noteId: page.id, authorId: player.id, revision: 4, body: "confirmed start"
  });
  await waitFor(() => listHistory(page.id).length === 1, "session-start checkpoint");
  assert.equal(listHistory(page.id)[0].body, "confirmed start");

  await page.update({ "system.body": "final saved body", "system.revision": 5 });
  Hooks.callAll("journalinatorNoteEditEnded", {
    noteId: page.id, authorId: player.id, revision: 5, saved: true
  });
  await waitFor(() => listHistory(page.id)[0]?.body === "final saved body", "session-end checkpoint");
  assert.deepEqual(listHistory(page.id).map(entry => entry.body), [
    "final saved body", "confirmed start"
  ]);

  // Ending without saving and with the confirmed body already newest is a no-op.
  const before = listHistory(page.id).length;
  Hooks.callAll("journalinatorNoteEditEnded", {
    noteId: page.id, authorId: player.id, revision: 5, saved: false
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(listHistory(page.id).length, before);
  void noteId;
});

test("pre-restore capture ignores the checkpoint cooldown", async () => {
  const noteId = nextNoteId("HistRestore");
  const now = Date.now();
  await addHistorySnapshot(noteId, { body: "older version", revision: 1, authorId: "user", at: now });
  assert.equal(await recordPreRestore(noteId, "current before restore", 2, "user"), true);
  assert.deepEqual(listHistory(noteId).map(entry => entry.body), [
    "current before restore", "older version"
  ]);
});

test("trash retains history; permanent deletion hook removes it", async () => {
  const noteId = nextNoteId("HistTrash");
  const page = await createNote("trashed text", 1);
  await addHistorySnapshot(page.id, { body: "trashed text", revision: 1, authorId: "user", at: 100 });

  await page.update({ "system.deleted": Date.now() });
  assert.equal(listHistory(page.id).length, 1, "soft delete must not clear history");

  Hooks.callAll("journalinatorNotesPermanentlyDeleted", {
    noteIds: [page.id], byUserId: gm.id
  });
  await waitFor(() => listHistory(page.id).length === 0, "permanent-delete cleanup");
  void noteId;
});

test("missing history page is a no-op, never an unexpected create or throw", async () => {
  const ids = getContainerIds();
  await game.settings.set(MODULE_ID, "containerIds", { ...ids, historyPage: "MissingPage000001" });
  try {
    assert.deepEqual(listHistory("AnyNote000000001"), []);
    assert.equal(await addHistorySnapshot("AnyNote000000001", {
      body: "ignored", revision: 0, authorId: "user", at: 1
    }), false);
    assert.equal(await deleteHistory(["AnyNote000000001"]), false);
  } finally {
    await game.settings.set(MODULE_ID, "containerIds", ids);
  }
});

test("history listeners only act on the active GM", async () => {
  const noteId = nextNoteId("HistGM");
  game.user = player;
  try {
    Hooks.callAll("journalinatorNoteEditBegan", {
      noteId, authorId: player.id, revision: 0, body: "player side"
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(listHistory(noteId), []);
  } finally {
    game.user = gm;
  }
});
