/**
 * UI smoke test: renders the real NoteEditor and JournalCanvas in jsdom on top of the fake
 * Foundry and clicks through the GM flows. Catches runtime errors the data-path tests can't.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import showdown from "showdown";

const JN = new URL("../../", import.meta.url).href.replace(/\/$/, "");
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const k of ["document", "HTMLElement", "Node", "Event", "KeyboardEvent", "MouseEvent"]) globalThis[k] = dom.window[k];
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);

const { installFoundry, makeContainers, makeUser } = await import(`${JN}/tests/fake-foundry.mjs`);
const gmUser = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const env = installFoundry({ user: gmUser, users: [gmUser] });
const containers = await makeContainers(env);
globalThis.showdown = showdown;
globalThis.foundry.utils.cleanHTML = html => html;

// Dialog fakes: queue answers per call.
const answers = [];
globalThis.foundry.applications = {
  api: {
    ApplicationV2: class {
      constructor() { this.element = null; }
      render() { return this; }
    },
    DialogV2: {
      confirm: async () => answers.shift() ?? true,
      prompt: async () => answers.shift() ?? null,
      wait: async () => answers.shift() ?? null
    }
  },
  apps: { FilePicker: class { render() {} } }
};

const { vaultStore } = await import(`${JN}/scripts/secrets/vault-store.mjs`);
const { notesStore } = await import(`${JN}/scripts/store/notes-store.mjs`);
const secrets = await import(`${JN}/scripts/secrets/secret-actions.mjs`);
const { registerSocket, requestWrite } = await import(`${JN}/scripts/socket.mjs`);
const { privateStore } = await import(`${JN}/scripts/store/private-store.mjs`);
const { default: NoteEditor } = await import(`${JN}/scripts/app/editor.mjs`);
const { default: JournalCanvas } = await import(`${JN}/scripts/app/canvas.mjs`);
const { default: JournalApp, isTextEntryTarget } = await import(`${JN}/scripts/app/journal-app.mjs`);
const { getLock } = await import(`${JN}/scripts/locks.mjs`);
registerSocket();

const settle = () => new Promise(r => setTimeout(r, 80));
const sharedByName = name => [...containers.shared.pages.values()].find(p => p.name === name);
const errors = () => env.notifications.filter(([level]) => level === "error");

await vaultStore.init();
await vaultStore.setKeyring({ mode: "passphrase", passphrase: "correct horse battery" });
await requestWrite({ type: "createNote", title: "Tavern", x: 0, y: 0 });
await settle();
const tavernId = sharedByName("Tavern").id;
const firstBlock = sharedByName("Tavern").system.blocks[0].blockId;
const vexId = await secrets.createSecretNote({ title: "Lord Vex", x: 400, y: 0 });
const hiddenId = await secrets.addHiddenBlock(tavernId, firstBlock, "secret words");

const editor = new NoteEditor({ onFocusNote() {}, onSelectNote() {} });
document.body.appendChild(editor.root);
editor.activate();

function blockEl(id) { return editor.root.querySelector(`.jn-block[data-block-id="${id}"]`); }

test("editor renders merged note with GM controls", () => {
  editor.open(tavernId);
  editor.render();
  const hidden = blockEl(hiddenId);
  assert.ok(hidden.classList.contains("jn-hidden-block"));
  const acts = [...hidden.querySelectorAll(".jn-block-gm button")].map(b => b.dataset.act);
  assert.deepEqual(acts, ["reveal", "delete", "add"]);
  const sharedActs = [...blockEl(firstBlock).querySelectorAll(".jn-block-gm button")].map(b => b.dataset.act);
  assert.deepEqual(sharedActs, ["hide", "add"]);
  assert.ok(editor.root.querySelector(".journalinator-hint-toggle"));
});

test("clicking a hidden block edits locally without a lock; blur saves to the vault", async () => {
  blockEl(hiddenId).click();
  const textarea = editor.root.querySelector(".jn-block-input");
  assert.ok(textarea, "editing textarea shown");
  assert.equal(getLock(tavernId, hiddenId), null, "no lock taken");
  textarea.value = "the keeper is a cultist";
  textarea.dispatchEvent(new Event("blur"));
  await settle();
  assert.equal(vaultStore.data.hiddenBlocks[tavernId].blocks[hiddenId].text, "the keeper is a cultist");
  assert.equal(sharedByName("Tavern").system.blocks.length, 1);
});

test("splitting a hidden block with a blank line creates another hidden block", async () => {
  editor.render();
  blockEl(hiddenId).click();
  const textarea = editor.root.querySelector(".jn-block-input");
  textarea.value = "first\n\nsecond";
  textarea.selectionStart = textarea.selectionEnd = "first\n".length;
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await settle();
  const texts = Object.values(vaultStore.data.hiddenBlocks[tavernId].blocks).map(b => b.text).sort();
  assert.deepEqual(texts, ["\nsecond", "first"].sort());
  assert.equal(sharedByName("Tavern").system.blocks.length, 1);
});

test("GM saving a shared block that names a secret note by GM title is refused", async () => {
  editor.render();
  blockEl(firstBlock).click(); // active GM: lock granted locally, editor switches to editing
  await settle();
  const textarea = editor.root.querySelector(".jn-block-input");
  assert.ok(textarea, "shared block editing");
  const vexTitle = vaultStore.data.notes[vexId].name;
  textarea.value = `See [[${vexTitle}]]`;
  textarea.dispatchEvent(new Event("blur"));
  await settle();
  assert.ok(errors().some(([, m]) => m.includes("links a secret note")));
  assert.ok(!sharedByName("Tavern").system.blocks[0].text.includes("GM-"));
  assert.ok(!sharedByName(vexTitle), "no public note with the GM title");
});

test("reveal button declassifies the hidden block", async () => {
  editor.render();
  const ids = Object.keys(vaultStore.data.hiddenBlocks[tavernId].blocks);
  const target = ids.find(id => vaultStore.data.hiddenBlocks[tavernId].blocks[id].text === "first");
  blockEl(target).querySelector('[data-act="reveal"]').click();
  await settle();
  assert.ok(sharedByName("Tavern").system.blocks.some(b => b.text === "first"));
});

test("hide button moves a shared block into the vault", async () => {
  editor.render();
  const target = sharedByName("Tavern").system.blocks.find(b => b.text === "first").blockId;
  answers.push(true); // confirm
  blockEl(target).querySelector('[data-act="hide"]').click();
  await settle();
  assert.ok(!sharedByName("Tavern").system.blocks.some(b => b.text === "first"));
  assert.ok(Object.values(vaultStore.data.hiddenBlocks[tavernId].blocks).some(b => b.text === "first"));
});

test("+ Hidden block adds an empty GM-only block and opens it", async () => {
  editor.render();
  editor.root.querySelector(".journalinator-add-hidden").click();
  await settle();
  assert.ok(editor.root.querySelector(".jn-block-input"));
  assert.equal(editor.editingSecret, true);
  editor.root.querySelector(".jn-block-input").dispatchEvent(new Event("blur"));
  await settle();
});

test("declassifying while editing checks the unsaved text for secret mentions", async () => {
  const sourceId = await secrets.createSecretNote({ title: "Warn Source", x: 0, y: 200 });
  await secrets.createSecretNote({ title: "Quiet Ally", x: 220, y: 200 });
  const blockId = vaultStore.data.notes[sourceId].blocks[0].blockId;

  editor.open(sourceId);
  editor.render();
  blockEl(blockId).click();
  const textarea = editor.root.querySelector(".jn-block-input");
  textarea.value = "The plan involves [[Quiet Ally]].";
  answers.push("Warn Source", false); // title, then decline the bare-mention confirmation
  editor.root.querySelector(".journalinator-declassify").click();
  await settle();

  assert.equal(sharedByName("Warn Source"), undefined);
  assert.ok(vaultStore.data.notes[sourceId], "cancelled declassification leaves the secret note intact");
});

test("secret note shows the GM banner, renames keep the prefix, declassify publishes", async () => {
  editor.open(vexId);
  editor.render();
  assert.ok(editor.root.querySelector(".jn-gm-banner"));
  const prefix = vaultStore.data.notes[vexId].name.slice(0, 8);
  editor.root.querySelector(".jn-inline-title").click();
  const titleInput = editor.root.querySelector(".jn-inline-title-input");
  titleInput.value = "Lady Vex";
  titleInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  assert.equal(vaultStore.data.notes[vexId].name, `${prefix}Lady Vex`);

  editor.render();
  const block = vaultStore.data.notes[vexId].blocks[0].blockId;
  blockEl(block).click();
  const textarea = editor.root.querySelector(".jn-block-input");
  textarea.value = "A noble of the [[Tavern]] district.";
  textarea.dispatchEvent(new Event("blur"));
  await settle();

  answers.push("Lady Vex");
  editor.render();
  editor.root.querySelector(".journalinator-declassify").click();
  await settle();
  const page = containers.shared.pages.get(vexId);
  assert.equal(page?.name, "Lady Vex");
  assert.ok(page.system.links.some(l => l.targetId === tavernId));
});

test("canvas renders secret cards, hidden links and GM toolbar buttons", async () => {
  const cultId = await secrets.createSecretNote({ title: "Cult", x: 0, y: 300, style: "wanted" });
  await secrets.addHiddenLink(tavernId, cultId, { sourceSide: "bottom", targetSide: "left" });
  const calls = [];
  const canvas = new JournalCanvas(new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) }));
  document.body.appendChild(canvas.root);
  canvas.gmMode = true;
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  const card = canvas.root.querySelector(`.jn-card[data-id="${cultId}"]`);
  assert.ok(card.classList.contains("jn-secret"));
  assert.equal(card.querySelector(".jn-card-link"), null);
  assert.equal(canvas.root.querySelector(".jn-tooltip"), null, "hover tooltip was removed");
  const hiddenLink = canvas.root.querySelector("g.jn-link-hidden");
  assert.ok(hiddenLink, "hidden link drawn");

  const pathBefore = hiddenLink.querySelector("path:not(.jn-link-hit)").getAttribute("d");
  card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  canvas.root.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, button: 0, clientX: 90, clientY: 45 }));
  await new Promise(resolve => setTimeout(resolve, 25));
  const pathAfter = canvas.root.querySelector("g.jn-link-hidden path:not(.jn-link-hit)").getAttribute("d");
  assert.notEqual(pathAfter, pathBefore, "connection follows a locally dragged card before the write is sent");
  canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 90, clientY: 45 }));
  assert.ok(calls.some(([name]) => name === "onMoveCard"), "card position is committed on release");

  for (let click = 0; click < 2; click++) {
    card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  }
  assert.ok(calls.some(([name, id]) => name === "onEditNote" && id === cultId), "double-click starts editing");

  const linkHit = canvas.root.querySelector(".jn-link-hit");
  for (let i = 0; i < 2; i++) {
    linkHit.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
    linkHit.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
  }
  assert.ok(calls.some(([name]) => name === "onDeleteLink"), "double-clicking a connection removes it");

  canvas.root.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 100, clientY: 100 }));
  const locationButton = canvas.root.querySelector('.jn-context-menu [data-action="location"]');
  assert.ok(locationButton, "right-click opens the add menu");
  locationButton.click();
  assert.ok(calls.some(([name, , , options]) => name === "onCreateNoteAt" && options.kind === "location"));

  // Player view: no secret card.
  notesStore.setGmView(false);
  canvas.gmMode = false;
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  assert.equal(canvas.root.querySelector(`.jn-card[data-id="${cultId}"]`), null);
  assert.equal(canvas.root.querySelector("g.jn-link-hidden"), null);
  notesStore.setGmView(true);
});

test("Backspace removes labels and stamps or trashes notes, and Ctrl+Z restores notes", async () => {
  const app = new JournalApp();
  const context = await app._prepareContext();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  app._replaceHTML(await app._renderHTML(context), host);
  app._onFirstRender();

  const card = host.querySelector(`.jn-card[data-id="${tavernId}"]`);
  const canvas = host.querySelector(".jn-canvas");
  await requestWrite({ type: "addLabel", text: "Test label" });
  await requestWrite({ type: "addLabel", stamp: "paw" });
  await requestWrite({ type: "addLabel", stamp: "skull", noteId: tavernId });
  for (const selector of [".jn-label:not(:has(.jn-stamp))", ".jn-label .jn-stamp", ".jn-card-stamps .jn-stamp"]) {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    const element = canvas.querySelector(selector);
    assert.ok(element, selector);
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    assert.ok(canvas.querySelector(".jn-label-selected"));
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }));
    await settle();
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    assert.equal(canvas.querySelector(selector), null);
  }
  card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
  assert.equal(document.activeElement, canvas, "selection re-render preserves keyboard focus");
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }));
  await settle();
  assert.ok(sharedByName("Tavern").system.deleted, "Backspace moves the selected note to trash");

  app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyZ", key: "я", ctrlKey: true }));
  await settle();
  assert.equal(sharedByName("Tavern").system.deleted, null, "Ctrl+Z restores the last keyboard deletion");

  app._onClose();
  host.remove();
});

test("the selection box includes labels and an empty-board double click opens the creation menu", () => {
  const calls = [];
  const canvas = new JournalCanvas(new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) }));
  document.body.appendChild(canvas.root);
  canvas.update([], { cards: {}, labels: {
    one: { x: 20, y: 20, text: "One" },
    two: { x: 40, y: 40, text: "Two" },
    three: { x: 100, y: 100, text: "Three" }
  } });
  for (const [index, label] of [...canvas.root.querySelectorAll(".jn-label")].entries()) {
    const origin = [20, 40, 100][index];
    label.getBoundingClientRect = () => ({ left: origin, top: origin, right: origin + 10, bottom: origin + 10 });
  }
  const pointer = (type, x, y) => canvas.root.dispatchEvent(new MouseEvent(type, {
    bubbles: true, button: 0, clientX: x, clientY: y
  }));
  pointer("pointerdown", 10, 10);
  pointer("pointermove", 60, 60);
  pointer("pointerup", 60, 60);
  assert.deepEqual(canvas.getSelectedLabelIds(), ["one", "two"]);
  assert.equal(canvas.root.querySelectorAll(".jn-label-selected").length, 2);
  assert.equal(canvas.contextMenu.style.display, "none");

  for (let click = 0; click < 2; click++) {
    pointer("pointerdown", 70, 70);
    pointer("pointerup", 70, 70);
  }
  assert.equal(canvas.contextMenu.style.display, "flex");
  assert.ok(canvas.contextMenu.querySelector('[data-action="note"]'));
  canvas.contextMenu.querySelector('[data-action="label"]').click();
  assert.ok(calls.some(([name]) => name === "onAddLabelAt"));
  canvas.root.remove();
});

test("keyboard deletion shortcuts ignore text inputs", () => {
  const input = document.createElement("input");
  const editable = document.createElement("div");
  editable.setAttribute("contenteditable", "true");
  document.body.append(input, editable);
  assert.equal(isTextEntryTarget(input), true);
  assert.equal(isTextEntryTarget(editable), true);
  assert.equal(isTextEntryTarget(document.body), false);
  input.remove();
  editable.remove();
});

test("creation dialog offers five styles and keeps a custom title", async () => {
  const { promptNewNote } = await import(`${JN}/scripts/app/note-dialog.mjs`);
  const dialog = foundry.applications.api.DialogV2;
  const prompt = dialog.prompt;
  const form = document.createElement("form");
  document.body.appendChild(form);
  try {
    dialog.prompt = async options => {
      form.innerHTML = options.content;
      options.render(null, { element: form });
      const { style, noteTitle } = form.elements;
      assert.deepEqual([...style.options].map(option => option.value), ["sticky", "document", "torn", "wanted", "memo"]);
      assert.equal(document.activeElement, noteTitle);
      assert.equal(noteTitle.selectionEnd, noteTitle.value.length);
      noteTitle.value = "Missing Person";
      style.value = "wanted";
      style.dispatchEvent(new Event("change"));
      return options.ok.callback(null, { form });
    };
    assert.deepEqual(await promptNewNote("New Note"), { title: "Missing Person", style: "wanted", autoTitle: false });
  } finally {
    dialog.prompt = prompt;
    form.remove();
  }
});

test("clicking a sidebar name renames the note independently of its target heading", async () => {
  await requestWrite({ type: "createNote", title: "Person of Interest", style: "wanted", x: 2000, y: 0 });
  await settle();
  const noteId = sharedByName("Person of Interest").id;
  editor.open(noteId);
  editor.render();
  editor.root.querySelector(".jn-inline-title").click();
  const title = editor.root.querySelector(".jn-inline-title-input");
  assert.equal(document.activeElement, title);
  assert.equal(title.selectionEnd, title.value.length);
  title.value = "Known Witness";
  title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  editor.render();
  const heading = editor.root.querySelector(".journalinator-target-heading");
  heading.value = "Witness";
  heading.dispatchEvent(new Event("change"));
  await settle();
  assert.equal(sharedByName("Known Witness").system.targetHeading, "Witness");
  const canvas = new JournalCanvas({});
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  const card = canvas.root.querySelector(`[data-id="${noteId}"]`);
  assert.equal(card.querySelector(".jn-card-wanted-heading").textContent, "Witness");
  assert.equal(card.querySelector(".jn-card-title").textContent, "Known Witness");
});

test("one click edits each target field on the board and saves through the existing writes", async () => {
  const page = sharedByName("Known Witness");
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
  await redraw();
  app._onFirstRender();
  try {
    const card = host.querySelector(`.jn-card[data-id="${page.id}"]`);
    const canvas = card.closest(".jn-canvas");
    const click = selector => {
      card.querySelector(selector).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    };
    const key = (input, value, options = {}) => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, ...options }));
    };
    click(".jn-card-wanted-heading");
    let input = card.querySelector("input");
    assert.equal(document.activeElement, input);
    input.value = "Suspect";
    await redraw();
    assert.equal(document.activeElement, input);
    key(input, "Enter");
    await settle();
    assert.equal(page.system.targetHeading, "Suspect");
    await redraw();

    click(".jn-card-title");
    input = card.querySelector("input");
    input.value = "New Name";
    key(input, "Enter");
    await settle();
    assert.equal(page.name, "New Name");
    await redraw();

    click(".jn-card-block-empty");
    await settle();
    const textarea = card.querySelector("textarea");
    assert.equal(document.activeElement, textarea);
    assert.equal(textarea.value, "");
    textarea.value = "A statement recorded on the board.";
    key(textarea, "Enter", { ctrlKey: true });
    await settle();
    assert.equal(page.system.blocks[0].text, "A statement recorded on the board.");
    await redraw();
    assert.equal(card.querySelector(".jn-card-block").textContent, page.system.blocks[0].text);

    click(".jn-card-block");
    await settle();
    const again = card.querySelector("textarea");
    again.value = "Discard this revision.";
    key(again, "Escape");
    await settle();
    assert.equal(card.querySelector("textarea"), null);
    assert.equal(page.system.blocks[0].text, "A statement recorded on the board.");
  } finally {
    app._onClose();
    host.remove();
  }
});

test("right-clicking a note opens attached stamp settings", async () => {
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
  app._onRender();
  try {
    assert.equal(host.querySelector(".journalinator-add-stamp"), null);
    assert.ok(host.querySelector(".journalinator-add-link"));
    const canvas = host.querySelector(".jn-canvas");
    const card = canvas.querySelector(".jn-card");
    const menu = canvas.querySelector(".jn-context-menu");
    const open = element => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
    open(canvas);
    assert.ok(menu.querySelector('[data-action="note"]'));
    assert.equal(menu.querySelector('[data-action="stamps"]'), null);
    open(card);
    assert.equal(menu.querySelector('[data-action="ports"]'), null);
    menu.querySelector('[data-action="card-stamp"]').click();
    menu.querySelector('[data-stamp-color="#53936b"]').click();
    menu.querySelector('[data-stamp-corner="top-left"]').click();
    menu.querySelector('[data-stamp="paw"]').click();
    await settle();
    const stamp = Object.values(notesStore.getLayout().labels).find(item => item.noteId === card.dataset.id && item.stamp === "paw");
    assert.equal(stamp.corner, "top-left");
    assert.equal(stamp.color, "#53936b");
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    open(card.querySelector(".jn-card-stamps .jn-stamp"));
    menu.querySelector('[data-stamp-color="#5a83ad"]').click();
    await settle();
    assert.equal(Object.values(notesStore.getLayout().labels).find(item => item.noteId === card.dataset.id).color, "#5a83ad");
    assert.equal(card.querySelector(".jn-card-link"), null);
  } finally {
    app._onClose();
    host.remove();
  }
});

test("the context menu creates the chosen card immediately and the toolbar opens the dialog", async () => {
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const dialog = foundry.applications.api.DialogV2;
  const prompt = dialog.prompt;
  let prompts = 0;
  dialog.prompt = async () => { prompts++; return null; };
  try {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
    const canvas = host.querySelector(".jn-canvas");
    const existing = new Set(containers.shared.pages.keys());
    for (const action of ["note", "memo", "wanted", "location", "note"]) {
      canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
      canvas.querySelector(`[data-action="${action}"]`).click();
    }
    await settle();
    const created = [...containers.shared.pages.values()].filter(page => !existing.has(page.id));
    assert.deepEqual(created.map(page => [page.system.kind, page.system.style]), [
      ["note", "sticky"], ["note", "memo"], ["note", "wanted"], ["location", "document"], ["note", "sticky"]
    ]);
    assert.notEqual(created[0].name, created[4].name);
    assert.equal(prompts, 0);
    host.querySelector(".journalinator-new").click();
    assert.equal(prompts, 1);
  } finally {
    dialog.prompt = prompt;
    app._onClose();
    host.remove();
  }
});

test("toolbar dropdowns filter cards and change the saved board theme", async () => {
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const initialTheme = game.settings.get("fvtt-journalinator", "boardTheme");
  try {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
    assert.equal(host.querySelector(".jn-current-user").textContent, game.user.name);
    assert.equal(host.querySelector(".journalinator-filterbar"), null);
    const filters = host.querySelector(".journalinator-filters");
    filters.querySelector("summary").click();
    assert.equal(filters.open, true);
    assert.ok(filters.querySelector(`[data-kind="author"][value="${game.user.id}"]`));
    const style = filters.querySelector('[value="memo"]');
    style.click();
    const tavern = host.querySelector(`.jn-card[data-id="${tavernId}"]`);
    assert.ok(tavern.classList.contains("jn-dimmed"));
    assert.equal(filters.open, true);
    style.click();
    assert.ok(!tavern.classList.contains("jn-dimmed"));
    const theme = host.querySelector(".journalinator-theme");
    assert.equal(filters.nextElementSibling, theme);
    assert.equal(theme.closest(".jn-toolbar-group").nextElementSibling.querySelector(".journalinator-trash") !== null, true);
    theme.querySelector("summary").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    assert.equal(filters.open, false);
    theme.querySelector("summary").click();
    theme.querySelector('[data-theme-choice="fantasy"]').click();
    await settle();
    assert.equal(game.settings.get("fvtt-journalinator", "boardTheme"), "fantasy");
    assert.equal(host.querySelector(".journalinator-root").dataset.theme, "fantasy");
    assert.equal(theme.open, false);
  } finally {
    await game.settings.set("fvtt-journalinator", "boardTheme", initialTheme);
    app._onClose();
    host.remove();
  }
});

test("cards place foreground images by type and change the background independently", async () => {
  await requestWrite({ type: "createNote", title: "Camera test", style: "document", x: 0, y: 0 });
  await settle();
  const note = sharedByName("Camera test");
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  try {
    await redraw();
    const card = host.querySelector(`.jn-card[data-id="${note.id}"]`);
    const camera = card.querySelector(".jn-card-image-button");
    assert.equal(camera.hidden, false);
    answers.push("https://example.com/content.png");
    camera.click();
    await settle();
    await redraw();
    assert.ok(card.querySelector(".jn-card-excerpt + .jn-card-image"));
    assert.equal(card.querySelector(".jn-card-image img").getAttribute("src"), "https://example.com/content.png");
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
    answers.push("https://example.com/background.png");
    host.querySelector('[data-action="card-background"]').click();
    await settle();
    await redraw();
    assert.equal(card.querySelector(".jn-card-background").getAttribute("src"), "https://example.com/background.png");
    card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    card.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    await redraw();
    const sidebar = host.querySelector(".journalinator-editor");
    assert.equal(sidebar.querySelector(".jn-doc").hidden, true);
    assert.equal(sidebar.querySelector(".jn-doc .jn-block"), null);
    assert.ok(sidebar.querySelector(".jn-note-tool summary"));
    assert.equal(sidebar.querySelector(".journalinator-set-image, .journalinator-style, .journalinator-authors-toggle"), null);
    const type = sidebar.querySelector(".journalinator-kind");
    type.value = "wanted";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    await redraw();
    assert.equal(camera.hidden, false);
    assert.ok(card.querySelector(".jn-card-wanted-heading + .jn-card-image"));
    answers.push("https://example.com/target.png");
    camera.click();
    await settle();
    await redraw();
    assert.equal(card.querySelector(".jn-card-image img").getAttribute("src"), "https://example.com/target.png");
    answers.push("");
    camera.click();
    await settle();
    await redraw();
    assert.equal(card.querySelector(".jn-card-image").hidden, true);
    assert.equal(card.querySelector(".jn-card-background").getAttribute("src"), "https://example.com/background.png");
  } finally {
    app._onClose();
    host.remove();
  }
});

test("search holds focus and results through input and a background redraw", async () => {
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  await redraw();
  try {
    let input = host.querySelector(".journalinator-search");
    input.focus();
    assert.equal(host.querySelector(".jn-switcher").style.display, "block");
    input.value = "Tavern";
    input.setSelectionRange(1, 3);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(document.activeElement, input);
    assert.ok(host.querySelector(`.jn-switcher-item[data-id="${tavernId}"]`));
    const documentFilter = host.querySelector('.journalinator-filters [data-kind="style"][value="document"]');
    documentFilter.checked = true;
    documentFilter.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(host.querySelector(`.jn-switcher-item[data-id="${tavernId}"]`), null,
      "author/style filters also apply to the quick switcher");
    documentFilter.checked = false;
    documentFilter.dispatchEvent(new Event("change", { bubbles: true }));
    assert.ok(host.querySelector(`.jn-switcher-item[data-id="${tavernId}"]`));
    await redraw();
    input = host.querySelector(".journalinator-search");
    assert.equal(document.activeElement, input);
    assert.equal(input.selectionStart, 1);
    assert.equal(input.selectionEnd, 3);
    assert.equal(host.querySelector(".jn-switcher").style.display, "block");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(input.value, "");
    assert.equal(host.querySelector(".jn-switcher").style.display, "none");
    input.focus();
    assert.equal(host.querySelector(".jn-switcher").style.display, "block");
    host.querySelector(".journalinator-stats").focus();
    assert.equal(host.querySelector(".jn-switcher").style.display, "none");
  } finally {
    app._onClose();
    host.remove();
  }
});

test("legacy attachments follow the board edge when a card resizes", async () => {
  const canvas = new JournalCanvas({});
  const fixture = (id, style, links = []) => ({ _id: id, name: id, system: { style, blocks: [], links } });
  const link = { id: "wire", targetId: "memo", sourceSide: "right", targetSide: "top" };
  const notes = [fixture("target", "wanted", [link]), fixture("memo", "memo")];
  const cards = { target: { x: 0, y: 0, width: 250 }, memo: { x: 400, y: 250, width: 360 } };
  canvas.update(notes, { cards, labels: {} }, { deferGeometry: true });

  const source = canvas.cardEls.get("target");
  let height = 300;
  Object.defineProperty(source, "offsetHeight", { get: () => canvas.root.isConnected ? height : 0 });
  document.body.appendChild(canvas.root);

  const originalObserver = globalThis.ResizeObserver;
  let resized;
  globalThis.ResizeObserver = class {
    constructor(callback) { resized = callback; }
    observe() {}
    disconnect() {}
  };
  try {
    canvas.refreshGeometry();
    const path = () => canvas.svg.querySelector(".jn-thread").getAttribute("d");
    assert.match(path(), /^M253 150 /);
    assert.match(path(), / 580 247$/);
    height = 400;
    resized();
    await settle();
    assert.match(path(), /^M253 200 /);
    assert.match(path(), / 580 247$/);
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
    if (originalObserver) globalThis.ResizeObserver = originalObserver;
    else delete globalThis.ResizeObserver;
  }
});

test("Alt-click connects edges through saved board pins and the toolbar can replace the route", async () => {
  const a = sharedByName("Tavern");
  const b = sharedByName("New Name");
  await requestWrite({ type: "resizeCard", noteId: a.id, width: 250, height: 120 });
  await requestWrite({ type: "resizeCard", noteId: b.id, width: 250, height: 120 });
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  await redraw();
  const card = id => host.querySelector(`.jn-card[data-id="${id}"]`);
  const click = (page, x, y, altKey = false) => {
    const data = notesStore.getLayout().cards[page.id];
    const angle = data.rotation * Math.PI / 180;
    const dx = (x - 0.5) * 250, dy = (y - 0.5) * 120;
    card(page.id).querySelector(".jn-card-title").dispatchEvent(new MouseEvent("click", {
      bubbles: true, button: 0, altKey,
      clientX: data.x + 125 + dx * Math.cos(angle) - dy * Math.sin(angle),
      clientY: data.y + 60 + dx * Math.sin(angle) + dy * Math.cos(angle)
    }));
  };
  const selectTool = () => host.querySelector(".journalinator-add-link").click();
  const match = (point, x, y) => {
    assert.ok(Math.abs(point.x - x) < 1e-8);
    assert.ok(Math.abs(point.y - y) < 1e-8);
  };
  try {
    click(a, 0.5, 0.5, true);
    assert.equal(host.querySelector(".jn-canvas").dataset.placingLink, "true");
    assert.equal(host.querySelector(".jn-link-preview"), null);
    click(a, 0.32, 0.96);
    assert.ok(host.querySelector(".jn-link-preview"));
    assert.equal(host.querySelector(".jn-card-text-input"), null);
    assert.ok(!a.system.links.some(link => link.targetId === b.id));
    for (const [clientX, clientY] of [[100, 310], [260, 350]]) {
      host.querySelector(".jn-canvas").dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, clientX, clientY }));
    }
    assert.equal(host.querySelectorAll(".jn-board-pin").length, 2);
    click(b, 0.98, 0.35);
    await settle();
    const link = a.system.links.find(link => link.targetId === b.id);
    match(link.sourcePoint, 0.32, 1);
    match(link.targetPoint, 1, 0.35);
    assert.deepEqual(link.pins, [{ x: 100, y: 310 }, { x: 260, y: 350 }]);
    await redraw();
    const thread = host.querySelector(`g[data-id="${link.id}"]`);
    assert.equal(thread.querySelectorAll(".jn-thread-pin").length, 4);
    assert.match(thread.querySelector(".jn-thread").getAttribute("d"), /100 310 M100 310/);
    assert.match(thread.parentElement.getAttribute("mask"), /^url\(#jn-thread-mask-/);
    const lineEnd = thread.querySelector(".jn-thread").getAttribute("d").match(/([-\d.]+) ([-\d.]+)$/).slice(1).join(",");
    assert.equal(thread.querySelector(".jn-link-arrow").getAttribute("points").split(" ")[0], lineEnd.replace(" ", ","));
    assert.equal(host.querySelector(".jn-link-preview"), null);
    const marker = thread.querySelector('[data-pin-index="0"]');
    const canvas = host.querySelector(".jn-canvas");
    marker.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 310 }));
    canvas.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 130, clientY: 300 }));
    assert.equal(marker.getAttribute("cx"), "130");
    canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 130, clientY: 300 }));
    await settle();
    assert.deepEqual(a.system.links.find(item => item.id === link.id).pins, [{ x: 130, y: 300 }, { x: 260, y: 350 }]);
    selectTool();
    click(a, 0.98, 0.68);
    click(b, 0.26, 0.04);
    await settle();
    const links = a.system.links.filter(item => item.targetId === b.id);
    assert.equal(links.length, 1);
    assert.equal(links[0].id, link.id);
    match(links[0].sourcePoint, 1, 0.68);
    match(links[0].targetPoint, 0.26, 0);
    assert.deepEqual(links[0].pins, []);
  } finally {
    app._onClose();
    host.remove();
  }
});

test("left drag plucks one thread and keeps its anchors and the other thread fixed", async () => {
  const canvas = new JournalCanvas({});
  document.body.appendChild(canvas.root);
  const notes = ["a", "b", "c"].map(_id => ({ _id, name: _id, system: { style: "sticky", blocks: [], links: [] } }));
  notes[0].system.links = [
    { id: "ab", targetId: "b", sourceSide: "right", targetSide: "left" },
    { id: "ac", targetId: "c", sourceSide: "right", targetSide: "left" }
  ];
  try {
    canvas.update(notes, { cards: { a: { x: 0, y: 0 }, b: { x: 390, y: 0 }, c: { x: 390, y: 200 } } });
    const line = id => canvas.svg.querySelector(`g[data-id="${id}"] .jn-thread`).getAttribute("d");
    const original = line("ab"), other = line("ac");
    const hit = canvas.root.querySelector('.jn-link-hit[data-id="ab"]');
    const send = (target, type, y) => target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, button: 0, clientX: 285, clientY: y
    }));
    send(hit, "pointerdown", 50);
    send(canvas.root, "pointermove", 110);
    const pulled = line("ab");
    assert.notEqual(pulled, original);
    const ends = value => [value.match(/^M([^ ]+ [^ ]+)/)[1], value.match(/([^ ]+ [^ ]+)$/)[1]];
    assert.deepEqual(ends(pulled), ends(original));
    assert.equal(line("ac"), other);
    send(canvas.root, "pointerup", 110);
    await settle();
    assert.notEqual(line("ab"), pulled);
    assert.equal(line("ac"), other);
    assert.equal(canvas.selectedLinkId, null);
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("offline mode disables write controls and says the board is read-only", async () => {
  gmUser.active = false;
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  try {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
    assert.ok(host.querySelector(".journalinator-offline-banner"));
    assert.equal(host.querySelector(".journalinator-new").disabled, true);
    assert.equal(host.querySelector(".journalinator-add-label").disabled, true);
    assert.equal(host.querySelector(".journalinator-add-link").disabled, true);
    assert.equal(host.querySelector(".journalinator-stats").disabled, false);
    assert.equal(host.querySelector(".jn-context-menu").style.display === "flex", false);
  } finally {
    app._onClose();
    host.remove();
    gmUser.active = true;
  }
});

test("renders Markdown in the editor and toggles a task item", async () => {
  const heading = foundry.utils.randomID();
  const tasks = foundry.utils.randomID();
  const page = await JournalEntryPage.create({
    name: "Markdown fixture",
    type: "fvtt-journalinator.note",
    system: {
      kind: "note", style: "sticky", authorId: gmUser.id,
      blocks: [
        { blockId: heading, text: "# Heading", authorId: gmUser.id },
        { blockId: tasks, text: "- [ ] first\n- [x] second", authorId: gmUser.id }
      ],
      createdAt: Date.now(), updatedAt: Date.now()
    }
  }, { parent: containers.shared });

  editor.open(page.id);
  editor.render();
  assert.ok(editor.root.querySelector(".jn-block-markdown h1"), "heading rendered");
  const boxes = editor.root.querySelectorAll("input.jn-task-checkbox");
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].disabled, false);
  boxes[0].click();
  await settle();
  assert.equal(page.system.blocks[1].text, "- [x] first\n- [x] second");
});

test("toggling a task from another card opens that note for the lock listener", async () => {
  const blockId = foundry.utils.randomID();
  const page = await JournalEntryPage.create({
    name: "Task elsewhere",
    type: "fvtt-journalinator.note",
    system: {
      kind: "note", style: "sticky", authorId: gmUser.id,
      blocks: [{ blockId, text: "- [ ] remote task", authorId: gmUser.id }],
      createdAt: Date.now(), updatedAt: Date.now()
    }
  }, { parent: containers.shared });

  editor.open(null);
  editor.render();
  editor.toggleTask(page.id, blockId, 0);
  await settle();
  assert.equal(editor.noteId, page.id);
  assert.equal(page.system.blocks[0].text, "- [x] remote task");
});

test("canvas cards render Markdown and forward task checkboxes", () => {
  const calls = [];
  const canvas = new JournalCanvas({
    onToggleTask: (noteId, blockId, index) => calls.push([noteId, blockId, index])
  });
  document.body.appendChild(canvas.root);
  const note = {
    _id: "markdowncard00001",
    name: "Markdown card",
    system: {
      style: "sticky", links: [],
      blocks: [{ blockId: "markdownblock001", text: "# Card heading\n\n- [ ] card task" }]
    }
  };
  try {
    canvas.update([note], { cards: { [note._id]: { x: 0, y: 0, rotation: 0 } } });
    assert.ok(canvas.root.querySelector(".jn-card-block-body h1"));
    const box = canvas.root.querySelector("input.jn-task-checkbox");
    assert.ok(box);
    box.click();
    assert.deepEqual(calls, [[note._id, "markdownblock001", 0]]);
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("private canvas is separate and publishes title and text only", async () => {
  const privatePage = await privateStore.createFor(gmUser);
  assert.ok(privatePage);
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  try {
    await redraw();
    const select = host.querySelector(".jn-view-switch");
    select.value = "private";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await redraw();
    assert.ok(host.querySelector(".jn-private-view"));
    assert.ok(host.querySelector(".jn-workspace-name").textContent.includes(privatePage.name));
    assert.equal(host.querySelector(".journalinator-filters"), null);
    assert.ok(host.querySelector(".journalinator-private-new"));

    host.querySelector(".journalinator-private-new").click();
    await settle();
    await redraw();
    const workspace = privateStore.read(privateStore.findActive(gmUser.id));
    const privateNote = Object.values(workspace.notes)[0];
    assert.ok(privateNote, "private note created");
    assert.equal(sharedByName(privateNote.title), undefined, "private note was not published to the shared canvas");

    const card = host.querySelector(`.jn-card[data-id="${privateNote.id}"]`);
    assert.ok(card);
    const block = card.querySelector(".jn-card-block");
    block.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    block.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    const textarea = card.querySelector(".jn-block-input");
    textarea.value = "- [ ] Private task";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await settle();
    await redraw();
    assert.equal(privateStore.read(privateStore.findActive(gmUser.id)).notes[privateNote.id].blocks[0].text, "- [ ] Private task");
    const task = host.querySelector(`.jn-card[data-id="${privateNote.id}"] input.jn-task-checkbox`);
    assert.ok(task, "private task checkbox rendered");
    task.click();
    await settle();
    await redraw();
    assert.equal(privateStore.read(privateStore.findActive(gmUser.id)).notes[privateNote.id].blocks[0].text, "- [x] Private task");

    answers.push("Published private note");
    host.querySelector(".jn-private-publish").click();
    await settle();
    const published = sharedByName("Published private note");
    assert.ok(published, "publish created a shared note");
    assert.deepEqual(published.system.blocks.map(block => block.text), ["- [x] Private task"]);
    assert.equal(published.system.links.length, 0, "publishing copies no links");
    assert.ok(privateStore.findActive(gmUser.id), "private copy remains");
  } finally {
    app._onClose();
    host.remove();
  }
});

test("merging a shared block keeps text typed but not yet saved", async () => {
  const page = await JournalEntryPage.create({
    name: "Merge Test",
    type: "fvtt-journalinator.note",
    system: {
      kind: "note", style: "sticky", authorId: gmUser.id,
      blocks: [
        { blockId: foundry.utils.randomID(), text: "alpha", authorId: gmUser.id },
        { blockId: foundry.utils.randomID(), text: "beta", authorId: gmUser.id }
      ],
      createdAt: Date.now(), updatedAt: Date.now()
    }
  }, { parent: containers.shared });
  const secondId = page.system.blocks[1].blockId;

  editor.open(page.id);
  editor.render();
  blockEl(secondId).click();
  const textarea = editor.root.querySelector(".jn-block-input");
  assert.ok(textarea, "second block is being edited");
  textarea.value = "betaGAMMA";
  textarea.selectionStart = textarea.selectionEnd = 0;
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  await settle();

  const merged = containers.shared.pages.get(page.id);
  assert.equal(merged.system.blocks.length, 1);
  assert.equal(merged.system.blocks[0].text, "alphabetaGAMMA");
});

test("merging a hidden block keeps text typed but not yet saved", async () => {
  const secretId = await secrets.createSecretNote({ title: "Merge Secret", x: 0, y: 0 });
  const firstId = vaultStore.data.notes[secretId].blocks[0].blockId;
  await secrets.saveSecretBlock(secretId, firstId, "alpha");
  const secondId = await secrets.addHiddenBlock(secretId, firstId, "beta");

  editor.open(secretId);
  editor.render();
  blockEl(secondId).click();
  const textarea = editor.root.querySelector(".jn-block-input");
  assert.ok(textarea, "hidden block is being edited");
  textarea.value = "betaGAMMA";
  textarea.selectionStart = textarea.selectionEnd = 0;
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  await settle();

  const blocks = vaultStore.data.notes[secretId].blocks;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "alphabetaGAMMA");
});

test("no unexpected errors were reported", () => {
  const unexpected = errors().filter(([, m]) => !m.includes("links a secret note"));
  assert.deepEqual(unexpected, []);
});
