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
const user = makeUser("PenGM00000000001", { isGM: true, name: "GM" });
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
const wheelEvent = (target, deltaY, init = {}) => target.dispatchEvent(
  new dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, ...init }));
const fakeRect = (w, h) => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0 });

const SKIN = { paper: "cream", font: "default", torn: false, backgroundImage: null, tiltSeed: 0 };

async function setup(extra = {}) {
  await requestWrite({
    type: "createNote", body: `# Pen A ${Math.random()}`, layout: "plain", skin: SKIN, x: 10, y: 20
  });
  await requestWrite({
    type: "createNote", body: `# Pen B ${Math.random()}`, layout: "plain", skin: SKIN, x: 350, y: 20
  });
  await tick();
  const notes = notesStore.getAllNotes().slice(-2);
  const actions = [];
  let pen = null;
  const canvas = new JournalCanvas({
    onSelectNote() {}, onMoveCard() {},
    onBoardPinAction: action => { actions.push(action); },
    getLinkPen: () => pen,
    onLinkPenChange: next => { pen = next; },
    ...extra
  });
  document.body.append(canvas.root);
  canvas.pinsEnabled = true;
  canvas.root.getBoundingClientRect = () => fakeRect(1000, 800);
  return { canvas, notes, actions, getPen: () => pen };
}

const layoutWith = (notes, pinLinks = {}) => {
  const layout = structuredClone(notesStore.getLayout());
  layout.pins = { p1: { noteId: "", x: 600, y: 300, isDefault: false } };
  layout.pinLinks = pinLinks;
  return layout;
};

test("with the Pin tool armed and nothing selected the right panel edits the pen", async () => {
  const { canvas, notes, getPen } = await setup();
  canvas.update(notes, layoutWith(notes));
  assert.equal(canvas.floatingToolbar.hidden, true);
  canvas.togglePinTool();
  assert.equal(canvas.floatingToolbar.hidden, false, "the pen panel appears with the tool");
  const groups = [...canvas.floatingToolbar.querySelectorAll(".jn-ft-btn")].map(button => button.dataset.group);
  assert.deepEqual(groups, ["presets", "color", "thickness", "slack", "material", "pattern", "ends"],
    "the pen has every look control but no per-thread actions");
  const open = group => {
    canvas.floatingToolbar.querySelector(`.jn-ft-btn[data-group="${group}"]`).click();
    return canvas.floatingPopover;
  };
  const thickness = open("thickness").querySelector(".jn-ft-thickness");
  thickness.value = "3.4";
  thickness.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(getPen().current.thickness, 3.4, "the pen follows the slider live");
  open("color").querySelector(".jn-ft-swatch-link2").click();
  assert.equal(getPen().current.color, "link2");

  let pop = open("presets");
  pop.querySelector(".jn-ft-preset-name").value = "Red rope";
  pop.querySelector(".jn-ft-preset-save").click();
  assert.deepEqual(getPen().presets.map(preset => preset.name), ["Red rope"]);
  assert.equal(getPen().presets[0].style.thickness, 3.4);
  pop = canvas.floatingPopover;
  assert.ok(pop.querySelector(".jn-ft-presets-mine .jn-ft-preset"), "the saved preset is listed");
  pop.querySelector('[data-preset="fine"]').click();
  assert.equal(getPen().current.thickness, 1.3);
  assert.equal(getPen().current.color, "link2", "a built-in keeps the dye");
  canvas.floatingPopover.querySelector(".jn-ft-presets-mine .jn-ft-preset").click();
  assert.equal(getPen().current.thickness, 3.4, "a saved preset restores its look");
  canvas.floatingPopover.querySelector(".jn-ft-preset-delete").click();
  assert.equal(getPen().presets.length, 0);

  canvas.togglePinTool();
  assert.equal(canvas.floatingToolbar.hidden, true, "the panel leaves with the tool");
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("while a thread is being drawn the wheel changes the pen, Alt changes hang, and nothing zooms", async () => {
  const { canvas, notes, getPen } = await setup();
  canvas.update(notes, layoutWith(notes));
  const source = canvas.root.querySelector(`[data-pin-ref="n:${notes[0].id}:main"]`);
  const k = canvas.view.k;
  event(source, "pointerdown", 105, 20);
  assert.ok(canvas.root.querySelector(".jn-link-preview"), "a thread is being drawn");
  wheelEvent(canvas.root, -100);
  assert.equal(getPen().current.thickness, 2.8);
  wheelEvent(canvas.root, 100, { altKey: true });
  assert.equal(getPen().current.slack, 0.08);
  assert.equal(canvas.view.k, k, "the wheel never zooms mid-drag");
  const preview = canvas.root.querySelector(".jn-link-preview");
  event(canvas.root, "pointermove", 300, 200);
  assert.match(preview.getAttribute("style"), /--jn-thread-width:2.8/, "the preview wears the pen");
  event(canvas.root, "pointerup", 300, 200);
  wheelEvent(canvas.root, -100);
  assert.notEqual(canvas.view.k, k, "with no drag the wheel zooms again");
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("the wheel over the selected thread edits it in throttled writes; other threads just zoom", async () => {
  const { canvas, notes, actions } = await setup();
  const link = { source: `n:${notes[0].id}:main`, target: "p:p1", color: "", secondaryColor: "",
    material: "linen", thickness: 2.6, slack: 0.09, pattern: "continuous", ends: "standard" };
  canvas.update(notes, layoutWith(notes, { l1: link, l2: { ...link, target: `n:${notes[1].id}:main` } }));
  const hit = id => canvas.pinLinksSvg.querySelector(`[data-pin-link="${id}"] .jn-pin-link-hit`);
  event(hit("l1"), "pointerdown", 400, 160);
  event(hit("l1"), "pointerup", 400, 160);
  assert.equal(canvas.selectedLinkId, "l1");
  const writes = () => actions.filter(action => action.type === "updateLink");

  const k = canvas.view.k;
  wheelEvent(hit("l2"), -100);
  assert.equal(writes().length, 0, "an unselected thread does not capture the wheel");
  assert.notEqual(canvas.view.k, k);

  const zoomed = canvas.view.k;
  wheelEvent(hit("l1"), -100);
  assert.deepEqual(writes().at(-1), { type: "updateLink", linkId: "l1", fields: { thickness: 2.8 } });
  wheelEvent(hit("l1"), -100);
  wheelEvent(hit("l1"), -100);
  assert.equal(writes().length, 1, "a burst is throttled, not one write per notch");
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(writes().length, 2);
  assert.equal(writes().at(-1).fields.thickness, 3.2, "the trailing write carries the accumulated value");
  wheelEvent(hit("l1"), 100, { altKey: true });
  assert.equal(canvas.view.k, zoomed, "wheel over the selected thread never zooms");
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("dragging a thread to the board edge scrolls the camera, and releasing stops it", async () => {
  const { canvas, notes } = await setup();
  canvas.update(notes, layoutWith(notes));
  canvas.view = { x: 0, y: 0, k: 1 };
  const source = canvas.root.querySelector(`[data-pin-ref="n:${notes[0].id}:main"]`);
  event(source, "pointerdown", 105, 20);
  event(canvas.root, "pointermove", 500, 400);
  await frame(); await frame();
  assert.equal(canvas.view.x, 0, "the middle of the board does not scroll");
  event(canvas.root, "pointermove", 996, 400);
  await frame(); await frame(); await frame();
  assert.ok(canvas.view.x < -10, `pushing right slides the world left (${canvas.view.x})`);
  assert.equal(canvas.view.y, 0, "only the pushed axis scrolls");
  const preview = canvas.root.querySelector(".jn-link-preview .jn-thread-layer");
  assert.ok(preview, "the thread is still being drawn while the camera moves");
  event(canvas.root, "pointermove", 4, 796);
  await frame(); await frame();
  assert.ok(canvas.view.y < 0 && canvas.view.x > -200, "the bottom-left corner pushes down and back left");
  event(canvas.root, "pointerup", 4, 796);
  const stopped = { x: canvas.view.x, y: canvas.view.y };
  await frame(); await frame();
  assert.deepEqual({ x: canvas.view.x, y: canvas.view.y }, stopped, "release stops the scroll");
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("threads drawn between pins show loose ends, alternating dye and material like note links", async () => {
  const { canvas, notes } = await setup();
  const link = { source: `n:${notes[0].id}:main`, target: "p:p1", color: "link1", secondaryColor: "link2",
    material: "double", thickness: 3, slack: 0.12, pattern: "alternating", ends: "loose" };
  canvas.update(notes, layoutWith(notes, { fancy: link }));
  const group = canvas.pinLinksSvg.querySelector('[data-pin-link="fancy"]');
  for (const name of ["jn-link-color-link1", "jn-link-accent-link2", "jn-link-material-double",
    "jn-link-pattern-alternating", "jn-link-ends-loose"]) assert.ok(group.classList.contains(name), name);
  assert.equal(group.querySelectorAll(".jn-link-stack").length, 2, "primary and accent stacks");
  assert.equal(group.querySelectorAll(".jn-thread-tail").length, 4, "stacked loose tails at both ends");
  assert.match(group.querySelector(".jn-thread-layer").getAttribute("d"), / Q/, "it hangs on the shared curve");
  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("the GM keeps a sender's pen style only as validated cosmetics", async () => {
  const { notes } = await setup();
  const before = Object.keys(notesStore.getLayout().pinLinks ?? {});
  const connect = style => requestWrite({ type: "boardPinAction", action: {
    type: "connect", source: `n:${notes[0].id}:main`, target: `n:${notes[1].id}:main`, style } });
  await connect({ material: "double", thickness: 3.1, slack: 0.14, pattern: "interrupted",
    ends: "loose", color: "link2", secondaryColor: "link1" });
  await tick();
  let links = notesStore.getLayout().pinLinks;
  let created = Object.entries(links).filter(([id]) => !before.includes(id));
  assert.equal(created.length, 1);
  assert.deepEqual(
    [created[0][1].material, created[0][1].thickness, created[0][1].slack, created[0][1].pattern,
      created[0][1].ends, created[0][1].color, created[0][1].secondaryColor],
    ["double", 3.1, 0.14, "interrupted", "loose", "link2", "link1"]);

  // Same endpoints again are a duplicate, so remove the first link, then send hostile values.
  await requestWrite({ type: "boardPinAction", action: { type: "deleteLink", linkId: created[0][0] } });
  await tick();
  await connect({ material: "__proto__", thickness: 9999, slack: -5, pattern: "zigzag", ends: {},
    color: "javascript:alert(1)", label: "injected", extra: "x", source: "p:evil" });
  await tick();
  links = notesStore.getLayout().pinLinks;
  created = Object.entries(links).filter(([id]) => !before.includes(id));
  assert.equal(created.length, 1);
  const hostile = created[0][1];
  assert.deepEqual([hostile.material, hostile.thickness, hostile.slack, hostile.pattern, hostile.ends, hostile.color],
    ["linen", 5, 0, "continuous", "standard", ""]);
  assert.equal(hostile.label, "", "a client can no longer write a label");
  assert.equal(hostile.extra, undefined);
  assert.equal(hostile.source, `n:${notes[0].id}:main`, "style can never redirect the endpoints");
});
