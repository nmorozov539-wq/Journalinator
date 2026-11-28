import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import showdown from "showdown";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost/" });
for (const key of [
  "document", "window", "Node", "HTMLElement", "Event", "KeyboardEvent",
  "MouseEvent", "InputEvent", "Range", "NodeFilter"
]) globalThis[key] = dom.window[key];
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.showdown = showdown;

const STRINGS = {
  "JN.Selection.Toolbar": "Selection tools",
  "JN.Selection.Edit": "Edit",
  "JN.Selection.Layout": "Layout",
  "JN.Selection.Appearance": "Appearance",
  "JN.Selection.Auto": "Auto",
  "JN.Selection.UseAutomaticSizing": "Use automatic sizing",
  "JN.Selection.More": "More",
  "JN.Selection.History": "History",
  "JN.Selection.Copy": "Copy",
  "JN.Selection.LockedGroup": "Some selected notes are being edited. Nothing was changed.",
  "JN.Selection.ReadOnly": "Read-only: controls are disabled.",
  "JN.Layout.Plain": "Plain",
  "JN.Layout.Profile": "Profile",
  "JN.Skin.Paper": "Paper",
  "JN.Skin.Font": "Font",
  "JN.Skin.Torn": "Torn edges",
  "JN.Skin.BackgroundImage": "Background image",
  "JN.Skin.Choose": "Choose",
  "JN.Skin.Remove": "Remove",
  "JN.Skin.Paper.Cream": "Cream",
  "JN.Skin.Paper.Amber": "Amber",
  "JN.Skin.Paper.Parchment": "Parchment",
  "JN.Skin.Font.Default": "Default",
  "JN.Skin.Font.Serif": "Serif",
  "JN.Skin.Font.Handwritten": "Handwritten",
  "JN.Skin.Font.Display": "Display",
  "JN.Transfer.SendTo": "Send to…",
  "JN.Common.Delete": "Delete",
  "JN.Common.Cancel": "Cancel",
  "JN.Lock.Editing": "{name} is editing",
  "JN.Lock.SomeoneEditing": "Someone is editing",
  "JN.Lock.Unlock": "Unlock",
  "JN.Lock.UnlockNote": "Unlock note",
  "JN.Lock.EndTitle": "End {name}’s editing session?",
  "JN.Lock.EndBody": "Unsaved changes will remain on their device. The note will return to its last saved version.",
  "JN.Lock.Someone": "Someone",
  "JN.Lock.LockedAction": "Someone else is editing this note.",
  "JN.Editor.Toolbar": "Editing tools",
  "JN.Editor.EditingYou": "Editing · You"
};

const { installFoundry, makeContainers, makeUser } = await import("./fake-foundry.mjs");
const gm = makeUser("GM00000000000001", { isGM: true, name: "GM" });
const editorUser = makeUser("Player0000000001", { name: "Alex" });
const env = installFoundry({ user: gm, users: [gm, editorUser] });
await makeContainers(env);
game.i18n.localize = (key, data) => {
  const value = STRINGS[key] ?? key;
  return data ? value.replace(/\{(\w+)\}/g, (_, name) => String(data[name] ?? "")) : value;
};
foundry.utils.cleanHTML = html => html;
const dialogCalls = [];
foundry.applications = { api: { DialogV2: {
  confirm: async () => true,
  prompt: async () => null,
  wait: async options => { dialogCalls.push(options); return "unlock"; }
} } };

const socket = await import("../scripts/socket.mjs");
socket.registerSocket();
const editSession = await import("../scripts/edit-session.mjs");
const { notesStore } = await import("../scripts/store/notes-store.mjs");
const { default: JournalCanvas } = await import("../scripts/app/canvas.mjs");
const { default: NoteEditor } = await import("../scripts/app/editor.mjs");

const BASE_SKIN = { paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 0 };

async function createNote({ body = "", layout = "plain", x = 10, y = 20 } = {}) {
  const reply = await socket.requestEditReply({
    type: "createNote", body, layout, skin: BASE_SKIN, x, y, requestEdit: false
  });
  assert.equal(reply.type, "noteCreated");
  return notesStore.getNote(reply.noteId);
}

function mountCanvas(notes, layout = notesStore.getLayout(), callbacks = {}) {
  const canvas = new JournalCanvas({ onSelectNote() {}, ...callbacks });
  document.body.append(canvas.root);
  canvas.update(notes, layout);
  return canvas;
}

function click(target, x = 20, y = 20, { ctrlKey = false, dbl = false } = {}) {
  const type = dbl ? "dblclick" : "pointerdown";
  target.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ctrlKey
  }));
  if (!dbl) {
    target.dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ctrlKey
    }));
  }
}

function lockNote(noteId, name = "Alex") {
  const grant = editSession.grantLease({
    noteId,
    userId: editorUser.id,
    userName: name,
    clientSessionId: "remote-session"
  });
  editSession.applyLeaseChanged({
    type: "noteEditLeaseChanged",
    noteId,
    lease: { ...grant.lease, userName: name },
    gmEpoch: editSession.authorityEpoch()
  });
  return grant.lease;
}

function cleanup(canvas) {
  canvas.disconnectGeometry();
  canvas.root.remove();
}

test("read-mode toolbar order is exactly Edit, Layout, Appearance, Auto, More", async () => {
  const note = await createNote({ body: "# One" });
  const actions = [];
  const canvas = mountCanvas([note], notesStore.getLayout(), {
    onSetLayout: (ids, layout) => actions.push(["layout", ids, layout]),
    onSetAppearance: (ids, patch) => actions.push(["appearance", ids, patch]),
    onAutoSize: ids => actions.push(["auto", ids]),
    onDeleteNotes: ids => actions.push(["delete", ids]),
    onCopyNotes: ids => actions.push(["copy", ids])
  });
  try {
    click(canvas.cardEls.get(note._id));
    const bar = canvas.root.querySelector(".jn-selection-bar");
    assert.equal(bar.hidden, false);
    const order = [...bar.querySelectorAll(":scope > .jn-selection-button, :scope > .jn-selection-menu-wrap > .jn-selection-button")]
      .map(button => button.textContent);
    assert.deepEqual(order, ["Edit", "Layout", "Appearance", "Auto", "More"]);

    bar.querySelector('[data-action="layout"]').click();
    assert.equal(bar.querySelector(".jn-selection-layout").hidden, false);
    const layoutItems = [...bar.querySelectorAll(".jn-selection-layout [data-layout]")]
      .map(item => [item.dataset.layout, item.textContent, item.getAttribute("aria-checked")]);
    assert.deepEqual(layoutItems, [["plain", "Plain", "true"], ["profile", "Profile", "false"]]);
    bar.querySelector('.jn-selection-layout [data-layout="profile"]').click();
    assert.deepEqual(actions.at(-1), ["layout", [note._id], "profile"]);

    bar.querySelector('[data-action="appearance"]').click();
    const rows = [...bar.querySelectorAll(".jn-selection-appearance .jn-selection-row-label")]
      .map(node => node.textContent);
    assert.deepEqual(rows, ["Paper", "Font", "Torn edges", "Background image"]);
    bar.querySelector('.jn-selection-swatch[data-paper="parchment"]').click();
    assert.deepEqual(actions.at(-1), ["appearance", [note._id], { paper: "parchment" }]);
    bar.querySelector(".jn-selection-torn-input").checked = true;
    bar.querySelector(".jn-selection-torn-input").dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(actions.at(-1), ["appearance", [note._id], { torn: true }]);

    bar.querySelector('[data-action="more"]').click();
    const more = [...bar.querySelectorAll(".jn-selection-more [data-action]")]
      .map(item => item.textContent);
    assert.deepEqual(more, ["History", "Send to…", "Copy", "Delete"]);
    bar.querySelector('.jn-selection-more [data-action="copy"]').click();
    assert.deepEqual(actions.at(-1), ["copy", [note._id]]);
    bar.querySelector('[data-action="more"]').click();
    bar.querySelector('.jn-selection-more [data-action="delete"]').click();
    assert.deepEqual(actions.at(-1), ["delete", [note._id]]);
  } finally { cleanup(canvas); }
});

test("Auto reflects automatic/manual sizing and requests automatic dimensions", async () => {
  const note = await createNote({ body: "# Auto" });
  const layout = structuredClone(notesStore.getLayout());
  const actions = [];
  const canvas = mountCanvas([note], layout, { onAutoSize: ids => actions.push(ids) });
  try {
    click(canvas.cardEls.get(note._id));
    const auto = canvas.root.querySelector('.jn-selection-bar [data-action="auto"]');
    assert.equal(auto.getAttribute("aria-pressed"), "true");

    const manual = structuredClone(layout);
    manual.cards[note._id].sizing = { mode: "manual", width: 320, minHeight: 240 };
    canvas.layout = manual;
    canvas.update([note], manual);
    assert.equal(auto.getAttribute("aria-pressed"), "false");
    assert.equal(auto.getAttribute("title"), "Use automatic sizing");
    auto.click();
    assert.deepEqual(actions, [[note._id]]);
  } finally { cleanup(canvas); }
});

test("a remotely locked note shows a badge, cannot be selected and offers GM unlock", async () => {
  const note = await createNote({ body: "# Locked\n\n- [ ] task" });
  const lease = lockNote(note._id, "Alex");
  const canvas = mountCanvas([note]);
  try {
    const card = canvas.cardEls.get(note._id);
    const badge = card.querySelector(".jn-lock-badge");
    assert.equal(badge.hidden, false);
    assert.equal(card.querySelector(".jn-lock-text").textContent, "Alex is editing");
    assert.match(card.className, /\bjn-being-edited\b/);
    assert.equal(card.querySelector(".jn-task-checkbox").disabled, true);

    click(card);
    assert.equal(canvas.getSelectedNoteIds().length, 0, "locked note is readable but not selectable");
    assert.equal(canvas.root.querySelector(".jn-selection-bar").hidden, true);

    const unlock = card.querySelector(".jn-lock-unlock");
    assert.equal(unlock.hidden, false);
    unlock.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dialogCalls.length, 1);
    assert.equal(dialogCalls[0].window.title, "End Alex’s editing session?");
    assert.match(dialogCalls[0].content, /Unsaved changes will remain on their device\./);
    assert.equal(lease.noteId, note._id);
    canvas.update([note], notesStore.getLayout());
    assert.equal(card.querySelector(".jn-lock-badge").hidden, true,
      "force unlock clears the mirrored lease");
  } finally { cleanup(canvas); }
});

test("free pins and unrelated unlocked notes stay usable beside a locked note", async () => {
  const a = await createNote({ body: "# A", x: 10, y: 20 });
  const b = await createNote({ body: "# B", x: 300, y: 20 });
  lockNote(a._id);
  const layout = structuredClone(notesStore.getLayout());
  layout.pins = { free1: { noteId: "", x: 700, y: 300, isDefault: false } };
  const canvas = mountCanvas([a, b], layout);
  try {
    assert.ok(canvas.root.querySelector('[data-pin-ref="p:free1"]'));
    click(canvas.cardEls.get(b._id), 320, 40);
    assert.deepEqual(canvas.getSelectedNoteIds(), [b._id]);
    assert.equal(canvas.root.querySelector(".jn-selection-bar").hidden, false);
  } finally { cleanup(canvas); }
});

test("a mixed selection with a locked note disables every mutating group action", async () => {
  const a = await createNote({ body: "# A", x: 10, y: 20 });
  const b = await createNote({ body: "# B", x: 300, y: 20 });
  const canvas = mountCanvas([a, b]);
  try {
    click(canvas.cardEls.get(a._id));
    click(canvas.cardEls.get(b._id), 320, 40, { ctrlKey: true });
    assert.deepEqual(new Set(canvas.getSelectedNoteIds()), new Set([a._id, b._id]));
    lockNote(a._id);
    canvas.update([a, b], notesStore.getLayout());
    const bar = canvas.root.querySelector(".jn-selection-bar");
    for (const action of ["layout", "appearance", "auto"]) {
      assert.equal(bar.querySelector(`[data-action="${action}"]`).disabled, true, `${action} disabled`);
    }
    assert.equal(bar.querySelector(".jn-selection-notice").hidden, false);
    assert.match(bar.querySelector(".jn-selection-notice").textContent, /being edited|locked/i);
  } finally { cleanup(canvas); }
});

test("group drag uses moveCards and More/Delete sends one deleteNotes request", async () => {
  const a = await createNote({ body: "# A", x: 10, y: 20 });
  const b = await createNote({ body: "# B", x: 300, y: 20 });
  const moves = [];
  const deletes = [];
  const canvas = mountCanvas([a, b], notesStore.getLayout(), {
    onMoveCards: value => moves.push(value),
    onDeleteNotes: ids => deletes.push(ids)
  });
  try {
    click(canvas.cardEls.get(a._id));
    click(canvas.cardEls.get(b._id), 320, 40, { ctrlKey: true });
    const card = canvas.cardEls.get(a._id);
    card.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: 30, clientY: 30, button: 0
    }));
    canvas.root.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: 55, clientY: 45, button: 0
    }));
    canvas.root.dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: 55, clientY: 45, button: 0
    }));
    assert.equal(moves.length, 1);
    assert.deepEqual(new Set(moves[0].map(move => move.noteId)), new Set([a._id, b._id]));

    const bar = canvas.root.querySelector(".jn-selection-bar");
    bar.querySelector('[data-action="more"]').click();
    bar.querySelector('.jn-selection-more [data-action="delete"]').click();
    assert.deepEqual(deletes, [[a._id, b._id]]);
  } finally { cleanup(canvas); }
});

test("double-click requests editing at the text point", async () => {
  const note = await createNote({ body: "# Edit me" });
  const requested = [];
  const canvas = mountCanvas([note], notesStore.getLayout(), {
    onEditNote: (id, point) => requested.push([id, point])
  });
  try {
    click(canvas.cardEls.get(note._id).querySelector(".jn-note-body"), 42, 55, { dbl: true });
    assert.equal(requested.length, 1);
    assert.equal(requested[0][0], note._id);
    assert.equal(requested[0][1].clientX, 42);
    assert.equal(requested[0][1].clientY, 55);
  } finally { cleanup(canvas); }
});

test("the editor focusAtPoint delegation moves the source caret", async () => {
  const note = await createNote({ body: "# Focus\n\nBody" });
  const lease = {
    canvasId: "shared", noteId: note._id, userId: gm.id, clientSessionId: "tab-test",
    leaseToken: "lease-test", gmEpoch: "epoch-test"
  };
  const noop = () => {};
  const transport = {
    begin: async () => ({
      type: "noteEditGranted", lease, revision: 0, body: note.system.body,
      layout: note.system.layout, skin: note.system.skin
    }),
    heartbeat: async () => ({ type: "noteEditHeartbeatAck", leaseToken: lease.leaseToken }),
    preview: noop,
    save: async () => ({ type: "noteSaveAck", revision: 1, sequence: 0 }),
    appearance: async () => ({ type: "noteAppearanceAck" }),
    end: async () => ({ type: "noteEditEnded", revision: 0, saved: false, released: true }),
    state: async () => ({ type: "noteEditState", notes: [] }),
    now: () => Date.now(),
    setTimeout: () => 0,
    clearTimeout: noop
  };
  const editor = new NoteEditor({ transport, drafts: null });
  const host = document.createElement("div");
  document.body.appendChild(host);
  try {
    const result = await editor.open(note._id, { host, note });
    assert.equal(result.ok, true);
    editor._source.caretOffsetFromPoint = () => 5;
    assert.equal(editor.focusAtPoint(100, 120), true);
    assert.equal(editor._source.getSelection().start, 5);
    assert.equal(document.activeElement, editor._source.textarea);
  } finally {
    await editor.close();
    host.remove();
  }
});

test("remote card updates never tear down the mounted editor DOM", async () => {
  const note = await createNote({ body: "# Original" });
  const canvas = mountCanvas([note]);
  try {
    const card = canvas.cardEls.get(note._id);
    const body = card.querySelector(".jn-note-body");
    const originalHtml = body.innerHTML;
    const editor = document.createElement("div");
    editor.className = "jn-note-editor";
    const marker = document.createElement("span");
    marker.dataset.editorMarker = "1";
    editor.appendChild(marker);
    card.appendChild(editor);
    canvas.setEditingNote(note._id);
    assert.match(card.className, /\bjn-editing\b/);

    const changed = { ...note, system: { ...note.system, body: "# Remote change" } };
    canvas.update([changed], notesStore.getLayout());
    assert.equal(card.querySelector("[data-editor-marker]"), marker, "editor node survives");
    assert.equal(body.innerHTML, originalHtml, "read body is not rebuilt under the editor");

    canvas.setEditingNote(null);
    canvas.update([changed], notesStore.getLayout());
    assert.match(card.querySelector(".jn-note-body").innerHTML, /Remote change/);
  } finally { cleanup(canvas); }
});
