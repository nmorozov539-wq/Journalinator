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
const owner = makeUser("PrivateOwner00001", { name: "Owner" });
const other = makeUser("PrivateOther00001", { name: "Other" });
const env = installFoundry({ user: owner, users: [owner, other] });
const containers = await makeContainers(env);
foundry.utils.cleanHTML = html => html;
const STRINGS = {
  "JN.Editor.Title": "Title",
  "JN.Editor.Divider": "Divider",
  "JN.Editor.Portrait": "Portrait",
  "JN.Editor.Layout": "Layout",
  "JN.Editor.Appearance": "Appearance",
  "JN.Editor.Done": "Done",
  "JN.Selection.Edit": "Edit",
  "JN.Selection.Layout": "Layout",
  "JN.Selection.Appearance": "Appearance",
  "JN.Selection.Auto": "Auto",
  "JN.Selection.More": "More",
  "JN.Selection.History": "History",
  "JN.Transfer.SendTo": "Send to…",
  "JN.Selection.Copy": "Copy",
  "JN.Common.Delete": "Delete",
  "JN.History.Title": "Note history",
  "JN.Search.EmptyNote": "Empty note",
  "JN.Search.ImageNote": "Image note"
};
const localize = game.i18n.localize;
game.i18n.localize = (key, data) => {
  const value = STRINGS[key] ?? localize(key, data);
  return data ? String(value).replace(/\{(\w+)\}/g, (_, name) => String(data[name] ?? "")) : value;
};
const dialogs = [];
foundry.applications = {
  api: {
    DialogV2: {
      confirm: async () => true,
      prompt: async () => null,
      wait: async options => { dialogs.push(options); return null; }
    }
  }
};

const { privateStore } = await import("../scripts/store/private-store.mjs");
const { originFromBox, mainPinWorld } = await import("../scripts/sizing/geometry.mjs");
const { noteSearchLabel } = await import("../scripts/app/note-search.mjs");
const { default: PrivateWorkspace } = await import("../scripts/app/private-workspace.mjs");

let userSequence = 0;
const users = new Map([[owner.id, owner], [other.id, other]]);
const baseGet = game.users.get;
game.users.get = id => users.get(id) ?? baseGet(id);
function freshUser() {
  userSequence += 1;
  const user = makeUser(`PrivateUiUser${String(userSequence).padStart(6, "0")}`, { name: `User ${userSequence}` });
  users.set(user.id, user);
  return user;
}

async function mountWorkspace(page, options = {}) {
  const workspace = new PrivateWorkspace(options);
  workspace.setPage(page);
  const slot = document.createElement("div");
  slot.className = "private-test-slot";
  slot.style.width = "900px";
  slot.style.height = "700px";
  document.body.append(slot);
  workspace.renderInto(slot);
  return { workspace, slot };
}

async function discard(workspace, slot) {
  await workspace.editor.close().catch(() => {});
  workspace.destroy();
  slot.remove();
}

function addNote(workspace, body, { layout = "plain", x = 20, y = 20 } = {}) {
  const { note, card } = privateStore.makeNote({
    body, layout, x, y,
    cards: workspace.layout().cards,
    notes: workspace.workspace.notes
  });
  workspace.workspace.notes[note.id] = note;
  workspace.workspace.layout.cards[note.id] = card;
  return { note, card };
}

async function persist(workspace, page) {
  return privateStore.save(page, workspace.workspace, privateStore.flags(page).rev);
}

async function createPageFor(user) {
  return privateStore.createFor(user);
}

function click(element, { dbl = false } = {}) {
  const type = dbl ? "dblclick" : "pointerdown";
  element.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: 20, clientY: 20, button: 0
  }));
  if (!dbl) {
    element.dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: 20, clientY: 20, button: 0
    }));
  }
}

async function waitFor(check, timeout = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test("private cards use the shared v2 card view with derived labels and Plain/Profile layout", async () => {
  const user = freshUser();
  const page = await createPageFor(user);
  const { workspace, slot } = await mountWorkspace(page);
  try {
    const plain = addNote(workspace, "# Field notes\n\nVisible body");
    const profile = addNote(workspace, "# Portrait\n\n![face](worlds/face.webp)\n\n## Caption\n\nText", {
      layout: "profile", x: 420
    });
    await persist(workspace, page);
    workspace.reloadWorkspace();

    const plainEl = workspace.canvas.cardEls.get(plain.note.id);
    const profileEl = workspace.canvas.cardEls.get(profile.note.id);
    assert.match(plainEl.className, /\bjn-card-plain\b/);
    assert.match(profileEl.className, /\bjn-card-profile\b/);
    assert.match(plainEl.querySelector(".jn-note-body").textContent, /Field notes/);
    assert.match(profileEl.querySelector(".jn-note-body").textContent, /Caption/);
    assert.equal(workspace.getNote(plain.note.id).name, "Field notes");
    assert.equal(workspace.getNote(profile.note.id).name, "Portrait");

    const system = workspace.getNote(plain.note.id).system;
    for (const removed of ["label", "kind", "style", "location", "secret", "presentation", "blocks"]) {
      assert.equal(Object.hasOwn(system, removed), false, `v2 view has no ${removed}`);
    }
    assert.equal(plainEl.querySelector(".journalinator-label"), null);
    assert.equal(plainEl.querySelector(".jn-private-delete"), null);
  } finally {
    await discard(workspace, slot);
  }
});

test("+ Note and empty double-click open the shared Blank/Document/Profile menu", async () => {
  const user = freshUser();
  const page = await createPageFor(user);
  const { workspace, slot } = await mountWorkspace(page);
  try {
    const point = workspace.canvas.newCardPosition();
    const menu = workspace.openCreationMenuAt(point);
    assert.ok(menu?.element?.isConnected);
    assert.deepEqual(
      [...menu.element.querySelectorAll("[data-template]")].map(item => item.dataset.template),
      ["blank", "document", "profile"]
    );
    menu.element.querySelector('[data-template="profile"]').click();

    const opened = await waitFor(() => workspace.editor.isEditing);
    assert.equal(opened, true);
    const notes = workspace.notes();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].system.body, "# ");
    assert.equal(notes[0].system.layout, "profile");
    assert.equal(notes[0].system.skin.paper, "parchment");

    const textarea = workspace.editor.editor.root.querySelector("textarea.jn-source-input");
    assert.equal(textarea.value, "# ");
    assert.equal(textarea.selectionStart, 2, "focus lands after the title marker");
    assert.equal(textarea.selectionEnd, 2);
    assert.equal(document.activeElement, textarea);

    const toolbar = [...workspace.editor.editor.root.querySelectorAll(".jn-editor-toolbar .jn-editor-tool")]
      .map(button => button.textContent);
    assert.deepEqual(toolbar, ["Title", "Divider", "Portrait", "Layout", "Appearance", "Done"]);
    assert.ok(workspace.editor.editor.root.querySelector(".jn-editor-profile-helper"));

    await workspace.editor.close();
    workspace.canvas.root.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true, cancelable: true, clientX: 300, clientY: 240, button: 0
    }));
    const boardMenu = document.querySelector(".jn-creation-menu");
    assert.ok(boardMenu, "an empty-board double-click opens the same anchored menu");
    assert.deepEqual(
      [...boardMenu.querySelectorAll("[data-template]")].map(item => item.dataset.template),
      ["blank", "document", "profile"]
    );
    boardMenu.querySelector('[data-template="blank"]').click();
    assert.equal(await waitFor(() => workspace.notes().length === 2), true);
    assert.equal(workspace.editor.isEditing, true);
    assert.equal(workspace.notes().find(note => note.system.body === "").system.skin.paper, "amber");
  } finally {
    await discard(workspace, slot);
  }
});

test("quick creation makes a real heading, allows duplicates and keeps empty input Blank", async () => {
  const user = freshUser();
  const page = await createPageFor(user);
  const { workspace, slot } = await mountWorkspace(page);
  try {
    const position = { x: 10, y: 10 };
    await workspace.createFromQuery("Same title", position);
    await workspace.createFromQuery("Same title", { x: 200, y: 10 });
    await workspace.createFromQuery("", { x: 400, y: 10 });
    const notes = workspace.notes();
    assert.equal(notes.length, 3);
    assert.deepEqual(notes.map(note => note.system.body).sort(), ["", "# Same title", "# Same title"].sort());
    assert.deepEqual(notes.map(note => noteSearchLabel(note)).sort(), [
      "Empty note", "Same title", "Same title"
    ].sort());
    for (const note of notes) {
      if (note.system.body === "# Same title") assert.equal(note.system.layout, "plain");
    }
  } finally {
    await discard(workspace, slot);
  }
});

test("a failed creation save leaves no orphan note or card", async () => {
  const user = freshUser();
  const page = await createPageFor(user);
  const { workspace, slot } = await mountWorkspace(page);
  const save = privateStore.save.bind(privateStore);
  try {
    privateStore.save = async () => { throw new Error("simulated save failure"); };
    const created = await workspace.createFromTemplate("document", { x: 30, y: 30 });
    assert.equal(created, null);
    assert.equal(workspace.notes().length, 0);
    assert.equal(Object.keys(workspace.workspace.layout.cards).length, 0);
    assert.equal(workspace.editor.isEditing, false);
  } finally {
    privateStore.save = save;
    await discard(workspace, slot);
  }
});

test("the shared editor mounts on the private card, autosaves through the local transport and never uses socket", async () => {
  const user = freshUser();
  const page = await createPageFor(user);
  const { workspace, slot } = await mountWorkspace(page);
  try {
    const { note } = addNote(workspace, "# Draft\n\nStart");
    await persist(workspace, page);
    workspace.reloadWorkspace();
    const historyBefore = structuredClone(containers.history.pages.get(containers.ids.historyPage).system);
    const activityBefore = structuredClone(containers.shared.pages.get(containers.ids.activityPage).system);

    const result = await workspace.beginEditing(note.id);
    assert.equal(result.ok, true);
    const card = workspace.canvas.cardEls.get(note.id);
    assert.equal(card.classList.contains("jn-editing"), true);
    assert.ok(card.querySelector("textarea.jn-source-input"));
    assert.equal(workspace.canvas.editingNoteId, note.id);

    const textarea = card.querySelector("textarea.jn-source-input");
    textarea.value = "# Draft\n\nSaved privately";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "y" }));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(env.socketLog.length, 0, "preview/autosave never emits a socket message");

    const saved = await waitFor(() => {
      const current = privateStore.read(privateStore.findActive(user.id)).notes[note.id];
      return current.body === "# Draft\n\nSaved privately";
    });
    assert.equal(saved, true);
    assert.equal(env.socketLog.length, 0, "no shared socket traffic after autosave");
    assert.deepEqual(containers.history.pages.get(containers.ids.historyPage).system, historyBefore);
    assert.deepEqual(containers.shared.pages.get(containers.ids.activityPage).system, activityBefore);

    await workspace.editor.close();
    assert.equal(workspace.editor.isEditing, false);
    assert.equal(card.classList.contains("jn-editing"), false);
  } finally {
    await discard(workspace, slot);
  }
});

test("private layout/appearance and Auto use short local leases and v2 sizing", async () => {
  const user = freshUser();
  const page = await createPageFor(user);
  const { workspace, slot } = await mountWorkspace(page);
  try {
    const { note, card } = addNote(workspace, "# Style\n\nBody");
    await persist(workspace, page);
    workspace.reloadWorkspace();

    assert.equal(await workspace.applyAppearance([note.id], {
      layout: "profile", paper: "parchment", font: "serif", torn: true
    }), true);
    let stored = privateStore.read(privateStore.findActive(user.id)).notes[note.id];
    assert.equal(stored.layout, "profile");
    assert.equal(stored.skin.paper, "parchment");
    assert.equal(stored.skin.font, "serif");
    assert.equal(stored.skin.torn, true);
    assert.equal(stored.revision, 0, "appearance never changes the body revision");

    const before = { x: card.x, y: card.y };
    assert.equal(await workspace.resizeCard(note.id, 340, 260), true);
    let savedCard = privateStore.read(privateStore.findActive(user.id)).layout.cards[note.id];
    assert.deepEqual(savedCard.sizing, { mode: "manual", width: 340, minHeight: 260 });
    assert.equal(savedCard.x, before.x);
    assert.equal(savedCard.y, before.y);
    assert.equal(savedCard.sizing.width > 160, true);

    const originBefore = savedCard.autoSizeOrigin;
    assert.ok(originBefore && Number.isFinite(originBefore.x) && Number.isFinite(originBefore.y));
    assert.equal(await workspace.autoSizeNotes([note.id]), true);
    savedCard = privateStore.read(privateStore.findActive(user.id)).layout.cards[note.id];
    assert.deepEqual(savedCard.sizing, { mode: "auto", width: null, minHeight: null });
    assert.deepEqual(savedCard.autoSizeOrigin, originBefore, "Auto keeps the stable pin origin");

    const rendered = workspace.canvas.cardBox(note.id);
    assert.deepEqual(mainPinWorld(savedCard, rendered),
      { x: savedCard.autoSizeOrigin.x, y: savedCard.autoSizeOrigin.y });
  } finally {
    await discard(workspace, slot);
  }
});

test("private selection uses the shared read-mode bar and More→History opens the shared dialog", async () => {
  const user = freshUser();
  const page = await createPageFor(user);
  const sent = [];
  const copied = [];
  const { workspace, slot } = await mountWorkspace(page, {
    onSend: id => sent.push(id),
    onCopy: entries => copied.push(...entries)
  });
  try {
    const { note } = addNote(workspace, "# Selected\n\nBody");
    await persist(workspace, page);
    workspace.reloadWorkspace();

    click(workspace.canvas.cardEls.get(note.id));
    const bar = workspace.canvas.root.querySelector(".jn-selection-bar");
    assert.equal(bar.hidden, false);
    const order = [...bar.querySelectorAll(
      ":scope > .jn-selection-button, :scope > .jn-selection-menu-wrap > .jn-selection-button"
    )].map(button => button.textContent);
    assert.deepEqual(order, ["Edit", "Layout", "Appearance", "Auto", "More"]);
    assert.equal(bar.querySelector(".jn-lock-badge"), null, "private selection has no shared lock badge");

    bar.querySelector('[data-action="more"]').click();
    assert.deepEqual([...bar.querySelectorAll(".jn-selection-more [data-action]")]
      .map(item => item.textContent), ["History", "Send to…", "Copy", "Delete"]);
    bar.querySelector('.jn-selection-more [data-action="history"]').click();
    assert.ok(document.querySelector(".jn-history-dialog"));
    assert.equal(document.querySelector(".jn-history-dialog").textContent.includes("Note history"), true);
    document.querySelector(".jn-history-dialog .jn-history-close").click();

    bar.querySelector('[data-action="more"]').click();
    bar.querySelector('.jn-selection-more [data-action="send"]').click();
    assert.deepEqual(sent, [note.id], "Send uses the derived note id on the private canvas");
    bar.querySelector('[data-action="more"]').click();
    bar.querySelector('.jn-selection-more [data-action="copy"]').click();
    assert.deepEqual(copied.map(entry => entry.body), ["# Selected\n\nBody"]);
  } finally {
    await discard(workspace, slot);
  }
});

test("private trash uses derived labels/excerpts and never internal page or note names", async () => {
  const user = freshUser();
  const page = await createPageFor(user);
  const { workspace, slot } = await mountWorkspace(page);
  try {
    addNote(workspace, "Visible body only");
    const empty = addNote(workspace, "", { x: 300 });
    await persist(workspace, page);
    workspace.reloadWorkspace();
    await workspace.deleteNotes([empty.note.id]);
    dialogs.length = 0;
    await workspace.openTrash();
    const content = dialogs.at(-1)?.content ?? "";
    assert.match(content, /Empty note/, "derived empty label, not the note id");
    assert.match(content, /Deleted by you/);
    assert.equal(dialogs.at(-1).content.includes(page.name), false);
    const row = document.createElement("div");
    row.innerHTML = content;
    assert.equal(row.querySelector(".jn-trash-title").textContent, "Empty note");
    assert.equal(row.textContent.includes(empty.note.id), false);

    await workspace.restoreTrash(workspace.workspace.trash[0].undoId);
    assert.ok(workspace.workspace.notes[empty.note.id]);
  } finally {
    await discard(workspace, slot);
  }
});
