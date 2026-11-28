import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import showdown from "showdown";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost/" });
for (const key of [
  "document", "window", "Node", "HTMLElement", "Event", "KeyboardEvent",
  "MouseEvent", "InputEvent", "Range", "NodeFilter"
]) {
  globalThis[key] = dom.window[key];
}
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.showdown = showdown;

const { installFoundry, makeContainers, makeUser } = await import("./fake-foundry.mjs");
const gm = makeUser("GM00000000000001", { isGM: true, name: "GM" });
const player = makeUser("Player0000000001", { name: "Alex" });
const env = installFoundry({ user: gm, users: [gm, player] });
const containers = await makeContainers(env);

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
  }
};
foundry.utils.cleanHTML = html => html;

const STRINGS = {
  "JN.Search.EmptyNote": "Empty note",
  "JN.Search.ImageNote": "Image note",
  "JN.Layout.Plain": "Plain",
  "JN.Layout.Profile": "Profile",
  "JN.Filter.All": "All",
  "JN.Filter.Layouts": "Layout",
  "JN.Notices.Incompatible": "These notes use an older development format. This build needs a fresh Journalinator workspace.",
  "JN.Notices.IncompatibleHint": "Existing data has not been changed. Use a fresh test world or ask the host to reset Journalinator data.",
  "JN.Notices.PrivateIncompatible": "This private canvas uses an older development format.",
  "JN.Notices.PrivateIncompatibleHint": "Existing data has not been changed. Switch back to the main canvas or ask the host to reset Journalinator data.",
  "JN.Notices.NoGM": "A GM must be connected to edit shared notes.",
  "JN.Switcher.CreateBlank": "+ Create Blank note",
  "JN.Common.Close": "Close"
};
const baseLocalize = game.i18n.localize;
game.i18n.localize = (key, data) => {
  const value = STRINGS[key] ?? baseLocalize(key, data);
  return data ? value.replace(/\{(\w+)\}/g, (_, name) => String(data[name] ?? "")) : value;
};

const {
  default: JournalApp,
  quickCreateModel,
  createSharedNoteFromQuery,
  clipboardEntryForNote,
  clipboardPasteMessage,
  collectCopyableNotes
} = await import("../scripts/app/journal-app.mjs");
const { notesStore } = await import("../scripts/store/notes-store.mjs");
const { privateStore } = await import("../scripts/store/private-store.mjs");

async function mount(app) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  app.element = host;
  const context = await app._prepareContext();
  app._replaceHTML(await app._renderHTML(context), host);
  return { host, context };
}

function closeApp(app, host) {
  app._onClose?.();
  host?.remove();
}

test("incompatible shared data shows the exact read-only notice and performs no write", async () => {
  const legacy = await JournalEntryPage.create({
    name: "jn-note-legacy",
    type: "fvtt-journalinator.note",
    system: { schemaVersion: 1, blocks: [{ text: "old prose" }] }
  }, { parent: containers.shared });
  const before = structuredClone(legacy.system);
  const writesBefore = env.socketLog.length;

  const app = new JournalApp();
  const { host, context } = await mount(app);
  try {
    assert.equal(context.incompatible, true);
    assert.equal(context.sharedWritable, false);
    assert.deepEqual(context.allNotes, [], "legacy notes are not rendered as empty v2 notes");
    assert.equal(host.querySelectorAll(".jn-card").length, 0);
    assert.equal(
      host.querySelector(".jn-format-notice-title").textContent,
      "These notes use an older development format. This build needs a fresh Journalinator workspace."
    );
    assert.equal(
      host.querySelector(".jn-format-notice-hint").textContent,
      "Existing data has not been changed. Use a fresh test world or ask the host to reset Journalinator data."
    );
    assert.equal(host.querySelectorAll(".jn-format-notice-actions button").length, 1);
    assert.equal(host.querySelector(".jn-format-notice-actions button").textContent, "Close");
    assert.deepEqual(legacy.system, before, "opening/rendering never migrates or clears stored data");
    assert.equal(env.socketLog.length, writesBefore, "the read-only notice sends no write");
  } finally {
    closeApp(app, host);
    containers.shared.pages.delete(legacy.id);
  }
});

test("an incompatible private workspace shows a read-only private notice", async () => {
  const privatePage = await JournalEntryPage.create({
    name: "Private workspace",
    type: "JournalEntryPage",
    flags: {
      "fvtt-journalinator": {
        private: {
          ownerUserId: gm.id,
          state: "active",
          rev: 1,
          workspace: { format: 2, notes: {}, layout: {}, trash: [], history: {} }
        }
      }
    }
  }, { parent: containers.private });

  const app = new JournalApp();
  const first = await mount(app);
  app._onRender();
  try {
    // Switch to the private view through the normal top-bar control.
    first.host.querySelector('.jn-view-option[data-view="private"]').click();
    const context = await app._prepareContext();
    assert.equal(context.privateIncompatible, true);
    const host = document.createElement("div");
    document.body.appendChild(host);
    app.element = host;
    app._replaceHTML(await app._renderHTML(context), host);
    assert.equal(
      host.querySelector(".jn-format-notice-title").textContent,
      "This private canvas uses an older development format."
    );
    assert.equal(host.querySelectorAll(".jn-private-format-notice").length, 1);
    host.remove();
  } finally {
    closeApp(app, first.host);
    containers.private.pages.delete(privatePage.id);
  }
});

test("no-GM shared canvas keeps a read-only banner and navigation", async () => {
  gm.active = false;
  const app = new JournalApp();
  const { host, context } = await mount(app);
  try {
    assert.equal(context.gmOnline, false);
    assert.equal(context.sharedWritable, false);
    assert.equal(host.querySelector(".journalinator-offline-banner").textContent,
      "A GM must be connected to edit shared notes.");
    assert.ok(host.querySelector(".journalinator-search"), "search/navigation remains available");
    assert.equal(host.querySelectorAll(".jn-card").length, 0);
  } finally {
    closeApp(app, host);
    gm.active = true;
  }
});

test("quick-switcher create sends the v2 query payload and focuses the returned note", async () => {
  const titled = quickCreateModel("Harbor", { x: 12, y: 34, clientSessionId: "tab-t9" });
  assert.equal(titled.message.type, "createNote");
  assert.equal(titled.message.body, "# Harbor");
  assert.equal(titled.message.layout, "plain");
  assert.equal(titled.message.skin.paper, "cream");
  assert.equal(titled.message.requestEdit, true);
  assert.equal(titled.message.clientSessionId, "tab-t9");
  assert.equal(titled.message.x, 12);
  assert.equal(titled.message.y, 34);
  assert.equal("title" in titled.message, false);
  assert.equal(titled.focus, "body-start");

  const blank = quickCreateModel("   ");
  assert.equal(blank.message.body, "");
  assert.equal(blank.message.layout, "plain");
  assert.equal(blank.message.skin.paper, "amber");

  const requests = [];
  const created = [];
  const result = await createSharedNoteFromQuery({
    query: "Harbor",
    x: 5,
    y: 6,
    clientSessionId: "tab-t9",
    requestEditReply: async message => {
      requests.push(message);
      return {
        type: "noteCreated",
        noteId: "Note000000000009",
        revision: 0,
        body: "# Harbor",
        layout: "plain",
        skin: message.skin
      };
    },
    onCreated: value => created.push(value)
  });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body, "# Harbor");
  assert.equal(created.length, 1);
  assert.equal(created[0].focus, "body-start", "the returned note is opened with the creation focus");
  assert.equal(created[0].note.noteId, "Note000000000009");
});

test("clipboard is v2 body/layout/skin only and paste allocates fresh ids server-side", () => {
  const note = {
    _id: "n1",
    name: "jn-note-internal",
    system: {
      body: "# Title\n\nBody",
      layout: "profile",
      skin: { paper: "parchment", font: "serif", torn: true, backgroundImage: null, tiltSeed: 7 },
      title: "legacy title",
      blocks: [{ text: "legacy" }],
      kind: "location",
      label: "secret label",
      secret: true
    }
  };
  const entry = clipboardEntryForNote(note);
  assert.deepEqual(Object.keys(entry).sort(), ["body", "layout", "skin"]);
  assert.equal(entry.body, "# Title\n\nBody");
  assert.equal(entry.layout, "profile");
  assert.equal(entry.skin.paper, "parchment");

  const paste = clipboardPasteMessage(entry, { x: 40, y: 50 });
  assert.deepEqual(Object.keys(paste).sort(), ["body", "layout", "skin", "type", "x", "y"]);
  assert.equal(paste.type, "pasteNote");
  assert.equal(paste.x, 40);
  assert.equal(paste.y, 50);
  assert.equal("title" in paste, false);
  assert.equal("id" in paste, false);

  const locked = collectCopyableNotes([note], ["n1"], () => true);
  assert.equal(locked.blocked, true);
  assert.deepEqual(locked.notes, []);
});

test("publishing private notes to the Main Canvas sends one batch request, not clipboard pastes", async () => {
  const previousUser = game.user;
  const privatePage = await privateStore.createFor(player);
  const workspace = privateStore.read(privatePage);
  const ids = ["Publish Alpha", "Publish Beta"].map((title, index) => {
    const made = privateStore.makeNote({
      title, style: "memo", x: index * 260, y: 0, cards: workspace.layout.cards
    });
    made.note.blocks = [{ blockId: foundry.utils.randomID(), text: `${title} body` }];
    workspace.notes[made.note.id] = made.note;
    workspace.layout.cards[made.note.id] = made.card;
    return made.note.id;
  });
  await privateStore.save(privatePage, workspace, privateStore.flags(privatePage).rev ?? 0);
  game.user = player;
  const socketBefore = env.socketLog.length;

  const app = new JournalApp();
  const host = document.createElement("div");
  document.body.appendChild(host);
  app.element = host;
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    host.querySelector(".jn-view-switch").click();
    host.querySelector('.jn-view-option[data-view="private"]').click();
    await redraw();

    const canvasRoot = host.querySelector(".jn-canvas");
    const select = (id, ctrlKey = false) => {
      const card = canvasRoot.querySelector(`.jn-card[data-id="${id}"]`);
      assert.ok(card, `card ${id}`);
      card.dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true, button: 0, clientX: 10, clientY: 10, ctrlKey
      }));
      canvasRoot.dispatchEvent(new MouseEvent("pointerup", {
        bubbles: true, button: 0, clientX: 10, clientY: 10, ctrlKey
      }));
    };
    select(ids[0]);
    select(ids[1], true);

    host.querySelector(".journalinator-private-send").click();
    const panel = host.querySelector(".journalinator-transfer-send");
    panel.querySelector(".jn-transfer-recipient").value = "__main__";
    panel.querySelector(".jn-transfer-confirm").click();

    const writes = env.socketLog.slice(socketBefore).map(entry => entry.message);
    const publishes = writes.filter(message => message.type === "publishPrivateNotes");
    assert.equal(publishes.length, 1, "the whole selection is published in one request");
    assert.deepEqual(publishes[0].noteIds, ids);
    assert.equal(writes.some(message => message.type === "pasteNote"), false,
      "publishing no longer sends per-note clipboard pastes");
    assert.equal(panel.hidden, true, "the send panel closes after publishing");
  } finally {
    game.user = previousUser;
    app._onClose();
    host.remove();
    containers.private.pages.delete(privatePage.id);
  }
});

test("stats, vault, secret and location controls are absent from the app", async () => {
  const live = await JournalEntryPage.create({
    name: "jn-note-live",
    type: "fvtt-journalinator.note",
    system: { body: "# Live note\n\nBody" }
  }, { parent: containers.shared });
  const app = new JournalApp();
  const { host } = await mount(app);
  try {
    assert.ok(host.querySelector(`.jn-card[data-id="${live.id}"]`), "current notes still render normally");
    for (const selector of [
      ".journalinator-stats", ".journalinator-private-stats",
      ".journalinator-secrets", ".journalinator-gm-view",
      "#openStats", ".jn-add-session", ".jn-session-group"
    ]) {
      assert.equal(host.querySelector(selector), null, `${selector} is removed`);
    }
    assert.equal(host.querySelector(".journalinator-root").classList.contains("jn-gm-view"), false);
    const layoutValues = [...host.querySelectorAll('.journalinator-filters input[data-kind="layout"]')]
      .map(input => input.value);
    assert.deepEqual(layoutValues, ["", "plain", "profile"]);
    assert.equal(host.querySelector('.journalinator-filters input[value="location"]'), null);
    assert.equal(host.querySelector('.journalinator-filters input[value="memo"]'), null);
  } finally {
    closeApp(app, host);
    containers.shared.pages.delete(live.id);
  }
});
