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
const user = makeUser("UxGM0000000000001", { isGM: true, name: "GM" });
const env = installFoundry({ user, users: [user] });
await makeContainers(env);
const { registerSocket } = await import("../scripts/socket.mjs");
const { default: JournalCanvas } = await import("../scripts/app/canvas.mjs");
registerSocket();

const SKIN = { paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 0 };
const fakeRect = (w, h) => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0 });
const event = (target, type, x = 0, y = 0) => target.dispatchEvent(
  new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
const key = (target, value) => target.dispatchEvent(
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: value }));

const makeNote = (id, body, extra = {}) => ({
  _id: id,
  name: `jn-note-${id}`,
  system: { body, layout: "plain", skin: SKIN, authorId: user.id, links: [], ...extra }
});
const card = (x, y) => ({
  x, y, rotation: 0, anchors: { main: { kind: "main", x: 0.5, y: 0 } }
});
const layoutFor = (notes, extra = {}) => ({
  cards: Object.fromEntries(notes.map((note, index) => [note._id, card(10 + index * 340, 20)])),
  labels: {}, pins: {}, pinLinks: {}, ...extra
});
const pinLink = (source, target) => ({
  source: `n:${source}:main`, target: `n:${target}:main`,
  color: "", secondaryColor: "", material: "linen", thickness: 2.6, slack: 0.09,
  pattern: "continuous", ends: "standard"
});
const clickLink = (canvas, selector) => {
  const hit = canvas.root.querySelector(selector);
  assert.ok(hit, `link hit ${selector}`);
  event(hit, "pointerdown", 200, 100);
  event(hit, "pointerup", 200, 100);
};

test("a selected pin link keeps its inspector across style writes and still deselects normally", async () => {
  const a = makeNote("PinUxNote0000001", "# Pin one");
  const b = makeNote("PinUxNote0000002", "# Pin two");
  const notes = [a, b];
  const layout = layoutFor(notes, { pinLinks: { pin1: pinLink(a._id, b._id) } });
  const actions = [];
  let canvas;
  canvas = new JournalCanvas({
    onSelectNote() {},
    onBoardPinAction: action => {
      actions.push(action);
      if (action.type === "updateLink") {
        Object.assign(layout.pinLinks[action.linkId], action.fields);
      } else if (action.type === "deleteLink") {
        delete layout.pinLinks[action.linkId];
      }
      canvas.update(notes, layout);
    }
  });
  document.body.append(canvas.root);
  canvas.root.getBoundingClientRect = () => fakeRect(1000, 800);
  canvas.update(notes, layout);

  const pinGroup = () => canvas.pinLinksSvg.querySelector('[data-pin-link="pin1"]');
  clickLink(canvas, '[data-pin-link="pin1"] .jn-pin-link-hit');
  assert.equal(canvas.selectedLinkId, "pin1");
  assert.equal(canvas.floatingToolbar.hidden, false, "selecting a pin link opens the inspector");
  assert.ok(pinGroup().classList.contains("jn-link-selected"));

  // First write: thickness. The callback re-renders the board exactly like a document update.
  canvas.floatingToolbar.querySelector('.jn-ft-btn[data-group="thickness"]').click();
  const thickness = canvas.floatingPopover.querySelector(".jn-ft-thickness");
  thickness.value = "4.2";
  thickness.dispatchEvent(new Event("change", { bubbles: true }));

  assert.deepEqual(actions.at(-1),
    { type: "updateLink", linkId: "pin1", fields: { thickness: 4.2 } });
  assert.equal(layout.pinLinks.pin1.thickness, 4.2);
  assert.equal(canvas.selectedLinkId, "pin1", "the layout update keeps the pin link selected");
  assert.equal(canvas.floatingToolbar.hidden, false, "the inspector stays open after the write");
  assert.ok(pinGroup().classList.contains("jn-link-selected"), "selection styling survives the redraw");

  // A second control still reaches the same link without re-selecting the thread.
  canvas.floatingToolbar.querySelector('.jn-ft-btn[data-group="material"]').click();
  const material = canvas.floatingPopover.querySelector(".jn-ft-material");
  material.value = "double";
  material.dispatchEvent(new Event("change", { bubbles: true }));
  assert.deepEqual(actions.at(-1),
    { type: "updateLink", linkId: "pin1", fields: { material: "double" } });
  assert.equal(layout.pinLinks.pin1.material, "double");
  assert.equal(canvas.selectedLinkId, "pin1");
  assert.equal(canvas.floatingToolbar.hidden, false);

  // Escape still closes the inspector and clears the selection. The first press dismisses the
  // open popover (existing capture handler); the second reaches the canvas selection handler.
  key(canvas.root, "Escape");
  assert.equal(canvas.floatingPopover.hidden, true);
  assert.equal(canvas.selectedLinkId, "pin1", "closing the popover keeps the thread selected");
  key(canvas.root, "Escape");
  assert.equal(canvas.selectedLinkId, null);
  assert.equal(canvas.floatingToolbar.hidden, true);

  // Clicking the empty board still deselects.
  await new Promise(resolve => setTimeout(resolve, 450));
  clickLink(canvas, '[data-pin-link="pin1"] .jn-pin-link-hit');
  assert.equal(canvas.selectedLinkId, "pin1");
  event(canvas.root, "pointerdown", 950, 750);
  event(canvas.root, "pointerup", 950, 750);
  assert.equal(canvas.selectedLinkId, null, "an outside click clears the pin-link selection");
  assert.equal(canvas.floatingToolbar.hidden, true);

  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("double-clicking a selected pin link still deletes it and closes the inspector", () => {
  const a = makeNote("PinDblNote0000001", "# Pin one");
  const b = makeNote("PinDblNote0000002", "# Pin two");
  const notes = [a, b];
  const layout = layoutFor(notes, { pinLinks: { pin1: pinLink(a._id, b._id) } });
  const actions = [];
  let canvas;
  canvas = new JournalCanvas({
    onSelectNote() {},
    onBoardPinAction: action => actions.push(action)
  });
  document.body.append(canvas.root);
  canvas.root.getBoundingClientRect = () => fakeRect(1000, 800);
  canvas.update(notes, layout);

  const hit = () => canvas.pinLinksSvg.querySelector('[data-pin-link="pin1"] .jn-pin-link-hit');
  event(hit(), "pointerdown", 200, 100);
  event(hit(), "pointerup", 200, 100);
  assert.equal(canvas.selectedLinkId, "pin1");
  event(hit(), "pointerdown", 200, 100);
  event(hit(), "pointerup", 200, 100);
  assert.deepEqual(actions.at(-1), { type: "deleteLink", linkId: "pin1" });
  assert.equal(canvas.selectedLinkId, null);
  assert.equal(canvas.floatingToolbar.hidden, true);

  canvas.disconnectGeometry();
  canvas.root.remove();
});

test("route detach labels use the derived v2 title, never the hidden page name", () => {
  const a = makeNote("RouteUxNote000001", "# Source note");
  const b = makeNote("RouteUxNote000002", "# Target note");
  const internalName = "jn-note-3tHN6ydp3tbjgoGO";
  const c = makeNote("RouteUxNote000003", "# Visible title", {
    name: internalName,
    // A v1-shaped leftover must never leak either; v2 has no label field.
    label: internalName
  });
  a.system.links = [{
    id: "route1", targetId: b._id, color: "", secondaryColor: "",
    material: "linen", thickness: 2.6, slack: 0.09, pattern: "continuous", ends: "standard",
    routeAnchors: [{ noteId: c._id, anchorId: "main" }]
  }];
  const notes = [a, b, c];
  const canvas = new JournalCanvas({
    onSelectNote() {},
    onDetachRouteNote() {}
  });
  document.body.append(canvas.root);
  canvas.root.getBoundingClientRect = () => fakeRect(1000, 800);
  canvas.update(notes, layoutFor(notes));

  clickLink(canvas, '.jn-link-hit[data-id="route1"]');
  assert.equal(canvas.selectedLinkId, "route1");
  canvas.floatingToolbar.querySelector('.jn-ft-btn[data-group="actions"]').click();
  const detach = canvas.floatingPopover.querySelector(".jn-link-detach");
  assert.ok(detach, "the routed note offers a detach action");
  assert.match(detach.textContent, /Visible title/);
  assert.equal(detach.textContent.includes("jn-note-"), false, "the internal page name is never shown");

  canvas.disconnectGeometry();
  canvas.root.remove();
});
