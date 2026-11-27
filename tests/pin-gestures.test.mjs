import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { anchorWorld } = await import("../scripts/anchors.mjs");
registerSocket();
const tick = () => new Promise(resolve => setTimeout(resolve, 50));
const frame = () => new Promise(resolve => dom.window.requestAnimationFrame(() => resolve()));
const event = (target, type, x = 0, y = 0, button = 0) => target.dispatchEvent(
  new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button })
);
const screenPoint = (canvas, x, y) => [x * canvas.view.k + canvas.view.x, y * canvas.view.k + canvas.view.y];

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
  let source = canvas.root.querySelector(`[data-pin-ref="n:${a.id}:main"]`);
  assert.ok(source);

  canvas.togglePinTool();
  assert.ok(canvas.root.classList.contains("jn-placing-pin"), "pin tool marks the canvas");
  event(cardA, "pointerdown", 70, 60);
  event(cardA, "pointerup", 70, 60);
  assert.deepEqual(actions.at(-1), { type: "add", noteId: a.id,
    x: (70 - 10) / 190, y: (60 - 20) / 70 });
  event(canvas.root, "pointerdown", 600, 300);
  event(canvas.root, "pointerup", 600, 300);
  assert.deepEqual(actions.at(-1), { type: "add", noteId: "", x: 600, y: 300 });
  canvas.togglePinTool();
  assert.equal(canvas.root.classList.contains("jn-placing-pin"), false,
    "toggling the pin tool off clears the placement class");
  canvas.togglePinTool();
  canvas.deactivatePinTool();
  assert.equal(canvas.root.classList.contains("jn-placing-pin"), false,
    "deactivation also clears the placement class");

  const manualId = "manual1";
  const layout = structuredClone(notesStore.getLayout());
  layout.pins = { [manualId]: { noteId: a.id, x: 0.3, y: 0.4, isDefault: false },
    free1: { noteId: "", x: 600, y: 300, isDefault: false } };
  layout.pinLinks = {};
  canvas.update(notes, layout);
  source = canvas.root.querySelector(`[data-pin-ref="n:${a.id}:main"]`);
  const manual = canvas.root.querySelector('[data-pin-ref="p:manual1"]');
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

test("pin tool paints a pin-tipped cursor on the canvas and its descendants", () => {
  const css = readFileSync(new URL("../styles/journal.css", import.meta.url), "utf8");
  const block = css.match(/\.jn-canvas\.jn-placing-pin,[\s\S]*?\}/)?.[0];
  assert.ok(block, "the pin tool cursor rule exists");
  assert.match(block, /\.jn-canvas\.jn-placing-pin\s+\.jn-world\s+\*/,
    "the rule covers every world descendant");
  const cursor = block.match(/cursor:\s*url\("data:image\/svg\+xml,([^"]+)"\)\s+(\d+)\s+(\d+),\s*crosshair;/);
  assert.ok(cursor, "cursor uses an inline SVG with a hotspot and crosshair fallback");
  const [, svg, hotX, hotY] = cursor;
  assert.match(svg, /width='28'%20height='28'/, "cursor is a compact 28px pin");
  assert.match(svg, /viewBox='0%200%2028%2028'/);
  assert.match(svg, /%3Cpath%20d='M14%2026\.5/, "cursor draws a pin body");
  assert.match(svg, /%3Ccircle%20cx='14'%20cy='11\.5'/, "cursor has a pin head");
  assert.match(svg, /stroke='%23241b22'/, "the pin has a dark outline for dark cork");
  assert.equal(`${hotX} ${hotY}`, "14 27", "the hotspot sits on the pin tip");
});

test("pin heads keep a fixed board size while their hit targets stay screen-sized through zoom", () => {
  const notes = notesStore.getAllNotes();
  const a = notes.find(note => note.name === "Pin A");
  const b = notes.find(note => note.name === "Pin B");
  const layout = structuredClone(notesStore.getLayout());
  layout.pins = { noteExtra: { noteId: a.id, x: 0.4, y: 0.5, isDefault: false },
    standalone: { noteId: "", x: 700, y: 300, isDefault: false } };
  layout.pinLinks = { visible: { source: "p:noteExtra", target: "p:standalone" } };
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.append(canvas.root);
  canvas.update(notes, layout);
  const worldChildren = [...canvas.world.children];
  assert.ok(worldChildren.indexOf(canvas.pinLayer) > worldChildren.indexOf(canvas.svg));
  assert.ok(worldChildren.indexOf(canvas.pinLayer) > worldChildren.indexOf(canvas.pinLinksSvg));
  const refs = [`n:${a.id}:main`, "p:noteExtra", "p:standalone"];
  for (const k of [0.35, 0.8, 1.5, 2.8]) {
    canvas.view.k = k;
    canvas.refreshGeometry();
    assert.equal(Number.parseFloat(canvas.root.style.getPropertyValue("--jn-main-pin-size")), 14,
      "pin heads keep their world size instead of growing at low zoom");
    assert.equal(Number.parseFloat(canvas.root.style.getPropertyValue("--jn-pin-hit-size")) * k, 20,
      "the hit target stays 20px on screen");
    for (const ref of refs) assert.ok(canvas.pinLayer.querySelector(`[data-pin-ref="${ref}"]`));
    const pin = canvas.pinLayer.querySelector('[data-pin-ref="p:noteExtra"]');
    pin.dispatchEvent(new dom.window.WheelEvent("wheel", {
      bubbles: true, cancelable: true, clientX: 20, clientY: 20, deltaY: 20
    }));
    assert.equal(Number.parseFloat(canvas.root.style.getPropertyValue("--jn-main-pin-size")), 14,
      "wheel zoom leaves the pin head at its fixed world size");
    assert.ok(Math.abs(Number.parseFloat(canvas.root.style.getPropertyValue("--jn-pin-hit-size")) * canvas.view.k - 20) < 1e-9,
      "zoom compensation updates the hit target in the same wheel event");
  }
  const path = canvas.pinLinksSvg.querySelector('[data-pin-link="visible"] .jn-thread-layer');
  assert.ok(path?.getAttribute("d"));
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("the link magnet snaps within the screen-space pin hitbox at every zoom", () => {
  const id = "pinMagnet0000001";
  const note = {
    _id: id, name: "Magnet note",
    system: {
      style: "sticky", authorId: user.id, blocks: [], links: [],
      attachment: { mainPinEnabled: true, mainSnapRadius: 1, minorSnapRadius: 1, pinStyle: "enamel" }
    }
  };
  const layout = {
    cards: {
      [id]: {
        x: 100, y: 100, width: 200, height: 100, rotation: 0,
        anchors: {
          main: { kind: "main", x: 0.5, y: 0, createdBy: user.id },
          magnet: { kind: "minor", x: 0.5, y: 0.5, createdBy: user.id }
        }
      }
    },
    labels: {}
  };
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  try {
    canvas.update([note], layout);
    canvas.toggleLinkTool();
    const card = canvas.cardEls.get(id);
    const pin = canvas.pinLayer.querySelector(`[data-pin-ref="n:${id}:magnet"]`);
    const preview = () => canvas.svg.querySelector(".jn-pin-target");
    const hover = (k, worldX, worldY) => {
      canvas.view = { x: 0, y: 0, k };
      canvas.refreshGeometry();
      card.dispatchEvent(new MouseEvent("pointermove", {
        bubbles: true, clientX: worldX * k, clientY: worldY * k
      }));
    };

    // The pin sits at world (200, 150); its hit target is 10 screen px around that point even
    // though this note's configured minor magnet is only 1px.
    hover(1, 208, 150);
    assert.equal(preview()?.dataset.anchorId, "magnet", "a link touching the hitbox snaps to the pin");
    assert.ok(pin.classList.contains("jn-pin-snap"));

    hover(0.5, 218, 150); // 18 world px = 9 screen px from the pin.
    assert.equal(preview()?.dataset.anchorId, "magnet",
      "the hitbox scales with the board, so the same screen distance still snaps when zoomed out");
    assert.ok(pin.classList.contains("jn-pin-snap"));

    hover(2, 218, 150); // The same world point is now 36 screen px away.
    assert.notEqual(preview()?.dataset.anchorId, "magnet",
      "zooming in shrinks the world-space hitbox instead of making the magnet enormous");
    assert.equal(pin.classList.contains("jn-pin-snap"), false);

    hover(4, 206.25, 150); // 25 screen px away: outside the 20px target, but on the 56px head.
    assert.equal(preview()?.dataset.anchorId, "magnet",
      "when the visible head grows past the minimum target, the magnet grows with it");
  } finally {
    canvas.cancelLinkTool();
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("box selection includes free pins and moves them with the selected notes", async () => {
  const noteId = "pinSelect0000001";
  const note = {
    _id: noteId, name: "Selection note",
    system: {
      style: "sticky", authorId: user.id, blocks: [], links: [],
      attachment: { mainPinEnabled: true, pinStyle: "enamel" }
    }
  };
  const layout = {
    cards: {
      [noteId]: {
        x: 100, y: 100, width: 200, height: 100, rotation: 0,
        anchors: { main: { kind: "main", x: 0.5, y: 0, createdBy: user.id } }
      }
    },
    labels: {},
    pins: { free: { noteId: "", x: 350, y: 150, isDefault: false } },
    pinLinks: {}
  };
  const movedCards = [];
  const pinActions = [];
  const canvas = new JournalCanvas({
    onSelectNote() {},
    onMoveCard: (...args) => movedCards.push(args),
    onBoardPinAction: action => { pinActions.push(action); }
  });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  try {
    canvas.update([note], layout);
    const card = canvas.cardEls.get(noteId);
    card.getBoundingClientRect = () => ({
      left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100
    });
    const pointer = (type, x, y) => canvas.root.dispatchEvent(new MouseEvent(type, {
      bubbles: true, button: 0, clientX: x, clientY: y
    }));

    pointer("pointerdown", 90, 90);
    pointer("pointermove", 400, 250);
    pointer("pointerup", 400, 250);
    assert.deepEqual(canvas.getSelectedNoteIds(), [noteId]);
    assert.deepEqual(canvas.getSelectedPinRefs(), ["p:free"]);
    assert.ok(card.classList.contains("selected"));
    assert.ok(canvas.pinLayer.querySelector('[data-pin-ref="p:free"]').classList.contains("jn-pin-selected"));

    event(card, "pointerdown", 150, 150);
    event(canvas.root, "pointermove", 200, 180);
    await frame();
    const freePin = canvas.pinLayer.querySelector('[data-pin-ref="p:free"]');
    assert.equal(Number.parseFloat(freePin.style.left), 400,
      "the selected free pin follows the note group before release");
    assert.equal(Number.parseFloat(freePin.style.top), 180);
    event(canvas.root, "pointerup", 200, 180);

    assert.deepEqual(movedCards.at(-1), [noteId, 150, 130]);
    assert.deepEqual(pinActions.at(-1), { type: "move", ref: "p:free", noteId: "", x: 400, y: 180 });
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("box-selecting an attached pin selects its owning note, not an independent pin", () => {
  const noteId = "pinAttachSelect01";
  const note = {
    _id: noteId, name: "Attached selection",
    system: {
      style: "sticky", authorId: user.id, blocks: [], links: [],
      attachment: { mainPinEnabled: true, pinStyle: "enamel" }
    }
  };
  const layout = {
    cards: {
      [noteId]: {
        x: 100, y: 100, width: 200, height: 100, rotation: 0,
        anchors: { main: { kind: "main", x: 0.5, y: 0, createdBy: user.id } }
      }
    },
    labels: {}, pins: {}, pinLinks: {}
  };
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  try {
    canvas.update([note], layout);
    const pointer = (type, x, y) => canvas.root.dispatchEvent(new MouseEvent(type, {
      bubbles: true, button: 0, clientX: x, clientY: y
    }));
    pointer("pointerdown", 195, 95);
    pointer("pointermove", 205, 105);
    pointer("pointerup", 205, 105);
    assert.deepEqual(canvas.getSelectedNoteIds(), [noteId]);
    assert.deepEqual(canvas.getSelectedPinRefs(), [],
      "the attached pin is part of its note, not a separate board object");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("double-click type menu creates once at the original panned world point", () => {
  const a = notesStore.getAllNotes().find(note => note.name === "Pin A");
  const calls = [];
  const canvas = new JournalCanvas({ onSelectNote() {},
    onEditCardBlock: (...args) => calls.push(["edit", ...args]),
    onCreateNoteAt: (...args) => calls.push(["create", ...args]) });
  document.body.append(canvas.root);
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  canvas.view = { x: 60, y: -25, k: 1.6 };
  canvas.refreshGeometry();
  const card = canvas.cardEls.get(a.id);
  const text = card.querySelector('[data-card-text="block"]');
  const pin = canvas.pinLayer.querySelector(`[data-pin-ref="n:${a.id}:main"]`);
  event(text, "dblclick", 90, 70);
  assert.equal(calls.filter(call => call[0] === "edit").length, 1);
  event(card, "dblclick", 90, 70);
  event(pin, "dblclick", 90, 70);
  assert.notEqual(canvas.contextMenu.style.display, "flex");
  const world = { x: 1200, y: 800 };
  const screen = { x: world.x * canvas.view.k + canvas.view.x,
    y: world.y * canvas.view.k + canvas.view.y };
  const kinds = ["note", "memo", "document", "target", "location"];
  for (const kind of kinds) {
    event(canvas.root, "dblclick", screen.x, screen.y);
    assert.deepEqual([...canvas.contextMenu.querySelectorAll("[data-action]")]
      .map(button => button.dataset.action).filter(action => kinds.includes(action)), kinds);
    const before = calls.length;
    canvas.contextMenu.querySelector(`[data-action="${kind}"]`).click();
    assert.equal(calls.length, before + 1);
    const [, x, y, options] = calls.at(-1);
    assert.ok(Math.abs(x + ({ note: 60, memo: 180, document: 124, target: 126, location: 122.5 }[kind]) - world.x) < 1e-6);
    assert.ok(Math.abs(y + (kind === "note" ? 30 : kind === "location" ? 45 : 40) - world.y) < 1e-6);
    assert.equal(options.kind, kind === "location" ? "location" : "note");
  }
  event(canvas.root, "dblclick", screen.x, screen.y);
  const beforeDismiss = calls.length;
  event(canvas.root, "pointerdown", screen.x + 100, screen.y + 100);
  assert.equal(calls.length, beforeDismiss);
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("pin Backspace removes attached connections while preserving text editing and default pins", async () => {
  const a = notesStore.getAllNotes().find(note => note.name === "Pin A");
  const b = notesStore.getAllNotes().find(note => note.name === "Pin B");
  await requestWrite({ type: "boardPinAction", action: { type: "add", noteId: a.id, x: 0.6, y: 0.5 } });
  await requestWrite({ type: "boardPinAction", action: { type: "add", noteId: "", x: 850, y: 450 } });
  await tick();
  let layout = notesStore.getLayout();
  const owned = Object.entries(layout.pins).find(([, pin]) => pin.noteId === a.id)[0];
  const free = Object.entries(layout.pins).find(([, pin]) => !pin.noteId)[0];
  await requestWrite({ type: "boardPinAction", action: { type: "connect",
    source: `p:${owned}`, target: `p:${free}` } });
  await tick();
  layout = notesStore.getLayout();
  const linkId = Object.keys(layout.pinLinks)[0];
  const canvas = new JournalCanvas({ onSelectNote() {}, onBoardPinAction: action =>
    requestWrite({ type: "boardPinAction", action }) });
  document.body.append(canvas.root);
  canvas.update(notesStore.getAllNotes(), layout);
  const hit = canvas.pinLinksSvg.querySelector(`[data-pin-link="${linkId}"] .jn-pin-link-hit`);
  assert.ok(hit);
  event(hit, "pointerdown", 500, 300);
  event(hit, "pointerup", 500, 300);
  assert.equal(canvas.linkToolbar.style.display, "flex");
  const thickness = canvas.linkToolbar.querySelector(".jn-link-thickness");
  thickness.value = "4.2";
  thickness.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  assert.equal(notesStore.getLayout().pinLinks[linkId].thickness, 4.2);
  const pin = canvas.pinLayer.querySelector(`[data-pin-ref="p:${owned}"]`);
  event(pin, "pointerdown", 124, 55);
  event(pin, "pointerup", 124, 55);
  canvas.root.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }));
  await tick();
  layout = notesStore.getLayout();
  assert.equal(layout.pins[owned], undefined);
  assert.equal(layout.pinLinks[linkId], undefined);
  const defaultPin = canvas.pinLayer.querySelector(`[data-pin-ref="n:${a.id}:main"]`);
  event(defaultPin, "pointerdown", 105, 20);
  event(defaultPin, "pointerup", 105, 20);
  canvas.root.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }));
  assert.ok(notesStore.getLayout().cards[a.id].anchors.main);
  const input = document.createElement("input");
  canvas.root.append(input);
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }));
  assert.ok(notesStore.getLayout().pins[free]);
  await requestWrite({ type: "boardPinAction", action: { type: "delete", ref: `p:${free}` } });
  await tick();
  assert.equal(notesStore.getLayout().pins[free], undefined);
  const reloaded = new JournalCanvas({ onSelectNote() {} });
  document.body.append(reloaded.root);
  reloaded.update(notesStore.getAllNotes(), notesStore.getLayout());
  assert.equal(reloaded.pinLinksSvg.querySelector(`[data-pin-link="${linkId}"]`), null);
  reloaded.disconnectGeometry();
  reloaded.root.remove();
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
  const pin = canvas.root.querySelector(`[data-pin-ref="n:${a.id}:main"]`);
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
  assert.equal(calls.filter(call => call[0] === "create").length, 0);
  assert.equal(canvas.contextMenu.style.display, "flex");
  canvas.contextMenu.querySelector('[data-action="note"]').click();
  assert.equal(calls.filter(call => call[0] === "create").length, 1);
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("only a genuine empty-canvas double click opens the board menu after pin gestures", async () => {
  const notes = notesStore.getAllNotes();
  const a = notes.find(note => note.name === "Pin A");
  const layout = structuredClone(notesStore.getLayout());
  layout.pins = { menuPin: { noteId: "", x: 300, y: 200, isDefault: false } };
  layout.pinLinks = {};
  const calls = [];
  const actions = [];
  const canvas = new JournalCanvas({ onSelectNote() {},
    onBoardPinAction: action => { actions.push(action); },
    onEditCardBlock: (...args) => calls.push(["edit", ...args]),
    onCreateNoteAt: (...args) => calls.push(["create", ...args]) });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  canvas.update(notes, layout);
  const card = canvas.cardEls.get(a.id);
  const text = card.querySelector('[data-card-text="block"]');
  const pin = canvas.root.querySelector('[data-pin-ref="p:menuPin"]');
  assert.ok(text && pin);

  event(text, "dblclick", 40, 50);
  assert.equal(calls.filter(call => call[0] === "edit").length, 1,
    "double-clicking note text still edits it");
  event(card, "dblclick", 40, 50);
  event(pin, "dblclick", 300, 200);
  assert.notEqual(canvas.contextMenu.style.display, "flex",
    "cards and pins never open the board menu");

  // Leave a board click at the future release point, then move a pin there. The old stale
  // click and the native dblclick released over empty canvas must not open the menu.
  event(canvas.root, "pointerdown", 760, 520);
  event(canvas.root, "pointerup", 760, 520);
  event(pin, "pointerdown", 300, 200);
  event(pin, "pointerup", 300, 200);
  event(pin, "pointerdown", 300, 200);
  event(canvas.root, "pointermove", 760, 520);
  event(canvas.root, "pointerup", 760, 520);
  assert.deepEqual(actions.at(-1), { type: "move", ref: "p:menuPin", noteId: "", x: 760, y: 520 });
  assert.notEqual(canvas.contextMenu.style.display, "flex",
    "releasing a moved pin on empty canvas does not open the menu");

  event(canvas.root, "pointerdown", 760, 520);
  event(canvas.root, "pointerup", 760, 520);
  assert.notEqual(canvas.contextMenu.style.display, "flex",
    "a stale board click cannot pair with the pin release");

  event(canvas.root, "dblclick", 760, 520);
  assert.notEqual(canvas.contextMenu.style.display, "flex",
    "a native dblclick at the pin release point is ignored");

  const fresh = new JournalCanvas({ onSelectNote() {},
    onCreateNoteAt: (...args) => calls.push(["create", ...args]) });
  document.body.append(fresh.root);
  fresh.update(notes, layout);
  event(fresh.root, "dblclick", 900, 500);
  assert.equal(fresh.contextMenu.style.display, "flex",
    "a genuine empty-canvas double click still opens the note-type menu");
  const kinds = ["note", "memo", "document", "target", "location"];
  assert.deepEqual([...fresh.contextMenu.querySelectorAll("[data-action]")]
    .map(button => button.dataset.action).filter(action => kinds.includes(action)), kinds);
  fresh.disconnectGeometry();
  fresh.root.remove();
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("pin drag repaints attached threads and pin links in place before release", async () => {
  await requestWrite({ type: "createNote", title: "Drag Pin A", x: 40, y: 40 });
  await requestWrite({ type: "createNote", title: "Drag Pin B", x: 560, y: 340 });
  await tick();
  const notes = notesStore.getAllNotes();
  const a = notes.find(note => note.name === "Drag Pin A");
  const b = notes.find(note => note.name === "Drag Pin B");
  assert.ok(a && b);
  await requestWrite({ type: "boardPinAction", action: { type: "add", noteId: a.id, x: 0.25, y: 0.75 } });
  await requestWrite({ type: "boardPinAction", action: { type: "add", noteId: "", x: 900, y: 700 } });
  await tick();
  const layout = structuredClone(notesStore.getLayout());
  const ownedId = Object.keys(layout.pins).find(id => layout.pins[id].noteId === a.id);
  const freeId = Object.keys(layout.pins).find(id => layout.pins[id].noteId === "");
  assert.ok(ownedId && freeId);
  layout.pinLinks = { dragPinLink: {
    source: `p:${ownedId}`, target: `p:${freeId}`, label: "pin link",
    color: "", secondaryColor: "", material: "linen", thickness: 2.6, slack: 0.09,
    pattern: "continuous", ends: "standard"
  } };
  const dragNotes = structuredClone(notes);
  const linkId = "dragNormalLink";
  dragNotes.find(note => note._id === a.id).system.links = [{
    id: linkId, targetId: b.id, sourcePinRef: `p:${ownedId}`, sourceAnchorId: "",
    targetPinRef: "", targetAnchorId: "main", sourceSide: "right", targetSide: "left",
    color: "", label: "normal"
  }];
  const actions = [];
  const canvas = new JournalCanvas({ onSelectNote() {},
    onBoardPinAction: action => { actions.push(action); } });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  canvas.update(dragNotes, layout);
  const normalPath = canvas.svg.querySelector(`g[data-id="${linkId}"] .jn-thread-layer`);
  const pinGroup = canvas.pinLinksSvg.querySelector('[data-pin-link="dragPinLink"]');
  const pinPath = pinGroup.querySelector(".jn-thread-layer");
  assert.ok(normalPath?.getAttribute("d") && pinPath?.getAttribute("d"));
  const beforeNormal = normalPath.getAttribute("d");
  const beforePin = pinPath.getAttribute("d");
  const pin = canvas.root.querySelector(`[data-pin-ref="p:${ownedId}"]`);
  assert.ok(pin);

  event(pin, "pointerdown", 100, 100);
  event(pin, "pointerup", 100, 100);
  event(pin, "pointerdown", 100, 100);
  const target = { x: 960, y: 760 };
  const [sx, sy] = screenPoint(canvas, target.x, target.y);
  event(canvas.root, "pointermove", sx, sy);
  const ghost = canvas.pinLayer.querySelector(".jn-moving-pin");
  assert.ok(ghost, "the pin is picked up immediately");
  assert.match(ghost.style.transform, new RegExp(`translate3d\\(${target.x}px, ${target.y}px`),
    "the ghost follows the pointer through a composited transform");
  assert.equal(actions.length, 0, "no write happens on pointermove");

  await frame();
  assert.notEqual(normalPath.getAttribute("d"), beforeNormal,
    "the attached normal thread follows the ghost before release");
  assert.notEqual(pinPath.getAttribute("d"), beforePin,
    "the attached pin link follows the ghost before release");
  assert.equal(canvas.pinLinksSvg.querySelector('[data-pin-link="dragPinLink"]'), pinGroup,
    "the fast path reuses the existing pin-link group");
  assert.equal(pinGroup.querySelector(".jn-thread-layer"), pinPath,
    "existing pin-link paths are updated in place");
  assert.ok(pinGroup.classList.contains("jn-link-material-linen"));
  assert.equal(pinGroup.querySelector(".jn-link-label")?.textContent, "pin link");

  event(canvas.root, "pointerup", sx, sy);
  assert.equal(actions.length, 1, "release emits one final move write");
  assert.deepEqual(actions[0], { type: "move", ref: `p:${ownedId}`,
    noteId: "", x: target.x, y: target.y });
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("dragging a note pin never uses percent positions or snaps back before its write", async () => {
  await requestWrite({ type: "createNote", title: "Minor Drag", x: 40, y: 40 });
  await requestWrite({ type: "createNote", title: "Minor Drag Target", x: 600, y: 400 });
  await tick();
  const notes = notesStore.getAllNotes();
  const a = notes.find(note => note.name === "Minor Drag");
  const b = notes.find(note => note.name === "Minor Drag Target");
  assert.ok(a && b);
  await requestWrite({ type: "addCardAnchor", noteId: a.id, kind: "minor", x: 0.3, y: 0.7 });
  await tick();
  const layout = notesStore.getLayout();
  const anchorId = Object.keys(layout.cards[a.id].anchors).find(id => id !== "main");
  assert.ok(anchorId);
  await requestWrite({ type: "createLink", sourceId: a.id, targetId: b.id,
    sourceAnchorId: anchorId, targetAnchorId: "main" });
  await tick();
  const link = notesStore.getNote(a.id).system.links.find(item => item.targetId === b.id);
  assert.ok(link);
  const canvas = new JournalCanvas({ onSelectNote() {},
    onBoardPinAction: () => new Promise(() => {}) });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  const pin = canvas.root.querySelector(`[data-pin-ref="n:${a.id}:${anchorId}"]`);
  const path = canvas.svg.querySelector(`g[data-id="${link.id}"] .jn-thread-layer`);
  assert.ok(pin && path?.getAttribute("d"));
  const before = { left: pin.style.left, top: pin.style.top };
  const beforePath = path.getAttribute("d");
  assert.match(before.left, /px$/);

  event(pin, "pointerdown", 100, 100);
  event(pin, "pointerup", 100, 100);
  event(pin, "pointerdown", 100, 100);
  const target = { x: 980, y: 780 };
  const [sx, sy] = screenPoint(canvas, target.x, target.y);
  event(canvas.root, "pointermove", sx, sy);
  await frame();
  assert.notEqual(path.getAttribute("d"), beforePath,
    "a link attached by anchor id follows the moving note pin");
  const ghost = canvas.pinLayer.querySelector(".jn-moving-pin");
  assert.ok(ghost, "the dragged pin has a live ghost");
  assert.match(ghost.style.transform, new RegExp(`translate3d\\(${target.x}px, ${target.y}px`),
    "the ghost follows the pointer in world pixels without a percent position");
  assert.equal(pin.style.visibility, "hidden", "the stored pin is hidden under the ghost");

  event(canvas.root, "pointerup", sx, sy);
  assert.equal(canvas.pinOverride?.ref, `n:${a.id}:${anchorId}`);
  assert.match(ghost.style.transform, new RegExp(`translate3d\\(${target.x}px, ${target.y}px`),
    "the pending write keeps the ghost at the drop point");
  assert.equal(pin.style.visibility, "hidden");
  assert.equal(Number.parseFloat(pin.style.left), target.x,
    "the hidden pin follows the pending override in world pixels");
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

test("duplicate legacy anchors render one pin and no small endpoint dots", () => {
  const aId = "pinstack00000001";
  const bId = "pinstack00000002";
  const note = (id, links = []) => ({
    _id: id, name: id,
    system: {
      style: "sticky", authorId: user.id, blocks: [], links,
      attachment: { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "enamel" }
    }
  });
  const links = [
    { id: "dup", targetId: bId, sourceAnchorId: "dup1", targetAnchorId: "main" },
    { id: "legacy", targetId: bId, sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 } }
  ];
  const layout = {
    cards: {
      [aId]: { x: 0, y: 0, width: 200, height: 100, rotation: 0, anchors: {
        main: { kind: "main", x: 0.5, y: 0, createdBy: user.id },
        dup1: { kind: "minor", x: 0.5, y: 0, createdBy: user.id },
        dup2: { kind: "minor", x: 0.5, y: 0, createdBy: user.id }
      } },
      [bId]: { x: 400, y: 0, width: 200, height: 100, rotation: 0, anchors: {
        main: { kind: "main", x: 0.5, y: 0, createdBy: user.id }
      } }
    },
    labels: {}
  };
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  try {
    canvas.update([note(aId, links), note(bId)], layout);
    const pins = canvas.root.querySelectorAll(`.jn-pin-layer [data-note-id="${aId}"]`);
    assert.equal(pins.length, 1, "three coincident anchors paint one physical pin");
    assert.equal(pins[0].dataset.anchorId, "main", "the main pin is the canonical visible pin");
    const endpoints = [...canvas.svg.querySelectorAll(".jn-thread-pin:not(.jn-board-pin)")];
    assert.ok(endpoints.length > 0);
    assert.ok(endpoints.every(pin => pin.classList.contains("jn-thread-pin-attached")),
      "with pins enabled there are no small SVG endpoint pins, including legacy point-only links");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("deferred render measures a reconnected auto-sized rotated card before placing pins", () => {
  const noteId = "pinMeasure000001";
  const note = {
    _id: noteId, name: "Tall measured note",
    system: {
      style: "sticky", authorId: user.id, blocks: [], links: [],
      attachment: { mainPinEnabled: true, pinStyle: "enamel" }
    }
  };
  const baseCard = { x: 120, y: 80, rotation: 23, anchors: {} };
  const anchors = {
    main: { kind: "main", x: 0.5, y: 0, createdBy: user.id },
    inner: { kind: "minor", x: 0.31, y: 0.62, createdBy: user.id }
  };
  const card = { ...baseCard, anchors };
  const layout = {
    cards: { [noteId]: card },
    labels: {},
    pins: {
      attached: { noteId, x: 0.78, y: 0.23, isDefault: false },
      free: { noteId: "", x: 900, y: 430, isDefault: false }
    },
    pinLinks: {
      attachedWire: { source: "p:attached", target: `n:${noteId}:main` },
      freeWire: { source: "p:free", target: `n:${noteId}:inner` }
    }
  };
  const refs = {
    main: `n:${noteId}:main`,
    inner: `n:${noteId}:inner`,
    attached: "p:attached",
    free: "p:free"
  };
  const expectedBox = { x: baseCard.x, y: baseCard.y, w: 360, h: 420, rotation: baseCard.rotation };
  const expectedPoint = ref => {
    if (ref.startsWith("p:")) {
      const data = layout.pins[ref.slice(2)];
      if (!data.noteId) return { x: data.x, y: data.y };
      return anchorWorld(expectedBox, { ...data, kind: "minor" });
    }
    return anchorWorld(expectedBox, anchors[ref.slice(ref.lastIndexOf(":") + 1)]);
  };
  const assertPins = (canvas, label) => {
    for (const ref of Object.values(refs)) {
      const el = canvas.pinLayer.querySelector(`[data-pin-ref="${ref}"]`);
      assert.ok(el, `${label}: ${ref} renders`);
      const actual = { left: Number.parseFloat(el.style.left), top: Number.parseFloat(el.style.top) };
      const expected = expectedPoint(ref);
      assert.ok(Math.abs(actual.left - expected.x) < 1e-6 && Math.abs(actual.top - expected.y) < 1e-6,
        `${label}: ${ref} at ${actual.left},${actual.top}; expected ${expected.x},${expected.y}`);
    }
  };
  const pinPaths = canvas => new Map([...canvas.pinLinksSvg.querySelectorAll("g[data-pin-link]")]
    .map(group => [group.dataset.pinLink, group.querySelector(".jn-pin-link-hit")?.getAttribute("d")]));

  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const canvas = new JournalCanvas({ onSelectNote() {} });
  canvas.pinsEnabled = true;
  try {
    // Create the card element while detached, then make the real (unchanged) auto-size visible
    // only when the canvas is connected. The initial anchor-free pass avoids inventing a size.
    canvas.update([note], { cards: { [noteId]: baseCard }, labels: {} }, { deferGeometry: true });
    const cardEl = canvas.cardEls.get(noteId);
    Object.defineProperty(cardEl, "offsetWidth", {
      configurable: true, get: () => canvas.root.isConnected ? 360 : 0
    });
    Object.defineProperty(cardEl, "offsetHeight", {
      configurable: true, get: () => canvas.root.isConnected ? 420 : 0
    });

    document.body.append(canvas.root);
    canvas.view = { x: 41, y: -27, k: 1.45 };
    canvas.update([note], layout);
    assertPins(canvas, "connected render");
    assert.deepEqual(canvas.cardSizes.get(noteId), { w: 360, h: 420 });
    const connectedPaths = pinPaths(canvas);
    assert.equal(connectedPaths.size, 2);

    canvas.root.remove();
    canvas.update([note], layout, { deferGeometry: true });
    assert.equal(canvas.cardSizes.has(noteId), false,
      "a detached deferred render never caches fallback dimensions");
    assert.equal(canvas.unmeasuredCards.has(noteId), true);

    // Reconnect at exactly the same real dimensions. The existing ResizeObserver never fires,
    // so only the refresh's own measurement can put the pins and thread endpoints back.
    document.body.append(canvas.root);
    canvas.refreshGeometry();
    assertPins(canvas, "immediately after reconnect");
    assert.deepEqual(pinPaths(canvas), connectedPaths,
      "pin-link thread endpoints use the measured card box, not the detached placeholder");
    assert.deepEqual(canvas.cardSizes.get(noteId), { w: 360, h: 420 });
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
    if (originalObserver) globalThis.ResizeObserver = originalObserver;
    else delete globalThis.ResizeObserver;
  }
});
