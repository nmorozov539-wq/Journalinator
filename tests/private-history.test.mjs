import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SNAPSHOTS,
  CHECKPOINT_MS,
  privateHistoryList,
  privateSnapshot,
  appendPrivateSnapshot,
  checkpointPrivateHistory,
  deletePrivateHistory
} from "../scripts/private/private-history.mjs";

function workspace() {
  return {
    format: 3,
    notes: { noteA: { body: "" }, noteB: { body: "" } },
    layout: { cards: {}, labels: {}, pins: {}, pinLinks: {}, viewport: null },
    trash: [],
    history: {}
  };
}

function entry(body, at = 0, revision = 0) {
  return { body, at, revision, authorId: "user-a" };
}

test("private history keeps 20 distinct snapshots newest-first without mutating input", () => {
  const source = workspace();
  let current = source;
  for (let index = 0; index < 25; index += 1) {
    current = appendPrivateSnapshot(current, "noteA", entry(`v${index}`, 1000 + index, index)).workspace;
  }

  const list = privateHistoryList(current, "noteA");
  assert.equal(list.length, MAX_SNAPSHOTS);
  assert.equal(list[0].body, "v24");
  assert.equal(list.at(-1).body, "v5");
  assert.equal(new Set(list.map(snapshot => snapshot.body)).size, MAX_SNAPSHOTS);
  assert.deepEqual(Object.keys(list[0]).sort(), ["at", "authorId", "body", "id", "revision"]);
  assert.deepEqual(source.history, {}, "the input workspace is never mutated");
  assert.deepEqual(privateHistoryList(current, "noteB"), []);
});

test("the newest duplicate is a no-op and a deeper duplicate moves to newest", () => {
  let current = workspace();
  current = appendPrivateSnapshot(current, "noteA", entry("alpha", 100)).workspace;
  current = appendPrivateSnapshot(current, "noteA", entry("beta", 200)).workspace;

  const duplicateNewest = appendPrivateSnapshot(current, "noteA", entry("beta", 300));
  assert.equal(duplicateNewest.recorded, false);
  assert.equal(duplicateNewest.workspace, current);

  const moved = appendPrivateSnapshot(current, "noteA", entry("alpha", 300, 3));
  assert.equal(moved.recorded, true);
  assert.deepEqual(privateHistoryList(moved.workspace, "noteA").map(snapshot => snapshot.body),
    ["alpha", "beta"]);
  assert.equal(privateHistoryList(moved.workspace, "noteA")[0].revision, 3);
});

test("periodic checkpoints obey CHECKPOINT_MS and force ignores it", () => {
  let current = workspace();
  current = appendPrivateSnapshot(current, "noteA", entry("base", 0)).workspace;

  const early = checkpointPrivateHistory(current, "noteA", entry("next", 30_000), { now: 30_000 });
  assert.equal(early.recorded, false);
  assert.equal(early.workspace, current);

  const due = checkpointPrivateHistory(current, "noteA", entry("next", CHECKPOINT_MS), {
    now: CHECKPOINT_MS
  });
  assert.equal(due.recorded, true);
  assert.deepEqual(privateHistoryList(due.workspace, "noteA").map(snapshot => snapshot.body),
    ["next", "base"]);

  const unchanged = checkpointPrivateHistory(due.workspace, "noteA", entry("next", CHECKPOINT_MS * 5), {
    now: CHECKPOINT_MS * 5
  });
  assert.equal(unchanged.recorded, false);

  const forced = checkpointPrivateHistory(due.workspace, "noteA", entry("restored", CHECKPOINT_MS * 5 + 1), {
    now: CHECKPOINT_MS * 5 + 1,
    force: true
  });
  assert.equal(forced.recorded, true);
  assert.equal(privateHistoryList(forced.workspace, "noteA")[0].body, "restored");
});

test("snapshot helper always produces the text-only private shape", () => {
  const snapshot = privateSnapshot({ body: "text", revision: 4, authorId: "u", at: 123 });
  assert.deepEqual(Object.keys(snapshot).sort(), ["at", "authorId", "body", "id", "revision"]);
  assert.equal(snapshot.body, "text");
  assert.equal(snapshot.revision, 4);
  assert.equal(snapshot.at, 123);
  assert.equal(typeof snapshot.id, "string");
});

test("delete removes only the requested note histories", () => {
  let current = workspace();
  current = appendPrivateSnapshot(current, "noteA", entry("a", 1)).workspace;
  current = appendPrivateSnapshot(current, "noteB", entry("b", 2)).workspace;
  const before = structuredClone(current.history.noteA);

  const result = deletePrivateHistory(current, ["noteA", "missing"]);
  assert.equal(result.removed, 1);
  assert.deepEqual(privateHistoryList(result.workspace, "noteA"), []);
  assert.deepEqual(privateHistoryList(result.workspace, "noteB").map(snapshot => snapshot.body), ["b"]);
  assert.deepEqual(current.history.noteA, before, "source is untouched");

  const none = deletePrivateHistory(result.workspace, []);
  assert.equal(none.removed, 0);
  assert.equal(none.workspace, result.workspace);
});
