import { test } from "node:test";
import assert from "node:assert/strict";
import { Hooks, installFoundry, makeUser } from "./fake-foundry.mjs";

const gm = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const gm2 = makeUser("GMuser0000000002", { isGM: true, name: "GM Two" });
const player = makeUser("Player0000000001", { name: "Player" });

const env = installFoundry({ user: gm, users: [gm, gm2, player] });
void env;
const es = await import("../scripts/edit-session.mjs");

const NOTE = "Note000000000001";

function reset() {
  game.user = gm;
  gm.active = true;
  gm2.active = true;
  es.initializeAuthority();
  es.clearEditorState("test-reset");
}

function grant(overrides = {}) {
  return es.grantLease({
    noteId: NOTE,
    userId: player.id,
    userName: player.name,
    userColor: player.color,
    clientSessionId: "session-one",
    requestId: "req-1",
    revision: 3,
    ...overrides
  });
}

test("a lease denies a different user and the same user's second tab", () => {
  reset();
  const first = grant();
  assert.ok(first.lease);
  assert.equal(first.existing, false);
  assert.equal(first.lease.canvasId, "shared");
  assert.equal(first.lease.userId, player.id);
  assert.equal(first.lease.gmEpoch, es.authorityEpoch());

  const otherUser = grant({ userId: gm.id, clientSessionId: "session-two" });
  assert.equal(otherUser.lease, null);
  assert.equal(otherUser.reason, "locked");
  assert.equal(otherUser.holder.userId, player.id);

  const secondTab = grant({ clientSessionId: "session-two" });
  assert.equal(secondTab.lease, null);
  assert.equal(secondTab.reason, "locked");
});

test("the same session re-begins idempotently with the same token", () => {
  reset();
  const first = grant();
  const again = grant({ requestId: "req-2" });
  assert.equal(again.existing, true);
  assert.equal(again.lease.leaseToken, first.lease.leaseToken);
  assert.equal(again.lease.userId, player.id);
  assert.equal(es.leaseFor(NOTE).leaseToken, first.lease.leaseToken);
});

test("heartbeats keep an idle lease alive", () => {
  reset();
  const { lease } = grant();
  const start = Date.now();
  assert.equal(es.isLeaseValid(lease, start + es.LEASE_MS - 1), true);
  assert.equal(es.isLeaseValid(lease, start + es.LEASE_MS + 1), false);

  const beat = es.heartbeat(lease, start + es.LEASE_MS - 1);
  assert.equal(beat.ok, true);
  assert.equal(es.isLeaseValid(lease, start + es.LEASE_MS + 100), true);
  assert.equal(beat.expiresAt, start + es.LEASE_MS - 1 + es.LEASE_MS);
});

test("expiry is injected and returns the revoked lease", () => {
  reset();
  const { lease } = grant();
  const expired = es.expireLeases(Date.now() + es.LEASE_MS + 1);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].noteId, NOTE);
  assert.equal(expired[0].lease.leaseToken, lease.leaseToken);
  assert.equal(expired[0].reason, "expired");
  assert.equal(es.leaseFor(NOTE), null);
  assert.equal(es.isLeaseValid(lease), false);
});

test("preview sequences are monotonic and release clears the preview", () => {
  reset();
  const { lease } = grant();
  const first = es.setPreview(lease, 1, "one");
  assert.equal(first.ok, true);
  assert.equal(es.getAuthorityPreview(NOTE).body, "one");

  assert.equal(es.setPreview(lease, 1, "one again").ok, false);
  assert.equal(es.setPreview(lease, 0, "zero").ok, false);
  assert.equal(es.setPreview(lease, 2, "two").ok, true);
  assert.equal(es.getAuthorityPreview(NOTE).sequence, 2);

  es.releaseLease(lease, "forced");
  assert.equal(es.getAuthorityPreview(NOTE), null);
});

test("force-style release revokes the token", () => {
  reset();
  const { lease } = grant();
  const released = es.releaseLease(lease, "forced");
  assert.equal(released.ok, true);
  assert.equal(released.reason, "forced");
  assert.equal(es.leaseFor(NOTE), null);
  assert.equal(es.isLeaseValid(lease), false);
});

test("snapshot exposes token-free lease info and a new epoch invalidates old tokens", () => {
  reset();
  const { lease } = grant();
  const snapshot = es.authoritySnapshot(NOTE);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].revision, 3);
  assert.equal("leaseToken" in snapshot[0].lease, false);
  assert.equal(snapshot[0].lease.userId, player.id);

  const oldEpoch = es.authorityEpoch();
  const newEpoch = es.initializeAuthority();
  assert.notEqual(newEpoch, oldEpoch);
  assert.equal(es.isLeaseValid(lease), false);
  assert.equal(es.authoritySnapshot(NOTE).length, 0);
});

test("mirror changes fire the edit-state hook", () => {
  reset();
  game.user = player;
  const seen = [];
  const id = Hooks.on("journalinatorEditStateChanged", (noteId, state) => {
    seen.push({ noteId, lease: state.lease, preview: state.preview });
  });

  es.applyEditState([{
    noteId: NOTE,
    revision: 4,
    deleted: false,
    lease: {
      noteId: NOTE, userId: player.id, clientSessionId: es.clientSessionId, leaseToken: "t"
    },
    preview: null
  }], "epoch-a");
  assert.equal(es.isNoteHeldByMe(NOTE), true);
  assert.equal(es.noteIsLocked(NOTE), false);
  assert.equal(es.hasEditor(NOTE), true);

  es.applyLeaseChanged({ type: "noteEditLeaseChanged", noteId: NOTE, lease: null, preview: null });
  assert.equal(es.hasEditor(NOTE), false);
  assert.equal(seen.length >= 2, true);
  assert.equal(seen.at(-1).lease, null);

  es.applyRevoked({ type: "noteEditRevoked", noteId: NOTE, leaseToken: "t" });
  Hooks.off("journalinatorEditStateChanged", id);
});

test("a forced revocation keeps its reason on the edit-state hook payload", () => {
  reset();
  game.user = player;
  const seen = [];
  const id = Hooks.on("journalinatorEditStateChanged", (noteId, state) => {
    seen.push({ noteId, ...state });
  });

  es.applyEditState([{
    noteId: NOTE,
    lease: { noteId: NOTE, userId: gm2.id, clientSessionId: "other", leaseToken: "t" },
    preview: { leaseToken: "t", sequence: 1, body: "live" }
  }], "epoch-forced");

  es.applyRevoked({
    type: "noteEditRevoked",
    noteId: NOTE,
    leaseToken: "t",
    reason: "forced",
    revision: 3
  });
  Hooks.off("journalinatorEditStateChanged", id);

  const last = seen.at(-1);
  assert.equal(last.noteId, NOTE);
  assert.equal(last.lease, null);
  assert.equal(last.preview, null);
  assert.equal(last.reason, "forced", "remote clients can distinguish a GM force-unlock");
  assert.equal(seen.some(state => state.reason === "forced"), true);
});

test("a lease for another user appears locked in the mirror", () => {
  reset();
  es.applyEditState([{
    noteId: NOTE,
    lease: { noteId: NOTE, userId: gm2.id, clientSessionId: "other", leaseToken: "t" },
    preview: { leaseToken: "t", sequence: 1, body: "live" }
  }], "epoch-b");
  assert.equal(es.noteIsLocked(NOTE), true);
  assert.equal(es.isNoteHeldByMe(NOTE), false);
  assert.equal(es.getNotePreview(NOTE).body, "live");
  assert.equal(es.listEditors()[0].userId, gm2.id);
  assert.equal(es.listPreviews().length, 1);
});

test("active-GM failover clears the mirror and starts a fresh authority epoch", () => {
  reset();
  es.startEditResync();
  es.applyEditState([{
    noteId: NOTE,
    lease: { noteId: NOTE, userId: player.id, clientSessionId: "s", leaseToken: "t" }
  }], "epoch-before");
  assert.equal(es.hasEditor(NOTE), true);

  game.user = gm2;
  gm.active = false;
  gm2.active = true;
  Hooks.callAll("updateUser", gm2);
  assert.equal(es.hasEditor(NOTE), false);
  assert.ok(es.authorityEpoch());
  assert.equal(es.gmEpoch(), es.authorityEpoch());

  game.user = gm;
  gm.active = true;
  gm2.active = false;
  Hooks.callAll("updateUser", gm);
});
