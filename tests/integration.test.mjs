/**
 * End-to-end integration over the fake Foundry data layer.
 *
 * This suite is deliberately bounded: unit suites cover every protocol/helper edge. Here we
 * exercise the seams a real session depends on — containers and socket registration, v2 creation,
 * the whole-note edit lease, preview/appearance, body saves that leave links alone, v2
 * transfer/publish, and shared/private isolation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";

const MODULE_ID = "fvtt-journalinator";
const NOTE_TYPE = `${MODULE_ID}.note`;
const SKIN = { paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 0 };

const gm = makeUser("IntegrationGM0001", { isGM: true, name: "GM" });
const player = makeUser("IntegrationPlayer1", { name: "Player" });
const env = installFoundry({ user: gm, users: [gm, player] });

const containers = await makeContainers(env);
const socket = await import("../scripts/socket.mjs");
const edit = await import("../scripts/edit-session.mjs");
const { notesStore } = await import("../scripts/store/notes-store.mjs");
const { privateStore } = await import("../scripts/store/private-store.mjs");

socket.registerSocket();
edit.startEditResync();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 1500) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) return false;
    await sleep(5);
  }
  return true;
}

function sharedNotes() {
  return [...containers.shared.pages.values()].filter(page => page.type === NOTE_TYPE);
}

async function createNote(fields = {}) {
  return socket.requestEditReply({
    type: "createNote",
    body: "",
    layout: "plain",
    skin: SKIN,
    x: 0,
    y: 0,
    ...fields
  });
}

async function begin(noteId, clientSessionId = "integration-tab") {
  return socket.requestEditReply({ type: "beginNoteEdit", noteId, clientSessionId });
}

test("containers and socket registration are live before the first user write", async () => {
  assert.deepEqual(Object.keys(containers.ids).sort(), [
    "activityPage", "history", "historyPage", "layoutPage", "private", "shared"
  ]);
  assert.equal(containers.shared.flags["fvtt-journalinator"].container, "shared");
  assert.equal(containers.private.flags["fvtt-journalinator"].container, "private");
  assert.equal(containers.ids.shared, game.settings.get(MODULE_ID, "containerIds").shared);

  // A player-originated socket write is handled by the active GM client, not by the sender.
  const before = sharedNotes().length;
  env.deliver({
    type: "createNote", body: "# From socket", layout: "plain", skin: SKIN, x: 40, y: 60
  }, player.id);
  const created = await waitFor(() =>
    sharedNotes().some(page => page.system?.body === "# From socket"));
  assert.equal(created, true);
  assert.equal(sharedNotes().length, before + 1);
  const page = sharedNotes().find(item => item.system.body === "# From socket");
  assert.equal(page.system.authorId, player.id, "the sender stays the author");
});

test("createNote writes a stable internal name and the complete v2 shape", async () => {
  const reply = await createNote({
    body: "# Integration tavern\n\nA warm room.", layout: "profile", x: 120, y: 80
  });
  assert.equal(reply.type, "noteCreated");
  const page = containers.shared.pages.get(reply.noteId);
  assert.ok(page);
  assert.equal(page.name, `jn-note-${reply.noteId}`);
  assert.notEqual(page.name, "Integration tavern", "the visible title is never the page name");
  assert.equal(page.system.schemaVersion, 2);
  assert.equal(page.system.body, "# Integration tavern\n\nA warm room.");
  assert.equal(page.system.layout, "profile");
  assert.equal(page.system.revision, 0);
  assert.equal(page.system.authorId, gm.id);
  assert.deepEqual(page.system.links, []);
  assert.equal(page.system.deleted, null);
  assert.deepEqual(page.system.attachment, {
    mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "default"
  });
  const card = notesStore.getSharedLayout().cards[reply.noteId];
  assert.equal(card.sizing.mode, "auto");
  assert.equal(card.anchors.main.kind, "main");
  assert.deepEqual(reply.links, []);
  assert.equal(reply.body, page.system.body);
});

test("begin/save/end leases and stale or forced tokens are enforced", async () => {
  const created = await createNote({ body: "# Lease\n\nStart" });
  const noteId = created.noteId;
  const page = containers.shared.pages.get(noteId);

  const granted = await begin(noteId, "lease-tab");
  assert.equal(granted.type, "noteEditGranted");
  assert.equal(granted.revision, 0);
  const lease = granted.lease;
  assert.ok(lease?.leaseToken);

  const secondTab = await begin(noteId, "other-tab");
  assert.equal(secondTab.type, "noteEditDenied");
  assert.equal(secondTab.reason, "locked");

  const saved = await socket.requestEditReply({
    type: "saveNoteBody", noteId, lease, sequence: 1, baseRevision: 0,
    body: "# Lease\n\nSaved body"
  });
  assert.equal(saved.type, "noteSaveAck");
  assert.equal(saved.revision, 1);
  assert.equal(page.system.body, "# Lease\n\nSaved body");

  const stale = await socket.requestEditReply({
    type: "saveNoteBody", noteId, lease, sequence: 2, baseRevision: 0, body: "stale"
  });
  assert.equal(stale.type, "noteSaveRejected");
  assert.equal(stale.reason, "staleRevision");
  assert.equal(page.system.body, "# Lease\n\nSaved body");

  const forced = await socket.requestEditReply({ type: "forceUnlockNote", noteId });
  assert.equal(forced.type, "noteEditForced");
  assert.equal(edit.leaseFor(noteId), null);
  const afterForce = await socket.requestEditReply({
    type: "saveNoteBody", noteId, lease, sequence: 3, baseRevision: 1, body: "after force"
  });
  assert.equal(afterForce.type, "noteSaveRejected");
  assert.equal(afterForce.reason, "leaseLost");

  const again = await begin(noteId, "lease-tab-2");
  assert.equal(again.type, "noteEditGranted");
  const ended = await socket.requestEditReply({
    type: "endNoteEdit", noteId, lease: again.lease, sequence: 1, baseRevision: 1,
    body: "# Lease\n\nEnded body"
  });
  assert.equal(ended.type, "noteEditEnded");
  assert.equal(ended.saved, true);
  assert.equal(ended.released, true);
  assert.equal(page.system.body, "# Lease\n\nEnded body");
  assert.equal(edit.leaseFor(noteId), null);
});

test("preview relays live text without writing the note", async () => {
  const created = await createNote({ body: "# Preview\n\nOriginal" });
  const noteId = created.noteId;
  const page = containers.shared.pages.get(noteId);
  const granted = await begin(noteId, "preview-tab");

  const mark = env.socketLog.length;
  await socket.requestWrite({
    type: "previewNoteBody", noteId, lease: granted.lease, sequence: 1, body: "live text"
  });
  const relayed = await waitFor(() => env.socketLog.slice(mark)
    .some(entry => entry.message.type === "notePreview"));
  assert.equal(relayed, true);
  const preview = env.socketLog.slice(mark).map(entry => entry.message)
    .find(message => message.type === "notePreview");
  assert.equal(preview.body, "live text");
  assert.equal(preview.noteId, noteId);
  assert.equal(page.system.body, "# Preview\n\nOriginal", "preview never saves");
  assert.equal(page.system.revision, 0);
  await socket.requestEditReply({ type: "endNoteEdit", noteId, lease: granted.lease });
});

test("appearance saves layout and skin without changing body, revision or links", async () => {
  const created = await createNote({ body: "# Appearance\n\nBody" });
  const noteId = created.noteId;
  const page = containers.shared.pages.get(noteId);
  await socket.requestWrite({ type: "createLink", sourceId: noteId, targetId: (await createNote({
    body: "# Appearance target"
  })).noteId });
  await waitFor(() => (page.system.links ?? []).length === 1);
  const links = structuredClone(page.system.links);
  const granted = await begin(noteId, "appearance-tab");

  const ack = await socket.requestEditReply({
    type: "saveNoteAppearance", noteId, lease: granted.lease, layout: "profile",
    skin: { paper: "parchment", font: "serif", torn: true,
      backgroundImage: "assets/stylized/cork.svg", tiltSeed: 12 }
  });
  assert.equal(ack.type, "noteAppearanceAck");
  assert.equal(page.system.layout, "profile");
  assert.equal(page.system.skin.paper, "parchment");
  assert.equal(page.system.skin.font, "serif");
  assert.equal(page.system.body, "# Appearance\n\nBody");
  assert.equal(page.system.revision, 0);
  assert.deepEqual(page.system.links, links, "appearance never rewrites relationships");
  await socket.requestEditReply({ type: "endNoteEdit", noteId, lease: granted.lease });
});

test("a body save keeps every stored link and a body-only payload does not mint notes", async () => {
  const source = await createNote({ body: "# Links\n\nSource" });
  const target = await createNote({ body: "# Links\n\nTarget" });
  const page = containers.shared.pages.get(source.noteId);
  await socket.requestWrite({
    type: "createLink", sourceId: source.noteId, targetId: target.noteId
  });
  await waitFor(() => (page.system.links ?? []).length === 1);
  const before = structuredClone(page.system.links);
  const noteCount = sharedNotes().length;
  const granted = await begin(source.noteId, "links-tab");

  const saved = await socket.requestEditReply({
    type: "saveNoteBody", noteId: source.noteId, lease: granted.lease, sequence: 1,
    baseRevision: 0, body: "# Links\n\nEdited [[not a note]]"
  });
  assert.equal(saved.type, "noteSaveAck");
  assert.equal(page.system.body, "# Links\n\nEdited [[not a note]]");
  assert.deepEqual(page.system.links, before);
  assert.equal(sharedNotes().length, noteCount,
    "wikilink-looking text never creates a note");
  await socket.requestEditReply({ type: "endNoteEdit", noteId: source.noteId, lease: granted.lease });
});

test("shared-to-private transfer and private publishing carry schema v2 data", async () => {
  const shared = await createNote({ body: "# Transfer\n\nShared body", layout: "profile", x: 90, y: 30 });
  const sharedPage = containers.shared.pages.get(shared.noteId);
  const target = await createNote({ body: "# Transfer target", x: 400, y: 30 });
  await socket.requestWrite({ type: "createLink", sourceId: shared.noteId, targetId: target.noteId });
  await waitFor(() => (sharedPage.system.links ?? []).length === 1);
  const sharedBefore = JSON.stringify(sharedPage.system);

  const privatePage = await privateStore.createFor(gm);
  env.deliver({
    type: "sendSharedToPrivate", toUserId: gm.id, noteIds: [shared.noteId]
  }, gm.id);
  const imported = await waitFor(() => Object.keys(privateStore.read(privatePage).notes).length === 1);
  assert.equal(imported, true);
  const privateWorkspace = privateStore.read(privatePage);
  const privateNote = Object.values(privateWorkspace.notes)[0];
  assert.equal(privateNote.schemaVersion, 2);
  assert.equal(privateNote.body, "# Transfer\n\nShared body");
  assert.equal(privateNote.layout, "profile");
  assert.equal(JSON.stringify(sharedPage.system), sharedBefore,
    "copying to private never mutates the shared source");
  assert.deepEqual(privateNote.links, [], "external links are dropped from the one-note transfer");

  const privateCard = privateWorkspace.layout.cards[privateNote.id];
  assert.equal(privateCard.sizing.mode, "auto");
  assert.ok(privateCard.anchors.main);

  const sharedCount = sharedNotes().length;
  env.deliver({ type: "publishPrivateNotes", noteIds: [privateNote.id] }, gm.id);
  const published = await waitFor(() => sharedNotes().length === sharedCount + 1);
  assert.equal(published, true);
  const created = sharedNotes().find(page => page.id !== shared.noteId
    && page.system.body === privateNote.body);
  assert.ok(created);
  assert.notEqual(created.id, privateNote.id, "publishing allocates a fresh shared identity");
  assert.equal(created.name, `jn-note-${created.id}`);
  assert.equal(created.system.schemaVersion, 2);
  assert.equal(created.system.body, privateNote.body);
  assert.equal(created.system.layout, privateNote.layout);
  assert.equal(privateStore.read(privatePage).notes[privateNote.id].body, privateNote.body,
    "publishing does not consume or mutate the private source");
});

test("private workspace writes never leak into shared notes, activity or history", async () => {
  const privatePage = await privateStore.createFor(player);
  const workspace = privateStore.read(privatePage);
  const made = privateStore.makeNote({
    body: "# Private only\n\nSecret-free but isolated", x: 20, y: 20,
    cards: workspace.layout.cards
  });
  workspace.notes[made.note.id] = made.note;
  workspace.layout.cards[made.note.id] = made.card;
  await privateStore.save(privatePage, workspace, privateStore.flags(privatePage).rev ?? 0);

  assert.equal(notesStore.getAllNotes().some(note => note.id === made.note.id), false);
  assert.equal(sharedNotes().some(page => page.id === made.note.id), false,
    "a private note is never a shared page");
  const sharedBefore = JSON.stringify([...containers.shared.pages.values()].map(page => page.system));
  assert.equal(privateStore.read(privatePage).notes[made.note.id].body,
    "# Private only\n\nSecret-free but isolated");
  assert.equal(JSON.stringify([...containers.shared.pages.values()].map(page => page.system)),
    sharedBefore, "private saves do not write shared containers");
  assert.equal(Object.keys(notesStore.getActivity()?.activity ?? {}).length, 0,
    "private edits never record shared activity");
  assert.deepEqual(notesStore.getHistory()?.snapshots ?? {}, {},
    "private edits never record shared history");
});
