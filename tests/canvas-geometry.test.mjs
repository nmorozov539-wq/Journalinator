import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const { installFoundry, makeContainers, makeUser } = await import("./fake-foundry.mjs");
const gm = makeUser("GM00000000000001", { isGM: true, name: "GM" });
const env = installFoundry({ user: gm, users: [gm] });
await makeContainers(env);
foundry.utils.cleanHTML = html => html;
foundry.applications = { api: { DialogV2: { confirm: async () => true, wait: async () => null } } };

const socket = await import("../scripts/socket.mjs");
socket.registerSocket();
const { notesStore } = await import("../scripts/store/notes-store.mjs");
const { default: JournalCanvas } = await import("../scripts/app/canvas.mjs");
const { MAIN_ANCHOR_ID, anchorWorld } = await import("../scripts/anchors.mjs");
const {
  mainPinWorld, moveOrigin, originFromBox, translateForAutoOrigin
} = await import("../scripts/sizing/geometry.mjs");

const BASE_SKIN = { paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 0 };

function measure({ kind, text, parsed, width }) {
  if (kind === "text") return String(text ?? "").length * 8;
  if (kind === "height") {
    const inner = Math.max(60, Number(width) - 40);
    let lines = 0;
    for (const line of String(parsed?.body ?? "").split("\n")) {
      lines += Math.max(1, Math.ceil((line.length * 8) / inner));
    }
    return 40 + lines * 24;
  }
  return null;
}

async function createNote({ body = "", layout = "plain", x = 10, y = 20 } = {}) {
  const reply = await socket.requestEditReply({
    type: "createNote", body, layout, skin: BASE_SKIN, x, y, requestEdit: false
  });
  assert.equal(reply.type, "noteCreated");
  return notesStore.getNote(reply.noteId);
}

function mountCanvas(notes, layout = notesStore.getLayout(), callbacks = {}) {
  const canvas = new JournalCanvas({ onSelectNote() {}, measure, ...callbacks });
  document.body.append(canvas.root);
  canvas.update(notes, layout);
  return canvas;
}

function cleanup(canvas) {
  canvas.disconnectGeometry();
  canvas.root.remove();
}

function pin(canvas, noteId, anchorId = MAIN_ANCHOR_ID) {
  return canvas.root.querySelector(`[data-pin-ref="n:${noteId}:${anchorId}"]`);
}

function freePin(canvas, pinId) {
  return canvas.root.querySelector(`[data-pin-ref="p:${pinId}"]`);
}

function namedPinCard(rotation = 0) {
  return {
    rotation,
    anchors: { main: { kind: "main", x: 0.5, y: 0, createdBy: "" } },
    attachment: { mainPinEnabled: true }
  };
}

function assertNear(actual, expected, message, tolerance = 1) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} vs ${expected}`);
}

test("main pin world point is invariant across grow/shrink at every rotation", () => {
  const card = namedPinCard();
  const start = { x: 100, y: 50, w: 220, h: 120, rotation: 0 };
  for (const rotation of [0, 23, -17, 90]) {
    const origin = originFromBox(start, rotation);
    let box = { ...start };
    for (const [w, h] of [[220, 120], [380, 300], [300, 180], [380, 120], [220, 120]]) {
      const topLeft = translateForAutoOrigin({ origin, w, h, rotation });
      box = { ...topLeft, w, h, rotation };
      const world = mainPinWorld(card, box, rotation);
      assertNear(world.x, origin.x, `x invariant at ${rotation}deg/${w}x${h}`, 1e-9);
      assertNear(world.y, origin.y, `y invariant at ${rotation}deg/${w}x${h}`, 1e-9);
    }
    // Repeated cycles return to the same top-left, with no accumulated drift.
    const returned = translateForAutoOrigin({ origin, w: start.w, h: start.h, rotation });
    assertNear(returned.x, start.x, `cycle x stable at ${rotation}deg`, 1e-9);
    assertNear(returned.y, start.y, `cycle y stable at ${rotation}deg`, 1e-9);
  }
});

test("a disabled or missing main pin uses the virtual top-center origin", () => {
  const box = { x: 30, y: 40, w: 220, h: 120, rotation: 0 };
  for (const card of [
    namedPinCard(),
    { ...namedPinCard(), attachment: { mainPinEnabled: false } },
    { anchors: {}, attachment: { mainPinEnabled: true } }
  ]) {
    const origin = originFromBox(box, 0);
    assert.deepEqual(mainPinWorld(card, box, 0), origin);
  }
});

test("moving an automatic card translates its origin by the same delta", () => {
  const card = namedPinCard(14);
  const origin = originFromBox({ x: 100, y: 50, w: 300, h: 180, rotation: 14 }, 14);
  const moved = moveOrigin(origin, 45, -20);
  const y = translateForAutoOrigin({ origin: moved, w: 300, h: 180, rotation: 14 });
  const world = mainPinWorld(card, { ...y, w: 300, h: 180, rotation: 14 }, 14);
  assertNear(world.x, origin.x + 45, "x moved", 1e-9);
  assertNear(world.y, origin.y - 20, "y moved", 1e-9);
});

test("canvas derives auto width/height and keeps the main pin fixed across updates", async () => {
  const note = await createNote({ body: "# Auto\n\nshort body" });
  const canvas = mountCanvas([note]);
  try {
    const card = canvas.cardEls.get(note._id);
    const origin = notesStore.getLayout().cards[note._id].autoSizeOrigin;
    assert.equal(card.style.width, "220px");
    assert.ok(Number.parseFloat(card.style.minHeight) >= 120);
    assertNear(Number.parseFloat(pin(canvas, note._id).style.left), origin.x, "initial pin x");
    assertNear(Number.parseFloat(pin(canvas, note._id).style.top), origin.y, "initial pin y");

    const grown = { ...note, system: { ...note.system, body: "# Auto\n\n" + "x".repeat(40) } };
    canvas.update([grown], notesStore.getLayout());
    assert.equal(card.style.width, "380px", "long unbroken run widens one step family");
    assertNear(Number.parseFloat(pin(canvas, note._id).style.left), origin.x, "grown pin x");
    assertNear(Number.parseFloat(pin(canvas, note._id).style.top), origin.y, "grown pin y");

    canvas.update([note], notesStore.getLayout());
    assert.equal(card.style.width, "220px", "deletion shrinks without hysteresis");
    assertNear(Number.parseFloat(pin(canvas, note._id).style.left), origin.x, "shrunk pin x");
    assertNear(Number.parseFloat(pin(canvas, note._id).style.top), origin.y, "shrunk pin y");
  } finally { cleanup(canvas); }
});

test("a missing autoSizeOrigin initializes from the measured box without drift", async () => {
  const note = await createNote({ body: "# Legacy\n\nshort" });
  const layout = structuredClone(notesStore.getLayout());
  delete layout.cards[note._id].autoSizeOrigin;
  const canvas = mountCanvas([note], layout);
  try {
    const card = canvas.cardEls.get(note._id);
    const initialLeft = Number.parseFloat(card.style.left);
    const initialPin = Number.parseFloat(pin(canvas, note._id).style.left);
    const expectedOrigin = originFromBox({
      x: 10, y: 20, w: 220, h: 120, rotation: layout.cards[note._id].rotation
    }, layout.cards[note._id].rotation);
    assertNear(initialLeft, 10, "initial left", 1e-9);
    assertNear(initialPin, expectedOrigin.x, "virtual origin is the measured top-center");

    const grown = { ...note, system: { ...note.system, body: "# Legacy\n\n" + "x".repeat(40) } };
    canvas.update([grown], layout);
    assert.equal(card.style.width, "380px");
    assertNear(Number.parseFloat(pin(canvas, note._id).style.left), initialPin,
      "missing origin is remembered in memory, not re-derived from the changed width");

    canvas.update([note], layout);
    assertNear(Number.parseFloat(card.style.left), initialLeft, "shrinking returns exactly");
    assertNear(Number.parseFloat(pin(canvas, note._id).style.left), initialPin,
      "repeated cycles do not drift");
  } finally { cleanup(canvas); }
});

test("manual resize enters manual sizing and the Auto toggle restores automatic size", async () => {
  const note = await createNote({ body: "# Resize\n\nbody" });
  const manual = structuredClone(notesStore.getLayout());
  manual.cards[note._id].sizing = { mode: "manual", width: 320, minHeight: 240 };
  const resized = [];
  const automatic = [];
  let layout = manual;
  const canvas = mountCanvas([note], manual, {
    onResizeCard: (id, width, height) => resized.push([id, width, height]),
    onAutoSize: ids => automatic.push(ids)
  });
  try {
    const card = canvas.cardEls.get(note._id);
    assert.equal(card.style.width, "320px");
    assert.equal(card.style.minHeight, "240px");
    assert.match(card.className, /\bjn-sized\b/);

    const handle = card.querySelector(".jn-card-resize");
    handle.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: 100, clientY: 100, button: 0
    }));
    canvas.root.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: 160, clientY: 140, button: 0
    }));
    canvas.root.dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: 160, clientY: 140, button: 0
    }));
    assert.deepEqual(resized, [[note._id, 380, 280]]);

    card.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: 20, clientY: 20, button: 0
    }));
    card.dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: 20, clientY: 20, button: 0
    }));
    const auto = canvas.root.querySelector('.jn-selection-bar [data-action="auto"]');
    auto.click();
    assert.deepEqual(automatic, [[note._id]]);
    assert.doesNotMatch(card.className, /\bjn-sized\b/);
    assert.equal(card.style.width, "220px", "immediate automatic preview");
    assert.equal(card.style.height, "", "automatic height is a minimum, never fixed");

    layout = structuredClone(manual);
    layout.cards[note._id].sizing = { mode: "auto", width: null, minHeight: null };
    canvas.update([note], layout);
    assert.equal(card.style.width, "220px");
    assert.ok(Number.parseFloat(card.style.minHeight) >= 120);
  } finally { cleanup(canvas); }
});

test("an observed size change during a resize gesture does not revert the drag", async () => {
  const note = await createNote({ body: "# Resize\n\nbody" });
  const resized = [];
  const originalObserver = globalThis.ResizeObserver;
  let observerCallback = null;
  globalThis.ResizeObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const canvas = mountCanvas([note], notesStore.getLayout(), {
    onResizeCard: (id, width, height) => resized.push([id, width, height])
  });
  try {
    const card = canvas.cardEls.get(note._id);
    const handle = card.querySelector(".jn-card-resize");
    handle.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true, cancelable: true, clientX: 100, clientY: 100, button: 0
    }));
    canvas.root.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: 220, clientY: 180, button: 0
    }));
    assert.equal(card.style.width, "340px");
    observerCallback?.([{ target: card }]);
    canvas.refreshGeometry();
    assert.equal(card.style.width, "340px", "manual gesture survives an observer refresh");
    canvas.root.dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true, cancelable: true, clientX: 220, clientY: 180, button: 0
    }));
    assert.deepEqual(resized, [[note._id, 340, 200]]);
  } finally {
    globalThis.ResizeObserver = originalObserver;
    cleanup(canvas);
  }
});

test("input invalidations coalesce into exactly one geometry update per frame", async () => {
  const note = await createNote({ body: "# Frame\n\nbody" });
  const canvas = mountCanvas([note]);
  const view = dom.window;
  const originalFrame = view.requestAnimationFrame;
  const originalCancel = view.cancelAnimationFrame;
  const originalRefresh = canvas.refreshGeometry.bind(canvas);
  const frames = [];
  let refreshes = 0;
  view.requestAnimationFrame = callback => {
    frames.push(callback);
    return frames.length;
  };
  view.cancelAnimationFrame = () => {};
  canvas.refreshGeometry = () => {
    refreshes += 1;
    return originalRefresh();
  };
  try {
    canvas.scheduleGeometry();
    canvas.scheduleGeometry();
    canvas.scheduleGeometry();
    assert.equal(frames.length, 1, "three invalidations share one frame");
    frames.shift()(16);
    assert.equal(refreshes, 1, "one geometry pass");
  } finally {
    view.requestAnimationFrame = originalFrame;
    view.cancelAnimationFrame = originalCancel;
    canvas.refreshGeometry = originalRefresh;
    cleanup(canvas);
  }
});

test("attached pins follow the resized paper while free pins stay put", async () => {
  const note = await createNote({ body: "# Pins\n\nshort" });
  const layout = structuredClone(notesStore.getLayout());
  layout.cards[note._id].anchors = {
    ...layout.cards[note._id].anchors,
    edge: { kind: "minor", x: 1, y: 0.5, createdBy: "" }
  };
  layout.pins = { free1: { noteId: "", x: 900, y: 40, isDefault: false } };
  const canvas = mountCanvas([note], layout);
  try {
    const origin = layout.cards[note._id].autoSizeOrigin;
    const freeBefore = {
      left: freePin(canvas, "free1").style.left,
      top: freePin(canvas, "free1").style.top
    };
    const minorBefore = Number.parseFloat(pin(canvas, note._id, "edge").style.left);

    const grown = { ...note, system: { ...note.system, body: "# Pins\n\n" + "x".repeat(40) } };
    canvas.update([grown], layout);
    const box = canvas.cardBox(note._id);
    assert.equal(box.w, 380);
    assertNear(Number.parseFloat(pin(canvas, note._id).style.left), origin.x, "main pin fixed");
    assertNear(Number.parseFloat(pin(canvas, note._id).style.top), origin.y, "main pin fixed");

    const expected = anchorWorld(box, layout.cards[note._id].anchors.edge);
    const minorAfter = pin(canvas, note._id, "edge");
    assertNear(Number.parseFloat(minorAfter.style.left), expected.x, "minor pin stays attached");
    assertNear(Number.parseFloat(minorAfter.style.top), expected.y, "minor pin stays attached");
    assert.notEqual(Number.parseFloat(minorAfter.style.left), minorBefore,
      "the attached pin moves naturally with the wider paper");
    assert.deepEqual({
      left: freePin(canvas, "free1").style.left,
      top: freePin(canvas, "free1").style.top
    }, freeBefore, "free pins do not move with a note");
  } finally { cleanup(canvas); }
});

test("thread endpoints refresh in the same update that finishes automatic geometry", async () => {
  const a = await createNote({ body: "# A\n\nshort", x: 10, y: 20 });
  const b = await createNote({ body: "# B\n\nother", x: 500, y: 20 });
  const linked = {
    ...a,
    system: {
      ...a.system,
      links: [{
        id: "link1", targetId: b._id,
        sourceAnchorId: "edge", targetAnchorId: MAIN_ANCHOR_ID,
        sourceSide: "right", targetSide: "left"
      }]
    }
  };
  const layout = structuredClone(notesStore.getLayout());
  layout.cards[a._id].anchors = {
    ...layout.cards[a._id].anchors,
    edge: { kind: "minor", x: 1, y: 0.5, createdBy: "" }
  };
  const canvas = mountCanvas([linked, b], layout);
  try {
    const before = canvas.root.querySelector('.jn-links g[data-id="link1"] .jn-thread-layer')?.getAttribute("d");
    assert.ok(before, "thread rendered");

    const grown = {
      ...linked,
      system: { ...linked.system, body: "# A\n\n" + "x".repeat(40) }
    };
    canvas.update([grown, b], layout);
    const after = canvas.root.querySelector('.jn-links g[data-id="link1"] .jn-thread-layer')?.getAttribute("d");
    assert.ok(after && after !== before, "thread path follows the new box in the same pass");

    const thread = canvas.threads.get("link1");
    const box = canvas.cardBox(a._id);
    const expected = anchorWorld(box, layout.cards[a._id].anchors.edge);
    assertNear(thread.start.x, expected.x, "thread start tracks the finished box");
    assertNear(thread.start.y, expected.y, "thread start tracks the finished box");
  } finally { cleanup(canvas); }
});

test("card CSS has no width/height/pin/thread resize transitions", () => {
  const journal = readFileSync(new URL("../styles/journal.css", import.meta.url), "utf8");
  const stylized = readFileSync(new URL("../styles/stylized.css", import.meta.url), "utf8");
  for (const [name, css] of [["journal", journal], ["stylized", stylized]]) {
    const blocks = [...css.matchAll(/([^{}]*\.jn-card[^{}]*)\{([^}]*)\}/g)]
      .filter(match => !match[1].includes(".jn-card-resize"));
    for (const [, selector, body] of blocks) {
      const transitions = [...body.matchAll(/transition\s*:\s*([^;]+);/g)].map(match => match[1]);
      for (const value of transitions) {
        if (/^none\b/.test(value.trim())) continue;
        assert.doesNotMatch(value, /\b(width|height|left|top|transform)\b/,
          `${name} ${selector.trim()} must not animate geometry`);
      }
    }
  }
  assert.match(journal, /\.jn-card\s*\{[^}]*transition:\s*none/s);
  assert.match(stylized, /\.jn-canvas \.jn-card\s*\{[^}]*transition:\s*none/s);
  assert.match(journal, /\.jn-card-paper\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  const paper = journal.match(/\.jn-card-paper\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.doesNotMatch(paper, /(?:max-height|overflow\s*:\s*hidden)/,
    "manual overflow grows vertically instead of clipping");
  assert.match(journal,
    /\.jn-card-profile \.jn-note-body img\.jn-profile-portrait\s*\{[^}]*max-height:\s*220px[^}]*\}/s);
  assert.match(journal, /\.jn-note-body img\s*\{[^}]*object-fit:\s*contain/s);
  assert.match(journal, /\.jn-note-body pre\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(journal, /\.jn-note-body table\s*\{[^}]*overflow-x:\s*auto/s);
});
