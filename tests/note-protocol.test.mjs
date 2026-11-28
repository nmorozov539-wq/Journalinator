import { test } from "node:test";
import assert from "node:assert/strict";
import { Hooks, JournalEntryPage, installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";
import { getLayout } from "../scripts/layouts/registry.mjs";
import { originFromBox } from "../scripts/sizing/geometry.mjs";
import { tiltForSkin } from "../scripts/skins/registry.mjs";

const MODULE_ID = "fvtt-journalinator";
const NOTE_TYPE = `${MODULE_ID}.note`;

const gm = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const player = makeUser("Player0000000001", { name: "Player One" });
const player2 = makeUser("Player0000000002", { name: "Player Two" });
const env = installFoundry({ user: gm, users: [gm, player, player2] });
const containers = await makeContainers(env);
const socket = await import("../scripts/socket.mjs");
const edit = await import("../scripts/edit-session.mjs");

socket.registerSocket();
edit.startEditResync();

const layoutPage = containers.shared.pages.get(containers.ids.layoutPage);
const skin = () => ({
  paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 0
});

function initialOrigin(x, y, layout, rotation) {
  const definition = getLayout(layout);
  return originFromBox({
    x, y, w: definition.widths[0], h: definition.minHeight ?? 120
  }, rotation);
}

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

/** Failure paths intentionally log; keep the test output readable. */
async function quietErrors(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

function notes() {
  return containers.shared.pages.filter(page => page.type === NOTE_TYPE);
}

async function gmRequest(message, options = { timeoutMs: 2000 }) {
  setUser(gm);
  return socket.requestEditReply(message, options);
}

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
  const result = await promise;
  return { result, replies, sent };
}

async function createNote(fields = {}) {
  return gmRequest({
    type: "createNote",
    body: "",
    layout: "plain",
    skin: skin(),
    x: 10,
    y: 20,
    ...fields
  });
}

/** A page shaped like the unsupported pre-v2 storage the clean-break guard must reject. */
async function createLegacyNote() {
  return JournalEntryPage.create({
    name: "legacy-note",
    type: NOTE_TYPE,
    system: { schemaVersion: 1, body: "legacy body", revision: 0 }
  }, { parent: containers.shared });
}

async function beginAsGM(noteId, session = "gm-tab") {
  return { result: await gmRequest({ type: "beginNoteEdit", noteId, clientSessionId: session }) };
}

test("createNote writes a v2 page, stable name, duplicate bodies and a sized card", async () => {
  const first = await createNote({ body: "# Same", x: 40, y: 50, requestEdit: true });
  const second = await createNote({ body: "# Same", x: 0, y: 0 });
  assert.equal(first.type, "noteCreated");
  assert.equal(second.type, "noteCreated");
  assert.notEqual(first.noteId, second.noteId);

  const page = containers.shared.pages.get(first.noteId);
  assert.equal(page.name, `jn-note-${first.noteId}`);
  assert.notEqual(second.noteId, first.noteId);
  assert.equal(page.system.schemaVersion, 2);
  assert.equal(page.system.body, "# Same");
  assert.equal(page.system.revision, 0);
  assert.equal(page.system.authorId, gm.id);
  assert.deepEqual(page.system.links, []);
  assert.equal(page.system.lastSave, null);
  assert.deepEqual(page.system.attachment, {
    mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "default"
  });

  const card = layoutPage.system.cards[first.noteId];
  assert.deepEqual(card.sizing, { mode: "auto", width: null, minHeight: null });
  assert.deepEqual(card.autoSizeOrigin, initialOrigin(40, 50, page.system.layout, card.rotation));
  assert.equal(card.rotation, tiltForSkin(page.system.skin));
  assert.deepEqual(card.ports, ["right"]);
  assert.deepEqual(card.anchors.main, { kind: "main", x: 0.5, y: 0, createdBy: gm.id });

  assert.ok(first.lease);
  assert.equal(first.lease.userId, gm.id);
  assert.ok(first.expiresAt > Date.now());
  assert.equal(edit.leaseFor(first.noteId).leaseToken, first.lease.leaseToken);

  // A creator can render the note from the reply alone, before any document sync.
  assert.equal(first.authorId, gm.id);
  assert.equal(first.createdAt, page.system.createdAt);
  assert.equal(first.updatedAt, page.system.updatedAt);
  assert.deepEqual(first.attachment, page.system.attachment);
  assert.deepEqual(first.links, []);
  assert.equal(first.deleted, false);
  assert.equal(first.lastSave, null);

  const profile = await createNote({ layout: "profile", x: 100, y: 10 });
  const profileCard = layoutPage.system.cards[profile.noteId];
  assert.deepEqual(profileCard.autoSizeOrigin, initialOrigin(100, 10, "profile", profileCard.rotation));
});

test("a failed card write deletes the just-created page", async () => {
  const before = notes().length;
  const original = layoutPage.update;
  layoutPage.update = async () => { throw new Error("card failure"); };
  try {
    const result = await quietErrors(() => createNote({ body: "orphan" }));
    assert.equal(result.type, "noteCreateRejected");
    assert.equal(result.reason, "invalid");
  } finally {
    layoutPage.update = original;
  }
  assert.equal(notes().length, before);
});

test("begin grants one session and denies another user or another tab", async () => {
  const created = await createNote({ body: "begin" });
  const { result: granted } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "player-tab-1"
  });
  assert.equal(granted.type, "noteEditGranted");
  assert.equal(granted.lease.userId, player.id);
  assert.equal(granted.revision, 0);
  assert.equal(granted.body, "begin");

  const { result: secondTab } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "player-tab-2"
  });
  assert.equal(secondTab.type, "noteEditDenied");
  assert.equal(secondTab.reason, "locked");
  assert.equal(secondTab.holder.userId, player.id);

  const { result: otherUser } = await playerRequest(player2, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "other-tab"
  });
  assert.equal(otherUser.type, "noteEditDenied");
  assert.equal(otherUser.reason, "locked");
});

test("heartbeat acknowledges a live lease and revokes an old token", async () => {
  const created = await createNote({ body: "heartbeat" });
  const { result: granted } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "beat-tab"
  });
  const { result: ack } = await playerRequest(player, {
    type: "noteEditHeartbeat", noteId: created.noteId, lease: granted.lease
  });
  assert.equal(ack.type, "noteEditHeartbeatAck");
  assert.equal(ack.leaseToken, granted.lease.leaseToken);
  assert.equal(ack.gmEpoch, edit.authorityEpoch());
  assert.ok(ack.expiresAt > Date.now());

  const oldLease = { ...granted.lease };
  await gmRequest({ type: "forceUnlockNote", noteId: created.noteId });
  setUser(gm);
  const logStart = env.socketLog.length;
  env.deliver({
    type: "noteEditHeartbeat", requestId: "old-beat", noteId: created.noteId, lease: oldLease
  }, player.id);
  await waitFor(() => env.socketLog.slice(logStart)
    .some(entry => entry.message.type === "noteEditRevoked"));
  const revoked = env.socketLog.slice(logStart).map(entry => entry.message)
    .find(item => item.type === "noteEditRevoked");
  assert.ok(revoked);
  assert.equal(revoked.leaseToken, oldLease.leaseToken);
});

test("preview relays once per increasing sequence and never writes the note", async () => {
  const created = await createNote({ body: "preview" });
  const granted = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "preview-tab"
  });
  const lease = granted.result.lease;
  const page = containers.shared.pages.get(created.noteId);
  const revision = page.system.revision;

  setUser(gm);
  let mark = env.socketLog.length;
  env.deliver({
    type: "previewNoteBody", noteId: created.noteId, lease, sequence: 1, body: "live text"
  }, player.id);
  await waitFor(() => env.socketLog.slice(mark)
    .some(entry => entry.message.type === "notePreview"));
  const preview = env.socketLog.slice(mark).map(entry => entry.message)
    .find(item => item.type === "notePreview");
  assert.equal(preview.body, "live text");
  assert.equal(preview.sequence, 1);
  assert.equal(preview.userId, player.id);
  assert.equal(preview.leaseToken, lease.leaseToken);
  const options = env.socketLog.slice(mark)
    .find(entry => entry.message.type === "notePreview").options;
  assert.equal(options.recipients.includes(player.id), false);
  assert.equal(options.recipients.includes(gm.id), true);
  assert.equal(edit.getAuthorityPreview(created.noteId).body, "live text");

  mark = env.socketLog.length;
  env.deliver({
    type: "previewNoteBody", noteId: created.noteId, lease, sequence: 1, body: "stale"
  }, player.id);
  await sleep(20);
  assert.equal(env.socketLog.slice(mark).some(entry => entry.message.type === "notePreview"), false);

  mark = env.socketLog.length;
  env.deliver({
    type: "previewNoteBody", noteId: created.noteId, lease, sequence: 0, body: "older"
  }, player.id);
  await sleep(20);
  assert.equal(env.socketLog.slice(mark).some(entry => entry.message.type === "notePreview"), false);

  assert.equal(page.system.revision, revision);
  assert.equal(page.system.body, "preview");
  assert.equal(edit.getAuthorityPreview(created.noteId).sequence, 1);
});

test("body save acknowledges, no-ops, retries, rejects stale and oversize bodies", async () => {
  const created = await createNote({ body: "start" });
  const { result: granted } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "save-tab"
  });
  const lease = granted.lease;
  const page = containers.shared.pages.get(created.noteId);

  let saves = 0;
  const savedHook = Hooks.on("journalinatorNoteSaved", () => { saves++; });
  const body = "edited body";
  const first = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease, sequence: 1,
    baseRevision: 0, body
  });
  assert.equal(first.result.type, "noteSaveAck");
  assert.equal(first.result.revision, 1);
  assert.equal(first.result.sequence, 1);
  assert.equal(first.result.bodyHash, socket.noteBodyHash(body));
  assert.equal(first.result.receipt.requestId, first.sent.requestId);
  assert.equal(page.system.body, body);
  assert.equal(page.system.revision, 1);
  assert.equal(page.system.lastSave.requestId, first.sent.requestId);
  assert.equal(saves, 1);

  const retry = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease, sequence: 1,
    baseRevision: 0, body, requestId: first.sent.requestId
  });
  assert.equal(retry.result.type, "noteSaveAck");
  assert.equal(retry.result.revision, 1);
  assert.equal(saves, 1);

  const noOp = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease, sequence: 2,
    baseRevision: 1, body
  });
  assert.equal(noOp.result.type, "noteSaveAck");
  assert.equal(noOp.result.revision, 1);
  assert.equal(page.system.lastSave.requestId, first.sent.requestId);
  assert.equal(saves, 1);

  const stale = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease, sequence: 3,
    baseRevision: 0, body: "stale write"
  });
  assert.equal(stale.result.type, "noteSaveRejected");
  assert.equal(stale.result.reason, "staleRevision");
  assert.equal(stale.result.revision, 1);
  assert.equal(page.system.body, body);

  const oversize = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease, sequence: 3,
    baseRevision: 1, body: "x".repeat(200001)
  });
  assert.equal(oversize.result.type, "noteSaveRejected");
  assert.equal(oversize.result.reason, "tooLarge");
  assert.equal(page.system.revision, 1);
  Hooks.off("journalinatorNoteSaved", savedHook);
});

test("a re-begun session receives lastSave and the server rejects a lower sequence", async () => {
  const created = await createNote({ body: "start" });
  const { result: granted } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "seq-tab"
  });
  assert.equal(granted.type, "noteEditGranted");

  const first = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease: granted.lease,
    sequence: 1, baseRevision: 0, body: "one"
  });
  assert.equal(first.result.type, "noteSaveAck");

  const second = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease: granted.lease,
    sequence: 2, baseRevision: 1, body: "two"
  });
  assert.equal(second.result.type, "noteSaveAck");

  const ended = await playerRequest(player, {
    type: "endNoteEdit", noteId: created.noteId, lease: granted.lease,
    sequence: 3, baseRevision: 2
  });
  assert.equal(ended.result.type, "noteEditEnded");

  const { result: again } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "seq-tab"
  });
  assert.equal(again.type, "noteEditGranted");
  assert.equal(again.lastSave.sequence, 2, "the grant carries the persisted receipt");

  const lower = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease: again.lease,
    sequence: 1, baseRevision: 2, body: "again"
  });
  assert.equal(lower.result.type, "noteSaveRejected");
  assert.equal(lower.result.reason, "sequenceOutOfOrder");

  const higher = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease: again.lease,
    sequence: 3, baseRevision: 2, body: "again"
  });
  assert.equal(higher.result.type, "noteSaveAck");
  await playerRequest(player, {
    type: "endNoteEdit", noteId: created.noteId, lease: again.lease,
    sequence: 4, baseRevision: 3
  });
});

test("an old token is rejected after force, expiry or an authority epoch change", async () => {
  const created = await createNote({ body: "tokens" });
  const { result: granted } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "token-tab"
  });
  const oldLease = granted.lease;

  const forced = await gmRequest({ type: "forceUnlockNote", noteId: created.noteId });
  assert.equal(forced.type, "noteEditForced");
  assert.equal(forced.previousLease.userId, player.id);

  const afterForce = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease: oldLease, sequence: 1,
    baseRevision: 0, body: "after force"
  });
  assert.equal(afterForce.result.type, "noteSaveRejected");
  assert.equal(afterForce.result.reason, "leaseLost");

  const { result: expiredGrant } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "token-tab"
  });
  edit.expireLeases(Date.now() + edit.LEASE_MS + 1);
  const afterExpiry = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease: expiredGrant.lease, sequence: 1,
    baseRevision: 0, body: "after expiry"
  });
  assert.equal(afterExpiry.result.type, "noteSaveRejected");
  assert.equal(afterExpiry.result.reason, "leaseLost");

  const { result: regranted } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "token-tab"
  });
  edit.initializeAuthority();
  const afterFailover = await playerRequest(player, {
    type: "saveNoteBody", noteId: created.noteId, lease: regranted.lease, sequence: 1,
    baseRevision: 0, body: "after failover"
  });
  assert.equal(afterFailover.result.type, "noteSaveRejected");
  assert.equal(afterFailover.result.reason, "leaseLost");
});

test("end flushes the body, releases after the save, and revokes before replying", async () => {
  const created = await createNote({ body: "end start" });
  const { result: granted } = await beginAsGM(created.noteId, "end-tab");
  const page = containers.shared.pages.get(created.noteId);

  setUser(gm);
  const mark = env.socketLog.length;
  const ended = await gmRequest({
    type: "endNoteEdit", noteId: created.noteId, lease: granted.lease,
    sequence: 1, baseRevision: 0, body: "end body"
  });
  assert.equal(ended.type, "noteEditEnded");
  assert.equal(ended.saved, true);
  assert.equal(ended.released, true);
  assert.equal(ended.revision, 1);
  assert.equal(page.system.body, "end body");
  assert.equal(edit.leaseFor(created.noteId), null);

  const logged = env.socketLog.slice(mark).map(entry => entry.message);
  const revokedAt = logged.findIndex(item => item.type === "noteEditRevoked"
    && item.reason === "ended");
  const leaseAt = logged.findIndex(item => item.type === "noteEditLeaseChanged"
    && item.lease === null);
  assert.ok(revokedAt >= 0);
  assert.ok(leaseAt > revokedAt);
  assert.equal(logged.some(item => item.type === "noteSaveAck"), false,
    "the end reply is the only acknowledgement");
});

test("a failed end flush keeps the lease", async () => {
  const created = await createNote({ body: "keep" });
  const { result: granted } = await beginAsGM(created.noteId, "keep-tab");
  const page = containers.shared.pages.get(created.noteId);
  const original = page.update;
  page.update = async () => { throw new Error("save failure"); };
  try {
    const result = await quietErrors(() => gmRequest({
      type: "endNoteEdit", noteId: created.noteId, lease: granted.lease,
      sequence: 1, baseRevision: 0, body: "never saved"
    }));
    assert.equal(result.type, "noteSaveRejected");
  } finally {
    page.update = original;
  }
  assert.ok(edit.leaseFor(created.noteId));
  assert.equal(edit.leaseFor(created.noteId).leaseToken, granted.lease.leaseToken);
  await gmRequest({ type: "endNoteEdit", noteId: created.noteId, lease: granted.lease });
});

test("appearance saves without touching the body revision and rejects an invalid skin", async () => {
  const created = await createNote({ body: "appearance" });
  const { result: granted } = await beginAsGM(created.noteId, "appearance-tab");
  const page = containers.shared.pages.get(created.noteId);
  const revision = page.system.revision;
  const nextSkin = {
    paper: "parchment", font: "serif", torn: true,
    backgroundImage: "assets/stylized/cork.svg", tiltSeed: 12
  };
  const ack = await gmRequest({
    type: "saveNoteAppearance", noteId: created.noteId, lease: granted.lease,
    layout: "profile", skin: nextSkin
  });
  assert.equal(ack.type, "noteAppearanceAck");
  assert.equal(page.system.layout, "profile");
  assert.equal(page.system.skin.paper, "parchment");
  assert.equal(page.system.skin.font, "serif");
  assert.equal(page.system.revision, revision);
  assert.equal(page.system.body, "appearance");

  const bad = await gmRequest({
    type: "saveNoteAppearance", noteId: created.noteId, lease: granted.lease,
    layout: "profile", skin: { ...nextSkin, paper: "neon" }
  });
  assert.equal(bad.type, "noteAppearanceRejected");
  assert.equal(bad.reason, "invalid");
  assert.equal(page.system.skin.paper, "parchment");
});

test("a body save never rewrites links and [[x]] never creates a note", async () => {
  const created = await createNote({ body: "links" });
  const page = containers.shared.pages.get(created.noteId);
  const link = {
    id: "Link000000000001",
    targetId: player.id,
    label: "", direction: "one", color: "", lineStyle: "solid",
    origin: "drawn", edited: false, createdBy: gm.id
  };
  await page.update({ "system.links": [link] });
  const before = JSON.stringify(page.system.links);
  const count = notes().length;

  const { result: granted } = await beginAsGM(created.noteId, "links-tab");
  const saved = await gmRequest({
    type: "saveNoteBody", noteId: created.noteId, lease: granted.lease, sequence: 1,
    baseRevision: 0, body: "See [[Another Note]] and [[Literal Text]]."
  });
  assert.equal(saved.type, "noteSaveAck");
  assert.equal(JSON.stringify(page.system.links), before);
  assert.equal(notes().length, count);
  assert.equal(page.system.body.includes("[[Another Note]]"), true);
});

test("a state request returns revision, lease and the live preview", async () => {
  const created = await createNote({ body: "state" });
  const { result: granted } = await playerRequest(player, {
    type: "beginNoteEdit", noteId: created.noteId, clientSessionId: "state-tab"
  });
  setUser(gm);
  env.deliver({
    type: "previewNoteBody", noteId: created.noteId, lease: granted.lease,
    sequence: 1, body: "state preview"
  }, player.id);
  await waitFor(() => edit.getAuthorityPreview(created.noteId)?.body === "state preview");

  const { result: state } = await playerRequest(player, {
    type: "requestNoteEditState", noteId: created.noteId
  });
  assert.equal(state.type, "noteEditState");
  assert.equal(state.gmEpoch, edit.authorityEpoch());
  const entry = state.notes.find(note => note.noteId === created.noteId);
  assert.equal(entry.revision, 0);
  assert.equal(entry.deleted, false);
  assert.equal(entry.lease.userId, player.id);
  assert.equal(entry.preview.body, "state preview");
  assert.equal(edit.hasEditor(created.noteId), true);
  assert.equal(edit.getNotePreview(created.noteId).body, "state preview");

  await playerRequest(player, {
    type: "endNoteEdit", noteId: created.noteId, lease: granted.lease
  });
});

test("edit hooks fire exactly once per accepted event", async () => {
  const events = [];
  const beganId = Hooks.on("journalinatorNoteEditBegan", payload => events.push(["began", payload]));
  const savedId = Hooks.on("journalinatorNoteSaved", payload => events.push(["saved", payload]));
  const endedId = Hooks.on("journalinatorNoteEditEnded", payload => events.push(["ended", payload]));
  const forcedId = Hooks.on("journalinatorNoteForceUnlocked", payload => events.push(["forced", payload]));

  const created = await createNote({ body: "hook start" });
  const { result: granted } = await beginAsGM(created.noteId, "hook-tab");
  assert.equal(events.filter(event => event[0] === "began").length, 1,
    "a plain create does not begin an edit; the grant fires once");

  const ack = await gmRequest({
    type: "saveNoteBody", noteId: created.noteId, lease: granted.lease,
    sequence: 1, baseRevision: 0, body: "hook body"
  });
  assert.equal(ack.type, "noteSaveAck");
  assert.equal(events.filter(event => event[0] === "saved").length, 1);

  const retry = await gmRequest({
    type: "saveNoteBody", noteId: created.noteId, lease: granted.lease,
    sequence: 1, baseRevision: 0, body: "hook body", requestId: ack.requestId
  });
  assert.equal(retry.type, "noteSaveAck");
  assert.equal(events.filter(event => event[0] === "saved").length, 1);

  await gmRequest({ type: "endNoteEdit", noteId: created.noteId, lease: granted.lease });
  assert.equal(events.filter(event => event[0] === "ended").length, 1);

  const second = await createNote({ body: "force me", requestEdit: true });
  await gmRequest({ type: "forceUnlockNote", noteId: second.noteId });
  assert.equal(events.filter(event => event[0] === "forced").length, 1);

  Hooks.off("journalinatorNoteEditBegan", beganId);
  Hooks.off("journalinatorNoteSaved", savedId);
  Hooks.off("journalinatorNoteEditEnded", endedId);
  Hooks.off("journalinatorNoteForceUnlocked", forcedId);
});

test("a stale heartbeat does not clear a newer lease held by another session", async () => {
  const created = await createNote({ body: "stale heartbeat" });
  const noteId = created.noteId;

  const { result: first } = await playerRequest(player, {
    type: "beginNoteEdit", noteId, clientSessionId: "stale-tab-a"
  });
  assert.equal(first.type, "noteEditGranted");
  const oldLease = first.lease;

  await gmRequest({ type: "forceUnlockNote", noteId });

  const { result: second } = await playerRequest(player2, {
    type: "beginNoteEdit", noteId, clientSessionId: "fresh-tab-b"
  });
  assert.equal(second.type, "noteEditGranted");
  assert.equal(edit.leaseFor(noteId).clientSessionId, "fresh-tab-b");
  assert.equal(edit.getNoteEditor(noteId).clientSessionId, "fresh-tab-b");

  setUser(gm);
  const mark = env.socketLog.length;
  env.deliver({
    type: "noteEditHeartbeat", requestId: "stale-beat", noteId, lease: oldLease
  }, player.id);
  await sleep(20);

  // Authority and the GM's own mirror still hold B; the stale A heartbeat changed nothing.
  const snapshot = edit.authoritySnapshot(noteId);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].lease.clientSessionId, "fresh-tab-b");
  assert.equal(edit.getNoteEditor(noteId).clientSessionId, "fresh-tab-b");
  const messages = env.socketLog.slice(mark).map(entry => entry.message);
  assert.equal(messages.some(item => item.type === "noteEditRevoked"), false);
  assert.equal(messages.some(item => item.type === "noteEditLeaseChanged" && item.lease === null), false);
});

test("incompatible legacy data makes every shared note write read-only", async () => {
  const current = await createNote({ body: "current world" });
  assert.equal(current.type, "noteCreated");
  const noteId = current.noteId;
  const legacy = await createLegacyNote();
  const legacyBefore = JSON.stringify(legacy.system);
  const countBefore = notes().length;

  const blockedCreate = await createNote({ body: "blocked create" });
  assert.equal(blockedCreate.type, "noteCreateRejected");
  assert.equal(blockedCreate.reason, "incompatible");

  const { result: blockedBegin } = await playerRequest(player, {
    type: "beginNoteEdit", noteId, clientSessionId: "legacy-tab"
  });
  assert.equal(blockedBegin.type, "noteEditDenied");
  assert.equal(blockedBegin.reason, "incompatible");

  const { result: blockedSave } = await playerRequest(player2, {
    type: "saveNoteBody", noteId, lease: null, sequence: 1, baseRevision: 0, body: "blocked"
  });
  assert.equal(blockedSave.type, "noteSaveRejected");
  assert.equal(blockedSave.reason, "incompatible");

  const blockedAppearance = await gmRequest({
    type: "saveNoteAppearance", noteId, lease: null, layout: "plain", skin: skin()
  });
  assert.equal(blockedAppearance.type, "noteAppearanceRejected");
  assert.equal(blockedAppearance.reason, "incompatible");

  setUser(gm);
  const mark = env.socketLog.length;
  env.deliver({
    type: "pasteNote", body: "blocked paste", layout: "plain", skin: skin(), x: 0, y: 0
  }, player.id);
  await waitFor(() => env.socketLog.slice(mark)
    .some(entry => entry.message.type === "writeRejected"));
  assert.equal(notes().length, countBefore, "paste must not create a page");
  assert.equal(JSON.stringify(legacy.system), legacyBefore, "legacy data stays byte-identical");

  await legacy.delete();
  const after = await createNote({ body: "after legacy" });
  assert.equal(after.type, "noteCreated");
  const granted = await gmRequest({
    type: "beginNoteEdit", noteId: after.noteId, clientSessionId: "post-legacy-tab"
  });
  assert.equal(granted.type, "noteEditGranted");
  const saved = await gmRequest({
    type: "saveNoteBody", noteId: after.noteId, lease: granted.lease,
    sequence: 1, baseRevision: 0, body: "current world works"
  });
  assert.equal(saved.type, "noteSaveAck");
});

test("noteCreated carries enough state for a non-GM creator to render at once", async () => {
  const { result } = await playerRequest(player, {
    type: "createNote", body: "player note", layout: "plain", skin: skin(), x: 5, y: 6
  });
  assert.equal(result.type, "noteCreated");
  const page = containers.shared.pages.get(result.noteId);
  assert.equal(result.authorId, player.id);
  assert.equal(result.createdAt, page.system.createdAt);
  assert.equal(result.updatedAt, page.system.updatedAt);
  assert.deepEqual(result.attachment, page.system.attachment);
  assert.deepEqual(result.links, []);
  assert.equal(result.deleted, false);
  assert.equal(result.lastSave, null);
  assert.equal("lease" in result, false);
});

test("journalinatorNoteCreated fires once per create and paste, never on a failed card", async () => {
  const events = [];
  const hookId = Hooks.on("journalinatorNoteCreated", payload => events.push(payload));

  const created = await createNote({ body: "hook create" });
  assert.equal(created.type, "noteCreated");
  const createEvents = events.filter(event => event.noteId === created.noteId);
  assert.equal(createEvents.length, 1);
  assert.equal(createEvents[0].source, "create");
  assert.equal(createEvents[0].authorId, gm.id);
  assert.equal(createEvents[0].body, "hook create");
  assert.equal(createEvents[0].previousBody, "");
  assert.equal(createEvents[0].layout, "plain");
  assert.deepEqual(createEvents[0].skin, created.skin);
  assert.equal(createEvents[0].revision, 0);
  assert.equal(createEvents[0].createdAt, created.createdAt);

  setUser(gm);
  env.deliver({
    type: "pasteNote", body: "hook paste", layout: "plain", skin: skin(), x: 0, y: 0
  }, player.id);
  assert.equal(await waitFor(() => events.some(event => event.source === "paste")), true);
  const pasteEvents = events.filter(event => event.source === "paste");
  assert.equal(pasteEvents.length, 1);
  assert.equal(pasteEvents[0].authorId, player.id);
  assert.equal(pasteEvents[0].body, "hook paste");
  assert.equal(pasteEvents[0].previousBody, "");
  assert.equal(pasteEvents[0].revision, 0);

  const before = events.length;
  const original = layoutPage.update;
  layoutPage.update = async () => { throw new Error("card failure"); };
  try {
    const failed = await quietErrors(() => createNote({ body: "hook failure" }));
    assert.equal(failed.type, "noteCreateRejected");
  } finally {
    layoutPage.update = original;
  }
  assert.equal(events.length, before);

  Hooks.off("journalinatorNoteCreated", hookId);
});
