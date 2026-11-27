import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import showdown from "showdown";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const key of ["document", "HTMLElement", "Node", "Event", "KeyboardEvent", "MouseEvent"]) {
  globalThis[key] = dom.window[key];
}
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.showdown = showdown;
const { installFoundry, makeContainers, makeUser } = await import("./fake-foundry.mjs");
const user = makeUser("PinGM00000000001", { isGM: true, name: "GM" });
const env = installFoundry({ user, users: [user] });
await makeContainers(env);
foundry.applications = { api: { DialogV2: { confirm: async () => true,
  prompt: async () => null, wait: async () => null } } };
const { registerSocket, requestWrite } = await import("../scripts/socket.mjs");
const { notesStore } = await import("../scripts/store/notes-store.mjs");
const { default: JournalCanvas } = await import("../scripts/app/canvas.mjs");
registerSocket();
const tick = () => new Promise(resolve => setTimeout(resolve, 50));
const event = (target, type, x = 0, y = 0, button = 0) => target.dispatchEvent(
  new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button })
);

test("pin tool and all four pin gestures use distinct pointer transactions", async () => {
  await requestWrite({ type: "createNote", title: "Pin A", x: 10, y: 20 });
  await requestWrite({ type: "createNote", title: "Pin B", x: 350, y: 20 });
  await tick();
  const notes = notesStore.getAllNotes();
  const a = notes.find(note => note.name === "Pin A");
  const b = notes.find(note => note.name === "Pin B");
  assert.ok(a && b);
  const actions = [];
  const canvas = new JournalCanvas({ onBoardPinAction: action => actions.push(action),
    onSelectNote() {}, onMoveCard() {}, onCreateNoteAt() {} });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  canvas.update(notes, notesStore.getLayout());
  const cardA = canvas.cardEls.get(a.id), cardB = canvas.cardEls.get(b.id);
  let source = cardA.querySelector('[data-pin-ref$=":main"]');
  assert.ok(source);

  canvas.togglePinTool();
  event(cardA, "pointerdown", 70, 60);
  event(cardA, "pointerup", 70, 60);
  assert.deepEqual(actions.at(-1), { type: "add", noteId: a.id,
    x: (70 - 10) / 190, y: (60 - 20) / 70 });
  event(canvas.root, "pointerdown", 600, 300);
  event(canvas.root, "pointerup", 600, 300);
  assert.deepEqual(actions.at(-1), { type: "add", noteId: "", x: 600, y: 300 });
  canvas.togglePinTool();

  const manualId = "manual1";
  const layout = structuredClone(notesStore.getLayout());
  layout.pins = { [manualId]: { noteId: a.id, x: 0.3, y: 0.4, isDefault: false },
    free1: { noteId: "", x: 600, y: 300, isDefault: false } };
  layout.pinLinks = {};
  canvas.update(notes, layout);
  source = cardA.querySelector('[data-pin-ref$=":main"]');
  const manual = cardA.querySelector('[data-pin-ref="p:manual1"]');
  assert.ok(manual);
  event(source, "pointerdown", 105, 20);
  assert.ok(canvas.root.querySelector(".jn-link-preview"), "thread appears on first press");
  event(source, "pointerup", 105, 20);
  event(canvas.root, "pointermove", 160, 70);
  assert.ok(canvas.root.querySelector(".jn-link-preview")?.getAttribute("d")?.includes("160"),
    "thread follows the pointer with the button up");
  event(manual, "pointerdown", 67, 48);
  event(manual, "pointerup", 67, 48);
  assert.deepEqual(actions.at(-1), { type: "connect", source: `n:${a.id}:main`, target: "p:manual1" });
  assert.equal(canvas.root.querySelector(".jn-link-preview"), null);

  const free = canvas.root.querySelector('[data-pin-ref="p:free1"]');
  event(manual, "pointerdown", 67, 48);
  event(manual, "pointerup", 67, 48);
  event(free, "pointerdown", 600, 300);
  event(free, "pointerup", 600, 300);
  assert.deepEqual(actions.at(-1), { type: "connect", source: "p:manual1", target: "p:free1" },
    "standalone pins start and receive connections");
  const countBeforeSelf = actions.length;
  event(source, "pointerdown", 105, 20);
  event(source, "pointerup", 105, 20);
  event(source, "pointerdown", 105, 20);
  event(source, "pointerup", 105, 20);
  assert.equal(actions.length, countBeforeSelf, "source pin does not fall through to its note");

  event(source, "pointerdown", 105, 20);
  event(canvas.root, "pointermove", 390, 60);
  event(cardB, "pointerup", 390, 60);
  assert.deepEqual(actions.at(-1), { type: "connect", source: `n:${a.id}:main`, target: `n:${b.id}:main` },
    "a drag released on note body uses its default pin");

  event(manual, "pointerdown", 67, 48);
  event(manual, "pointerup", 67, 48);
  event(manual, "pointerdown", 67, 48);
  event(manual, "pointerup", 67, 48);
  event(canvas.root, "pointermove", 500, 300);
  assert.ok(canvas.root.querySelector(".jn-moving-pin"), "double click picks the pin up");
  event(canvas.root, "pointerdown", 500, 300);
  event(canvas.root, "pointerup", 500, 300);
  assert.deepEqual(actions.at(-1), { type: "move", ref: "p:manual1", noteId: "", x: 500, y: 300 });

  event(manual, "pointerdown", 67, 48);
  event(manual, "pointerup", 67, 48);
  event(manual, "pointerdown", 67, 48);
  event(canvas.root, "pointermove", 390, 60);
  event(cardB, "pointerup", 390, 60);
  assert.deepEqual(actions.at(-1), { type: "move", ref: "p:manual1", noteId: b.id,
    x: (390 - 350) / 190, y: (60 - 20) / 70 });
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("saved pins and links survive ownership changes and reload", async () => {
  const notes = notesStore.getAllNotes();
  const a = notes.find(note => note.name === "Pin A");
  const b = notes.find(note => note.name === "Pin B");
  await requestWrite({ type: "boardPinAction", action: { type: "add", noteId: a.id, x: 0.3, y: 0.4 } });
  await tick();
  let layout = notesStore.getLayout();
  const id = Object.keys(layout.pins)[0];
  assert.ok(id);
  await requestWrite({ type: "boardPinAction", action: { type: "connect",
    source: `p:${id}`, target: `n:${b.id}:main` } });
  await requestWrite({ type: "boardPinAction", action: { type: "move",
    ref: `p:${id}`, noteId: "", x: 600, y: 300 } });
  await tick();
  layout = notesStore.getLayout();
  assert.deepEqual([layout.pins[id].noteId, layout.pins[id].x, layout.pins[id].y], ["", 600, 300]);
  await requestWrite({ type: "boardPinAction", action: { type: "move",
    ref: `p:${id}`, noteId: b.id, x: 0.2, y: 0.7 } });
  await tick();
  layout = notesStore.getLayout();
  assert.deepEqual([layout.pins[id].noteId, layout.pins[id].x, layout.pins[id].y], [b.id, 0.2, 0.7]);
  assert.equal(Object.values(layout.pinLinks)[0].source, `p:${id}`);
  await requestWrite({ type: "boardPinAction", action: { type: "move",
    ref: `p:${id}`, noteId: a.id, x: 0.8, y: 0.1 } });
  await tick();
  layout = notesStore.getLayout();
  assert.deepEqual([layout.pins[id].noteId, layout.pins[id].x, layout.pins[id].y], [a.id, 0.8, 0.1]);
  assert.equal(Object.values(layout.pinLinks)[0].source, `p:${id}`);

  const canvas = new JournalCanvas({ onBoardPinAction: action =>
    requestWrite({ type: "boardPinAction", action }), onSelectNote() {} });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  canvas.view = { x: 50, y: -20, k: 1.5 };
  const refresh = () => canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  const pin = () => canvas.root.querySelector(`[data-pin-ref="p:${id}"]`);
  refresh();
  const at = (x, y) => [x * canvas.view.k + canvas.view.x,
    y * canvas.view.k + canvas.view.y];
  let [sx, sy] = at(162, 27);
  event(pin(), "pointerdown", sx, sy);
  event(pin(), "pointerup", sx, sy);
  event(pin(), "pointerdown", sx, sy);
  [sx, sy] = at(600, 300);
  event(canvas.root, "pointermove", sx, sy);
  event(canvas.root, "pointerup", sx, sy);
  await tick();
  refresh();
  layout = notesStore.getLayout();
  assert.deepEqual([layout.pins[id].noteId, layout.pins[id].x, layout.pins[id].y], ["", 600, 300],
    "note to canvas keeps world coordinates after pan and zoom");

  event(pin(), "pointerdown", sx, sy);
  event(pin(), "pointerup", sx, sy);
  event(pin(), "pointerdown", sx, sy);
  event(pin(), "pointerup", sx, sy);
  [sx, sy] = at(390, 60);
  event(canvas.root, "pointermove", sx, sy);
  const cardB = canvas.cardEls.get(b.id);
  event(cardB, "pointerdown", sx, sy);
  event(cardB, "pointerup", sx, sy);
  await tick();
  refresh();
  layout = notesStore.getLayout();
  assert.deepEqual([layout.pins[id].noteId, layout.pins[id].x, layout.pins[id].y],
    [b.id, 40 / 190, 40 / 70], "canvas to note uses exact local coordinates");

  event(pin(), "pointerdown", sx, sy);
  event(pin(), "pointerup", sx, sy);
  event(pin(), "pointerdown", sx, sy);
  [sx, sy] = at(100, 65);
  event(canvas.root, "pointermove", sx, sy);
  event(canvas.cardEls.get(a.id), "pointerup", sx, sy);
  await tick();
  refresh();
  layout = notesStore.getLayout();
  assert.equal(layout.pins[id].noteId, a.id);
  assert.ok(Math.abs(layout.pins[id].x - 90 / 190) < 1e-9
    && Math.abs(layout.pins[id].y - 45 / 70) < 1e-9,
  "note to note changes owner without snapping");

  const before = canvas.root.querySelector(".jn-pin-links path")?.getAttribute("d");
  await requestWrite({ type: "moveCard", noteId: b.id, x: 450, y: 120 });
  await tick();
  refresh();
  const after = canvas.root.querySelector(".jn-pin-links path")?.getAttribute("d");
  assert.notEqual(after, before, "connected thread follows the moved destination note");
  const reload = new JournalCanvas({ onSelectNote() {} });
  document.body.append(reload.root);
  reload.update(notesStore.getAllNotes(), notesStore.getLayout());
  assert.ok(reload.root.querySelector(`[data-pin-ref="p:${id}"]`));
  assert.ok(reload.root.querySelector(".jn-pin-links path"));
  reload.disconnectGeometry();
  reload.root.remove();
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("right drag pans over notes and pins; only text and empty-board double clicks act", () => {
  const notes = notesStore.getAllNotes();
  const a = notes.find(note => note.name === "Pin A");
  const calls = [];
  const canvas = new JournalCanvas({ onSelectNote() {},
    onEditCardBlock: (...args) => calls.push(["edit", ...args]),
    onCreateNoteAt: (...args) => calls.push(["create", ...args]) });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  canvas.update(notes, notesStore.getLayout());
  const card = canvas.cardEls.get(a.id);
  const text = card.querySelector("[data-card-text='block']");
  const pin = card.querySelector('[data-pin-ref$=":main"]');
  event(text, "pointerdown", 40, 50);
  event(text, "pointerup", 40, 50);
  assert.equal(calls.some(call => call[0] === "edit"), false,
    "single click selects without editing");
  event(text, "pointerdown", 40, 50);
  event(text, "pointerup", 40, 50);
  assert.equal(calls.filter(call => call[0] === "edit").length, 1);

  const pan = target => {
    const before = { ...canvas.view };
    event(target, "pointerdown", 40, 40, 2);
    event(canvas.root, "pointermove", 80, 70, 2);
    event(canvas.root, "pointerup", 80, 70, 2);
    assert.deepEqual([canvas.view.x - before.x, canvas.view.y - before.y], [40, 30]);
  };
  pan(card);
  pan(pin);
  pan(canvas.root);
  assert.equal(event(card, "contextmenu", 10, 10, 2), false,
    "browser context menu is suppressed");
  assert.equal(canvas.root.querySelector(".jn-context-menu")?.style.display, "none");

  event(pin, "dblclick", 40, 40);
  assert.equal(calls.filter(call => call[0] === "create").length, 0);
  event(card, "dblclick", 40, 40);
  assert.equal(calls.filter(call => call[0] === "create").length, 0);
  event(canvas.root, "dblclick", 600, 400);
  assert.equal(calls.filter(call => call[0] === "create").length, 1);
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("moving a legacy minor anchor migrates its link endpoint without changing the link", async () => {
  const a = notesStore.getAllNotes().find(note => note.name === "Pin A");
  const b = notesStore.getAllNotes().find(note => note.name === "Pin B");
  await requestWrite({ type: "addCardAnchor", noteId: a.id, kind: "minor", x: 0.3, y: 0.4 });
  await tick();
  const before = notesStore.getLayout();
  const anchorId = Object.keys(before.cards[a.id].anchors).find(id => id !== "main");
  assert.ok(anchorId);
  await requestWrite({ type: "createLink", sourceId: a.id, targetId: b.id,
    sourceAnchorId: anchorId, targetAnchorId: "main" });
  await tick();
  const originalLink = notesStore.getNote(a.id).system.links.find(link => link.targetId === b.id);
  assert.ok(originalLink);
  await requestWrite({ type: "boardPinAction", action: { type: "move",
    ref: `n:${a.id}:${anchorId}`, noteId: "", x: 720, y: 410 } });
  await tick();
  const after = notesStore.getLayout();
  const savedLink = notesStore.getNote(a.id).system.links.find(link => link.id === originalLink.id);
  assert.equal(savedLink.sourcePinRef.startsWith("p:"), true);
  assert.equal(savedLink.sourceAnchorId, "");
  assert.equal(after.cards[a.id].anchors[anchorId], undefined);
  assert.deepEqual([after.pins[savedLink.sourcePinRef.slice(2)].noteId,
    after.pins[savedLink.sourcePinRef.slice(2)].x,
    after.pins[savedLink.sourcePinRef.slice(2)].y], ["", 720, 410]);
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.append(canvas.root);
  canvas.update(notesStore.getAllNotes(), after);
  assert.ok(canvas.root.querySelector(`.jn-board-pin-control[data-pin-ref="${savedLink.sourcePinRef}"]`));
  assert.ok(canvas.root.querySelector(`g[data-id="${savedLink.id}"] path`),
    "the original connection still renders after reload");
  canvas.disconnectGeometry();
  canvas.root.remove();
});
