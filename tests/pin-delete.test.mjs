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
const user = makeUser("PinDeleteGM000001", { isGM: true, name: "GM" });
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
const press = (canvas, key) => canvas.root.dispatchEvent(
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
);
const selectPin = pin => {
  event(pin, "pointerdown", 50, 50);
  event(pin, "pointerup", 50, 50);
};
const noteId = async title => {
  await requestWrite({ type: "createNote", title, x: 10, y: 20 });
  await tick();
  return notesStore.getAllNotes().find(note => note.name === title).id;
};
const canvasFor = actions => {
  const canvas = new JournalCanvas({ onSelectNote() {},
    onBoardPinAction: action => {
      actions.push(action);
      return requestWrite({ type: "boardPinAction", action });
    } });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  return canvas;
};

test("Delete removes a minor note pin and its attached link", async () => {
  const a = await noteId("Delete Minor A");
  const b = await noteId("Delete Minor B");
  await requestWrite({ type: "addCardAnchor", noteId: a, kind: "minor", x: 0.35, y: 0.5 });
  await tick();
  const anchorId = Object.keys(notesStore.getLayout().cards[a].anchors)
    .find(id => id !== "main");
  assert.ok(anchorId);
  await requestWrite({ type: "createLink", sourceId: a, targetId: b,
    sourceAnchorId: anchorId, targetAnchorId: "main" });
  await tick();
  const actions = [];
  const canvas = canvasFor(actions);
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  const pin = canvas.root.querySelector(`[data-pin-ref="n:${a}:${anchorId}"]`);
  assert.ok(pin, "minor pin renders");

  selectPin(pin);
  const input = document.createElement("textarea");
  canvas.root.append(input);
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Delete" }));
  assert.equal(actions.length, 0, "Delete inside a textarea is ignored");
  assert.ok(notesStore.getLayout().cards[a].anchors[anchorId], "textarea Delete leaves the pin");
  input.remove();

  press(canvas, "Delete");
  await tick();
  assert.deepEqual(actions.at(-1), { type: "delete", ref: `n:${a}:${anchorId}` });
  assert.equal(canvas.selectedPinRef, null, "successful delete clears the selection");
  const layout = notesStore.getLayout();
  assert.equal(layout.cards[a].anchors[anchorId], undefined);
  assert.equal(notesStore.getNote(a).system.links.some(link => link.targetId === b), false,
    "the link attached to the deleted anchor is removed through the board-pin action");
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  assert.equal(canvas.root.querySelector(`[data-pin-ref="n:${a}:${anchorId}"]`), null);
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("Delete and Backspace remove board pins and their pin links", async () => {
  const a = await noteId("Delete Board A");
  const b = await noteId("Delete Board B");
  await requestWrite({ type: "boardPinAction", action: { type: "add", noteId: a, x: 0.4, y: 0.5 } });
  await requestWrite({ type: "boardPinAction", action: { type: "add", noteId: "", x: 850, y: 450 } });
  await requestWrite({ type: "boardPinAction", action: { type: "add", noteId: "", x: 900, y: 500 } });
  await tick();
  let layout = notesStore.getLayout();
  const owned = Object.entries(layout.pins).find(([, pin]) => pin.noteId === a)[0];
  const [freeA, freeB] = Object.entries(layout.pins)
    .filter(([, pin]) => !pin.noteId).map(([id]) => id);
  assert.ok(owned && freeA && freeB);
  await requestWrite({ type: "boardPinAction", action: { type: "connect",
    source: `p:${owned}`, target: `p:${freeA}` } });
  await requestWrite({ type: "boardPinAction", action: { type: "connect",
    source: `p:${freeB}`, target: `n:${b}:main` } });
  await tick();
  layout = notesStore.getLayout();
  const ownedLink = Object.entries(layout.pinLinks)
    .find(([, link]) => link.source === `p:${owned}` || link.target === `p:${owned}`)[0];
  const freeBLink = Object.entries(layout.pinLinks)
    .find(([, link]) => link.source === `p:${freeB}` || link.target === `p:${freeB}`)[0];
  assert.ok(ownedLink && freeBLink);

  const actions = [];
  const canvas = canvasFor(actions);
  canvas.update(notesStore.getAllNotes(), layout);

  selectPin(canvas.root.querySelector(`[data-pin-ref="p:${owned}"]`));
  press(canvas, "Delete");
  await tick();
  assert.deepEqual(actions.at(-1), { type: "delete", ref: `p:${owned}` });
  assert.equal(notesStore.getLayout().pins[owned], undefined);
  assert.equal(notesStore.getLayout().pinLinks[ownedLink], undefined,
    "Delete removes pin links attached to the board pin");

  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  selectPin(canvas.root.querySelector(`[data-pin-ref="p:${freeB}"]`));
  press(canvas, "Backspace");
  await tick();
  assert.deepEqual(actions.at(-1), { type: "delete", ref: `p:${freeB}` });
  assert.equal(notesStore.getLayout().pins[freeB], undefined);
  assert.equal(notesStore.getLayout().pinLinks[freeBLink], undefined,
    "Backspace still deletes a selected movable pin");
  assert.ok(notesStore.getLayout().pins[freeA]);
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("Delete on a main pin is a no-op that cannot fall through to link deletion", async () => {
  const a = await noteId("Delete Main A");
  const b = await noteId("Delete Main B");
  await requestWrite({ type: "createLink", sourceId: a, targetId: b });
  await tick();
  const link = notesStore.getNote(a).system.links[0];
  assert.ok(link);
  const actions = [];
  let deletedLinks = 0;
  let deletedNotes = 0;
  const canvas = new JournalCanvas({ onSelectNote() {},
    onBoardPinAction: action => { actions.push(action); },
    onDeleteLink: () => { deletedLinks += 1; },
    onDeleteNote: () => { deletedNotes += 1; } });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  const main = canvas.root.querySelector(`[data-pin-ref="n:${a}:main"]`);
  assert.ok(main);

  selectPin(main);
  canvas.selectedLinkId = link.id;
  press(canvas, "Delete");
  press(canvas, "Backspace");
  await tick();

  assert.deepEqual(actions, [], "main pin sends no board-pin delete or disable request");
  assert.equal(deletedLinks, 0, "Delete does not fall through to the selected link");
  assert.equal(deletedNotes, 0);
  const layout = notesStore.getLayout();
  assert.ok(layout.cards[a].anchors.main, "the main pin anchor is still present");
  assert.ok(notesStore.getNote(a), "the note is intact");
  assert.ok(notesStore.getNote(a).system.links.some(item => item.id === link.id),
    "the note link is intact");
  assert.equal(canvas.root.querySelector(`[data-pin-ref="n:${a}:main"]`) !== null, true);
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("selected pins get feedback and clear on Escape, outside click and removal", async () => {
  const a = await noteId("Delete Feedback A");
  await requestWrite({ type: "addCardAnchor", noteId: a, kind: "minor", x: 0.3, y: 0.4 });
  await requestWrite({ type: "boardPinAction", action: { type: "add", noteId: a, x: 0.7, y: 0.3 } });
  await tick();
  const layout = notesStore.getLayout();
  const anchorId = Object.keys(layout.cards[a].anchors).find(id => id !== "main");
  const boardId = Object.keys(layout.pins).find(id => layout.pins[id].noteId === a);
  assert.ok(boardId);
  const actions = [];
  const canvas = canvasFor(actions);
  canvas.update(notesStore.getAllNotes(), layout);
  const minor = () => canvas.root.querySelector(`[data-pin-ref="n:${a}:${anchorId}"]`);
  const main = () => canvas.root.querySelector(`[data-pin-ref="n:${a}:main"]`);
  const board = () => canvas.root.querySelector(`[data-pin-ref="p:${boardId}"]`);
  const minorLabel = canvas.pinLayer.querySelector(`[data-pin-ref="n:${a}:${anchorId}"]`);
  const baseLabel = minorLabel.getAttribute("aria-label");

  selectPin(minor());
  assert.equal(minor().classList.contains("jn-pin-selected"), true);
  assert.equal(canvas.selectedPinRef, `n:${a}:${anchorId}`);
  assert.equal(minor().getAttribute("aria-label"),
    game.i18n.localize("JN.Pin.SelectedMinor"));
  assert.equal(minor().getAttribute("title"), game.i18n.localize("JN.Pin.SelectedMinor"));
  assert.match(minor().getAttribute("aria-label"), /Delete.*Backspace/);

  press(canvas, "Escape");
  assert.equal(canvas.selectedPinRef, null);
  assert.equal(minor().classList.contains("jn-pin-selected"), false);
  assert.equal(minor().getAttribute("aria-label"), baseLabel);
  assert.equal(minor().getAttribute("title"), null);

  selectPin(board());
  assert.equal(board().classList.contains("jn-pin-selected"), true);
  event(canvas.root, "pointerdown", 640, 420);
  event(canvas.root, "pointerup", 640, 420);
  assert.equal(canvas.selectedPinRef, null, "outside click clears the selected pin");
  assert.equal(board().classList.contains("jn-pin-selected"), false);

  selectPin(main());
  assert.equal(main().classList.contains("jn-pin-selected"), true);
  assert.equal(main().getAttribute("aria-label"), game.i18n.localize("JN.Pin.SelectedMain"));
  assert.match(main().getAttribute("aria-label"), /permanent/);
  press(canvas, "Escape");
  assert.equal(canvas.selectedPinRef, null);

  selectPin(board());
  assert.equal(canvas.selectedPinRef, `p:${boardId}`,
    "a board pin becomes the selected pin after the previous one is dismissed");
  const withoutPin = structuredClone(notesStore.getLayout());
  delete withoutPin.pins[boardId];
  canvas.update(notesStore.getAllNotes(), withoutPin);
  assert.equal(canvas.selectedPinRef, null, "a disappearing pin clears the selection");
  assert.equal(canvas.root.querySelector(`[data-pin-ref="p:${boardId}"]`), null);

  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  press(canvas, "Escape");
  selectPin(board());
  assert.equal(canvas.selectedPinRef, `p:${boardId}`, "board pin selected before the final delete");
  press(canvas, "Delete");
  press(canvas, "Delete");
  assert.equal(canvas.selectedPinRef, null);
  assert.equal(board().classList.contains("jn-pin-selected"), false,
    "successful delete removes the selected feedback immediately");
  await tick();
  assert.equal(notesStore.getLayout().pins[boardId], undefined);
  canvas.disconnectGeometry();
  canvas.root.remove();
});
