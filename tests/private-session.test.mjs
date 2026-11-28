import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";
import { privateStore, privateStore as store } from "../scripts/store/private-store.mjs";
import {
  PrivateEditCoordinator,
  createPrivateTransport,
  createPrivateEditorSession,
  LEASE_MS,
  HEARTBEAT_MS
} from "../scripts/private/private-session.mjs";
import { noteBodyHash } from "../scripts/editor/session.mjs";

const MODULE_ID = "fvtt-journalinator";
const owner = makeUser("SessionOwner00001", { name: "Owner" });
const env = installFoundry({ user: owner, users: [owner] });
await makeContainers(env);

function makeClock(start = 10_000) {
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
    set(value) {
      now = value;
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

function fakeBroadcast() {
  const posted = [];
  return {
    posted,
    postMessage(message) {
      posted.push(message);
    },
    addEventListener() {},
    removeEventListener() {},
    close() {}
  };
}

let pageSeq = 0;
let noteSeq = 0;

async function makePrivateNote({ body = "# Original", layout = "plain", skin = null } = {}) {
  pageSeq += 1;
  noteSeq += 1;
  const user = makeUser(`SessionUser${String(pageSeq).padStart(8, "0")}`, { name: `User ${pageSeq}` });
  const page = await privateStore.createFor(user);
  const workspace = privateStore.read(page);
  const made = privateStore.makeNote({
    body,
    layout,
    skin,
    noteId: `SessionNote${String(noteSeq).padStart(8, "0")}`,
    cards: {}
  });
  workspace.notes[made.note.id] = made.note;
  workspace.layout.cards[made.note.id] = made.card;
  const saved = await privateStore.save(page, workspace, 0);
  return { user, page, noteId: made.note.id, workspace: saved.workspace };
}

function makeTransport({ page, user, noteId, clock, coordinator, storage, sessionId }) {
  const localStorage = storage ?? new MemoryStorage();
  const local = coordinator ?? new PrivateEditCoordinator({
    worldId: "world",
    userId: user.id,
    workspacePageId: page.id,
    noteId,
    storage: localStorage,
    now: () => clock.now(),
    timers: clock,
    sessionId: sessionId ?? `session-${noteId}`,
    broadcast: fakeBroadcast()
  });
  const transport = createPrivateTransport({
    privateStore: store,
    pageProvider: () => page,
    workspacePage: page,
    noteId,
    userId: user.id,
    coordinator: local,
    now: () => clock.now(),
    timers: clock
  });
  return { transport, coordinator: local, storage: localStorage };
}

test("coordinator acquire/deny/heartbeat/expiry/release/forceExpire", () => {
  const clock = makeClock(1000);
  const storage = new MemoryStorage();
  const options = {
    worldId: "world",
    userId: "user",
    workspacePageId: "page",
    noteId: "note",
    storage,
    now: () => clock.now(),
    timers: clock,
    broadcast: fakeBroadcast()
  };
  const first = new PrivateEditCoordinator({ ...options, sessionId: "first" });
  const second = new PrivateEditCoordinator({ ...options, sessionId: "second" });

  assert.equal(
    first.key,
    "journalinator.private.lock.world.user.page.note"
  );

  const acquired = first.acquire();
  assert.equal(acquired.ok, true);
  assert.equal(acquired.lock.sessionId, "first");
  assert.equal(acquired.lock.gmEpoch, "local");
  assert.equal(acquired.lock.at, 1000);
  assert.equal(first.isHeldBy("first"), true);
  assert.equal(first.state().byUs, true);

  const denied = second.acquire();
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "locked");
  assert.equal(denied.holder.sessionId, "first");

  clock.advance(HEARTBEAT_MS);
  const beat = first.heartbeat();
  assert.equal(beat.ok, true);
  assert.equal(beat.lock.at, 1000 + HEARTBEAT_MS);

  // No heartbeat for a full lease: the lock is expired and another tab may take it.
  clock.set(1000 + HEARTBEAT_MS + LEASE_MS);
  assert.equal(first.heartbeat().ok, false);
  assert.equal(first.heartbeat().reason, "expired");
  assert.equal(second.acquire().ok, true);
  assert.equal(first.release(), false, "a stolen lock is not released by the old session");
  const notices = [];
  second.subscribe(notice => notices.push(notice));
  assert.equal(second.release(), true);
  assert.equal(notices.some(notice => notice.type === "privateLockReleased"), true);
  assert.equal(second.state().held, false);

  const third = new PrivateEditCoordinator({ ...options, sessionId: "third" });
  assert.equal(third.acquire().ok, true);
  assert.equal(third.forceExpire(), true);
  assert.equal(third.state().held, false);
  assert.equal(third.heartbeat().ok, false);
  third.dispose();
  first.dispose();
  second.dispose();
});

test("coordinator handles storage failures without granting a lock", () => {
  const clock = makeClock(1000);
  const storage = new MemoryStorage();
  const coordinator = new PrivateEditCoordinator({
    worldId: "w", userId: "u", workspacePageId: "p", noteId: "n",
    storage, now: clock.now, timers: clock, sessionId: "s",
    broadcast: fakeBroadcast()
  });
  storage.failSet = new Error("quota");
  const failed = coordinator.acquire();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "storage");
  assert.equal(coordinator.state().held, false);

  const missing = new PrivateEditCoordinator({
    worldId: "w", userId: "u", workspacePageId: "p", noteId: "n",
    storage: null, now: clock.now, timers: clock, sessionId: "s",
    broadcast: fakeBroadcast()
  });
  const unavailable = missing.acquire();
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, "storage");
  coordinator.dispose();
  missing.dispose();
});

test("private transport grants the owner and denies a second tab", async () => {
  const { page, user, noteId } = await makePrivateNote();
  const clock = makeClock();
  const storage = new MemoryStorage();
  const first = makeTransport({ page, user, noteId, clock, storage });
  const second = makeTransport({ page, user, noteId, clock, storage, sessionId: "second-tab" });

  const grant = await first.transport.begin({ noteId });
  assert.equal(grant.type, "noteEditGranted");
  assert.equal(grant.revision, 0);
  assert.equal(grant.body, "# Original");
  assert.equal(grant.layout, "plain");
  assert.equal(grant.lease.canvasId, "private");
  assert.equal(grant.lease.noteId, noteId);
  assert.equal(grant.lease.userId, user.id);
  assert.equal(grant.lease.gmEpoch, "local");
  assert.equal(grant.lease.clientSessionId, first.coordinator.sessionId);
  assert.equal(grant.expiresAt, clock.now() + LEASE_MS);
  assert.equal(grant.workspaceRev, privateStore.flags(page).rev);

  const denied = await second.transport.begin({ noteId });
  assert.equal(denied.type, "noteEditDenied");
  assert.equal(denied.reason, "locked");
  assert.equal(denied.holder.sessionId, first.coordinator.sessionId);

  const beat = await first.transport.heartbeat({ noteId, lease: grant.lease });
  assert.equal(beat.type, "noteEditHeartbeatAck");
  assert.equal(beat.leaseToken, grant.lease.leaseToken);
  assert.equal(beat.gmEpoch, "local");

  const state = first.transport.state();
  assert.equal(state.type, "noteEditState");
  assert.equal(state.note.noteId, noteId);
  assert.equal(state.note.body, "# Original");
  assert.equal(state.note.deleted, false);
  assert.equal(state.workspaceRev, privateStore.flags(page).rev);

  assert.equal(env.socketLog.length, 0, "private transport must not use the socket");
  first.coordinator.dispose();
  second.coordinator.dispose();
});

test("save acknowledgements, no-op saves, stale base revisions and appearance", async () => {
  const { page, user, noteId } = await makePrivateNote();
  const clock = makeClock();
  const { transport, coordinator } = makeTransport({ page, user, noteId, clock });
  const grant = await transport.begin({ noteId });

  const ack = await transport.save({
    noteId,
    lease: grant.lease,
    sequence: 1,
    baseRevision: 0,
    body: "# Updated"
  });
  assert.equal(ack.type, "noteSaveAck");
  assert.equal(ack.revision, 1);
  assert.equal(ack.sequence, 1);
  assert.equal(ack.bodyHash, noteBodyHash("# Updated"));
  assert.equal(ack.receipt.revision, 1);
  assert.equal(privateStore.read(page).notes[noteId].body, "# Updated");
  assert.equal(privateStore.read(page).notes[noteId].revision, 1);
  assert.equal(privateStore.listHistory(page, noteId)[0].body, "# Original",
    "the session-start body is captured with the first save");

  const revAfterSave = privateStore.flags(page).rev;
  const noop = await transport.save({
    noteId,
    lease: grant.lease,
    sequence: 2,
    baseRevision: 1,
    body: "# Updated"
  });
  assert.equal(noop.type, "noteSaveAck");
  assert.equal(noop.revision, 1);
  assert.equal(privateStore.flags(page).rev, revAfterSave,
    "an identical body must not write the workspace");

  const noopStaleBase = await transport.save({
    noteId,
    lease: grant.lease,
    sequence: 3,
    baseRevision: 0,
    body: "# Updated"
  });
  assert.equal(noopStaleBase.type, "noteSaveAck");
  assert.equal(noopStaleBase.revision, 1);

  const stale = await transport.save({
    noteId,
    lease: grant.lease,
    sequence: 4,
    baseRevision: 0,
    body: "# Must not overwrite"
  });
  assert.equal(stale.type, "noteSaveRejected");
  assert.equal(stale.reason, "staleRevision");
  assert.equal(privateStore.read(page).notes[noteId].body, "# Updated");

  const revBeforeAppearance = privateStore.flags(page).rev;
  const appearance = await transport.appearance({
    noteId,
    lease: grant.lease,
    layout: "profile",
    skin: { ...grant.skin, paper: "cream", font: "serif" }
  });
  assert.equal(appearance.type, "noteAppearanceAck");
  assert.equal(appearance.changed, true);
  const afterAppearance = privateStore.read(page).notes[noteId];
  assert.equal(afterAppearance.layout, "profile");
  assert.equal(afterAppearance.skin.paper, "cream");
  assert.equal(afterAppearance.skin.font, "serif");
  assert.equal(afterAppearance.revision, 1, "appearance must not change the body revision");
  assert.equal(privateStore.flags(page).rev, revBeforeAppearance + 1);
  coordinator.dispose();
});

test("an externally changed workspace rev rejects the save without overwriting", async () => {
  const { page, user, noteId } = await makePrivateNote();
  const clock = makeClock();
  const { transport, coordinator } = makeTransport({ page, user, noteId, clock });
  const grant = await transport.begin({ noteId });

  const currentRev = privateStore.flags(page).rev;
  await privateStore.save(page, privateStore.read(page), currentRev);
  assert.equal(privateStore.flags(page).rev, currentRev + 1);

  const result = await transport.save({
    noteId,
    lease: grant.lease,
    sequence: 1,
    baseRevision: 0,
    body: "# External conflict"
  });
  assert.equal(result.type, "noteSaveRejected");
  assert.equal(result.reason, "staleRevision");
  assert.equal(privateStore.read(page).notes[noteId].body, "# Original");
  coordinator.dispose();
});

test("end records the final snapshot, releases the lock and keeps it on failure", async () => {
  const { page, user, noteId } = await makePrivateNote();
  const clock = makeClock();
  const { transport, coordinator } = makeTransport({ page, user, noteId, clock });
  const grant = await transport.begin({ noteId });

  const ended = await transport.end({
    noteId,
    lease: grant.lease,
    sequence: 1,
    baseRevision: 0,
    body: "# Final body"
  });
  assert.equal(ended.type, "noteEditEnded");
  assert.equal(ended.saved, true);
  assert.equal(ended.released, true);
  assert.equal(ended.revision, 1);
  assert.equal(coordinator.isHeldBy(coordinator.sessionId), false);
  assert.equal(privateStore.read(page).notes[noteId].body, "# Final body");
  const history = privateStore.listHistory(page, noteId).map(entry => entry.body);
  assert.equal(history[0], "# Final body");
  assert.ok(history.includes("# Original"));

  // A fresh session whose save loses the workspace CAS keeps its local lock.
  const clock2 = makeClock();
  const second = makeTransport({ page, user, noteId, clock: clock2, storage: new MemoryStorage() });
  const secondGrant = await second.transport.begin({ noteId });
  assert.equal(secondGrant.type, "noteEditGranted");
  const rev = privateStore.flags(page).rev;
  await privateStore.save(page, privateStore.read(page), rev);
  const failed = await second.transport.end({
    noteId,
    lease: secondGrant.lease,
    sequence: 1,
    baseRevision: secondGrant.revision,
    body: "# Must not land"
  });
  assert.equal(failed.type, "noteSaveRejected");
  assert.equal(failed.reason, "staleRevision");
  assert.equal(second.coordinator.isHeldBy(second.coordinator.sessionId), true,
    "a failed end keeps the lock");
  assert.equal(privateStore.read(page).notes[noteId].body, "# Final body");
  second.coordinator.dispose();
});

test("two tabs cannot both save; the second tab can begin after release", async () => {
  const { page, user, noteId } = await makePrivateNote();
  const clock = makeClock();
  const storage = new MemoryStorage();
  const first = makeTransport({ page, user, noteId, clock, storage });
  const second = makeTransport({ page, user, noteId, clock, storage, sessionId: "second-tab" });

  const grant = await first.transport.begin({ noteId });
  assert.equal(grant.type, "noteEditGranted");
  const denied = await second.transport.begin({ noteId });
  assert.equal(denied.type, "noteEditDenied");
  const blocked = await second.transport.save({
    noteId,
    lease: null,
    sequence: 1,
    baseRevision: 0,
    body: "# Second tab"
  });
  assert.equal(blocked.type, "noteSaveRejected");
  assert.equal(blocked.reason, "leaseLost");

  await first.transport.end({ noteId, lease: grant.lease, sequence: 0, baseRevision: 0 });
  const later = await second.transport.begin({ noteId });
  assert.equal(later.type, "noteEditGranted");
  second.coordinator.dispose();
  first.coordinator.dispose();
});

test("private editor session uses drafts and the local transport without shared traffic", async () => {
  const { page, user, noteId } = await makePrivateNote();
  const clock = makeClock();
  const storage = new MemoryStorage();
  const coordinator = new PrivateEditCoordinator({
    worldId: "world",
    userId: user.id,
    workspacePageId: page.id,
    noteId,
    storage,
    now: () => clock.now(),
    timers: clock,
    sessionId: `session-${noteId}`,
    broadcast: fakeBroadcast()
  });
  const session = createPrivateEditorSession({
    privateStore,
    pageProvider: () => page,
    workspacePage: page,
    noteId,
    userId: user.id,
    worldId: "world",
    origin: "test-origin",
    storage,
    coordinator,
    now: () => clock.now(),
    timers: clock
  });

  const opened = await session.open();
  assert.equal(opened.ok, true);
  assert.equal(session.state, "editing");
  assert.equal(session.body, "# Original");

  session.setBody("# Drafted in tab");
  clock.advance(200);
  const draft = session.drafts.load(noteId, session.clientSessionId);
  assert.equal(draft.body, "# Drafted in tab");
  assert.equal(env.socketLog.length, 0, "no preview may be sent over the socket");

  const ack = await session.flush({ reason: "test" });
  assert.equal(ack.type, "noteSaveAck");
  assert.equal(session.confirmedBody, "# Drafted in tab");
  assert.equal(session.drafts.load(noteId, session.clientSessionId), null,
    "an acknowledged body removes the local draft");

  session.setBody("# Session final");
  const closed = await session.close();
  assert.equal(closed.ok, true);
  assert.equal(session.state, "closed");
  assert.equal(coordinator.isHeldBy(coordinator.sessionId), false);
  assert.equal(privateStore.read(page).notes[noteId].body, "# Session final");
  assert.equal(privateStore.listHistory(page, noteId)[0].body, "# Session final");
  assert.equal(env.socketLog.length, 0);
  coordinator.dispose();
});
