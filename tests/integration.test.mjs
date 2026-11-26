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
const { resolvePresentation } = await import("../scripts/presentation.mjs");
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

test("location creation keeps title separate from an empty body", async () => {
  await fromPlayer({ type: "createNote", title: "New Location", kind: "location", x: 300, y: 0 });
  const location = sharedByName("New Location");
  assert.equal(location.system.kind, "location");
  assert.equal(location.system.style, "document");
  assert.equal(location.system.blocks[0].text, "");
});

test("keyboard undo restores only the matching deletion", async () => {
  const note = sharedByName("New Location");
  const undoId = "DeletionToken001";
  const oldCard = structuredClone(notesStore.getSharedLayout().cards[note.id]);
  await fromPlayer({ type: "deleteNote", noteId: note.id, undoId });
  assert.equal(note.system.deleted.undoId, undoId);
  assert.equal(notesStore.getSharedLayout().cards[note.id], undefined);
  await requestWrite({ type: "restoreNote", noteId: note.id, undoId });
  assert.ok(note.system.deleted, "another client cannot undo this deletion via its keyboard");
  await fromPlayer({ type: "restoreNote", noteId: note.id, undoId });
  assert.equal(note.system.deleted, null);
  const card = notesStore.getSharedLayout().cards[note.id];
  assert.deepEqual([card.x, card.y], [oldCard.x, oldCard.y]);
  await fromPlayer({ type: "deleteNote", noteId: note.id });
  await fromPlayer({ type: "restoreNote", noteId: note.id, undoId });
  assert.ok(note.system.deleted, "old keyboard undo cannot restore a newer deletion");
  await fromPlayer({ type: "restoreNote", noteId: note.id });
  assert.equal(note.system.deleted, null, "manual trash restore still works");
});

test("target cards retain image links and custom socket sides after restoration", async () => {
  await fromPlayer({ type: "createNote", title: "Wanted fixture", style: "wanted" });
  const note = sharedByName("Wanted fixture");
  assert.equal(note.system.style, "wanted");
  const image = "https://example.com/portraits/target.webp";
  await fromPlayer({ type: "setNoteImage", noteId: note.id, image });
  await fromPlayer({ type: "setNoteImage", noteId: note.id, image: "file:///portrait.webp" });
  await fromPlayer({ type: "setCardPorts", noteId: note.id, ports: ["left", "top"] });
  await fromPlayer({ type: "setCardPorts", noteId: note.id, ports: [] });
  await fromPlayer({ type: "setCardPorts", noteId: note.id, ports: ["left", "left"] });
  await requestWrite({ type: "deleteNote", noteId: note.id });
  await requestWrite({ type: "restoreNote", noteId: note.id });
  assert.deepEqual(notesStore.getSharedLayout().cards[note.id].ports, ["left", "top"]);
  assert.equal(note.system.image, image);
});

test("shared stamps attach to a note or stay movable on the board", async () => {
  await requestWrite({ type: "createNote", title: "Stamp fixture" });
  const note = sharedByName("Stamp fixture");
  await fromPlayer({ type: "addLabel", stamp: "skull", noteId: note.id });
  await fromPlayer({ type: "addLabel", stamp: "paw", x: 15, y: 40 });
  const labels = () => Object.entries(notesStore.getSharedLayout().labels);
  const [attached] = labels().find(([, label]) => label.stamp === "skull");
  const [loose] = labels().find(([, label]) => label.stamp === "paw");
  assert.equal(notesStore.getSharedLayout().labels[attached].noteId, note.id);
  assert.equal(notesStore.getSharedLayout().labels[attached].corner, "bottom-right");
  await fromPlayer({ type: "updateLabel", labelId: attached, corner: "top-left" });
  await fromPlayer({ type: "updateLabel", labelId: loose, corner: "top-left" });
  assert.equal(notesStore.getSharedLayout().labels[loose].corner, undefined);
  await fromPlayer({ type: "addLabel", stamp: "compass", noteId: note.id });
  assert.deepEqual(labels().filter(([, label]) => label.noteId === note.id).map(([, label]) => label.stamp), ["compass"]);
  assert.equal(notesStore.getSharedLayout().labels[attached].corner, "top-left");
  await fromPlayer({ type: "updateLabel", labelId: attached, corner: "center" });
  assert.equal(notesStore.getSharedLayout().labels[attached].corner, "top-left");
  await fromPlayer({ type: "updateLabel", labelId: attached, color: "#5a83ad" });
  assert.equal(notesStore.getSharedLayout().labels[attached].color, "#5a83ad");
  await fromPlayer({ type: "updateLabel", labelId: loose, x: 250 });
  assert.equal(notesStore.getSharedLayout().labels[loose].x, 250);
  await fromPlayer({ type: "addLabel", stamp: "../outside" });
  await fromPlayer({ type: "addLabel", stamp: "paw", noteId: "MissingNote00001" });
  assert.equal(labels().length, 2);
  await requestWrite({ type: "deleteNote", noteId: note.id });
  await requestWrite({ type: "restoreNote", noteId: note.id });
  assert.equal(notesStore.getSharedLayout().labels[attached].noteId, note.id);
  await requestWrite({ type: "deleteNote", noteId: note.id });
  await requestWrite({ type: "emptyTrash" });
  assert.equal(notesStore.getSharedLayout().labels[attached], undefined);
  await fromPlayer({ type: "removeLabel", labelId: loose });
  assert.equal(notesStore.getSharedLayout().labels[loose], undefined);
});

test("GM writes a secret note with typed links into both namespaces", async () => {
  vexId = await secrets.createSecretNote({ title: "Lord Vex", x: 0, y: 0 });
  await secrets.addSecretStamp(vexId, "crowned-helm");
  await secrets.addSecretStamp(vexId, "sun-shield");
  assert.equal(Object.values(notesStore.getLayout().labels).filter(label => label.noteId === vexId).length, 1);
  assert.ok(Object.values(notesStore.getLayout().labels)
    .some(label => label.noteId === vexId && label.stamp === "sun-shield" && label.hidden));
  assert.ok(!Object.values(notesStore.getSharedLayout().labels).some(label => label.noteId === vexId));
  const [sealId] = Object.entries(notesStore.getLayout().labels).find(([, label]) => label.noteId === vexId);
  await secrets.updateHiddenLabel(sealId, { color: "#53936b", corner: "bottom-left" });
  assert.equal(notesStore.getLayout().labels[sealId].color, "#53936b");
  assert.equal(notesStore.getLayout().labels[sealId].corner, "bottom-left");
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

test("secret legacy setters keep stored presentation in sync", async () => {
  const id = await secrets.createSecretNote({ title: "Legacy Secret", x: 700, y: 0 });
  await secrets.setSecretNotePresentation(id, { font: "hand", pictureLayout: "left" });
  await secrets.setSecretTargetHeading(id, "  Secret Heading  ");
  await secrets.setSecretNoteStyle(id, "torn");

  let note = vaultStore.data.notes[id];
  let presentation = resolvePresentation(note);
  assert.equal(presentation.extendedStyle, "memo");
  assert.equal(presentation.forceExtended, true);
  assert.equal(presentation.torn, true);
  assert.equal(presentation.font, "hand", "a style change keeps the chosen font");
  assert.equal(presentation.pictureLayout, "left");
  assert.equal(presentation.heading, "Secret Heading");
  assert.equal(note.schemaVersion, 1);

  await secrets.setSecretNotePresentation(id, { font: "serif" });
  assert.equal(vaultStore.data.notes[id].targetHeading, "Secret Heading",
    "an absent heading leaves the legacy secret heading alone");
  await secrets.setSecretNotePresentation(id, { heading: "" });
  assert.equal(vaultStore.data.notes[id].targetHeading, "",
    "an explicit empty heading clears the legacy secret heading");
  assert.equal(resolvePresentation(vaultStore.data.notes[id]).heading, "");

  await secrets.renameSecretNote(id, "Captain of Secrets");
  note = vaultStore.data.notes[id];
  presentation = resolvePresentation(note);
  assert.equal(presentation.nameGenerated, false);
  assert.equal(note.label, "Captain of Secrets", "a meaningful rename replaces the old bare label");
  assert.equal(note.schemaVersion, 1);
  assert.ok(note.formerNames.some(name => name.endsWith(" Legacy Secret")),
    "the previous secret title is kept as a former name");

  await secrets.deleteSecretNote(id);
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
  await secrets.addHiddenLink(tavernId, targetId, { sourceSide: "bottom", targetSide: "top" });
  const hiddenLink = vaultStore.data.hiddenLinks[tavernId].find(l => l.targetId === targetId);
  assert.ok(hiddenLink, "GM-only drawn link exists before the edit");

  await requestWrite({ type: "createLink", sourceId: tavernId, targetId, sourceSide: "right", targetSide: "left" });
  const publicLink = sharedByName("Tavern").system.links.find(l => l.targetId === targetId);
  assert.deepEqual([publicLink.sourceSide, publicLink.targetSide], ["right", "left"]);
  assert.deepEqual([hiddenLink.sourceSide, hiddenLink.targetSide], ["bottom", "top"]);

  await secrets.saveSecretBlock(tavernId, hiddenBlockId, "The keeper is a cultist.");
  assert.ok(
    vaultStore.data.hiddenLinks[tavernId]?.some(l => l.id === hiddenLink.id),
    "the pre-existing GM-only link was not dropped"
  );
});

test("client-created links cannot carry route waypoints before Phase 6", async () => {
  await fromPlayer({ type: "createNote", title: "Route Ignore Target", x: 620, y: 0 });
  const target = sharedByName("Route Ignore Target");
  assert.ok(cultId && vaultStore.data.notes[cultId], "the waypoint note is still secret");
  const malicious = [{ noteId: cultId, anchorId: "main" }, { noteId: tavernId, anchorId: "main" }];
  await fromPlayer({
    type: "createLink", sourceId: tavernId, targetId: target.id, routeAnchors: malicious
  });
  const link = sharedByName("Tavern").system.links.find(item => item.targetId === target.id);
  assert.deepEqual(link.routeAnchors, [], "createLink ignores client routeAnchors");
  assert.ok(!JSON.stringify(link).includes(cultId), "a still-secret waypoint id never enters the link");

  await fromPlayer({
    type: "updateLink", noteId: tavernId, linkId: link.id, fields: { routeAnchors: malicious }
  });
  const updated = sharedByName("Tavern").system.links.find(item => item.id === link.id);
  assert.deepEqual(updated.routeAnchors, [], "updateLink does not accept route changes");
  assert.ok(!JSON.stringify(updated).includes(cultId));
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

test("declassifying a routed link drops waypoints through still-secret notes", async () => {
  const waypointId = await secrets.createSecretNote({ title: "Waypoint Secret", x: 0, y: 0 });
  const routedId = await secrets.createSecretNote({ title: "Routed Secret", x: 100, y: 0 });
  await secrets.addHiddenLink(routedId, tavernId, { sourceSide: "right", targetSide: "left" });
  const hidden = vaultStore.data.notes[routedId].links.find(link => link.targetId === tavernId);
  await secrets.updateHiddenLink(routedId, hidden.id, {
    routeAnchors: [
      { noteId: waypointId, anchorId: "main" },
      { noteId: tavernId, anchorId: "main" }
    ]
  });

  assert.equal(await secrets.declassifyNote(routedId, "Published Route"), true);
  const page = shared().pages.get(routedId);
  const link = page.system.links.find(item => item.targetId === tavernId);
  assert.deepEqual(link.routeAnchors.map(anchor => anchor.noteId), [tavernId],
    "only the live shared waypoint is published");

  const dump = playerVisibleDump();
  assert.ok(!dump.includes(waypointId), "a still-secret waypoint id must not leave the vault");
  assert.ok(!dump.includes(vaultStore.data.notes[waypointId].name),
    "a still-secret waypoint title must not leave the vault");
  assert.ok(vaultStore.data.notes[waypointId], "the waypoint note itself stays secret");
});

test("declassification preserves bounded former names after a secret rename", async () => {
  const secretId = await secrets.createSecretNote({ title: "Former Secret", x: 0, y: 0 });
  const oldName = vaultStore.data.notes[secretId].name;
  await secrets.renameSecretNote(secretId, "Renamed Secret");
  assert.notEqual(vaultStore.data.notes[secretId].name, oldName);

  assert.equal(await secrets.declassifyNote(secretId, "Public Renamed Secret"), true);
  const page = shared().pages.get(secretId);
  assert.deepEqual(page.system.formerNames, [oldName], "the former secret title survives declassification");
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

test("typed links count toward links drawn exactly once", async () => {
  await fromPlayer({ type: "createNote", title: "Activity Source", x: 0, y: 0 });
  const source = sharedByName("Activity Source");
  const blockId = source.system.blocks[0].blockId;
  const linkActivity = () => Object.values(notesStore.getStats()?.activity ?? {})
    .reduce((total, day) => total + Object.values(day).reduce((sum, bucket) => sum + (bucket.links ?? 0), 0), 0);
  const before = linkActivity();

  await fromPlayer({ type: "requestLock", noteId: source.id, blockId });
  await fromPlayer({ type: "saveBlock", noteId: source.id, blockId, text: "See [[Activity Target]]." });
  await fromPlayer({ type: "releaseLock", noteId: source.id, blockId });
  assert.equal(linkActivity(), before + 1, "a new typed link is counted");

  await fromPlayer({ type: "requestLock", noteId: source.id, blockId });
  await fromPlayer({ type: "saveBlock", noteId: source.id, blockId, text: "See [[Activity Target]] again." });
  await fromPlayer({ type: "releaseLock", noteId: source.id, blockId });
  assert.equal(linkActivity(), before + 1, "re-saving the same typed link is not counted twice");
});

test("offline writes warn instead of disappearing silently", async () => {
  const wasActive = gmUser.active;
  gmUser.active = false;
  env.notifications.length = 0;
  const result = await requestWrite({ type: "createNote", title: "Offline Note", x: 0, y: 0 });
  assert.equal(result, false);
  assert.equal(sharedByName("Offline Note"), undefined);
  assert.ok(env.notifications.some(([level, message]) => level === "warn" && message.includes("Read-only")));
  gmUser.active = wasActive;
});

test("only the GM may link a note to an actor, and the ref survives as shared note data", async () => {
  await requestWrite({ type: "createNote", title: "Linked NPC" });
  const note = sharedByName("Linked NPC");
  const actor = { id: "ActorLink0000001", name: "Villain", statuses: new Set(["dead"]), testUserPermission: () => true };
  const scene = { id: "SceneLink0000001", name: "Crypt", tokens: new Map() };
  globalThis.game.actors = new Map([[actor.id, actor]]);
  globalThis.game.scenes = Object.assign(new Map([[scene.id, scene]]), { active: scene });
  const ref = { actorId: actor.id, sceneId: scene.id };

  await fromPlayer({ type: "linkActor", noteId: note.id, actorRef: ref });
  assert.equal(note.system.actorRef, null, "players cannot choose which actor a shared note watches");

  await requestWrite({ type: "linkActor", noteId: note.id, actorRef: ref });
  assert.deepEqual(note.system.actorRef, { ...ref, tokenId: null });

  await requestWrite({ type: "linkActor", noteId: note.id, actorRef: { actorId: "MissingActor0001", sceneId: scene.id } });
  assert.deepEqual(note.system.actorRef, { ...ref, tokenId: null }, "unknown actors are rejected");

  await requestWrite({ type: "linkActor", noteId: note.id, actorRef: null });
  assert.equal(note.system.actorRef, null);
});

test("mid-suite leak check (key is in the world now: open mode, so only ciphertext is checked)", () => {
  // In open mode the key is readable by design, so check the vault blob holds no plaintext.
  const blob = JSON.stringify(containers.secrets.flags["fvtt-journalinator"].vault);
  for (const s of ["Hidden Cult", "secret link label", "GM label text"]) assert.ok(!blob.includes(s));
});

test("new shared notes carry schema defaults, a label slot and a main anchor", async () => {
  await fromPlayer({ type: "createNote", title: "Presentation Fixture", x: 0, y: 0 });
  const note = sharedByName("Presentation Fixture");
  assert.equal(note.system.schemaVersion, 1);
  assert.equal(note.system.label, "");
  assert.equal(note.system.presentation.extendedStyle, "memo");
  assert.equal(note.system.presentation.forceExtended, false);
  assert.equal(note.system.attachment.mainPinEnabled, true);
  assert.equal(note.system.attachment.mainSnapRadius, 24);
  const card = notesStore.getSharedLayout().cards[note.id];
  assert.deepEqual(card.anchors.main, {
    kind: "main", x: 0.5, y: 0, createdBy: player.id
  });
});

test("presentation, label and attachment handlers roundtrip and reject invalid batches", async () => {
  const note = sharedByName("Presentation Fixture");
  const originalName = note.name;

  await fromPlayer({
    type: "setNotePresentation", noteIds: [note.id],
    fields: { extendedStyle: "document", font: "hand", pictureLayout: "left", torn: true }
  });
  assert.equal(note.system.presentation.extendedStyle, "document");
  assert.equal(note.system.presentation.font, "hand");
  assert.equal(note.system.presentation.pictureLayout, "left");
  assert.equal(note.system.presentation.torn, true);
  assert.equal(note.system.presentation.forceExtended, false, "unspecified fields stay untouched");
  assert.equal(note.system.label, "", "presentation changes do not touch the label");

  await fromPlayer({ type: "setNoteLabel", noteId: note.id, label: "  A readable label  " });
  assert.equal(note.system.label, "A readable label");
  assert.equal(note.name, originalName, "the Foundry page name is never renamed by a label edit");

  await fromPlayer({
    type: "setNoteAttachment", noteIds: [note.id],
    fields: { mainPinEnabled: false, mainSnapRadius: 99, minorSnapRadius: 4, pinStyle: "brass" }
  });
  assert.equal(note.system.attachment.mainPinEnabled, false);
  assert.equal(note.system.attachment.mainSnapRadius, 64);
  assert.equal(note.system.attachment.minorSnapRadius, 4);
  assert.equal(note.system.attachment.pinStyle, "brass");

  // Unknown keys, bad enums and one invalid id reject the whole batch before any write.
  await fromPlayer({
    type: "setNotePresentation", noteIds: [note.id], fields: { unknownField: true }
  });
  await fromPlayer({
    type: "setNotePresentation", noteIds: [note.id], fields: { extendedStyle: "sticky" }
  });
  await fromPlayer({
    type: "setNotePresentation", noteIds: [note.id, "MissingNote00001"], fields: { font: "serif" }
  });
  await fromPlayer({
    type: "setNoteAttachment", noteIds: [note.id], fields: { pinStyle: "rope" }
  });
  await fromPlayer({
    type: "setNoteAttachment", noteIds: [note.id], fields: { mainPinEnabled: "yes" }
  });
  assert.equal(note.system.presentation.extendedStyle, "document");
  assert.equal(note.system.presentation.font, "hand");
  assert.equal(note.system.attachment.pinStyle, "brass");
  assert.equal(note.system.attachment.mainPinEnabled, false);

  const longLabel = "x".repeat(201);
  await fromPlayer({ type: "setNoteLabel", noteId: note.id, label: longLabel });
  assert.equal(note.system.label.length, 200);
  assert.equal(note.name, originalName);
});

test("legacy setters keep presentation, heading, rename label and schema in sync", async () => {
  const makeLegacy = (name, style) => JournalEntryPage.create({
    name,
    type: "fvtt-journalinator.note",
    system: {
      style, targetHeading: "", schemaVersion: 0,
      blocks: [{ blockId: foundry.utils.randomID(), text: "" }],
      authorId: player.id, createdAt: 1, updatedAt: 1
    }
  }, { parent: shared() });

  const partial = await makeLegacy("Legacy Partial", "wanted");
  await requestWrite({
    type: "setNotePresentation", noteIds: [partial.id], fields: { font: "hand" }
  });
  const partialPresentation = resolvePresentation(partial);
  assert.equal(partialPresentation.extendedStyle, "target", "a partial patch keeps the legacy style");
  assert.equal(partialPresentation.forceExtended, true);
  assert.equal(partialPresentation.torn, false);
  assert.equal(partialPresentation.font, "hand");
  assert.equal(partial.system.schemaVersion, 1);

  const styled = await makeLegacy("Legacy Styled", "sticky");
  await requestWrite({
    type: "setNotePresentation", noteIds: [styled.id],
    fields: { font: "serif", pictureLayout: "left" }
  });
  await requestWrite({ type: "setTargetHeading", noteId: styled.id, heading: "  Wanted heading  " });
  await requestWrite({ type: "setNoteStyle", noteId: styled.id, style: "torn" });
  const styledPresentation = resolvePresentation(styled);
  assert.equal(styledPresentation.extendedStyle, "memo");
  assert.equal(styledPresentation.forceExtended, true);
  assert.equal(styledPresentation.torn, true);
  assert.equal(styledPresentation.font, "serif", "a style change keeps the chosen font");
  assert.equal(styledPresentation.pictureLayout, "left", "a style change keeps the picture layout");
  assert.equal(styledPresentation.heading, "Wanted heading", "a style change keeps the heading");
  assert.equal(styled.system.schemaVersion, 1);

  const headingLegacy = await makeLegacy("Legacy Heading", "wanted");
  await requestWrite({ type: "setTargetHeading", noteId: headingLegacy.id, heading: "Old heading" });
  await requestWrite({
    type: "setNotePresentation", noteIds: [headingLegacy.id], fields: { font: "serif" }
  });
  assert.equal(headingLegacy.system.targetHeading, "Old heading",
    "an absent heading leaves the legacy key alone");
  await requestWrite({
    type: "setNotePresentation", noteIds: [headingLegacy.id], fields: { heading: "" }
  });
  assert.equal(headingLegacy.system.targetHeading, "",
    "an explicit empty heading clears the legacy key");
  assert.equal(resolvePresentation(headingLegacy).heading, "");

  const renamed = await makeLegacy("New Note", "sticky");
  await requestWrite({ type: "setNoteLabel", noteId: renamed.id, label: "New Note" });
  assert.equal(renamed.system.schemaVersion, 1, "setNoteLabel migrates the schema");
  await requestWrite({ type: "renameNote", noteId: renamed.id, title: "Captain Vex" });
  assert.equal(renamed.system.label, "Captain Vex", "a meaningful rename replaces the old bare label");
  assert.equal(renamed.system.presentation.nameGenerated, false);
  assert.equal(renamed.system.schemaVersion, 1);

  const zero = await makeLegacy("New Note", "sticky");
  assert.equal(zero.system.schemaVersion, 0, "legacy pages start unmigrated");
  await requestWrite({ type: "renameNote", noteId: zero.id, title: "Zero To One" });
  assert.equal(zero.system.schemaVersion, 1, "rename migrates a page that was still at schema 0");
});

test("restoring a note copies the whole stored card, including its anchor registry", async () => {
  await requestWrite({ type: "createNote", title: "Anchor Restore Fixture", x: 20, y: 30 });
  const note = sharedByName("Anchor Restore Fixture");
  const layout = shared().pages.get(containers.ids.layoutPage);
  await layout.update({
    [`system.cards.${note.id}.anchors.minor`]: {
      kind: "minor", x: 0.2, y: 0.3, createdBy: player.id
    }
  });
  const before = structuredClone(layout.system.cards[note.id]);

  await requestWrite({ type: "deleteNote", noteId: note.id });
  assert.equal(notesStore.getSharedLayout().cards[note.id], undefined);
  await requestWrite({ type: "restoreNote", noteId: note.id });

  const restored = notesStore.getSharedLayout().cards[note.id];
  assert.deepEqual(restored.anchors, before.anchors);
  assert.deepEqual([restored.x, restored.y], [before.x, before.y]);
});

test("declassification preserves label, presentation, attachment, anchors and link ids", async () => {
  const noteId = "Declassify000001";
  const blockId = "BlockDeclass0001";
  const linkId = "LinkDeclass00001";
  await requestWrite({
    type: "gmCreateNote",
    noteId,
    title: "Declassified Fixture",
    kind: "note",
    style: "wanted",
    targetHeading: "Wanted",
    label: "Public label",
    formerNames: ["First Former", 42, "x".repeat(250)],
    presentation: {
      extendedStyle: "target", forceExtended: true, font: "serif",
      pictureLayout: "left", torn: true, heading: "Wanted", nameGenerated: false
    },
    attachment: {
      mainPinEnabled: false, mainSnapRadius: 18, minorSnapRadius: 3, pinStyle: "wax"
    },
    blocks: [{ blockId, text: "Declassified body" }],
    links: [{
      id: linkId,
      targetId: tavernId,
      label: "public link",
      direction: "one",
      color: "link2",
      lineStyle: "dashed",
      material: "double",
      thickness: 9,
      slack: 2,
      pattern: "alternating",
      ends: "loose",
      secondaryColor: "link3",
      sourceAnchorId: "main",
      targetAnchorId: "main",
      routeAnchors: [{ noteId: tavernId, anchorId: "main" }]
    }],
    card: {
      x: 50, y: 60, width: 200, height: 100, rotation: 2, ports: ["left"],
      anchors: {
        main: { kind: "main", x: 0.5, y: 0, createdBy: gmUser.id },
        minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: gmUser.id }
      }
    }
  });

  const page = shared().pages.get(noteId);
  assert.ok(page);
  assert.equal(page.system.schemaVersion, 1);
  assert.equal(page.system.label, "Public label");
  assert.deepEqual(page.system.formerNames, ["First Former", "x".repeat(200)],
    "declassified former names are bounded strings");
  assert.equal(page.system.presentation.extendedStyle, "target");
  assert.equal(page.system.presentation.pictureLayout, "left");
  assert.equal(page.system.presentation.torn, true);
  assert.equal(page.system.attachment.mainPinEnabled, false);
  assert.equal(page.system.attachment.pinStyle, "wax");
  const link = page.system.links.find(item => item.id === linkId);
  assert.ok(link, "a non-colliding link id is preserved");
  assert.equal(link.material, "double");
  assert.equal(link.thickness, 5);
  assert.equal(link.slack, 0.25);
  assert.equal(link.pattern, "alternating");
  assert.equal(link.secondaryColor, "link3");
  assert.deepEqual(link.routeAnchors, [{ noteId: tavernId, anchorId: "main" }]);
  assert.equal(link.sourceAnchorId, "main");
  const card = notesStore.getSharedLayout().cards[noteId];
  assert.deepEqual(card.anchors, {
    main: { kind: "main", x: 0.5, y: 0, createdBy: gmUser.id },
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: gmUser.id }
  });

  // A colliding link id in a second declassification is regenerated, not overwritten.
  await requestWrite({
    type: "gmCreateNote",
    noteId: "Declassify000002",
    title: "Declassified Fixture 2",
    blocks: [{ blockId: "BlockDeclass0002", text: "Second body" }],
    links: [{ id: linkId, targetId: tavernId }],
    card: { x: 90, y: 60 }
  });
  const second = shared().pages.get("Declassify000002");
  assert.ok(second.system.links[0].id);
  assert.notEqual(second.system.links[0].id, linkId);
  assert.equal(second.system.links[0].material, "linen");
  assert.deepEqual(second.system.links[0].routeAnchors, []);
});

test("shared-world migration is idempotent and adds missing main anchors", async () => {
  const { migrateSharedWorld } = await import("../scripts/migrate.mjs");
  const legacy = await JournalEntryPage.create({
    name: "New Note",
    type: "fvtt-journalinator.note",
    system: {
      style: "sticky",
      targetHeading: "",
      blocks: [{ blockId: "LegacyBlock00001", text: "Legacy body" }],
      authorId: player.id,
      createdAt: 1,
      updatedAt: 1
    }
  }, { parent: shared() });
  const layout = shared().pages.get(containers.ids.layoutPage);
  await layout.update({
    [`system.cards.${legacy.id}`]: { x: 10, y: 20, rotation: 0, ports: ["right"] }
  });

  const first = await migrateSharedWorld();
  assert.ok(first.notes >= 1);
  assert.ok(first.anchors >= 1);
  assert.equal(legacy.system.schemaVersion, 1);
  assert.equal(legacy.system.label, "", "generated title is not turned into a label");
  assert.equal(legacy.system.presentation.extendedStyle, "memo");
  assert.equal(legacy.system.attachment.mainPinEnabled, true);
  assert.deepEqual(layout.system.cards[legacy.id].anchors, {
    main: { kind: "main", x: 0.5, y: 0, createdBy: player.id }
  });

  const snapshot = JSON.stringify({ system: legacy.system, card: layout.system.cards[legacy.id] });
  const second = await migrateSharedWorld();
  assert.equal(second.notes, 0);
  assert.equal(second.anchors, 0);
  assert.equal(
    JSON.stringify({ system: legacy.system, card: layout.system.cards[legacy.id] }),
    snapshot
  );
});

test("final player-visible dump still excludes the remaining secret notes", () => {
  const dump = playerVisibleDump();
  for (const note of Object.values(vaultStore.data?.notes ?? {})) {
    assert.ok(!dump.includes(note.name), `end of suite: secret title "${note.name}" leaked`);
    assert.ok(!dump.includes(note.id), `end of suite: secret note id leaked`);
  }
});
