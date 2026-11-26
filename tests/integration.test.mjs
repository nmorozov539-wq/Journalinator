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
const { privateStore } = await import("../scripts/store/private-store.mjs");
const secrets = await import("../scripts/secrets/secret-actions.mjs");
const { registerSocket, requestWrite, sanitizeProjectionBox } = await import("../scripts/socket.mjs");
const { resolvePresentation } = await import("../scripts/presentation.mjs");
const { anchorWorld, projectToEdge } = await import("../scripts/anchors.mjs");
const { MAX_ROUTE_ANCHORS } = await import("../scripts/route-notes.mjs");
const { noteMatchesQuery, noteSearchLabel, noteFilterKey } = await import("../scripts/app/note-search.mjs");
const { noteCreationPresentation, noteCreationStyle } = await import("../scripts/app/note-dialog.mjs");
registerSocket();

const PASS = "correct horse battery staple";
// Strings only the GM ever wrote. (The player types "Hidden Cult" themselves below, so that
// bare name is legitimately public; the secret note's id and GM-prefixed title are still checked.)
const SECRET_STRINGS = ["betrayed", "is a cultist", "Lord Vex the Elder", "GM label text", "secret link label"];
const settle = () => new Promise(r => setTimeout(r, 60));
const shared = () => containers.shared;
const sharedByName = name => [...shared().pages.values()].find(p => p.name === name);
const fromPlayer = async message => { env.deliver(message, player.id); await settle(); };
const sharedCard = noteId => notesStore.getSharedLayout()?.cards?.[noteId];
const minorAnchors = noteId => Object.entries(sharedCard(noteId)?.anchors ?? {})
  .filter(([, anchor]) => anchor.kind === "minor");
const linkOn = (noteName, linkId) => sharedByName(noteName).system.links.find(link => link.id === linkId);
const rejectionReasonsSince = index => env.socketLog.slice(index)
  .map(entry => entry.message)
  .filter(message => message.type === "writeRejected")
  .map(message => message.reason);

/** Creates a note and pins its card to an exact geometry, so redistribution is deterministic. */
async function createNoteAt(title, x, y) {
  await fromPlayer({ type: "createNote", title, x, y });
  const page = sharedByName(title);
  await requestWrite({ type: "moveCard", noteId: page.id, x, y });
  await requestWrite({ type: "resizeCard", noteId: page.id, width: 200, height: 100 });
  return page;
}

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

test("hidden link edits clear route waypoints before declassification can publish them", async () => {
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
  const edited = vaultStore.data.notes[routedId].links.find(link => link.id === hidden.id);
  assert.deepEqual(edited.routeAnchors, [],
    "vault links never keep shared route anchors that shared pruning cannot see");
  assert.deepEqual([edited.sourceSide, edited.targetSide], ["right", "left"],
    "the point/side fallback survives");

  assert.equal(await secrets.declassifyNote(routedId, "Published Route"), true);
  const page = shared().pages.get(routedId);
  const link = page.system.links.find(item => item.targetId === tavernId);
  assert.deepEqual(link.routeAnchors, [],
    "declassification cannot publish a waypoint the hidden link no longer stores");

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
    fields: { mainSnapRadius: 99, minorSnapRadius: 4, pinStyle: "brass" }
  });
  assert.equal(note.system.attachment.mainPinEnabled, true,
    "the generic attachment path does not touch main-pin visibility");
  assert.equal(note.system.attachment.mainSnapRadius, 64);
  assert.equal(note.system.attachment.minorSnapRadius, 4);
  assert.equal(note.system.attachment.pinStyle, "brass");

  // Visibility changes use the dedicated destructive/undoable operation.
  await fromPlayer({ type: "setMainPinEnabled", noteId: note.id, enabled: false });
  assert.equal(note.system.attachment.mainPinEnabled, false);

  // The generic path cannot bypass redistribution by toggling mainPinEnabled.
  await fromPlayer({
    type: "setNoteAttachment", noteIds: [note.id], fields: { mainPinEnabled: true }
  });
  assert.equal(note.system.attachment.mainPinEnabled, false,
    "setNoteAttachment {mainPinEnabled} is rejected as an unknown field");

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

test("bulk cosmetic batch writes cover every selected note and leave content, labels, images and links alone", async () => {
  await fromPlayer({ type: "createNote", title: "Bulk One", x: 0, y: 400 });
  await fromPlayer({ type: "createNote", title: "Bulk Two", x: 300, y: 400 });
  const one = sharedByName("Bulk One");
  const two = sharedByName("Bulk Two");
  await requestWrite({ type: "setNoteLabel", noteId: one.id, label: "One label" });
  await requestWrite({ type: "setNoteImage", noteId: one.id, image: "assets/stylized/cork.svg" });
  await requestWrite({ type: "createLink", sourceId: one.id, targetId: two.id, sourceSide: "right", targetSide: "left" });
  const snapshot = note => JSON.parse(JSON.stringify({
    label: note.system.label,
    blocks: note.system.blocks,
    image: note.system.image,
    links: note.system.links,
    kind: note.system.kind,
    attachment: note.system.attachment
  }));
  const beforeOne = snapshot(one);
  const beforeTwo = snapshot(two);
  const linkBefore = JSON.stringify(one.system.links);

  await fromPlayer({
    type: "setNotePresentation", noteIds: [one.id, two.id],
    fields: { extendedStyle: "document", font: "serif", pictureLayout: "right", torn: true }
  });
  for (const note of [one, two]) {
    assert.equal(note.system.presentation.extendedStyle, "document");
    assert.equal(note.system.presentation.font, "serif");
    assert.equal(note.system.presentation.pictureLayout, "right");
    assert.equal(note.system.presentation.torn, true);
    assert.equal(note.system.presentation.forceExtended, false, "bulk never forces extended");
  }
  assert.equal(one.system.label, beforeOne.label, "label untouched");
  assert.deepEqual(one.system.blocks, beforeOne.blocks, "content untouched");
  assert.equal(one.system.image, beforeOne.image, "image untouched");
  assert.equal(JSON.stringify(one.system.links), linkBefore, "link topology untouched");
  assert.deepEqual(two.system.blocks, beforeTwo.blocks);

  await fromPlayer({
    type: "setNoteAttachment", noteIds: [one.id, two.id], fields: { pinStyle: "iron" }
  });
  for (const note of [one, two]) {
    assert.equal(note.system.attachment.pinStyle, "iron");
    assert.equal(note.system.attachment.mainPinEnabled, true, "bulk never disables a pin");
    assert.equal(note.system.attachment.mainSnapRadius, 24, "bulk never changes snap radii");
    assert.equal(note.system.attachment.minorSnapRadius, 6);
  }
  assert.equal(two.system.label, beforeTwo.label);
  assert.equal(two.system.image, beforeTwo.image);
  assert.equal(JSON.stringify(one.system.links), linkBefore);
});

test("setNotePresentation rejects forceExtended on any batch, including duplicate ids", async () => {
  const one = sharedByName("Bulk One");
  const two = sharedByName("Bulk Two");
  await fromPlayer({
    type: "setNotePresentation", noteIds: [one.id, two.id],
    fields: { forceExtended: false }
  });
  assert.equal(one.system.presentation.forceExtended, false, "two ids reject the whole batch");
  assert.equal(two.system.presentation.forceExtended, false);

  await fromPlayer({
    type: "setNotePresentation", noteIds: [one.id, one.id],
    fields: { forceExtended: true, font: "serif" }
  });
  assert.equal(one.system.presentation.forceExtended, false,
    "duplicate ids are still a batch and never widen force-context");
  assert.equal(one.system.presentation.font, "serif",
    "the whole patch is rejected, not partially written");

  await fromPlayer({
    type: "setNotePresentation", noteIds: [one.id], fields: { forceExtended: true }
  });
  assert.equal(one.system.presentation.forceExtended, true, "a true single-note request still works");
  await fromPlayer({
    type: "setNotePresentation", noteIds: [one.id], fields: { forceExtended: false }
  });
});

test("presentation force/font/layout roundtrip keeps the internal name separate from the label", async () => {
  const note = sharedByName("Presentation Fixture");
  const originalName = note.name;

  await fromPlayer({ type: "setNoteLabel", noteId: note.id, label: "  Selected label  " });
  await fromPlayer({
    type: "setNotePresentation", noteIds: [note.id],
    fields: {
      extendedStyle: "memo", forceExtended: true, font: "display",
      pictureLayout: "below", torn: true
    }
  });
  assert.equal(note.system.label, "Selected label");
  assert.equal(note.name, originalName, "label edits never rename the Foundry page");
  assert.equal(note.system.presentation.extendedStyle, "memo");
  assert.equal(note.system.presentation.forceExtended, true);
  assert.equal(note.system.presentation.font, "display");
  assert.equal(note.system.presentation.pictureLayout, "below");
  assert.equal(note.system.presentation.torn, true);
});

test("creation presets force extended while a plain note stays automatic", async () => {
  assert.deepEqual(noteCreationPresentation({}), {
    extendedStyle: "memo", forceExtended: false
  });
  assert.deepEqual(noteCreationPresentation({ style: "memo" }), {
    extendedStyle: "memo", forceExtended: true
  });
  assert.deepEqual(noteCreationPresentation({ style: "document" }), {
    extendedStyle: "document", forceExtended: true
  });
  assert.deepEqual(noteCreationPresentation({ style: "wanted" }), {
    extendedStyle: "target", forceExtended: true
  });
  assert.deepEqual(noteCreationPresentation({ kind: "location" }), {
    extendedStyle: "document", forceExtended: true
  });
  assert.deepEqual(noteCreationPresentation({
    style: "memo", presentation: { extendedStyle: "memo", forceExtended: false }
  }), { extendedStyle: "memo", forceExtended: false }, "an explicit automatic preset can override the style default");
  assert.equal(noteCreationStyle({}), "memo");
  assert.equal(noteCreationStyle({ style: "wanted" }), "wanted");
  assert.equal(noteCreationStyle({ kind: "location" }), "document");

  await fromPlayer({ type: "createNote", title: "Automatic Creation", x: 900, y: 0 });
  const automatic = sharedByName("Automatic Creation");
  assert.equal(automatic.system.style, "memo", "the plain new note uses the Memo storage default");
  assert.equal(automatic.system.label, "");
  assert.equal(automatic.system.presentation.extendedStyle, "memo");
  assert.equal(automatic.system.presentation.forceExtended, false);

  await fromPlayer({
    type: "createNote", title: "Labeled Target Creation", style: "wanted",
    label: "Bounty board",
    presentation: { extendedStyle: "target", forceExtended: true }
  });
  const preset = sharedByName("Labeled Target Creation");
  assert.equal(preset.name, "Labeled Target Creation", "the internal name remains the lookup identity");
  assert.equal(preset.system.label, "Bounty board");
  assert.equal(preset.system.style, "wanted");
  assert.equal(preset.system.presentation.extendedStyle, "target");
  assert.equal(preset.system.presentation.forceExtended, true);

  await fromPlayer({
    type: "createNote", title: "Document Creation", style: "document",
    label: "Dossier",
    presentation: {
      extendedStyle: "document", forceExtended: true, font: "serif",
      pictureLayout: "right", torn: true
    }
  });
  const document = sharedByName("Document Creation");
  assert.equal(document.system.presentation.extendedStyle, "document");
  assert.equal(document.system.presentation.forceExtended, true);
  assert.equal(document.system.presentation.font, "serif");
  assert.equal(document.system.presentation.pictureLayout, "right");
  assert.equal(document.system.presentation.torn, true);
});

test("search uses labels and visible text but never internal names or hidden blocks", async () => {
  await fromPlayer({ type: "createNote", title: "Search Fixture", label: "Harbor Label", x: 1050, y: 0 });
  const page = sharedByName("Search Fixture");
  const blockId = page.system.blocks[0].blockId;
  await fromPlayer({ type: "requestLock", noteId: page.id, blockId });
  await fromPlayer({
    type: "saveBlock", noteId: page.id, blockId, text: "A visible lighthouse stands here."
  });
  await fromPlayer({ type: "releaseLock", noteId: page.id, blockId });
  const hiddenId = await secrets.addHiddenBlock(page.id, blockId);
  await secrets.saveSecretBlock(page.id, hiddenId, "The hidden cellar phrase.");

  const merged = notesStore.getNote(page.id);
  assert.equal(noteMatchesQuery(merged, "harbor label"), true, "the optional label is searchable");
  assert.equal(noteMatchesQuery(merged, "visible lighthouse"), true, "visible Markdown text is searchable");
  assert.equal(noteMatchesQuery(merged, "player", player.name), true, "the public author name is searchable");
  assert.equal(noteMatchesQuery(merged, "hidden cellar"), false, "hidden blocks never enter search");
  assert.equal(noteMatchesQuery(merged, "search fixture"), false, "the internal generated name is not searchable");
  assert.equal(noteSearchLabel(merged), "Harbor Label");

  await requestWrite({ type: "setNoteLabel", noteId: page.id, label: "" });
  assert.deepEqual(
    noteSearchLabel(notesStore.getNote(page.id)).startsWith("A visible lighthouse"),
    true,
    "unlabelled results use a deterministic visible excerpt"
  );

  await requestWrite({ type: "createNote", title: "Blank Search Fixture", x: 1150, y: 0 });
  const blank = sharedByName("Blank Search Fixture");
  assert.equal(noteSearchLabel(notesStore.getNote(blank.id)), "Untitled note",
    "a blank note gets a neutral fallback, not its generated internal name");

  const secretId = await secrets.createSecretNote({ title: "Search Secret", x: 1200, y: 0 });
  await secrets.setSecretNoteLabel(secretId, "");
  const secretBlock = vaultStore.data.notes[secretId].blocks[0].blockId;
  await secrets.saveSecretBlock(secretId, secretBlock, "classified search phrase");
  const secretView = notesStore.getNote(secretId);
  assert.equal(noteMatchesQuery(secretView, "classified search phrase"), false,
    "secret block text stays out of search");
  assert.equal(noteMatchesQuery(secretView, "Search Secret"), false,
    "the internal secret title stays out of search");
  assert.equal(noteSearchLabel(secretView), "Untitled note");
  await secrets.deleteSecretNote(secretId);

  // Search sees the resolved heading, but never invisible URLs or HTML comments.
  await fromPlayer({
    type: "createNote", title: "Search Markdown Fixture", label: "Markdown Label", x: 1250, y: 0
  });
  const markdownPage = sharedByName("Search Markdown Fixture");
  const markdownBlock = markdownPage.system.blocks[0].blockId;
  await fromPlayer({ type: "requestLock", noteId: markdownPage.id, blockId: markdownBlock });
  await fromPlayer({
    type: "saveBlock", noteId: markdownPage.id, blockId: markdownBlock,
    text: "See [the harbor](https://hidden.example/secretpath) and [the dock](/worlds/hidden/relative-path) <!-- hidden comment -->"
  });
  await fromPlayer({ type: "releaseLock", noteId: markdownPage.id, blockId: markdownBlock });
  await requestWrite({
    type: "setNotePresentation", noteIds: [markdownPage.id], fields: { heading: "Hidden Heading" }
  });
  const markdownView = notesStore.getNote(markdownPage.id);
  assert.equal(noteMatchesQuery(markdownView, "the harbor"), true, "visible link text is searchable");
  assert.equal(noteMatchesQuery(markdownView, "the dock"), true, "relative link labels stay searchable");
  assert.equal(noteMatchesQuery(markdownView, "hidden heading"), true, "the resolved heading is searchable");
  assert.equal(noteMatchesQuery(markdownView, "secretpath"), false, "raw link URLs never match");
  assert.equal(noteMatchesQuery(markdownView, "relative-path"), false, "relative link destinations never match");
  assert.equal(noteMatchesQuery(markdownView, "hidden comment"), false, "HTML comments never match");
  await requestWrite({ type: "setNoteLabel", noteId: markdownPage.id, label: "" });
  assert.equal(noteSearchLabel(notesStore.getNote(markdownPage.id)), "Hidden Heading",
    "the excerpt fallback uses the resolved heading before visible text");

  assert.equal(noteFilterKey(sharedByName("New Location")), "location");
  assert.equal(noteFilterKey(sharedByName("Labeled Target Creation")), "target");
  assert.equal(noteFilterKey(sharedByName("Automatic Creation")), "memo");
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

test("declassification preserves label, presentation, attachment and link ids but clears legacy anchors", async () => {
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
  assert.deepEqual(link.routeAnchors, [],
    "legacy route waypoints are not published with a declassified link");
  assert.equal(link.sourceAnchorId, "", "legacy source anchor ids are not published");
  assert.equal(link.targetAnchorId, "");
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

test("minor anchors are added, moved and removed with bounds and reference checks", async () => {
  const note = await createNoteAt("Pin CRUD", 1400, 100);
  const target = await createNoteAt("Pin CRUD Target", 1700, 100);

  await fromPlayer({ type: "addCardAnchor", noteId: note.id, kind: "minor", x: 0.25, y: 0.75 });
  const [anchorId, anchor] = minorAnchors(note.id)[0];
  assert.equal(anchor.kind, "minor");
  assert.equal(anchor.createdBy, player.id, "the sender is recorded, never a client-supplied author");

  const count = () => minorAnchors(note.id).length;
  await fromPlayer({ type: "addCardAnchor", noteId: note.id, kind: "minor", x: 1.2, y: 0.2 });
  await fromPlayer({ type: "addCardAnchor", noteId: note.id, kind: "main", x: 0.2, y: 0.2 });
  await fromPlayer({ type: "addCardAnchor", noteId: note.id, kind: "minor", x: 0.2, y: Number.NaN });
  await fromPlayer({ type: "addCardAnchor", noteId: "MissingAnchor001", kind: "minor", x: 0.2, y: 0.2 });
  assert.equal(count(), 1, "invalid or missing targets add nothing");

  await fromPlayer({ type: "moveCardAnchor", noteId: note.id, anchorId, x: 0.4, y: 0.6 });
  let current = sharedCard(note.id).anchors[anchorId];
  assert.deepEqual([current.x, current.y, current.kind, current.createdBy],
    [0.4, 0.6, "minor", player.id]);
  await fromPlayer({ type: "moveCardAnchor", noteId: note.id, anchorId: "main", x: 0.1, y: 0.1 });
  await fromPlayer({ type: "moveCardAnchor", noteId: note.id, anchorId, x: -0.1, y: 0.5 });
  await fromPlayer({ type: "moveCardAnchor", noteId: note.id, anchorId: "missing", x: 0.5, y: 0.5 });
  current = sharedCard(note.id).anchors[anchorId];
  assert.deepEqual([current.x, current.y], [0.4, 0.6], "main and invalid moves are rejected");

  await fromPlayer({
    type: "createLink", sourceId: note.id, targetId: target.id,
    sourceAnchorId: anchorId, targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Pin CRUD").system.links.find(item => item.targetId === target.id);
  assert.ok(link);
  await fromPlayer({ type: "removeCardAnchor", noteId: note.id, anchorId });
  assert.ok(sharedCard(note.id).anchors[anchorId], "a referenced minor anchor is not removed");

  await fromPlayer({ type: "deleteLink", noteId: note.id, linkId: link.id });
  assert.equal(sharedCard(note.id).anchors[anchorId], undefined,
    "the last reference removal prunes the minor anchor");

  await fromPlayer({ type: "addCardAnchor", noteId: note.id, kind: "minor", x: 0.6, y: 0.2 });
  const orphanId = minorAnchors(note.id)[0][0];
  await fromPlayer({ type: "removeCardAnchor", noteId: note.id, anchorId: orphanId });
  assert.equal(count(), 0, "an unreferenced minor anchor can be removed directly");
  assert.ok(sharedCard(note.id).anchors.main, "the main anchor is never removed");
});

test("a shared card is capped at 256 anchors", async () => {
  const note = await createNoteAt("Pin Anchor Cap", 1600, 200);
  const layout = shared().pages.get(containers.ids.layoutPage);
  const bulk = {};
  for (let i = 0; i < 255; i++) {
    bulk[`system.cards.${note.id}.anchors.a${i}`] = {
      kind: "minor", x: 0.5, y: 0.5, createdBy: player.id
    };
  }
  await layout.update(bulk);
  assert.equal(Object.keys(sharedCard(note.id).anchors).length, 256);

  await fromPlayer({ type: "addCardAnchor", noteId: note.id, kind: "minor", x: 0.1, y: 0.1 });
  assert.equal(Object.keys(sharedCard(note.id).anchors).length, 256, "the cap is enforced");
  assert.ok(sharedCard(note.id).anchors.main, "the generated main anchor counts toward the cap");
});

test("createLink stores validated new anchors on both cards and reuses existing ones", async () => {
  const a = await createNoteAt("Pin Link A", 1400, 300);
  const b = await createNoteAt("Pin Link B", 1700, 300);
  const c = await createNoteAt("Pin Link C", 2000, 300);

  // A bad second endpoint rejects the whole request before either card is touched.
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourceAnchor: { kind: "minor", x: 0.2, y: 0.3 },
    targetAnchor: { kind: "minor", x: 2, y: 0.5 }
  });
  assert.equal(sharedByName("Pin Link A").system.links.length, 0);
  assert.equal(minorAnchors(a.id).length, 0);
  assert.equal(minorAnchors(b.id).length, 0);

  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourceAnchor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "spoofed" },
    targetAnchor: { kind: "minor", x: 0.8, y: 0.7 }
  });
  const first = sharedByName("Pin Link A").system.links.find(link => link.targetId === b.id);
  assert.ok(first.sourceAnchorId && first.sourceAnchorId !== "main");
  assert.ok(first.targetAnchorId && first.targetAnchorId !== "main");
  assert.equal(sharedCard(a.id).anchors[first.sourceAnchorId].createdBy, player.id);
  assert.equal(sharedCard(b.id).anchors[first.targetAnchorId].createdBy, player.id);
  assert.deepEqual(first.sourcePoint, { x: 0.2, y: 0.3 });
  assert.deepEqual(first.targetPoint, { x: 0.8, y: 0.7 });
  assert.ok(["top", "right", "bottom", "left"].includes(first.sourceSide));
  assert.ok(["top", "right", "bottom", "left"].includes(first.targetSide));

  // Updating cosmetics keeps the generated anchor ids stable.
  await fromPlayer({
    type: "updateLink", noteId: a.id, linkId: first.id, fields: { label: "steady anchor" }
  });
  const updated = sharedByName("Pin Link A").system.links.find(link => link.id === first.id);
  assert.equal(updated.sourceAnchorId, first.sourceAnchorId);
  assert.equal(updated.targetAnchorId, first.targetAnchorId);

  // Another link may share the same target anchor; no new anchor is generated on b.
  const bAnchorCount = Object.keys(sharedCard(b.id).anchors).length;
  await fromPlayer({
    type: "createLink", sourceId: c.id, targetId: b.id,
    sourcePoint: { x: 0.5, y: 0.5 }, targetAnchorId: first.targetAnchorId
  });
  const cLink = sharedByName("Pin Link C").system.links.find(link => link.targetId === b.id);
  assert.equal(cLink.targetAnchorId, first.targetAnchorId);
  assert.equal(Object.keys(sharedCard(b.id).anchors).length, bAnchorCount,
    "reusing an existing anchor does not duplicate it");

  // Existing source anchors are accepted by id as well.
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: c.id,
    sourceAnchorId: first.sourceAnchorId, targetPoint: { x: 0, y: 0.5 }
  });
  const second = sharedByName("Pin Link A").system.links.find(link => link.targetId === c.id);
  assert.equal(second.sourceAnchorId, first.sourceAnchorId);
});

test("updateLink accepts only existing anchors on the correct cards", async () => {
  const a = await createNoteAt("Pin Update A", 1400, 400);
  const b = await createNoteAt("Pin Update B", 1700, 400);
  await fromPlayer({ type: "addCardAnchor", noteId: a.id, kind: "minor", x: 0.1, y: 0.2 });
  await fromPlayer({ type: "addCardAnchor", noteId: b.id, kind: "minor", x: 0.9, y: 0.8 });
  const aAnchor = minorAnchors(a.id)[0][0];
  const bAnchor = minorAnchors(b.id)[0][0];

  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 0, y: 0.5 }, targetPoint: { x: 1, y: 0.5 }
  });
  const link = sharedByName("Pin Update A").system.links.find(item => item.targetId === b.id);
  const sourceIdOf = () => sharedByName("Pin Update A").system.links
    .find(item => item.id === link.id).sourceAnchorId ?? "";

  await fromPlayer({
    type: "updateLink", noteId: a.id, linkId: link.id,
    fields: { label: "must not apply", sourceAnchorId: bAnchor }
  });
  assert.equal(sourceIdOf(), "", "a source anchor from the target card is rejected");
  assert.equal(sharedByName("Pin Update A").system.links.find(item => item.id === link.id).label, "",
    "the invalid patch never partially applies");

  await fromPlayer({
    type: "updateLink", noteId: a.id, linkId: link.id,
    fields: { sourceAnchorId: "MissingAnchor01" }
  });
  assert.equal(sourceIdOf(), "", "a missing anchor id is rejected");

  await fromPlayer({
    type: "updateLink", noteId: a.id, linkId: link.id,
    fields: { sourceAnchorId: aAnchor, targetAnchorId: bAnchor }
  });
  const anchored = sharedByName("Pin Update A").system.links.find(item => item.id === link.id);
  assert.equal(anchored.sourceAnchorId, aAnchor);
  assert.equal(anchored.targetAnchorId, bAnchor);

  await fromPlayer({
    type: "updateLink", noteId: a.id, linkId: link.id, fields: { sourceAnchorId: "" }
  });
  const cleared = sharedByName("Pin Update A").system.links.find(item => item.id === link.id);
  assert.equal(cleared.sourceAnchorId, "");
  assert.equal(sharedCard(a.id).anchors[aAnchor], undefined, "the orphaned minor is pruned");
  assert.ok(sharedCard(b.id).anchors[bAnchor], "the still-referenced target anchor survives");
});

test("minor anchors survive while any live link or route references them", async () => {
  const a = await createNoteAt("Pin Prune A", 1400, 600);
  const b = await createNoteAt("Pin Prune B", 1700, 600);
  const c = await createNoteAt("Pin Prune C", 2000, 600);
  await fromPlayer({ type: "addCardAnchor", noteId: a.id, kind: "minor", x: 0.1, y: 0.1 });
  await fromPlayer({ type: "addCardAnchor", noteId: a.id, kind: "minor", x: 0.9, y: 0.9 });
  await fromPlayer({ type: "addCardAnchor", noteId: b.id, kind: "minor", x: 0.5, y: 0.5 });
  const [a1, a2] = minorAnchors(a.id).map(([id]) => id);
  const [b1] = minorAnchors(b.id).map(([id]) => id);

  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourceAnchorId: a1, targetAnchorId: b1
  });
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: c.id,
    sourceAnchorId: a1, targetPoint: { x: 0, y: 0.5 }
  });
  const ab = sharedByName("Pin Prune A").system.links.find(link => link.targetId === b.id);
  const ac = sharedByName("Pin Prune A").system.links.find(link => link.targetId === c.id);

  await fromPlayer({
    type: "updateLink", noteId: a.id, linkId: ab.id,
    fields: { label: "prune now", sourceAnchorId: a1 }
  });
  assert.equal(sharedCard(a.id).anchors[a2], undefined, "an unreferenced minor is pruned");
  assert.ok(sharedCard(a.id).anchors[a1], "an anchor shared by two links survives");
  assert.ok(sharedCard(b.id).anchors[b1]);
  assert.ok(sharedCard(a.id).anchors.main, "main is never pruned");

  await fromPlayer({ type: "deleteLink", noteId: a.id, linkId: ab.id });
  assert.equal(sharedCard(b.id).anchors[b1], undefined, "the last reference to b1 was removed");
  assert.ok(sharedCard(a.id).anchors[a1], "a1 is still referenced by a-c");

  await fromPlayer({ type: "deleteLink", noteId: a.id, linkId: ac.id });
  assert.equal(sharedCard(a.id).anchors[a1], undefined, "a1 loses its last reference");
  assert.ok(sharedCard(a.id).anchors.main);
});

test("disabling the main pin redistributes every live reference and undo restores it exactly", async () => {
  const hub = await createNoteAt("Pin Toggle Hub", 3000, 500);
  const inbound = await createNoteAt("Pin Toggle Inbound", 2700, 500);
  const outbound = await createNoteAt("Pin Toggle Outbound", 3300, 500);
  const routeSource = await createNoteAt("Pin Toggle Route Source", 3000, 800);
  const routeTarget = await createNoteAt("Pin Toggle Route Target", 3000, 1000);

  await fromPlayer({ type: "addCardAnchor", noteId: hub.id, kind: "minor", x: 0, y: 0.5 });
  const [reuseId] = minorAnchors(hub.id).map(([id]) => id);

  await fromPlayer({
    type: "createLink", sourceId: inbound.id, targetId: hub.id,
    sourcePoint: { x: 1, y: 0.5 }, targetAnchorId: "main"
  });
  await fromPlayer({
    type: "createLink", sourceId: hub.id, targetId: outbound.id,
    sourceAnchorId: "main", targetPoint: { x: 0, y: 0.5 }
  });
  await requestWrite({
    type: "gmAddLink", sourceId: routeSource.id,
    link: { targetId: routeTarget.id, routeAnchors: [{ noteId: hub.id, anchorId: "main" }] }
  });

  const before = {
    hubLinks: structuredClone(sharedByName("Pin Toggle Hub").system.links),
    inboundLinks: structuredClone(sharedByName("Pin Toggle Inbound").system.links),
    routeLinks: structuredClone(sharedByName("Pin Toggle Route Source").system.links),
    hubAnchors: structuredClone(sharedCard(hub.id).anchors)
  };
  const inboundLinkId = before.inboundLinks[0].id;
  const outboundLinkId = before.hubLinks[0].id;
  const routeLinkId = before.routeLinks[0].id;
  const undoId = "PinUndoToggle001";

  await fromPlayer({ type: "setMainPinEnabled", noteId: hub.id, enabled: false, undoId });
  assert.equal(sharedByName("Pin Toggle Hub").system.attachment.mainPinEnabled, false);
  assert.equal(sharedByName("Pin Toggle Inbound").system.links.length, 1, "inbound link survives");
  assert.equal(sharedByName("Pin Toggle Hub").system.links.length, 1, "outbound link survives");
  assert.equal(sharedByName("Pin Toggle Route Source").system.links.length, 1, "route link survives");
  assert.equal(sharedByName("Pin Toggle Inbound").system.links[0].id, inboundLinkId);
  assert.equal(sharedByName("Pin Toggle Hub").system.links[0].id, outboundLinkId);
  assert.equal(sharedByName("Pin Toggle Route Source").system.links[0].id, routeLinkId);

  const inboundLink = sharedByName("Pin Toggle Inbound").system.links[0];
  assert.equal(inboundLink.targetAnchorId, reuseId, "the nearby minor anchor is reused");
  assert.deepEqual(inboundLink.targetPoint, { x: 0, y: 0.5 });
  assert.equal(inboundLink.targetSide, "left");

  const outboundLink = sharedByName("Pin Toggle Hub").system.links[0];
  assert.notEqual(outboundLink.sourceAnchorId, "main");
  assert.ok(sharedCard(hub.id).anchors[outboundLink.sourceAnchorId],
    "a projected replacement minor was created");
  assert.deepEqual(outboundLink.sourcePoint, { x: 1, y: 0.5 });
  assert.equal(outboundLink.sourceSide, "right");

  assert.deepEqual(sharedByName("Pin Toggle Route Source").system.links[0].routeAnchors, [],
    "only the pin-off route waypoint is dropped");
  assert.ok(sharedCard(hub.id).anchors.main, "the main anchor itself is retained for re-enable");

  await requestWrite({ type: "undoPinChange", undoId });
  assert.deepEqual(sharedByName("Pin Toggle Hub").system.links, before.hubLinks);
  assert.deepEqual(sharedByName("Pin Toggle Inbound").system.links, before.inboundLinks);
  assert.deepEqual(sharedByName("Pin Toggle Route Source").system.links, before.routeLinks);
  assert.deepEqual(sharedCard(hub.id).anchors, before.hubAnchors);
  assert.equal(sharedByName("Pin Toggle Hub").system.attachment.mainPinEnabled, true);

  // Re-enabling outside undo restores the pin only; redistributed links stay put.
  await fromPlayer({ type: "setMainPinEnabled", noteId: hub.id, enabled: false, undoId: "PinUndoToggle002" });
  const redistributed = {
    hubLinks: structuredClone(sharedByName("Pin Toggle Hub").system.links),
    inboundLinks: structuredClone(sharedByName("Pin Toggle Inbound").system.links)
  };
  await fromPlayer({ type: "setMainPinEnabled", noteId: hub.id, enabled: true });
  assert.equal(sharedByName("Pin Toggle Hub").system.attachment.mainPinEnabled, true);
  assert.ok(sharedCard(hub.id).anchors.main, "re-enabling ensures the canonical main anchor");
  assert.deepEqual(sharedByName("Pin Toggle Hub").system.links, redistributed.hubLinks,
    "re-enable does not reattach links");
  assert.deepEqual(sharedByName("Pin Toggle Inbound").system.links, redistributed.inboundLinks);
});

test("a failed pin redistribution write rolls the captured state back", async () => {
  const hub = await createNoteAt("Pin Rollback Hub", 3000, 600);
  const inbound = await createNoteAt("Pin Rollback Inbound", 2700, 600);
  await fromPlayer({
    type: "createLink", sourceId: inbound.id, targetId: hub.id,
    sourcePoint: { x: 1, y: 0.5 }, targetAnchorId: "main"
  });

  const before = {
    hubLinks: structuredClone(sharedByName("Pin Rollback Hub").system.links),
    inboundLinks: structuredClone(sharedByName("Pin Rollback Inbound").system.links),
    hubAnchors: structuredClone(sharedCard(hub.id).anchors)
  };

  const originalUpdate = hub.update.bind(hub);
  let calls = 0;
  hub.update = async function update(changes) {
    calls += 1;
    if (calls === 1) throw new Error("injected pin write failure");
    return originalUpdate(changes);
  };
  try {
    await fromPlayer({
      type: "setMainPinEnabled", noteId: hub.id, enabled: false, undoId: "PinUndoFail0001"
    });
  } finally {
    hub.update = originalUpdate;
  }

  assert.deepEqual(sharedByName("Pin Rollback Inbound").system.links, before.inboundLinks,
    "the already-written inbound page was restored");
  assert.deepEqual(sharedByName("Pin Rollback Hub").system.links, before.hubLinks);
  assert.deepEqual(sharedCard(hub.id).anchors, before.hubAnchors);
  assert.equal(sharedByName("Pin Rollback Hub").system.attachment.mainPinEnabled, true);

  // No undo entry was recorded for a failed operation.
  await requestWrite({ type: "undoPinChange", undoId: "PinUndoFail0001" });
  assert.deepEqual(sharedByName("Pin Rollback Inbound").system.links, before.inboundLinks);
});

test("pinsEnabled off blocks new anchors while preserving existing ones", async () => {
  const note = await createNoteAt("Pin Setting Off", 3600, 600);
  const target = await createNoteAt("Pin Setting Off Target", 3900, 600);
  await fromPlayer({ type: "addCardAnchor", noteId: note.id, kind: "minor", x: 0.3, y: 0.4 });
  const [anchorId] = minorAnchors(note.id).map(([id]) => id);
  const beforeAnchors = structuredClone(sharedCard(note.id).anchors);

  await game.settings.set("fvtt-journalinator", "pinsEnabled", false);
  try {
    await fromPlayer({ type: "addCardAnchor", noteId: note.id, kind: "minor", x: 0.1, y: 0.1 });
    assert.deepEqual(sharedCard(note.id).anchors, beforeAnchors, "no new anchor is added");

    await fromPlayer({
      type: "createLink", sourceId: note.id, targetId: target.id,
      sourceAnchor: { kind: "minor", x: 0.5, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
    });
    assert.equal(sharedByName("Pin Setting Off").system.links.length, 0,
      "a new anchor spec is rejected while pins are off");
    assert.deepEqual(sharedCard(note.id).anchors, beforeAnchors);

    await fromPlayer({
      type: "createLink", sourceId: note.id, targetId: target.id,
      sourceAnchorId: anchorId, targetPoint: { x: 0, y: 0.5 }
    });
    const link = sharedByName("Pin Setting Off").system.links.find(item => item.targetId === target.id);
    assert.equal(link.sourceAnchorId, anchorId, "existing anchors remain reusable data");
    assert.deepEqual(sharedCard(note.id).anchors, beforeAnchors, "existing render data is preserved");
  } finally {
    await game.settings.set("fvtt-journalinator", "pinsEnabled", true);
  }
});

test("hidden links never store shared anchor or route references", async () => {
  const target = await createNoteAt("Hidden Anchor Target", 3600, 800);
  await secrets.addHiddenLink(tavernId, target.id, {
    sourceAnchorId: "main",
    targetAnchorId: "main",
    routeAnchors: [{ noteId: tavernId, anchorId: "main" }],
    sourceSide: "right",
    targetSide: "left",
    sourcePoint: { x: 1, y: 0.5 },
    targetPoint: { x: 0, y: 0.5 }
  });
  const hidden = vaultStore.data.hiddenLinks[tavernId].find(link => link.targetId === target.id);
  assert.equal(hidden.sourceAnchorId, "");
  assert.equal(hidden.targetAnchorId, "");
  assert.deepEqual(hidden.routeAnchors, []);
  assert.deepEqual([hidden.sourceSide, hidden.targetSide], ["right", "left"],
    "point/side fallback is preserved");

  await secrets.updateHiddenLink(tavernId, hidden.id, {
    label: "hidden anchor edit",
    sourceAnchorId: "main",
    targetAnchorId: "main",
    routeAnchors: [{ noteId: tavernId, anchorId: "main" }]
  });
  const updated = vaultStore.data.hiddenLinks[tavernId].find(link => link.id === hidden.id);
  assert.equal(updated.label, "hidden anchor edit");
  assert.equal(updated.sourceAnchorId, "");
  assert.equal(updated.targetAnchorId, "");
  assert.deepEqual(updated.routeAnchors, []);
  assert.deepEqual([updated.sourceSide, updated.targetSide], ["right", "left"]);

  // Hiding a shared link is the other storage path, and must clear anchors too.
  const secondTarget = await createNoteAt("Hidden Anchor Target 2", 3600, 1000);
  await requestWrite({
    type: "createLink", sourceId: tavernId, targetId: secondTarget.id,
    sourceAnchorId: "main", sourcePoint: { x: 0.5, y: 0 }, targetPoint: { x: 0, y: 0.5 }
  });
  const sharedLink = sharedByName("Tavern").system.links.find(link => link.targetId === secondTarget.id);
  assert.equal(sharedLink.sourceAnchorId, "main");
  assert.equal(await secrets.hideSharedLink(tavernId, sharedLink.id), true);
  const hiddenShared = vaultStore.data.hiddenLinks[tavernId]
    .find(link => link.targetId === secondTarget.id);
  assert.equal(hiddenShared.sourceAnchorId, "");
  assert.equal(hiddenShared.targetAnchorId, "");
  assert.deepEqual(hiddenShared.routeAnchors, []);
  assert.equal(hiddenShared.sourceSide, "top", "the point/side fallback is preserved");
});

test("hostile anchor ids never reach dotted updates; pasted/declassified/restored mains are trusted", async () => {
  const note = await createNoteAt("Anchor Hostile", 4200, 1600);
  const layout = shared().pages.get(containers.ids.layoutPage);
  const hostileAnchors = JSON.parse(`{
    "main": {"kind":"main","x":0.1,"y":0.1,"createdBy":"spoof"},
    "constructor": {"kind":"minor","x":0.2,"y":0.2,"createdBy":"spoof"},
    "__proto__": {"kind":"minor","x":0.3,"y":0.3,"createdBy":"spoof"},
    "a.b": {"kind":"minor","x":0.4,"y":0.4,"createdBy":"spoof"},
    "safe": {"kind":"minor","x":0.5,"y":0.5,"createdBy":"u"}
  }`);
  await layout.update({ [`system.cards.${note.id}.anchors`]: hostileAnchors });
  const before = JSON.stringify(sharedCard(note.id).anchors);
  for (const anchorId of ["constructor", "__proto__", "a.b"]) {
    await fromPlayer({ type: "moveCardAnchor", noteId: note.id, anchorId, x: 0.9, y: 0.9 });
    await fromPlayer({ type: "removeCardAnchor", noteId: note.id, anchorId });
  }
  assert.equal(JSON.stringify(sharedCard(note.id).anchors), before,
    "invalid/prototype/path ids are rejected before any whole-registry write");

  await fromPlayer({
    type: "pasteNote", title: "Pasted Anchor Spoof", autoTitle: false,
    blocks: ["body"],
    card: {
      anchors: {
        legacyMain: { kind: "main", x: 0.1, y: 0.1, createdBy: "spoof" },
        secondMain: { kind: "main", x: 0.9, y: 0.9, createdBy: "spoof" },
        copied: { kind: "minor", x: 0.2, y: 0.3, createdBy: "original-minor-author" },
        constructor: { kind: "minor", x: 0.4, y: 0.4 }
      }
    }
  });
  const pasted = sharedByName("Pasted Anchor Spoof");
  const pastedAnchors = sharedCard(pasted.id).anchors;
  assert.deepEqual(pastedAnchors.main, {
    kind: "main", x: 0.5, y: 0, createdBy: player.id
  }, "a pasted non-canonical main folds to main and takes the sender as creator");
  assert.equal(pastedAnchors.legacyMain, undefined);
  assert.equal(pastedAnchors.secondMain, undefined);
  assert.equal(Object.hasOwn(pastedAnchors, "constructor"), false);
  assert.equal(pastedAnchors.copied.createdBy, "original-minor-author",
    "copied minor anchors may keep their original creator");

  await requestWrite({
    type: "gmCreateNote",
    noteId: "DeclassSpoof0001",
    title: "Declassified Anchor Spoof",
    blocks: [{ blockId: "BlockSpoof000001", text: "public" }],
    card: {
      x: 4000, y: 1700,
      anchors: {
        main: { kind: "main", x: 0.2, y: 0.8, createdBy: "spoof" },
        copied: { kind: "minor", x: 0.2, y: 0.3, createdBy: "original" }
      }
    }
  });
  assert.deepEqual(sharedCard("DeclassSpoof0001").anchors.main, {
    kind: "main", x: 0.5, y: 0, createdBy: gmUser.id
  }, "declassification stamps the main creator from the GM sender");

  const restored = await createNoteAt("Restore Anchor Spoof", 4200, 1800);
  await layout.update({
    [`system.cards.${restored.id}.anchors`]: {
      main: { kind: "main", x: 0.3, y: 0.7, createdBy: "spoof" },
      copied: { kind: "minor", x: 0.1, y: 0.2, createdBy: "original" }
    }
  });
  await requestWrite({ type: "deleteNote", noteId: restored.id });
  await requestWrite({ type: "restoreNote", noteId: restored.id });
  assert.deepEqual(sharedCard(restored.id).anchors.main, {
    kind: "main", x: 0.5, y: 0, createdBy: player.id
  }, "restore stamps the main creator from the note author, not stored spoof data");
});

test("pruning counts references from trashed note pages, so restore reconnects", async () => {
  const owner = await createNoteAt("Trash Ref Owner", 4500, 1600);
  const trashed = await createNoteAt("Trash Ref Source", 4500, 1800);
  const unrelated = await createNoteAt("Trash Ref Noise A", 4500, 2000);
  const unrelatedTarget = await createNoteAt("Trash Ref Noise B", 4700, 2000);
  await fromPlayer({ type: "addCardAnchor", noteId: owner.id, kind: "minor", x: 0.77, y: 0.22 });
  const [anchorId] = minorAnchors(owner.id).map(([id]) => id);
  await fromPlayer({
    type: "createLink", sourceId: trashed.id, targetId: owner.id,
    sourcePoint: { x: 0, y: 0.5 }, targetAnchorId: anchorId
  });
  await fromPlayer({
    type: "createLink", sourceId: unrelated.id, targetId: unrelatedTarget.id,
    sourcePoint: { x: 0, y: 0.5 }, targetPoint: { x: 1, y: 0.5 }
  });
  const noise = sharedByName("Trash Ref Noise A").system.links[0];

  await requestWrite({ type: "deleteNote", noteId: trashed.id });
  assert.ok(shared().pages.get(trashed.id).system.deleted, "the link's owner is soft-deleted");

  await fromPlayer({ type: "deleteLink", noteId: unrelated.id, linkId: noise.id });
  assert.ok(sharedCard(owner.id).anchors[anchorId],
    "a prune triggered elsewhere keeps an anchor referenced only by a trashed note");

  await fromPlayer({ type: "removeCardAnchor", noteId: owner.id, anchorId });
  assert.ok(sharedCard(owner.id).anchors[anchorId],
    "direct removal also respects a trashed note's returning reference");

  await requestWrite({ type: "restoreNote", noteId: trashed.id });
  const restoredLink = sharedByName("Trash Ref Source").system.links[0];
  assert.equal(restoredLink.targetAnchorId, anchorId, "the restored link still resolves");
  assert.ok(sharedCard(owner.id).anchors[anchorId]);
});

test("updateLink refreshes the endpoint point/side fallback when anchors change", async () => {
  const a = await createNoteAt("Fallback Link A", 4500, 2300);
  const b = await createNoteAt("Fallback Link B", 4800, 2300);
  await fromPlayer({ type: "addCardAnchor", noteId: a.id, kind: "minor", x: 0.8, y: 0.1 });
  await fromPlayer({ type: "addCardAnchor", noteId: b.id, kind: "minor", x: 0.2, y: 0.9 });
  const [aAnchor] = minorAnchors(a.id).map(([id]) => id);
  const [bAnchor] = minorAnchors(b.id).map(([id]) => id);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 0, y: 0.5 }, sourceSide: "left",
    targetPoint: { x: 1, y: 0.5 }, targetSide: "right"
  });
  const link = sharedByName("Fallback Link A").system.links[0];

  await fromPlayer({
    type: "updateLink", noteId: a.id, linkId: link.id,
    fields: { sourceAnchorId: aAnchor, targetAnchorId: bAnchor }
  });
  let updated = sharedByName("Fallback Link A").system.links[0];
  assert.deepEqual(updated.sourcePoint, { x: 0.8, y: 0.1 });
  assert.equal(updated.sourceSide, "top", "source side follows the new anchor");
  assert.deepEqual(updated.targetPoint, { x: 0.2, y: 0.9 });
  assert.equal(updated.targetSide, "bottom", "target side follows the new anchor");

  await fromPlayer({
    type: "updateLink", noteId: a.id, linkId: link.id, fields: { sourceAnchorId: "" }
  });
  updated = sharedByName("Fallback Link A").system.links[0];
  assert.equal(updated.sourceAnchorId, "");
  assert.deepEqual(updated.sourcePoint, { x: 0.8, y: 0.1 },
    "clearing an anchor keeps the last released point as the hidden/legacy fallback");
  assert.equal(updated.sourceSide, "top");
});

test("main-pin redistribution uses the clamped measured box and compact/extended fallbacks", async () => {
  // Stored card is 200x100, but the client reports a narrow/tall measured box. The same target
  // projects to the bottom edge with the stored box and to the right edge with the reported one.
  const hub = await createNoteAt("Pin Box Hub", 5000, 1000);
  const target = await createNoteAt("Pin Box Target", 5050, 1150);
  await fromPlayer({
    type: "createLink", sourceId: hub.id, targetId: target.id,
    sourceAnchorId: "main", targetPoint: { x: 0, y: 0.5 }
  });
  await fromPlayer({
    type: "setMainPinEnabled", noteId: hub.id, enabled: false, undoId: "PinBoxUndo0001",
    box: { w: 40, h: 1000, x: -999999, rotation: 45 }
  });
  const outbound = sharedByName("Pin Box Hub").system.links[0];
  assert.equal(outbound.sourceSide, "right",
    "client w/h drive projection while x/rotation are ignored");
  assert.equal(outbound.sourcePoint.x, 1);
  assert.ok(sharedCard(hub.id).anchors[outbound.sourceAnchorId]);

  // No stored width/height: compact and extended cards still get a usable fallback box.
  await fromPlayer({ type: "createNote", title: "Pin Box Compact", x: 5200, y: 1000 });
  const compact = sharedByName("Pin Box Compact");
  await fromPlayer({ type: "createNote", title: "Pin Box Extended", x: 5200, y: 1200 });
  const extended = sharedByName("Pin Box Extended");
  await requestWrite({
    type: "setNotePresentation", noteIds: [extended.id], fields: { forceExtended: true }
  });
  for (const [source, label] of [[compact, "compact"], [extended, "extended"]]) {
    const targetNote = await createNoteAt(`Pin Box ${label} Target`, 5400, source === compact ? 1000 : 1200);
    await fromPlayer({
      type: "createLink", sourceId: source.id, targetId: targetNote.id,
      sourceAnchorId: "main", targetPoint: { x: 0, y: 0.5 }
    });
    await fromPlayer({
      type: "setMainPinEnabled", noteId: source.id, enabled: false,
      undoId: `PinBox${label}Undo`.slice(0, 100)
    });
    const link = sharedByName(source.name).system.links[0];
    assert.notEqual(link.sourceAnchorId, "main", `${label} redistribution creates a minor`);
    assert.ok(sharedCard(source.id).anchors[link.sourceAnchorId]);
    assert.ok(["top", "right", "bottom", "left"].includes(link.sourceSide));
  }
});

test("stale pin undo refuses to clobber later edits or a re-enabled main pin", async () => {
  const hub = await createNoteAt("Pin Stale Hub", 5600, 1000);
  const inbound = await createNoteAt("Pin Stale Inbound", 5400, 1000);
  await fromPlayer({
    type: "createLink", sourceId: inbound.id, targetId: hub.id,
    sourcePoint: { x: 1, y: 0.5 }, targetAnchorId: "main"
  });

  // A label edit is outside the undo's write set, so it survives while links are restored.
  await fromPlayer({ type: "setMainPinEnabled", noteId: hub.id, enabled: false, undoId: "PinStaleLabel01" });
  await fromPlayer({ type: "setNoteLabel", noteId: hub.id, label: "Edited after pin-off" });
  await requestWrite({ type: "undoPinChange", undoId: "PinStaleLabel01" });
  assert.equal(sharedByName("Pin Stale Hub").system.label, "Edited after pin-off");
  assert.equal(sharedByName("Pin Stale Hub").system.attachment.mainPinEnabled, true);

  // Disable, then re-enable: the old undo entry is stale and must not reattach the main pin.
  await fromPlayer({ type: "setMainPinEnabled", noteId: hub.id, enabled: false, undoId: "PinStaleEnable01" });
  const redistributed = structuredClone(sharedByName("Pin Stale Inbound").system.links);
  await fromPlayer({ type: "setMainPinEnabled", noteId: hub.id, enabled: true });
  env.notifications.length = 0;
  await requestWrite({ type: "undoPinChange", undoId: "PinStaleEnable01" });
  assert.equal(sharedByName("Pin Stale Hub").system.attachment.mainPinEnabled, true,
    "a stale undo does not switch the main pin off again");
  assert.deepEqual(sharedByName("Pin Stale Inbound").system.links, redistributed,
    "a stale undo does not reattach the old main endpoint");
  assert.ok(env.notifications.some(([, message]) => message.includes("can no longer be undone")),
    "the requester is told why the undo was refused");

  // A later link edit makes an otherwise current undo stale as well.
  const link = sharedByName("Pin Stale Inbound").system.links[0];
  await fromPlayer({
    type: "updateLink", noteId: inbound.id, linkId: link.id, fields: { label: "newer edit" }
  });
  await requestWrite({ type: "undoPinChange", undoId: "PinStaleEnable01" });
  assert.equal(sharedByName("Pin Stale Inbound").system.links[0].label, "newer edit");
});

test("pin undo restores a partial raw attachment exactly", async () => {
  const hub = await createNoteAt("Pin Raw Attachment", 5800, 1000);
  const raw = { mainSnapRadius: 12, customFutureField: { keep: true } };
  await requestWrite({
    type: "setNoteAttachment", noteIds: [hub.id], fields: { pinStyle: "wax" }
  });
  const page = sharedByName("Pin Raw Attachment");
  await page.update({ "system.attachment": structuredClone(raw) });
  assert.equal(page.system.attachment.mainPinEnabled, undefined, "raw fixture has no resolved defaults");

  await fromPlayer({ type: "setMainPinEnabled", noteId: hub.id, enabled: false, undoId: "PinRawUndo0001" });
  assert.deepEqual(page.system.attachment, { ...raw, mainPinEnabled: false });
  await requestWrite({ type: "undoPinChange", undoId: "PinRawUndo0001" });
  assert.deepEqual(page.system.attachment, raw,
    "undo restores the stored attachment block byte-for-byte, not resolved defaults");
});

test("setMainPinEnabled is a no-op for missing notes/cards and the dedicated path still works", async () => {
  await fromPlayer({ type: "setMainPinEnabled", noteId: "MissingNote00001", enabled: false });
  const note = await createNoteAt("Pin No Card", 6000, 1000);
  const layout = shared().pages.get(containers.ids.layoutPage);
  const card = structuredClone(layout.system.cards[note.id]);
  await layout.update({ [`system.cards.-=${note.id}`]: null });
  await fromPlayer({ type: "setMainPinEnabled", noteId: note.id, enabled: false, undoId: "PinNoCardUndo01" });
  assert.equal(sharedByName("Pin No Card").system.attachment.mainPinEnabled, true,
    "a missing layout card is a no-op");
  await layout.update({ [`system.cards.${note.id}`]: card });
  await fromPlayer({ type: "setMainPinEnabled", noteId: note.id, enabled: false, undoId: "PinNoCardUndo02" });
  assert.equal(sharedByName("Pin No Card").system.attachment.mainPinEnabled, false);
  await fromPlayer({ type: "setMainPinEnabled", noteId: note.id, enabled: true });
  assert.equal(sharedByName("Pin No Card").system.attachment.mainPinEnabled, true);
});

test("projection box sanitizer rejects non-finite/string values and clamps extremes", () => {
  assert.equal(sanitizeProjectionBox(null), null);
  assert.equal(sanitizeProjectionBox({ w: Infinity, h: 100 }), null);
  assert.equal(sanitizeProjectionBox({ w: 100, h: Number.NaN }), null);
  assert.equal(sanitizeProjectionBox({ w: "40", h: 100 }), null, "strings are not measurements");
  assert.deepEqual(sanitizeProjectionBox({ w: -50, h: -50 }), { w: 40, h: 40 });
  assert.deepEqual(sanitizeProjectionBox({ w: 1e12, h: 1e12 }), { w: 2000, h: 2000 });
  assert.deepEqual(sanitizeProjectionBox({ w: 200, h: 100, x: 1e12, rotation: 45 }),
    { w: 200, h: 100 }, "only client w/h are read");
});

test("disabling the main pin redistributes a trashed inbound link; restore and undo stay correct", async () => {
  const hub = await createNoteAt("Pin Trash Hub", 6500, 1400);
  const source = await createNoteAt("Pin Trash Source", 6200, 1400);
  await fromPlayer({
    type: "createLink", sourceId: source.id, targetId: hub.id,
    sourcePoint: { x: 1, y: 0.5 }, targetAnchorId: "main"
  });
  const before = {
    sourceLinks: structuredClone(sharedByName("Pin Trash Source").system.links),
    hubAnchors: structuredClone(sharedCard(hub.id).anchors)
  };
  await requestWrite({ type: "deleteNote", noteId: source.id });
  assert.ok(shared().pages.get(source.id).system.deleted);

  const undoId = "PinTrashUndo001";
  await fromPlayer({ type: "setMainPinEnabled", noteId: hub.id, enabled: false, undoId });
  assert.equal(sharedByName("Pin Trash Hub").system.attachment.mainPinEnabled, false);
  const trashedLink = shared().pages.get(source.id).system.links[0];
  assert.equal(trashedLink.id, before.sourceLinks[0].id, "the trashed link survives");
  assert.notEqual(trashedLink.targetAnchorId, "main",
    "a trashed link is redistributed too, not left dangling on main");
  assert.ok(trashedLink.targetAnchorId === ""
    || sharedCard(hub.id).anchors[trashedLink.targetAnchorId], "its replacement resolves");

  await requestWrite({ type: "restoreNote", noteId: source.id });
  const restoredLink = sharedByName("Pin Trash Source").system.links[0];
  assert.notEqual(restoredLink.targetAnchorId, "main", "restore does not reattach to the disabled main");
  assert.equal(sharedByName("Pin Trash Hub").system.attachment.mainPinEnabled, false);

  await requestWrite({ type: "undoPinChange", undoId });
  assert.deepEqual(sharedByName("Pin Trash Source").system.links, before.sourceLinks);
  assert.deepEqual(sharedCard(hub.id).anchors, before.hubAnchors);
  assert.equal(sharedByName("Pin Trash Hub").system.attachment.mainPinEnabled, true);
});

test("redistribution at the anchor cap drops new pins but keeps a valid link fallback", async () => {
  const hub = await createNoteAt("Pin Cap Hub", 6500, 1600);
  const inbound = await createNoteAt("Pin Cap Inbound", 6200, 1600);
  const layout = shared().pages.get(containers.ids.layoutPage);
  const anchors = {
    main: { kind: "main", x: 0.5, y: 0, createdBy: player.id }
  };
  for (let i = 0; i < 255; i++) {
    anchors[`m${i}`] = { kind: "minor", x: 0.1, y: 0.1, createdBy: player.id };
  }
  await layout.update({ [`system.cards.${hub.id}.anchors`]: anchors });
  await fromPlayer({
    type: "createLink", sourceId: inbound.id, targetId: hub.id,
    sourcePoint: { x: 1, y: 0.5 }, targetAnchorId: "main"
  });

  await fromPlayer({
    type: "setMainPinEnabled", noteId: hub.id, enabled: false, undoId: "PinCapUndo0001"
  });
  assert.equal(Object.keys(sharedCard(hub.id).anchors).length, 256,
    "redistribution cannot exceed the shared anchor cap");
  const link = sharedByName("Pin Cap Inbound").system.links[0];
  assert.ok(link, "the inbound link is not lost");
  assert.equal(link.targetAnchorId, "", "no over-cap pin id is invented");
  assert.deepEqual(link.targetPoint, { x: 0, y: 0.5 }, "the projected fallback is stored");
  assert.ok(["top", "right", "bottom", "left"].includes(link.targetSide));
  assert.equal(sharedByName("Pin Cap Hub").system.attachment.mainPinEnabled, false);
});

test("disabled main pins cannot be chosen as new link endpoints, but legacy links still work", async () => {
  const hub = await createNoteAt("Disabled Main Hub", 6500, 1800);
  const source = await createNoteAt("Disabled Main Source", 6200, 1800);
  await fromPlayer({
    type: "setMainPinEnabled", noteId: hub.id, enabled: false, undoId: "PinDisabledUndo01"
  });
  await fromPlayer({
    type: "setMainPinEnabled", noteId: source.id, enabled: false, undoId: "PinDisabledUndo02"
  });

  await fromPlayer({
    type: "createLink", sourceId: source.id, targetId: hub.id,
    sourcePoint: { x: 1, y: 0.5 }, targetAnchorId: "main"
  });
  assert.equal(sharedByName("Disabled Main Source").system.links.length, 0,
    "a new target choice cannot select a disabled main");

  await fromPlayer({
    type: "createLink", sourceId: source.id, targetId: hub.id,
    sourceAnchorId: "main", targetPoint: { x: 0, y: 0.5 }
  });
  assert.equal(sharedByName("Disabled Main Source").system.links.length, 0,
    "a new source choice cannot select a disabled main");

  const legacyId = "LegacyMainLink01";
  await sharedByName("Disabled Main Source").update({
    "system.links": [{
      id: legacyId, targetId: hub.id, label: "", direction: "one", color: "", lineStyle: "solid",
      origin: "drawn", edited: false, createdBy: player.id, hint: false,
      sourceAnchorId: "main", targetAnchorId: "main",
      sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
    }]
  });
  await fromPlayer({
    type: "updateLink", noteId: source.id, linkId: legacyId, fields: { label: "legacy renders" }
  });
  let legacy = sharedByName("Disabled Main Source").system.links[0];
  assert.equal(legacy.label, "legacy renders", "an existing link may still be edited");
  assert.equal(legacy.targetAnchorId, "main", "legacy anchor data is preserved for rendering");

  await fromPlayer({
    type: "updateLink", noteId: source.id, linkId: legacyId,
    fields: { label: "must not apply", targetAnchorId: "main" }
  });
  legacy = sharedByName("Disabled Main Source").system.links[0];
  assert.equal(legacy.label, "legacy renders", "re-selecting the disabled main is rejected");
});

test("moving a minor anchor refreshes fallbacks used by hide and reveal", async () => {
  const a = await createNoteAt("Move Anchor A", 6500, 2000);
  const b = await createNoteAt("Move Anchor B", 6800, 2000);
  await fromPlayer({ type: "addCardAnchor", noteId: a.id, kind: "minor", x: 0.2, y: 0.2 });
  const [anchorId] = minorAnchors(a.id).map(([id]) => id);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourceAnchorId: anchorId, sourcePoint: { x: 0.2, y: 0.2 }, sourceSide: "top",
    targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Move Anchor A").system.links[0];

  await fromPlayer({ type: "moveCardAnchor", noteId: a.id, anchorId, x: 0.85, y: 0.85 });
  let moved = sharedByName("Move Anchor A").system.links[0];
  assert.deepEqual([moved.sourcePoint.x, moved.sourcePoint.y], [0.85, 0.85]);
  assert.equal(moved.sourceSide, "bottom");

  assert.equal(await secrets.hideSharedLink(a.id, link.id), true);
  const hidden = vaultStore.data.hiddenLinks[a.id].find(item => item.targetId === b.id);
  assert.ok(hidden);
  assert.deepEqual([hidden.sourcePoint.x, hidden.sourcePoint.y], [0.85, 0.85],
    "hiding stores the refreshed fallback");
  assert.equal(hidden.sourceSide, "bottom");

  assert.equal(await secrets.revealLink(a.id, hidden.id), true);
  const revealed = sharedByName("Move Anchor A").system.links.find(item => item.targetId === b.id);
  assert.equal(revealed.sourceAnchorId, "");
  assert.deepEqual([revealed.sourcePoint.x, revealed.sourcePoint.y], [0.85, 0.85],
    "revealing keeps the new fallback position");
  assert.equal(revealed.sourceSide, "bottom");
});

test("a referenced non-canonical main folds to the canonical main instead of keeping two", async () => {
  const note = await createNoteAt("Non Canonical Main", 6500, 2200);
  const target = await createNoteAt("Non Canonical Target", 6800, 2200);
  const noise = await createNoteAt("Non Canonical Noise", 7000, 2200);
  const noiseTarget = await createNoteAt("Non Canonical Noise Target", 7200, 2200);
  const layout = shared().pages.get(containers.ids.layoutPage);
  await layout.update({
    [`system.cards.${note.id}.anchors`]: {
      main: { kind: "main", x: 0.9, y: 0.9, createdBy: player.id },
      legacyMain: { kind: "main", x: 0.1, y: 0.2, createdBy: player.id },
      keep: { kind: "minor", x: 0.3, y: 0.4, createdBy: player.id }
    }
  });
  await fromPlayer({
    type: "createLink", sourceId: note.id, targetId: target.id,
    sourceAnchorId: "legacyMain", targetPoint: { x: 0, y: 0.5 }
  });
  await fromPlayer({
    type: "createLink", sourceId: noise.id, targetId: noiseTarget.id,
    sourcePoint: { x: 0, y: 0.5 }, targetPoint: { x: 1, y: 0.5 }
  });
  const noiseLink = sharedByName("Non Canonical Noise").system.links[0];
  await fromPlayer({ type: "deleteLink", noteId: noise.id, linkId: noiseLink.id });

  const anchors = sharedCard(note.id).anchors;
  assert.deepEqual(anchors.main, {
    kind: "main", x: 0.5, y: 0, createdBy: player.id
  }, "the surviving main is folded to the canonical position");
  assert.equal(anchors.legacyMain, undefined);
  assert.equal(Object.values(anchors).filter(anchor => anchor.kind === "main").length, 1,
    "pruning never preserves two mains");
  const link = sharedByName("Non Canonical Main").system.links[0];
  assert.equal(link.sourceAnchorId, "main", "the link follows the folded main id");
});

test("pin undo restores null and absent raw attachments exactly", async () => {
  const nullHub = await createNoteAt("Pin Raw Null", 6500, 2400);
  const nullPage = sharedByName("Pin Raw Null");
  await nullPage.update({ "system.attachment": null });
  assert.equal(nullPage.system.attachment, null);
  await fromPlayer({
    type: "setMainPinEnabled", noteId: nullHub.id, enabled: false, undoId: "PinRawNull0001"
  });
  assert.deepEqual(nullPage.system.attachment, { mainPinEnabled: false });
  await requestWrite({ type: "undoPinChange", undoId: "PinRawNull0001" });
  assert.equal(nullPage.system.attachment, null, "null round-trips as null, not resolved defaults");

  const absentHub = await createNoteAt("Pin Raw Absent", 6500, 2600);
  const absentPage = sharedByName("Pin Raw Absent");
  await absentPage.update({ "system.-=attachment": null });
  assert.equal(Object.hasOwn(absentPage.system, "attachment"), false);
  await fromPlayer({
    type: "setMainPinEnabled", noteId: absentHub.id, enabled: false, undoId: "PinRawAbsent01"
  });
  assert.deepEqual(absentPage.system.attachment, { mainPinEnabled: false });
  await requestWrite({ type: "undoPinChange", undoId: "PinRawAbsent01" });
  assert.equal(Object.hasOwn(absentPage.system, "attachment"), false,
    "an absent attachment stays absent after undo");
});

test("successful pin writes are acknowledged, failed ones are not", async () => {
  const hub = await createNoteAt("Pin Ack Hub", 6500, 2800);
  const undoId = "PinAckUndo0001";
  const before = env.socketLog.length;
  await fromPlayer({ type: "setMainPinEnabled", noteId: hub.id, enabled: false, undoId });
  const acks = env.socketLog.slice(before).map(entry => entry.message)
    .filter(message => message.type === "writeApplied");
  assert.deepEqual(acks, [{
    type: "writeApplied", forUserId: player.id, kind: "pin", undoId
  }]);

  const seen = [];
  const hookId = Hooks.on("journalinatorWriteApplied", message => seen.push(message));
  try {
    env.deliver({ type: "writeApplied", forUserId: player.id, kind: "pin", undoId }, gmUser.id);
    assert.equal(seen.length, 0, "another client's acknowledgement is ignored");
    env.deliver({ type: "writeApplied", forUserId: gmUser.id, kind: "pin", undoId }, gmUser.id);
    assert.equal(seen.length, 1, "the active GM acknowledgement emits the hook");
    assert.equal(seen[0].undoId, undoId);
    env.deliver({ type: "writeApplied", forUserId: gmUser.id, kind: "pin", undoId: "Spoof" }, player.id);
    assert.equal(seen.length, 1, "a non-GM sender cannot forge an acknowledgement");
  } finally {
    Hooks.off("journalinatorWriteApplied", hookId);
  }

  const failedHub = await createNoteAt("Pin Ack Fail", 6500, 3000);
  const originalUpdate = failedHub.update.bind(failedHub);
  failedHub.update = async () => { throw new Error("injected acknowledgement failure"); };
  const beforeFailure = env.socketLog.length;
  try {
    await fromPlayer({
      type: "setMainPinEnabled", noteId: failedHub.id, enabled: false, undoId: "PinAckFail0001"
    });
  } finally {
    failedHub.update = originalUpdate;
  }
  assert.equal(env.socketLog.slice(beforeFailure).some(entry =>
    entry.message.type === "writeApplied" && entry.message.undoId === "PinAckFail0001"), false,
  "a rolled-back write sends no acknowledgement and consumes no Ctrl+Z entry");
  assert.equal(sharedByName("Pin Ack Fail").system.attachment.mainPinEnabled, true);
});

test("delete writes are acknowledged only after the note and card are removed", async () => {
  const note = await createNoteAt("Delete Ack Note", 6500, 3200);
  const undoId = "DeleteAckUndo001";
  const before = env.socketLog.length;
  await fromPlayer({ type: "deleteNote", noteId: note.id, undoId });
  const acks = env.socketLog.slice(before).map(entry => entry.message)
    .filter(message => message.type === "writeApplied");
  assert.deepEqual(acks, [{
    type: "writeApplied", forUserId: player.id, kind: "delete", undoId
  }]);
  assert.ok(note.system.deleted, "the note moved to trash");
  assert.equal(notesStore.getSharedLayout().cards[note.id], undefined, "the card was removed");

  const failed = await createNoteAt("Delete Ack Fail", 6500, 3400);
  const originalUpdate = failed.update.bind(failed);
  failed.update = async () => { throw new Error("injected delete acknowledgement failure"); };
  const beforeFailure = env.socketLog.length;
  try {
    await fromPlayer({ type: "deleteNote", noteId: failed.id, undoId: "DeleteAckFail001" });
  } finally {
    failed.update = originalUpdate;
  }
  assert.equal(env.socketLog.slice(beforeFailure).some(entry =>
    entry.message.type === "writeApplied" && entry.message.undoId === "DeleteAckFail001"), false,
  "a failed delete sends no acknowledgement");
  assert.equal(failed.system.deleted, null, "the failed delete rolled back and stayed live");

  await requestWrite({ type: "restoreNote", noteId: note.id });
  assert.equal(note.system.deleted, null, "cleanup restores the acknowledged fixture");
});

test("declassifying a note clears legacy anchors from links that stay secret", async () => {
  const sourceId = await secrets.createSecretNote({ title: "Legacy Anchor Source", x: 7300, y: 3000 });
  const targetId = await secrets.createSecretNote({ title: "Legacy Anchor Target", x: 7500, y: 3000 });
  await vaultStore.mutate(vault => {
    vault.notes[sourceId].links = [{
      id: "LegacyHiddenLink1", targetId,
      sourceAnchorId: "main", targetAnchorId: "minor-legacy",
      routeAnchors: [{ noteId: tavernId, anchorId: "main" }],
      sourceSide: "right", targetSide: "left",
      sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
    }];
  });
  assert.equal(await secrets.declassifyNote(sourceId, "Published Legacy Anchor"), true);
  const kept = vaultStore.data.hiddenLinks[sourceId].find(link => link.targetId === targetId);
  assert.ok(kept, "the still-secret link is retained in the vault");
  assert.equal(kept.sourceAnchorId, "");
  assert.equal(kept.targetAnchorId, "");
  assert.deepEqual(kept.routeAnchors, []);
  assert.equal(kept.sourceSide, "right", "the point/side fallback still renders");
  assert.ok(vaultStore.data.notes[targetId], "the target note stays secret");
});

test("the pin undo register evicts its oldest entry at 20", async () => {
  const hubs = [];
  for (let i = 0; i < 21; i++) {
    const title = `Pin Undo Cap ${i}`;
    await requestWrite({ type: "createNote", title, x: 6500 + i * 220, y: 3200 });
    hubs.push(sharedByName(title));
  }
  for (let i = 0; i < hubs.length; i++) {
    await requestWrite({
      type: "setMainPinEnabled", noteId: hubs[i].id, enabled: false,
      undoId: `PinUndoCap${String(i).padStart(3, "0")}`
    });
  }
  await requestWrite({ type: "undoPinChange", undoId: "PinUndoCap000" });
  assert.equal(sharedByName("Pin Undo Cap 0").system.attachment.mainPinEnabled, false,
    "the oldest entry has been evicted");
  await requestWrite({ type: "undoPinChange", undoId: "PinUndoCap001" });
  assert.equal(sharedByName("Pin Undo Cap 1").system.attachment.mainPinEnabled, true,
    "the next entry is still available");
});

test("restoring a note with a disabled main pin does not invent a main anchor", async () => {
  const note = await createNoteAt("Restore Disabled Main", 12000, 1000);
  const layout = shared().pages.get(containers.ids.layoutPage);
  await layout.update({ [`system.cards.${note.id}.anchors`]: {} });
  await fromPlayer({
    type: "setMainPinEnabled", noteId: note.id, enabled: false, undoId: "RestoreDisabled01"
  });
  assert.equal(sharedByName("Restore Disabled Main").system.attachment.mainPinEnabled, false);
  await requestWrite({ type: "deleteNote", noteId: note.id });
  await requestWrite({ type: "restoreNote", noteId: note.id });
  assert.equal(sharedByName("Restore Disabled Main").system.attachment.mainPinEnabled, false);
  assert.equal(sharedCard(note.id).anchors.main, undefined,
    "restore only adds a main anchor when the note still wants one");
});

test("route A inserts a main waypoint without changing the original link, its index and duplicate rules", async () => {
  const a = await createNoteAt("Route A Source", 13000, 4200);
  const b = await createNoteAt("Route A Target", 13400, 4200);
  const c = await createNoteAt("Route A Insert", 13200, 4200);
  const d = await createNoteAt("Route A Insert D", 13200, 4400);
  const e = await createNoteAt("Route A Insert E", 13200, 4600);

  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourceAnchorId: "main", targetAnchorId: "main"
  });
  const original = sharedByName("Route A Source").system.links.find(link => link.targetId === b.id);
  await fromPlayer({
    type: "updateLink", noteId: a.id, linkId: original.id,
    fields: {
      label: "Route A label", direction: "one", material: "double", thickness: 4,
      slack: 0.2, pattern: "alternating", ends: "loose",
      color: "link2", secondaryColor: "link3", lineStyle: "dashed"
    }
  });
  const before = structuredClone(linkOn("Route A Source", original.id));

  const ackBefore = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: original.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RouteAUndo000001"
  });
  const routed = linkOn("Route A Source", original.id);
  assert.deepEqual({ ...routed, routeAnchors: [] }, { ...before, routeAnchors: [] },
    "route A preserves the link id, endpoints, label, direction and cosmetics");
  assert.deepEqual(routed.routeAnchors, [{ noteId: c.id, anchorId: "main" }]);

  const acks = env.socketLog.slice(ackBefore)
    .filter(entry => entry.message.type === "writeApplied");
  assert.deepEqual(acks.map(entry => entry.message), [{
    type: "writeApplied", forUserId: player.id, kind: "route", action: "route", undoId: "RouteAUndo000001"
  }]);
  assert.deepEqual(acks[0].options.recipients, [player.id], "the ack goes only to the requester");

  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: original.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RouteADuplicate1"
  });
  assert.deepEqual(linkOn("Route A Source", original.id).routeAnchors,
    [{ noteId: c.id, anchorId: "main" }], "duplicate routing is rejected");

  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: original.id, noteId: d.id,
    mode: "route", index: 999, undoId: "RouteAIndexD001"
  });
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: original.id, noteId: e.id,
    mode: "route", index: -5, undoId: "RouteAIndexE001"
  });
  assert.deepEqual(linkOn("Route A Source", original.id).routeAnchors.map(entry => entry.noteId),
    [e.id, c.id, d.id], "index is clamped to both ends");

  const beforeDetach = structuredClone(linkOn("Route A Source", original.id));
  await fromPlayer({ type: "detachRouteNote", sourceId: a.id, linkId: original.id, noteId: c.id });
  const detached = linkOn("Route A Source", original.id);
  assert.deepEqual(detached.routeAnchors.map(entry => entry.noteId), [e.id, d.id]);
  assert.deepEqual({ ...detached, routeAnchors: [] }, { ...beforeDetach, routeAnchors: [] },
    "detach keeps the link id/endpoints/label/cosmetics");

  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: original.id, noteId: c.id,
    mode: "route", index: 1, undoId: "RouteAUndoBack1"
  });
  assert.deepEqual(linkOn("Route A Source", original.id).routeAnchors.map(entry => entry.noteId),
    [e.id, c.id, d.id]);
  await fromPlayer({ type: "undoRouteSplit", undoId: "RouteAUndoBack1" });
  assert.deepEqual(linkOn("Route A Source", original.id).routeAnchors.map(entry => entry.noteId),
    [e.id, d.id], "the acknowledged route insertion can be undone");

  await fromPlayer({ type: "deleteLink", noteId: a.id, linkId: original.id });
  assert.ok(sharedByName("Route A Source") && sharedByName("Route A Target")
    && sharedByName("Route A Insert"), "deleting a thread leaves every note");
});

test("route A rejects secret, hidden, trashed, self and pin-off targets", async () => {
  const a = await createNoteAt("Route Reject Source", 13000, 5000);
  const b = await createNoteAt("Route Reject Target", 13400, 5000);
  const c = await createNoteAt("Route Reject Insert", 13200, 5000);
  const f = await createNoteAt("Route Reject Pin Off", 13200, 5200);
  const g = await createNoteAt("Route Reject World Off", 13200, 5400);
  const h = await createNoteAt("Route Reject No Main", 13200, 5600);
  const gone = await createNoteAt("Route Reject Trashed", 13200, 5800);

  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Route Reject Source").system.links.find(item => item.targetId === b.id);
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RouteRejectBase1"
  });
  const routed = structuredClone(linkOn("Route Reject Source", link.id));
  assert.deepEqual(routed.routeAnchors, [{ noteId: c.id, anchorId: "main" }]);

  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: cultId,
    mode: "route", index: 0, undoId: "RouteRejectSecret"
  });
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: cultId, linkId: link.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RouteRejectSrcSec"
  });
  assert.deepEqual(linkOn("Route Reject Source", link.id).routeAnchors, routed.routeAnchors,
    "secret notes are never routable");

  const hiddenTarget = await createNoteAt("Route Hidden Target", 13800, 5000);
  await secrets.addHiddenLink(tavernId, hiddenTarget.id, {
    sourceSide: "right", targetSide: "left"
  });
  const hiddenLink = vaultStore.data.hiddenLinks[tavernId].find(link =>
    link.targetId === hiddenTarget.id);
  assert.ok(hiddenLink);
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: tavernId, linkId: hiddenLink.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RouteRejectHidden"
  });
  assert.deepEqual(linkOn("Route Reject Source", link.id).routeAnchors, routed.routeAnchors,
    "a vault-hidden link cannot be routed through the shared handler");

  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: a.id,
    mode: "route", index: 0, undoId: "RouteRejectSelf01"
  });
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: b.id,
    mode: "route", index: 0, undoId: "RouteRejectSelf02"
  });
  assert.deepEqual(linkOn("Route Reject Source", link.id).routeAnchors, routed.routeAnchors,
    "an endpoint note cannot be its own route waypoint");

  await requestWrite({ type: "deleteNote", noteId: gone.id });
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: gone.id,
    mode: "route", index: 0, undoId: "RouteRejectTrash1"
  });
  assert.deepEqual(linkOn("Route Reject Source", link.id).routeAnchors, routed.routeAnchors,
    "a trashed note is not a live route target");

  await fromPlayer({
    type: "setMainPinEnabled", noteId: f.id, enabled: false, undoId: "RouteRejectPin01"
  });
  assert.equal(sharedByName("Route Reject Pin Off").system.attachment.mainPinEnabled, false);
  let mark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: f.id,
    mode: "route", index: 0, undoId: "RouteRejectPin02"
  });
  assert.deepEqual(linkOn("Route Reject Source", link.id).routeAnchors, routed.routeAnchors);
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("main pin is off")),
    "pin-off routing is rejected with an explanation");

  const layout = shared().pages.get(containers.ids.layoutPage);
  await layout.update({ [`system.cards.${h.id}.anchors`]: {} });
  mark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: h.id,
    mode: "route", index: 0, undoId: "RouteRejectMain1"
  });
  assert.deepEqual(linkOn("Route Reject Source", link.id).routeAnchors, routed.routeAnchors);
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("main pin is off")),
    "a missing canonical main anchor is rejected");

  await game.settings.set("fvtt-journalinator", "pinsEnabled", false);
  try {
    mark = env.socketLog.length;
    await fromPlayer({
      type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: g.id,
      mode: "route", index: 0, undoId: "RouteRejectWorld"
    });
    assert.deepEqual(linkOn("Route Reject Source", link.id).routeAnchors, routed.routeAnchors);
    assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("main pin is off")),
      "routing is rejected while the pin experiment is off");
  } finally {
    await game.settings.set("fvtt-journalinator", "pinsEnabled", true);
  }
});

test("disabling a routed note's main pin drops only its waypoint and re-routing is refused", async () => {
  const a = await createNoteAt("Route Pin Drop Source", 14000, 4200);
  const b = await createNoteAt("Route Pin Drop Target", 14400, 4200);
  const c = await createNoteAt("Route Pin Drop Note", 14200, 4200);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Route Pin Drop Source").system.links.find(item => item.targetId === b.id);
  const before = structuredClone(linkOn("Route Pin Drop Source", link.id));
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RoutePinDrop0001"
  });
  assert.deepEqual(linkOn("Route Pin Drop Source", link.id).routeAnchors,
    [{ noteId: c.id, anchorId: "main" }]);

  await fromPlayer({
    type: "setMainPinEnabled", noteId: c.id, enabled: false, undoId: "RoutePinDrop0002"
  });
  const dropped = linkOn("Route Pin Drop Source", link.id);
  assert.equal(dropped.id, before.id);
  assert.deepEqual(dropped.routeAnchors, [], "pin-off drops only the route waypoint");
  assert.equal(sharedByName("Route Pin Drop Source").system.links.length, 1, "the link survives");

  const mark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RoutePinDrop0003"
  });
  assert.deepEqual(linkOn("Route Pin Drop Source", link.id).routeAnchors, [],
    "route A cannot reattach a disabled main pin");
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("main pin is off")));

  await requestWrite({ type: "undoPinChange", undoId: "RoutePinDrop0002" });
  assert.deepEqual(linkOn("Route Pin Drop Source", link.id).routeAnchors,
    [{ noteId: c.id, anchorId: "main" }], "pin undo restores the exact routed link");
});

test("route B splits into two styled links and undo restores the exact original", async () => {
  const a = await createNoteAt("Route Split Source", 15000, 4200);
  const b = await createNoteAt("Route Split Target", 15400, 4200);
  const c = await createNoteAt("Route Split Note", 15200, 4200);

  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourceAnchorId: "main", targetAnchorId: "main"
  });
  const original = sharedByName("Route Split Source").system.links.find(link => link.targetId === b.id);
  await fromPlayer({
    type: "updateLink", noteId: a.id, linkId: original.id,
    fields: {
      label: "split label", material: "double", thickness: 3.4, slack: 0.15,
      pattern: "interrupted", ends: "loose", color: "link1", secondaryColor: "link2",
      lineStyle: "dashed"
    }
  });
  await requestWrite({ type: "gmSetLinkHint", noteId: a.id, linkId: original.id, hint: true });

  const beforeSource = structuredClone(sharedByName("Route Split Source").system.links);
  const beforeNote = structuredClone(sharedByName("Route Split Note").system.links);
  const beforeLink = structuredClone(linkOn("Route Split Source", original.id));
  const ackBefore = env.socketLog.length;
  const undoId = "RouteSplitUndo01";
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: original.id, noteId: c.id,
    mode: "split", index: 0, undoId
  });

  const sourceLinks = sharedByName("Route Split Source").system.links;
  const noteLinks = sharedByName("Route Split Note").system.links;
  assert.equal(sourceLinks.length, beforeSource.length, "one link replaced by one on the source");
  assert.ok(!sourceLinks.some(link => link.id === original.id), "the original link id is gone");
  assert.equal(noteLinks.length, beforeNote.length + 1);
  const first = sourceLinks[sourceLinks.length - 1];
  const second = noteLinks[noteLinks.length - 1];
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.id, original.id);
  assert.equal(first.targetId, c.id);
  assert.equal(second.targetId, b.id);
  assert.equal(first.sourceAnchorId, beforeLink.sourceAnchorId, "A side endpoint preserved");
  assert.deepEqual(first.sourcePoint, beforeLink.sourcePoint);
  assert.equal(first.sourceSide, beforeLink.sourceSide);
  assert.equal(first.targetAnchorId, "main", "C side uses its main pin");
  assert.deepEqual(first.targetPoint, { x: 0.5, y: 0 });
  assert.equal(first.targetSide, "top");
  assert.equal(second.sourceAnchorId, "main");
  assert.deepEqual(second.sourcePoint, { x: 0.5, y: 0 });
  assert.equal(second.sourceSide, "top");
  assert.equal(second.targetAnchorId, beforeLink.targetAnchorId, "B side endpoint preserved");
  assert.deepEqual(second.targetPoint, beforeLink.targetPoint);
  assert.equal(second.targetSide, beforeLink.targetSide);

  for (const item of [first, second]) {
    assert.equal(item.material, "double");
    assert.equal(item.thickness, 3.4);
    assert.equal(item.slack, 0.15);
    assert.equal(item.pattern, "interrupted");
    assert.equal(item.ends, "loose");
    assert.equal(item.color, "link1");
    assert.equal(item.secondaryColor, "link2");
    assert.equal(item.lineStyle, "dashed");
    assert.equal(item.origin, "drawn");
    assert.equal(item.edited, true);
    assert.equal(item.createdBy, player.id);
    assert.equal(item.direction, "none");
    assert.equal(item.hint, true);
    assert.deepEqual(item.routeAnchors, []);
    assert.ok(!item.pins || item.pins.length === 0, "no board pins are invented");
  }
  assert.equal(first.label, "split label");
  assert.equal(second.label, "");

  const ack = env.socketLog.slice(ackBefore).map(entry => entry.message)
    .find(message => message.type === "writeApplied");
  assert.deepEqual(ack, { type: "writeApplied", forUserId: player.id, kind: "route", action: "split", undoId });

  // Unauthorized client (the GM here) cannot spend the player's undo entry.
  await requestWrite({ type: "undoRouteSplit", undoId });
  assert.equal(sharedByName("Route Split Source").system.links.length, sourceLinks.length);
  await fromPlayer({ type: "undoRouteSplit", undoId });
  assert.deepEqual(sharedByName("Route Split Source").system.links, beforeSource,
    "undo restores the exact original source array");
  assert.deepEqual(sharedByName("Route Split Note").system.links, beforeNote,
    "undo removes the second link and leaves C's other links alone");

  // A stale undo after a later edit is refused and keeps the split links.
  const staleUndo = "RouteSplitStale1";
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: original.id, noteId: c.id,
    mode: "split", index: 0, undoId: staleUndo
  });
  const splitLinks = sharedByName("Route Split Source").system.links;
  const splitFirst = splitLinks[splitLinks.length - 1];
  await fromPlayer({
    type: "updateLink", noteId: a.id, linkId: splitFirst.id, fields: { label: "later edit" }
  });
  const afterEdit = structuredClone(sharedByName("Route Split Source").system.links);
  const mark = env.socketLog.length;
  await fromPlayer({ type: "undoRouteSplit", undoId: staleUndo });
  assert.deepEqual(sharedByName("Route Split Source").system.links, afterEdit,
    "a stale undo does not clobber a later edit");
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("no longer be undone")));
});

test("route B rejects typed links and links with existing pins or route waypoints", async () => {
  const a = await createNoteAt("Route Split Reject Source", 15600, 5000);
  const b = await createNoteAt("Route Split Reject Target", 16000, 5000);
  const c = await createNoteAt("Route Split Reject Note", 15800, 5000);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Route Split Reject Source").system.links.find(item => item.targetId === b.id);

  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RouteSplitBlockA"
  });
  const routed = structuredClone(linkOn("Route Split Reject Source", link.id));
  const mark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
    mode: "split", index: 0, undoId: "RouteSplitBlock01"
  });
  assert.deepEqual(linkOn("Route Split Reject Source", link.id), routed,
    "existing route waypoints must be detached before splitting");
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("Detach board pins")));

  const pinTarget = await createNoteAt("Route Split Pin Target", 16000, 5200);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: pinTarget.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const pinLink = sharedByName("Route Split Reject Source").system.links
    .find(item => item.targetId === pinTarget.id);
  const pinPage = sharedByName("Route Split Reject Source");
  await pinPage.update({
    "system.links": pinPage.system.links.map(item =>
      item.id === pinLink.id ? { ...item, pins: [{ x: 10, y: 20 }] } : item)
  });
  const pinned = structuredClone(linkOn("Route Split Reject Source", pinLink.id));
  const pinMark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: pinLink.id, noteId: c.id,
    mode: "split", index: 0, undoId: "RouteSplitBlock02"
  });
  assert.deepEqual(linkOn("Route Split Reject Source", pinLink.id), pinned,
    "board pins must be detached before splitting");
  assert.ok(rejectionReasonsSince(pinMark).some(reason => reason.includes("Detach board pins")));

  const ts = await createNoteAt("Route Typed Source", 16200, 5000);
  await createNoteAt("Route Typed Target", 16600, 5000);
  const tn = await createNoteAt("Route Typed Note", 16400, 5000);
  const block = sharedByName("Route Typed Source").system.blocks[0];
  await fromPlayer({ type: "requestLock", noteId: ts.id, blockId: block.blockId });
  await fromPlayer({
    type: "saveBlock", noteId: ts.id, blockId: block.blockId,
    text: "See [[Route Typed Target]]."
  });
  await fromPlayer({ type: "releaseLock", noteId: ts.id, blockId: block.blockId });
  const typed = sharedByName("Route Typed Source").system.links.find(item => item.origin === "typed");
  assert.ok(typed);
  const typedBefore = structuredClone(sharedByName("Route Typed Source").system.links);
  const typedMark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: ts.id, linkId: typed.id, noteId: tn.id,
    mode: "split", index: 0, undoId: "RouteSplitBlock03"
  });
  assert.deepEqual(sharedByName("Route Typed Source").system.links, typedBefore);
  assert.ok(rejectionReasonsSince(typedMark).some(reason => reason.includes("Typed [[links]]")));
});

test("a failed second split write rolls both source and inserted-note links back", async () => {
  const a = await createNoteAt("Route Split Rollback Source", 16800, 4200);
  const b = await createNoteAt("Route Split Rollback Target", 17200, 4200);
  const c = await createNoteAt("Route Split Rollback Note", 17000, 4200);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Route Split Rollback Source").system.links
    .find(item => item.targetId === b.id);
  const beforeSource = structuredClone(sharedByName("Route Split Rollback Source").system.links);
  const beforeNote = structuredClone(sharedByName("Route Split Rollback Note").system.links);

  const originalUpdate = c.update.bind(c);
  let calls = 0;
  c.update = async function update(changes) {
    calls += 1;
    if (calls === 1) throw new Error("injected split write failure");
    return originalUpdate(changes);
  };
  const mark = env.socketLog.length;
  try {
    await fromPlayer({
      type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
      mode: "split", index: 0, undoId: "RouteSplitFail01"
    });
  } finally {
    c.update = originalUpdate;
  }
  assert.ok(calls >= 1);
  assert.deepEqual(sharedByName("Route Split Rollback Source").system.links, beforeSource,
    "the already-written source page was restored");
  assert.deepEqual(sharedByName("Route Split Rollback Note").system.links, beforeNote);
  assert.equal(env.socketLog.slice(mark).some(entry => entry.message.type === "writeApplied"
    && entry.message.undoId === "RouteSplitFail01"), false,
  "a rolled-back split sends no acknowledgement");
  await requestWrite({ type: "undoRouteSplit", undoId: "RouteSplitFail01" });
  assert.deepEqual(sharedByName("Route Split Rollback Source").system.links, beforeSource,
    "no undo entry was recorded");
});

test("route B without a main pin uses the facing card edges for the inserted note", async () => {
  const a = await createNoteAt("Route Split Edge Source", 17400, 4200);
  const b = await createNoteAt("Route Split Edge Target", 18200, 4200);
  const c = await createNoteAt("Route Split Edge Note", 17800, 4200);
  const layout = shared().pages.get(containers.ids.layoutPage);
  for (const note of [a, b, c]) {
    await layout.update({ [`system.cards.${note.id}.rotation`]: 0 });
  }
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Route Split Edge Source").system.links.find(item => item.targetId === b.id);
  await fromPlayer({
    type: "setMainPinEnabled", noteId: c.id, enabled: false, undoId: "RouteSplitEdge01"
  });
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
    mode: "split", index: 0, undoId: "RouteSplitEdge02"
  });
  const first = sharedByName("Route Split Edge Source").system.links
    .find(item => item.targetId === c.id);
  const second = sharedByName("Route Split Edge Note").system.links
    .find(item => item.targetId === b.id);
  assert.ok(first && second);
  assert.equal(first.targetAnchorId, "", "no main anchor is referenced when the pin is off");
  assert.equal(second.sourceAnchorId, "");
  assert.equal(first.targetSide, "left", "the C side faces the source on its left");
  assert.equal(second.sourceSide, "right", "the C side faces the target on its right");
  assert.deepEqual(first.targetPoint, { x: 0, y: 0.5 });
  assert.deepEqual(second.sourcePoint, { x: 1, y: 0.5 });
  assert.ok(sharedCard(c.id).anchors.main, "the stored main anchor is retained for re-enable");
});

test("deleting a routed note removes only its waypoints from every stored link", async () => {
  const source = await createNoteAt("Route Cleanup Source", 18400, 5000);
  const t1 = await createNoteAt("Route Cleanup Target 1", 18800, 5000);
  const t2 = await createNoteAt("Route Cleanup Target 2", 18800, 5200);
  const via = await createNoteAt("Route Cleanup Via", 18600, 5100);

  await fromPlayer({
    type: "createLink", sourceId: source.id, targetId: t1.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  await fromPlayer({
    type: "createLink", sourceId: source.id, targetId: t2.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const links = sharedByName("Route Cleanup Source").system.links
    .filter(item => [t1.id, t2.id].includes(item.targetId));
  assert.equal(links.length, 2);
  for (const link of links) {
    await fromPlayer({
      type: "routeNoteOnLink", sourceId: source.id, linkId: link.id, noteId: via.id,
      mode: "route", index: 0, undoId: `RouteCleanup${link.targetId.slice(0, 4)}`
    });
  }
  const linkIds = sharedByName("Route Cleanup Source").system.links.map(link => link.id);
  assert.ok(sharedByName("Route Cleanup Source").system.links
    .every(link => link.routeAnchors.some(entry => entry.noteId === via.id)));

  // A trashed owner still stores its links, so cleanup must scan all shared notes.
  await requestWrite({ type: "deleteNote", noteId: source.id });
  assert.ok(sharedByName("Route Cleanup Source").system.links
    .every(link => link.routeAnchors.some(entry => entry.noteId === via.id)),
  "trashing the owner keeps its routed links");

  await fromPlayer({ type: "deleteNote", noteId: via.id });
  const trashedLinks = sharedByName("Route Cleanup Source").system.links;
  assert.equal(trashedLinks.length, 2, "links survive deleting the routed note");
  assert.deepEqual(trashedLinks.map(link => link.id).sort(), linkIds.slice().sort());
  assert.ok(trashedLinks.every(link => link.routeAnchors.length === 0),
    "only the deleted note's waypoints are removed from trashed owners too");

  await requestWrite({ type: "restoreNote", noteId: via.id });
  assert.ok(sharedByName("Route Cleanup Source").system.links
    .every(link => link.routeAnchors.length === 0), "restoring the note does not re-add waypoints");
  await requestWrite({ type: "restoreNote", noteId: source.id });
  const restoredLinks = sharedByName("Route Cleanup Source").system.links;
  assert.equal(restoredLinks.length, 2);
  assert.ok(restoredLinks.every(link => link.routeAnchors.length === 0));

  await fromPlayer({ type: "deleteLink", noteId: source.id, linkId: restoredLinks[0].id });
  assert.ok(sharedByName("Route Cleanup Source") && sharedByName("Route Cleanup Target 1")
    && sharedByName("Route Cleanup Via"), "deleting a thread leaves notes");
});

test("route A may add a visual waypoint to a typed link without changing its origin", async () => {
  const source = await createNoteAt("Route Typed Route Source", 19000, 5000);
  await createNoteAt("Route Typed Route Target", 19600, 5000);
  const insert = await createNoteAt("Route Typed Route Note", 19300, 5000);
  const block = sharedByName("Route Typed Route Source").system.blocks[0];
  await fromPlayer({ type: "requestLock", noteId: source.id, blockId: block.blockId });
  await fromPlayer({
    type: "saveBlock", noteId: source.id, blockId: block.blockId,
    text: "See [[Route Typed Route Target]]."
  });
  await fromPlayer({ type: "releaseLock", noteId: source.id, blockId: block.blockId });
  const typed = sharedByName("Route Typed Route Source").system.links
    .find(link => link.origin === "typed");
  assert.ok(typed);
  const before = structuredClone(typed);
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: source.id, linkId: typed.id, noteId: insert.id,
    mode: "route", index: 0, undoId: "RouteTypedA0001"
  });
  const routed = linkOn("Route Typed Route Source", typed.id);
  assert.equal(routed.origin, "typed", "route A never converts a typed relationship");
  assert.deepEqual(routed.routeAnchors, [{ noteId: insert.id, anchorId: "main" }]);
  assert.deepEqual({ ...routed, routeAnchors: [] }, { ...before, routeAnchors: [] });
  assert.equal(sharedByName("Route Typed Route Source").system.blocks[0].text,
    "See [[Route Typed Route Target]].", "note text is untouched");
});

test("route A reports duplicate/cap/missing rejections and board pins can be cleared", async () => {
  const a = await createNoteAt("Route Limit Source", 20000, 4200);
  const b = await createNoteAt("Route Limit Target", 20400, 4200);
  const c = await createNoteAt("Route Limit Note", 20200, 4200);
  const d = await createNoteAt("Route Limit Note D", 20200, 4400);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Route Limit Source").system.links.find(item => item.targetId === b.id);
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RouteLimitBase01"
  });
  assert.deepEqual(linkOn("Route Limit Source", link.id).routeAnchors,
    [{ noteId: c.id, anchorId: "main" }]);

  let mark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RouteLimitDup001"
  });
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("already routed through this thread")),
    "a duplicate route waypoint is rejected with a localized reason");
  assert.deepEqual(linkOn("Route Limit Source", link.id).routeAnchors,
    [{ noteId: c.id, anchorId: "main" }]);

  const page = sharedByName("Route Limit Source");
  await page.update({
    "system.links": page.system.links.map(item => item.id === link.id ? {
      ...item,
      routeAnchors: Array.from({ length: MAX_ROUTE_ANCHORS }, () => ({ noteId: c.id, anchorId: "main" }))
    } : item)
  });
  mark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: d.id,
    mode: "route", index: 0, undoId: "RouteLimitCap0001"
  });
  assert.equal(linkOn("Route Limit Source", link.id).routeAnchors.length, MAX_ROUTE_ANCHORS);
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("maximum number of routed notes")),
    "the server cap is reported instead of silently returning");
  assert.equal(env.socketLog.slice(mark).some(entry => entry.message.type === "writeApplied"
    && entry.message.undoId === "RouteLimitCap0001"), false, "a capped route sends no ack");

  mark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: "MissingNote00001",
    mode: "route", index: 0, undoId: "RouteLimitMiss001"
  });
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("no longer available")),
    "a missing/trashed route target is reported");

  // Clear only the free board pins; route waypoints and every other link field stay untouched.
  await page.update({
    "system.links": page.system.links.map(item => item.id === link.id ? {
      ...item,
      pins: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
      routeAnchors: [{ noteId: c.id, anchorId: "main" }]
    } : item)
  });
  const beforeClear = structuredClone(linkOn("Route Limit Source", link.id));
  const clearMark = env.socketLog.length;
  await fromPlayer({ type: "clearThreadPins", noteId: a.id, linkId: link.id });
  const cleared = linkOn("Route Limit Source", link.id);
  assert.deepEqual(cleared.pins, [], "the clear-pins request removes every board pin");
  assert.deepEqual(cleared.routeAnchors, beforeClear.routeAnchors, "route waypoints are not pins");
  assert.deepEqual({ ...cleared, pins: beforeClear.pins }, beforeClear,
    "all other link fields survive clearing pins");
  assert.equal(env.socketLog.slice(clearMark).some(entry => entry.message.type === "writeRejected"), false);

  mark = env.socketLog.length;
  await fromPlayer({ type: "clearThreadPins", noteId: a.id, linkId: link.id });
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("no board pins")),
    "clearing an unpinned thread is explained instead of silently ignored");
});

test("route A drops stale waypoints and continues instead of silently no-oping", async () => {
  const a = await createNoteAt("Route Stale Source", 20600, 4200);
  const b = await createNoteAt("Route Stale Target", 21000, 4200);
  const c = await createNoteAt("Route Stale Note", 20800, 4200);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Route Stale Source").system.links.find(item => item.targetId === b.id);
  const page = sharedByName("Route Stale Source");
  const staleId = "StaleNote0000001";
  await page.update({
    "system.links": page.system.links.map(item => item.id === link.id
      ? { ...item, routeAnchors: [{ noteId: staleId, anchorId: "main" }] } : item)
  });
  const mark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RouteStale000001"
  });
  const routed = linkOn("Route Stale Source", link.id);
  assert.deepEqual(routed.routeAnchors, [{ noteId: c.id, anchorId: "main" }],
    "the stale waypoint is removed and the new waypoint is inserted");
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("missing or unavailable")),
    "the stale cleanup is reported");
  assert.ok(env.socketLog.slice(mark).some(entry => entry.message.type === "writeApplied"
    && entry.message.action === "route" && entry.message.undoId === "RouteStale000001"),
  "a successful cleanup still acknowledges the route write");
});

test("detaching a routed note is acknowledged and can be undone", async () => {
  const a = await createNoteAt("Route Detach Source", 21200, 4200);
  const b = await createNoteAt("Route Detach Target", 21600, 4200);
  const c = await createNoteAt("Route Detach Note", 21400, 4200);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Route Detach Source").system.links.find(item => item.targetId === b.id);
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
    mode: "route", index: 0, undoId: "RouteDetachBase1"
  });
  const routed = structuredClone(linkOn("Route Detach Source", link.id));
  const detachId = "RouteDetachUndo";
  const mark = env.socketLog.length;
  await fromPlayer({
    type: "detachRouteNote", sourceId: a.id, linkId: link.id, noteId: c.id, undoId: detachId
  });
  const detached = linkOn("Route Detach Source", link.id);
  assert.deepEqual(detached.routeAnchors, []);
  assert.deepEqual({ ...detached, routeAnchors: routed.routeAnchors }, routed,
    "detach changes only the route waypoints");
  const ack = env.socketLog.slice(mark).map(entry => entry.message)
    .find(message => message.type === "writeApplied");
  assert.deepEqual(ack, {
    type: "writeApplied", forUserId: player.id, kind: "route", action: "detach", undoId: detachId
  }, "detach acknowledges the action and undo id");

  await fromPlayer({ type: "undoRouteSplit", undoId: detachId });
  assert.deepEqual(linkOn("Route Detach Source", link.id), routed,
    "Ctrl+Z can restore the exact pre-detach link array");
});

test("route B rejects a split that would duplicate an existing relationship", async () => {
  const a = await createNoteAt("Route Duplicate Source", 21800, 5000);
  const b = await createNoteAt("Route Duplicate Target", 22400, 5000);
  const c = await createNoteAt("Route Duplicate Note", 22100, 5000);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const ab = sharedByName("Route Duplicate Source").system.links.find(item => item.targetId === b.id);

  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: c.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const ac = sharedByName("Route Duplicate Source").system.links.find(item => item.targetId === c.id);
  let before = structuredClone(sharedByName("Route Duplicate Source").system.links);
  let mark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: ab.id, noteId: c.id,
    mode: "split", index: 0, undoId: "RouteDupSplit001"
  });
  assert.deepEqual(sharedByName("Route Duplicate Source").system.links, before,
    "an existing A→C link blocks the split without writing");
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("duplicate an existing link")));

  await fromPlayer({ type: "deleteLink", noteId: a.id, linkId: ac.id });
  await fromPlayer({
    type: "createLink", sourceId: c.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  before = structuredClone(sharedByName("Route Duplicate Source").system.links);
  const beforeNote = structuredClone(sharedByName("Route Duplicate Note").system.links);
  mark = env.socketLog.length;
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: ab.id, noteId: c.id,
    mode: "split", index: 0, undoId: "RouteDupSplit002"
  });
  assert.deepEqual(sharedByName("Route Duplicate Source").system.links, before,
    "an existing C→B link blocks the split too");
  assert.deepEqual(sharedByName("Route Duplicate Note").system.links, beforeNote);
  assert.ok(rejectionReasonsSince(mark).some(reason => reason.includes("duplicate an existing link")));
});

test("route A waypoints survive a later typed-link save", async () => {
  const source = await createNoteAt("Route Typed Keep Source", 22800, 5000);
  await createNoteAt("Route Typed Keep Target", 23300, 5000);
  const insert = await createNoteAt("Route Typed Keep Note", 23050, 5000);
  const sourcePage = sharedByName("Route Typed Keep Source");
  const block = sourcePage.system.blocks[0];
  await fromPlayer({ type: "requestLock", noteId: source.id, blockId: block.blockId });
  await fromPlayer({
    type: "saveBlock", noteId: source.id, blockId: block.blockId,
    text: "See [[Route Typed Keep Target]]."
  });
  await fromPlayer({ type: "releaseLock", noteId: source.id, blockId: block.blockId });
  const typed = sharedByName("Route Typed Keep Source").system.links
    .find(item => item.origin === "typed");
  assert.ok(typed);
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: source.id, linkId: typed.id, noteId: insert.id,
    mode: "route", index: 0, undoId: "RouteTypedKeep1"
  });
  assert.deepEqual(linkOn("Route Typed Keep Source", typed.id).routeAnchors,
    [{ noteId: insert.id, anchorId: "main" }]);

  await fromPlayer({ type: "requestLock", noteId: source.id, blockId: block.blockId });
  await fromPlayer({
    type: "saveBlock", noteId: source.id, blockId: block.blockId,
    text: "See [[Route Typed Keep Target]] and more."
  });
  await fromPlayer({ type: "releaseLock", noteId: source.id, blockId: block.blockId });
  const resaved = sharedByName("Route Typed Keep Source").system.links
    .find(item => item.origin === "typed");
  assert.equal(resaved.id, typed.id, "re-saving keeps the same typed relationship");
  assert.deepEqual(resaved.routeAnchors, [{ noteId: insert.id, anchorId: "main" }],
    "reconciliation preserves the routed waypoint");
});

test("route B computes the rotated inserted note's facing edges", async () => {
  const a = await createNoteAt("Route Rotated Source", 23600, 5200);
  const b = await createNoteAt("Route Rotated Target", 24400, 5200);
  const c = await createNoteAt("Route Rotated Note", 24000, 5200);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Route Rotated Source").system.links.find(item => item.targetId === b.id);
  await fromPlayer({
    type: "setMainPinEnabled", noteId: c.id, enabled: false, undoId: "RouteRotatedPin1"
  });
  const layout = shared().pages.get(containers.ids.layoutPage);
  await layout.update({ [`system.cards.${c.id}.rotation`]: 90 });
  await fromPlayer({
    type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
    mode: "split", index: 0, undoId: "RouteRotatedSp1"
  });
  const first = sharedByName("Route Rotated Source").system.links.find(item => item.targetId === c.id);
  const second = sharedByName("Route Rotated Note").system.links.find(item => item.targetId === b.id);
  assert.ok(first && second);
  const boxA = { x: 23600, y: 5200, w: 200, h: 100, rotation: 0 };
  const boxB = { x: 24400, y: 5200, w: 200, h: 100, rotation: 0 };
  const boxC = { x: 24000, y: 5200, w: 200, h: 100, rotation: 90 };
  const towardC = anchorWorld(boxA, { x: 1, y: 0.5 });
  const towardB = anchorWorld(boxB, { x: 0, y: 0.5 });
  const edgeFromA = projectToEdge(boxC, towardC);
  const edgeFromB = projectToEdge(boxC, towardB);
  assert.equal(first.targetAnchorId, "", "no main anchor is referenced when the pin is off");
  assert.equal(second.sourceAnchorId, "");
  assert.deepEqual(first.targetPoint, { x: edgeFromA.point.x, y: edgeFromA.point.y },
    "the A→C endpoint projects onto the rotated card");
  assert.equal(first.targetSide, edgeFromA.side);
  assert.deepEqual(second.sourcePoint, { x: edgeFromB.point.x, y: edgeFromB.point.y },
    "the C→B endpoint projects onto the rotated card");
  assert.equal(second.sourceSide, edgeFromB.side);
});

test("route B uses one updateDocuments call when Foundry exposes it", async () => {
  const a = await createNoteAt("Route Atomic Source", 24800, 5200);
  const b = await createNoteAt("Route Atomic Target", 25300, 5200);
  const c = await createNoteAt("Route Atomic Note", 25050, 5200);
  await fromPlayer({
    type: "createLink", sourceId: a.id, targetId: b.id,
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  });
  const link = sharedByName("Route Atomic Source").system.links.find(item => item.targetId === b.id);
  const calls = [];
  const original = globalThis.JournalEntryPage.updateDocuments;
  // The real Foundry v14 static commits both embedded pages in one database operation; this stub
  // records the call and applies the same update payloads so the rest of the split path is tested.
  globalThis.JournalEntryPage.updateDocuments = async (updates, { parent } = {}) => {
    calls.push({ updates, parent });
    for (const update of updates) {
      const page = parent.pages.get(update._id);
      for (const [key, value] of Object.entries(update)) {
        if (key !== "_id") await page.update({ [key]: value });
      }
    }
    return [];
  };
  try {
    const mark = env.socketLog.length;
    await fromPlayer({
      type: "routeNoteOnLink", sourceId: a.id, linkId: link.id, noteId: c.id,
      mode: "split", index: 0, undoId: "RouteAtomic00001"
    });
    assert.equal(calls.length, 1, "the split takes the single-call atomic path");
    assert.equal(calls[0].parent, shared());
    assert.deepEqual(calls[0].updates.map(update => update._id).sort(), [a.id, c.id].sort(),
      "both pages are updated in the same operation");
    assert.ok(env.socketLog.slice(mark).some(entry => entry.message.type === "writeApplied"
      && entry.message.action === "split" && entry.message.undoId === "RouteAtomic00001"));
    assert.ok(sharedByName("Route Atomic Source").system.links.some(item => item.targetId === c.id));
    assert.ok(sharedByName("Route Atomic Note").system.links.some(item => item.targetId === b.id));
  } finally {
    globalThis.JournalEntryPage.updateDocuments = original;
  }
});

test("final player-visible dump still excludes the remaining secret notes", () => {
  const dump = playerVisibleDump();
  for (const note of Object.values(vaultStore.data?.notes ?? {})) {
    assert.ok(!dump.includes(note.name), `end of suite: secret title "${note.name}" leaked`);
    assert.ok(!dump.includes(note.id), `end of suite: secret note id leaked`);
  }
});

function privateCardsOverlap(a, b) {
  const aw = Number.isFinite(a.width) && a.width > 0 ? a.width : 200;
  const ah = Number.isFinite(a.height) && a.height > 0 ? a.height : 90;
  const bw = Number.isFinite(b.width) && b.width > 0 ? b.width : 200;
  const bh = Number.isFinite(b.height) && b.height > 0 ? b.height : 90;
  return !(a.x + aw <= b.x || b.x + bw <= a.x || a.y + ah <= b.y || b.y + bh <= a.y);
}

test("private transfers are sent, stay pending, and import as a recipient copy", async () => {
  const statsBefore = JSON.stringify(notesStore.getStats()?.activity ?? {});
  assert.equal(privateStore.findActive(player.id), null, "the player starts without a private page");

  const gmPage = await privateStore.createFor(gmUser);
  const workspace = privateStore.read(gmPage);
  const alpha = privateStore.makeNote({ title: "Transfer Alpha", style: "memo", x: 0, y: 0, cards: {} });
  const beta = privateStore.makeNote({
    title: "Transfer Beta", style: "document", x: 450, y: 0,
    cards: { [alpha.note.id]: alpha.card }
  });
  alpha.note.blocks = [{ blockId: "TransferBlockA", text: "private alpha text", authorId: gmUser.id }];
  alpha.note.image = "assets/stylized/cork.svg";
  alpha.note.backgroundImage = "assets/stylized/paper.webp";
  alpha.note.presentation = {
    ...alpha.note.presentation,
    extendedStyle: "document", forceExtended: true, font: "hand", pictureLayout: "left", torn: true
  };
  alpha.note.attachment = {
    ...alpha.note.attachment, pinStyle: "brass", mainSnapRadius: 12
  };
  beta.note.blocks = [{ blockId: "TransferBlockB", text: "private beta text", authorId: gmUser.id }];
  alpha.note.links = [
    {
      id: "transfer-internal", targetId: beta.note.id, label: "internal", direction: "one",
      color: "link1", lineStyle: "solid", origin: "drawn", edited: false,
      createdBy: gmUser.id, hint: false, sourceAnchorId: "main", targetAnchorId: "main",
      sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 },
      routeAnchors: [{ noteId: beta.note.id, anchorId: "main" }]
    },
    { id: "transfer-external", targetId: "OutsideNote00001", label: "external", direction: "one" }
  ];
  workspace.notes[alpha.note.id] = alpha.note;
  workspace.notes[beta.note.id] = beta.note;
  workspace.layout.cards[alpha.note.id] = alpha.card;
  workspace.layout.cards[beta.note.id] = beta.card;
  workspace.layout.labels.attachedStamp = {
    text: "", x: 0, y: 0, size: 14, color: "#c79848", stamp: "skull",
    noteId: alpha.note.id, corner: "bottom-right"
  };
  workspace.layout.labels.free = {
    text: "free label text", x: 20, y: 20, size: 14, color: "", stamp: "",
    noteId: "", corner: "bottom-right"
  };
  await privateStore.save(gmPage, workspace, privateStore.flags(gmPage).rev ?? 0);

  const acks = [];
  const hookId = Hooks.on("journalinatorWriteApplied", message => acks.push(message));
  try {
    await requestWrite({
      type: "sendPrivateTransfer", toUserId: player.id,
      noteIds: [alpha.note.id, beta.note.id]
    });
  } finally {
    Hooks.off("journalinatorWriteApplied", hookId);
  }
  const sent = acks.find(message => message.kind === "privateTransfer" && message.action === "sent");
  assert.ok(sent, "the sender receives a writeApplied acknowledgement");
  assert.equal(sent.count, 2);
  assert.equal(sent.toUserId, player.id);
  assert.ok(sent.transferId);
  assert.ok(!JSON.stringify(sent).includes("private alpha text"),
    "the acknowledgement carries no note payload");

  const pending = privateStore.pendingTransfers(player.id);
  assert.equal(pending.length, 1);
  const record = pending[0];
  assert.equal(record.id, sent.transferId);
  assert.equal(record.fromUserId, gmUser.id);
  assert.equal(record.toUserId, player.id);
  assert.equal(record.notes.length, 2);
  assert.deepEqual(record.summary, {
    count: 2, titles: ["Transfer Alpha", "Transfer Beta"],
    droppedLinks: 1, droppedWaypoints: 0
  });
  assert.equal(JSON.stringify(notesStore.getStats()?.activity ?? {}), statsBefore,
    "pending transfers do not touch the main-canvas statistics");

  env.notifications.length = 0;
  await requestWrite({ type: "acceptPrivateTransfer", transferId: record.id });
  assert.ok(env.notifications.some(([, text]) => text.includes("not addressed to you")),
    "only the named recipient may accept");
  assert.equal(privateStore.transfer(record.id)?.id, record.id, "a refused accept keeps the offer");

  const ackMark = env.socketLog.length;
  await fromPlayer({ type: "acceptPrivateTransfer", transferId: record.id });
  const accepted = env.socketLog.slice(ackMark).map(entry => entry.message)
    .find(message => message.type === "writeApplied" && message.kind === "privateTransfer");
  assert.deepEqual(accepted, {
    type: "writeApplied", forUserId: player.id, kind: "privateTransfer",
    action: "accepted", count: 2, droppedLinks: 1, droppedWaypoints: 0
  });
  assert.equal(privateStore.pendingTransfers(player.id).length, 0);

  const playerPage = privateStore.findActive(player.id);
  assert.ok(playerPage, "accepting with no active page creates one");
  const importedWorkspace = privateStore.read(playerPage);
  assert.equal(Object.keys(importedWorkspace.notes).length, 2);
  const importedAlpha = Object.values(importedWorkspace.notes)
    .find(note => note.title === "Transfer Alpha");
  const importedBeta = Object.values(importedWorkspace.notes)
    .find(note => note.title === "Transfer Beta");
  assert.ok(importedAlpha && importedBeta);
  assert.notEqual(importedAlpha.id, alpha.note.id);
  assert.notEqual(importedBeta.id, beta.note.id);
  assert.equal(importedAlpha.blocks[0].text, "private alpha text");
  assert.equal(importedAlpha.image, "assets/stylized/cork.svg");
  assert.equal(importedAlpha.backgroundImage, "assets/stylized/paper.webp");
  assert.equal(importedAlpha.presentation.font, "hand");
  assert.equal(importedAlpha.presentation.torn, true);
  assert.equal(importedAlpha.attachment.pinStyle, "brass");
  assert.equal(importedAlpha.links.length, 1, "the external link is dropped");
  assert.equal(importedAlpha.links[0].targetId, importedBeta.id);
  assert.notEqual(importedAlpha.links[0].id, "transfer-internal");
  assert.equal(importedAlpha.links[0].createdBy, player.id);
  assert.deepEqual(importedAlpha.links[0].routeAnchors,
    [{ noteId: importedBeta.id, anchorId: "main" }]);
  const labels = Object.values(importedWorkspace.layout.labels);
  assert.equal(labels.length, 1, "only attached labels travel");
  assert.equal(labels[0].stamp, "skull");
  assert.equal(labels[0].noteId, importedAlpha.id);
  assert.ok(!labels.some(label => label.text === "free label text"));
  assert.equal(privateCardsOverlap(
    importedWorkspace.layout.cards[importedAlpha.id],
    importedWorkspace.layout.cards[importedBeta.id]
  ), false);
  assert.equal(JSON.stringify(notesStore.getStats()?.activity ?? {}), statsBefore,
    "accepted private copies never enter main-canvas statistics");

  await privateStore.remove(gmPage);
  await privateStore.remove(playerPage);
});

test("private transfer send/decline validates sender, recipient and payload", async () => {
  const gmPage = privateStore.findActive(gmUser.id) ?? await privateStore.createFor(gmUser);
  const playerPage = privateStore.findActive(player.id) ?? await privateStore.createFor(player);
  const workspace = privateStore.read(gmPage);
  const source = privateStore.makeNote({
    title: "Decline Source", style: "memo", x: 0, y: 0, cards: workspace.layout.cards
  });
  source.note.blocks = [{ blockId: "DeclineBlock01", text: "decline body" }];
  workspace.notes[source.note.id] = source.note;
  workspace.layout.cards[source.note.id] = source.card;
  await privateStore.save(gmPage, workspace, privateStore.flags(gmPage).rev ?? 0);

  await requestWrite({
    type: "sendPrivateTransfer", toUserId: player.id, noteIds: [source.note.id]
  });
  const record = privateStore.pendingTransfers(player.id)[0];
  assert.ok(record);
  const beforeNotes = Object.keys(privateStore.read(playerPage).notes).length;

  env.notifications.length = 0;
  await requestWrite({ type: "declinePrivateTransfer", transferId: record.id });
  assert.ok(env.notifications.some(([, text]) => text.includes("not addressed to you")),
    "only the named recipient may decline");
  assert.ok(privateStore.transfer(record.id));

  const ackMark = env.socketLog.length;
  await fromPlayer({ type: "declinePrivateTransfer", transferId: record.id });
  const declined = env.socketLog.slice(ackMark).map(entry => entry.message)
    .find(message => message.type === "writeApplied" && message.kind === "privateTransfer");
  assert.deepEqual(declined, {
    type: "writeApplied", forUserId: player.id, kind: "privateTransfer",
    action: "declined", count: 1
  });
  assert.equal(privateStore.transfer(record.id), null);
  assert.equal(Object.keys(privateStore.read(playerPage).notes).length, beforeNotes,
    "declining imports nothing");

  env.notifications.length = 0;
  await requestWrite({
    type: "sendPrivateTransfer", toUserId: gmUser.id, noteIds: [source.note.id]
  });
  assert.ok(env.notifications.some(([, text]) => text.includes("cannot send notes to yourself")));

  env.notifications.length = 0;
  await requestWrite({
    type: "sendPrivateTransfer", toUserId: "MissingUser00001", noteIds: [source.note.id]
  });
  assert.ok(env.notifications.some(([, text]) => text.includes("no longer exists")));

  env.notifications.length = 0;
  await requestWrite({ type: "sendPrivateTransfer", toUserId: player.id, noteIds: [] });
  assert.ok(env.notifications.some(([, text]) => text.includes("no notes to send")));

  env.notifications.length = 0;
  await requestWrite({
    type: "sendPrivateTransfer", toUserId: player.id, noteIds: ["MissingNote00001"]
  });
  assert.ok(env.notifications.some(([, text]) => text.includes("no longer available")));
  assert.equal(privateStore.pendingTransfers(player.id).length, 0);

  await privateStore.detach(playerPage);
  const rejectionMark = env.socketLog.length;
  await fromPlayer({
    type: "sendPrivateTransfer", toUserId: gmUser.id, noteIds: [source.note.id]
  });
  assert.ok(rejectionReasonsSince(rejectionMark).some(reason =>
    reason.includes("Create your private journal")),
  "a sender without an active private page is rejected");
  await privateStore.remove(playerPage);
  await privateStore.remove(gmPage);
});

test("a failed transfer save keeps the offer and accepts cleanly on retry", async () => {
  const gmPage = privateStore.findActive(gmUser.id) ?? await privateStore.createFor(gmUser);
  const playerPage = privateStore.findActive(player.id) ?? await privateStore.createFor(player);
  const workspace = privateStore.read(gmPage);
  const source = privateStore.makeNote({
    title: "Retry Source", style: "memo", x: 0, y: 0, cards: workspace.layout.cards
  });
  source.note.blocks = [{ blockId: "RetryBlock00001", text: "retry body" }];
  workspace.notes[source.note.id] = source.note;
  workspace.layout.cards[source.note.id] = source.card;
  await privateStore.save(gmPage, workspace, privateStore.flags(gmPage).rev ?? 0);

  await requestWrite({
    type: "sendPrivateTransfer", toUserId: player.id, noteIds: [source.note.id]
  });
  const record = privateStore.pendingTransfers(player.id)[0];
  assert.ok(record);
  const beforeNotes = Object.keys(privateStore.read(playerPage).notes).length;

  const originalUpdate = playerPage.update.bind(playerPage);
  playerPage.update = async () => { throw new Error("injected transfer save failure"); };
  const rejectionMark = env.socketLog.length;
  try {
    await fromPlayer({ type: "acceptPrivateTransfer", transferId: record.id });
  } finally {
    playerPage.update = originalUpdate;
  }
  assert.ok(rejectionReasonsSince(rejectionMark).some(reason =>
    reason.includes("injected transfer save failure")));
  assert.equal(privateStore.transfer(record.id)?.id, record.id,
    "a failed save never loses the pending transfer");
  assert.equal(Object.keys(privateStore.read(playerPage).notes).length, beforeNotes,
    "no partial import was saved");

  const ackMark = env.socketLog.length;
  await fromPlayer({ type: "acceptPrivateTransfer", transferId: record.id });
  const accepted = env.socketLog.slice(ackMark).map(entry => entry.message)
    .find(message => message.type === "writeApplied" && message.kind === "privateTransfer");
  assert.equal(accepted.action, "accepted");
  assert.equal(privateStore.transfer(record.id), null);
  assert.equal(Object.keys(privateStore.read(playerPage).notes).length, beforeNotes + 1);

  await privateStore.remove(gmPage);
  await privateStore.remove(playerPage);
});
