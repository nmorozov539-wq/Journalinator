/**
 * UI smoke test: renders the real NoteEditor and JournalCanvas in jsdom on top of the fake
 * Foundry and clicks through the GM flows. Catches runtime errors the data-path tests can't.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { resolvePresentation } = await import(`${JN}/scripts/presentation.mjs`);
const { default: NoteEditor } = await import(`${JN}/scripts/app/editor.mjs`);
const { default: JournalCanvas } = await import(`${JN}/scripts/app/canvas.mjs`);
const { default: JournalApp, isTextEntryTarget, themeApplicationChanged } =
  await import(`${JN}/scripts/app/journal-app.mjs`);
const { default: PrivateWorkspace } = await import(`${JN}/scripts/app/private-workspace.mjs`);
const { parsePatchNotes } = await import(`${JN}/scripts/app/patch-notes.mjs`);
const { applyTheme, getTheme } = await import(`${JN}/scripts/styles/themes.mjs`);
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

test("creation dialog offers automatic and three presets and keeps a custom title", async () => {
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
      assert.deepEqual([...style.options].map(option => option.value), ["auto", "memo", "document", "target"],
        "no Sticky or Torn creation entries");
      assert.doesNotMatch([...style.options].map(option => option.textContent).join(" "), /Sticky Note|Torn Paper/i,
        "creation labels never show the legacy Sticky/Torn vocabulary");
      assert.equal(document.activeElement, noteTitle);
      assert.equal(noteTitle.selectionEnd, noteTitle.value.length);
      noteTitle.value = "Missing Person";
      style.value = "target";
      style.dispatchEvent(new Event("change"));
      return options.ok.callback(null, { form });
    };
    assert.deepEqual(await promptNewNote("New Note"), {
      title: "Missing Person",
      style: "wanted",
      autoTitle: false,
      presentation: { extendedStyle: "target", forceExtended: true },
      label: ""
    });
  } finally {
    dialog.prompt = prompt;
    form.remove();
  }
});

test("renaming a note fills an empty label while the target heading stays independent", async () => {
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
  const page = sharedByName("Known Witness");
  assert.equal(page.system.targetHeading, "Witness");
  assert.equal(page.system.label, "Known Witness", "a meaningful rename fills an empty label");
  const canvas = new JournalCanvas({});
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  const card = canvas.root.querySelector(`[data-id="${noteId}"]`);
  assert.equal(card.querySelector(".jn-card-wanted-heading").textContent, "Witness");
  assert.equal(card.querySelector(".jn-card-title").textContent, "Known Witness");
  assert.equal(card.querySelector(".jn-card-title").hidden, false);
  assert.equal(card.querySelector(".jn-card-title").dataset.cardText, "label");
});

test("editor saves the label (including empty) and presentation controls", async () => {
  await requestWrite({ type: "createNote", title: "Control Fixture", x: 2900, y: 0 });
  await settle();
  const page = sharedByName("Control Fixture");
  const reopen = () => {
    editor.open(page.id);
    editor.render();
  };
  const change = (selector, value, event = "change") => {
    const control = editor.root.querySelector(selector);
    assert.ok(control, `${selector} is rendered`);
    if (control.type === "checkbox") control.checked = value;
    else control.value = value;
    control.dispatchEvent(new Event(event, { bubbles: true }));
  };

  reopen();
  change(".journalinator-label", "Visible Label");
  await settle();
  assert.equal(sharedByName("Control Fixture").system.label, "Visible Label");

  reopen();
  change(".journalinator-label", "");
  await settle();
  assert.equal(sharedByName("Control Fixture").system.label, "", "empty label is a valid save");

  reopen();
  change(".journalinator-font", "hand");
  await settle();
  assert.equal(sharedByName("Control Fixture").system.presentation.font, "hand");

  reopen();
  change(".journalinator-picture-layout", "left");
  await settle();
  assert.equal(sharedByName("Control Fixture").system.presentation.pictureLayout, "left");

  reopen();
  assert.equal(editor.root.querySelector(".journalinator-force-extended").checked, false);
  change(".journalinator-force-extended", true);
  await settle();
  assert.equal(sharedByName("Control Fixture").system.presentation.forceExtended, true);

  reopen();
  assert.equal(editor.root.querySelector(".journalinator-torn").checked, false);
  change(".journalinator-torn", true);
  await settle();
  assert.equal(sharedByName("Control Fixture").system.presentation.torn, true);
});

test("private editor saves the label (including empty) and presentation controls", async () => {
  const user = makeUser("Player000000011", { name: "Private Controls" });
  const page = await privateStore.createFor(user);
  const workspace = new PrivateWorkspace({ onChange() {} });
  workspace.setPage(page);
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  try {
    const noteId = await workspace.createNoteAt({ title: "Private Control Note", x: 0, y: 0 });
    workspace.editor.open(noteId);
    workspace.editor.mount(slot);
    const root = workspace.editor.root;
    const reopen = () => workspace.editor.render();
    const change = (selector, value, event = "change") => {
      const control = root.querySelector(selector);
      assert.ok(control, `${selector} is rendered in the private editor`);
      if (control.type === "checkbox") control.checked = value;
      else control.value = value;
      control.dispatchEvent(new Event(event, { bubbles: true }));
    };

    reopen();
    change(".journalinator-label", "Private Label");
    await settle();
    assert.equal(privateStore.read(page).notes[noteId].label, "Private Label");

    reopen();
    change(".journalinator-label", "");
    await settle();
    assert.equal(privateStore.read(page).notes[noteId].label, "", "empty label is saved privately");

    reopen();
    change(".journalinator-font", "display");
    await settle();
    assert.equal(privateStore.read(page).notes[noteId].presentation.font, "display");

    reopen();
    change(".journalinator-picture-layout", "right");
    await settle();
    assert.equal(privateStore.read(page).notes[noteId].presentation.pictureLayout, "right");

    reopen();
    change(".journalinator-force-extended", true);
    await settle();
    assert.equal(privateStore.read(page).notes[noteId].presentation.forceExtended, true);

    reopen();
    change(".journalinator-torn", true);
    await settle();
    assert.equal(privateStore.read(page).notes[noteId].presentation.torn, true);
  } finally {
    workspace.destroy();
    slot.remove();
    await privateStore.remove(page);
  }
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
    assert.equal(page.system.label, "New Name", "the card edits the optional label, not the Foundry name");
    assert.equal(page.name, "Known Witness", "the internal name is owned by the editor");
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
    canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
    assert.deepEqual([...canvas.querySelectorAll(".jn-context-menu button[data-action]")]
      .map(button => button.dataset.action),
    ["note", "memo", "document", "target", "location", "label", "secret-note", "gm-label"],
    "creation menu offers New note then the three extended presets with no Sticky or Torn entries");
    canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    const existing = new Set(containers.shared.pages.keys());
    for (const action of ["note", "memo", "document", "target", "location"]) {
      canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
      canvas.querySelector(`[data-action="${action}"]`).click();
    }
    await settle();
    const created = [...containers.shared.pages.values()].filter(page => !existing.has(page.id));
    assert.deepEqual(created.map(page => page.system.kind), ["note", "note", "note", "note", "location"]);
    assert.deepEqual(created.slice(0, 4).map(page => page.system.presentation.extendedStyle),
      ["memo", "memo", "document", "target"]);
    assert.deepEqual(created.slice(0, 4).map(page => page.system.presentation.forceExtended),
      [false, true, true, true]);
    assert.notEqual(created[0].name, created[1].name);
    assert.equal(prompts, 0);
    host.querySelector(".journalinator-new").click();
    assert.equal(prompts, 1);
  } finally {
    dialog.prompt = prompt;
    app._onClose();
    host.remove();
  }
});

test("toolbar dropdowns filter cards and keep the theme selector inert", async () => {
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
    const style = filters.querySelector('[value="document"]');
    style.click();
    const tavern = host.querySelector(`.jn-card[data-id="${tavernId}"]`);
    assert.ok(tavern.classList.contains("jn-dimmed"));
    assert.equal(filters.open, true);
    style.click();
    assert.ok(!tavern.classList.contains("jn-dimmed"));

    // The theme selector stays in place but is visibly inactive: no palette popup, no write,
    // no appearance change. Theme token/API coverage lives in tests/theme.test.mjs.
    const theme = host.querySelector(".journalinator-theme");
    assert.ok(theme, "the theme selector is still rendered");
    assert.equal(filters.nextElementSibling, theme);
    assert.equal(theme.closest(".jn-toolbar-group").nextElementSibling.querySelector(".journalinator-trash") !== null, true);
    assert.notEqual(theme.hidden, true, "the selector stays visible");
    const control = theme.matches("button, summary") ? theme : theme.querySelector("button, summary");
    const inactive = [theme, control].filter(Boolean).some(node =>
      node.disabled === true
      || node.hasAttribute("disabled")
      || node.getAttribute("aria-disabled") === "true"
      || node.hasAttribute("inert")
      || node.dataset.disabled === "true"
      || node.dataset.inactive === "true");
    assert.ok(inactive, "the theme selector is disabled or inert");
    const inactiveLabel = game.i18n.localize("JN.Theme.PickerInactive");
    assert.equal(theme.getAttribute("aria-label"), inactiveLabel, "the inert details has an accessible name");
    assert.equal(control?.getAttribute("aria-label"), inactiveLabel, "the summary has an accessible name");
    assert.equal(theme.open, false, "the disabled details starts closed");
    const panel = theme.querySelector(".jn-toolbar-panel");
    assert.equal(panel.getAttribute("aria-hidden"), "true", "the panel is hidden from assistive tech");
    assert.equal(panel.hasAttribute("inert"), true, "the panel is inert");
    const choices = [...panel.querySelectorAll("button")];
    assert.ok(choices.length >= 2, "the theme list is still rendered");
    assert.ok(choices.every(button => button.disabled), "every theme choice is disabled");
    const board = host.querySelector(".journalinator-root");
    const themeBefore = board.dataset.theme;
    control?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    control?.click();
    await settle();
    assert.equal(theme.open, false, "trying to open the inert details is refused");
    assert.equal(game.settings.get("fvtt-journalinator", "boardTheme"), initialTheme,
      "clicking the inert selector never changes the saved theme");
    assert.equal(board.dataset.theme, themeBefore, "the applied theme never changes");

    // The disabled look is CSS-only; the selector never becomes hidden.
    const journalCss = readFileSync(new URL("../../styles/journal.css", import.meta.url), "utf8");
    assert.match(journalCss,
      /\.journalinator-theme\[aria-disabled="true"\]\s*\{[^}]*opacity:\s*0?\.55;[^}]*cursor:\s*not-allowed;/,
      "the inert theme selector has a disabled opacity and cursor");
    assert.match(journalCss,
      /\.journalinator-theme\[aria-disabled="true"\]\s+summary\s*\{[^}]*cursor:\s*not-allowed;/,
      "the inert summary has a disabled cursor");
    const canvas = board.querySelector(".jn-canvas");
    assert.ok(["none", "stylized"].includes(canvas.dataset.boardPattern),
      `the board uses the stylized material, not "${canvas.dataset.boardPattern}"`);
    assert.notEqual(canvas.dataset.boardPattern, "dots");
    assert.notEqual(canvas.dataset.boardPattern, "grid");
    assert.equal(canvas.style.getPropertyValue("--jn-board-cork-size"), "320px",
      "the applied theme uses the 320px cork material, not the retired pattern size");
  } finally {
    await game.settings.set("fvtt-journalinator", "boardTheme", initialTheme);
    app._onClose();
    host.remove();
  }
});

test("journalinatorThemeChanged fires when the applied theme changes, not on every render", async () => {
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const initial = game.settings.get("fvtt-journalinator", "boardTheme");
  const seen = [];
  const onChange = (id, theme) => seen.push([id, theme.id]);
  const hookId = Hooks.on("journalinatorThemeChanged", onChange);
  const draw = async () => app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
  try {
    await game.settings.set("fvtt-journalinator", "boardTheme", "stylized");
    await draw();
    assert.deepEqual(seen, [["stylized", "stylized"]], "the first applied theme is announced");

    await draw();
    await draw();
    assert.equal(seen.length, 1, "re-rendering the same theme does not refire the hook");

    await game.settings.set("fvtt-journalinator", "boardTheme", "parchment");
    await draw();
    assert.deepEqual(seen.at(-1), ["parchment", "parchment"]);
    assert.equal(seen.length, 2);

    await draw();
    assert.equal(seen.length, 2, "a re-render of parchment stays silent");

    // A regenerated scene palette keeps the synthetic "scene" id but changes the theme object.
    const sceneA = { id: "scene", theme: { id: "scene" } };
    const sceneB = { id: "scene", theme: { id: "scene" } };
    assert.equal(themeApplicationChanged(sceneA, sceneA.theme), false, "same cached scene object is silent");
    assert.equal(themeApplicationChanged(sceneA, sceneB.theme), true, "a new scene palette is announced");
  } finally {
    Hooks.off("journalinatorThemeChanged", hookId);
    await game.settings.set("fvtt-journalinator", "boardTheme", initial);
    app._onClose();
    host.remove();
  }
});

test("cards place explicit images by layout and change the background independently", async () => {
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
    assert.equal(card.querySelector(".jn-card-image").hidden, false);
    assert.ok(card.querySelector(".jn-card-body > .jn-card-image"), "explicit image lives in the card body");
    assert.ok(card.querySelector(".jn-card-body > .jn-card-text .jn-card-excerpt"));
    assert.equal(card.querySelector(".jn-card-image img").getAttribute("src"), "https://example.com/content.png");
    assert.ok(card.classList.contains("jn-extended"), "adding an image promotes the card");
    assert.ok(card.classList.contains("jn-card-document"), "adding an image never selects Target");
    assert.ok(card.classList.contains("jn-pic-above"));

    await requestWrite({ type: "setNotePresentation", noteIds: [note.id], fields: { pictureLayout: "left" } });
    await settle();
    await redraw();
    assert.ok(card.classList.contains("jn-pic-left"), "picture layout is independent of the style");
    assert.ok(card.classList.contains("jn-card-document"));

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
    type.value = "target";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    await redraw();
    assert.equal(camera.hidden, false);
    assert.ok(card.classList.contains("jn-card-wanted"));
    assert.ok(card.querySelector(".jn-card-wanted-heading"));
    assert.equal(card.querySelector(".jn-card-wanted-heading").hidden, false);
    assert.ok(card.querySelector(".jn-card-body > .jn-card-image"));
    assert.ok(card.classList.contains("jn-pic-left"), "changing extended style keeps the picture layout");
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
    card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
    answers.push("worlds/camera/cork.webp");
    host.querySelector('[data-action="card-background"]').click();
    await settle();
    await redraw();
    assert.equal(card.querySelector(".jn-card-background").getAttribute("src"), "worlds/camera/cork.webp");
  } finally {
    app._onClose();
    host.remove();
  }
});

test("cards hide the internal name, show labels, and promote on qualifying content", () => {
  const canvas = new JournalCanvas({});
  document.body.appendChild(canvas.root);
  const base = (id, system = {}) => ({
    _id: id,
    name: "New Note 7",
    system: {
      style: "sticky", authorId: gmUser.id, links: [],
      blocks: [{ blockId: `${id}-block`, text: "three short words" }],
      ...system
    }
  });
  const notes = [
    base("untitledcard0001"),
    base("labelledcard0001", { label: "Captain Vex" }),
    base("headingcard00001", { presentation: { heading: "Bounty" } }),
    base("picturecard00001", { image: "worlds/test/picture.webp" }),
    base("targetcard00001", {
      style: "wanted",
      presentation: { extendedStyle: "target", forceExtended: true, heading: "" }
    })
  ];
  const cards = Object.fromEntries(notes.map((note, index) => [note._id, { x: index * 300, y: 0, rotation: 0 }]));
  try {
    canvas.update(notes, { cards, labels: {} });
    const card = id => canvas.root.querySelector(`.jn-card[data-id="${id}"]`);

    const untitled = card("untitledcard0001");
    assert.ok(untitled.classList.contains("jn-compact"));
    assert.equal(untitled.querySelector(".jn-card-title").hidden, true);
    assert.equal(untitled.querySelector(".jn-card-title").textContent, "");
    assert.equal(untitled.textContent.includes("New Note 7"), false, "the internal Foundry name is never displayed");
    assert.ok(untitled.querySelector(".jn-card-signature").textContent, "the author signature stays visible");

    const labelled = card("labelledcard0001");
    assert.ok(labelled.classList.contains("jn-extended"), "a label promotes to extended");
    assert.equal(labelled.querySelector(".jn-card-title").hidden, false);
    assert.equal(labelled.querySelector(".jn-card-title").textContent, "Captain Vex");
    assert.equal(labelled.querySelector(".jn-card-title").dataset.cardText, "label");

    assert.ok(card("headingcard00001").classList.contains("jn-extended"), "a heading promotes to extended");
    const picture = card("picturecard00001");
    assert.ok(picture.classList.contains("jn-extended"), "a picture promotes to extended");
    assert.equal(picture.classList.contains("jn-card-wanted"), false, "a picture never selects Target");

    const target = card("targetcard00001");
    assert.equal(target.querySelector(".jn-card-wanted-heading").hidden, false);
    assert.equal(target.querySelector(".jn-card-wanted-heading").textContent, "Target",
      "an empty target heading falls back to the Target label");
    assert.equal(target.querySelector(".jn-card-title").hidden, true);

    delete notes[3].system.image;
    canvas.update(notes, { cards, labels: {} });
    assert.ok(card("picturecard00001").classList.contains("jn-compact"),
      "removing the only promoting condition demotes the card");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("stylized canvas uses cork, paper surfaces, fonts and torn clipping on the paper only", () => {
  const canvas = new JournalCanvas({});
  document.body.appendChild(canvas.root);
  const base = (id, system = {}) => ({
    _id: id,
    name: `Internal ${id}`,
    system: {
      style: "sticky", authorId: gmUser.id, links: [],
      blocks: [{ blockId: `${id}-block`, text: "three short words" }],
      ...system
    }
  });
  const notes = [
    base("stylizedcompact01"),
    base("stylizedmemo0001", {
      presentation: { extendedStyle: "memo", forceExtended: true, font: "default", torn: true }
    }),
    base("stylizeddoc00001", {
      presentation: { extendedStyle: "document", forceExtended: true, font: "hand" }
    }),
    base("stylizedtarget01", {
      presentation: { extendedStyle: "target", forceExtended: true, font: "display", torn: true }
    })
  ];
  const cards = Object.fromEntries(notes.map((note, index) => [note._id, { x: index * 300, y: 0, rotation: 0 }]));
  const layout = { cards, labels: {} };
  try {
    canvas.update(notes, layout);
    const card = id => canvas.root.querySelector(`.jn-card[data-id="${id}"]`);

    assert.equal(canvas.root.dataset.boardPattern, "stylized", "the board advertises the stylized material");
    assert.notEqual(canvas.root.dataset.boardPattern, "dots");
    assert.notEqual(canvas.root.dataset.boardPattern, "grid");
    assert.equal(canvas.root.style.getPropertyValue("--jn-board-cork-size"), "320px",
      "the cork tile keeps its world size");

    for (const note of notes) {
      const el = card(note._id);
      assert.ok(el, `card ${note._id} rendered`);
      assert.ok(el.querySelector(":scope > .jn-card-main"), "paper surface is the main wrapper");
      assert.ok(el.querySelector(":scope > .jn-card-signature").textContent, "author signature remains");
      assert.equal(el.querySelector(".jn-author-stripe, .jn-author-badge, .jn-card-author-stripe, .jn-card-author-badge"), null,
        "no legacy author stripe/badge");
      assert.equal(el.classList.contains("jn-card-sticky"), false, "no legacy sticky class");
      assert.equal(el.classList.contains("jn-card-torn"), false, "torn is a modifier, not a legacy type");
    }

    const compact = card("stylizedcompact01");
    const memo = card("stylizedmemo0001");
    const documentCard = card("stylizeddoc00001");
    const target = card("stylizedtarget01");
    assert.ok(compact.classList.contains("jn-compact"));
    assert.ok(memo.classList.contains("jn-extended") && memo.classList.contains("jn-card-memo"));
    assert.ok(documentCard.classList.contains("jn-extended") && documentCard.classList.contains("jn-card-document"));
    assert.ok(target.classList.contains("jn-extended") && target.classList.contains("jn-card-wanted"));
    assert.ok(documentCard.classList.contains("jn-font-hand"), "per-note font class is preserved");
    assert.ok(target.classList.contains("jn-font-display"), "per-note font class is preserved");
    assert.ok(compact.classList.contains("jn-font-default"));

    assert.ok(memo.classList.contains("jn-torn"));
    const tear = memo.style.getPropertyValue("--jn-tear");
    assert.match(tear, /^polygon\(/, "torn cards expose a CSS polygon");
    assert.ok(memo.dataset.tearSeed, "torn profile is seeded from the stable note id");
    assert.equal(documentCard.classList.contains("jn-torn"), false);
    assert.equal(documentCard.style.getPropertyValue("--jn-tear"), "");
    assert.ok(target.classList.contains("jn-torn"));
    assert.notEqual(target.style.getPropertyValue("--jn-tear"), tear,
      "different note ids get different torn edges");

    canvas.update(notes, layout);
    assert.equal(memo.style.getPropertyValue("--jn-tear"), tear,
      "re-rendering keeps the same torn edge for one note");

    const css = readFileSync(new URL("../../styles/stylized.css", import.meta.url), "utf8");
    assert.ok(css.includes("../assets/stylized/cork.svg"), "cork is a local bundled asset");
    assert.ok(css.includes("../assets/stylized/grain.svg"), "paper grain is a local bundled asset");
    for (const token of ["--jn-sc-paper-compact", "--jn-sc-paper-memo", "--jn-sc-paper-document",
      "--jn-sc-paper-target", "--jn-sc-torn-fiber", "--jn-sc-ink"]) {
      assert.ok(css.includes(`var(${token}`), `${token} is a theme hook`);
    }
    assert.match(css,
      /\.jn-canvas \.jn-card\.jn-torn\s*>\s*\.jn-card-main\s*\{[^}]*clip-path:\s*var\(--jn-tear/,
      "clip-path is applied to the paper wrapper, not the card root");
    assert.doesNotMatch(css,
      /\.jn-canvas \.jn-card\.jn-torn\s*\{[^}]*clip-path:/,
      "the card root itself stays unclipped for pins, stamps, signature and resize");
    assert.equal(css.includes("--jn-board-pattern-paint"), false, "the legacy dot/grid paint is gone");

    // The resize handle sits above the paper wrapper and keeps receiving pointer events.
    assert.match(css,
      /\.jn-canvas \.jn-card \.jn-card-resize\s*\{[^}]*z-index:\s*8;[^}]*pointer-events:\s*auto;/,
      "the resize handle is above .jn-card-main and pointer-interactive");

    // The vignette stops come from the normalized theme data, not hardcoded CSS percentages.
    assert.match(css, /transparent var\(--jn-sc-board-vignette-start, 38%\)/);
    assert.match(css, /var\(--jn-sc-board-vignette-end, 100%\)/);

    // Compact/document layer order: gloss, rules/margin, grain; the grain multiplies underneath.
    const compactBlock = css.match(/\.jn-canvas \.jn-card\.jn-compact > \.jn-card-main \{[^}]*\}/)?.[0] ?? "";
    const documentBlock = css.match(/\.jn-canvas \.jn-card\.jn-card-document > \.jn-card-main \{[^}]*\}/)?.[0] ?? "";
    const inOrder = (block, ...parts) =>
      parts.every((part, index) => index === 0 || block.indexOf(parts[index - 1]) < block.indexOf(part));
    assert.ok(inOrder(compactBlock, "linear-gradient(180deg", "repeating-linear-gradient", "var(--jn-sc-grain"),
      "compact paints gloss and ruling above the grain");
    assert.match(compactBlock, /background-blend-mode:\s*normal, normal, multiply;/);
    assert.ok(inOrder(documentBlock, "linear-gradient(180deg", "var(--jn-sc-doc-margin", "var(--jn-sc-grain"),
      "document paints the gloss and margin band above the grain");
    assert.match(documentBlock, /background-blend-mode:\s*normal, normal, multiply;/);
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("inline label editing reads and saves through the card callbacks", () => {
  const calls = [];
  const canvas = new JournalCanvas({
    onSelectNote() {},
    onReadCardText: (id, kind) => kind === "label" ? "Old label" : "",
    onSaveCardText: (id, kind, value) => calls.push([id, kind, value])
  });
  document.body.appendChild(canvas.root);
  const note = {
    _id: "labelcard000001",
    name: "Internal Name",
    system: {
      style: "sticky", authorId: gmUser.id, label: "Old label", links: [],
      blocks: [{ blockId: "labelblock0001", text: "short text" }]
    }
  };
  const layout = { cards: { [note._id]: { x: 0, y: 0, rotation: 0 } }, labels: {} };
  try {
    canvas.update([note], layout);
    const card = canvas.root.querySelector(`.jn-card[data-id="${note._id}"]`);
    const title = card.querySelector(".jn-card-title");
    title.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    const input = title.querySelector("input");
    assert.ok(input, "clicking the label opens an inline input");
    assert.equal(input.value, "Old label");
    input.value = "New label";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.deepEqual(calls, [[note._id, "label", "New label"]]);
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("picture classes require an image and compact cards keep manual sizes", () => {
  const canvas = new JournalCanvas({});
  document.body.appendChild(canvas.root);
  const note = (id, system = {}) => ({
    _id: id,
    name: "New Note",
    system: {
      style: "sticky", authorId: gmUser.id, links: [],
      blocks: [{ blockId: `${id}-block`, text: "three short words" }],
      ...system
    }
  });
  const notes = [
    note("compactsize00001", { presentation: { pictureLayout: "left" } }),
    note("picturelayout001", {
      image: "worlds/test/portrait.webp",
      presentation: { pictureLayout: "left" }
    })
  ];
  const cards = {
    compactsize00001: { x: 0, y: 0, rotation: 0, width: 260, height: 140 },
    picturelayout001: { x: 400, y: 0, rotation: 0 }
  };
  try {
    canvas.update(notes, { cards, labels: {} });
    const compact = canvas.root.querySelector(`.jn-card[data-id="compactsize00001"]`);
    assert.ok(compact.classList.contains("jn-compact"));
    assert.ok(compact.classList.contains("jn-sized"), "a manual size marks the card as sized");
    assert.ok(compact.classList.contains("jn-pic-left"));
    assert.equal(compact.style.width, "260px", "manual width is written inline beyond the compact max");
    assert.equal(compact.style.minHeight, "140px");
    assert.equal(compact.classList.contains("jn-has-picture"), false,
      "no explicit image means no picture column");

    const picture = canvas.root.querySelector(`.jn-card[data-id="picturelayout001"]`);
    assert.ok(picture.classList.contains("jn-has-picture"));
    assert.ok(picture.classList.contains("jn-pic-left"));

    delete notes[1].system.image;
    canvas.update(notes, { cards, labels: {} });
    assert.equal(picture.classList.contains("jn-has-picture"), false,
      "removing the explicit image drops the picture layout class");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
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
  // Search finds the optional label and visible content, never the internal Foundry name.
  await requestWrite({ type: "setNoteLabel", noteId: tavernId, label: "Tavern" });
  await settle();
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
    assert.doesNotMatch(
      host.querySelector(`.jn-switcher-item[data-id="${tavernId}"]`).textContent,
      /Sticky Note|Torn Paper/i,
      "search metadata uses the new style vocabulary"
    );
    const documentFilter = host.querySelector('.journalinator-filters [data-kind="style"][value="document"]');
    documentFilter.checked = true;
    documentFilter.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(host.querySelector(`.jn-switcher-item[data-id="${tavernId}"]`), null,
      "author/style filters also apply to the quick switcher");
    documentFilter.checked = false;
    documentFilter.dispatchEvent(new Event("change", { bubbles: true }));
    assert.ok(host.querySelector(`.jn-switcher-item[data-id="${tavernId}"]`));

    await requestWrite({ type: "createNote", title: "Internal Only Search Name", x: 1300, y: 0 });
    await settle();
    await redraw();
    input = host.querySelector(".journalinator-search");
    input.focus();
    input.value = "Internal Only Search Name";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const internalNote = sharedByName("Internal Only Search Name");
    assert.equal(host.querySelector(`.jn-switcher-item[data-id="${internalNote.id}"]`), null,
      "the internal Foundry name never appears as a search result");
    assert.doesNotMatch(
      host.querySelector(".jn-switcher").textContent,
      /Sticky Note|Torn Paper/i,
      "search results never show the legacy style names"
    );

    input.value = "Tavern";
    input.setSelectionRange(1, 3);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
  const b = sharedByName("Known Witness");
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
    card(page.id).dispatchEvent(new MouseEvent("click", {
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

test("link groups carry color slots and state classes without inline paint", async () => {
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  applyTheme(canvas.root, getTheme("classic"));
  const notes = [
    {
      _id: "a", name: "A",
      system: {
        style: "sticky", blocks: [], links: [
          { id: "legacy", targetId: "b", color: "#A393F2", label: "Legacy", direction: "one", sourceSide: "right", targetSide: "left" },
          { id: "hint", targetId: "c", color: "link2", hint: true, label: "Hint", lineStyle: "dashed", sourceSide: "right", targetSide: "left" },
          { id: "hidden", targetId: "d", color: "link3", hidden: true, label: "Hidden", lineStyle: "dashed", sourceSide: "right", targetSide: "left" }
        ]
      }
    },
    ...["b", "c", "d"].map(id => ({ _id: id, name: id, system: { style: "sticky", blocks: [], links: [] } }))
  ];
  const cards = {
    a: { x: 0, y: 0, rotation: 0 }, b: { x: 400, y: 0, rotation: 0 },
    c: { x: 0, y: 300, rotation: 0 }, d: { x: 400, y: 300, rotation: 0 }
  };
  try {
    canvas.update(notes, { cards, labels: {} });
    const group = id => canvas.svg.querySelector(`g[data-id="${id}"]`);
    const legacy = group("legacy");
    assert.ok(legacy.classList.contains("jn-link-color-link1"), "legacy hex renders as a slot class");
    const thread = legacy.querySelector(".jn-thread");
    assert.equal(thread.hasAttribute("stroke"), false);
    assert.equal(thread.hasAttribute("stroke-width"), false);
    assert.equal(thread.hasAttribute("stroke-dasharray"), false);
    assert.equal(thread.hasAttribute("fill"), false);
    assert.equal(legacy.hasAttribute("opacity"), false);
    const arrow = legacy.querySelector(".jn-link-arrow");
    assert.ok(arrow, "directed link has an arrowhead");
    assert.equal(arrow.hasAttribute("fill"), false);
    assert.match(arrow.getAttribute("style"), /transform-origin:/);

    const hint = group("hint");
    assert.ok(hint.classList.contains("jn-link-hint"));
    assert.ok(hint.classList.contains("jn-link-dashed"));
    const hidden = group("hidden");
    assert.ok(hidden.classList.contains("jn-link-hidden"));
    assert.ok(!hidden.classList.contains("jn-link-dashed"), "hidden wins over dashed");
    assert.equal(hidden.querySelector(".jn-thread").hasAttribute("stroke-dasharray"), false);

    const hit = canvas.root.querySelector('.jn-link-hit[data-id="legacy"]');
    hit.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
    canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
    assert.ok(group("legacy").classList.contains("jn-link-selected"), "selection toggles an existing group");
    const swatch = canvas.linkToolbar.querySelector(".jn-link-swatch-link1");
    assert.ok(swatch?.classList.contains("on"));
    assert.equal(swatch.getAttribute("style"), null, "swatch paint comes from a CSS variable");
    assert.equal(swatch.getAttribute("title"), "Link color 1");
    assert.equal(swatch.getAttribute("aria-label"), "Link color 1");

    canvas.setDimMatch(() => false);
    const dimmed = group("legacy");
    assert.ok(dimmed.classList.contains("jn-link-dimmed"));
    assert.ok(dimmed.classList.contains("jn-link-selected"), "selection survives a redraw");

    const pathBefore = group("legacy").querySelector(".jn-thread").getAttribute("d");
    canvas.root.dispatchEvent(new dom.window.WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY: 500
    }));
    await new Promise(resolve => setTimeout(resolve, 40));
    const comp = Number.parseFloat(canvas.root.style.getPropertyValue("--jn-zoom-comp"));
    const expected = Math.round(Math.min(2, Math.max(0.5, 1 / canvas.view.k)) * 1000) / 1000;
    assert.equal(comp, expected);
    assert.equal(group("legacy").querySelector(".jn-thread").getAttribute("d"), pathBefore, "zoom does not redraw links");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("patch notes open on the canvas with foldable version groups", async () => {
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  const panel = canvas.patchNotes;
  panel.load = async () => parsePatchNotes(`# Notes

## Unreleased — Newest dev note

- Newest bullet.

## 0.8.4 — Keep the note type

- Copy and paste keeps the type.

## 0.8.0 — Private canvases

- Private notes and trash.
`);
  try {
    assert.ok(panel);
    assert.equal(panel.root.hidden, true);
    panel.button.click();
    await settle();
    assert.equal(panel.root.hidden, false);
    assert.equal(panel.selectedId, "unreleased");
    assert.match(panel.reader.textContent, /Newest bullet/);
    const group = panel.root.querySelector('details.jn-patch-series[data-series="0.8"]');
    assert.ok(group, "0.8 is a foldable series");
    assert.equal(group.open, true, "the latest series starts open");

    panel.root.querySelector('[data-version-id="v0.8.0"]').click();
    assert.equal(panel.selectedId, "v0.8.0");
    assert.match(panel.reader.textContent, /Private notes and trash/);
    assert.equal(panel.root.querySelectorAll(".jn-patch-version.on").length, 1);

    panel.root.querySelector(".jn-patch-notes-close").click();
    assert.equal(panel.root.hidden, true);
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

test("actor status renders as a card marker without replacing the seal", () => {
  const canvas = new JournalCanvas({});
  document.body.appendChild(canvas.root);
  const note = {
    _id: "statuscard000001",
    name: "Dead NPC",
    system: { style: "sticky", blocks: [], links: [], actorRef: { actorId: "Actor00000000001", sceneId: null } }
  };
  const layout = {
    cards: { [note._id]: { x: 0, y: 0, rotation: 0 } },
    labels: { seal000000000001: { stamp: "paw", noteId: note._id, corner: "bottom-right" } }
  };
  try {
    canvas.statusFor = () => ({ state: "dead", actorId: "Actor00000000001", sceneId: null, tokenId: null });
    canvas.update([note], layout);
    const card = canvas.root.querySelector(`.jn-card[data-id="${note._id}"]`);
    assert.ok(card.classList.contains("jn-has-status"));
    assert.equal(card.querySelector(".jn-card-status img").getAttribute("src"),
      "modules/fvtt-journalinator/assets/stamps/skull.png");
    assert.ok(card.querySelector(".jn-card-stamps .jn-stamp"), "the decorative seal is still rendered");

    canvas.statusFor = () => null;
    canvas.update([note], layout);
    assert.ok(!card.classList.contains("jn-has-status"));
    assert.equal(card.querySelector(".jn-card-status").hidden, true);
    assert.equal(card.querySelector(".jn-card-status").children.length, 0);
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("private canvas is separate and copies notes through the clipboard", async () => {
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
    app._onFirstRender();
    await redraw();
    const switchView = async view => {
      host.querySelector(".jn-view-switch").click();
      host.querySelector(`.jn-view-option[data-view="${view}"]`).click();
      await redraw();
    };
    await switchView("private");
    assert.ok(host.querySelector(".jn-private-view"));
    assert.ok(host.querySelector(".jn-view-rename"), "private workspace rename icon is in the switcher");
    assert.ok(host.querySelector(".journalinator-filters"), "private style filters are available");
    assert.ok(host.querySelector(".journalinator-private-new"));
    assert.ok(host.querySelector(".journalinator-private-add-label"));
    assert.ok(host.querySelector(".journalinator-private-add-link"));
    assert.ok(host.querySelector(".jn-patch-notes-button"), "patch notes are available on the private canvas");

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

    const page = privateStore.findActive(gmUser.id);
    const data = privateStore.read(page);
    data.notes[privateNote.id].title = "Clipboard private";
    data.notes[privateNote.id].style = "wanted";
    data.notes[privateNote.id].targetHeading = "Type preserved";
    data.notes[privateNote.id].label = "Clipboard label";
    data.notes[privateNote.id].schemaVersion = 1;
    data.notes[privateNote.id].presentation = {
      ...(data.notes[privateNote.id].presentation ?? {}),
      extendedStyle: "target", forceExtended: true, font: "hand", pictureLayout: "left",
      torn: false, heading: "Type preserved", nameGenerated: false
    };
    data.notes[privateNote.id].attachment = {
      mainPinEnabled: false, mainSnapRadius: 18, minorSnapRadius: 3, pinStyle: "wax"
    };
    data.layout.cards[privateNote.id].anchors.minor = {
      kind: "minor", x: 0.2, y: 0.3, createdBy: gmUser.id
    };
    await privateStore.save(page, data, privateStore.flags(page).rev);
    await redraw();

    const privateCanvas = host.querySelector(".jn-canvas");
    privateCanvas.dispatchEvent(new KeyboardEvent("keydown", {
      key: "c", ctrlKey: true, bubbles: true, cancelable: true
    }));
    await settle();

    await switchView("shared");
    const sharedCanvas = host.querySelector(".jn-canvas");
    sharedCanvas.dispatchEvent(new KeyboardEvent("keydown", {
      key: "v", ctrlKey: true, bubbles: true, cancelable: true
    }));
    await settle();
    await redraw();

    const copied = sharedByName("Clipboard private");
    assert.ok(copied, "clipboard paste created a shared note");
    assert.deepEqual(copied.system.blocks.map(block => block.text), ["- [x] Private task"]);
    assert.equal(copied.system.style, "wanted", "clipboard preserves the note type");
    assert.equal(copied.system.targetHeading, "Type preserved");
    assert.equal(copied.system.links.length, 0, "clipboard copies no links");
    assert.equal(copied.system.label, "Clipboard label", "clipboard preserves the label");
    assert.equal(copied.system.schemaVersion, 1);
    assert.equal(copied.system.presentation.font, "hand", "clipboard preserves presentation");
    assert.equal(copied.system.presentation.pictureLayout, "left");
    assert.equal(copied.system.presentation.extendedStyle, "target");
    assert.deepEqual(copied.system.attachment, {
      mainPinEnabled: false, mainSnapRadius: 18, minorSnapRadius: 3, pinStyle: "wax"
    }, "clipboard preserves attachment settings");
    const copiedCardLayout = notesStore.getSharedLayout().cards[copied.id];
    assert.deepEqual(copiedCardLayout.anchors.minor, {
      kind: "minor", x: 0.2, y: 0.3, createdBy: gmUser.id
    }, "clipboard preserves card anchors");
    assert.ok(privateStore.findActive(gmUser.id), "private copy remains");

    // Shared -> private copy/paste.
    const copiedCard = sharedCanvas.querySelector(`.jn-card[data-id="${copied.id}"]`);
    copiedCard.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    copiedCard.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    sharedCanvas.dispatchEvent(new KeyboardEvent("keydown", {
      key: "c", ctrlKey: true, bubbles: true, cancelable: true
    }));
    await settle();

    await switchView("private");
    const privateCanvasAgain = host.querySelector(".jn-canvas");
    privateCanvasAgain.dispatchEvent(new KeyboardEvent("keydown", {
      key: "v", ctrlKey: true, bubbles: true, cancelable: true
    }));
    await settle();
    await redraw();
    const workspaceAfterCopy = privateStore.read(privateStore.findActive(gmUser.id));
    const copiedPrivate = Object.values(workspaceAfterCopy.notes).filter(note => note.title === "Clipboard private");
    assert.equal(copiedPrivate.length, 2, "shared note was pasted into the private workspace");
    assert.ok(copiedPrivate.every(note => note.blocks[0].text === "- [x] Private task"));
    assert.ok(copiedPrivate.every(note => note.style === "wanted"), "shared-to-private paste preserves the type");
    assert.ok(copiedPrivate.every(note => note.targetHeading === "Type preserved"));
    assert.ok(copiedPrivate.every(note => note.label === "Clipboard label"), "shared-to-private paste preserves the label");
    assert.ok(copiedPrivate.every(note => note.presentation.font === "hand"), "shared-to-private paste preserves presentation");
    assert.ok(copiedPrivate.every(note => note.attachment.mainPinEnabled === false
      && note.attachment.pinStyle === "wax"), "shared-to-private paste preserves attachment settings");
    assert.ok(copiedPrivate.every(note => workspaceAfterCopy.layout.cards[note.id].anchors.minor?.x === 0.2),
      "shared-to-private paste preserves card anchors");

    const beforeDelete = Object.keys(privateStore.read(privateStore.findActive(gmUser.id)).notes).length;
    privateCanvasAgain.focus();
    privateCanvasAgain.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Backspace", bubbles: true, cancelable: true
    }));
    await settle();
    await redraw();
    const afterDelete = privateStore.read(privateStore.findActive(gmUser.id));
    assert.equal(Object.keys(afterDelete.notes).length, beforeDelete - 1, "Backspace deletes a private note");
    assert.ok(afterDelete.trash.length >= 1, "deleted private note went to the private trash");
  } finally {
    app._onClose();
    host.remove();
  }
});

test("private workspace uses the same link slots and state classes", async () => {
  let page = privateStore.findActive(gmUser.id);
  if (!page) page = await privateStore.createFor(gmUser);
  const data = privateStore.read(page);
  const cards = data.layout.cards ?? {};
  const a = privateStore.makeNote({ title: "Private A", x: 0, y: 0, cards });
  const b = privateStore.makeNote({ title: "Private B", x: 380, y: 0, cards: { ...cards, [a.note.id]: a.card } });
  a.note.links = [{
    id: "private-link", targetId: b.note.id, color: "#a393f2", direction: "one", lineStyle: "solid",
    sourceSide: "right", targetSide: "left"
  }];
  data.notes[a.note.id] = a.note;
  data.notes[b.note.id] = b.note;
  data.layout.cards[a.note.id] = a.card;
  data.layout.cards[b.note.id] = b.card;
  await privateStore.save(page, data, privateStore.flags(page).rev);

  const workspace = new PrivateWorkspace({});
  workspace.setPage(privateStore.findById(page.id));
  const canvasSlot = document.createElement("div");
  const editorSlot = document.createElement("div");
  document.body.append(canvasSlot, editorSlot);
  try {
    workspace.renderInto(canvasSlot, editorSlot);
    workspace.canvas.refreshGeometry();
    const group = canvasSlot.querySelector('g[data-id="private-link"]');
    assert.ok(group, "private link drawn");
    assert.ok(group.classList.contains("jn-link-color-link1"), "legacy hex normalized on read");
    assert.equal(group.querySelector(".jn-thread").hasAttribute("stroke"), false);
    assert.equal(group.querySelector(".jn-link-arrow").hasAttribute("fill"), false);
  } finally {
    workspace.canvas.disconnectGeometry();
    canvasSlot.remove();
    editorSlot.remove();
  }
});

test("private link edits accept cosmetics and anchors but never identity or target", async () => {
  const user = makeUser("Player000000010", { name: "Private Links" });
  const page = await privateStore.createFor(user);
  const workspace = new PrivateWorkspace({ onChange() {} });
  workspace.setPage(page);
  try {
    const sourceId = await workspace.createNoteAt({ title: "Link Source", x: 0, y: 0 });
    const targetId = await workspace.createNoteAt({ title: "Link Target", x: 400, y: 0 });
    await workspace.createLink(sourceId, targetId, { sourceSide: "right", targetSide: "left" });
    const linkId = workspace.workspace.notes[sourceId].links[0].id;
    workspace.workspace.notes[sourceId].links[0].pins = [{ x: 1, y: 2 }];

    await workspace.updateLink(sourceId, linkId, {
      id: "hijacked-id",
      targetId: "hijacked-target",
      origin: "typed",
      label: "edited",
      direction: "two",
      color: "link1",
      lineStyle: "dashed",
      material: "double",
      thickness: 99,
      slack: -1,
      pattern: "alternating",
      ends: "loose",
      secondaryColor: "link3",
      sourceAnchorId: "main",
      targetAnchorId: "minor-1",
      pinMove: { index: 0, x: 5, y: 6 }
    });

    const link = workspace.workspace.notes[sourceId].links[0];
    assert.equal(link.id, linkId, "identity is never editable");
    assert.equal(link.targetId, targetId, "target is never editable");
    assert.equal(link.origin, "drawn", "origin is never editable");
    assert.equal(link.label, "edited");
    assert.equal(link.direction, "two");
    assert.equal(link.color, "link1");
    assert.equal(link.lineStyle, "dashed");
    assert.equal(link.material, "double");
    assert.equal(link.thickness, 5, "thickness is clamped");
    assert.equal(link.slack, 0, "slack is clamped");
    assert.equal(link.pattern, "alternating");
    assert.equal(link.ends, "loose");
    assert.equal(link.secondaryColor, "link3");
    assert.equal(link.sourceAnchorId, "main");
    assert.equal(link.targetAnchorId, "minor-1");
    assert.deepEqual(link.pins, [{ x: 5, y: 6 }], "pinMove still works alongside cosmetics");
    assert.equal(link.edited, true);

    await workspace.updateLink(sourceId, linkId, {
      material: "rope", thickness: "wide", slack: "loose", pattern: "zigzag",
      ends: "tight", sourceAnchorId: 42, secondaryColor: "url(javascript:alert(1))"
    });
    const rejected = workspace.workspace.notes[sourceId].links[0];
    assert.equal(rejected.material, "double", "unknown materials do not overwrite the valid value");
    assert.equal(rejected.thickness, 5);
    assert.equal(rejected.slack, 0);
    assert.equal(rejected.pattern, "alternating");
    assert.equal(rejected.ends, "loose");
    assert.equal(rejected.sourceAnchorId, "main");
    assert.equal(rejected.secondaryColor, "", "a bad secondary dye degrades to none");
  } finally {
    workspace.destroy();
    await privateStore.remove(page);
  }
});

test("private legacy note edits keep presentation and label in sync", async () => {
  const user = makeUser("Player000000009", { name: "Private Setter" });
  const page = await privateStore.createFor(user);
  const workspace = new PrivateWorkspace({ onChange() {} });
  workspace.setPage(page);
  try {
    const id = await workspace.createNoteAt({ title: "New Note", style: "sticky" });
    await workspace.updateNote(id, { targetHeading: "  Private heading  " });
    await workspace.updateNote(id, { style: "torn" });

    let note = workspace.workspace.notes[id];
    let presentation = resolvePresentation({ name: note.title, system: note });
    assert.equal(presentation.extendedStyle, "memo");
    assert.equal(presentation.forceExtended, true);
    assert.equal(presentation.torn, true);
    assert.equal(presentation.heading, "Private heading");
    assert.equal(note.schemaVersion, 1);

    await workspace.updateNote(id, { title: "Private Captain" });
    note = workspace.workspace.notes[id];
    presentation = resolvePresentation({ name: note.title, system: note });
    assert.equal(presentation.nameGenerated, false);
    assert.equal(note.label, "Private Captain", "a meaningful rename fills an empty label");
    assert.equal(note.schemaVersion, 1);
  } finally {
    workspace.destroy();
    await privateStore.remove(page);
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
