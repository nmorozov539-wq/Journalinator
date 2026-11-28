import { test } from "node:test";
import assert from "node:assert/strict";
import { Hooks, installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";
import {
  activityFor, recordActivityEvent, mergeCounters, todayUTC,
  registerActivityHooks, BOARD_NOTE_ID
} from "../scripts/activity.mjs";

const MODULE_ID = "fvtt-journalinator";
const gm = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const player = makeUser("Player0000000001", { name: "Player" });
const env = installFoundry({ user: gm, users: [gm, player] });
const containers = await makeContainers(env);
registerActivityHooks();

function activityPage() {
  return containers.shared.pages.get(containers.ids.activityPage);
}

function storedActivity() {
  return activityPage()?.system?.activity ?? {};
}

async function waitFor(check, message = "condition") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${message}`);
}

let seq = 0;
function ids(label) {
  seq += 1;
  return {
    noteId: `${label}Note${String(seq).padStart(8, "0")}`,
    userId: `${label}User${String(seq).padStart(8, "0")}`
  };
}

function countersAt(date, userId, noteId) {
  return activityFor(date, userId, noteId);
}

test("a template creation counts creation, characters and one template insert", async () => {
  const { noteId, userId } = ids("Create");
  const at = Date.UTC(2026, 0, 2, 23, 30);
  const body = "# Template\n\nSome body text";

  Hooks.callAll("journalinatorNoteCreated", {
    noteId, authorId: userId, body, revision: 0, source: "create", createdAt: at
  });
  await waitFor(() => countersAt("2026-01-02", userId, noteId).notesCreated === 1, "creation");

  const counters = countersAt("2026-01-02", userId, noteId);
  assert.equal(counters.notesCreated, 1);
  assert.equal(counters.charsAdded, Array.from(body).length);
  assert.equal(counters.templateInsertCount, 1);
  assert.equal(counters.imagesAdded, 0);
  assert.equal(counters.titlesSet, 0);
  assert.equal(counters.saveCount, 0);
});

test("a pasted note counts images and a title, but not a template insert", async () => {
  const { noteId, userId } = ids("Paste");
  const at = Date.UTC(2026, 1, 3, 12);
  const body = "# Pasted title\n\n![alt](https://example.test/pic.png)";

  Hooks.callAll("journalinatorNoteCreated", {
    noteId, authorId: userId, body, revision: 0, source: "paste", createdAt: at
  });
  await waitFor(() => countersAt("2026-02-03", userId, noteId).notesCreated === 1, "paste creation");

  const counters = countersAt("2026-02-03", userId, noteId);
  assert.equal(counters.notesCreated, 1);
  assert.equal(counters.charsAdded, Array.from(body).length);
  assert.equal(counters.templateInsertCount, 0);
  assert.equal(counters.imagesAdded, 1);
  assert.equal(counters.titlesSet, 1);
});

test("a durable save records a real diff and deduplicated event counters", async () => {
  const { noteId, userId } = ids("Save");
  const at = Date.UTC(2026, 2, 4, 8);

  Hooks.callAll("journalinatorNoteSaved", {
    noteId,
    authorId: userId,
    previousBody: "hello",
    body: "hello world",
    previousRevision: 1,
    revision: 2,
    saveIdentity: {
      requestId: "request-save-1",
      eventIds: ["template:t1", "paste-large:p1", "paste-large:p2", "paste-large:p1"],
      at
    }
  });
  await waitFor(() => countersAt("2026-03-04", userId, noteId).saveCount === 1, "save");

  const counters = countersAt("2026-03-04", userId, noteId);
  assert.equal(counters.charsAdded, 6);
  assert.equal(counters.charsRemoved, 0);
  assert.equal(counters.saveCount, 1);
  assert.equal(counters.largePasteCount, 2, "distinct paste-large ids only");
  assert.equal(counters.templateInsertCount, 1, "distinct template ids only");
  assert.equal(counters.notesCreated, 0);
});

test("a save counts title changes and positive image multiset differences", async () => {
  const { noteId, userId } = ids("SaveMeta");
  const at = Date.UTC(2026, 3, 5, 9);
  const previousBody = "# Old\n\n![](https://a.test/a.png)\nbody";
  const body = "# New\n\n![](https://a.test/a.png)\n![](https://b.test/b.png)\nbody";

  Hooks.callAll("journalinatorNoteSaved", {
    noteId, authorId: userId, previousBody, body,
    previousRevision: 2, revision: 3,
    saveIdentity: { requestId: "request-save-meta", eventIds: [], at }
  });
  await waitFor(() => countersAt("2026-04-05", userId, noteId).saveCount === 1, "metadata save");

  const counters = countersAt("2026-04-05", userId, noteId);
  assert.equal(counters.titlesSet, 1);
  assert.equal(counters.imagesAdded, 1);
  assert.equal(counters.saveCount, 1);
  assert.ok(counters.charsAdded > 0);
  assert.ok(counters.charsRemoved > 0);
});

test("removing a title does not count as setting one", async () => {
  const { noteId, userId } = ids("TitleRemove");
  const at = Date.UTC(2026, 3, 6, 9);

  Hooks.callAll("journalinatorNoteSaved", {
    noteId, authorId: userId,
    previousBody: "# Title\nbody", body: "body",
    previousRevision: 1, revision: 2,
    saveIdentity: { requestId: "request-title-remove", eventIds: [], at }
  });
  await waitFor(() => countersAt("2026-04-06", userId, noteId).saveCount === 1, "title removal save");

  assert.equal(countersAt("2026-04-06", userId, noteId).titlesSet, 0);
});

test("a no-op save produces no counters even with event ids", async () => {
  const { noteId, userId } = ids("Noop");
  const at = Date.UTC(2026, 4, 7, 10);

  Hooks.callAll("journalinatorNoteSaved", {
    noteId, authorId: userId, previousBody: "same", body: "same",
    previousRevision: 1, revision: 1,
    saveIdentity: { requestId: "request-noop", eventIds: ["paste-large:p1"], at }
  });
  await new Promise(resolve => setTimeout(resolve, 50));

  const counters = countersAt("2026-05-07", userId, noteId);
  assert.equal(Object.values(counters).every(value => value === 0), true);
});

test("thread hooks attribute note relationships and use the board sentinel", async () => {
  const { noteId, userId } = ids("Thread");
  const at = new Date();
  const date = todayUTC(at);

  Hooks.callAll("journalinatorThreadCreated", {
    noteId, linkId: "link-1", targetId: "target-1", authorId: userId,
    kind: "note-link", board: false
  });
  await waitFor(() => countersAt(date, userId, noteId).threadsCreated === 1, "note thread");

  Hooks.callAll("journalinatorThreadCreated", {
    noteId: "", linkId: "link-2", targetId: "target-1", authorId: userId,
    kind: "pin-link", board: true
  });
  await waitFor(() => countersAt(date, userId, BOARD_NOTE_ID).threadsCreated === 1, "board thread");

  // A split/replacement is another committed relationship and counts once per hook.
  Hooks.callAll("journalinatorThreadCreated", {
    noteId, linkId: "link-3", targetId: "target-1", authorId: userId,
    kind: "pin-link", board: false, replacesLinkId: "link-1"
  });
  await waitFor(() => countersAt(date, userId, noteId).threadsCreated === 2, "replacement thread");
});

test("UTC day buckets do not follow local midnight", () => {
  const late = Date.UTC(2026, 4, 6, 23, 59);
  assert.equal(todayUTC(late), "2026-05-06");
  const early = Date.UTC(2026, 4, 7, 0, 1);
  assert.equal(todayUTC(early), "2026-05-07");
});

test("the activity page stores counters only, never text, titles or URLs", async () => {
  const { noteId, userId } = ids("Privacy");
  const at = Date.UTC(2026, 5, 8, 11);
  const body = "# Secret Title\n\nprivate body words ![x](https://secret.test/image.png)";

  Hooks.callAll("journalinatorNoteCreated", {
    noteId, authorId: userId, body, revision: 0, source: "paste", createdAt: at
  });
  await waitFor(() => countersAt("2026-06-08", userId, noteId).notesCreated === 1, "private-shaped creation");

  const serialized = JSON.stringify(storedActivity());
  assert.equal(serialized.includes("Secret Title"), false);
  assert.equal(serialized.includes("private body words"), false);
  assert.equal(serialized.includes("secret.test"), false);
  assert.equal(storedActivity()["2026-06-08"][userId][noteId].notesCreated, 1);
});

test("a duplicated save hook invocation is counted once in this GM session", async () => {
  const { noteId, userId } = ids("Dedupe");
  const at = Date.UTC(2026, 6, 9, 12);
  const payload = {
    noteId,
    authorId: userId,
    previousBody: "before",
    body: "after",
    previousRevision: 1,
    revision: 2,
    saveIdentity: { requestId: "same-request", eventIds: [], at }
  };

  Hooks.callAll("journalinatorNoteSaved", payload);
  Hooks.callAll("journalinatorNoteSaved", payload);
  await waitFor(() => countersAt("2026-07-09", userId, noteId).saveCount === 1, "deduped save");
  await new Promise(resolve => setTimeout(resolve, 40));

  const counters = countersAt("2026-07-09", userId, noteId);
  assert.equal(counters.saveCount, 1);
  assert.equal(counters.charsAdded, 3);
  assert.equal(counters.charsRemoved, 4);
});

test("private-named hooks never create shared activity", async () => {
  const before = JSON.stringify(storedActivity());
  Hooks.callAll("journalinatorPrivateNoteCreated", {
    noteId: "PrivateNote0001", authorId: player.id, body: "private", source: "create"
  });
  Hooks.callAll("journalinatorPrivateNoteSaved", {
    noteId: "PrivateNote0001", authorId: player.id, previousBody: "", body: "private"
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(JSON.stringify(storedActivity()), before);
});

test("recordActivityEvent is a pure calculation and mergeCounters clamps additions", async () => {
  const { noteId, userId } = ids("Pure");
  const record = recordActivityEvent({
    type: "noteSaved", noteId, authorId: userId,
    previousBody: "abc", body: "abXc", at: Date.UTC(2026, 7, 10), saveIdentity: {}
  });
  assert.equal(record.date, "2026-08-10");
  assert.equal(record.counters.charsAdded, 1);
  assert.equal(record.counters.saveCount, 1);
  assert.equal(storedActivity()["2026-08-10"], undefined, "the pure calculation does not write");

  const merged = await mergeCounters("2026-08-10", userId, noteId, {
    charsAdded: 2, saveCount: -5, bogus: 100
  });
  assert.equal(merged.charsAdded, 2);
  assert.equal(merged.saveCount, 0);
  assert.equal("bogus" in merged, false);
});
