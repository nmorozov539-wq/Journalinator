import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";
import {
  privateStore, emptyWorkspace, normalizeWorkspace, inspectWorkspace,
  WORKSPACE_FORMAT, NOTE_SCHEMA_VERSION, PrivateIncompatibleFormat
} from "../scripts/store/private-store.mjs";
import { seedForNote } from "../scripts/skins/registry.mjs";
import { getLayout } from "../scripts/layouts/registry.mjs";
import { originFromBox } from "../scripts/sizing/geometry.mjs";
import { t } from "../scripts/i18n.mjs";

const MODULE_ID = "fvtt-journalinator";
const owner = makeUser("StoreOwner000001", { name: "Owner" });
const env = installFoundry({ user: owner, users: [owner] });
const containers = await makeContainers(env);

let userSeq = 0;
function nextUser() {
  userSeq += 1;
  return makeUser(`StoreUser${String(userSeq).padStart(8, "0")}`, { name: `User ${userSeq}` });
}

async function freshPage() {
  return privateStore.createFor(nextUser());
}

function addNote(workspace, note, card) {
  workspace.notes[note.id] = note;
  workspace.layout.cards[note.id] = card;
  return workspace;
}

test("createFor writes an empty format 3 workspace with history", async () => {
  const page = await freshPage();
  const stored = JSON.parse(privateStore.flags(page).workspace);
  assert.equal(stored.format, WORKSPACE_FORMAT);
  assert.equal(WORKSPACE_FORMAT, 3);
  assert.deepEqual(stored, emptyWorkspace());
  assert.deepEqual(stored.history, {});
  assert.equal(privateStore.flags(page).rev, 0);

  const status = privateStore.inspectWorkspace(page);
  assert.equal(status.ok, true);
  assert.equal(status.rev, 0);
  assert.deepEqual(status.workspace, emptyWorkspace());
  assert.deepEqual(inspectWorkspace(page), status, "standalone inspector matches the store method");
});

test("makeNote builds the v2 shape and a sizing card with seeded tilt", () => {
  const { note, card } = privateStore.makeNote({
    body: "# A title",
    layout: "profile",
    skin: { paper: "parchment", font: "serif", torn: true },
    cards: {}
  });

  assert.equal(note.schemaVersion, NOTE_SCHEMA_VERSION);
  assert.equal(NOTE_SCHEMA_VERSION, 2);
  assert.equal(note.body, "# A title");
  assert.equal(note.revision, 0);
  assert.equal(note.layout, "profile");
  assert.equal(note.skin.paper, "parchment");
  assert.equal(note.skin.font, "serif");
  assert.equal(note.skin.torn, true);
  assert.equal(note.skin.tiltSeed, seedForNote(note.id));
  assert.equal(note.attachment.mainPinEnabled, true);
  assert.deepEqual(note.links, []);
  assert.equal(note.authorId, owner.id);
  assert.equal(note.deleted, null);
  assert.equal(note.lastSave, null);
  assert.equal(typeof note.createdAt, "number");
  assert.equal(note.createdAt, note.updatedAt);

  for (const removed of [
    "title", "kind", "style", "presentation", "targetHeading", "label", "image",
    "blocks", "contributions", "editCount", "hint", "formerNames", "actorRef"
  ]) {
    assert.equal(Object.hasOwn(note, removed), false, `note must not carry ${removed}`);
  }

  assert.deepEqual(card.sizing, { mode: "auto", width: null, minHeight: null });
  assert.equal(Number.isFinite(card.autoSizeOrigin.x), true);
  assert.equal(Number.isFinite(card.autoSizeOrigin.y), true);
  const initialBox = {
    x: card.x, y: card.y, w: getLayout(note.layout).widths[0],
    h: getLayout(note.layout).minHeight, rotation: card.rotation
  };
  assert.deepEqual(card.autoSizeOrigin, originFromBox(initialBox, card.rotation));
  assert.equal(Number.isFinite(card.rotation), true);
  assert.equal(Object.hasOwn(card, "width"), false);
  assert.equal(Object.hasOwn(card, "height"), false);
  assert.equal(Object.hasOwn(card, "style"), false);

  const blank = privateStore.makeNote({ body: "", cards: {} });
  assert.equal(blank.note.skin.paper, "amber");
  assert.equal(blank.note.skin.font, "handwritten");
  const document = privateStore.makeNote({ body: "# A document", cards: {} });
  assert.equal(document.note.skin.paper, "cream");
  assert.equal(document.note.skin.font, "default");
  const profile = privateStore.makeNote({ body: "", layout: "profile", cards: {} });
  assert.equal(profile.note.skin.paper, "parchment");
  assert.equal(profile.note.skin.font, "serif");
  assert.equal(blank.note.skin.tiltSeed, seedForNote(blank.note.id));
});

test("body, layout and skin round-trip through save and read", async () => {
  const page = await freshPage();
  const workspace = privateStore.read(page);
  const { note, card } = privateStore.makeNote({
    body: "# Field notes\n\nText",
    layout: "profile",
    skin: { paper: "cream", font: "serif", torn: false, backgroundImage: "worlds/bg.webp" },
    cards: {}
  });
  addNote(workspace, note, card);

  const saved = await privateStore.save(page, workspace, 0);
  assert.equal(saved.rev, 1);
  const read = privateStore.read(page);
  assert.equal(read.format, 3);
  assert.equal(read.notes[note.id].body, "# Field notes\n\nText");
  assert.equal(read.notes[note.id].layout, "profile");
  assert.equal(read.notes[note.id].skin.paper, "cream");
  assert.equal(read.notes[note.id].skin.backgroundImage, "worlds/bg.webp");
  assert.equal(read.notes[note.id].schemaVersion, 2);
  assert.deepEqual(read.layout.cards[note.id].sizing, { mode: "auto", width: null, minHeight: null });
  assert.deepEqual(normalizeWorkspace(read), read);
});

test("noteView derives localized titles and exposes only v2 fields", async () => {
  const page = await freshPage();
  const workspace = privateStore.read(page);

  const titled = privateStore.makeNote({ body: "# Visible title\n\nBody" });
  const untitled = privateStore.makeNote({ body: "Just body text" });
  const empty = privateStore.makeNote({ body: "" });
  const image = privateStore.makeNote({ body: "![alt](worlds/pic.webp)" });
  for (const entry of [titled, untitled, empty, image]) {
    addNote(workspace, entry.note, entry.card);
  }
  await privateStore.save(page, workspace, 0);
  const read = privateStore.read(page);

  assert.equal(privateStore.noteView(page, read.notes[titled.note.id]).name, "Visible title");
  assert.equal(privateStore.noteView(page, read.notes[untitled.note.id]).name, "Just body text");
  assert.equal(privateStore.noteView(page, read.notes[empty.note.id]).name, t("JN.Search.EmptyNote"));
  assert.equal(privateStore.noteView(page, read.notes[image.note.id]).name, t("JN.Search.ImageNote"));

  const view = privateStore.noteView(page, read.notes[titled.note.id]);
  assert.equal(view.system.schemaVersion, 2);
  assert.equal(view.system.body, "# Visible title\n\nBody");
  assert.equal(view.system.revision, 0);
  assert.equal(view.system.layout, "plain");
  assert.equal(view.system.attachment.mainPinEnabled, true);
  assert.deepEqual(view.system.links, []);
  assert.equal(view.system.deleted, null);
  for (const removed of ["title", "kind", "style", "secret", "label", "presentation",
    "blocks", "image", "backgroundImage", "contributions", "hint", "formerNames", "editCount"]) {
    assert.equal(Object.hasOwn(view.system, removed), false, `view must not expose ${removed}`);
  }
  assert.equal(privateStore.noteViews(page, read).length, 4);
});

test("legacy format 1/2 and corrupt current data are non-destructively rejected", async () => {
  const page = await freshPage();

  for (const [label, value, reason] of [
    ["format 1", { format: 1, notes: { old: { title: "Old", blocks: [{ text: "x" }] } } }, "legacy-format"],
    ["format 2", { format: 2, notes: { old: { schemaVersion: 1, title: "Old", blocks: [{ text: "x" }] } } }, "legacy-format"],
    ["format 3 with v1 note", {
      format: 3,
      notes: { old: { id: "old", schemaVersion: 1, title: "Old", blocks: [{ text: "x" }] } },
      layout: { cards: {}, labels: {}, pins: {}, pinLinks: {}, viewport: null },
      trash: [],
      history: {}
    }, "invalid-workspace"]
  ]) {
    const raw = JSON.stringify(value);
    await page.update({
      [`flags.${MODULE_ID}.private.workspace`]: raw,
      [`flags.${MODULE_ID}.private.rev`]: 4
    });
    const before = privateStore.flags(page).workspace;
    const beforeRev = privateStore.flags(page).rev;

    const status = privateStore.inspectWorkspace(page);
    assert.equal(status.ok, false, label);
    assert.equal(status.reason, reason, label);
    assert.equal(status.workspace, null, label);
    assert.equal(status.rev, 4, label);

    assert.throws(() => privateStore.read(page), error => {
      assert.ok(error instanceof PrivateIncompatibleFormat, label);
      assert.equal(error.name, "JN.Private.IncompatibleFormat", label);
      assert.equal(error.code, reason, label);
      return true;
    }, label);

    const legacy = reason === "legacy-format" ? value : { ...value };
    await assert.rejects(privateStore.save(page, legacy, 4), error => {
      assert.equal(error.name, "JN.Private.IncompatibleFormat", label);
      return true;
    }, label);
    assert.equal(privateStore.flags(page).workspace, before, `${label} must not be rewritten`);
    assert.equal(privateStore.flags(page).rev, beforeRev, `${label} must not advance rev`);
  }
});

test("system.workspace is only a legacy inspection fallback and is never written", async () => {
  const user = nextUser();
  const raw = JSON.stringify({ format: 2, notes: { old: { title: "Old", blocks: [{ text: "x" }] } } });
  const page = await JournalEntryPage.create({
    name: "Legacy private",
    type: "text",
    system: { workspace: raw },
    flags: {
      [MODULE_ID]: {
        private: { ownerUserId: user.id, state: "active", rev: 3 }
      }
    }
  }, { parent: containers.private });

  const status = privateStore.inspectWorkspace(page);
  assert.equal(status.ok, false);
  assert.equal(status.reason, "legacy-format");
  assert.equal(status.format, 2);
  assert.equal(status.rev, 3);
  assert.equal(status.workspace, null);

  assert.throws(() => privateStore.read(page), /JN\.Private\.IncompatibleFormat/);
  await assert.rejects(privateStore.save(page, { format: 2, notes: {} }, 3), /JN\.Private\.IncompatibleFormat/);
  assert.equal(page.system.workspace, raw, "legacy system storage is never rewritten");
  assert.equal(privateStore.flags(page).workspace, undefined);
});

test("save enforces workspace CAS and rejects mismatched revisions", async () => {
  const page = await freshPage();
  const workspace = privateStore.read(page);
  const { note, card } = privateStore.makeNote({ body: "hello" });
  addNote(workspace, note, card);

  await privateStore.save(page, workspace, 0);
  const stale = privateStore.read(page);
  await assert.rejects(privateStore.save(page, stale, 0), /changed in another tab|another session/i);
  assert.equal(privateStore.flags(page).rev, 1, "the stale write must not advance rev");
  assert.equal(privateStore.flags(page).rev, 1);
  assert.ok(privateStore.read(page).notes[note.id]);
});

test("history ring keeps 20 distinct snapshots with newest-first order", async () => {
  const page = await freshPage();
  const workspace = privateStore.read(page);
  const { note, card } = privateStore.makeNote({ body: "v0" });
  addNote(workspace, note, card);
  let { rev } = await privateStore.save(page, workspace, 0);

  for (let index = 0; index < 25; index += 1) {
    const result = await privateStore.recordHistory(page, note.id, {
      body: `version ${index}`,
      revision: index,
      authorId: owner.id,
      at: 10_000 + index
    }, { expectedRev: rev });
    rev = result.rev;
  }

  const list = privateStore.listHistory(page, note.id);
  assert.equal(list.length, 20);
  assert.equal(list[0].body, "version 24");
  assert.equal(list.at(-1).body, "version 5");
  assert.equal(new Set(list.map(entry => entry.body)).size, 20);
  for (const entry of list) {
    assert.deepEqual(Object.keys(entry).sort(), ["at", "authorId", "body", "id", "revision"]);
  }
});

test("periodic history honors the 60-second cooldown; pre-restore is mandatory", async () => {
  const page = await freshPage();
  const workspace = privateStore.read(page);
  const { note, card } = privateStore.makeNote({ body: "base" });
  addNote(workspace, note, card);
  let { rev } = await privateStore.save(page, workspace, 0);

  const base = await privateStore.recordHistory(page, note.id, {
    body: "base", revision: 1, authorId: owner.id, at: 0
  }, { expectedRev: rev });
  rev = base.rev;
  assert.equal(base.recorded, true);

  const early = await privateStore.checkpointHistoryIfDue(page, note.id, {
    body: "next", revision: 2, authorId: owner.id, at: 30_000
  }, { expectedRev: rev, now: 30_000 });
  assert.equal(early.recorded, false, "inside the cooldown");
  assert.equal(early.rev, rev);

  const due = await privateStore.checkpointHistoryIfDue(page, note.id, {
    body: "next", revision: 2, authorId: owner.id, at: 60_000
  }, { expectedRev: rev, now: 60_000 });
  assert.equal(due.recorded, true);
  rev = due.rev;
  assert.deepEqual(privateStore.listHistory(page, note.id).map(entry => entry.body), ["next", "base"]);

  const same = await privateStore.checkpointHistoryIfDue(page, note.id, {
    body: "next", revision: 3, authorId: owner.id, at: 200_000
  }, { expectedRev: rev, now: 200_000 });
  assert.equal(same.recorded, false, "unchanged newest body is a no-op");

  const restore = await privateStore.recordPreRestore(page, note.id, {
    body: "current before restore", revision: 4, authorId: owner.id, at: 61_000
  }, { expectedRev: rev });
  assert.equal(restore.recorded, true, "pre-restore ignores the cooldown");
  rev = restore.rev;
  assert.equal(privateStore.listHistory(page, note.id)[0].body, "current before restore");
});

test("trash retains history and restores v2 content; permanent deletion removes history", async () => {
  const page = await freshPage();
  const workspace = privateStore.read(page);
  const first = privateStore.makeNote({
    body: "# Keep me", layout: "profile", skin: { paper: "cream", font: "serif" }
  });
  const second = privateStore.makeNote({ body: "other" });
  addNote(workspace, first.note, first.card);
  addNote(workspace, second.note, second.card);
  let { rev } = await privateStore.save(page, workspace, 0);

  for (const entry of [first, second]) {
    const result = await privateStore.recordHistory(page, entry.note.id, {
      body: entry.note.body, revision: 0, authorId: owner.id, at: 100
    }, { expectedRev: rev });
    rev = result.rev;
  }

  const withTrash = privateStore.read(page);
  const trashNote = withTrash.notes[first.note.id];
  withTrash.trash.unshift({
    note: trashNote,
    card: withTrash.layout.cards[first.note.id],
    deletedAt: 500,
    undoId: "undo-1"
  });
  delete withTrash.notes[first.note.id];
  delete withTrash.layout.cards[first.note.id];
  const saved = await privateStore.save(page, withTrash, rev);
  rev = saved.rev;

  const trashed = privateStore.read(page);
  assert.equal(trashed.trash.length, 1);
  assert.equal(trashed.trash[0].note.body, "# Keep me");
  assert.equal(trashed.trash[0].note.layout, "profile");
  assert.equal(trashed.trash[0].note.skin.paper, "cream");
  assert.equal(trashed.trash[0].undoId, "undo-1");
  assert.equal(privateStore.listHistory(page, first.note.id).length, 1,
    "trash must retain history");

  const removed = await privateStore.deleteHistory(page, first.note.id, { expectedRev: rev });
  assert.equal(removed.removed, 1);
  assert.deepEqual(privateStore.listHistory(page, first.note.id), []);
  assert.equal(privateStore.listHistory(page, second.note.id).length, 1,
    "other notes keep their history");
});

test("findFreeSpot and makeNote use v2 sizing, not legacy card width/height", async () => {
  const occupied = {
    existing: {
      x: 0,
      y: 0,
      sizing: { mode: "manual", width: 300, minHeight: 200 },
      rotation: 0
    }
  };
  const spot = privateStore.findFreeSpot(occupied, 300, 200, 0, 0, 0);
  assert.notDeepEqual({ x: spot.x, y: spot.y }, { x: 0, y: 0 });

  const auto = privateStore.makeNote({ body: "auto", layout: "plain", cards: occupied });
  assert.deepEqual(auto.card.sizing, { mode: "auto", width: null, minHeight: null });
  assert.notDeepEqual({ x: auto.card.x, y: auto.card.y }, { x: 0, y: 0 });

  const manual = privateStore.findFreeSpot({}, 300, 200, 40, 50, 0);
  assert.deepEqual(manual, { x: 40, y: 50 });
});

test("legacy transfer payloads are rejected instead of storing old blocks", async () => {
  const sender = makeUser("LegacySender0001", { name: "Sender" });
  const record = {
    id: "LegacyTransfer001",
    fromUserId: sender.id,
    toUserId: owner.id,
    createdAt: Date.now(),
    notes: [{
      note: {
        id: "LegacyNote000001",
        title: "Old note",
        schemaVersion: 2,
        blocks: [{ blockId: "block-1", text: "old block text" }],
        links: []
      },
      card: null,
      labels: {},
      pins: {}
    }],
    pinLinks: {},
    summary: { count: 1, titles: ["Old note"], droppedLinks: 0, droppedWaypoints: 0 }
  };
  await privateStore.addTransfer(record);
  try {
    await assert.rejects(
      privateStore.acceptTransfer(record.id, owner.id),
      error => {
        assert.equal(error.name, "JN.Private.IncompatibleFormat");
        return true;
      }
    );
    const page = privateStore.findActive(owner.id);
    assert.ok(page, "the recipient page exists");
    assert.deepEqual(privateStore.read(page).notes, {},
      "old note blocks must never be stored as v2 notes");
    assert.ok(privateStore.transfer(record.id), "the offer is kept for the T11 payload rewrite");
  } finally {
    await privateStore.removeTransfer(record.id);
  }
});

test("private store never writes shared history or activity", async () => {
  assert.deepEqual(containers.history.pages.get(containers.ids.historyPage)?.system?.snapshots ?? {}, {});
  assert.deepEqual(containers.shared.pages.get(containers.ids.activityPage)?.system?.activity ?? {}, {});
  assert.equal(env.socketLog.length, 0);

  const page = await freshPage();
  const workspace = privateStore.read(page);
  const { note, card } = privateStore.makeNote({ body: "private only" });
  addNote(workspace, note, card);
  const { rev } = await privateStore.save(page, workspace, 0);
  await privateStore.recordHistory(page, note.id, {
    body: "private only", revision: 0, authorId: owner.id, at: 1
  }, { expectedRev: rev });

  const historyPage = containers.history.pages.get(containers.ids.historyPage);
  assert.deepEqual(historyPage?.system?.snapshots ?? {}, {});
  const activityPage = containers.shared.pages.get(containers.ids.activityPage);
  assert.deepEqual(activityPage?.system?.activity ?? {}, {});
  assert.equal(env.socketLog.length, 0);
});
