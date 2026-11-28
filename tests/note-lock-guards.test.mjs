import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Hooks, JournalEntryPage, installFoundry, makeContainers, makeUser
} from "./fake-foundry.mjs";

const MODULE_ID = "fvtt-journalinator";
const NOTE_TYPE = `${MODULE_ID}.note`;

const gm = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const gm2 = makeUser("GMuser0000000002", { isGM: true, name: "GM Two", active: false });
const player = makeUser("Player0000000001", { name: "Player One" });
const player2 = makeUser("Player0000000002", { name: "Player Two" });

const env = installFoundry({ user: gm, users: [gm, gm2, player, player2] });
const containers = await makeContainers(env);
const socket = await import("../scripts/socket.mjs");
const edit = await import("../scripts/edit-session.mjs");
const { privateStore } = await import("../scripts/store/private-store.mjs");
const { t } = await import("../scripts/i18n.mjs");

socket.registerSocket();

const layoutPage = containers.shared.pages.get(containers.ids.layoutPage);

const skin = () => ({
  paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 0
});

function setUser(user) {
  game.user = user;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 1000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) return false;
    await sleep(5);
  }
  return true;
}

async function gmRequest(message, options = { timeoutMs: 2000 }) {
  setUser(gm);
  return socket.requestEditReply(message, options);
}

async function createNote(fields = {}) {
  const reply = await gmRequest({
    type: "createNote", body: "", layout: "plain", skin: skin(), x: 0, y: 0, ...fields
  });
  assert.equal(reply.type, "noteCreated");
  return reply;
}

async function gmWrite(message) {
  setUser(gm);
  return socket.requestWrite(message);
}

/** Plays a player request through the real active-GM socket path. */
async function playerRequest(user, message, { timeoutMs = 2000 } = {}) {
  setUser(user);
  const start = env.socketLog.length;
  const promise = socket.requestEditReply(message, { timeoutMs });
  const sent = env.socketLog.slice(start).map(entry => entry.message)
    .find(item => item.type === message.type);
  assert.ok(sent, `expected ${message.type} to be emitted`);

  setUser(gm);
  const replyStart = env.socketLog.length;
  env.deliver(sent, user.id);
  await waitFor(() => env.socketLog.slice(replyStart)
    .some(entry => entry.message.forUserId === user.id));

  const replies = env.socketLog.slice(replyStart).map(entry => entry.message)
    .filter(item => item.forUserId === user.id);
  setUser(user);
  for (const reply of replies) env.deliver(reply, gm.id);
  return { result: await promise, replies, sent };
}

/** Plays a player write request through the active GM and returns the rejection messages. */
async function playerWrite(user, message) {
  setUser(user);
  const start = env.socketLog.length;
  socket.requestWrite(message);
  const sent = env.socketLog.slice(start).map(entry => entry.message)
    .find(item => item.type === message.type);
  assert.ok(sent, `expected ${message.type} to be emitted`);

  setUser(gm);
  const replyStart = env.socketLog.length;
  env.deliver(sent, user.id);
  await waitFor(() => env.socketLog.slice(replyStart)
    .some(entry => entry.message.type === "writeRejected"));
  return env.socketLog.slice(replyStart).map(entry => entry.message)
    .filter(item => item.type === "writeRejected");
}

function grant(noteId, user = player, session = "lock-tab") {
  return edit.grantLease({
    noteId,
    userId: user.id,
    userName: user.name,
    userColor: user.color,
    clientSessionId: session,
    requestId: "lock-request",
    revision: 0
  });
}

function release(noteId) {
  const lease = edit.leaseFor(noteId);
  if (lease) edit.releaseLease(lease, "test-cleanup");
}

function snapshot() {
  return JSON.stringify({
    pages: [...containers.shared.pages.values()].map(page => ({
      id: page.id, type: page.type, system: page.system
    })),
    layout: layoutPage.system
  });
}

function noteCount() {
  return [...containers.shared.pages.values()].filter(page => page.type === NOTE_TYPE).length;
}

function warnings() {
  return env.notifications.filter(entry => entry[0] === "warn").length;
}

async function expectRejected(fn) {
  const before = warnings();
  await fn();
  assert.ok(warnings() > before, "expected a user-facing rejection");
}

function seedCardFields(noteId, fields) {
  const changes = {};
  for (const [key, value] of Object.entries(fields)) {
    changes[`system.cards.${noteId}.${key}`] = value;
  }
  return layoutPage.update(changes);
}

test("any live lease blocks every GM structural/pin/route mutation without writes", async () => {
  edit.initializeAuthority();
  const a = await createNote({ body: "A", x: 10, y: 10 });
  const b = await createNote({ body: "B", x: 300, y: 10 });
  const c = await createNote({ body: "C", x: 600, y: 10 });

  const linkId = "LinkLock00000001";
  await seedCardFields(a.noteId, {
    anchors: {
      main: { kind: "main", x: 0.5, y: 0, createdBy: gm.id },
      minor000000000001: { kind: "minor", x: 0.5, y: 1, createdBy: gm.id }
    }
  });
  await containers.shared.pages.get(a.noteId).update({
    "system.links": [{
      id: linkId, targetId: b.noteId, label: "", direction: "one", color: "",
      lineStyle: "solid", origin: "drawn", edited: false, createdBy: gm.id,
      sourceAnchorId: "", targetAnchorId: "",
      routeAnchors: [{ noteId: c.noteId, anchorId: "main" }],
      pins: [{ x: 120, y: 80 }]
    }]
  });
  await layoutPage.update({
    "system.pins.freepin00000001": { noteId: "", x: 50, y: 50, isDefault: false },
    "system.pins.attachedpin00001": { noteId: a.noteId, x: 0.5, y: 0.5, isDefault: false }
  });
  await gmWrite({
    type: "addLabel", noteId: a.noteId, stamp: "sun-shield", x: 0, y: 0
  });
  const labelId = Object.keys(layoutPage.system.labels).find(id =>
    layoutPage.system.labels[id].noteId === a.noteId);

  const before = snapshot();
  const lease = grant(a.noteId);
  assert.ok(lease.lease);

  const blocked = [
    ["moveCard", () => gmWrite({ type: "moveCard", noteId: a.noteId, x: 999, y: 999 })],
    ["setCardPorts", () => gmWrite({ type: "setCardPorts", noteId: a.noteId, ports: ["left"] })],
    ["setCardSizing", () => gmWrite({
      type: "setCardSizing", noteId: a.noteId,
      sizing: { mode: "manual", width: 320, minHeight: 200 }
    })],
    ["setNoteAttachment", () => gmWrite({
      type: "setNoteAttachment", noteIds: [a.noteId, b.noteId],
      fields: { pinStyle: "brass" }
    })],
    ["addLabel", () => gmWrite({
      type: "addLabel", noteId: a.noteId, stamp: "compass", x: 5, y: 5
    })],
    ["updateLabel", () => gmWrite({ type: "updateLabel", labelId, text: "changed" })],
    ["removeLabel", () => gmWrite({ type: "removeLabel", labelId })],
    ["boardPinAction connect", () => gmWrite({
      type: "boardPinAction",
      action: { type: "connect", source: "p:freepin00000001", target: "p:attachedpin00001" }
    })],
    ["boardPinAction delete", () => gmWrite({
      type: "boardPinAction", action: { type: "delete", ref: "p:attachedpin00001" }
    })],
    ["addCardAnchor", () => gmWrite({
      type: "addCardAnchor", noteId: a.noteId, kind: "minor", x: 0.5, y: 1
    })],
    ["moveCardAnchor", () => gmWrite({
      type: "moveCardAnchor", noteId: a.noteId, anchorId: "minor000000000001", x: 0.4, y: 1
    })],
    ["removeCardAnchor", () => gmWrite({
      type: "removeCardAnchor", noteId: a.noteId, anchorId: "minor000000000001"
    })],
    ["setMainPinEnabled", () => gmWrite({
      type: "setMainPinEnabled", noteId: a.noteId, enabled: false
    })],
    ["normalizePins", () => gmWrite({ type: "normalizePins" })],
    ["createLink", () => gmWrite({
      type: "createLink", sourceId: a.noteId, targetId: c.noteId
    })],
    ["updateLink", () => gmWrite({
      type: "updateLink", noteId: a.noteId, linkId, fields: { label: "edited" }
    })],
    ["deleteLink", () => gmWrite({ type: "deleteLink", noteId: a.noteId, linkId })],
    ["routeNoteOnLink route", () => gmWrite({
      type: "routeNoteOnLink", sourceId: a.noteId, noteId: c.noteId, linkId, mode: "route"
    })],
    ["routeNoteOnLink split", () => gmWrite({
      type: "routeNoteOnLink", sourceId: a.noteId, noteId: c.noteId, linkId, mode: "split"
    })],
    ["clearThreadPins", () => gmWrite({
      type: "clearThreadPins", noteId: a.noteId, linkId
    })],
    ["detachRouteNote", () => gmWrite({
      type: "detachRouteNote", sourceId: a.noteId, noteId: c.noteId, linkId
    })],
    ["deleteNote", () => gmWrite({ type: "deleteNote", noteId: a.noteId })]
  ];

  for (const [label, run] of blocked) {
    await expectRejected(async () => {
      await run();
      assert.equal(snapshot(), before, `${label} must not write`);
    });
  }

  release(a.noteId);
});

test("disabling a hub main pin is rejected while any affected source link is leased", async () => {
  edit.initializeAuthority();
  const hub = await createNote({ body: "pin lease hub", x: 100, y: 100 });
  const source = await createNote({ body: "pin lease source", x: 400, y: 100 });
  await gmWrite({
    type: "createLink", sourceId: source.noteId, targetId: hub.noteId,
    sourcePoint: { x: 1, y: 0.5 }, targetAnchorId: "main"
  });
  const sourcePage = containers.shared.pages.get(source.noteId);
  const link = sourcePage.system.links.find(item => item.targetId === hub.noteId);
  assert.ok(link, "the inbound link exists before the toggle");
  assert.equal(link.targetAnchorId, "main");

  const request = { type: "setMainPinEnabled", noteId: hub.noteId, enabled: false };
  const before = snapshot();
  const lease = grant(source.noteId);
  assert.ok(lease.lease);

  await expectRejected(() => gmWrite(request));
  assert.equal(snapshot(), before,
    "the whole disable leaves every link, attachment and anchor byte-identical");
  assert.equal(containers.shared.pages.get(hub.noteId).system.attachment.mainPinEnabled, true);

  release(source.noteId);
  await gmWrite(request);
  assert.equal(containers.shared.pages.get(hub.noteId).system.attachment.mainPinEnabled, false);
  const redistributed = containers.shared.pages.get(source.noteId).system.links
    .find(item => item.targetId === hub.noteId);
  assert.notEqual(redistributed.targetAnchorId, "main",
    "the same request succeeds once the affected source is unlocked");
  assert.ok(redistributed.targetAnchorId);
});

test("sendSharedToPrivate refuses incompatible shared worlds without a transfer or private write", async () => {
  edit.initializeAuthority();
  const current = await createNote({ body: "transfer source", x: 10, y: 10 });
  await privateStore.createFor(gm);
  const legacy = await JournalEntryPage.create({
    name: "legacy-transfer-note", type: NOTE_TYPE,
    system: { schemaVersion: 1, body: "legacy body", revision: 0 }
  }, { parent: containers.shared });
  const legacyBefore = JSON.stringify(legacy.system);
  const workspaceBefore = privateStore.flags(privateStore.findActive(gm.id)).workspace;
  const transferCount = Object.keys(privateStore.transfers()).length;

  await expectRejected(() => gmWrite({
    type: "sendSharedToPrivate", toUserId: gm.id, noteIds: [current.noteId]
  }));
  assert.equal(privateStore.flags(privateStore.findActive(gm.id)).workspace, workspaceBefore,
    "a self-copy performs no private workspace write");
  assert.equal(JSON.stringify(legacy.system), legacyBefore, "legacy data stays byte-identical");

  await expectRejected(() => gmWrite({
    type: "sendSharedToPrivate", toUserId: player.id, noteIds: [current.noteId]
  }));
  assert.equal(Object.keys(privateStore.transfers()).length, transferCount,
    "no pending offer is built for another user");
  assert.equal(privateStore.findActive(player.id), null);

  await legacy.delete();
  await gmWrite({
    type: "sendSharedToPrivate", toUserId: player.id, noteIds: [current.noteId]
  });
  assert.equal(Object.keys(privateStore.transfers()).length, transferCount + 1,
    "the same request works again once the shared world is current");
  const pending = privateStore.pendingTransfers(player.id).at(-1);
  assert.equal(pending.fromUserId, gm.id);
  assert.equal(pending.summary.count, 1);
});

test("the lease holder can save body/appearance but cannot move, resize or pin", async () => {
  edit.initializeAuthority();
  const created = await createNote({ body: "holder body", x: 20, y: 30 });
  const page = containers.shared.pages.get(created.noteId);

  const { result: granted } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "holder-tab"
  });
  assert.equal(granted.type, "noteEditGranted");

  const saved = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease: granted.lease,
    sequence: 1, baseRevision: 0, body: "holder edit"
  });
  assert.equal(saved.result.type, "noteSaveAck");
  assert.equal(page.system.body, "holder edit");

  const appearance = await playerRequest(player, {
    type: "saveNoteAppearance", noteId: created.noteId, lease: granted.lease,
    layout: "profile", skin: { ...skin(), paper: "parchment" }
  });
  assert.equal(appearance.result.type, "noteAppearanceAck");

  const before = snapshot();
  for (const action of [
    { type: "moveCard", noteId: created.noteId, x: 500, y: 500 },
    { type: "setCardSizing", noteId: created.noteId,
      sizing: { mode: "manual", width: 400, minHeight: 300 } },
    { type: "addCardAnchor", noteId: created.noteId, kind: "minor", x: 0.5, y: 1 }
  ]) {
    const rejected = await playerWrite(player, action);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason, `Journalinator: ${t("JN.Socket.LockedByOther")}`);
    assert.equal(snapshot(), before, `${action.type} must be rejected`);
  }

  const { result: ended } = await playerRequest(player, {
    type: "endNoteEdit", noteId: created.noteId, lease: granted.lease
  });
  assert.equal(ended.type, "noteEditEnded");
  assert.equal(ended.released, true);
});

test("free pins and unrelated notes stay usable while another note is leased", async () => {
  edit.initializeAuthority();
  const locked = await createNote({ body: "locked", x: 0, y: 0 });
  const free = await createNote({ body: "free", x: 400, y: 0 });
  const lease = grant(locked.noteId);
  assert.ok(lease.lease);

  const freeBefore = { ...layoutPage.system.cards[free.noteId].autoSizeOrigin };
  await gmWrite({ type: "moveCard", noteId: free.noteId, x: 450, y: 30 });
  assert.equal(layoutPage.system.cards[free.noteId].x, 450);
  assert.equal(layoutPage.system.cards[free.noteId].y, 30);
  assert.equal(layoutPage.system.cards[free.noteId].autoSizeOrigin.x,
    freeBefore.x + 50);
  assert.equal(layoutPage.system.cards[free.noteId].autoSizeOrigin.y,
    freeBefore.y + 30);

  await gmWrite({
    type: "boardPinAction", action: { type: "add", noteId: "", x: 700, y: 700 }
  });
  const pinId = Object.keys(layoutPage.system.pins)
    .find(id => layoutPage.system.pins[id].noteId === "" && layoutPage.system.pins[id].x === 700);
  assert.ok(pinId, "free pin was added");

  await gmWrite({
    type: "boardPinAction",
    action: { type: "move", ref: `p:${pinId}`, noteId: "", x: 750, y: 725 }
  });
  assert.equal(layoutPage.system.pins[pinId].x, 750);

  await gmWrite({
    type: "boardPinAction", action: { type: "delete", ref: `p:${pinId}` }
  });
  assert.equal(layoutPage.system.pins[pinId], undefined);

  // The locked card itself never moved.
  assert.equal(layoutPage.system.cards[locked.noteId].x, 0);
  release(locked.noteId);
});

test("group move/delete rejects the whole selection while one note is leased", async () => {
  edit.initializeAuthority();
  const a = await createNote({ body: "group A", x: 10, y: 10 });
  const b = await createNote({ body: "group B", x: 300, y: 10 });
  const c = await createNote({ body: "group C", x: 600, y: 10 });
  const lease = grant(a.noteId);
  assert.ok(lease.lease);

  const before = snapshot();
  await expectRejected(() => gmWrite({
    type: "moveCards",
    moves: [{ noteId: a.noteId, x: 50, y: 50 }, { noteId: b.noteId, x: 350, y: 50 }]
  }));
  assert.equal(snapshot(), before);

  await expectRejected(() => gmWrite({
    type: "deleteNotes", noteIds: [a.noteId, b.noteId]
  }));
  assert.equal(snapshot(), before);
  assert.equal(containers.shared.pages.get(a.noteId).system.deleted, null);
  assert.equal(containers.shared.pages.get(b.noteId).system.deleted, null);

  await gmRequest({ type: "forceUnlockNote", noteId: a.noteId });
  await gmWrite({
    type: "moveCards",
    moves: [{ noteId: a.noteId, x: 80, y: 80 }, { noteId: b.noteId, x: 380, y: 80 }]
  });
  assert.equal(layoutPage.system.cards[a.noteId].x, 80);
  assert.equal(layoutPage.system.cards[b.noteId].x, 380);

  await gmWrite({ type: "deleteNotes", noteIds: [a.noteId, b.noteId] });
  assert.ok(containers.shared.pages.get(a.noteId).system.deleted);
  assert.ok(containers.shared.pages.get(b.noteId).system.deleted);
  assert.equal(layoutPage.system.cards[a.noteId], undefined);
  assert.equal(layoutPage.system.cards[b.noteId], undefined);
  assert.ok(layoutPage.system.cards[c.noteId], "unselected note keeps its card");
});

test("a failed group delete restores every note and route array", async () => {
  edit.initializeAuthority();
  const a = await createNote({ body: "rollback A", x: 10, y: 10 });
  const b = await createNote({ body: "rollback B", x: 300, y: 10 });
  const link = {
    id: "LinkRollback0001", targetId: b.noteId, label: "", direction: "one",
    color: "", lineStyle: "solid", origin: "drawn", edited: false, createdBy: gm.id,
    sourceAnchorId: "", targetAnchorId: "",
    routeAnchors: [{ noteId: b.noteId, anchorId: "main" }]
  };
  await containers.shared.pages.get(a.noteId).update({ "system.links": [link] });
  const pageB = containers.shared.pages.get(b.noteId);
  const original = pageB.update;
  pageB.update = async () => { throw new Error("forced write failure"); };
  try {
    const originalError = console.error;
    console.error = () => {};
    try {
      await gmWrite({ type: "deleteNotes", noteIds: [a.noteId, b.noteId] });
    } finally {
      console.error = originalError;
    }
  } finally {
    pageB.update = original;
  }
  assert.equal(containers.shared.pages.get(a.noteId).system.deleted, null);
  assert.equal(containers.shared.pages.get(b.noteId).system.deleted, null);
  assert.deepEqual(containers.shared.pages.get(a.noteId).system.links[0].routeAnchors, [
    { noteId: b.noteId, anchorId: "main" }
  ]);
  assert.ok(layoutPage.system.cards[a.noteId]);
  assert.ok(layoutPage.system.cards[b.noteId]);
});

test("the same group succeeds after the lease expires", async () => {
  edit.initializeAuthority();
  const a = await createNote({ body: "expiry A", x: 10, y: 10 });
  const b = await createNote({ body: "expiry B", x: 300, y: 10 });
  grant(a.noteId);
  const before = snapshot();

  await expectRejected(() => gmWrite({
    type: "moveCards", moves: [{ noteId: a.noteId, x: 40, y: 40 }, { noteId: b.noteId, x: 340, y: 40 }]
  }));
  assert.equal(snapshot(), before);

  edit.expireLeases(Date.now() + edit.LEASE_MS + 1);
  await gmWrite({
    type: "moveCards", moves: [{ noteId: a.noteId, x: 40, y: 40 }, { noteId: b.noteId, x: 340, y: 40 }]
  });
  assert.equal(layoutPage.system.cards[a.noteId].x, 40);
  assert.equal(layoutPage.system.cards[b.noteId].x, 340);
});

test("incompatible data blocks structural writes but lease close commands still work", async () => {
  edit.initializeAuthority();
  const created = await createNote({ body: "still current", x: 20, y: 20 });
  const { result: granted } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "incompatible-tab"
  });
  assert.equal(granted.type, "noteEditGranted");

  const legacy = await JournalEntryPage.create({
    name: "legacy-note", type: NOTE_TYPE,
    system: { schemaVersion: 1, body: "legacy body", revision: 0 }
  }, { parent: containers.shared });
  const legacyBefore = JSON.stringify(legacy.system);
  const pageBefore = JSON.stringify(containers.shared.pages.get(created.noteId).system);
  const cardBefore = JSON.stringify(layoutPage.system.cards[created.noteId]);
  const pinsBefore = JSON.stringify(layoutPage.system.pins);

  await expectRejected(() => gmWrite({
    type: "moveCard", noteId: created.noteId, x: 900, y: 900
  }));
  await expectRejected(() => gmWrite({ type: "deleteNote", noteId: created.noteId }));
  await expectRejected(() => gmWrite({
    type: "boardPinAction", action: { type: "add", noteId: created.noteId, x: 0.5, y: 0.5 }
  }));
  await expectRejected(() => gmWrite({
    type: "setCardSizing", noteId: created.noteId,
    sizing: { mode: "manual", width: 300, minHeight: 200 }
  }));

  assert.equal(JSON.stringify(legacy.system), legacyBefore, "legacy data stays byte-identical");
  assert.equal(JSON.stringify(containers.shared.pages.get(created.noteId).system), pageBefore);
  assert.equal(JSON.stringify(layoutPage.system.cards[created.noteId]), cardBefore);
  assert.equal(JSON.stringify(layoutPage.system.pins), pinsBefore);

  // Closing the already-open session is allowed even though the world is read-only.
  const { result: ended } = await playerRequest(player, {
    type: "endNoteEdit", noteId: created.noteId, lease: granted.lease
  });
  assert.equal(ended.type, "noteEditEnded");
  assert.equal(ended.released, true);
  assert.equal(edit.leaseFor(created.noteId), null);

  // Force-unlock and state reads stay available too.
  const state = await gmRequest({ type: "requestNoteEditState", noteId: created.noteId });
  assert.equal(state.type, "noteEditState");
  await gmRequest({ type: "forceUnlockNote", noteId: created.noteId });

  await legacy.delete();
  await gmWrite({ type: "moveCard", noteId: created.noteId, x: 70, y: 70 });
  assert.equal(layoutPage.system.cards[created.noteId].x, 70);
});

test("activity hooks fire once per permanent deletion and per new relationship", async () => {
  edit.initializeAuthority();
  // Clear trashed notes left by earlier cases so the permanent-deletion hook is unambiguous.
  await gmWrite({ type: "emptyTrash" });
  const a = await createNote({ body: "hook A", x: 0, y: 0 });
  const b = await createNote({ body: "hook B", x: 300, y: 0 });
  const c = await createNote({ body: "hook C", x: 600, y: 0 });

  const threads = [];
  const threadHook = Hooks.on("journalinatorThreadCreated", payload => threads.push(payload));

  await gmWrite({ type: "createLink", sourceId: a.noteId, targetId: b.noteId });
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0], {
    noteId: a.noteId, linkId: threads[0].linkId, targetId: b.noteId,
    authorId: gm.id, kind: "note-link", board: false
  });
  assert.ok(threads[0].linkId);
  const originalLink = containers.shared.pages.get(a.noteId).system.links
    .find(link => link.targetId === b.noteId);

  // Repeating the same relationship is an update/no-op, not a new thread.
  await gmWrite({ type: "createLink", sourceId: a.noteId, targetId: b.noteId });
  assert.equal(threads.length, 1);

  // A route split commits two replacement links.
  await gmWrite({
    type: "routeNoteOnLink", sourceId: a.noteId, noteId: c.noteId,
    linkId: originalLink.id, mode: "split"
  });
  assert.equal(threads.length, 3);
  const replacements = threads.slice(1);
  assert.ok(replacements.every(event => event.replacesLinkId === originalLink.id));
  assert.deepEqual(replacements.map(event => [event.noteId, event.targetId]), [
    [a.noteId, c.noteId], [c.noteId, b.noteId]
  ]);

  const pinsBefore = new Set(Object.keys(layoutPage.system.pins));
  await gmWrite({
    type: "boardPinAction", action: { type: "add", noteId: "", x: 800, y: 900 }
  });
  await gmWrite({
    type: "boardPinAction", action: { type: "add", noteId: "", x: 850, y: 900 }
  });
  const pinIds = Object.keys(layoutPage.system.pins)
    .filter(id => !pinsBefore.has(id));
  assert.equal(pinIds.length, 2);
  await gmWrite({
    type: "boardPinAction",
    action: { type: "connect", source: `p:${pinIds[0]}`, target: `p:${pinIds[1]}` }
  });
  assert.equal(threads.length, 4);
  assert.equal(threads[3].kind, "pin-link");
  assert.equal(threads[3].board, true);
  assert.equal(threads[3].noteId, "");
  assert.equal(threads[3].targetId, "");
  assert.ok(threads[3].linkId);

  // A duplicate pin connection is a no-op and must not fire again.
  await gmWrite({
    type: "boardPinAction",
    action: { type: "connect", source: `p:${pinIds[0]}`, target: `p:${pinIds[1]}` }
  });
  assert.equal(threads.length, 4);

  const deleted = [];
  const deleteHook = Hooks.on("journalinatorNotesPermanentlyDeleted", payload => deleted.push(payload));
  await gmWrite({ type: "deleteNotes", noteIds: [a.noteId, b.noteId] });
  await gmWrite({ type: "emptyTrash" });
  assert.equal(deleted.length, 1);
  assert.deepEqual(deleted[0].noteIds.sort(), [a.noteId, b.noteId].sort());
  assert.equal(deleted[0].byUserId, gm.id);
  assert.equal(containers.shared.pages.get(a.noteId), undefined);
  assert.equal(containers.shared.pages.get(b.noteId), undefined);

  Hooks.off("journalinatorThreadCreated", threadHook);
  Hooks.off("journalinatorNotesPermanentlyDeleted", deleteHook);
  void c;
});

test("incidental anchor cleanup skips a leased note and defers it until unlock", async () => {
  edit.initializeAuthority();
  const a = await createNote({ body: "cleanup A", x: 10, y: 10 });
  const b = await createNote({ body: "cleanup B", x: 300, y: 10 });
  const c = await createNote({ body: "cleanup C", x: 600, y: 10 });

  // Two links to B: the second createLink is an update, which is the path that runs cleanup.
  await gmWrite({
    type: "createLink", sourceId: a.noteId, targetId: b.noteId,
    sourceAnchorId: "main", targetAnchorId: "main"
  });

  // C has an unreferenced minor anchor and a legacy point-only link that cleanup would normally
  // prune/promote. Both must survive untouched while C is leased.
  const staleAnchor = "stale000000000001";
  await seedCardFields(c.noteId, {
    anchors: {
      main: { kind: "main", x: 0.5, y: 0, createdBy: gm.id },
      [staleAnchor]: { kind: "minor", x: 1, y: 1, createdBy: gm.id }
    }
  });
  await containers.shared.pages.get(c.noteId).update({
    "system.links": [{
      id: "LinkLockedClean01", targetId: b.noteId, label: "", direction: "one", color: "",
      lineStyle: "solid", origin: "drawn", edited: false, createdBy: gm.id,
      sourcePoint: { x: 0, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
    }]
  });
  const cLinksBefore = JSON.stringify(containers.shared.pages.get(c.noteId).system.links);
  const cCardBefore = JSON.stringify(layoutPage.system.cards[c.noteId]);

  const lease = grant(c.noteId);
  assert.ok(lease.lease);

  await gmWrite({
    type: "createLink", sourceId: a.noteId, targetId: b.noteId,
    sourceAnchorId: "main", targetAnchorId: "main"
  });

  // A's relationship update commits, while the locked note is byte-identical.
  const aLink = containers.shared.pages.get(a.noteId).system.links
    .find(link => link.targetId === b.noteId);
  assert.ok(aLink);
  assert.equal(aLink.edited, true, "the A to B update commits");
  assert.equal(aLink.sourceAnchorId, "main");
  assert.equal(JSON.stringify(containers.shared.pages.get(c.noteId).system.links), cLinksBefore,
    "the leased note's links are not rewritten");
  assert.equal(JSON.stringify(layoutPage.system.cards[c.noteId]), cCardBefore,
    "the leased note's stale anchor is not pruned");

  release(c.noteId);

  // Once unlocked, an explicit cleanup performs the deferred legacy-endpoint promotion (which
  // adds the anchor to C's card that the locked pass had to skip).
  await gmWrite({ type: "normalizePins" });
  const cleaned = containers.shared.pages.get(c.noteId).system.links
    .find(link => link.id === "LinkLockedClean01");
  assert.ok(cleaned);
  assert.ok(cleaned.sourceAnchorId, "the deferred legacy endpoint is promoted after unlock");
  assert.ok(
    Object.keys(layoutPage.system.cards[c.noteId].anchors).length >
      Object.keys(JSON.parse(cCardBefore).anchors).length,
    "the promoted endpoint anchor is created after unlock"
  );
});
