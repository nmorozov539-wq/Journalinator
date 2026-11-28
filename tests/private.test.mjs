import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";

const gm = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const first = makeUser("Player000000001", { name: "First" });
const second = makeUser("Player000000002", { name: "Second" });
const third = makeUser("Player000000003", { name: "Third" });
const env = installFoundry({ user: gm, users: [gm, first, second, third] });
const containers = await makeContainers(env);
const {
  privateStore, emptyWorkspace, inspectWorkspace, normalizeWorkspace,
  WORKSPACE_FORMAT, NOTE_SCHEMA_VERSION, PrivateIncompatibleFormat
} = await import("../scripts/store/private-store.mjs");
const { buildPrivateTransfer } = await import("../scripts/private-transfer.mjs");
const { t } = await import("../scripts/i18n.mjs");
const { getLayout } = await import("../scripts/layouts/registry.mjs");
const { originFromBox } = await import("../scripts/sizing/geometry.mjs");

let sequence = 0;
const extraUsers = new Map();
const baseGetUser = game.users.get;
// The fake Foundry user directory is deliberately small. Register test users for the few store
// paths that resolve a recipient through game.users.get without changing production behaviour.
game.users.get = id => extraUsers.get(id) ?? baseGetUser(id);
function freshUser(label = "User") {
  sequence += 1;
  const user = makeUser(`PrivateUser${String(sequence).padStart(8, "0")}`, { name: `${label} ${sequence}` });
  extraUsers.set(user.id, user);
  return user;
}

async function freshPage(user = freshUser()) {
  return privateStore.createFor(user);
}

function addNote(workspace, body, { layout = "plain", x = 0, y = 0 } = {}) {
  const { note, card } = privateStore.makeNote({
    body, layout, x, y, cards: workspace.layout.cards, notes: workspace.notes
  });
  workspace.notes[note.id] = note;
  workspace.layout.cards[note.id] = card;
  return { note, card };
}

test("creates one active owned workspace per profile", async () => {
  const user = freshUser("Owner");
  const page = await privateStore.createFor(user);
  assert.equal(page.type, "text");
  assert.equal(privateStore.findActive(user.id)?.id, page.id);
  assert.equal(privateStore.flags(page).state, "active");
  assert.equal(privateStore.flags(page).ownerUserId, user.id);
  assert.equal(page.ownership[user.id], CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
  assert.deepEqual(privateStore.read(page), emptyWorkspace());
  assert.equal(privateStore.flags(page).rev, 0);
  assert.equal((await privateStore.createFor(user)).id, page.id, "no duplicate workspace");
});

test("workspace names are unique and assign/accept preserves the owner permission path", async () => {
  const owner = freshUser("Owner");
  const recipient = freshUser("Recipient");
  const page = await privateStore.createFor(owner);
  await privateStore.rename(page, "Field notes");
  assert.equal(page.name, "Field notes");
  await assert.rejects(privateStore.rename(page, ""), /empty/);

  const other = await privateStore.createFor(recipient);
  await assert.rejects(privateStore.rename(other, "field notes"), /already/);
  await privateStore.detach(page);
  assert.equal(privateStore.findActive(owner.id), null);

  const next = freshUser("Next");
  await privateStore.assign(page, next.id);
  assert.equal(privateStore.findPending(next.id)?.id, page.id);
  await privateStore.accept(page, next.id);
  assert.equal(privateStore.findActive(next.id)?.id, page.id);
  assert.equal(page.ownership[next.id], CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
});

test("a removed owner's workspace is kept and becomes orphaned", async () => {
  const user = freshUser("Orphan");
  const page = await privateStore.createFor(user);
  assert.equal(await privateStore.orphanUser(user.id), 1);
  assert.equal(privateStore.flags(page).state, "orphaned");
  assert.equal(privateStore.flags(page).ownerUserId, null);
  assert.ok(privateStore.findById(page.id), "workspace data is not deleted");
});

test("save is a workspace rev CAS and never invents or migrates notes", async () => {
  const page = await freshPage();
  const workspace = privateStore.read(page);
  const { note } = addNote(workspace, "# Field\n\nText");
  const saved = await privateStore.save(page, workspace, 0);
  assert.equal(saved.rev, 1);
  assert.equal(privateStore.read(page).notes[note.id].body, "# Field\n\nText");
  await assert.rejects(privateStore.save(page, workspace, 0), /another session/);
});

test("older private formats are rejected without writing or showing empty v2 notes", async () => {
  const page = await freshPage();
  const legacy = {
    format: 2,
    notes: {
      old: {
        id: "old", schemaVersion: 1, title: "Old",
        blocks: [{ blockId: "b", text: "legacy body" }]
      }
    },
    layout: { cards: { old: { x: 0, y: 0, width: 200, height: 90 } }, labels: {}, viewport: null },
    trash: []
  };
  const raw = JSON.stringify(legacy);
  privateStore.flags(page).workspace = raw;
  const storedBefore = privateStore.flags(page).workspace;

  const status = inspectWorkspace(page);
  assert.equal(status.ok, false);
  assert.equal(status.reason, "legacy-format");
  assert.equal(status.workspace, null);
  assert.throws(() => privateStore.read(page), PrivateIncompatibleFormat);
  assert.throws(() => normalizeWorkspace(legacy), PrivateIncompatibleFormat);
  assert.equal(privateStore.flags(page).workspace, storedBefore, "inspection never rewrites old data");
  assert.equal(privateStore.flags(page).rev, 0);
});

test("makeNote builds the v2 note/view and a rotated auto-size origin", () => {
  const { note, card } = privateStore.makeNote({
    body: "# A title", layout: "profile", x: 40, y: 50, cards: {}
  });
  assert.equal(note.schemaVersion, NOTE_SCHEMA_VERSION);
  assert.equal(note.layout, "profile");
  assert.equal(note.body, "# A title");
  assert.equal(note.revision, 0);
  for (const removed of [
    "title", "kind", "style", "presentation", "targetHeading", "label", "image",
    "blocks", "contributions", "editCount", "hint", "formerNames", "actorRef"
  ]) {
    assert.equal(Object.hasOwn(note, removed), false, `note must not carry ${removed}`);
  }
  assert.deepEqual(card.sizing, { mode: "auto", width: null, minHeight: null });
  const definition = getLayout("profile");
  const box = {
    x: card.x, y: card.y, w: definition.widths[0], h: definition.minHeight,
    rotation: card.rotation
  };
  assert.deepEqual(card.autoSizeOrigin, originFromBox(box, card.rotation),
    "tilted cards seed the rotated main-pin origin, not origin.y === card.y");
  assert.equal(card.x, 40);
  assert.equal(card.y, 50);

  const page = privateStore.findActive(first.id) ?? null;
  const view = privateStore.noteView(page, note);
  assert.equal(view.name, "A title");
  assert.equal(view.system.body, "# A title");
  assert.equal(view.system.schemaVersion, 2);
  for (const removed of ["title", "kind", "style", "secret", "label", "presentation", "blocks"]) {
    assert.equal(Object.hasOwn(view.system, removed), false);
  }
});

test("derived labels use the v2 body and never an internal page name", async () => {
  const page = await freshPage();
  const workspace = privateStore.read(page);
  const titled = addNote(workspace, "# Visible title\n\nBody").note;
  const plain = addNote(workspace, "Just the body").note;
  const empty = addNote(workspace, "").note;
  const image = addNote(workspace, "![alt](worlds/pic.webp)").note;
  await privateStore.save(page, workspace, 0);
  const read = privateStore.read(page);
  assert.equal(privateStore.noteView(page, read.notes[titled.id]).name, "Visible title");
  assert.equal(privateStore.noteView(page, read.notes[plain.id]).name, "Just the body");
  assert.equal(privateStore.noteView(page, read.notes[empty.id]).name, t("JN.Search.EmptyNote"));
  assert.equal(privateStore.noteView(page, read.notes[image.id]).name, t("JN.Search.ImageNote"));
});

test("v2 links, anchors, pins and sizing survive a workspace roundtrip", async () => {
  const page = await freshPage();
  const workspace = privateStore.read(page);
  const { note, card } = addNote(workspace, "# Roundtrip\n\nBody");
  const target = addNote(workspace, "# Target", { x: 400, y: 0 }).note;
  note.links = [{
    id: "link", targetId: target.id, label: "thread", direction: "one",
    color: "link1", lineStyle: "dashed", sourceAnchorId: "main",
    sourcePinRef: "", targetPinRef: "", routeAnchors: [{ noteId: target.id, anchorId: "main" }],
    material: "double", thickness: 3, slack: 0.1, pattern: "alternating",
    ends: "loose", secondaryColor: "link2",
    sourceSide: "right", targetSide: "left",
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
  }];
  card.anchors.minor = { kind: "minor", x: 0.2, y: 0.3, createdBy: gm.id };
  card.sizing = { mode: "manual", width: 320, minHeight: 240 };
  card.autoSizeOrigin = { x: 100, y: 0 };
  workspace.layout.pins.free = { noteId: "", x: 700, y: 300, isDefault: false };
  workspace.layout.pinLinks.plink = { source: `n:${note.id}:main`, target: "p:free" };
  await privateStore.save(page, workspace, 0);

  const read = privateStore.read(page);
  const link = read.notes[note.id].links[0];
  assert.equal(link.targetId, target.id);
  assert.equal(link.material, "double");
  assert.deepEqual(link.routeAnchors, [{ noteId: target.id, anchorId: "main" }]);
  assert.deepEqual(read.layout.cards[note.id].sizing, { mode: "manual", width: 320, minHeight: 240 });
  assert.deepEqual(read.layout.cards[note.id].anchors.minor,
    { kind: "minor", x: 0.2, y: 0.3, createdBy: gm.id });
  assert.deepEqual(read.layout.pins.free, { noteId: "", x: 700, y: 300, isDefault: false });
  assert.ok(read.layout.pinLinks.plink);
  assert.deepEqual(normalizeWorkspace(read), read, "normalization is idempotent");
});

test("private transfer inbox stores v2 copies and acceptance never touches shared stores", async () => {
  const sender = freshUser("Sender");
  const recipient = freshUser("Recipient");
  const senderPage = await privateStore.createFor(sender);
  const workspace = privateStore.read(senderPage);
  const { note } = addNote(workspace, "# Copy me\n\nSource body");
  await privateStore.save(senderPage, workspace, 0);

  const transfer = buildPrivateTransfer(privateStore.read(senderPage), [note.id], {
    fromUserId: sender.id, toUserId: recipient.id
  });
  assert.equal(transfer.transferVersion, 2);
  transfer.id = foundry.utils.randomID();
  await privateStore.addTransfer(transfer);
  assert.equal(privateStore.pendingTransfers(recipient.id).length, 1);

  const accepted = await privateStore.acceptTransfer(transfer.id, recipient.id);
  assert.equal(accepted.count, 1);
  const recipientPage = privateStore.findActive(recipient.id);
  assert.ok(recipientPage);
  const recipientWorkspace = privateStore.read(recipientPage);
  const copied = Object.values(recipientWorkspace.notes)[0];
  assert.notEqual(copied.id, note.id, "copy gets a fresh id");
  assert.equal(copied.body, "# Copy me\n\nSource body");
  assert.equal(copied.revision, 0);
  assert.equal(privateStore.read(senderPage).notes[note.id].body, "# Copy me\n\nSource body",
    "the source note remains");
  assert.equal(privateStore.transfer(transfer.id), null);
  assert.equal(privateStore.acceptedTransfers(recipientPage).includes(transfer.id), true);

  const historyPage = containers.history.pages.get(containers.ids.historyPage);
  const activityPage = containers.shared.pages.get(containers.ids.activityPage);
  assert.deepEqual(historyPage.system.snapshots, {});
  assert.deepEqual(activityPage.system.activity, {});
});

test("pending transfers expire, enforce the per-sender cap and are pruned with a removed user", async () => {
  const sender = freshUser("Bulk sender");
  const recipient = freshUser("Bulk recipient");
  const senderPage = await privateStore.createFor(sender);
  const workspace = privateStore.read(senderPage);
  const { note } = addNote(workspace, "# Bulk");
  await privateStore.save(senderPage, workspace, 0);

  const base = buildPrivateTransfer(privateStore.read(senderPage), [note.id], {
    fromUserId: sender.id, toUserId: recipient.id
  });
  for (let index = 0; index < 5; index += 1) {
    await privateStore.addTransfer({ ...foundry.utils.deepClone(base), id: `bulk-${index}`,
      createdAt: Date.now() + index });
  }
  await assert.rejects(
    privateStore.addTransfer({ ...foundry.utils.deepClone(base), id: "bulk-over" }),
    /too many|full/i
  );

  await privateStore.pruneTransfersForUser(sender.id);
  assert.equal(privateStore.pendingTransfers(recipient.id).length, 0);
});

test("private store never writes shared history, activity or a shared note page", async () => {
  const before = {
    history: structuredClone(containers.history.pages.get(containers.ids.historyPage).system),
    activity: structuredClone(containers.shared.pages.get(containers.ids.activityPage).system),
    sharedPages: containers.shared.pages.size
  };
  const page = await freshPage();
  const workspace = privateStore.read(page);
  addNote(workspace, "# Private only");
  await privateStore.save(page, workspace, 0);
  assert.deepEqual(containers.history.pages.get(containers.ids.historyPage).system, before.history);
  assert.deepEqual(containers.shared.pages.get(containers.ids.activityPage).system, before.activity);
  assert.equal(containers.shared.pages.size, before.sharedPages);
});
