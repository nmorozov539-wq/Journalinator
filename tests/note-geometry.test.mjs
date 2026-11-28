import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";

const MODULE_ID = "fvtt-journalinator";
const NOTE_TYPE = `${MODULE_ID}.note`;

const gm = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const player = makeUser("Player0000000001", { name: "Player One" });
const env = installFoundry({ user: gm, users: [gm, player] });
const containers = await makeContainers(env);
const socket = await import("../scripts/socket.mjs");

socket.registerSocket();

const layoutPage = containers.shared.pages.get(containers.ids.layoutPage);

const skin = () => ({
  // Cream has a zero tint tilt, so this file can assert plain top-center origin math;
  // rotated-origin behavior is covered by sizing/creation tests.
  paper: "cream", font: "default", torn: false, backgroundImage: null, tiltSeed: 0
});

function setUser(user) {
  game.user = user;
}

async function gmRequest(message) {
  setUser(gm);
  return socket.requestEditReply(message, { timeoutMs: 2000 });
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

function warnings() {
  return env.notifications.filter(entry => entry[0] === "warn").length;
}

/** Counts layout document writes performed by the handler under test. */
async function withLayoutWriteCount(run) {
  const original = layoutPage.update;
  let count = 0;
  layoutPage.update = async function (...args) {
    count++;
    return original.apply(this, args);
  };
  try {
    const result = await run();
    return { result, count };
  } finally {
    layoutPage.update = original;
  }
}

function card(noteId) {
  return layoutPage.system.cards[noteId];
}

test("setCardSizing accepts auto and manual sizing in one validated update", async () => {
  const note = await createNote({ x: 30, y: 40 });
  assert.deepEqual(card(note.noteId).sizing, { mode: "auto", width: null, minHeight: null });

  const manual = await withLayoutWriteCount(() => gmWrite({
    type: "setCardSizing", noteId: note.noteId,
    sizing: { mode: "manual", width: 320, minHeight: 240 },
    autoSizeOrigin: { x: 55, y: 65 },
    x: 12, y: 18
  }));
  assert.equal(manual.count, 1, "the whole sizing patch is one layout update");
  assert.deepEqual(card(note.noteId).sizing, { mode: "manual", width: 320, minHeight: 240 });
  assert.deepEqual(card(note.noteId).autoSizeOrigin, { x: 55, y: 65 });
  assert.equal(card(note.noteId).x, 12);
  assert.equal(card(note.noteId).y, 18);

  const auto = await withLayoutWriteCount(() => gmWrite({
    type: "setCardSizing", noteId: note.noteId,
    sizing: { mode: "auto", width: null, minHeight: null }
  }));
  assert.equal(auto.count, 1);
  assert.deepEqual(card(note.noteId).sizing, { mode: "auto", width: null, minHeight: null });

  const before = JSON.stringify(card(note.noteId));
  const invalid = [
    { sizing: { mode: "manual", width: 159, minHeight: 200 } },
    { sizing: { mode: "manual", width: 801, minHeight: 200 } },
    { sizing: { mode: "manual", width: 320, minHeight: 79 } },
    { sizing: { mode: "manual", width: 320, minHeight: 1601 } },
    { sizing: { mode: "manual", width: null, minHeight: 200 } },
    { sizing: { mode: "manual", width: 320, minHeight: null } },
    { sizing: { mode: "auto", width: 300, minHeight: null } },
    { sizing: { mode: "auto", width: null, minHeight: 200 } },
    { sizing: { mode: "huge", width: null, minHeight: null } },
    { sizing: { mode: "auto", width: null, minHeight: null }, autoSizeOrigin: { x: 1, y: Infinity } },
    { sizing: { mode: "auto", width: null, minHeight: null }, x: NaN },
    { sizing: { mode: "auto", width: null, minHeight: null }, extra: true }
  ];
  for (const fields of invalid) {
    const result = await withLayoutWriteCount(() => gmWrite({
      type: "setCardSizing", noteId: note.noteId, ...fields
    }));
    assert.equal(result.count, 0, `invalid sizing must not write: ${JSON.stringify(fields)}`);
    assert.equal(JSON.stringify(card(note.noteId)), before);
  }

  const rejected = warnings();
  assert.equal(rejected, 0, "validation failures are silent like other invalid payloads");
});

test("moveCard translates the auto-size origin by the same delta", async () => {
  const note = await createNote({ x: 40, y: 50 });
  const start = card(note.noteId);
  assert.deepEqual(start.autoSizeOrigin, { x: 40 + 110, y: 50 });

  const moved = await withLayoutWriteCount(() => gmWrite({
    type: "moveCard", noteId: note.noteId, x: 140, y: 90
  }));
  assert.equal(moved.count, 1);
  assert.equal(card(note.noteId).x, 140);
  assert.equal(card(note.noteId).y, 90);
  assert.deepEqual(card(note.noteId).autoSizeOrigin, { x: 250, y: 90 });

  const disabled = await createNote({ x: 0, y: 0 });
  await layoutPage.update({
    [`system.cards.${disabled.noteId}.-=autoSizeOrigin`]: null
  });
  await gmWrite({ type: "moveCard", noteId: disabled.noteId, x: 10, y: 20 });
  assert.equal(card(disabled.noteId).x, 10);
  assert.equal("autoSizeOrigin" in card(disabled.noteId), false,
    "a card without an origin does not gain one");
});

test("moveCards writes every move and origin in one update and rejects bad groups", async () => {
  const a = await createNote({ x: 0, y: 0 });
  const b = await createNote({ x: 300, y: 0 });
  const c = await createNote({ x: 600, y: 0 });
  const before = JSON.stringify({
    a: card(a.noteId), b: card(b.noteId), c: card(c.noteId)
  });

  const invalidGroups = [
    [],
    [{ noteId: a.noteId, x: 10, y: 10 }, { noteId: a.noteId, x: 20, y: 20 }],
    [{ noteId: a.noteId, x: 10, y: 10 }, { noteId: b.noteId, x: 20, y: Infinity }],
    [{ noteId: a.noteId, x: 10, y: 10 }, { noteId: "missing000000001", x: 20, y: 20 }],
    [{ noteId: a.noteId, x: 10, y: 10 }, { noteId: c.noteId, x: 20, y: 20 },
      ...Array.from({ length: 49 }, () => ({ noteId: b.noteId, x: 1, y: 1 }))]
  ];
  for (const moves of invalidGroups) {
    const result = await withLayoutWriteCount(() => gmWrite({ type: "moveCards", moves }));
    assert.equal(result.count, 0, "an invalid group writes nothing");
    assert.equal(JSON.stringify({
      a: card(a.noteId), b: card(b.noteId), c: card(c.noteId)
    }), before);
  }

  // Copy: the fake document merge mutates nested objects in place.
  const originA = { ...card(a.noteId).autoSizeOrigin };
  const originB = { ...card(b.noteId).autoSizeOrigin };
  const originC = { ...card(c.noteId).autoSizeOrigin };
  const moved = await withLayoutWriteCount(() => gmWrite({
    type: "moveCards",
    moves: [
      { noteId: a.noteId, x: 50, y: 60 },
      { noteId: b.noteId, x: 250, y: 70 },
      { noteId: c.noteId, x: 650, y: 80 }
    ]
  }));
  assert.equal(moved.count, 1, "the whole group is one layout update");
  assert.deepEqual(card(a.noteId).autoSizeOrigin, {
    x: originA.x + 50, y: originA.y + 60
  });
  assert.deepEqual(card(b.noteId).autoSizeOrigin, {
    x: originB.x - 50, y: originB.y + 70
  });
  assert.deepEqual(card(c.noteId).autoSizeOrigin, {
    x: originC.x + 50, y: originC.y + 80
  });
});

test("delete removes only the target card and leaves no origin behind", async () => {
  const a = await createNote({ x: 0, y: 0 });
  const b = await createNote({ x: 300, y: 0 });
  const cardB = JSON.stringify(card(b.noteId));

  await gmWrite({ type: "deleteNote", noteId: a.noteId });
  assert.ok(containers.shared.pages.get(a.noteId).system.deleted);
  assert.equal(card(a.noteId), undefined);
  assert.equal(containers.shared.pages.get(a.noteId).system.deleted.lastCard.autoSizeOrigin !== undefined,
    true, "the trashed card keeps its origin for restore");
  assert.equal(JSON.stringify(card(b.noteId)), cardB);

  const c = await createNote({ x: 600, y: 0 });
  await gmWrite({ type: "deleteNotes", noteIds: [b.noteId, c.noteId] });
  assert.equal(card(b.noteId), undefined);
  assert.equal(card(c.noteId), undefined);
  assert.ok(containers.shared.pages.get(b.noteId).system.deleted);
});

test("transfer placement reads v2 sizing instead of only legacy width/height", async () => {
  // A manual card is larger than the legacy fallback, so a free spot beside it must clear the
  // manual width. Place one big card and ask for a new one in the same area.
  const big = await createNote({ x: 0, y: 0 });
  await gmWrite({
    type: "setCardSizing", noteId: big.noteId,
    sizing: { mode: "manual", width: 800, minHeight: 400 }
  });
  const placed = await createNote({ x: 200, y: 0 });
  assert.ok(placed.noteId);
  // createNote uses the requested point rather than free placement; the shared findFreeSpot path
  // is exercised by restore. Trash and restore the second note next to the big manual card.
  await gmWrite({ type: "deleteNote", noteId: placed.noteId });
  // Force a colliding stored position just inside the manual card's real width (but beyond the
  // legacy 200 px fallback) so restore must search using v2 sizing.
  const page = containers.shared.pages.get(placed.noteId);
  const stored = { ...page.system.deleted.lastCard, x: 750, y: 0 };
  await page.update({ "system.deleted": { ...page.system.deleted, lastCard: stored } });
  await gmWrite({ type: "restoreNote", noteId: placed.noteId });
  const restored = card(placed.noteId);
  assert.notEqual(restored.x, 750, "restore moved the card off the wide manual card");
  assert.equal(restored.sizing.mode, "auto");
});
