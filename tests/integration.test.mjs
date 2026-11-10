/**
 * End-to-end data-path test against a fake Foundry (tests/fake-foundry.mjs): the real shared
 * write handler, vault, read layer and GM actions, with one GM client acting as active GM and a
 * player whose messages arrive over the (fake) module socket.
 *
 * The central assertion is the leak check: everything a player client would receive — every
 * world document and every module-socket message this GM client sent — must not contain any
 * hidden text or secret title.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";

const gmUser = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const player = makeUser("Player0000000001", { name: "Player" });
const env = installFoundry({ user: gmUser, users: [gmUser, player] });
const containers = await makeContainers(env);

const { vaultStore } = await import("../scripts/secrets/vault-store.mjs");
const { notesStore } = await import("../scripts/store/notes-store.mjs");
const secrets = await import("../scripts/secrets/secret-actions.mjs");
const { registerSocket, requestWrite } = await import("../scripts/socket.mjs");
registerSocket();

const PASS = "correct horse battery staple";
// Strings only the GM ever wrote. (The player types "Hidden Cult" themselves below, so that
// bare name is legitimately public; the secret note's id and GM-prefixed title are still checked.)
const SECRET_STRINGS = ["betrayed", "is a cultist", "Lord Vex the Elder", "GM label text", "secret link label"];
const settle = () => new Promise(r => setTimeout(r, 60));
const shared = () => containers.shared;
const sharedByName = name => [...shared().pages.values()].find(p => p.name === name);
const fromPlayer = async message => { env.deliver(message, player.id); await settle(); };

/** Everything a player's browser would hold: all world documents plus socket traffic from this GM. */
function playerVisibleDump() {
  const docs = [...env.journal.values()].map(entry => ({
    name: entry.name, flags: entry.flags,
    pages: [...entry.pages.values()].map(p => ({ id: p.id, name: p.name, system: p.system }))
  }));
  return JSON.stringify({ docs, socket: env.socketLog });
}

function assertNoLeak(label) {
  const dump = playerVisibleDump();
  for (const s of SECRET_STRINGS) assert.ok(!dump.includes(s), `${label}: player-visible data contains "${s}"`);
  for (const note of Object.values(vaultStore.data?.notes ?? {})) {
    assert.ok(!dump.includes(note.name), `${label}: secret title "${note.name}" leaked`);
    assert.ok(!dump.includes(note.id), `${label}: secret note id leaked`);
  }
}

let tavernId, vexId, cultId, hiddenBlockId;

test("vault starts absent and is set up with a passphrase", async () => {
  await vaultStore.init();
  assert.equal(vaultStore.status, "absent");
  await vaultStore.setKeyring({ mode: "passphrase", passphrase: PASS });
  assert.equal(vaultStore.status, "unlocked");
  assert.equal(containers.secrets.flags["fvtt-journalinator"].keyring.mode, "passphrase");
  assert.equal(containers.secrets.flags["fvtt-journalinator"].keyring.raw, undefined);
});

test("player creates a shared note through the socket", async () => {
  await fromPlayer({ type: "createNote", title: "Tavern", x: 0, y: 0 });
  tavernId = sharedByName("Tavern").id;
  assert.ok(tavernId);
});

test("GM writes a secret note with typed links into both namespaces", async () => {
  vexId = await secrets.createSecretNote({ title: "Lord Vex", x: 0, y: 0 });
  const note = vaultStore.data.notes[vexId];
  assert.match(note.name, /^GM-[A-Z2-9]{4} Lord Vex$/);
  await secrets.saveSecretBlock(vexId, note.blocks[0].blockId, "He betrayed the [[Tavern]] keeper. See [[Hidden Cult]].");
  const after = vaultStore.data.notes[vexId];
  cultId = Object.values(vaultStore.data.notes).find(n => n.name.endsWith(" Hidden Cult"))?.id;
  assert.ok(cultId, "unknown title in secret text creates a secret note");
  assert.deepEqual(after.links.map(l => l.targetId).sort(), [tavernId, cultId].sort());
  assert.equal(sharedByName("Hidden Cult"), undefined, "no public note was created");
});

test("GM adds a hidden block inside the shared note", async () => {
  const firstShared = sharedByName("Tavern").system.blocks[0].blockId;
  hiddenBlockId = await secrets.addHiddenBlock(tavernId, firstShared);
  await secrets.saveSecretBlock(tavernId, hiddenBlockId, "The keeper is a cultist.");
  const merged = notesStore.getNote(tavernId);
  assert.deepEqual(merged.system.blocks.map(b => b.hidden), [false, true]);
  assert.equal(sharedByName("Tavern").system.blocks.length, 1, "shared note untouched");
});

test("GM-only label and link", async () => {
  await secrets.addHiddenLabel(10, 20, "GM label text");
  const ext = await secrets.createSecretNote({ title: "Extra", x: 300, y: 0 });
  await secrets.addHiddenLink(tavernId, ext);
  const link = vaultStore.data.hiddenLinks[tavernId].find(l => l.targetId === ext);
  await secrets.updateHiddenLink(tavernId, link.id, { label: "secret link label" });
  assert.equal(notesStore.isHiddenLink(tavernId, link.id), true);
});

test("a temporarily missing shared journal never prunes hidden content", async () => {
  const before = {
    notes: Object.keys(vaultStore.data.notes).sort(),
    hiddenBlocks: Object.keys(vaultStore.data.hiddenBlocks).sort(),
    hiddenLinks: Object.keys(vaultStore.data.hiddenLinks).sort()
  };
  assert.ok(before.notes.length && before.hiddenBlocks.length && before.hiddenLinks.length);
  const sharedEntry = shared();
  try {
    env.journal.delete(containers.ids.shared);
    assert.equal(game.journal.get(containers.ids.shared), undefined, "shared entry is really unavailable");
    await vaultStore.mutate(vault => {
      vault.labels.probe = { text: "probe", x: 0, y: 0, size: 14, color: "" };
    });
    assert.deepEqual(Object.keys(vaultStore.data.notes).sort(), before.notes);
    assert.deepEqual(Object.keys(vaultStore.data.hiddenBlocks).sort(), before.hiddenBlocks);
    assert.deepEqual(Object.keys(vaultStore.data.hiddenLinks).sort(), before.hiddenLinks);
  } finally {
    env.journal.set(containers.ids.shared, sharedEntry);
  }
});

test("a pre-existing hidden drawn link survives a hidden-block edit after the shared note links the same target", async () => {
  await fromPlayer({ type: "createNote", title: "Link Target", x: 420, y: 0 });
  const targetId = sharedByName("Link Target").id;
  await secrets.addHiddenLink(tavernId, targetId);
  const hiddenLink = vaultStore.data.hiddenLinks[tavernId].find(l => l.targetId === targetId);
  assert.ok(hiddenLink, "GM-only drawn link exists before the edit");

  await requestWrite({ type: "createLink", sourceId: tavernId, targetId });
  assert.ok(sharedByName("Tavern").system.links.some(l => l.targetId === targetId));

  await secrets.saveSecretBlock(tavernId, hiddenBlockId, "The keeper is a cultist.");
  assert.ok(
    vaultStore.data.hiddenLinks[tavernId]?.some(l => l.id === hiddenLink.id),
    "the pre-existing GM-only link was not dropped"
  );
});

test("player actions never resolve against or collide with secret notes", async () => {
  // Same bare title as a secret note: succeeds for the player, no rejection to learn from.
  await fromPlayer({ type: "createNote", title: "Lord Vex", x: 0, y: 0 });
  assert.ok(sharedByName("Lord Vex"));
  assert.equal(env.socketLog.filter(e => e.message.type === "writeRejected").length, 0);

  // A typed [[Hidden Cult]] by a player creates a *public* note instead of linking the secret one.
  const block = sharedByName("Tavern").system.blocks[0];
  await fromPlayer({ type: "requestLock", noteId: tavernId, blockId: block.blockId });
  await fromPlayer({ type: "saveBlock", noteId: tavernId, blockId: block.blockId, text: "Ask about [[Hidden Cult]]." });
  const publicCult = sharedByName("Hidden Cult");
  assert.ok(publicCult);
  assert.ok(sharedByName("Tavern").system.links.every(l => l.targetId !== cultId));
  await fromPlayer({ type: "releaseLock", noteId: tavernId, blockId: block.blockId });

  await fromPlayer({ type: "requestLock", noteId: tavernId, blockId: block.blockId });
  await fromPlayer({ type: "saveBlock", noteId: tavernId, blockId: block.blockId, text: "A cosy tavern." });
  await fromPlayer({ type: "releaseLock", noteId: tavernId, blockId: block.blockId });
});

test("hidden block keeps its place after the player edits around it", async () => {
  const merged = notesStore.getNote(tavernId).system.blocks;
  assert.equal(merged[0].text, "A cosy tavern.");
  assert.equal(merged[1].blockId, hiddenBlockId);
});

test("nothing secret reaches player-visible data", () => {
  assertNoLeak("after GM edits");
});

test("even the exact GM-prefixed title is free for players (namespaces never collide)", async () => {
  // Runs after the leak check: creating this note makes the title public by the player's own hand.
  const vexTitle = vaultStore.data.notes[vexId].name;
  await fromPlayer({ type: "createNote", title: vexTitle, x: 0, y: 0 });
  assert.ok(sharedByName(vexTitle));
  assert.equal(env.socketLog.filter(e => e.message.type === "writeRejected").length, 0);
});

test("player view and player clients see shared content only", async () => {
  notesStore.setGmView(false);
  assert.ok(notesStore.getAllNotes().every(n => !n.secret));
  assert.equal(notesStore.getNote(vexId), null);
  notesStore.setGmView(true);
  assert.ok(notesStore.getAllNotes().some(n => n.secret));

  game.user = player;
  await vaultStore.init();
  assert.equal(vaultStore.status, "unavailable");
  assert.equal(notesStore.merged, false);
  assert.equal(notesStore.getNote(vexId), null);
  assert.ok(notesStore.getNote(tavernId).system.blocks.every(b => !b.hidden));
  game.user = gmUser;
});

test("lock, wrong passphrase, unlock with remember", async () => {
  await vaultStore.init();
  assert.equal(vaultStore.status, "locked", "key is not remembered unless asked");
  await assert.rejects(vaultStore.unlock("nope"), /wrong passphrase/);
  await vaultStore.unlock(PASS, { remember: true });
  assert.equal(vaultStore.status, "unlocked");
  assert.ok(vaultStore.data.notes[vexId]);
  await vaultStore.init();
  assert.equal(vaultStore.status, "unlocked", "remembered key reopens the vault");
});

test("declassify a hidden block lands it in place, publicly", async () => {
  const ok = await secrets.declassifyBlock(tavernId, hiddenBlockId);
  assert.equal(ok, true);
  const blocks = sharedByName("Tavern").system.blocks;
  assert.deepEqual(blocks.map(b => b.text), ["A cosy tavern.", "The keeper is a cultist."]);
  assert.equal(blocks[1].blockId, hiddenBlockId);
  assert.equal(vaultStore.data.hiddenBlocks[tavernId], undefined);
});

test("declassifying a note refuses a taken title, then publishes with the same id", async () => {
  assert.equal(await secrets.declassifyNote(vexId, "Lord Vex"), false, "player already has 'Lord Vex'");
  assert.ok(env.notifications.some(([, m]) => m.includes("already exists")));
  const ok = await secrets.declassifyNote(vexId, "Lord Vex the Elder");
  assert.equal(ok, true);
  const page = shared().pages.get(vexId);
  assert.equal(page.name, "Lord Vex the Elder");
  assert.ok(page.system.blocks[0].text.includes("betrayed"));
  assert.ok(page.system.links.some(l => l.targetId === tavernId), "typed link re-derived publicly");
  assert.equal(vaultStore.data.notes[vexId], undefined);
  const layout = shared().pages.get(containers.ids.layoutPage).system;
  assert.ok(layout.cards[vexId], "card moved to the shared layout");
});

test("hiding a shared block moves it into the vault", async () => {
  const blocks = sharedByName("Tavern").system.blocks;
  const ok = await secrets.hideSharedBlock(tavernId, blocks[1].blockId);
  assert.equal(ok, true);
  assert.deepEqual(sharedByName("Tavern").system.blocks.map(b => b.text), ["A cosy tavern."]);
  const merged = notesStore.getNote(tavernId).system.blocks;
  assert.deepEqual(merged.map(b => [b.text, b.hidden]), [["A cosy tavern.", false], ["The keeper is a cultist.", true]]);
});

test("hint flags are GM-only writes", async () => {
  await fromPlayer({ type: "gmSetHint", noteId: tavernId, hint: true });
  assert.equal(sharedByName("Tavern").system.hint, false, "player can't set hints");
  await requestWrite({ type: "gmSetHint", noteId: tavernId, hint: true });
  assert.equal(sharedByName("Tavern").system.hint, true);
});

test("player cannot use GM declassify messages", async () => {
  await fromPlayer({ type: "gmCreateNote", noteId: "AAAAAAAAAAAAAAAA", title: "Fake", blocks: [{ text: "x" }] });
  assert.equal(shared().pages.get("AAAAAAAAAAAAAAAA"), undefined);
  await fromPlayer({ type: "gmRemoveBlock", noteId: tavernId, blockId: sharedByName("Tavern").system.blocks[0].blockId });
  assert.equal(sharedByName("Tavern").system.blocks.length, 1);
});

test("still-secret content stays private after declassifying other parts", () => {
  const dump = playerVisibleDump();
  for (const s of ["GM label text", "secret link label"]) assert.ok(!dump.includes(s), s);
  for (const note of Object.values(vaultStore.data.notes)) {
    assert.ok(!dump.includes(note.id), `secret note ${note.name} id leaked`);
  }
});

test("switching to open mode rotates the key", async () => {
  const before = containers.secrets.flags["fvtt-journalinator"].keyring.keyId;
  await vaultStore.setKeyring({ mode: "open" });
  const ring = containers.secrets.flags["fvtt-journalinator"].keyring;
  assert.notEqual(ring.keyId, before);
  assert.equal(ring.mode, "open");
  assert.ok(vaultStore.data.notes[cultId]);
});

test("a non-active GM addresses write requests to the active GM only", async () => {
  const gm2 = makeUser("GMuser0000000002", { isGM: true, name: "GM2" });
  game.user = gm2;
  env.socketLog.length = 0;
  requestWrite({ type: "gmSetHint", noteId: tavernId, hint: false });
  assert.deepEqual(env.socketLog[0].options, { recipients: [gmUser.id] });
  game.user = gmUser;
});

test("final leak check (key is in the world now: open mode, so only ciphertext is checked)", () => {
  // In open mode the key is readable by design, so check the vault blob holds no plaintext.
  const blob = JSON.stringify(containers.secrets.flags["fvtt-journalinator"].vault);
  for (const s of ["Hidden Cult", "secret link label", "GM label text"]) assert.ok(!blob.includes(s));
});
