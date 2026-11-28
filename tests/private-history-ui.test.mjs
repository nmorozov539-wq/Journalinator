import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import showdown from "showdown";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost/" });
for (const key of [
  "document", "window", "Node", "HTMLElement", "Event", "KeyboardEvent",
  "MouseEvent", "InputEvent", "Range", "NodeFilter", "getSelection"
]) {
  if (dom.window[key]) globalThis[key] = dom.window[key];
}
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.showdown = showdown;

const { installFoundry, makeContainers, makeUser } = await import("./fake-foundry.mjs");
const owner = makeUser("HistoryOwner00001", { name: "Owner" });
const env = installFoundry({ user: owner, users: [owner] });
const containers = await makeContainers(env);
foundry.utils.cleanHTML = html => html;
const STRINGS = {
  "JN.History.Title": "Note history",
  "JN.History.Current": "Current version",
  "JN.History.Empty": "No earlier versions yet.",
  "JN.History.Restore": "Restore this version",
  "JN.History.ConfirmRestore": "Restore",
  "JN.History.Restored": "Version restored",
  "JN.History.Confirm": "Replace this note’s text with the selected version? The current text will remain in history.",
  "JN.History.Version": "Version",
  "JN.History.SelectVersion": "Select a version.",
  "JN.History.CurrentReason": "This is the current version.",
  "JN.History.Locked": "This note is being edited.",
  "JN.History.RestoreFailed": "Could not restore this version.",
  "JN.History.By": "by {name}",
  "JN.Common.Close": "Close",
  "JN.Common.Cancel": "Cancel",
  "JN.Search.EmptyNote": "Empty note",
  "JN.Search.ImageNote": "Image note"
};
const localize = game.i18n.localize;
game.i18n.localize = (key, data) => {
  const value = STRINGS[key] ?? localize(key, data);
  return data ? String(value).replace(/\{(\w+)\}/g, (_, name) => String(data[name] ?? "")) : value;
};
foundry.applications = {
  api: {
    DialogV2: {
      confirm: async () => true,
      prompt: async () => null,
      wait: async () => null
    }
  }
};

const { privateStore } = await import("../scripts/store/private-store.mjs");
const { default: PrivateWorkspace } = await import("../scripts/app/private-workspace.mjs");

let sequence = 0;
const users = new Map([[owner.id, owner]]);
const baseGet = game.users.get;
game.users.get = id => users.get(id) ?? baseGet(id);
function freshUser() {
  sequence += 1;
  const user = makeUser(`HistoryUser${String(sequence).padStart(8, "0")}`, { name: `Owner ${sequence}` });
  users.set(user.id, user);
  return user;
}

async function seedWorkspace({ body = "# Current\n\nNow", snapshots = [] } = {}) {
  const user = freshUser();
  const page = await privateStore.createFor(user);
  const workspace = privateStore.read(page);
  const { note, card } = privateStore.makeNote({ body, x: 20, y: 20, cards: {} });
  workspace.notes[note.id] = note;
  workspace.layout.cards[note.id] = card;
  if (snapshots.length) workspace.history[note.id] = snapshots;
  await privateStore.save(page, workspace, privateStore.flags(page).rev);
  return { user, page, noteId: note.id };
}

function snapshot(body, revision = 0, at = Date.now() - 60_000) {
  return {
    id: foundry.utils.randomID(),
    at,
    authorId: owner.id,
    revision,
    body
  };
}

async function waitFor(check, timeout = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test("More→History lists current first and workspace snapshots newest first", async () => {
  const older = snapshot("# Older\n\nOld", 0, Date.now() - 120_000);
  const newer = snapshot("# Newer\n\nNew", 1, Date.now() - 60_000);
  const { page, noteId } = await seedWorkspace({
    body: "# Current\n\nNow",
    snapshots: [newer, older]
  });
  const workspace = new PrivateWorkspace({});
  workspace.setPage(page);
  const dialog = workspace.openHistory(noteId);
  try {
    const entries = dialog.entries;
    assert.equal(entries.length, 3);
    assert.equal(entries[0].current, true);
    assert.equal(entries[0].body, "# Current\n\nNow");
    assert.deepEqual(entries.slice(1).map(entry => entry.body), [
      "# Newer\n\nNew", "# Older\n\nOld"
    ]);
    assert.equal(dialog.dialog.textContent.includes("Note history"), true);
    assert.equal(dialog.dialog.querySelector(".jn-history-restore").disabled, true,
      "the current version cannot be restored over itself");
    dialog.select(1);
    assert.equal(dialog.dialog.querySelector(".jn-history-restore").disabled, false);
  } finally {
    dialog.close();
    workspace.destroy();
  }
});

test("restore is text-only, revisioned, workspace-CAS protected and checkpoints the old current body", async () => {
  const oldSnapshot = snapshot("# Earlier\n\nOld text", 0);
  const { user, page, noteId } = await seedWorkspace({
    body: "# Current\n\nCurrent text",
    snapshots: [oldSnapshot]
  });
  const beforeRevision = privateStore.read(page).notes[noteId].revision;
  const sharedHistory = structuredClone(containers.history.pages.get(containers.ids.historyPage).system);
  const workspace = new PrivateWorkspace({});
  workspace.setPage(page);
  const dialog = workspace.openHistory(noteId);
  try {
    dialog.select(1);
    dialog.dialog.querySelector(".jn-history-restore").click();
    dialog.dialog.querySelector(".jn-history-confirm-restore").click();
    const restored = await waitFor(() => {
      const read = privateStore.read(privateStore.findActive(user.id));
      return read.notes[noteId].body === "# Earlier\n\nOld text";
    });
    assert.equal(restored, true);
    const read = privateStore.read(privateStore.findActive(user.id));
    assert.equal(read.notes[noteId].revision, beforeRevision + 1);
    assert.equal(read.notes[noteId].layout, "plain", "layout is not restored from history");
    assert.ok(read.history[noteId].some(entry => entry.body === "# Current\n\nCurrent text"),
      "pre-restore current text is kept in private history");
    assert.deepEqual(containers.history.pages.get(containers.ids.historyPage).system, sharedHistory,
      "no shared history is written");
    assert.equal(env.socketLog.length, 0);
  } finally {
    dialog.close();
    workspace.destroy();
  }
});

test("a concurrent workspace change rejects restore instead of overwriting it", async () => {
  const { user, page, noteId } = await seedWorkspace({
    body: "# Current\n\nNow",
    snapshots: [snapshot("# Earlier\n\nOld", 0)]
  });
  const workspace = new PrivateWorkspace({});
  workspace.setPage(page);
  const dialog = workspace.openHistory(noteId);
  const save = privateStore.save.bind(privateStore);
  let injected = false;
  privateStore.save = async (target, data, rev) => {
    if (!injected) {
      injected = true;
      const external = privateStore.read(target);
      external.notes[noteId].body = "# Concurrent\n\nOther tab";
      external.notes[noteId].revision += 1;
      external.notes[noteId].updatedAt = Date.now();
      await save(target, external, rev);
    }
    return save(target, data, rev);
  };
  try {
    dialog.select(1);
    dialog.dialog.querySelector(".jn-history-restore").click();
    dialog.dialog.querySelector(".jn-history-confirm-restore").click();
    await waitFor(() => injected);
    await new Promise(resolve => setTimeout(resolve, 80));
    const read = privateStore.read(privateStore.findActive(user.id));
    assert.equal(read.notes[noteId].body, "# Concurrent\n\nOther tab",
      "the stale restore never wins the workspace CAS");
    assert.ok(dialog.element.isConnected, "the modal stays open when the restore failed");
  } finally {
    privateStore.save = save;
    dialog.close();
    workspace.destroy();
  }
});

test("trash keeps private history until the trash is emptied", async () => {
  const old = snapshot("# Old version\n\nOld", 0);
  const { user, page, noteId } = await seedWorkspace({
    body: "# Live\n\nText",
    snapshots: [old]
  });
  const workspace = new PrivateWorkspace({});
  workspace.setPage(page);
  try {
    assert.equal(await workspace.deleteNotes([noteId]), true);
    let read = privateStore.read(privateStore.findActive(user.id));
    assert.equal(read.notes[noteId], undefined);
    assert.equal(read.trash[0].note.id, noteId);
    assert.deepEqual(read.history[noteId].map(entry => entry.body), ["# Old version\n\nOld"],
      "history survives the move to trash");

    await workspace.restoreTrash(read.trash[0].undoId);
    read = privateStore.read(privateStore.findActive(user.id));
    assert.ok(read.notes[noteId]);
    assert.ok(read.history[noteId], "restore keeps history");

    await workspace.deleteNotes([noteId]);
    await workspace.emptyTrash();
    read = privateStore.read(privateStore.findActive(user.id));
    assert.deepEqual(read.trash, []);
    assert.equal(read.history[noteId], undefined,
      "empty trash permanently deletes the note history");
  } finally {
    workspace.destroy();
  }
});

test("private history never lists or discloses shared history snapshots", async () => {
  const { page, noteId } = await seedWorkspace({
    body: "# Private\n\nOnly",
    snapshots: [snapshot("# Private old\n\nBody", 0)]
  });
  const historyPage = containers.history.pages.get(containers.ids.historyPage);
  historyPage.system.snapshots = {
    [noteId]: [snapshot("# Shared should not appear", 9)]
  };
  const workspace = new PrivateWorkspace({});
  workspace.setPage(page);
  const dialog = workspace.openHistory(noteId);
  try {
    assert.equal(dialog.entries.length, 2);
    assert.equal(dialog.entries.some(entry => entry.body === "# Shared should not appear"), false);
    assert.equal(dialog.dialog.textContent.includes("Shared should not appear"), false);
  } finally {
    dialog.close();
    workspace.destroy();
  }
});
