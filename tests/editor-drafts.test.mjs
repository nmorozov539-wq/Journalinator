import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DraftStore,
  DRAFT_TTL_MS,
  DRAFT_LIST_LIMIT,
  DRAFT_KEY_PREFIX
} from "../scripts/editor/drafts.mjs";

function makeClock(start = 1000000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms = 0) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const timer of timers.values()) {
          if (timer.at > target) continue;
          if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) {
            next = timer;
          }
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = target;
    }
  };
}

class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.failSet = null;
    this.failGet = null;
  }

  get length() {
    return this.map.size;
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key) {
    if (this.failGet) throw this.failGet;
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    if (this.failSet) throw this.failSet;
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

const BASE = {
  origin: "https://test.invalid",
  worldId: "world-1",
  userId: "user-1",
  canvasId: "shared"
};

function record(body, overrides = {}) {
  return {
    body,
    baseRevision: 1,
    acknowledgedBody: "base",
    acknowledgedRevision: 1,
    at: 0,
    ...overrides
  };
}

function makeStore(storage, { timers, now, ...overrides } = {}) {
  return new DraftStore({ ...BASE, storage, timers, now, ...overrides });
}

test("keys isolate origin, world, user, canvas, note and session", () => {
  const storage = new MemoryStorage();
  const clock = makeClock();
  const store = makeStore(storage, { timers: clock, now: clock.now });
  const key = store.keyFor("note-1", "session-1");
  assert.ok(key.startsWith(DRAFT_KEY_PREFIX));
  assert.equal(key, "journalinator.draft.https%3A%2F%2Ftest%2Einvalid.world-1.user-1.shared.note-1.session-1");

  const variants = [
    { origin: "https://other.invalid" },
    { worldId: "world-2" },
    { userId: "user-2" },
    { canvasId: "private" }
  ];
  for (const variant of variants) {
    const other = makeStore(storage, { timers: clock, now: clock.now, ...variant });
    assert.notEqual(other.keyFor("note-1", "session-1"), key, JSON.stringify(variant));
  }
  assert.notEqual(store.keyFor("note-2", "session-1"), key);
  assert.notEqual(store.keyFor("note-1", "session-2"), key);

  const worldTwo = makeStore(storage, { timers: clock, now: clock.now, worldId: "world-2" });
  assert.equal(store.save("note-1", "session-1", record("A")), true);
  assert.equal(worldTwo.save("note-1", "session-1", record("B")), true);
  assert.equal(store.load("note-1", "session-1").body, "A");
  assert.equal(worldTwo.load("note-1", "session-1").body, "B");
  assert.equal(storage.map.size, 2);
});

test("queued writes coalesce on one 150 ms timer and flush writes immediately", () => {
  const storage = new MemoryStorage();
  const clock = makeClock();
  const store = makeStore(storage, { timers: clock, now: clock.now });

  assert.equal(store.queueSave("note-1", "session-1", record("first")), true);
  assert.equal(store.queueSave("note-1", "session-1", record("second")), true);
  assert.equal(store.queueSave("note-2", "session-2", record("other")), true);
  clock.advance(149);
  assert.equal(storage.map.size, 0);
  clock.advance(1);
  assert.equal(storage.map.size, 2);
  assert.equal(store.load("note-1", "session-1").body, "second");
  assert.equal(store.load("note-2", "session-2").body, "other");

  assert.equal(store.queueSave("note-3", "session-3", record("immediate")), true);
  assert.equal(store.flush(), true);
  assert.equal(store.load("note-3", "session-3").body, "immediate");
  clock.advance(1000);
  assert.equal(storage.map.size, 3);

  assert.equal(typeof store.flushPending, "function");
  assert.equal(store.flushPending(), true);
});

test("prune removes 30-day-old drafts, acknowledged drafts and corrupt entries", () => {
  const storage = new MemoryStorage();
  let now = 4_000_000_000;
  const store = makeStore(storage, { now: () => now });

  store.save("old", "s", record("old", { at: now - DRAFT_TTL_MS - 1 }));
  store.save("recent", "s", record("recent", { at: now - 1000 }));
  store.save("acknowledged", "s", record("same", {
    acknowledgedBody: "same",
    at: now - 1000
  }));
  store.save("pending", "s", record("same", {
    acknowledgedBody: "same",
    pendingSequence: 4,
    pendingBodyHash: "abcd1234",
    at: now - 1000
  }));
  const corruptKey = store.keyFor("corrupt", "s");
  storage.setItem(corruptKey, "{not json");

  assert.equal(store.prune(), 3);
  assert.equal(store.load("old", "s"), null);
  assert.equal(store.load("acknowledged", "s"), null);
  assert.equal(store.load("corrupt", "s"), null);
  assert.equal(store.load("recent", "s").body, "recent");
  assert.equal(store.load("pending", "s").body, "same");

  now += DRAFT_TTL_MS + 1;
  assert.equal(store.prune(), 2);
  assert.equal(store.list().length, 0);
});

test("removing a draft is scoped to one client session", () => {
  const storage = new MemoryStorage();
  const clock = makeClock();
  const store = makeStore(storage, { timers: clock, now: clock.now });

  store.save("note-1", "session-a", record("same", { acknowledgedBody: "same" }));
  store.save("note-1", "session-b", record("same", { acknowledgedBody: "same" }));

  assert.equal(store.remove("note-1", "session-a"), true);
  assert.equal(store.load("note-1", "session-a"), null);
  assert.equal(store.load("note-1", "session-b").body, "same");
  assert.equal(storage.map.size, 1);
});

test("quota and security denials report failure without throwing or claiming success", () => {
  const storage = new MemoryStorage();
  const clock = makeClock();
  const store = makeStore(storage, { timers: clock, now: clock.now });
  storage.failSet = Object.assign(new Error("full"), { name: "QuotaExceededError" });

  assert.equal(store.save("note-1", "session-1", record("A")), false);
  assert.equal(store.isAvailable(), false);
  assert.equal(store.lastError(), "QuotaExceededError");
  assert.equal(store.queueSave("note-1", "session-1", record("B")), true);
  assert.equal(store.flush(), false);
  assert.equal(store.isAvailable(), false);

  storage.failSet = null;
  assert.equal(store.save("note-1", "session-1", record("C")), true);
  assert.equal(store.isAvailable(), true);
  assert.equal(store.lastError(), null);
  assert.equal(store.load("note-1", "session-1").body, "C");

  const deniedError = Object.assign(new Error("denied"), { name: "SecurityError" });
  const deniedStorage = {
    get length() { throw deniedError; },
    key() { throw deniedError; },
    getItem() { throw deniedError; },
    setItem() { throw deniedError; },
    removeItem() { throw deniedError; }
  };
  const denied = makeStore(deniedStorage, { timers: clock, now: clock.now });
  assert.equal(denied.save("note-1", "session-1", record("A")), false);
  assert.equal(denied.load("note-1", "session-1"), null);
  assert.equal(denied.remove("note-1", "session-1"), false);
  assert.equal(denied.isAvailable(), false);
  assert.equal(denied.lastError(), "SecurityError");
  assert.deepEqual(denied.list(), []);
  assert.equal(denied.prune(), 0);
  assert.equal(denied.queueSave("note-1", "session-1", record("B")), true);
  assert.equal(denied.flush(), false);
});

test("list is bounded and exposes note/session identity", () => {
  const storage = new MemoryStorage();
  const clock = makeClock();
  const store = makeStore(storage, { timers: clock, now: clock.now });

  for (let index = 0; index < DRAFT_LIST_LIMIT + 20; index += 1) {
    store.save(`note-${index}`, "session-1", record(`body-${index}`, { at: clock.now() }));
  }
  const listed = store.list();
  assert.equal(listed.length, DRAFT_LIST_LIMIT);
  assert.equal(typeof listed[0].noteId, "string");
  assert.equal(listed[0].clientSessionId, "session-1");
  assert.equal(typeof listed[0].body, "string");
});

test("missing storage is inert and never throws", () => {
  const store = new DraftStore({ ...BASE, storage: null, now: () => 1000 });
  assert.equal(store.isAvailable(), false);
  assert.equal(store.lastError(), "unavailable");
  assert.equal(store.save("note", "session", record("A")), false);
  assert.equal(store.load("note", "session"), null);
  assert.equal(store.remove("note", "session"), false);
  assert.equal(store.prune(), 0);
  assert.deepEqual(store.list(), []);
  assert.equal(store.queueSave("note", "session", record("B")), true);
  assert.equal(store.flush(), false);
});
