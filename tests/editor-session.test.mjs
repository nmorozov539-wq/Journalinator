import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NoteEditorSession,
  noteBodyHash,
  PREVIEW_MS,
  AUTOSAVE_MS,
  AUTOSAVE_MAX_MS,
  HEARTBEAT_MS
} from "../scripts/editor/session.mjs";
import { DraftStore } from "../scripts/editor/drafts.mjs";

const NOTE = "Note000000000001";
const SKIN = {
  paper: "cream",
  font: "default",
  torn: false,
  backgroundImage: null,
  tiltSeed: 7
};

function makeClock(start = 10000) {
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
    },
    pending() {
      return timers.size;
    }
  };
}

async function settle(rounds = 40) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.failSet = null;
  }

  get length() {
    return this.map.size;
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key) {
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

class FakeTransport {
  constructor(clock, { note = {}, leaseToken = "lease-token-1", gmEpoch = "epoch-1" } = {}) {
    this.clock = clock;
    this.note = note;
    this.leaseToken = leaseToken;
    this.gmEpoch = gmEpoch;
    this.calls = {
      begin: [],
      heartbeat: [],
      preview: [],
      save: [],
      appearance: [],
      end: [],
      state: []
    };
    this.events = [];
    this.deferBegin = false;
    this.beginPending = null;
    this.deferSaves = false;
    this.pendingSaves = [];
    this.beginReply = null;
    this.heartbeatImpl = null;
    this.saveImpl = null;
    this.appearanceImpl = null;
    this.endImpl = null;
    this.stateImpl = null;
  }

  now() {
    return this.clock.now();
  }

  setTimeout(fn, ms) {
    return this.clock.setTimeout(fn, ms);
  }

  clearTimeout(id) {
    this.clock.clearTimeout(id);
  }

  grant(overrides = {}) {
    return {
      type: "noteEditGranted",
      lease: {
        canvasId: "shared",
        noteId: NOTE,
        userId: "user-1",
        clientSessionId: "sess-a",
        leaseToken: this.leaseToken,
        gmEpoch: this.gmEpoch
      },
      revision: this.note.revision ?? 0,
      body: this.note.body ?? "",
      layout: this.note.layout ?? "plain",
      skin: this.note.skin ?? SKIN,
      ...overrides
    };
  }

  ackFor(args, overrides = {}) {
    return {
      type: "noteSaveAck",
      revision: (args.baseRevision ?? 0) + 1,
      sequence: args.sequence,
      bodyHash: noteBodyHash(args.body),
      ...overrides
    };
  }

  async begin(args) {
    this.calls.begin.push(args);
    if (this.deferBegin) {
      return new Promise(resolve => {
        this.beginPending = resolve;
      });
    }
    if (typeof this.beginReply === "function") return this.beginReply(args);
    if (this.beginReply) return this.beginReply;
    return this.grant();
  }

  async heartbeat(args) {
    this.calls.heartbeat.push(args);
    if (this.heartbeatImpl) return this.heartbeatImpl(args);
    return {
      type: "noteEditHeartbeatAck",
      leaseToken: args.lease.leaseToken,
      gmEpoch: args.lease.gmEpoch,
      revision: this.note.revision ?? 0
    };
  }

  preview(args) {
    this.calls.preview.push(args);
  }

  save(args) {
    this.calls.save.push(args);
    this.events.push("save");
    if (this.saveImpl) return this.saveImpl(args);
    if (this.deferSaves) {
      return new Promise((resolve, reject) => {
        this.pendingSaves.push({ args, resolve, reject });
      });
    }
    return Promise.resolve(this.ackFor(args));
  }

  appearance(args) {
    this.calls.appearance.push(args);
    if (this.appearanceImpl) return this.appearanceImpl(args);
    return Promise.resolve({
      type: "noteAppearanceAck",
      layout: args.layout,
      skin: args.skin
    });
  }

  end(args) {
    this.calls.end.push(args);
    this.events.push("end");
    if (this.endImpl) return this.endImpl(args);
    return Promise.resolve({
      type: "noteEditEnded",
      released: true,
      revision: args.baseRevision,
      saved: false
    });
  }

  state(args) {
    this.calls.state.push(args);
    if (this.stateImpl) return this.stateImpl(args);
    return Promise.resolve({ type: "timeout" });
  }

  resolveBegin(reply) {
    this.beginPending?.(reply);
    this.beginPending = null;
  }

  resolveSave(index, reply) {
    const pending = this.pendingSaves[index];
    if (!pending) throw new Error(`no pending save ${index}`);
    pending.resolve(reply ?? this.ackFor(pending.args));
    this.pendingSaves[index] = { ...pending, settled: true };
  }
}

function setup({ body = "base", revision = 2, layout = "plain", skin = SKIN } = {}) {
  const clock = makeClock();
  const note = { body, revision, layout, skin };
  const transport = new FakeTransport(clock, { note });
  const storage = new MemoryStorage();
  const drafts = new DraftStore({
    origin: "https://test.invalid",
    worldId: "world-1",
    userId: "user-1",
    canvasId: "shared",
    storage,
    now: clock.now,
    timers: clock
  });
  const session = new NoteEditorSession({
    noteId: NOTE,
    note,
    transport,
    drafts,
    clientSessionId: "sess-a",
    now: clock.now,
    timers: clock
  });
  return { clock, transport, storage, drafts, session, note };
}

test("open grants the lease and starts in editing state", async () => {
  const { session, transport } = setup();
  const result = await session.open();
  assert.equal(result.ok, true);
  assert.equal(session.state, "editing");
  assert.equal(session.lease.leaseToken, "lease-token-1");
  assert.equal(session.confirmedBody, "base");
  assert.equal(session.revision, 2);
  assert.deepEqual(session.skin, SKIN);
  assert.equal(transport.calls.heartbeat.length, 0);
});

test("a denied lease never previews or saves", async () => {
  const { session, transport, clock } = setup();
  transport.beginReply = { type: "noteEditDenied", reason: "locked" };
  const result = await session.open();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "locked");
  assert.equal(session.state, "denied");
  assert.equal(session.status().error, "locked");
  session.setBody("blocked");
  clock.advance(10000);
  await settle();
  assert.equal(transport.calls.preview.length, 0);
  assert.equal(transport.calls.save.length, 0);
  assert.equal(transport.calls.heartbeat.length, 0);
});

test("no active GM is offline, not a fake save", async () => {
  const { session, transport } = setup();
  transport.beginReply = { type: "noteEditDenied", reason: "noActiveGM" };
  const result = await session.open();
  assert.equal(result.ok, false);
  assert.equal(session.state, "offline");
  assert.equal(session.status().error, "noActiveGM");
  assert.equal(session.status().savedLocally, false);
});

test("an acquiring session keeps local text but never sends until granted", async () => {
  const { session, transport, clock } = setup();
  transport.deferBegin = true;
  const opening = session.open();
  session.setBody("typed while waiting");
  clock.advance(10000);
  await settle();
  assert.equal(transport.calls.preview.length, 0);
  assert.equal(transport.calls.save.length, 0);
  const blocked = await session.flush();
  assert.equal(blocked.type, "error");

  transport.resolveBegin(transport.grant());
  const result = await opening;
  assert.equal(result.ok, true);
  assert.equal(session.state, "editing");
  assert.equal(session.body, "typed while waiting");
  assert.equal(session.confirmedBody, "base");
  assert.equal(session.dirty, true);
});

test("previews coalesce to at most one per 150 ms and carry the latest text", async () => {
  const { session, transport, clock } = setup();
  await session.open();
  transport.calls.preview.length = 0;

  session.setBody("a");
  session.setBody("ab");
  session.setBody("abc");
  clock.advance(PREVIEW_MS - 1);
  await settle();
  assert.equal(transport.calls.preview.length, 0);
  clock.advance(1);
  await settle();
  assert.equal(transport.calls.preview.length, 1);
  assert.equal(transport.calls.preview[0].body, "abc");
  assert.equal(transport.calls.preview[0].noteId, NOTE);

  session.setBody("abcd");
  clock.advance(PREVIEW_MS);
  await settle();
  assert.equal(transport.calls.preview.length, 2);
  assert.equal(transport.calls.preview[1].body, "abcd");
});

test("composition updates local text without preview or autosave until compositionend", async () => {
  const { session, transport, clock } = setup();
  await session.open();
  transport.calls.preview.length = 0;

  session.setBody("にほ", { composing: true });
  clock.advance(2000);
  await settle();
  assert.equal(transport.calls.preview.length, 0);
  assert.equal(transport.calls.save.length, 0);
  assert.equal(session.body, "にほ");
  assert.equal(session.dirty, true);

  session.setBody("にほん", { composing: false });
  clock.advance(PREVIEW_MS);
  await settle();
  assert.equal(transport.calls.preview.length, 1);
  assert.equal(transport.calls.preview[0].body, "にほん");

  clock.advance(AUTOSAVE_MS);
  await settle();
  assert.equal(transport.calls.save.length, 1);
  assert.equal(transport.calls.save[0].body, "にほん");
});

test("autosave debounces 700 ms and a continuous typist saves within 3 s", async () => {
  {
    const { session, transport, clock } = setup();
    await session.open();
    session.setBody("one");
    clock.advance(AUTOSAVE_MS - 1);
    await settle();
    assert.equal(transport.calls.save.length, 0);
    clock.advance(1);
    await settle();
    assert.equal(transport.calls.save.length, 1);
    assert.equal(transport.calls.save[0].body, "one");
  }

  {
    const { session, transport, clock } = setup();
    await session.open();
    const firstDirtyAt = clock.now();
    for (let index = 0; index < 10; index += 1) {
      session.setBody(`t${index}`);
      clock.advance(300);
    }
    await settle();
    assert.ok(transport.calls.save.length >= 1, "continuous typing must save");
    assert.ok(clock.now() - firstDirtyAt <= AUTOSAVE_MAX_MS, "save within the 3 s cap");
  }
});

test("one in-flight save coalesces later text into one pending save", async () => {
  const { session, transport, clock, drafts } = setup();
  transport.deferSaves = true;
  await session.open();

  session.setBody("one");
  clock.advance(AUTOSAVE_MS);
  await settle();
  assert.equal(transport.calls.save.length, 1);
  const first = transport.calls.save[0];

  session.setBody("two");
  clock.advance(AUTOSAVE_MS);
  await settle();
  assert.equal(transport.calls.save.length, 1, "still one in-flight save");

  transport.resolveSave(0, {
    type: "noteSaveAck",
    revision: 3,
    sequence: first.sequence,
    bodyHash: noteBodyHash("one")
  });
  await settle();
  assert.equal(session.dirty, true, "older ack must not clear newer typing");
  assert.equal(session.confirmedBody, "one");
  assert.equal(session.body, "two");
  const draft = drafts.load(NOTE, "sess-a");
  assert.ok(draft);
  assert.equal(draft.body, "two");
  assert.equal(draft.acknowledgedBody, "one");
  assert.equal(transport.calls.save.length, 2);
  assert.equal(transport.calls.save[1].body, "two");

  transport.resolveSave(1);
  await settle();
  assert.equal(session.dirty, false);
  assert.equal(session.state, "editing");
  assert.equal(drafts.load(NOTE, "sess-a"), null);
});

test("an ack for older text with a wrong body hash keeps typing dirty", async () => {
  const { session, transport, clock } = setup();
  transport.deferSaves = true;
  await session.open();
  session.setBody("one");
  clock.advance(AUTOSAVE_MS);
  await settle();

  session.setBody("two");
  const first = transport.calls.save[0];
  transport.resolveSave(0, {
    type: "noteSaveAck",
    revision: 3,
    sequence: first.sequence,
    bodyHash: noteBodyHash("different")
  });
  await settle();
  assert.equal(session.dirty, true);
  assert.equal(session.confirmedBody, "base");
  assert.equal(session.body, "two");
});

test("a clean body returns a synthetic noop without calling save or advancing sequence", async () => {
  const { session, transport } = setup();
  await session.open();
  const before = session.sequence;
  const result = await session.flush();
  assert.deepEqual(result, { type: "noop" });
  assert.equal(transport.calls.save.length, 0);
  assert.equal(session.sequence, before);
});

test("event ids are carried by exactly one save and not repeated", async () => {
  const { session, transport } = setup();
  await session.open();
  session.addEventIds(["paste-large:one"]);
  session.setBody("pasted text");
  await session.flush({ reason: "paste" });
  await settle();

  assert.equal(transport.calls.save.length, 1);
  assert.deepEqual(transport.calls.save[0].eventIds, ["paste-large:one"]);

  session.setBody("pasted text plus typing");
  await session.flush();
  await settle();
  assert.equal(transport.calls.save.length, 2);
  assert.deepEqual(transport.calls.save[1].eventIds, []);
});

test("an ack for an older snapshot keeps a newer paste id pending", async () => {
  const { session, transport } = setup();
  transport.deferSaves = true;
  await session.open();

  session.addEventIds(["paste-large:old"]);
  session.setBody("one");
  const first = session.flush({ reason: "paste" });
  await settle();
  assert.deepEqual(transport.calls.save[0].eventIds, ["paste-large:old"]);

  session.addEventIds(["paste-large:new"]);
  session.setBody("two");
  transport.resolveSave(0, {
    type: "noteSaveAck",
    revision: 3,
    sequence: transport.calls.save[0].sequence,
    bodyHash: noteBodyHash("one")
  });
  await first;
  await settle();

  const second = session.flush();
  await settle();
  assert.equal(transport.calls.save.length, 2);
  assert.deepEqual(transport.calls.save[1].eventIds, ["paste-large:new"]);
  transport.resolveSave(1);
  await second;
  await settle();
});

test("a rejected save keeps its event id for the next retry", async () => {
  const { session, transport } = setup();
  transport.saveImpl = () => Promise.resolve({
    type: "noteSaveRejected",
    reason: "noActiveGM",
    revision: 2
  });
  await session.open();
  session.addEventIds(["paste-large:retry"]);
  session.setBody("local text");
  await session.flush();
  await settle();
  assert.equal(session.state, "offline");

  transport.saveImpl = null;
  await session.flush();
  await settle();
  assert.equal(transport.calls.save.length, 2);
  assert.deepEqual(transport.calls.save[1].eventIds, ["paste-large:retry"]);
});

test("a noteEditEnded ack clears the event ids that were sent with end", async () => {
  const { session, transport } = setup();
  await session.open();
  session.addEventIds(["paste-large:end"]);

  const result = await session.close();
  assert.equal(result.type, "noteEditEnded");
  assert.deepEqual(transport.calls.end[0].eventIds, ["paste-large:end"]);
  assert.deepEqual(session._eventIds, []);
});

test("retryConflict adopts an equal latest body as clean", async () => {
  const { session, transport, clock, drafts } = setup();
  transport.saveImpl = () => Promise.resolve({
    type: "noteSaveRejected",
    reason: "staleRevision",
    revision: 5
  });
  await session.open();
  session.setBody("local text");
  clock.advance(AUTOSAVE_MS);
  await settle();
  assert.equal(session.state, "conflict");

  transport.stateImpl = () => Promise.resolve({
    type: "noteEditState",
    notes: [{ noteId: NOTE, revision: 6, body: "local text" }]
  });
  const result = await session.retryConflict();
  assert.deepEqual(result, { ok: true, revision: 6 });
  assert.equal(session.state, "editing");
  assert.equal(session.dirty, false);
  assert.equal(session.confirmedBody, "local text");
  assert.equal(session.confirmedRevision, 6);
  assert.equal(drafts.load(NOTE, "sess-a"), null);
});

test("retryConflict never overwrites a differing latest body and keeps the draft", async () => {
  const { session, transport, clock, drafts } = setup();
  transport.saveImpl = () => Promise.resolve({
    type: "noteSaveRejected",
    reason: "staleRevision",
    revision: 5
  });
  await session.open();
  session.setBody("local text");
  clock.advance(AUTOSAVE_MS);
  await settle();
  const saveCalls = transport.calls.save.length;

  transport.stateImpl = () => Promise.resolve({
    type: "noteEditState",
    notes: [{ noteId: NOTE, revision: 7, body: "someone else" }]
  });
  const result = await session.retryConflict();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "conflictChanged");
  assert.equal(result.note.body, "someone else");
  assert.equal(result.note.revision, 7);
  assert.equal(session.state, "conflict");
  assert.equal(session.body, "local text");
  assert.equal(session.confirmedBody, "base");
  assert.equal(transport.calls.save.length, saveCalls, "no silent overwrite save");
  assert.equal(drafts.load(NOTE, "sess-a").body, "local text");
});

test("retryConflict reports offline when the latest state is unavailable", async () => {
  {
    const { session, transport, clock } = setup();
    transport.saveImpl = () => Promise.resolve({
      type: "noteSaveRejected",
      reason: "staleRevision",
      revision: 5
    });
    await session.open();
    session.setBody("local text");
    clock.advance(AUTOSAVE_MS);
    await settle();
    transport.stateImpl = () => { throw new Error("state unavailable"); };
    const result = await session.retryConflict();
    assert.deepEqual(result, { ok: false, reason: "offline" });
    assert.equal(session.state, "conflict");
    assert.equal(session.body, "local text");
  }

  {
    const { session, transport, clock } = setup();
    transport.saveImpl = () => Promise.resolve({
      type: "noteSaveRejected",
      reason: "staleRevision",
      revision: 5
    });
    await session.open();
    session.setBody("local text");
    clock.advance(AUTOSAVE_MS);
    await settle();
    transport.stateImpl = () => Promise.resolve({ type: "timeout" });
    const result = await session.retryConflict();
    assert.deepEqual(result, { ok: false, reason: "offline" });
  }
});

test("staleRevision becomes a conflict, keeps the draft and does not retry", async () => {
  const { session, transport, clock, drafts } = setup();
  transport.saveImpl = () => Promise.resolve({
    type: "noteSaveRejected",
    reason: "staleRevision",
    revision: 9
  });
  await session.open();
  session.setBody("local text");
  clock.advance(AUTOSAVE_MS);
  await settle();

  assert.equal(session.state, "conflict");
  assert.equal(session.status().error, "staleRevision");
  assert.equal(session.dirty, true);
  assert.equal(session.confirmedRevision, 9);
  assert.equal(session.body, "local text");
  assert.ok(drafts.load(NOTE, "sess-a"));

  clock.advance(10000);
  await settle();
  assert.equal(transport.calls.save.length, 1, "no blind retry after a rejection");
  assert.equal(session.state, "conflict");
});

test("tooLarge and invalid rejections become rejected and retain the draft", async () => {
  for (const reason of ["tooLarge", "invalid"]) {
    const { session, transport, clock, drafts } = setup();
    transport.saveImpl = () => Promise.resolve({
      type: "noteSaveRejected",
      reason,
      revision: 2
    });
    await session.open();
    session.setBody("x".repeat(10));
    clock.advance(AUTOSAVE_MS);
    await settle();
    assert.equal(session.state, "rejected");
    assert.equal(session.status().error, reason);
    assert.equal(session.dirty, true);
    assert.ok(drafts.load(NOTE, "sess-a"));
    clock.advance(10000);
    await settle();
    assert.equal(transport.calls.save.length, 1);
  }
});

test("editing recovers from a tooLarge or invalid rejection and saves on the next autosave", async () => {
  for (const reason of ["tooLarge", "invalid"]) {
    const { session, transport, clock } = setup();
    transport.saveImpl = args => Promise.resolve(
      transport.calls.save.length === 1
        ? { type: "noteSaveRejected", reason, revision: 2 }
        : transport.ackFor(args)
    );
    await session.open();
    session.setBody("x".repeat(20));
    clock.advance(AUTOSAVE_MS);
    await settle();
    assert.equal(session.state, "rejected");
    assert.equal(session.status().error, reason);
    assert.equal(transport.calls.save.length, 1);

    const previews = transport.calls.preview.length;
    session.setBody("fixed");
    assert.equal(session.state, "editing");
    assert.equal(session.status().error, null);
    assert.equal(session.dirty, true);

    clock.advance(PREVIEW_MS);
    await settle();
    assert.equal(transport.calls.preview.length, previews + 1, "preview resumes after the edit");

    clock.advance(AUTOSAVE_MS);
    await settle();
    assert.equal(transport.calls.save.length, 2, "autosave fires after the edit");
    assert.equal(transport.calls.save[1].body, "fixed");
    assert.equal(session.state, "editing");
    assert.equal(session.dirty, false);
  }
});

test("a conflict is not recovered by editing", async () => {
  const { session, transport, clock } = setup();
  transport.saveImpl = () => Promise.resolve({
    type: "noteSaveRejected",
    reason: "staleRevision",
    revision: 9
  });
  await session.open();
  session.setBody("local text");
  clock.advance(AUTOSAVE_MS);
  await settle();
  assert.equal(session.state, "conflict");

  session.setBody("local text edited");
  assert.equal(session.state, "conflict");
  assert.equal(transport.calls.save.length, 1);

  clock.advance(10000);
  await settle();
  assert.equal(transport.calls.save.length, 1);
  assert.equal(session.state, "conflict");
});

test("a leaseLost session is not recovered by editing", async () => {
  const { session, transport, clock } = setup();
  transport.saveImpl = () => Promise.resolve({
    type: "noteSaveRejected",
    reason: "leaseLost",
    revision: 3
  });
  await session.open();
  session.setBody("lost text");
  clock.advance(AUTOSAVE_MS);
  await settle();
  assert.equal(session.state, "leaseLost");
  assert.equal(session.lease, null);

  session.setBody("more lost text");
  assert.equal(session.state, "leaseLost");
  assert.equal(session.lease, null);

  clock.advance(10000);
  await settle();
  assert.equal(transport.calls.save.length, 1);
  assert.equal(session.state, "leaseLost");
});

test("leaseLost and forced stop timers and keep the local draft", async () => {
  {
    const { session, transport, clock, drafts } = setup();
    transport.saveImpl = () => Promise.resolve({
      type: "noteSaveRejected",
      reason: "leaseLost",
      revision: 3
    });
    await session.open();
    session.setBody("lost text");
    clock.advance(AUTOSAVE_MS);
    await settle();
    assert.equal(session.state, "leaseLost");
    assert.equal(session.lease, null);
    assert.ok(drafts.load(NOTE, "sess-a"));
    const heartbeatCalls = transport.calls.heartbeat.length;
    const previewCalls = transport.calls.preview.length;
    clock.advance(10000);
    await settle();
    assert.equal(transport.calls.save.length, 1);
    assert.equal(transport.calls.heartbeat.length, heartbeatCalls);
    assert.equal(transport.calls.preview.length, previewCalls);
  }

  {
    const { session, transport, clock, drafts } = setup();
    await session.open();
    session.setBody("forced text");
    clock.advance(PREVIEW_MS);
    await settle();
    const previewCalls = transport.calls.preview.length;
    session.applyLeaseLost("forced");
    assert.equal(session.state, "forced");
    assert.equal(session.lease, null);
    assert.equal(drafts.load(NOTE, "sess-a").body, "forced text");
    clock.advance(10000);
    await settle();
    assert.equal(transport.calls.save.length, 0);
    assert.equal(transport.calls.heartbeat.length, 0);
    assert.equal(transport.calls.preview.length, previewCalls);
  }
});

test("a save timeout reconciles through state and marks saved only on a body match", async () => {
  const { session, transport, clock, drafts } = setup();
  transport.saveImpl = () => Promise.resolve({ type: "timeout" });
  transport.stateImpl = () => Promise.resolve({
    type: "noteEditState",
    notes: [{ noteId: NOTE, revision: 5, body: "local text" }]
  });
  await session.open();
  session.setBody("local text");
  clock.advance(AUTOSAVE_MS);
  await settle();

  assert.equal(transport.calls.state.length, 1);
  assert.equal(session.state, "editing");
  assert.equal(session.dirty, false);
  assert.equal(session.confirmedRevision, 5);
  assert.equal(session.confirmedBody, "local text");
  assert.equal(drafts.load(NOTE, "sess-a"), null);
});

test("a timeout with an advanced revision and different body becomes a conflict", async () => {
  const { session, transport, clock, drafts } = setup();
  transport.saveImpl = () => Promise.resolve({ type: "timeout" });
  transport.stateImpl = () => Promise.resolve({
    type: "noteEditState",
    notes: [{ noteId: NOTE, revision: 5, body: "someone else" }]
  });
  await session.open();
  session.setBody("local text");
  clock.advance(AUTOSAVE_MS);
  await settle();

  assert.equal(session.state, "conflict");
  assert.equal(session.dirty, true);
  assert.equal(session.body, "local text");
  assert.equal(session.confirmedRevision, 5);
  assert.ok(drafts.load(NOTE, "sess-a"));
});

test("a timeout with unavailable state goes offline, keeps the draft and allows flush retry", async () => {
  const { session, transport, clock, drafts } = setup();
  transport.saveImpl = () => Promise.resolve({ type: "timeout" });
  transport.stateImpl = () => { throw new Error("state unavailable"); };
  await session.open();
  session.setBody("local text");
  clock.advance(AUTOSAVE_MS);
  await settle();

  assert.equal(session.state, "offline");
  assert.equal(session.dirty, true, "never claim saved on a timeout");
  assert.ok(drafts.load(NOTE, "sess-a"));

  const retry = session.flush();
  await settle();
  assert.equal(transport.calls.save.length, 2);
  assert.equal(session.dirty, true);
  await retry;
});

test("close flushes the pending save before end and releases after the ack", async () => {
  const { session, transport, drafts } = setup();
  await session.open();
  session.setBody("final text");

  const result = await session.close();
  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.deepEqual(transport.events, ["save", "end"]);
  assert.equal(transport.calls.save.length, 1);
  assert.equal(transport.calls.save[0].body, "final text");
  assert.equal(transport.calls.end.length, 1);
  assert.equal(transport.calls.end[0].body, "final text");
  assert.equal(transport.calls.end[0].baseRevision, 3);
  assert.equal(session.state, "closed");
  assert.equal(session.lease, null);
  assert.equal(drafts.load(NOTE, "sess-a"), null);
});

test("a failed end keeps the session, lease and draft", async () => {
  const { session, transport, drafts } = setup();
  transport.saveImpl = () => Promise.resolve({ type: "timeout" });
  transport.stateImpl = () => Promise.resolve({ type: "timeout" });
  transport.endImpl = () => Promise.resolve({ type: "timeout" });
  await session.open();
  session.setBody("final text");

  const result = await session.close();
  assert.equal(result.ok, false);
  assert.notEqual(session.state, "closed");
  assert.ok(session.lease);
  assert.ok(drafts.load(NOTE, "sess-a"));
  assert.equal(session.dirty, true);
});

test("open transport failure goes offline with the local body intact", async () => {
  const { session, transport } = setup({ body: "local copy" });
  transport.beginReply = () => { throw new Error("socket down"); };
  const result = await session.open();
  assert.equal(result.ok, false);
  assert.equal(session.state, "offline");
  assert.equal(session.body, "local copy");
  assert.equal(session.lease, null);
  assert.equal(session.status().savedLocally, false);
});

test("equal-body typing never calls save and status keeps its stable shape", async () => {
  const { session, transport, clock } = setup();
  await session.open();
  assert.deepEqual(
    Object.keys(session.status()).sort(),
    ["bodyLength", "confirmedRevision", "dirty", "error", "savedLocally", "saving", "state"]
  );
  assert.equal(typeof session.saveNow, "function");

  session.setBody("base");
  clock.advance(AUTOSAVE_MAX_MS);
  await settle();
  assert.equal(transport.calls.save.length, 0);
  assert.equal(session.dirty, false);
});

test("close without release stops timers and keeps the draft", async () => {
  const { session, transport, clock, drafts } = setup();
  await session.open();
  session.setBody("closing locally");
  clock.advance(PREVIEW_MS);
  await settle();
  const result = await session.close({ release: false });
  assert.equal(result.ok, true);
  assert.equal(result.released, false);
  assert.equal(session.state, "closed");
  assert.equal(transport.calls.end.length, 0);
  assert.equal(drafts.load(NOTE, "sess-a").body, "closing locally");
});

test("dispose clears timers without ending and keeps the draft", async () => {
  const { session, transport, clock, drafts } = setup();
  await session.open();
  session.setBody("pagehide text");
  clock.advance(PREVIEW_MS);
  await settle();
  session.dispose();
  assert.equal(session.state, "disposed");
  assert.equal(transport.calls.end.length, 0);
  assert.equal(drafts.load(NOTE, "sess-a").body, "pagehide text");
  clock.advance(10000);
  await settle();
  assert.equal(transport.calls.save.length, 0);
  assert.equal(transport.calls.heartbeat.length, 0);
});

test("heartbeats run every 5 s while the lease is open", async () => {
  const { session, transport, clock } = setup();
  await session.open();
  clock.advance(HEARTBEAT_MS - 1);
  await settle();
  assert.equal(transport.calls.heartbeat.length, 0);
  clock.advance(1);
  await settle();
  assert.equal(transport.calls.heartbeat.length, 1);
  assert.equal(transport.calls.heartbeat[0].noteId, NOTE);
  assert.equal(transport.calls.heartbeat[0].lease.leaseToken, "lease-token-1");
  clock.advance(HEARTBEAT_MS);
  await settle();
  assert.equal(transport.calls.heartbeat.length, 2);
});

test("a throttled tab stays quiet until revalidate, and revalidate failure is lease loss", async () => {
  {
    const { session, transport, clock } = setup();
    await session.open();
    transport.heartbeatImpl = () => Promise.resolve({ type: "timeout" });
    clock.advance(HEARTBEAT_MS);
    await settle();
    assert.equal(session.state, "offline");
    assert.equal(transport.calls.preview.length, 0);

    session.setBody("queued locally");
    clock.advance(1000);
    await settle();
    assert.equal(transport.calls.preview.length, 0);
    assert.equal(transport.calls.save.length, 0);

    transport.heartbeatImpl = args => Promise.resolve({
      type: "noteEditHeartbeatAck",
      leaseToken: args.lease.leaseToken,
      gmEpoch: args.lease.gmEpoch
    });
    const revalidated = await session.revalidate();
    assert.equal(revalidated.ok, true);
    assert.equal(session.state, "editing");

    session.setBody("queued locally!");
    clock.advance(PREVIEW_MS);
    await settle();
    assert.equal(transport.calls.preview.length, 1);
    assert.equal(transport.calls.preview[0].body, "queued locally!");
  }

  {
    const { session, transport, clock } = setup();
    await session.open();
    transport.heartbeatImpl = () => Promise.resolve({ type: "timeout" });
    clock.advance(HEARTBEAT_MS);
    await settle();
    const revalidated = await session.revalidate();
    assert.equal(revalidated.ok, false);
    assert.equal(session.state, "leaseLost");
    assert.equal(session.lease, null);
  }
});

test("appearance acks update layout/skin only on success and never touch body revisions", async () => {
  const { session, transport } = setup();
  await session.open();
  const revision = session.revision;
  const body = session.body;

  const layoutResult = await session.setLayout("profile");
  assert.equal(layoutResult.ok, true);
  assert.equal(session.layout, "profile");
  assert.equal(session.revision, revision);
  assert.equal(session.body, body);
  assert.equal(transport.calls.appearance.length, 1);

  const amber = { ...SKIN, paper: "amber" };
  const skinResult = await session.setSkin(amber);
  assert.equal(skinResult.ok, true);
  assert.deepEqual(session.skin, amber);

  transport.appearanceImpl = () => Promise.resolve({
    type: "noteAppearanceRejected",
    reason: "invalid"
  });
  const rejected = await session.setLayout("plain");
  assert.equal(rejected.ok, false);
  assert.equal(session.layout, "profile");
  assert.equal(session.revision, revision);

  transport.appearanceImpl = () => Promise.resolve({ type: "timeout" });
  const timedOut = await session.setLayout("plain");
  assert.equal(timedOut.ok, false);
  assert.equal(session.layout, "profile");
  assert.equal(session.body, body);
});

test("applyRemote is conservative and never replaces local text", async () => {
  {
    const { session } = setup();
    await session.open();
    const amber = { ...SKIN, paper: "amber" };
    session.applyRemote({ body: "remote body", revision: 4, layout: "profile", skin: amber });
    assert.equal(session.confirmedBody, "remote body");
    assert.equal(session.confirmedRevision, 4);
    assert.equal(session.layout, "profile");
    assert.deepEqual(session.skin, amber);
    assert.equal(session.body, "base", "local text is not replaced");
    assert.equal(session.dirty, false);
  }

  {
    const { session } = setup();
    await session.open();
    session.setBody("local draft");
    session.applyRemote({ body: "remote body", revision: 9, layout: "profile", skin: SKIN });
    assert.equal(session.confirmedBody, "base");
    assert.equal(session.confirmedRevision, 2);
    assert.equal(session.layout, "plain");
    assert.equal(session.body, "local draft");
    assert.equal(session.dirty, true);
  }
});

test("two sessions for the same user keep independent drafts", async () => {
  const clock = makeClock();
  const note = { body: "base", revision: 2, layout: "plain", skin: SKIN };
  const transportA = new FakeTransport(clock, { note });
  const transportB = new FakeTransport(clock, { note });
  const storage = new MemoryStorage();
  const drafts = new DraftStore({
    origin: "https://test.invalid",
    worldId: "world-1",
    userId: "user-1",
    canvasId: "shared",
    storage,
    now: clock.now,
    timers: clock
  });
  const sessionA = new NoteEditorSession({
    noteId: NOTE,
    note,
    transport: transportA,
    drafts,
    clientSessionId: "sess-a",
    now: clock.now,
    timers: clock
  });
  const sessionB = new NoteEditorSession({
    noteId: NOTE,
    note,
    transport: transportB,
    drafts,
    clientSessionId: "sess-b",
    now: clock.now,
    timers: clock
  });

  await sessionA.open();
  await sessionB.open();
  sessionA.setBody("draft A");
  sessionB.setBody("draft B");
  clock.advance(PREVIEW_MS);
  await settle();
  assert.equal(drafts.load(NOTE, "sess-a").body, "draft A");
  assert.equal(drafts.load(NOTE, "sess-b").body, "draft B");

  await sessionA.flush();
  await settle();
  assert.equal(drafts.load(NOTE, "sess-a"), null);
  assert.equal(drafts.load(NOTE, "sess-b").body, "draft B");
});
