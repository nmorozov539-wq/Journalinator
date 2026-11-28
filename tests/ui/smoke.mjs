/**
 * Bounded UI smoke test.
 *
 * The focus here is integration between the real JournalApp/JournalCanvas/NoteEditor and the
 * fake Foundry client: mount, card rendering, creation, the in-place editor, whole-note lock
 * presentation, the history dialog and a private canvas. Detailed gesture and editor behaviour
 * lives in the focused jsdom suites; this file intentionally avoids the removed vault, secret,
 * block, note-kind and location surfaces.
 */
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

const { installFoundry, makeContainers, makeUser } = await import("../fake-foundry.mjs");
const gm = makeUser("SmokeGM0000000001", { isGM: true, name: "GM" });
const player = makeUser("SmokePlayer000001", { name: "Player" });
const env = installFoundry({ user: gm, users: [gm, player] });
await makeContainers(env);
foundry.utils.cleanHTML = html => html;
foundry.applications = {
  api: {
    ApplicationV2: class {
      constructor() { this.element = null; }
      render() { return this; }
      close() { this.closed = true; return this; }
    },
    DialogV2: {
      confirm: async () => true,
      prompt: async () => null,
      wait: async () => null
    }
  },
  apps: { FilePicker: class { render() {} } }
};

const socket = await import("../../scripts/socket.mjs");
const edit = await import("../../scripts/edit-session.mjs");
const { notesStore } = await import("../../scripts/store/notes-store.mjs");
const { privateStore } = await import("../../scripts/store/private-store.mjs");
const { default: JournalApp } = await import("../../scripts/app/journal-app.mjs");
const { default: PrivateWorkspace } = await import("../../scripts/app/private-workspace.mjs");
socket.registerSocket();

const SKIN = { paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 1500) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) return false;
    await sleep(5);
  }
  return true;
}

async function createNote(body, { x = 20, y = 20, layout = "plain" } = {}) {
  const reply = await socket.requestEditReply({
    type: "createNote", body, layout, skin: SKIN, x, y, requestEdit: false
  });
  assert.equal(reply.type, "noteCreated");
  return reply.noteId;
}

async function mountApp() {
  const app = new JournalApp();
  const host = document.createElement("div");
  document.body.append(host);
  app.element = host;
  app._onFirstRender();
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  // The fake ApplicationV2 only stubs Foundry's public render(); point the app's own re-renders
  // at the same explicit render pass the test uses for the initial mount.
  app.render = redraw;
  await redraw();
  return { app, host, redraw };
}

function closeApp(app, host) {
  app._onClose?.();
  host?.remove();
}

test("the app mounts shared v2 cards and exposes no removed vault, secret or kind controls", async () => {
  const noteId = await createNote("# Smoke tavern\n\nA warm room.");
  const { app, host } = await mountApp();
  try {
    const card = host.querySelector(`.jn-card[data-id="${noteId}"]`);
    assert.ok(card, "the v2 note renders on the shared canvas");
    assert.equal(card.querySelector(".jn-note-title")?.textContent, "Smoke tavern");
    assert.match(card.querySelector(".jn-note-body")?.textContent ?? "", /A warm room/);
    assert.equal(card.querySelector(".jn-card-block"), null, "no legacy block DOM");
    assert.equal(host.querySelector(".journalinator-stats"), null);
    assert.equal(host.querySelector(".journalinator-kind"), null);
    assert.equal(host.querySelector(".journalinator-vault"), null);
    assert.equal(host.querySelector('[data-action="location"]'), null);
    assert.equal(host.querySelector(".jn-secret"), null);
    assert.equal(host.querySelectorAll(".jn-format-notice").length, 0,
      "current data never shows the incompatible-format notice");
  } finally {
    closeApp(app, host);
  }
});

test("empty-board creation opens the Blank/Document/Profile menu, creates v2 data and mounts the editor", async () => {
  const before = notesStore.getAllNotes().length;
  const { app, host } = await mountApp();
  try {
    const canvas = host.querySelector(".jn-canvas");
    assert.ok(canvas);
    canvas.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true, cancelable: true, clientX: 500, clientY: 350
    }));
    const menu = document.querySelector(".jn-creation-menu");
    assert.ok(menu, "the board menu is the current creation surface");
    assert.deepEqual([...menu.querySelectorAll(".jn-creation-choice")]
      .map(item => item.dataset.template), ["blank", "document", "profile"]);

    menu.querySelector('[data-template="blank"]').click();
    const opened = await waitFor(() => host.querySelector(".jn-source-input"));
    assert.equal(opened, true, "creation mounts the in-place Markdown editor");
    assert.equal(notesStore.getAllNotes().length, before + 1);
    const created = notesStore.getAllNotes().at(-1);
    assert.equal(created.system.schemaVersion, 2);
    assert.equal(created.name, `jn-note-${created.id}`);
    const card = host.querySelector(`.jn-card[data-id="${created.id}"]`);
    assert.ok(card.classList.contains("jn-editing"));
    assert.ok(card.querySelector(".jn-source-input"));
    assert.ok(card.querySelector(".jn-editor-toolbar"));
  } finally {
    app._onClose?.();
    host.remove();
  }
});

test("a remote whole-note lease shows the lock badge and refuses to mount a second editor", async () => {
  const noteId = await createNote("# Locked smoke\n\nRead only");
  edit.applyLeaseChanged({
    noteId,
    lease: {
      noteId, userId: player.id, userName: "Player", userColor: "#888888",
      clientSessionId: "player-other-tab", leaseToken: "smoke-peer-token", revision: 0
    }
  });
  const { app, host } = await mountApp();
  try {
    const card = host.querySelector(`.jn-card[data-id="${noteId}"]`);
    assert.ok(card);
    assert.equal(card.querySelector(".jn-lock-badge").hidden, false);
    assert.equal(card.querySelector(".jn-lock-text").textContent, "Player is editing");
    card.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true, cancelable: true, clientX: 10, clientY: 10
    }));
    await sleep(20);
    assert.equal(host.querySelector(".jn-source-input"), null,
      "the locked note cannot open an editor");
  } finally {
    edit.applyLeaseChanged({ noteId, lease: null });
    closeApp(app, host);
  }
});

test("selecting a card exposes the read toolbar and More opens the shared history dialog", async () => {
  const noteId = await createNote("# History smoke\n\nVersion one");
  const { app, host } = await mountApp();
  try {
    const card = host.querySelector(`.jn-card[data-id="${noteId}"]`);
    card.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true, button: 0, clientX: 40, clientY: 40
    }));
    host.querySelector(".jn-canvas").dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true, button: 0, clientX: 40, clientY: 40
    }));
    const bar = host.querySelector(".jn-selection-bar");
    assert.equal(bar.hidden, false);
    const actions = [...bar.querySelectorAll(":scope > .jn-selection-button, :scope > .jn-selection-menu-wrap > .jn-selection-button")]
      .map(button => button.textContent);
    assert.deepEqual(actions, ["Edit", "Layout", "Appearance", "Auto", "More"]);
    bar.querySelector('[data-action="more"]').click();
    bar.querySelector('.jn-selection-more [data-action="history"]').click();
    const dialog = document.querySelector(".jn-history-dialog");
    assert.ok(dialog, "the history dialog is current UI");
    assert.match(dialog.textContent, /Note history/);
    dialog.querySelector(".jn-history-close").click();
    assert.equal(document.querySelector(".jn-history-dialog"), null);
  } finally {
    closeApp(app, host);
  }
});

test("a private workspace mounts v2 cards with derived titles and no shared-note name", async () => {
  const page = await privateStore.createFor(gm);
  const workspace = privateStore.read(page);
  const made = privateStore.makeNote({
    body: "# Private smoke\n\nWorkspace body", x: 30, y: 30,
    cards: workspace.layout.cards
  });
  workspace.notes[made.note.id] = made.note;
  workspace.layout.cards[made.note.id] = made.card;
  await privateStore.save(page, workspace, privateStore.flags(page).rev ?? 0);

  const privateWorkspace = new PrivateWorkspace({});
  privateWorkspace.setPage(page);
  const slot = document.createElement("div");
  slot.style.width = "900px";
  slot.style.height = "700px";
  document.body.append(slot);
  try {
    privateWorkspace.renderInto(slot);
    const card = slot.querySelector(`.jn-card[data-id="${made.note.id}"]`);
    assert.ok(card, "private cards use the shared v2 card view");
    assert.equal(card.querySelector(".jn-note-title")?.textContent, "Private smoke");
    assert.equal(card.dataset.id, made.note.id);
    assert.equal(slot.textContent.includes(`jn-note-${made.note.id}`), false,
      "the internal page name is never shown");
  } finally {
    await privateWorkspace.editor?.close?.().catch(() => {});
    privateWorkspace.destroy();
    slot.remove();
    await page.delete?.();
  }
});
