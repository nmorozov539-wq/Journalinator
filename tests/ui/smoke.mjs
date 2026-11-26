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
const dialogWaits = [];

/** Renders the most recent wait() dialog so tests can click its in-content buttons. */
function renderLastDialog() {
  const options = dialogWaits.at(-1);
  const element = document.createElement("div");
  element.innerHTML = options?.content ?? "";
  const closed = [];
  options?.render?.(null, { element, close: () => closed.push(true) });
  return { element, options, closed };
}
globalThis.foundry.applications = {
  api: {
    ApplicationV2: class {
      constructor() { this.element = null; }
      render() { return this; }
    },
    DialogV2: {
      confirm: async () => answers.shift() ?? true,
      prompt: async () => answers.shift() ?? null,
      wait: async options => { dialogWaits.push(options); return answers.shift() ?? null; }
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
const { selectLiveSharedNotes } = await import(`${JN}/scripts/stats.mjs`);
const { anchorWorld } = await import(`${JN}/scripts/anchors.mjs`);
const { THREAD_PIN_RADIUS } = await import(`${JN}/scripts/card-ports.mjs`);
const { MAX_ROUTE_ANCHORS } = await import(`${JN}/scripts/route-notes.mjs`);
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
  const noticesBeforeDelete = env.notifications.length;
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }));
  await settle();
  assert.ok(sharedByName("Tavern").system.deleted, "Backspace moves the selected note to trash");
  assert.ok(env.notifications.slice(noticesBeforeDelete).some(([level, text]) =>
    level === "info" && text.includes("Deleted 1 note(s)") && text.includes("Restore from Trash")),
  "a single deleted note tells the user where it went and how to restore it");

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
    const path = () => canvas.svg.querySelector(".jn-thread-layer").getAttribute("d");
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
    assert.ok(host.querySelector(".jn-link-preview"), "an interior click starts a new minor-pin source");
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
    assert.match(thread.querySelector(".jn-thread-layer").getAttribute("d"), /100 310 M100 310/);
    assert.match(thread.querySelector(".jn-link-strokes").getAttribute("mask"), /^url\(#jn-thread-mask-/);
    assert.equal(thread.querySelector(".jn-link-arrow"), null, "Canvas 2 never renders arrowheads");
    assert.ok(thread.querySelectorAll(".jn-thread-layer").length >= 5, "thread is a layered stroke stack");
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
    const line = id => canvas.svg.querySelector(`g[data-id="${id}"] .jn-thread-layer`).getAttribute("d");
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

test("link groups carry layered stroke stacks, cosmetics and state classes without inline paint", async () => {
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  applyTheme(canvas.root, getTheme("classic"));
  const notes = [
    {
      _id: "a", name: "A",
      system: {
        style: "sticky", blocks: [], links: [
          { id: "legacy", targetId: "b", color: "#A393F2", label: "Legacy", direction: "one", sourceSide: "right", targetSide: "left" },
          {
            id: "modern", targetId: "b", color: "link2", secondaryColor: "link3", label: "Modern",
            material: "double", thickness: 4.2, slack: 0.2, pattern: "alternating", ends: "loose",
            sourceSide: "bottom", targetSide: "top"
          },
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
    assert.ok(legacy.classList.contains("jn-link-material-linen"));
    assert.ok(legacy.classList.contains("jn-link-pattern-continuous"));
    assert.ok(legacy.classList.contains("jn-link-ends-standard"));
    assert.equal(legacy.getAttribute("style").includes("--jn-thread-k:"), true);
    const strokes = legacy.querySelector(".jn-link-strokes");
    assert.match(strokes.getAttribute("mask"), /^url\(#jn-thread-mask-/);
    const layers = legacy.querySelectorAll(".jn-thread-layer");
    assert.equal(layers.length, 5, "L3 has five layers");
    assert.deepEqual([...layers].map(layer => [...layer.classList].find(name => name.startsWith("jn-thread-") && name !== "jn-thread-layer")),
      ["jn-thread-shadow", "jn-thread-dark", "jn-thread-core", "jn-thread-highlight", "jn-thread-fine"]);
    for (const layer of layers) {
      assert.equal(layer.hasAttribute("stroke"), false);
      assert.equal(layer.hasAttribute("stroke-width"), false);
      assert.equal(layer.hasAttribute("stroke-dasharray"), false);
      assert.equal(layer.hasAttribute("fill"), false);
      assert.match(layer.getAttribute("style"), /--jn-layer-width:/);
    }
    assert.equal(legacy.hasAttribute("opacity"), false);
    assert.equal(legacy.querySelector(".jn-link-arrow"), null, "no arrowheads in Canvas 2");
    assert.equal(legacy.querySelector(".jn-link-dir"), null, "no direction control");

    const modern = group("modern");
    assert.ok(modern.classList.contains("jn-link-material-double"));
    assert.ok(modern.classList.contains("jn-link-pattern-alternating"));
    assert.ok(modern.classList.contains("jn-link-ends-loose"));
    assert.ok(modern.classList.contains("jn-link-accent-link3"));
    assert.equal(modern.querySelectorAll(".jn-link-stack").length, 2, "solid + accent stack");
    assert.equal(modern.querySelectorAll(".jn-thread-layer").length, 12, "six layers per stack");
    assert.deepEqual([...modern.querySelectorAll(".jn-thread-tail")].map(tail => tail.classList.contains("jn-thread-tail-fine")),
      [false, true, false, true], "stacked loose tails sit at both ends");
    assert.match(modern.getAttribute("style"), /--jn-thread-width:4.2/);

    const hint = group("hint");
    assert.ok(hint.classList.contains("jn-link-hint"));
    assert.ok(hint.classList.contains("jn-link-pattern-interrupted"), "legacy dashed maps to interrupted");
    const hidden = group("hidden");
    assert.ok(hidden.classList.contains("jn-link-hidden"));
    assert.ok(!hidden.classList.contains("jn-link-pattern-interrupted"), "hidden wins over the legacy dash");
    assert.equal(hidden.querySelector(".jn-thread-layer").hasAttribute("stroke-dasharray"), false);

    const hit = canvas.root.querySelector('.jn-link-hit[data-id="legacy"]');
    hit.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
    canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
    assert.ok(group("legacy").classList.contains("jn-link-selected"), "selection toggles an existing group");
    const swatch = canvas.linkToolbar.querySelector(".jn-link-swatch-link1");
    assert.ok(swatch?.classList.contains("on"));
    assert.equal(swatch.getAttribute("style"), null, "swatch paint comes from a CSS variable");
    assert.equal(swatch.getAttribute("title"), "Link color 1");
    assert.equal(swatch.getAttribute("aria-label"), "Link color 1");
    assert.equal(canvas.linkToolbar.querySelectorAll(".jn-link-preset").length, 4);
    assert.equal(canvas.linkToolbar.querySelector(".jn-link-dir"), null);
    assert.equal(canvas.linkToolbar.querySelector(".jn-link-dash"), null);

    canvas.setDimMatch(() => false);
    const dimmed = group("legacy");
    assert.ok(dimmed.classList.contains("jn-link-dimmed"));
    assert.ok(dimmed.classList.contains("jn-link-selected"), "selection survives a redraw");

    const pathBefore = group("legacy").querySelector(".jn-thread-layer").getAttribute("d");
    canvas.root.dispatchEvent(new dom.window.WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY: 500
    }));
    await new Promise(resolve => setTimeout(resolve, 40));
    const comp = Number.parseFloat(canvas.root.style.getPropertyValue("--jn-zoom-comp"));
    const expected = Math.round(Math.min(2, Math.max(0.5, 1 / canvas.view.k)) * 1000) / 1000;
    assert.equal(comp, expected);
    assert.equal(group("legacy").querySelector(".jn-thread-layer").getAttribute("d"), pathBefore, "zoom does not redraw links");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("thread toolbar presets and controls commit exact, independent changes", () => {
  const calls = [];
  const canvas = new JournalCanvas({
    onSelectNote() {},
    onUpdateLink(...args) { calls.push(args); }
  });
  document.body.appendChild(canvas.root);
  const notes = [
    {
      _id: "a", name: "A",
      system: {
        style: "sticky", blocks: [], links: [
          { id: "l", targetId: "b", label: "Route", secondaryColor: "link1", sourceSide: "right", targetSide: "left" }
        ]
      }
    },
    { _id: "b", name: "B", system: { style: "sticky", blocks: [], links: [] } }
  ];
  try {
    canvas.update(notes, { cards: { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }, labels: {} });
    const hit = canvas.root.querySelector('.jn-link-hit[data-id="l"]');
    hit.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    const toolbar = canvas.linkToolbar;
    const field = selector => toolbar.querySelector(selector);
    assert.equal(toolbar.querySelector(".jn-link-dir"), null, "direction control removed");
    assert.equal(toolbar.querySelector(".jn-link-dash"), null, "old line-style toggle removed");

    field('[data-preset="heavy"]').click();
    assert.deepEqual(calls.at(-1), ["a", "l", {
      material: "double", thickness: 4, slack: 0.19, pattern: "continuous", ends: "standard"
    }]);
    assert.equal(field(".jn-link-material").value, "double");
    assert.equal(field(".jn-link-thickness").value, "4");
    assert.equal(field(".jn-link-thickness-out").textContent, "4.0 px");
    assert.equal(field(".jn-link-slack").value, "19");
    assert.equal(field(".jn-link-slack-out").textContent, "19%");
    assert.equal(field(".jn-link-pattern").value, "continuous");
    assert.equal(field(".jn-link-ends").value, "standard");

    field('[data-preset="fine"]').click();
    assert.deepEqual(calls.at(-1), ["a", "l", {
      material: "linen", thickness: 1.3, slack: 0.02, pattern: "continuous", ends: "standard"
    }]);
    assert.equal(field(".jn-link-thickness-out").textContent, "1.3 px");
    assert.equal(field(".jn-link-slack-out").textContent, "2%");

    const count = calls.length;
    const thickness = field(".jn-link-thickness");
    thickness.value = "3.3";
    thickness.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(calls.length, count, "range input never writes per pixel/step");
    assert.equal(field(".jn-link-thickness-out").textContent, "3.3 px");
    thickness.dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(calls.at(-1), ["a", "l", { thickness: 3.3 }]);

    const slack = field(".jn-link-slack");
    slack.value = "25";
    slack.dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(calls.at(-1), ["a", "l", { slack: 0.25 }], "slack stores a fraction");
    assert.equal(field(".jn-link-slack-out").textContent, "2%", "readout waits for the next input");
    slack.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(field(".jn-link-slack-out").textContent, "25%");

    const material = field(".jn-link-material");
    material.value = "double";
    material.dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(calls.at(-1), ["a", "l", { material: "double" }]);

    const pattern = field(".jn-link-pattern");
    pattern.value = "alternating";
    pattern.dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(calls.at(-1), ["a", "l", { pattern: "alternating" }]);

    const ends = field(".jn-link-ends");
    ends.value = "loose";
    ends.dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(calls.at(-1), ["a", "l", { ends: "loose" }]);

    const label = field(".jn-link-label-input");
    label.value = "Renamed";
    label.dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(calls.at(-1), ["a", "l", { label: "Renamed" }]);

    // Accent/secondary swatches are their own control group: they show the stored dye and
    // write only `secondaryColor`, never the primary `color`.
    const secondaryInitial = field(".jn-link-secondary-link1");
    assert.ok(secondaryInitial, "accent swatch group exists");
    assert.equal(toolbar.querySelectorAll(".jn-link-secondary").length, 4,
      "accent group offers theme default plus link1-3");
    assert.ok(secondaryInitial.classList.contains("on"), "current accent selection is shown");
    assert.equal(secondaryInitial.getAttribute("aria-pressed"), "true");
    assert.equal(secondaryInitial.getAttribute("title"), "Accent color 1");
    const primaryBefore = field(".jn-link-swatch-link1").classList.contains("on");
    field(".jn-link-secondary-link3").click();
    assert.deepEqual(calls.at(-1), ["a", "l", { secondaryColor: "link3" }]);
    field(".jn-link-secondary-default").click();
    assert.deepEqual(calls.at(-1), ["a", "l", { secondaryColor: "" }],
      "theme-default accent writes an empty slot");
    assert.equal(field(".jn-link-swatch-link1").classList.contains("on"), primaryBefore,
      "secondary click leaves the primary color untouched");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("link toolbar focuses on open and closes on Escape or an outside pointerdown", () => {
  const canvas = new JournalCanvas({ onSelectNote() {}, onDeleteLink() {} });
  document.body.appendChild(canvas.root);
  const notes = [
    {
      _id: "a", name: "A",
      system: {
        style: "sticky", blocks: [], links: [
          { id: "l", targetId: "b", sourceSide: "right", targetSide: "left" }
        ]
      }
    },
    { _id: "b", name: "B", system: { style: "sticky", blocks: [], links: [] } }
  ];
  const selectLink = () => {
    const hit = canvas.root.querySelector('.jn-link-hit[data-id="l"]');
    hit.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  };
  try {
    canvas.update(notes, { cards: { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }, labels: {} });
    selectLink();
    const toolbar = canvas.linkToolbar;
    assert.equal(toolbar.style.display, "flex");
    const first = toolbar.querySelector(".jn-link-preset");
    assert.ok(first, "toolbar has controls");
    assert.equal(document.activeElement, first, "opening the toolbar focuses its first control");

    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(toolbar.style.display, "none", "Escape closes the toolbar");
    assert.equal(canvas.selectedLinkId, null);
    assert.ok(canvas.root.contains(document.activeElement), "focus returns inside the canvas/card");
    assert.equal(toolbar.contains(document.activeElement), false);

    canvas.lastLinkClick = null;
    selectLink();
    assert.equal(toolbar.style.display, "flex", "toolbar reopens for the reselected link");
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    assert.equal(toolbar.style.display, "none", "outside pointerdown closes the toolbar");
    assert.equal(canvas.selectedLinkId, null);
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

/** Pointer click helper shared by the floating-toolbar tests. */
function clickCanvasCard(canvas, id, { ctrlKey = false } = {}) {
  const card = canvas.root.querySelector(`.jn-card[data-id="${id}"]`);
  assert.ok(card, `card ${id}`);
  card.dispatchEvent(new MouseEvent("pointerdown", {
    bubbles: true, button: 0, clientX: 10, clientY: 10, ctrlKey
  }));
  canvas.root.dispatchEvent(new MouseEvent("pointerup", {
    bubbles: true, button: 0, clientX: 10, clientY: 10, ctrlKey
  }));
}

function clickCanvasLink(canvas, id) {
  const hit = canvas.root.querySelector(`.jn-link-hit[data-id="${id}"]`);
  assert.ok(hit, `link hit ${id}`);
  hit.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
}

test("floating toolbar sits on the screen-space right edge and only appears with a selection", () => {
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  const notes = [
    {
      _id: "a", name: "A",
      system: {
        style: "sticky", blocks: [], links: [],
        presentation: { extendedStyle: "memo", font: "default", pictureLayout: "above", torn: false },
        attachment: { pinStyle: "brass" }
      }
    },
    { _id: "b", name: "B", system: { style: "sticky", blocks: [], links: [] } }
  ];
  const layout = { cards: { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } }, labels: {} };
  try {
    canvas.update(notes, layout);
    const toolbar = canvas.floatingToolbar;
    assert.equal(toolbar.parentElement, canvas.root, "toolbar is a direct canvas child");
    assert.equal(canvas.world.contains(toolbar), false, "toolbar is outside the transformed world");
    assert.equal(toolbar.hidden, true, "no selection hides the toolbar");

    const transform = canvas.world.style.transform;
    clickCanvasCard(canvas, "a");
    assert.equal(toolbar.hidden, false, "selecting a note reveals the toolbar");
    assert.equal(canvas.world.style.transform, transform, "toolbar never changes pan/zoom");
    assert.equal(canvas.root.querySelector(".jn-floating-toolbar").parentElement, canvas.root);

    const groups = [...toolbar.querySelectorAll(".jn-ft-btn")].map(button => button.dataset.group);
    assert.deepEqual(groups, ["style", "force", "font", "picture", "torn", "pin", "dimensions"]);
    for (const button of toolbar.querySelectorAll(".jn-ft-btn")) {
      assert.ok(button.getAttribute("aria-label"), "each button has an accessible name");
      assert.ok(button.getAttribute("title"), "each button has a tooltip");
      assert.equal(button.getAttribute("aria-haspopup"), "dialog");
      assert.equal(button.getAttribute("aria-expanded"), "false");
      assert.ok(button.querySelector(".jn-ft-label").textContent.trim(), "expanding text label exists");
      assert.ok(button.querySelector("i.fa-solid"), "resting state is icon-only");
    }

    const css = readFileSync(new URL("../../styles/stylized.css", import.meta.url), "utf8");
    assert.match(css, /\.jn-floating-toolbar\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*13px;[\s\S]*?top:\s*15px;/,
      "toolbar is anchored to the viewport edge");
    assert.match(css, /\.jn-ft-btn:hover \.jn-ft-label,[\s\S]*?max-width:\s*220px;/,
      "hover/focus expands the label leftward");
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.jn-ft-label\s*\{\s*transition:\s*none;/,
      "label expansion respects reduced motion");
    assert.match(css, /\.jn-floating-toolbar[\s\S]*?background:\s*#1b1611/,
      "toolbar paints a dark application surface, not parchment");

    canvas.readOnly = true;
    canvas.update(notes, layout);
    assert.equal(toolbar.hidden, false, "read-only still shows the selection context");
    assert.ok([...toolbar.querySelectorAll(".jn-ft-btn")].every(button => button.disabled),
      "read-only disables the cosmetic controls");

    canvas.readOnly = false;
    canvas.clearSelection();
    assert.equal(toolbar.hidden, true, "clearing selection hides the toolbar");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("floating note popover closes on outside/Escape/selection change and returns focus", () => {
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  const notes = [
    { _id: "a", name: "A", system: { style: "sticky", blocks: [], links: [] } },
    { _id: "b", name: "B", system: { style: "sticky", blocks: [], links: [] } }
  ];
  try {
    canvas.update(notes, { cards: { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } }, labels: {} });
    clickCanvasCard(canvas, "a");
    const toolbar = canvas.floatingToolbar;
    const popover = canvas.floatingPopover;
    const button = group => toolbar.querySelector(`.jn-ft-btn[data-group="${group}"]`);

    button("style").click();
    assert.equal(popover.hidden, false);
    assert.equal(popover.dataset.group, "style");
    assert.equal(button("style").getAttribute("aria-expanded"), "true");
    assert.ok(popover.contains(document.activeElement), "focus moves into the popover");

    button("font").click();
    assert.equal(popover.dataset.group, "font", "only one popover is open");
    assert.equal(button("style").getAttribute("aria-expanded"), "false");
    assert.equal(button("font").getAttribute("aria-expanded"), "true");

    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, key: "Escape"
    }));
    assert.equal(popover.hidden, true, "Escape closes the popover");
    assert.equal(document.activeElement, button("font"), "focus returns to the trigger button");
    assert.equal(button("font").getAttribute("aria-expanded"), "false");

    button("font").click();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    assert.equal(popover.hidden, true, "outside pointerdown closes the popover");

    button("font").click();
    clickCanvasCard(canvas, "b");
    assert.equal(popover.hidden, true, "selection change closes the popover");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("note popovers apply cosmetic fields; multi-selection shows Mixed and hides single-only controls", () => {
  const presentationCalls = [];
  const attachmentCalls = [];
  const resizeCalls = [];
  const resetCalls = [];
  const canvas = new JournalCanvas({
    onSelectNote() {},
    onSetPresentation: (ids, fields) => presentationCalls.push([ids, fields]),
    onSetAttachment: (ids, fields) => attachmentCalls.push([ids, fields]),
    onResizeCard: (...args) => resizeCalls.push(args),
    onResetCardSize: (...args) => resetCalls.push(args)
  });
  document.body.appendChild(canvas.root);
  const notes = [
    {
      _id: "a", name: "A",
      system: {
        style: "sticky", blocks: [],
        presentation: { extendedStyle: "memo", forceExtended: false, font: "default", pictureLayout: "above", torn: false },
        attachment: { pinStyle: "default" }
      }
    },
    {
      _id: "b", name: "B",
      system: {
        style: "sticky", blocks: [],
        presentation: { extendedStyle: "document", forceExtended: true, font: "hand", pictureLayout: "right", torn: true },
        attachment: { pinStyle: "brass" }
      }
    }
  ];
  const layout = {
    cards: { a: { x: 0, y: 0, width: 200, height: 120 }, b: { x: 300, y: 0, width: 250, height: 140 } },
    labels: {}
  };
  try {
    canvas.update(notes, layout);
    clickCanvasCard(canvas, "a");
    const toolbar = canvas.floatingToolbar;
    const popover = canvas.floatingPopover;
    const button = group => toolbar.querySelector(`.jn-ft-btn[data-group="${group}"]`);
    const open = group => {
      const trigger = button(group);
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.click();
      assert.equal(popover.dataset.group, group);
    };
    const choose = (selector, value) => {
      const field = popover.querySelector(selector);
      field.value = value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };

    open("style");
    choose(".jn-ft-style", "document");
    assert.deepEqual(presentationCalls.at(-1), [["a"], { extendedStyle: "document" }],
      "style changes only the renderer");

    open("force");
    const force = popover.querySelector(".jn-ft-force");
    force.checked = true;
    force.dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(presentationCalls.at(-1), [["a"], { forceExtended: true }]);

    open("font");
    choose(".jn-ft-font", "hand");
    assert.deepEqual(presentationCalls.at(-1), [["a"], { font: "hand" }]);

    open("picture");
    choose(".jn-ft-picture", "left");
    assert.deepEqual(presentationCalls.at(-1), [["a"], { pictureLayout: "left" }]);

    open("torn");
    choose(".jn-ft-torn", "on");
    assert.deepEqual(presentationCalls.at(-1), [["a"], { torn: true }]);

    open("pin");
    choose(".jn-ft-pin", "brass");
    assert.deepEqual(attachmentCalls.at(-1), [["a"], { pinStyle: "brass" }],
      "pin appearance goes through the attachment callback");

    open("dimensions");
    assert.equal(popover.querySelector(".jn-ft-width").value, "200");
    assert.equal(popover.querySelector(".jn-ft-height").value, "120");
    choose(".jn-ft-width", "260");
    assert.deepEqual(resizeCalls.at(-1), ["a", 260, 120], "dimensions commit on change");
    popover.querySelector(".jn-ft-auto").click();
    assert.deepEqual(resetCalls.at(-1), ["a"], "auto reset uses the existing size callback");
    assert.equal(popover.hidden, true, "auto reset closes the popover");

    clickCanvasCard(canvas, "b", { ctrlKey: true });
    assert.deepEqual([...toolbar.querySelectorAll(".jn-ft-btn")].map(item => item.dataset.group),
      ["style", "font", "picture", "torn", "pin"],
      "multi-selection shows only the cosmetic intersection");

    open("style");
    const styleSelect = popover.querySelector(".jn-ft-style");
    assert.equal(styleSelect.value, "", "mixed values select the Mixed option");
    assert.ok([...styleSelect.options].some(option => option.textContent === game.i18n.localize("JN.Toolbar.Mixed")));
    choose(".jn-ft-style", "target");
    assert.deepEqual(presentationCalls.at(-1), [["a", "b"], { extendedStyle: "target" }]);

    open("font");
    assert.equal(popover.querySelector(".jn-ft-font").value, "");
    choose(".jn-ft-font", "serif");
    assert.deepEqual(presentationCalls.at(-1), [["a", "b"], { font: "serif" }]);

    open("torn");
    assert.equal(popover.querySelector(".jn-ft-torn").value, "");
    choose(".jn-ft-torn", "off");
    assert.deepEqual(presentationCalls.at(-1), [["a", "b"], { torn: false }]);

    open("pin");
    choose(".jn-ft-pin", "iron");
    assert.deepEqual(attachmentCalls.at(-1), [["a", "b"], { pinStyle: "iron" }],
      "pin appearance is the only bulk attachment field");

    const allowedPresentation = new Set(["extendedStyle", "font", "pictureLayout", "torn", "forceExtended"]);
    for (const [, fields] of presentationCalls) {
      assert.ok(Object.keys(fields).every(key => allowedPresentation.has(key)),
        "bulk presentation never touches content, label, image or permissions");
    }
    for (const [, fields] of attachmentCalls) {
      assert.deepEqual(Object.keys(fields), ["pinStyle"], "bulk attachment only changes pin appearance");
    }
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("mixed GM-only multi-selection disables bulk cosmetics with an explanation", () => {
  const presentationCalls = [];
  const canvas = new JournalCanvas({
    onSelectNote() {},
    onSetPresentation: (ids, fields) => presentationCalls.push([ids, fields])
  });
  document.body.appendChild(canvas.root);
  const notes = [
    { _id: "shared", name: "Shared", system: { style: "sticky", blocks: [], links: [] } },
    { _id: "secret", name: "GM secret", secret: true, system: { style: "sticky", blocks: [], links: [] } }
  ];
  try {
    canvas.update(notes, { cards: { shared: { x: 0, y: 0 }, secret: { x: 300, y: 0 } }, labels: {} });
    clickCanvasCard(canvas, "secret");
    const toolbar = canvas.floatingToolbar;
    assert.equal(toolbar.querySelector('[data-group="locked"]'), null, "single GM-only note stays editable");
    assert.ok([...toolbar.querySelectorAll(".jn-ft-btn")].every(button => !button.disabled));

    clickCanvasCard(canvas, "shared", { ctrlKey: true });
    const locked = toolbar.querySelector('[data-group="locked"]');
    assert.ok(locked, "mixed secret selection exposes a lock explanation");
    assert.ok([...toolbar.querySelectorAll(".jn-ft-btn")].every(button =>
      button.dataset.group === "locked" || button.disabled), "bulk controls are disabled");
    locked.click();
    const popover = canvas.floatingPopover;
    assert.equal(popover.hidden, false);
    assert.match(popover.textContent, new RegExp(
      game.i18n.localize("JN.Toolbar.SecretBulkDisabled").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(presentationCalls.length, 0, "no partial tier write is attempted");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("link selection shows only link controls and commits fields, labels and presets on change", () => {
  const calls = [];
  const canvas = new JournalCanvas({
    onSelectNote() {},
    onUpdateLink: (...args) => calls.push(args)
  });
  document.body.appendChild(canvas.root);
  const notes = [
    {
      _id: "a", name: "A",
      system: {
        style: "sticky", blocks: [], links: [
          { id: "l", targetId: "b", label: "Route", color: "link1", sourceSide: "right", targetSide: "left" }
        ]
      }
    },
    { _id: "b", name: "B", system: { style: "sticky", blocks: [], links: [] } }
  ];
  try {
    canvas.update(notes, { cards: { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }, labels: {} });
    clickCanvasLink(canvas, "l");
    const toolbar = canvas.floatingToolbar;
    const popover = canvas.floatingPopover;
    assert.deepEqual([...toolbar.querySelectorAll(".jn-ft-btn")].map(item => item.dataset.group),
      ["material", "thickness", "slack", "color", "pattern", "ends", "label", "presets"],
      "links never show note rendering controls");
    const button = group => toolbar.querySelector(`.jn-ft-btn[data-group="${group}"]`);
    const open = group => {
      const trigger = button(group);
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.click();
      assert.equal(popover.dataset.group, group);
    };
    const choose = (selector, value) => {
      const field = popover.querySelector(selector);
      field.value = value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };

    open("material");
    choose(".jn-ft-material", "double");
    assert.deepEqual(calls.at(-1), ["a", "l", { material: "double" }]);

    open("thickness");
    const count = calls.length;
    const thickness = popover.querySelector(".jn-ft-thickness");
    thickness.value = "3.3";
    thickness.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(calls.length, count, "thickness never writes per step");
    assert.equal(popover.querySelector(".jn-ft-thickness-out").textContent, "3.3 px");
    thickness.dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(calls.at(-1), ["a", "l", { thickness: 3.3 }]);

    open("slack");
    choose(".jn-ft-slack", "25");
    assert.deepEqual(calls.at(-1), ["a", "l", { slack: 0.25 }]);

    open("color");
    popover.querySelector(".jn-ft-swatch-link3").click();
    assert.deepEqual(calls.at(-1), ["a", "l", { color: "link3" }]);

    open("pattern");
    choose(".jn-ft-pattern", "alternating");
    assert.deepEqual(calls.at(-1), ["a", "l", { pattern: "alternating" }]);

    open("ends");
    choose(".jn-ft-ends", "loose");
    assert.deepEqual(calls.at(-1), ["a", "l", { ends: "loose" }]);

    open("label");
    const beforeLabel = calls.length;
    const label = popover.querySelector(".jn-ft-link-label");
    label.value = "Renamed";
    label.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(calls.length, beforeLabel, "labels do not write per keystroke");
    label.dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(calls.at(-1), ["a", "l", { label: "Renamed" }]);

    open("presets");
    assert.equal(popover.querySelectorAll(".jn-ft-preset").length, 4);
    popover.querySelector('.jn-ft-preset[data-preset="heavy"]').click();
    assert.deepEqual(calls.at(-1), ["a", "l", {
      material: "double", thickness: 4, slack: 0.19, pattern: "continuous", ends: "standard"
    }]);
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

/** Border-box rectangle for jsdom, which has no layout engine. */
function fakeRect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
}

test("fitNotes frames all/live selected card bounds, rotation, and an empty canvas", () => {
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  const notes = [
    { _id: "a", name: "A", system: { style: "sticky", blocks: [], links: [] } },
    { _id: "b", name: "B", system: { style: "sticky", blocks: [], links: [] } }
  ];
  let rootWidth = 1000;
  let rootHeight = 800;
  try {
    canvas.update(notes, {
      cards: {
        a: { x: 0, y: 0, width: 200, height: 100 },
        b: { x: 1000, y: 500, width: 200, height: 100 }
      },
      labels: {}
    });
    canvas.root.getBoundingClientRect = () => fakeRect(0, 0, rootWidth, rootHeight);
    const near = (actual, expected, label) =>
      assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} ≈ ${expected}`);

    assert.equal(canvas.fitNotes(), true, "fit-all succeeds with live cards");
    near(canvas.view.k, 1000 / 1320, "fit-all zoom");
    near(canvas.view.x, 500 - 600 * canvas.view.k, "fit-all pan x");
    near(canvas.view.y, 400 - 300 * canvas.view.k, "fit-all pan y");
    assert.ok(canvas.view.k <= 1, "fit never magnifies above 1");

    assert.equal(canvas.fitNotes(["a"]), true, "fit-selection succeeds");
    near(canvas.view.k, 1, "single-card fit is capped at 1");
    near(canvas.view.x, 400, "single-card fit centers horizontally");
    near(canvas.view.y, 350, "single-card fit centers vertically");

    canvas.update(notes, {
      cards: {
        a: { x: 0, y: 0, width: 200, height: 100 },
        b: { x: 100000, y: 500, width: 200, height: 100 }
      },
      labels: { far: { text: "Far label", x: 100000, y: 100000, noteId: "" } }
    });
    assert.equal(canvas.fitNotes(), true);
    near(canvas.view.k, 0.3, "fit shares the 0.3 lower zoom bound instead of shrinking forever");

    const linkedNotes = notes.map((note, index) => index === 0 ? {
      ...note,
      system: {
        ...note.system,
        links: [{ id: "long-link", targetId: "b", direction: "one", label: "far" }]
      }
    } : note);
    canvas.update(linkedNotes, {
      cards: {
        a: { x: 0, y: 0, width: 200, height: 100 },
        b: { x: 1000, y: 500, width: 200, height: 100 }
      },
      labels: { far: { text: "Far label", x: 100000, y: 100000, noteId: "" } }
    });
    assert.equal(canvas.fitNotes(), true);
    near(canvas.view.k, 1000 / 1320,
      "links and labels do not widen the fit bounds beyond the cards");

    rootWidth = 500;
    rootHeight = 200;
    canvas.update(notes, {
      cards: {
        a: { x: 0, y: 0, width: 200, height: 100, rotation: 90 },
        b: { x: 1000, y: 500, width: 200, height: 100 }
      },
      labels: {}
    });
    assert.equal(canvas.fitNotes(["a"]), true);
    near(canvas.view.k, 200 / 320, "rotated card uses its swapped AABB height");
    assert.ok(canvas.view.k < 0.7, "rotation is reflected in the fit zoom");

    const empty = new JournalCanvas({ onSelectNote() {} });
    document.body.appendChild(empty.root);
    try {
      empty.root.getBoundingClientRect = () => fakeRect(0, 0, 1000, 800);
      const before = { ...empty.view };
      assert.equal(empty.fitNotes(), false, "empty canvas is a no-op");
      assert.deepEqual(empty.view, before);
    } finally {
      empty.root.remove();
    }
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("floating popover clamps its real border-box inside narrow/wide canvases and follows resize", () => {
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  const notes = [{ _id: "a", name: "A", system: { style: "sticky", blocks: [], links: [] } }];
  let rootWidth = 1400;
  try {
    canvas.update(notes, { cards: { a: { x: 0, y: 0 } }, labels: {} });
    const rootRect = () => fakeRect(0, 0, rootWidth, 700);
    canvas.root.getBoundingClientRect = rootRect;
    clickCanvasCard(canvas, "a");
    const trigger = canvas.floatingToolbar.querySelector('[data-group="style"]');
    const popover = canvas.floatingPopover;
    trigger.getBoundingClientRect = () => fakeRect(rootWidth - 45, 100, 32, 30);
    popover.getBoundingClientRect = () => {
      const declared = Number.parseFloat(popover.style.width);
      return fakeRect(0, 0, Number.isFinite(declared) ? declared : 264, 180);
    };
    trigger.click();

    for (const width of [1400, 430, 320, 160]) {
      rootWidth = width;
      dom.window.dispatchEvent(new Event("resize"));
      const left = Number.parseFloat(popover.style.left);
      const top = Number.parseFloat(popover.style.top);
      const actualWidth = Number.parseFloat(popover.style.width) || 264;
      const right = Number.parseFloat(popover.style.right);
      assert.equal(popover.hidden, false, `${width}: the open popover survives a resize`);
      assert.ok(left >= 6, `${width}: left edge is clamped inside`);
      assert.ok(right >= 6, `${width}: right edge is clamped inside`);
      assert.ok(left + actualWidth + right <= width + 0.01, `${width}: both edges stay inside`);
      assert.ok(top >= 6 && top <= 700 - 180 - 6, `${width}: top edge is clamped inside`);
    }
    const css = readFileSync(new URL("../../styles/stylized.css", import.meta.url), "utf8");
    assert.match(css, /\.jn-floating-popover\s*\{[\s\S]*?box-sizing:\s*border-box;/,
      "the popover measures its border box");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("selecting a card or link updates the editor without a full JournalApp render", async () => {
  await requestWrite({ type: "createNote", title: "Render Guard One", x: 800, y: 800 });
  await requestWrite({ type: "createNote", title: "Render Guard Two", x: 1100, y: 800 });
  await settle();
  const one = sharedByName("Render Guard One");
  const two = sharedByName("Render Guard Two");
  await requestWrite({
    type: "createLink", sourceId: one.id, targetId: two.id, sourceSide: "right", targetSide: "left"
  });
  await settle();
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  const originalRender = app.render;
  try {
    await redraw();
    const canvasRoot = host.querySelector(".jn-canvas");
    let renders = 0;
    app.render = (...args) => { renders++; return originalRender.call(app, ...args); };

    clickCanvasCard({ root: canvasRoot }, one.id);
    assert.equal(renders, 0, "card selection is a targeted editor update");
    assert.equal(host.querySelector(".journalinator-editor .jn-inline-title")?.textContent, "Render Guard One",
      "the editor follows the selected note without an app render");

    const link = sharedByName("Render Guard One").system.links[0];
    assert.ok(link, "the link fixture exists");
    clickCanvasLink({ root: canvasRoot }, link.id);
    assert.equal(renders, 0, "link selection does not re-render the app");
    assert.equal(host.querySelector(".journalinator-editor .jn-inline-title"), null,
      "link selection clears the editor only");
  } finally {
    delete app.render;
    app._onClose();
    host.remove();
  }
});

test("changing a popover value keeps focus inside the popover across the write render", async () => {
  await requestWrite({ type: "createNote", title: "Focus Popover", x: 1200, y: 800 });
  await settle();
  const note = sharedByName("Focus Popover");
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    const canvasRoot = host.querySelector(".jn-canvas");
    clickCanvasCard({ root: canvasRoot }, note.id);
    const trigger = canvasRoot.querySelector('.jn-floating-toolbar .jn-ft-btn[data-group="style"]');
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.click();
    const popover = canvasRoot.querySelector(".jn-floating-popover");
    const select = popover.querySelector(".jn-ft-style");
    select.focus();
    assert.ok(popover.contains(document.activeElement), "focus starts inside the popover");

    select.value = "document";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(popover.hidden, false, "the popover survives the document-sync render");
    assert.ok(popover.contains(document.activeElement), "focus stays inside the rebuilt popover");
    assert.equal(document.activeElement.dataset.jnFocusKey, select.dataset.jnFocusKey,
      "the same field is restored by its stable key");
  } finally {
    const toolbar = host.querySelector(".jn-floating-toolbar");
    app._onClose();
    assert.equal(toolbar?.hidden, true, "closing the app hides the floating toolbar");
    assert.equal(host.querySelector(".jn-floating-popover")?.hidden, true,
      "closing the app closes the popover");
    host.remove();
  }
});

test("read-only link selection is inspect-only; disconnect closes overlays and removes resize hooks", () => {
  const calls = [];
  const canvas = new JournalCanvas(new Proxy({}, {
    get: (_, name) => (...args) => calls.push([String(name), ...args])
  }));
  document.body.appendChild(canvas.root);
  const notes = [
    {
      _id: "a", name: "A",
      system: {
        style: "sticky", blocks: [], links: [
          { id: "l", targetId: "b", sourceSide: "right", targetSide: "left" }
        ]
      }
    },
    { _id: "b", name: "B", system: { style: "sticky", blocks: [], links: [] } }
  ];
  try {
    canvas.readOnly = false;
    canvas.update(notes, { cards: { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }, labels: {} });
    clickCanvasCard(canvas, "a");
    assert.equal(calls.some(([name]) => name === "onMoveCard"), false, "selection alone never writes");
    const card = canvas.root.querySelector('.jn-card[data-id="a"]');
    card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    canvas.root.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, button: 0, clientX: 40, clientY: 40 }));
    assert.equal(calls.some(([name]) => name === "onMoveCard"), false,
      "a drag preview is local-only until release");
    canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 40, clientY: 40 }));
    assert.equal(calls.filter(([name]) => name === "onMoveCard").length, 1,
      "the move is committed only on release");
    calls.length = 0;

    canvas.readOnly = true;
    canvas.update(notes, { cards: { a: { x: 0, y: 0 }, b: { x: 400, y: 0 } }, labels: {} });
    clickCanvasCard(canvas, "a");
    assert.equal(calls.some(([name]) => name === "onMoveCard"), false, "read-only selection never writes");
    assert.ok([...canvas.floatingToolbar.querySelectorAll(".jn-ft-btn")].every(button => button.disabled),
      "read-only cosmetic controls are disabled");

    clickCanvasLink(canvas, "l");
    assert.equal(canvas.selectedLinkId, "l", "a read-only link is still inspectable");
    assert.equal(canvas.linkToolbar.style.display, "none", "read-only link toolbar stays closed");
    assert.ok([...canvas.floatingToolbar.querySelectorAll(".jn-ft-btn")].every(button => button.disabled));
    clickCanvasLink(canvas, "l");
    assert.equal(calls.some(([name]) => name === "onDeleteLink"), false,
      "read-only double-click never deletes a link");

    canvas.root.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    canvas.root.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, button: 0, clientX: 12, clientY: 12 }));
    assert.equal(calls.some(([name]) => name === "onMoveCard"), false,
      "a drag preview is local-only until release");

    canvas.disconnectGeometry();
    assert.equal(canvas.floatingToolbar.hidden, true, "disconnect hides the floating toolbar");
    assert.equal(canvas.floatingPopover.hidden, true, "disconnect hides the popover");
    assert.equal(canvas.linkToolbar.style.display, "none", "disconnect hides the link toolbar");
    assert.equal(canvas.windowResize, null, "the window resize listener is removed");
    assert.equal(canvas.rootResizeObserver, null, "the root resize observer is removed");
  } finally {
    canvas.root.remove();
  }
});

test("client cosmetic batches abort with localized warnings on stale, mixed or many-secret ids", async () => {
  await requestWrite({ type: "createNote", title: "Batch Guard One", x: 1400, y: 800 });
  await requestWrite({ type: "createNote", title: "Batch Guard Two", x: 1700, y: 800 });
  await settle();
  const one = sharedByName("Batch Guard One");
  const two = sharedByName("Batch Guard Two");
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  const fakeSecret = id => {
    vaultStore.data.notes[id] = { id, name: "Fake secret" };
  };
  const openPopover = group => {
    const toolbar = host.querySelector(".jn-floating-toolbar");
    const trigger = toolbar.querySelector(`.jn-ft-btn[data-group="${group}"]`);
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.click();
    return host.querySelector(".jn-floating-popover");
  };
  try {
    await redraw();
    const canvasRoot = host.querySelector(".jn-canvas");

    // A stale/trashed id aborts before any subset is written.
    clickCanvasCard({ root: canvasRoot }, one.id);
    const staleStyle = one.system.presentation?.extendedStyle;
    let popover = openPopover("style");
    let select = popover.querySelector(".jn-ft-style");
    one.system.deleted = Date.now();
    env.notifications.length = 0;
    select.value = "document";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(one.system.presentation?.extendedStyle, staleStyle,
      "a trashed note is never partially updated");
    assert.ok(env.notifications.some(([, text]) => text === game.i18n.localize("JN.Toolbar.BatchStale")),
      "the stale batch is explained in the user's language");
    one.system.deleted = null;

    // A popover opened for two shared notes is refused if the selection later becomes mixed.
    clickCanvasCard({ root: canvasRoot }, two.id, { ctrlKey: true });
    const mixedStyle = sharedByName("Batch Guard One").system.presentation?.extendedStyle;
    popover = openPopover("style");
    select = popover.querySelector(".jn-ft-style");
    fakeSecret(two.id);
    env.notifications.length = 0;
    select.value = "target";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(sharedByName("Batch Guard One").system.presentation?.extendedStyle, mixedStyle,
      "the shared note is untouched when the batch is mixed");
    assert.ok(env.notifications.some(([, text]) => text === game.i18n.localize("JN.Toolbar.BatchMixed")),
      "mixing tiers is refused as a whole");
    delete vaultStore.data.notes[two.id];

    // Several GM-only notes cannot be bulk-edited either.
    popover = openPopover("style");
    select = popover.querySelector(".jn-ft-style");
    fakeSecret(one.id);
    fakeSecret(two.id);
    env.notifications.length = 0;
    select.value = "document";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.ok(env.notifications.some(([, text]) => text === game.i18n.localize("JN.Toolbar.BatchManySecrets")),
      "multiple secret ids are refused instead of writing one of them");
    delete vaultStore.data.notes[one.id];
    delete vaultStore.data.notes[two.id];

    // The attachment batch resolves stale ids first too; no pin write reaches either note.
    clickCanvasCard({ root: canvasRoot }, one.id);
    const pinBefore = one.system.attachment?.pinStyle ?? "";
    popover = openPopover("pin");
    select = popover.querySelector(".jn-ft-pin");
    one.system.deleted = Date.now();
    env.notifications.length = 0;
    select.value = "brass";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(one.system.attachment?.pinStyle ?? "", pinBefore,
      "a stale attachment batch leaves pin appearance untouched");
    assert.ok(env.notifications.some(([, text]) => text === game.i18n.localize("JN.Toolbar.BatchStale")));
    one.system.deleted = null;
  } finally {
    delete vaultStore.data.notes[one.id];
    delete vaultStore.data.notes[two.id];
    app._onClose();
    host.remove();
  }
});

test("hover and editing fade only matching silhouettes without rebuilding threads", () => {
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  const notes = [
    {
      _id: "a", name: "A",
      system: {
        style: "sticky", blocks: [], links: [
          { id: "ab", targetId: "b", label: "Route", sourceSide: "right", targetSide: "left" }
        ]
      }
    },
    { _id: "b", name: "B", system: { style: "sticky", blocks: [], links: [] } },
    { _id: "torn", name: "Torn", system: { style: "sticky", blocks: [], presentation: { torn: true } } }
  ];
  const cards = {
    a: { x: 0, y: 0, rotation: 0 },
    b: { x: 400, y: 0, rotation: 14 },
    torn: { x: 200, y: 260, rotation: -9 }
  };
  try {
    canvas.update(notes, { cards, labels: {} });
    const card = id => canvas.root.querySelector(`.jn-card[data-id="${id}"]`);
    const shape = id => canvas.svg.querySelector(`.jn-thread-mask-shape[data-note-id="${id}"]`);
    const group = canvas.svg.querySelector('g[data-id="ab"]');
    const strokes = group.querySelector(".jn-link-strokes");
    const hit = canvas.root.querySelector('.jn-link-hit[data-id="ab"]');
    assert.match(strokes.getAttribute("mask"), /^url\(#jn-thread-mask-/);
    assert.equal(group.hasAttribute("mask"), false, "pins and labels sit outside the fade mask");
    assert.equal(strokes.querySelector(".jn-thread-pin"), null);
    assert.ok(group.querySelector(".jn-thread-pin"), "endpoint pins remain");
    assert.ok(group.querySelector(".jn-link-label"), "label plaque remains");
    assert.equal(hit.hasAttribute("mask"), false, "hit path stays interactive");
    assert.ok(shape("a") && shape("b") && shape("torn"));
    assert.ok(shape("torn").getAttribute("points").split(" ").length > 4, "torn mask uses its polygon");

    const dBefore = group.querySelector(".jn-thread-layer").getAttribute("d");
    const svgNodes = [...canvas.svg.querySelectorAll("*")];
    card("a").dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    assert.ok(shape("a").classList.contains("jn-thread-mask-active"));
    assert.ok(!shape("b").classList.contains("jn-thread-mask-active"));
    assert.equal(group.querySelector(".jn-thread-layer").getAttribute("d"), dBefore, "hover does not rebuild paths");
    assert.deepEqual([...canvas.svg.querySelectorAll("*")], svgNodes, "hover reuses every SVG child node");

    card("b").dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    assert.ok(!shape("a").classList.contains("jn-thread-mask-active"), "pointer hover moves to the new note");
    assert.ok(shape("b").classList.contains("jn-thread-mask-active"));

    const input = document.createElement("input");
    card("a").querySelector(".jn-card-main").appendChild(input);
    input.dispatchEvent(new Event("focusin", { bubbles: true }));
    assert.ok(shape("a").classList.contains("jn-thread-mask-active"), "inline text edit fades its note");
    assert.ok(shape("b").classList.contains("jn-thread-mask-active"), "hover + edit fade each silhouette");

    input.dispatchEvent(new MouseEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    assert.ok(!shape("a").classList.contains("jn-thread-mask-active"));
    assert.ok(shape("b").classList.contains("jn-thread-mask-active"));
    card("b").dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    assert.ok(!shape("b").classList.contains("jn-thread-mask-active"));

    card("a").classList.add("jn-being-edited");
    canvas.refreshGeometry();
    assert.ok(shape("a").classList.contains("jn-thread-mask-active"), "editing lock fades its note");
    card("a").classList.remove("jn-being-edited");
    canvas.refreshGeometry();
    assert.ok(!shape("a").classList.contains("jn-thread-mask-active"));

    assert.equal(group.querySelector(".jn-link-arrow"), null);
    assert.equal(hit.getAttribute("d"), group.querySelector(".jn-thread-layer").getAttribute("d"));
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("torn mask vertices match cardPointAnchor and follow rotation/resize", async () => {
  const { cardPointAnchor } = await import(`${JN}/scripts/card-ports.mjs`);
  const { tearPoints } = await import(`${JN}/scripts/tear.mjs`);
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  const notes = ["flat", "tilted"].map(id => ({
    _id: id, name: id,
    system: { style: "sticky", blocks: [], presentation: { torn: true } }
  }));
  const cards = {
    flat: { x: 40, y: 30, width: 250, height: 120, rotation: 0 },
    tilted: { x: 360, y: 120, width: 250, height: 120, rotation: 14 }
  };
  const expectedPoints = (id, box) => tearPoints(id).map(({ x, y }) =>
    cardPointAnchor(box, { x: x / 100, y: y / 100 }));
  const actualPoints = id => canvas.svg
    .querySelector(`.jn-thread-mask-shape[data-note-id="${id}"]`)
    .getAttribute("points").split(" ").map(pair => pair.split(",").map(Number));
  const assertNear = (actual, expected, label) => {
    assert.equal(actual.length, expected.length, `${label} vertex count`);
    actual.forEach(([x, y], index) => {
      assert.ok(Math.abs(x - expected[index].x) < 1e-9, `${label}[${index}].x`);
      assert.ok(Math.abs(y - expected[index].y) < 1e-9, `${label}[${index}].y`);
    });
  };
  try {
    canvas.update(notes, { cards, labels: {} });
    assertNear(actualPoints("flat"), expectedPoints("flat", { ...cards.flat, w: 250, h: 120 }), "flat");
    assertNear(actualPoints("tilted"), expectedPoints("tilted", { ...cards.tilted, w: 250, h: 120 }), "tilted");

    const shape = canvas.svg.querySelector('.jn-thread-mask-shape[data-note-id="flat"]');
    const before = shape.getAttribute("points");
    const resized = { ...cards, flat: { ...cards.flat, width: 320, height: 150, rotation: 27 } };
    canvas.update(notes, { cards: resized, labels: {} });
    const afterShape = canvas.svg.querySelector('.jn-thread-mask-shape[data-note-id="flat"]');
    assert.equal(afterShape, shape, "geometry-only resize reuses the mask polygon");
    assert.notEqual(afterShape.getAttribute("points"), before, "rotation/resize updates mask points");
    assertNear(actualPoints("flat"), expectedPoints("flat", { ...resized.flat, w: 320, h: 150 }), "resized");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("geometry-only updates reuse SVG groups while path data changes", () => {
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  const notes = [
    {
      _id: "a", name: "A",
      system: {
        style: "sticky", blocks: [], links: [
          { id: "l", targetId: "b", label: "Route", sourceSide: "right", targetSide: "left" }
        ]
      }
    },
    { _id: "b", name: "B", system: { style: "sticky", blocks: [], presentation: { torn: true } } }
  ];
  const cards = { a: { x: 0, y: 0, width: 200, height: 100 }, b: { x: 400, y: 0, width: 200, height: 100 } };
  try {
    canvas.update(notes, { cards, labels: {} });
    const group = canvas.svg.querySelector('g[data-id="l"]');
    const layer = group.querySelector(".jn-thread-layer");
    const hit = canvas.root.querySelector('.jn-link-hit[data-id="l"]');
    const maskShape = canvas.svg.querySelector('.jn-thread-mask-shape[data-note-id="b"]');
    const dBefore = layer.getAttribute("d");
    const pointsBefore = maskShape.getAttribute("points");

    canvas.update(notes, {
      cards: { ...cards, b: { ...cards.b, x: 470, y: 140, rotation: 18 } },
      labels: {}
    });

    assert.equal(canvas.svg.querySelector('g[data-id="l"]'), group, "link group is reused");
    assert.equal(group.querySelector(".jn-thread-layer"), layer, "layer path is reused");
    assert.equal(canvas.root.querySelector('.jn-link-hit[data-id="l"]'), hit, "hit path is reused");
    assert.equal(canvas.svg.querySelector('.jn-thread-mask-shape[data-note-id="b"]'), maskShape,
      "mask polygon is reused");
    assert.notEqual(layer.getAttribute("d"), dBefore, "moved card updates the bezier path");
    assert.equal(hit.getAttribute("d"), layer.getAttribute("d"), "hit path follows the visible path");
    assert.notEqual(maskShape.getAttribute("points"), pointsBefore, "moved card updates mask points");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("stress probe: 100 notes / 200 links reuses geometry without a full rebuild", () => {
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  const notes = [];
  const cards = {};
  for (let index = 0; index < 100; index++) {
    const id = `n${index}`;
    notes.push({ _id: id, name: id, system: { style: "sticky", blocks: [], links: [] } });
    cards[id] = { x: (index % 10) * 260, y: Math.floor(index / 10) * 180, width: 200, height: 100 };
  }
  for (let index = 0; index < 200; index++) {
    const source = notes[index % 100];
    source.system.links.push({
      id: `l${index}`, targetId: `n${(index * 7 + 3) % 100}`,
      secondaryColor: index % 3 === 0 ? "link2" : "", material: index % 4 === 0 ? "double" : "linen",
      pattern: index % 5 === 0 ? "alternating" : "continuous", sourceSide: "right", targetSide: "left"
    });
  }
  try {
    canvas.update(notes, { cards, labels: {} });

    // Old-behaviour baseline: force a full innerHTML rebuild for the same board.
    canvas.linkSignature = null;
    const fullStart = performance.now();
    canvas.refreshGeometry();
    const fullMs = performance.now() - fullStart;

    // Drag simulation: only the card boxes move, so refreshGeometry must take the fast path.
    for (const el of canvas.cardEls.values()) {
      el.style.left = `${Number.parseFloat(el.style.left || "0") + 23}px`;
      el.style.top = `${Number.parseFloat(el.style.top || "0") + 7}px`;
    }
    const geometryStart = performance.now();
    canvas.refreshGeometry();
    const geometryMs = performance.now() - geometryStart;
    assert.equal(canvas.svg.querySelectorAll("g[data-id]").length, 200);
    assert.ok(geometryMs < fullMs, `geometry ${geometryMs.toFixed(1)}ms < full ${fullMs.toFixed(1)}ms`);
    console.log(`[canvas perf] 100 notes / 200 links — full rebuild ${fullMs.toFixed(1)}ms, geometry update ${geometryMs.toFixed(1)}ms`);
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("thread styles define reduced motion, luminance fade and layered material paint", () => {
  const css = readFileSync(new URL("../../styles/stylized.css", import.meta.url), "utf8");
  const journalCss = readFileSync(new URL("../../styles/journal.css", import.meta.url), "utf8");
  assert.match(css, /\.jn-thread-mask-shape\.jn-thread-mask-active\s*\{[^}]*fill:\s*var\(--jn-sc-thread-fade-fill/);
  assert.match(css, /\.jn-thread-mask-shape\s*\{[^}]*transition:\s*fill var\(--jn-sc-thread-fade-time[^}]*opacity var\(--jn-sc-thread-fade-time/);
  assert.match(css, /\.jn-thread-layer\s*\{[^}]*calc\(var\(--jn-thread-k,[^)]*\)\s*\*\s*var\(--jn-layer-width/);
  assert.match(css, /\.jn-link-pattern-interrupted \.jn-thread-layer\s*\{[^}]*stroke-dasharray:/);
  assert.match(css, /\.jn-link-pattern-alternating \.jn-link-stack-accent \.jn-thread-layer\s*\{[^}]*stroke-dasharray:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.jn-thread-mask-shape\s*\{[^}]*transition:\s*none/);
  // Canvas 2 has no arrow or legacy dashed/silhouette runtime rules left.
  for (const stale of [".jn-link-arrow", ".jn-link-dashed", ".jn-thread-silhouette"]) {
    assert.equal(css.includes(stale), false, `${stale} not in stylized.css`);
    assert.equal(journalCss.includes(stale), false, `${stale} not in journal.css`);
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

test("topbar fit buttons frame all notes or the current selection in shared and private views", async () => {
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    let canvasRoot = host.querySelector(".jn-canvas");
    canvasRoot.getBoundingClientRect = () => fakeRect(0, 0, 1000, 800);
    const sharedFit = host.querySelector(".journalinator-fit");
    assert.ok(sharedFit, "shared view has a fit button");
    assert.equal(sharedFit.getAttribute("aria-label"), "Fit all notes");
    sharedFit.click();
    assert.match(host.querySelector(".jn-world").style.transform, /scale\(/);

    const firstCard = [...canvasRoot.querySelectorAll(".jn-card")][0];
    assert.ok(firstCard, "the shared fixture has a card");
    clickCanvasCard({ root: canvasRoot }, firstCard.dataset.id);
    assert.equal(sharedFit.getAttribute("aria-label"), "Fit selection",
      "selection switches the fit label without a full app render");
    sharedFit.click();

    // The private view keeps the same action and label behavior.
    host.querySelector(".jn-view-switch").click();
    host.querySelector(".jn-view-option[data-view='private']").click();
    await settle();
    await redraw();
    if (!privateStore.findActive(gmUser.id)) await privateStore.createFor(gmUser);
    await redraw();
    canvasRoot = host.querySelector(".jn-canvas");
    canvasRoot.getBoundingClientRect = () => fakeRect(0, 0, 1000, 800);
    if (!canvasRoot.querySelector(".jn-card")) {
      host.querySelector(".journalinator-private-new").click();
      await settle();
      await redraw();
      canvasRoot = host.querySelector(".jn-canvas");
      canvasRoot.getBoundingClientRect = () => fakeRect(0, 0, 1000, 800);
    }
    const privateFit = host.querySelector(".journalinator-private-fit");
    assert.ok(privateFit, "private view has a fit button when a workspace exists");
    // A freshly created note is selected; clear the canvas before checking the all-notes label.
    canvasRoot.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 900, clientY: 700 }));
    canvasRoot.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 900, clientY: 700 }));
    assert.equal(privateFit.getAttribute("aria-label"), "Fit all notes");
    const privateCard = [...canvasRoot.querySelectorAll(".jn-card")][0];
    assert.ok(privateCard, "the private fixture has a card");
    clickCanvasCard({ root: canvasRoot }, privateCard.dataset.id);
    assert.equal(privateFit.getAttribute("aria-label"), "Fit selection");
    privateFit.click();
    assert.match(host.querySelector(".jn-canvas .jn-world").style.transform, /scale\(/);
  } finally {
    app._onClose();
    host.remove();
  }
});

test("JournalApp floating toolbar writes bulk cosmetics through the shared batch path", async () => {
  await requestWrite({ type: "createNote", title: "App Bulk One", x: 40, y: 40 });
  await requestWrite({ type: "createNote", title: "App Bulk Two", x: 340, y: 40 });
  await settle();
  const first = sharedByName("App Bulk One");
  const second = sharedByName("App Bulk Two");
  assert.ok(first && second);

  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  try {
    app._onFirstRender();
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
    const canvasRoot = host.querySelector(".jn-canvas");
    const canvas = { root: canvasRoot };
    clickCanvasCard(canvas, first.id);
    clickCanvasCard(canvas, second.id, { ctrlKey: true });
    const toolbar = canvasRoot.querySelector(".jn-floating-toolbar");
    assert.equal(toolbar.hidden, false);
    assert.deepEqual([...toolbar.querySelectorAll(".jn-ft-btn")].map(item => item.dataset.group),
      ["style", "font", "picture", "torn", "pin"]);

    const open = group => {
      const trigger = toolbar.querySelector(`.jn-ft-btn[data-group="${group}"]`);
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.click();
      return canvasRoot.querySelector(".jn-floating-popover");
    };
    const popover = open("style");
    const style = popover.querySelector(".jn-ft-style");
    style.value = "document";
    style.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(sharedByName("App Bulk One").system.presentation.extendedStyle, "document");
    assert.equal(sharedByName("App Bulk Two").system.presentation.extendedStyle, "document");

    const pinPopover = open("pin");
    const pin = pinPopover.querySelector(".jn-ft-pin");
    pin.value = "iron";
    pin.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(sharedByName("App Bulk One").system.attachment.pinStyle, "iron");
    assert.equal(sharedByName("App Bulk Two").system.attachment.pinStyle, "iron");
    assert.equal(sharedByName("App Bulk One").system.attachment.mainPinEnabled, true);
  } finally {
    app._onClose();
    host.remove();
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
    assert.equal(group.querySelector(".jn-thread-layer").hasAttribute("stroke"), false);
    assert.equal(group.querySelector(".jn-link-arrow"), null);
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

test("private workspace applies bulk cosmetic fields in one save and never widens them", async () => {
  const user = makeUser("Player000000099", { name: "Private Bulk" });
  const page = await privateStore.createFor(user);
  const workspace = new PrivateWorkspace({ onChange() {} });
  workspace.setPage(page);
  try {
    const firstId = await workspace.createNoteAt({ title: "Bulk private one", x: 0, y: 0 });
    const secondId = await workspace.createNoteAt({ title: "Bulk private two", x: 300, y: 0 });
    await workspace.updateNote(firstId, { label: "Keep this label", blocks: [{ blockId: "bulkblock0000001", text: "Keep this text" }] });
    await workspace.createLink(firstId, secondId, { sourceSide: "right", targetSide: "left" });
    const labelBefore = workspace.workspace.notes[firstId].label;
    const blocksBefore = JSON.stringify(workspace.workspace.notes[firstId].blocks);
    const linksBefore = JSON.stringify(workspace.workspace.notes[firstId].links);
    const revBefore = privateStore.flags(page).rev ?? 0;

    assert.equal(await workspace.setNotesPresentation([firstId, secondId], {
      extendedStyle: "document", font: "hand", pictureLayout: "right", torn: true,
      label: "must be ignored", heading: "must be ignored", forceExtended: true
    }), true);
    assert.equal(privateStore.flags(page).rev, revBefore + 1, "both notes share one private save");
    for (const id of [firstId, secondId]) {
      const note = workspace.workspace.notes[id];
      assert.equal(note.presentation.extendedStyle, "document");
      assert.equal(note.presentation.font, "hand");
      assert.equal(note.presentation.pictureLayout, "right");
      assert.equal(note.presentation.torn, true);
      assert.equal(note.presentation.forceExtended, false, "force is not widened to a bulk set");
    }
    assert.equal(workspace.workspace.notes[firstId].label, labelBefore);
    assert.equal(JSON.stringify(workspace.workspace.notes[firstId].blocks), blocksBefore);
    assert.equal(JSON.stringify(workspace.workspace.notes[firstId].links), linksBefore);

    const revBeforeAttachment = privateStore.flags(page).rev ?? 0;
    assert.equal(await workspace.setNotesAttachment([firstId, secondId], {
      pinStyle: "wax", mainPinEnabled: false, mainSnapRadius: 1, minorSnapRadius: 1
    }), true);
    assert.equal(privateStore.flags(page).rev, revBeforeAttachment + 1);
    for (const id of [firstId, secondId]) {
      const note = workspace.workspace.notes[id];
      assert.equal(note.attachment.pinStyle, "wax");
      assert.equal(note.attachment.mainPinEnabled, true, "pin enable stays out of bulk");
      assert.equal(note.attachment.mainSnapRadius, 24, "snap radii stay out of bulk");
      assert.equal(note.attachment.minorSnapRadius, 6);
    }
    assert.equal(await workspace.setNotesPresentation([firstId, secondId], { forceExtended: true }), false,
      "a multi-note force-extended request is refused at the data layer");
    assert.equal(await workspace.setNotesPresentation([firstId], { forceExtended: true }), true,
      "the single-note control still works");
    assert.equal(workspace.workspace.notes[firstId].presentation.forceExtended, true);
  } finally {
    workspace.destroy();
    await privateStore.remove(page);
  }
});

test("private anchors are capped, strictly named, reference-safe and main-pin guarded", async () => {
  const user = makeUser("Player000000011", { name: "Private Anchor" });
  const page = await privateStore.createFor(user);
  const workspace = new PrivateWorkspace({ onChange() {} });
  workspace.setPage(page);
  try {
    const sourceId = await workspace.createNoteAt({ title: "Private Anchor Source", x: 0, y: 0 });
    const targetId = await workspace.createNoteAt({ title: "Private Anchor Target", x: 400, y: 0 });
    const anchorId = await workspace.addCardAnchor(targetId, { kind: "minor", x: 0.2, y: 0.3 });
    assert.ok(anchorId);
    await workspace.createLink(sourceId, targetId, {
      sourceSide: "right", targetSide: "left", targetAnchorId: anchorId
    });
    const link = workspace.workspace.notes[sourceId].links[0];
    assert.equal(link.targetAnchorId, anchorId);

    assert.equal(await workspace.removeCardAnchor(targetId, anchorId), false,
      "a minor referenced by a private link is not removed");
    assert.ok(workspace.workspace.layout.cards[targetId].anchors[anchorId]);
    assert.equal(await workspace.moveCardAnchor(targetId, "a.b", 0.5, 0.5), false,
      "dotted ids are rejected");
    assert.equal(await workspace.removeCardAnchor(targetId, "constructor"), false,
      "prototype ids are rejected");

    // Fill the registry to the shared 256 cap through the normal save/normalize path.
    const card = workspace.workspace.layout.cards[targetId];
    for (let i = 0; i < 300; i++) card.anchors[`m${i}`] = { kind: "minor", x: 0.5, y: 0.5 };
    await privateStore.save(page, workspace.workspace, privateStore.flags(page).rev ?? 0);
    workspace.setPage(privateStore.findById(page.id));
    assert.equal(Object.keys(workspace.workspace.layout.cards[targetId].anchors).length, 256,
      "private normalization applies the shared cap");
    assert.equal(await workspace.addCardAnchor(targetId, { kind: "minor", x: 0.1, y: 0.1 }), null,
      "adding past the cap is refused");

    const secondSource = await workspace.createNoteAt({ title: "Private Main Ref", x: 800, y: 0 });
    await workspace.createLink(secondSource, targetId, {
      sourceSide: "right", targetSide: "left", targetAnchorId: "main"
    });
    assert.equal(await workspace.setMainPinEnabled(targetId, false), false,
      "private main-pin removal is refused while links use it");
    assert.equal(workspace.workspace.notes[targetId].attachment.mainPinEnabled, true);

    workspace.selectedNoteId = targetId;
    workspace.editor.open(targetId);
    workspace.editor.render();
    assert.equal(workspace.editor.root.querySelector(".journalinator-main-pin").disabled, true,
      "the private toggle is qualified instead of pretending it can redistribute links");
    await workspace.editor.setMainPinEnabled(targetId, false);
    assert.equal(workspace.workspace.notes[targetId].attachment.mainPinEnabled, true,
      "the editor checkbox cannot bypass the workspace main-pin guard");
  } finally {
    workspace.destroy();
    await privateStore.remove(page);
  }
});

test("private link creation does not materialize new minors while pins are disabled", async () => {
  const user = makeUser("Player000000012", { name: "Private Pin Gate" });
  const page = await privateStore.createFor(user);
  const workspace = new PrivateWorkspace({ onChange() {} });
  workspace.setPage(page);
  try {
    const sourceId = await workspace.createNoteAt({ title: "Private Gate Source", x: 0, y: 0 });
    const targetId = await workspace.createNoteAt({ title: "Private Gate Target", x: 400, y: 0 });
    const before = structuredClone(workspace.workspace.layout.cards[sourceId].anchors);
    await game.settings.set("fvtt-journalinator", "pinsEnabled", false);
    try {
      await workspace.createLink(sourceId, targetId, {
        sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 },
        sourceAnchor: { kind: "minor", x: 0.5, y: 0.5 },
        targetAnchor: { kind: "minor", x: 0.5, y: 0.5 }
      });
    } finally {
      await game.settings.set("fvtt-journalinator", "pinsEnabled", true);
    }
    const link = workspace.workspace.notes[sourceId].links.find(item => item.targetId === targetId);
    assert.ok(link, "the link is still created with its point fallback");
    assert.equal(link.sourceAnchorId, "");
    assert.equal(link.targetAnchorId, "");
    assert.deepEqual(workspace.workspace.layout.cards[sourceId].anchors, before,
      "no new source minor is materialized while pins are off");
    assert.equal(Object.keys(workspace.workspace.layout.cards[targetId].anchors).length, 1,
      "no new target minor is materialized while pins are off");
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

test("attachment pins render author colour, all candidate styles, and transform with the card", () => {
  const canvas = new JournalCanvas({});
  document.body.appendChild(canvas.root);
  canvas.pinsEnabled = true;
  const note = (id, attachment, links = []) => ({
    _id: id,
    name: id,
    system: {
      style: "sticky", authorId: gmUser.id, blocks: [], links,
      attachment
    }
  });
  const aId = "pincardA0000001";
  const bId = "pincardB0000002";
  const a = note(aId, { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "brass" }, [
    { id: "pinlink", targetId: bId, sourceAnchorId: "main", targetAnchorId: "secondary" }
  ]);
  const b = note(bId, { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "wood" });
  const makeLayout = () => ({
    cards: {
      [aId]: {
        x: 0, y: 0, width: 200, height: 100, rotation: 0,
        anchors: {
          main: { kind: "main", x: 0.5, y: 0, createdBy: gmUser.id },
          m1: { kind: "minor", x: 0.2, y: 0.3, createdBy: gmUser.id }
        }
      },
      [bId]: {
        x: 400, y: 0, width: 200, height: 100, rotation: 0,
        anchors: {
          main: { kind: "main", x: 0.5, y: 0, createdBy: gmUser.id },
          secondary: { kind: "minor", x: 0.7, y: 0.25, createdBy: gmUser.id }
        }
      }
    },
    labels: {}
  });
  try {
    canvas.update([a, b], makeLayout());
    const card = id => canvas.root.querySelector(`.jn-card[data-id="${id}"]`);
    const main = card(aId).querySelector(".jn-pin-main");
    const minor = card(aId).querySelector('.jn-pin[data-anchor-id="m1"]');
    assert.ok(main, "main pin rendered when attachment.mainPinEnabled and a main anchor exists");
    assert.ok(main.classList.contains("jn-pin-style-brass"), "pin style class comes from the attachment");
    assert.equal(main.style.getPropertyValue("--jn-pin-color"), gmUser.color,
      "the main pin uses the creator/author colour");
    assert.equal(main.style.left, "50%");
    assert.equal(main.style.top, "0%");
    assert.ok(minor, "minor anchors render their own pin");
    assert.equal(minor.style.left, "20%");
    assert.equal(minor.style.top, "30%");
    assert.equal(main.closest(".jn-card-main"), null, "pins live outside the clipped paper wrapper");

    const group = canvas.svg.querySelector('g[data-id="pinlink"]');
    let endpoints = [...group.querySelectorAll(".jn-thread-pin:not(.jn-board-pin)")];
    const sourceWorld = anchorWorld({ x: 0, y: 0, w: 200, h: 100, rotation: 0 },
      { kind: "main", x: 0.5, y: 0 });
    const targetWorld = anchorWorld({ x: 400, y: 0, w: 200, h: 100, rotation: 0 },
      { kind: "minor", x: 0.7, y: 0.25 });
    assert.equal(Number(endpoints[0].getAttribute("cx")), sourceWorld.x);
    assert.equal(Number(endpoints[0].getAttribute("cy")), sourceWorld.y);
    assert.equal(Number(endpoints[1].getAttribute("cx")), targetWorld.x);
    assert.equal(Number(endpoints[1].getAttribute("cy")), targetWorld.y);

    for (const style of ["default", "enamel", "brass", "iron", "wood", "decorative", "wax"]) {
      a.system.attachment = { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: style };
      canvas.update([a, b], makeLayout());
      const expected = style === "default" ? "enamel" : style;
      assert.ok(card(aId).querySelector(`.jn-pin-main.jn-pin-style-${expected}`),
        `${style} maps to the ${expected} pin visual`);
    }
    const css = readFileSync(new URL("../../styles/stylized.css", import.meta.url), "utf8");
    assert.match(css,
      /\.jn-canvas \.jn-card \.jn-pin \{[^}]*width:\s*calc\(20px \* var\(--jn-zoom-comp, 1\)\);/,
      "main pins are a screen-constant 20px via --jn-zoom-comp");
    assert.match(css,
      /\.jn-canvas \.jn-card \.jn-pin-minor \{[^}]*width:\s*calc\(9px \* var\(--jn-zoom-comp, 1\)\);/,
      "minor pins are a screen-constant 9px visual");
    assert.match(css,
      /\.jn-canvas \.jn-card \.jn-pin::after \{[^}]*width:\s*max\(calc\(14px \* var\(--jn-zoom-comp, 1\)\), 100%\);/,
      "small pins keep a ~14px screen-space hit target via a zoom-compensated pseudo-element");
    for (const style of ["enamel", "brass", "iron", "wood", "decorative", "wax"]) {
      assert.ok(css.includes(`.jn-pin-style-${style}::before`), `${style} has a pin visual rule`);
    }

    a.system.attachment = { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "brass" };
    const layout = makeLayout();
    layout.cards[aId].width = 240;
    layout.cards[aId].height = 120;
    layout.cards[aId].rotation = 90;
    canvas.update([a, b], layout);
    assert.equal(card(aId).querySelector(".jn-pin-main").style.left, "50%",
      "normalized pin coordinates survive rotation and resize");
    const rotatedWorld = anchorWorld({ x: 0, y: 0, w: 240, h: 120, rotation: 90 },
      { kind: "main", x: 0.5, y: 0 });
    endpoints = [...canvas.svg.querySelectorAll('g[data-id="pinlink"] .jn-thread-pin:not(.jn-board-pin)')];
    assert.equal(Number(endpoints[0].getAttribute("cx")), rotatedWorld.x);
    assert.equal(Number(endpoints[0].getAttribute("cy")), rotatedWorld.y);

    canvas.pinsEnabled = false;
    canvas.update([a, b], layout);
    assert.equal(canvas.root.querySelector(".jn-pin"), null, "pins are hidden when the experiment is off");
    endpoints = [...canvas.svg.querySelectorAll('g[data-id="pinlink"] .jn-thread-pin:not(.jn-board-pin)')];
    assert.equal(Number(endpoints[0].getAttribute("cx")), rotatedWorld.x,
      "an existing anchor-linked path still resolves its pin position while pins are hidden");

    canvas.pinsEnabled = true;
    a.system.attachment = { mainPinEnabled: false, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "brass" };
    canvas.update([a, b], layout);
    assert.equal(card(aId).querySelector(".jn-pin-main"), null,
      "a disabled main pin renders nothing and is never synthesized on the client");
    assert.ok(card(aId).querySelector('.jn-pin[data-anchor-id="m1"]'), "minor pins remain visible");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("main-pin drag moves the note, minor pins move alone and report normalized coordinates", () => {
  const calls = [];
  const canvas = new JournalCanvas(new Proxy({}, {
    get: (_, name) => (...args) => calls.push([name, ...args])
  }));
  document.body.appendChild(canvas.root);
  canvas.pinsEnabled = true;
  const note = id => ({
    _id: id, name: id,
    system: {
      style: "sticky", authorId: gmUser.id, blocks: [], links: [],
      attachment: { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "enamel" }
    }
  });
  const aId = "dragcardA0000001";
  const bId = "dragcardB0000002";
  const layout = () => ({
    cards: {
      [aId]: {
        x: 0, y: 0, width: 200, height: 100, rotation: 0,
        anchors: {
          main: { kind: "main", x: 0.5, y: 0, createdBy: gmUser.id },
          m1: { kind: "minor", x: 0.2, y: 0.3, createdBy: gmUser.id }
        }
      },
      [bId]: {
        x: 400, y: 0, width: 200, height: 100, rotation: 0,
        anchors: { main: { kind: "main", x: 0.5, y: 0, createdBy: gmUser.id } }
      }
    },
    labels: {}
  });
  const notes = [note(aId), note(bId)];
  try {
    canvas.update(notes, layout());
    const card = id => canvas.root.querySelector(`.jn-card[data-id="${id}"]`);
    const main = card(aId).querySelector(".jn-pin-main");
    main.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 0 }));
    canvas.root.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, button: 0, clientX: 130, clientY: 10 }));
    canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 130, clientY: 10 }));
    assert.ok(calls.some(([name, id, x, y]) => name === "onMoveCard" && id === aId && x === 30 && y === 10),
      "dragging the main pin moves the whole note");

    canvas.update(notes, layout());
    calls.length = 0;
    const minor = card(aId).querySelector('.jn-pin[data-anchor-id="m1"]');
    minor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 40, clientY: 30 }));
    canvas.root.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, button: 0, clientX: 80, clientY: 60 }));
    canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 80, clientY: 60 }));
    assert.ok(calls.some(([name, id, anchorId, x, y]) => name === "onMoveCardAnchor"
      && id === aId && anchorId === "m1" && Math.abs(x - 0.4) < 1e-9 && Math.abs(y - 0.6) < 1e-9),
      "a minor pin reports its new normalized position");
    assert.equal(calls.some(([name]) => name === "onMoveCard"), false,
      "a minor pin never starts a card drag");

    canvas.update(notes, layout());
    calls.length = 0;
    canvas.toggleLinkTool();
    card(aId).querySelector(".jn-pin-main").dispatchEvent(new MouseEvent("click", {
      bubbles: true, button: 0, clientX: 100, clientY: 0
    }));
    card(bId).querySelector(".jn-pin-main").dispatchEvent(new MouseEvent("click", {
      bubbles: true, button: 0, clientX: 500, clientY: 0
    }));
    const created = calls.find(([name]) => name === "onCreateLink");
    assert.ok(created, "link mode starts/picks links from the main pins");
    assert.equal(created[3].sourceAnchorId, "main");
    assert.equal(created[3].targetAnchorId, "main");

    canvas.update(notes, layout());
    calls.length = 0;
    card(aId).dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, button: 2, clientX: 60, clientY: 50
    }));
    const addMinor = canvas.root.querySelector('.jn-context-menu [data-action="add-minor-pin"]');
    assert.ok(addMinor, "the note menu offers an add-minor-pin action");
    addMinor.click();
    const added = calls.find(([name]) => name === "onAddCardAnchor");
    assert.ok(added, "the menu requests a new minor anchor");
    assert.equal(added[1], aId);
    assert.equal(added[2].kind, "minor");
    assert.ok(Math.abs(added[2].x - 0.3) < 1e-9 && Math.abs(added[2].y - 0.5) < 1e-9,
      "the anchor lands at the right-clicked normalized point");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("a rejected minor-pin write clears the optimistic drag and restores the pin", async () => {
  const canvas = new JournalCanvas({
    onMoveCardAnchor() { return Promise.reject(new Error("rejected anchor write")); }
  });
  document.body.appendChild(canvas.root);
  canvas.pinsEnabled = true;
  const note = {
    _id: "rejectpin0000001", name: "Rejected pin",
    system: {
      style: "sticky", authorId: gmUser.id, blocks: [], links: [],
      attachment: { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "enamel" }
    }
  };
  const layout = {
    cards: {
      [note._id]: {
        x: 0, y: 0, width: 200, height: 100, rotation: 0,
        anchors: {
          main: { kind: "main", x: 0.5, y: 0, createdBy: gmUser.id },
          m1: { kind: "minor", x: 0.2, y: 0.3, createdBy: gmUser.id }
        }
      }
    },
    labels: {}
  };
  try {
    canvas.update([note], layout);
    const pin = canvas.root.querySelector('.jn-pin[data-anchor-id="m1"]');
    pin.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 40, clientY: 30 }));
    canvas.root.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, button: 0, clientX: 100, clientY: 70 }));
    canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 100, clientY: 70 }));
    assert.equal(canvas.anchorDrag, null, "the drag override is cleared as soon as the write is sent");
    await settle();
    const restored = canvas.root.querySelector('.jn-pin[data-anchor-id="m1"]');
    assert.equal(restored.style.left, "20%", "a rejected write snaps the pin back to the stored point");
    assert.equal(restored.style.top, "30%");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("link tool reuses nearby pins, creates minor specs on interior clicks, and shares anchors", () => {
  const calls = [];
  const canvas = new JournalCanvas(new Proxy({}, {
    get: (_, name) => (...args) => calls.push([name, ...args])
  }));
  document.body.appendChild(canvas.root);
  canvas.pinsEnabled = true;
  const note = id => ({
    _id: id, name: id,
    system: {
      style: "sticky", authorId: gmUser.id, blocks: [], links: [],
      attachment: { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "enamel" }
    }
  });
  const ids = ["toolcardA0000001", "toolcardB0000002", "toolcardC0000003"];
  const layout = {
    cards: {
      [ids[0]]: {
        x: 0, y: 0, width: 200, height: 100, rotation: 0,
        anchors: { main: { kind: "main", x: 0.5, y: 0, createdBy: gmUser.id } }
      },
      [ids[1]]: {
        x: 400, y: 0, width: 200, height: 100, rotation: 0,
        anchors: {
          main: { kind: "main", x: 0.5, y: 0, createdBy: gmUser.id },
          m1: { kind: "minor", x: 0.7, y: 0.25, createdBy: gmUser.id }
        }
      },
      [ids[2]]: {
        x: 800, y: 0, width: 200, height: 100, rotation: 0,
        anchors: { main: { kind: "main", x: 0.5, y: 0, createdBy: gmUser.id } }
      }
    },
    labels: {}
  };
  const notes = ids.map(note);
  const clickCard = (id, x, y) => canvas.root.querySelector(`.jn-card[data-id="${id}"]`)
    .dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, clientX: x, clientY: y }));
  const linkCalls = () => calls.filter(([name]) => name === "onCreateLink");
  try {
    canvas.update(notes, layout);
    canvas.toggleLinkTool();
    canvas.root.querySelector(`.jn-card[data-id="${ids[0]}"]`).dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true, clientX: 100, clientY: 0
    }));
    const targetPreview = canvas.svg.querySelector(".jn-pin-target");
    assert.ok(targetPreview && targetPreview.style.display !== "none",
      "hovering a pin under the link tool shows a magnet preview");
    assert.ok(targetPreview.classList.contains("jn-pin-target-main"));
    clickCard(ids[0], 100, 0);
    clickCard(ids[1], 480, 50);
    let created = linkCalls().at(-1);
    assert.equal(created[3].sourceAnchorId, "main");
    assert.equal(created[3].targetAnchorId, "");
    assert.deepEqual(created[3].targetAnchor, { kind: "minor", x: 0.4, y: 0.5 });
    assert.deepEqual(created[3].targetPoint, { x: 0.4, y: 0.5 });

    canvas.toggleLinkTool();
    clickCard(ids[0], 100, 0);
    clickCard(ids[1], 540, 20);
    created = linkCalls().at(-1);
    assert.equal(created[3].targetAnchorId, "m1",
      "clicking near a rendered minor pin reuses its anchor id");

    canvas.toggleLinkTool();
    clickCard(ids[0], 100, 0);
    clickCard(ids[2], 900, 0);
    created = linkCalls().at(-1);
    assert.equal(created[3].sourceAnchorId, "main");
    assert.equal(created[3].targetAnchorId, "main");
    const shares = linkCalls().filter(([, , , ports]) => ports.sourceAnchorId === "main");
    assert.equal(shares.length, 3, "any number of links can reuse the same main anchor");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("editor pin controls write attachment values and disabling is routed through undo", async () => {
  await requestWrite({ type: "createNote", title: "Pin Controls", x: 1000, y: 120 });
  await settle();
  const noteId = sharedByName("Pin Controls").id;
  await requestWrite({
    type: "setNoteAttachment", noteIds: [noteId],
    fields: { mainSnapRadius: 18, minorSnapRadius: 4, pinStyle: "brass" }
  });
  await settle();
  const pinCalls = [];
  const editor = new NoteEditor({
    onFocusNote() {},
    onSelectNote() {},
    onSetMainPinEnabled: (id, enabled) => { pinCalls.push([id, enabled]); return Promise.resolve("pin-undo"); }
  });
  document.body.appendChild(editor.root);
  try {
    editor.open(noteId);
    editor.render();
    const toggle = editor.root.querySelector(".journalinator-main-pin");
    assert.ok(toggle, "the shared editor exposes a pin tool when the experiment is active");
    assert.equal(toggle.checked, true);
    assert.equal(editor.root.querySelector(".journalinator-main-snap").value, "18");
    assert.equal(editor.root.querySelector(".journalinator-minor-snap").value, "4");
    assert.equal(editor.root.querySelector(".journalinator-pin-style").value, "brass");

    const mainSnap = editor.root.querySelector(".journalinator-main-snap");
    mainSnap.value = "30";
    mainSnap.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(notesStore.getNote(noteId).system.attachment.mainSnapRadius, 30);
    const minorSnap = editor.root.querySelector(".journalinator-minor-snap");
    minorSnap.value = "9";
    minorSnap.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(notesStore.getNote(noteId).system.attachment.minorSnapRadius, 9);
    const style = editor.root.querySelector(".journalinator-pin-style");
    style.value = "wax";
    style.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(notesStore.getNote(noteId).system.attachment.pinStyle, "wax");

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    assert.deepEqual(pinCalls, [[noteId, false]],
      "disabling the main pin uses the undoable setMainPinEnabled callback instead of setNoteAttachment");

    await game.settings.set("fvtt-journalinator", "pinsEnabled", false);
    editor.render();
    assert.equal(editor.root.querySelector(".journalinator-main-pin"), null,
      "the pin tool is hidden when the world setting is off");
  } finally {
    await game.settings.set("fvtt-journalinator", "pinsEnabled", true);
    editor.deactivate();
    editor.root.remove();
  }
});

test("private editor pin controls save attachment values directly", async () => {
  const user = makeUser("PrivatePinUser01", { name: "Private Pin" });
  const page = await privateStore.createFor(user);
  const workspace = new PrivateWorkspace({ onChange() {} });
  workspace.setPage(page);
  const canvasSlot = document.createElement("div");
  const editorSlot = document.createElement("div");
  document.body.append(canvasSlot, editorSlot);
  try {
    const noteId = await workspace.createNoteAt({ title: "Private Pin", x: 0, y: 0 });
    workspace.selectedNoteId = noteId;
    workspace.renderInto(canvasSlot, editorSlot);
    const card = canvasSlot.querySelector(`.jn-card[data-id="${noteId}"]`);
    assert.ok(card.querySelector(".jn-pin-main"), "private notes render their main pin");
    const root = workspace.editor.root;
    const toggle = root.querySelector(".journalinator-main-pin");
    assert.ok(toggle, "the private editor exposes the same pin controls");
    const mainSnap = root.querySelector(".journalinator-main-snap");
    mainSnap.value = "21";
    mainSnap.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(workspace.getNote(noteId).system.attachment.mainSnapRadius, 21);
    const style = root.querySelector(".journalinator-pin-style");
    style.value = "decorative";
    style.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(workspace.getNote(noteId).system.attachment.pinStyle, "decorative");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    assert.equal(workspace.getNote(noteId).system.attachment.mainPinEnabled, false,
      "the private main-pin toggle is a direct workspace update");
  } finally {
    workspace.destroy();
    canvasSlot.remove();
    editorSlot.remove();
    await privateStore.remove(page);
  }
});

test("secret/hidden links never receive anchor ids or specs", async () => {
  const secretId = await secrets.createSecretNote({ title: "Pin Secret", x: 800, y: 120 });
  await settle();
  const sharedId = sharedByName("Pin Controls")?.id ?? tavernId;
  const notes = notesStore.getAllNotes();
  const layout = structuredClone(notesStore.getLayout());
  for (const id of [secretId, sharedId]) {
    if (!layout.cards[id]) continue;
    layout.cards[id].width = 200;
    layout.cards[id].height = 100;
    layout.cards[id].rotation = 0;
  }
  const calls = [];
  const canvas = new JournalCanvas(new Proxy({}, {
    get: (_, name) => (...args) => calls.push([name, ...args])
  }));
  document.body.appendChild(canvas.root);
  canvas.pinsEnabled = true;
  try {
    canvas.update(notes, layout);
    const secretCard = canvas.root.querySelector(`.jn-card[data-id="${secretId}"]`);
    const sharedCard = canvas.root.querySelector(`.jn-card[data-id="${sharedId}"]`);
    assert.ok(secretCard.querySelector(".jn-pin-main"), "a secret note keeps its own main pin");
    const secretData = layout.cards[secretId];
    const sharedData = layout.cards[sharedId];
    canvas.toggleLinkTool();
    secretCard.querySelector(".jn-pin-main").dispatchEvent(new MouseEvent("click", {
      bubbles: true, button: 0, clientX: secretData.x + 100, clientY: secretData.y
    }));
    sharedCard.dispatchEvent(new MouseEvent("click", {
      bubbles: true, button: 0, clientX: sharedData.x + 80, clientY: sharedData.y + 50
    }));
    const created = calls.find(([name]) => name === "onCreateLink");
    assert.ok(created, "the hidden/secret link gesture still creates a link");
    const ports = created[3];
    for (const key of ["sourceAnchorId", "targetAnchorId", "sourceAnchor", "targetAnchor"]) {
      assert.equal(Object.hasOwn(ports, key), false, `${key} is never sent for a secret link`);
    }
    assert.ok(ports.sourcePoint && ports.targetPoint, "plain normalized points are used instead");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
    await secrets.deleteSecretNote(secretId);
    await settle();
  }
});

test("JournalApp Ctrl+Z sends undoPinChange before trash undo", async () => {
  await requestWrite({ type: "createNote", title: "Pin Undo", x: 1400, y: 120 });
  await settle();
  const noteId = sharedByName("Pin Undo").id;
  await game.settings.set("fvtt-journalinator", "pinsEnabled", true);
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    const card = host.querySelector(`.jn-card[data-id="${noteId}"]`);
    card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    card.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    await redraw();
    const toggle = host.querySelector(".journalinator-main-pin");
    assert.ok(toggle, "the selected note exposes its pin toggle in the app editor");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    // Force the requestWrite socket path so the outbound undo message is observable.
    const descriptor = Object.getOwnPropertyDescriptor(game.users, "activeGM");
    const otherGM = { id: "OtherGM00000001", name: "Other GM", isGM: true, active: true };
    Object.defineProperty(game.users, "activeGM", { configurable: true, get: () => otherGM });
    const before = env.socketLog.length;
    try {
      host.querySelector(".jn-canvas").dispatchEvent(new KeyboardEvent("keydown", {
        key: "z", ctrlKey: true, bubbles: true, cancelable: true
      }));
      await settle();
    } finally {
      Object.defineProperty(game.users, "activeGM", descriptor);
    }
    const messages = env.socketLog.slice(before).map(entry => entry.message);
    assert.ok(messages.some(message => message.type === "undoPinChange" && message.undoId),
      "Ctrl+Z pops the pin history and requests an undo");
  } finally {
    await game.settings.set("fvtt-journalinator", "pinsEnabled", true);
    app._onClose();
    host.remove();
  }
});

test("routed threads pass through main pins, ignore minor targets, and follow transforms", () => {
  const canvas = new JournalCanvas({ onSelectNote() {}, onDeleteLink() {} });
  document.body.appendChild(canvas.root);
  canvas.pinsEnabled = true;
  const aId = "routecardA000001";
  const bId = "routecardB000002";
  const rId = "routecardR000003";
  const link = {
    id: "routelink", targetId: bId, sourceAnchorId: "main", targetAnchorId: "main",
    label: "Via", slack: 0, pins: [{ x: 450, y: 210 }],
    routeAnchors: [
      { noteId: rId, anchorId: "m1" },
      { noteId: rId, anchorId: "main" },
      { noteId: "missingcard00004", anchorId: "main" }
    ]
  };
  const notes = [
    { _id: aId, name: aId, system: { style: "sticky", blocks: [], links: [link] } },
    { _id: bId, name: bId, system: { style: "sticky", blocks: [], links: [] } },
    {
      _id: rId, name: rId,
      system: { style: "sticky", blocks: [], presentation: { torn: true }, links: [] }
    }
  ];
  const layout = () => ({
    cards: {
      [aId]: { x: 0, y: 0, width: 200, height: 100, rotation: 0, anchors: { main: { kind: "main", x: 0.5, y: 0 } } },
      [bId]: { x: 600, y: 0, width: 200, height: 100, rotation: 0, anchors: { main: { kind: "main", x: 0.5, y: 0 } } },
      [rId]: {
        x: 300, y: 150, width: 200, height: 100, rotation: 0,
        anchors: {
          main: { kind: "main", x: 0.5, y: 0 },
          m1: { kind: "minor", x: 0.2, y: 0.5 }
        }
      }
    },
    labels: {}
  });
  const attachment = (box, anchor) => {
    const world = anchorWorld(box, anchor);
    return { x: world.x + world.nx * THREAD_PIN_RADIUS, y: world.y + world.ny * THREAD_PIN_RADIUS };
  };
  const startsAt = (path, point) => path.includes(`M${point.x} ${point.y}`);
  try {
    canvas.update(notes, layout());
    const card = id => canvas.root.querySelector(`.jn-card[data-id="${id}"]`);
    const firstLayout = layout();
    const firstBox = { ...firstLayout.cards[rId], w: 200, h: 100 };
    const mainPoint = attachment(firstBox, { kind: "main", x: 0.5, y: 0 });
    const minorPoint = attachment(firstBox, { kind: "minor", x: 0.2, y: 0.5 });
    const path = () => canvas.svg.querySelector('g[data-id="routelink"] .jn-thread-layer').getAttribute("d");
    const hit = () => canvas.root.querySelector('.jn-link-hit[data-id="routelink"]').getAttribute("d");
    assert.equal(canvas.threads.get("routelink").routePoints.length, 1,
      "only the canonical main waypoint resolves; minor and missing entries are ignored");
    assert.ok(startsAt(path(), mainPoint), "the routed path runs through the main attachment point");
    assert.ok(!startsAt(path(), minorPoint), "Route A never targets a minor pin");
    assert.ok(startsAt(path(), { x: 450, y: 210 }), "existing board pins stay in the path before the route");
    assert.equal(hit(), path(), "the hit path follows the routed geometry");
    assert.equal(canvas.svg.querySelector('g[data-id="routelink"] .jn-link-label').textContent, "Via",
      "labels remain on routed threads");
    assert.ok(canvas.svg.querySelector('.jn-thread-mask-shape[data-note-id="routecardR000003"]'),
      "the routed note contributes its silhouette to the fade mask");

    const group = canvas.svg.querySelector('g[data-id="routelink"]');
    const moved = layout();
    moved.cards[rId] = {
      x: 330, y: 180, width: 240, height: 120, rotation: 90,
      anchors: firstLayout.cards[rId].anchors
    };
    canvas.update(notes, moved);
    const movedBox = { x: 330, y: 180, w: 240, h: 120, rotation: 90 };
    const movedPoint = attachment(movedBox, { kind: "main", x: 0.5, y: 0 });
    assert.equal(canvas.svg.querySelector('g[data-id="routelink"]'), group,
      "route geometry follows a card transform without rebuilding the group");
    assert.ok(startsAt(path(), movedPoint), "moving/rotating/resizing the routed note moves the waypoint");
    assert.notEqual(movedPoint.x, mainPoint.x);
    assert.ok(card(rId).classList.contains("jn-torn"), "the routed note keeps its torn silhouette");

    const detached = [];
    const cleared = [];
    canvas.callbacks.onDetachRouteNote = (...args) => detached.push(args);
    canvas.callbacks.onClearThreadPins = (...args) => cleared.push(args);
    const selectLink = () => {
      const hitEl = canvas.root.querySelector('.jn-link-hit[data-id="routelink"]');
      hitEl.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
      canvas.root.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    };
    selectLink();
    const clearPins = canvas.linkToolbar.querySelector(".jn-link-clear-pins");
    assert.ok(clearPins, "a pinned thread offers a clear-pins action");
    clearPins.click();
    assert.deepEqual(cleared, [[aId, "routelink"]], "clear pins names the source and link only");
    canvas.lastLinkClick = null;
    selectLink();
    const detach = canvas.linkToolbar.querySelector(".jn-link-detach");
    assert.ok(detach, "the selected routed thread offers a detach action");
    detach.click();
    assert.deepEqual(detached[0].slice(0, 3), [aId, "routelink", rId],
      "detach names the source, link and routed note");
    assert.match(detached[0][3], /^[A-Za-z0-9]{16}$/, "detach generates an undo id for the acknowledged transaction");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("multiple route waypoints keep stored order and disabled pins skip rendering", () => {
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.appendChild(canvas.root);
  canvas.pinsEnabled = true;
  const aId = "orderrouteA00001";
  const bId = "orderrouteB00002";
  const r1 = "orderrouteR100003";
  const r2 = "orderrouteR200004";
  const link = {
    id: "orderlink", targetId: bId, sourceAnchorId: "main", targetAnchorId: "main",
    sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 },
    sourceSide: "right", targetSide: "left", slack: 0,
    routeAnchors: [{ noteId: r1, anchorId: "main" }, { noteId: r2, anchorId: "main" }]
  };
  const notes = [
    { _id: aId, name: aId, system: { style: "sticky", blocks: [], links: [link] } },
    { _id: bId, name: bId, system: { style: "sticky", blocks: [], links: [] } },
    {
      _id: r1, name: r1,
      system: { style: "sticky", blocks: [], links: [], attachment: { mainPinEnabled: true } }
    },
    {
      _id: r2, name: r2,
      system: { style: "sticky", blocks: [], links: [], attachment: { mainPinEnabled: true } }
    }
  ];
  const layout = () => ({
    cards: {
      [aId]: { x: 0, y: 0, width: 200, height: 100, anchors: { main: { kind: "main", x: 0.5, y: 0 } } },
      [bId]: { x: 700, y: 0, width: 200, height: 100, anchors: { main: { kind: "main", x: 0.5, y: 0 } } },
      [r1]: { x: 240, y: 180, width: 200, height: 100, anchors: { main: { kind: "main", x: 0.5, y: 0 } } },
      [r2]: { x: 460, y: 180, width: 200, height: 100, anchors: { main: { kind: "main", x: 0.5, y: 0 } } }
    },
    labels: {}
  });
  const attachment = (id, data) => {
    const box = { ...data, w: data.width, h: data.height, rotation: data.rotation ?? 0 };
    const world = anchorWorld(box, data.anchors.main);
    return { x: world.x + world.nx * THREAD_PIN_RADIUS, y: world.y + world.ny * THREAD_PIN_RADIUS };
  };
  try {
    const base = layout();
    canvas.update(notes, base);
    const thread = canvas.threads.get("orderlink");
    assert.equal(thread.routePoints.length, 2, "both route waypoints resolve");
    const first = attachment(r1, base.cards[r1]);
    const second = attachment(r2, base.cards[r2]);
    assert.deepEqual(thread.routePoints.map(point => [point.x, point.y]),
      [[first.x, first.y], [second.x, second.y]], "route points keep their stored order");
    const path = canvas.svg.querySelector('g[data-id="orderlink"] .jn-thread-layer').getAttribute("d");
    assert.ok(path.indexOf(`M${first.x} ${first.y}`) < path.indexOf(`M${second.x} ${second.y}`),
      "the drawn path follows the stored route order");

    // A note that switched its main pin off stops contributing a waypoint immediately.
    notes[3].system.attachment.mainPinEnabled = false;
    canvas.update(notes, layout());
    assert.equal(canvas.threads.get("orderlink").routePoints.length, 1,
      "a disabled main pin is skipped defensively");
    assert.deepEqual(canvas.threads.get("orderlink").routePoints.map(point => [point.x, point.y]),
      [[first.x, first.y]]);

    // The world pin experiment off suppresses every route waypoint, including valid ones.
    canvas.pinsEnabled = false;
    canvas.update(notes, layout());
    assert.equal(canvas.threads.get("orderlink").routePoints.length, 0,
      "pinsEnabled=false skips all route waypoints");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("dropping a note near a thread previews a target and opens the chooser only after drop", () => {
  const calls = [];
  const canvas = new JournalCanvas({
    onSelectNote() {},
    onMoveCard: (...args) => calls.push(["move", ...args]),
    onRouteNoteOnLink: (...args) => calls.push(["route", ...args])
  });
  document.body.appendChild(canvas.root);
  canvas.pinsEnabled = true;
  const aId = "dropcardA0000001";
  const bId = "dropcardB0000002";
  const rId = "dropcardR0000003";
  const link = {
    id: "droplink", targetId: bId, sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 },
    sourceSide: "right", targetSide: "left", slack: 0, pins: [{ x: 450, y: 50 }], label: "Wire"
  };
  const notes = [
    { _id: aId, name: aId, system: { style: "sticky", blocks: [], links: [link] } },
    { _id: bId, name: bId, system: { style: "sticky", blocks: [], links: [] } },
    { _id: rId, name: rId, system: { style: "sticky", blocks: [], links: [] } }
  ];
  const layout = () => ({
    cards: {
      [aId]: { x: 0, y: 0, width: 200, height: 100, anchors: { main: { kind: "main", x: 0.5, y: 0 } } },
      [bId]: { x: 500, y: 0, width: 200, height: 100, anchors: { main: { kind: "main", x: 0.5, y: 0 } } },
      [rId]: { x: 300, y: 0, width: 200, height: 100, anchors: { main: { kind: "main", x: 0.5, y: 0 } } }
    },
    labels: {}
  });
  const pointer = (target, type, x, y, button = 0) => target.dispatchEvent(new MouseEvent(type, {
    bubbles: true, button, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y
  }));
  const beginDrag = (id, dx = 30, dy = 0) => {
    const card = canvas.root.querySelector(`.jn-card[data-id="${id}"]`);
    const box = canvas.cardBox(id);
    const sx = box.x + box.w / 2, sy = box.y + box.h / 2;
    pointer(card, "pointerdown", sx, sy);
    pointer(canvas.root, "pointermove", sx + dx, sy + dy);
    return { sx, sy, ex: sx + dx, ey: sy + dy };
  };
  try {
    canvas.update(notes, layout());
    let drag = beginDrag(rId);
    assert.ok(!canvas.routeChooser, "no mode chooser during the drag");
    assert.ok(canvas.root.querySelector('g[data-id="droplink"]').classList.contains("jn-link-drop-target"),
      "the target thread is highlighted while the note hovers it");
    assert.ok(canvas.svg.querySelector(".jn-route-preview"), "a tentative route preview is drawn");
    pointer(canvas.root, "pointerup", drag.ex, drag.ey);
    assert.ok(canvas.routeChooser, "the chooser opens only after the drop");
    assert.equal(canvas.routeChooser.parentElement, canvas.root, "the chooser is a screen-space child of the canvas");
    assert.equal(canvas.root.querySelector('g[data-id="droplink"] .jn-link-label').textContent, "Wire");
    assert.equal(canvas.root.querySelectorAll('.jn-link-hit[data-id="droplink"]').length, 1,
      "existing hit geometry remains available");
    assert.ok(calls.some(([name, id]) => name === "move" && id === rId), "the note move is committed first");
    assert.equal(calls.some(([name]) => name === "route"), false, "nothing is mutated before a choice");
    assert.deepEqual(link.routeAnchors, undefined, "dragging never edits route data on its own");

    canvas.routeChooser.querySelector(".jn-route-cancel").click();
    assert.equal(canvas.routeChooser, null, "cancel closes the chooser");
    assert.equal(canvas.root.querySelector(".jn-link-drop-target"), null, "cancel clears the highlight");
    assert.equal(canvas.svg.querySelector(".jn-route-preview"), null, "cancel clears the preview");
    assert.equal(calls.some(([name]) => name === "route"), false, "cancel writes nothing");

    // A cancelled pointer (browser gesture, lost capture) must not leave a highlight, preview or
    // chooser behind, and must never open the route transaction.
    drag = beginDrag(rId, 18, 2);
    assert.ok(canvas.root.querySelector('g[data-id="droplink"]').classList.contains("jn-link-drop-target"));
    assert.ok(canvas.svg.querySelector(".jn-route-preview"));
    pointer(canvas.root, "pointercancel", drag.ex, drag.ey);
    assert.equal(canvas.routeDrop, null, "pointercancel clears the drop target");
    assert.equal(canvas.routeChooser, null, "pointercancel never opens the chooser");
    assert.equal(canvas.root.querySelector(".jn-link-drop-target"), null, "pointercancel clears the highlight");
    assert.equal(canvas.svg.querySelector(".jn-route-preview"), null, "pointercancel clears the preview");
    assert.equal(calls.some(([name]) => name === "route"), false, "pointercancel writes nothing");

    // The route preview uses the live thread's spring motion, not a neutral rest path.
    drag = beginDrag(rId, 22, 1);
    const preview = () => canvas.svg.querySelector(".jn-route-preview").getAttribute("d");
    const restPreview = preview();
    const thread = canvas.threads.get("droplink");
    thread.motion.x = 24;
    thread.motion.y = 9;
    pointer(canvas.root, "pointermove", drag.ex, drag.ey);
    assert.notEqual(preview(), restPreview,
      "moving thread motion changes the tentative route path");
    thread.motion.x = 0;
    thread.motion.y = 0;
    pointer(canvas.root, "pointercancel", drag.ex, drag.ey);

    calls.length = 0;
    drag = beginDrag(rId, 20, 4);
    pointer(canvas.root, "pointerup", drag.ex, drag.ey);
    canvas.routeChooser.querySelector(".jn-route-through").click();
    const routed = calls.find(([name]) => name === "route");
    assert.deepEqual(routed, ["route", aId, "droplink", rId, "route", 0, undefined],
      "Route A sends the link, note, mode and append index");
    assert.equal(canvas.routeChooser, null);
    const card = canvas.root.querySelector(`.jn-card[data-id="${rId}"]`);
    const lastMove = [...calls].reverse().find(([name]) => name === "move");
    assert.equal(Number.parseFloat(card.style.left), lastMove[2], "the note stays where it was dropped");

    // Split is deliberately blocked on a thread with board pins, so clear the test pin before
    // exercising the successful split path.
    link.pins = [];
    canvas.update(notes, layout());
    calls.length = 0;
    drag = beginDrag(rId, -20, -4);
    pointer(canvas.root, "pointerup", drag.ex, drag.ey);
    canvas.routeChooser.querySelector(".jn-route-split").click();
    const split = calls.find(([name]) => name === "route");
    assert.equal(split[1], aId);
    assert.equal(split[2], "droplink");
    assert.equal(split[3], rId);
    assert.equal(split[4], "split");
    assert.equal(split[5], 0);
    assert.match(split[6], /^[A-Za-z0-9]{16}$/, "Split generates an undo id for the acknowledged transaction");

    // Focus trap: Tab/Shift+Tab cycle only through enabled choices, and Escape/outside dismissal
    // returns focus to the canvas instead of leaving it on a removed node.
    const press = (target, key, extra = {}) => target.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true, ...extra
    }));
    canvas.root.focus({ preventScroll: true });
    calls.length = 0;
    drag = beginDrag(rId, 10, 0);
    pointer(canvas.root, "pointerup", drag.ex, drag.ey);
    let chooser = canvas.routeChooser;
    assert.ok(chooser, "the chooser reopens for the focus test");
    assert.equal(chooser.getAttribute("role"), "dialog");
    assert.equal(chooser.getAttribute("aria-modal"), "true", "the chooser declares itself modal");
    const buttons = [...chooser.querySelectorAll("button:not([disabled])")];
    assert.equal(buttons.length, 3);
    assert.equal(document.activeElement, buttons[0], "initial focus lands on the first choice");
    press(buttons[0], "Tab");
    assert.equal(document.activeElement, buttons[1], "Tab moves forward inside the chooser");
    press(buttons[1], "Tab", { shiftKey: true });
    assert.equal(document.activeElement, buttons[0], "Shift+Tab moves backward");
    press(buttons[0], "Tab", { shiftKey: true });
    assert.equal(document.activeElement, buttons[2], "Shift+Tab from the first choice wraps to the last");
    press(buttons[2], "Tab");
    assert.equal(document.activeElement, buttons[0], "Tab from the last choice wraps to the first");
    press(buttons[0], "Escape");
    assert.equal(canvas.routeChooser, null, "Escape closes the chooser");
    assert.equal(document.activeElement, canvas.root, "Escape restores focus to the canvas");

    drag = beginDrag(rId, 12, 1);
    pointer(canvas.root, "pointerup", drag.ex, drag.ey);
    chooser = canvas.routeChooser;
    assert.ok(chooser);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
    assert.equal(canvas.routeChooser, null, "clicking outside dismisses the chooser");
    assert.equal(document.activeElement, canvas.root, "outside dismissal restores focus to the canvas");
    assert.equal(canvas.root.querySelector(".jn-link-drop-target"), null, "outside dismissal clears the highlight");
    assert.equal(calls.some(([name]) => name === "route"), false, "focus and dismissal never write route data");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("route/split drop modes explain disabled reasons and never open on pan or far drops", () => {
  const calls = [];
  const canvas = new JournalCanvas({
    onSelectNote() {},
    onMoveCard() {},
    onRouteNoteOnLink: (...args) => calls.push(args)
  });
  document.body.appendChild(canvas.root);
  canvas.pinsEnabled = true;
  const aId = "disabledA00000001";
  const bId = "disabledB00000002";
  const rId = "disabledR00000003";
  const link = {
    id: "disabledlink", targetId: bId, sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 },
    sourceSide: "right", targetSide: "left", slack: 0
  };
  const notes = [
    { _id: aId, name: aId, system: { style: "sticky", blocks: [], links: [link] } },
    { _id: bId, name: bId, system: { style: "sticky", blocks: [], links: [] } },
    { _id: rId, name: rId, system: { style: "sticky", blocks: [], links: [], attachment: { mainPinEnabled: true } } }
  ];
  const layout = () => ({
    cards: {
      [aId]: { x: 0, y: 0, width: 200, height: 100, anchors: { main: { kind: "main", x: 0.5, y: 0 } } },
      [bId]: { x: 500, y: 0, width: 200, height: 100, anchors: { main: { kind: "main", x: 0.5, y: 0 } } },
      [rId]: { x: 300, y: 0, width: 200, height: 100, anchors: { main: { kind: "main", x: 0.5, y: 0 } } }
    },
    labels: {}
  });
  const pointer = (target, type, x, y, button = 0) => target.dispatchEvent(new MouseEvent(type, {
    bubbles: true, button, clientX: x, clientY: y
  }));
  const drop = (id, dx = 20, dy = 0, button = 0) => {
    const box = canvas.cardBox(id);
    const card = canvas.root.querySelector(`.jn-card[data-id="${id}"]`);
    const sx = box.x + box.w / 2, sy = box.y + box.h / 2;
    pointer(card, "pointerdown", sx, sy, button);
    pointer(canvas.root, "pointermove", sx + dx, sy + dy, button);
    pointer(canvas.root, "pointerup", sx + dx, sy + dy, button);
  };
  const reset = () => {
    link.origin = "drawn";
    link.pins = [];
    link.routeAnchors = [];
    notes[2].system.attachment = { mainPinEnabled: true };
    canvas.pinsEnabled = true;
    canvas.update(notes, layout());
  };
  try {
    reset();
    link.origin = "typed";
    canvas.update(notes, layout());
    drop(rId);
    assert.ok(canvas.routeChooser.querySelector(".jn-route-split").disabled,
      "typed links cannot be split");
    assert.match(canvas.routeChooser.querySelector(".jn-route-split").textContent,
      new RegExp(game.i18n.localize("JN.Route.TypedBlocked").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the disabled split explains why");
    assert.equal(canvas.routeChooser.querySelector(".jn-route-through").disabled, false);
    canvas.routeChooser.querySelector(".jn-route-cancel").click();

    reset();
    link.pins = [{ x: 450, y: 50 }];
    canvas.update(notes, layout());
    drop(rId);
    assert.ok(canvas.routeChooser.querySelector(".jn-route-split").disabled,
      "board-pinned threads cannot be split");
    assert.match(canvas.routeChooser.querySelector(".jn-route-split").textContent,
      new RegExp(game.i18n.localize("JN.Route.SplitHint").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the waypoint policy is explained");
    canvas.routeChooser.querySelector(".jn-route-cancel").click();

    reset();
    link.routeAnchors = [{ noteId: "otherrouted00005", anchorId: "main" }];
    canvas.update(notes, layout());
    drop(rId);
    assert.ok(canvas.routeChooser.querySelector(".jn-route-split").disabled,
      "threads that already route through notes cannot be split");
    canvas.routeChooser.querySelector(".jn-route-cancel").click();

    reset();
    notes[2].system.attachment = { mainPinEnabled: false };
    canvas.update(notes, layout());
    drop(rId);
    assert.ok(canvas.routeChooser.querySelector(".jn-route-through").disabled,
      "Route A is unavailable when the dragged note's main pin is off");
    assert.match(canvas.routeChooser.querySelector(".jn-route-through").textContent,
      new RegExp(game.i18n.localize("JN.Route.PinOff").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the pin-off reason stays visible");
    canvas.routeChooser.querySelector(".jn-route-cancel").click();

    reset();
    const noMain = layout();
    noMain.cards[rId].anchors = { m1: { kind: "minor", x: 0.2, y: 0.4 } };
    canvas.update(notes, noMain);
    drop(rId);
    assert.ok(canvas.routeChooser.querySelector(".jn-route-through").disabled,
      "Route A requires a main anchor and never falls back to a minor");
    canvas.routeChooser.querySelector(".jn-route-cancel").click();

    reset();
    canvas.pinsEnabled = false;
    drop(rId);
    assert.ok(canvas.routeChooser.querySelector(".jn-route-through").disabled,
      "turning the world pin experiment off disables Route A");
    canvas.routeChooser.querySelector(".jn-route-cancel").click();

    reset();
    link.routeAnchors = Array.from({ length: MAX_ROUTE_ANCHORS }, (_, index) => ({
      noteId: `fullroute${String(index).padStart(7, "0")}`, anchorId: "main"
    }));
    canvas.update(notes, layout());
    drop(rId);
    assert.ok(canvas.routeChooser.querySelector(".jn-route-through").disabled,
      "Route A is disabled at the server cap");
    assert.match(canvas.routeChooser.querySelector(".jn-route-through").textContent,
      new RegExp(game.i18n.localize("JN.Route.Limit").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the cap reason is localized and visible");
    canvas.routeChooser.querySelector(".jn-route-cancel").click();

    reset();
    drop(rId, 20, 200);
    assert.equal(canvas.routeChooser, null, "a far drop opens no chooser");
    assert.equal(canvas.root.querySelector(".jn-link-drop-target"), null);

    reset();
    const box = canvas.cardBox(rId);
    pointer(canvas.root, "pointerdown", box.x + 10, box.y + 10, 1);
    pointer(canvas.root, "pointermove", box.x + 140, box.y + 90, 1);
    pointer(canvas.root, "pointerup", box.x + 140, box.y + 90, 1);
    assert.equal(canvas.routeChooser, null, "panning never opens the route chooser");

    reset();
    canvas.update(notes, layout());
    drop(aId);
    assert.equal(canvas.routeChooser, null, "links already attached to the dragged note are excluded");

    reset();
    link.routeAnchors = [{ noteId: rId, anchorId: "main" }];
    canvas.update(notes, layout());
    drop(rId);
    assert.equal(canvas.routeChooser, null, "a note already routed through the link is not offered again");
    assert.equal(calls.length, 0, "no mode callback ran in any disabled/far/pan scenario");
  } finally {
    canvas.disconnectGeometry();
    canvas.root.remove();
  }
});

test("JournalApp uses one newest-first undo stack for split, pin, route and detach", async () => {
  await requestWrite({ type: "createNote", title: "Route Undo", x: 1800, y: 120 });
  await settle();
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    const canvas = host.querySelector(".jn-canvas");
    const descriptor = Object.getOwnPropertyDescriptor(game.users, "activeGM");
    const otherGM = { id: "RouteGM000000001", name: "Route GM", isGM: true, active: true };
    Object.defineProperty(game.users, "activeGM", { configurable: true, get: () => otherGM });
    const undo = async () => {
      canvas.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z", ctrlKey: true, bubbles: true, cancelable: true
      }));
      await settle();
    };
    const sentSince = mark => env.socketLog.slice(mark).map(entry => entry.message);
    try {
      // Acknowledgements from another user (or without an undo id) must never create an entry.
      Hooks.callAll("journalinatorWriteApplied", { kind: "route", forUserId: "someoneelse0001", undoId: "wronguser0000001" });
      Hooks.callAll("journalinatorWriteApplied", { kind: "route", forUserId: game.user.id });
      let before = env.socketLog.length;
      await undo();
      assert.equal(sentSince(before).some(message => message.type === "undoRouteSplit"), false,
        "no route undo exists before a successful split acknowledgement");

      // Split acknowledgement, then a later pin acknowledgement: the pin is the newest action.
      Hooks.callAll("journalinatorWriteApplied", {
        kind: "route", action: "split", forUserId: game.user.id, undoId: "routesplitundo001"
      });
      Hooks.callAll("journalinatorWriteApplied", { kind: "pin", forUserId: game.user.id, undoId: "pinundo0000000001" });
      before = env.socketLog.length;
      await undo();
      const first = sentSince(before);
      assert.ok(first.some(message => message.type === "undoPinChange" && message.undoId === "pinundo0000000001"),
        "Ctrl+Z undoes the newest acknowledged action (the pin move) first");
      assert.equal(first.some(message => message.type === "undoRouteSplit"), false,
        "the older split entry waits behind the pin");

      before = env.socketLog.length;
      await undo();
      const second = sentSince(before);
      assert.ok(second.some(message => message.type === "undoRouteSplit" && message.undoId === "routesplitundo001"),
        "the split is undone next, in chronological order");

      // A Route A acknowledgement and a detach acknowledgement join the same stack.
      Hooks.callAll("journalinatorWriteApplied", {
        kind: "route", action: "route", forUserId: game.user.id, undoId: "routeinsertundo01"
      });
      Hooks.callAll("journalinatorWriteApplied", {
        kind: "route", action: "detach", forUserId: game.user.id, undoId: "routeDetachUndo1"
      });
      before = env.socketLog.length;
      await undo();
      assert.ok(sentSince(before).some(message => message.type === "undoRouteSplit" && message.undoId === "routeDetachUndo1"),
        "detach joins the same chronological stack");
      before = env.socketLog.length;
      await undo();
      assert.ok(sentSince(before).some(message => message.type === "undoRouteSplit" && message.undoId === "routeinsertundo01"),
        "the earlier route insertion is next");

      // A stale ack that lacks an undo id is ignored; a rolled-back operation never becomes Ctrl+Z.
      Hooks.callAll("journalinatorWriteApplied", { kind: "route", forUserId: game.user.id, undoId: "" });
      before = env.socketLog.length;
      await undo();
      assert.equal(sentSince(before).some(message => message.type === "undoRouteSplit"), false,
        "stale/rolled-back acknowledgements do not add undo history");

      // Success notices are generated only from acknowledged writes.
      const notices = env.notifications.splice(0).filter(([level]) => level === "info").map(([, text]) => text);
      assert.ok(notices.includes(game.i18n.localize("JN.Route.SplitDone")), "split success is shown on ack");
      assert.ok(notices.includes(game.i18n.localize("JN.Route.Routed")), "route success is shown on ack");
      assert.ok(notices.includes(game.i18n.localize("JN.Route.Detached")), "detach success is shown on ack");

      // Deleting a note joins the same stack, and a later pin is still newer than that deletion.
      const undoNote = sharedByName("Route Undo");
      const card = canvas.querySelector(`.jn-card[data-id="${undoNote.id}"]`);
      card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
      canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
      await settle();
      canvas.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Backspace", bubbles: true, cancelable: true
      }));
      await settle();
      Hooks.callAll("journalinatorWriteApplied", { kind: "pin", forUserId: game.user.id, undoId: "pinNewestAfterDelete" });
      before = env.socketLog.length;
      await undo();
      assert.ok(sentSince(before).some(message => message.type === "undoPinChange"
        && message.undoId === "pinNewestAfterDelete"),
      "a pin acknowledged after a delete is still the newest undo entry");
      before = env.socketLog.length;
      await undo();
      assert.ok(sentSince(before).some(message => message.type === "restoreNote"
        && message.noteId === undoNote.id),
      "the earlier keyboard deletion is restored after the newer pin entry");
    } finally {
      Object.defineProperty(game.users, "activeGM", descriptor);
    }
  } finally {
    app._onClose();
    host.remove();
  }
});

test("main stats count live shared notes only, disclose trash, and leave the private summary separate", async () => {
  await requestWrite({ type: "createNote", title: "Stats Trashed Fixture", x: 2400, y: 800 });
  await settle();
  const trashed = sharedByName("Stats Trashed Fixture");
  assert.ok(trashed, "trash fixture exists");
  await requestWrite({ type: "deleteNote", noteId: trashed.id });
  await settle();
  assert.ok(notesStore.getTrashedNotes().some(note => note.id === trashed.id),
    "the fixture is in the shared trash");

  const page = privateStore.findActive(gmUser.id) ?? await privateStore.createFor(gmUser);
  const workspace = privateStore.read(page);
  const made = privateStore.makeNote({
    title: "Stats Private Only", style: "memo", x: 0, y: 0, cards: workspace.layout.cards
  });
  made.note.blocks = [{ blockId: foundry.utils.randomID(), text: "private-only body" }];
  workspace.notes[made.note.id] = made.note;
  workspace.layout.cards[made.note.id] = made.card;
  await privateStore.save(page, workspace, privateStore.flags(page).rev ?? 0);

  const statsSecretId = await secrets.createSecretNote({
    title: "Stats Vault Secret", x: 5200, y: 800
  });
  const liveCount = selectLiveSharedNotes(notesStore.getSharedNotes()).length;
  const trashCount = notesStore.getTrashedNotes().length;
  const secretTitles = Object.values(vaultStore.data.notes)
    .map(note => note?.name)
    .filter(name => typeof name === "string" && name);
  assert.ok(notesStore.merged, "the GM vault is unlocked and merged for this check");
  assert.ok(secretTitles.length > 0, "a secret note exists to exclude");
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    host.querySelector(".journalinator-stats").click();
    await settle();
    const main = dialogWaits.at(-1);
    assert.ok(main, "the main stats dialog opened");
    assert.ok(main.content.includes(`Live shared notes: ${liveCount}`),
      "main stats count live shared notes");
    assert.ok(main.content.includes(`Trash not counted: ${trashCount}`),
      "the trash line explains what is excluded");
    assert.ok(!main.content.includes("Stats Private Only"),
      "private note titles never enter main stats");
    for (const title of secretTitles) {
      assert.ok(!main.content.includes(title),
        `vault/secret note title "${title}" never enters main stats even while merged`);
    }

    host.querySelector(".jn-view-switch").click();
    host.querySelector(".jn-view-option[data-view='private']").click();
    await settle();
    await redraw();
    host.querySelector(".journalinator-private-stats").click();
    await settle();
    const priv = dialogWaits.at(-1);
    assert.equal(priv.window.title, "Private space summary");
    assert.ok(priv.content.includes("Private notes are not included in the main canvas stats."));
    assert.ok(priv.content.includes(`Notes: ${Object.keys(privateStore.read(page).notes).length}`),
      "the private summary counts only this workspace");
  } finally {
    await secrets.deleteSecretNote(statsSecretId);
    app._onClose();
    host.remove();
  }
});

/** Fresh private notes for transfer UI fixtures, saved while `user` owns the workspace. */
async function addPrivateFixtureNotes(user, titles) {
  const previous = game.user;
  game.user = user;
  try {
    const page = privateStore.findActive(user.id) ?? await privateStore.createFor(user);
    const workspace = privateStore.read(page);
    const ids = [];
    for (const [index, title] of titles.entries()) {
      const made = privateStore.makeNote({
        title, style: "memo", x: 5000 + index * 260, y: 5000, cards: workspace.layout.cards
      });
      made.note.blocks = [{ blockId: foundry.utils.randomID(), text: `${title} body` }];
      workspace.notes[made.note.id] = made.note;
      workspace.layout.cards[made.note.id] = made.card;
      ids.push(made.note.id);
    }
    await privateStore.save(page, workspace, privateStore.flags(page).rev ?? 0);
    return { page, ids };
  } finally {
    game.user = previous;
  }
}

/** Adds extra users for one test and returns a restore function for get/iterator. */
function installExtraUsers(users) {
  const extra = new Map(users.map(user => [user.id, user]));
  const baseGet = game.users.get;
  const baseIterator = game.users[Symbol.iterator];
  game.users.get = id => extra.get(id) ?? baseGet.call(game.users, id);
  game.users[Symbol.iterator] = function* () {
    yield* baseIterator.call(game.users);
    yield* extra.values();
  };
  return () => {
    game.users.get = baseGet;
    game.users[Symbol.iterator] = baseIterator;
  };
}

/** Clicks through the view switch and renders the private canvas. */
async function openPrivateView(app, host, redraw) {
  host.querySelector(".jn-view-switch").click();
  host.querySelector(".jn-view-option[data-view='private']").click();
  await settle();
  await redraw();
}

test("private transfer sender UI excludes self, waits for the GM ack, and names the copy target", async () => {
  const pip = makeUser("SenderPip000001", { name: "Pip" });
  const quinn = makeUser("SenderQuinn0001", { name: "Quinn" });
  const restoreUsers = installExtraUsers([pip, quinn]);

  const { ids: sentIds } = await addPrivateFixtureNotes(gmUser, ["Transfer Alpha", "Transfer Beta"]);
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    host.querySelector(".jn-view-switch").click();
    host.querySelector(".jn-view-option[data-view='private']").click();
    await settle();
    await redraw();
    const canvasRoot = host.querySelector(".jn-canvas");
    const card = id => canvasRoot.querySelector(`.jn-card[data-id="${id}"]`);
    assert.ok(card(sentIds[0]) && card(sentIds[1]), "both sender fixtures render");

    host.querySelector(".journalinator-private-inbox").click();
    const emptyInbox = host.querySelector(".journalinator-transfer-inbox-panel");
    assert.match(emptyInbox.textContent, /No incoming notes/, "an empty inbox is explained");
    emptyInbox.querySelector(".jn-transfer-close").click();
    assert.equal(emptyInbox.hidden, true, "the empty inbox can be closed");

    const send = host.querySelector(".journalinator-private-send");
    assert.equal(send.disabled, true, "send is disabled without a private selection");
    clickCanvasCard({ root: canvasRoot }, sentIds[0]);
    clickCanvasCard({ root: canvasRoot }, sentIds[1], { ctrlKey: true });
    assert.equal(send.disabled, false, "send enables for the private selection");
    quinn.active = false;
    send.click();
    const panel = host.querySelector(".journalinator-transfer-send");
    assert.equal(panel.hidden, false, "the send popover opens");
    assert.equal(document.activeElement, panel.querySelector(".jn-transfer-recipient"),
      "focus starts on the recipient field");
    const options = [...panel.querySelectorAll("option")].map(option => option.value);
    assert.ok(!options.includes(gmUser.id), "the recipient list excludes the sender");
    assert.ok(options.includes(pip.id) && options.includes(quinn.id), "players and GMs can receive");
    assert.match([...panel.querySelectorAll("option")]
      .find(option => option.value === quinn.id).textContent, /offline/,
    "an offline recipient is still listed and marked");
    assert.match(panel.textContent, /Only notes can be transferred/,
      "the send panel states the copy-only boundary");
    quinn.active = true;
    panel.querySelector(".jn-transfer-recipient").value = pip.id;

    const infoBefore = env.notifications.filter(([level]) => level === "info").length;
    panel.querySelector(".jn-transfer-confirm").click();
    assert.equal(panel.hidden, true, "the popover closes on send");
    assert.equal(env.notifications.filter(([level]) => level === "info").length, infoBefore,
      "no optimistic success notice");
    await settle();

    const record = privateStore.pendingTransfers(pip.id).at(-1);
    assert.ok(record, "the GM stored the pending copy");
    assert.equal(record.fromUserId, gmUser.id);
    assert.deepEqual(record.summary.titles, ["Transfer Alpha", "Transfer Beta"]);
    assert.ok(env.notifications.some(([level, text]) =>
      level === "info" && text.includes("Sent 2 note(s) to Pip")),
    "success appears only after the writeApplied acknowledgement");

    // A later popover still excludes the sender and Escape closes it.
    send.click();
    assert.equal(panel.hidden, false);
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(panel.hidden, true, "Escape closes the send popover");
  } finally {
    restoreUsers();
    app._onClose();
    host.remove();
  }
});

test("private transfer inbox is recipient-only, accepts and declines only after ack, and refreshes the space", async () => {
  const pip = makeUser("InboxPip000001", { name: "Pip" });
  const quinn = makeUser("InboxQuinn0001", { name: "Quinn" });
  const restoreUsers = installExtraUsers([pip, quinn]);

  const { ids: gmIds } = await addPrivateFixtureNotes(gmUser, ["Inbox Alpha One", "Inbox Alpha Two"]);
  await requestWrite({ type: "sendPrivateTransfer", toUserId: pip.id, noteIds: gmIds });
  const { ids: secondPipIds } = await addPrivateFixtureNotes(gmUser, ["Inbox Alpha Three"]);
  await requestWrite({ type: "sendPrivateTransfer", toUserId: pip.id, noteIds: secondPipIds });
  const { ids: otherIds } = await addPrivateFixtureNotes(gmUser, ["Other Recipient Secret"]);
  await requestWrite({ type: "sendPrivateTransfer", toUserId: quinn.id, noteIds: otherIds });
  assert.equal(privateStore.findActive(pip.id), null, "the recipient starts without a private page");

  game.user = pip;
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    host.querySelector(".jn-view-switch").click();
    host.querySelector(".jn-view-option[data-view='private']").click();
    await settle();
    await redraw();
    assert.ok(host.querySelector(".jn-private-gate"), "a recipient with no page sees the private gate");
    assert.equal(host.querySelector(".journalinator-private-inbox .jn-transfer-badge")?.textContent, "2",
      "the badge counts every pending transfer for this recipient");
    assert.match(host.querySelector(".journalinator-transfer-banner").textContent, /2 incoming note transfer\(s\)/);

    host.querySelector(".journalinator-private-inbox").click();
    const panel = host.querySelector(".journalinator-transfer-inbox-panel");
    assert.equal(panel.hidden, false, "the inbox popover opens");
    assert.match(panel.textContent, /From GM/);
    assert.match(panel.textContent, /Inbox Alpha One/);
    assert.match(panel.textContent, /Inbox Alpha Three/);
    assert.match(panel.textContent, /2 note\(s\)/);
    assert.ok(!panel.textContent.includes("Other Recipient Secret"),
      "another recipient's titles never leak into this inbox");

    const mark = env.socketLog.length;
    const infoBefore = env.notifications.filter(([level]) => level === "info").length;
    const acceptItem = [...panel.querySelectorAll(".jn-transfer-item")]
      .find(item => item.textContent.includes("Inbox Alpha One"));
    assert.ok(acceptItem, "the requested offer is listed among multiple pending transfers");
    acceptItem.querySelector(".jn-transfer-accept").click();
    assert.equal(env.notifications.filter(([level]) => level === "info").length, infoBefore,
      "accept never shows an optimistic notice");
    const acceptMessage = env.socketLog.slice(mark).map(entry => entry.message)
      .find(message => message.type === "acceptPrivateTransfer");
    assert.ok(acceptMessage, "accept is sent to the active GM");
    assert.equal(privateStore.transfer(acceptMessage.transferId)?.toUserId, pip.id,
      "the pending offer is still present before the ack");

    const previousUser = game.user;
    game.user = gmUser;
    env.deliver(acceptMessage, pip.id);
    await settle();
    const acceptAck = env.socketLog.slice(mark).map(entry => entry.message)
      .find(message => message.type === "writeApplied" && message.forUserId === pip.id);
    assert.ok(acceptAck, "the active GM acknowledges the accepted transfer");
    game.user = pip;
    env.deliver(acceptAck, gmUser.id);
    await settle();
    assert.ok(env.notifications.some(([level, text]) =>
      level === "info" && text.includes("Accepted 2 note(s)")),
    "accept success waits for the acknowledgement");
    assert.ok(privateStore.findActive(pip.id), "accepting created the recipient's private page");
    await redraw();
    assert.ok(host.querySelector(".jn-canvas"), "the private view refreshes with the imported notes");
    assert.ok(host.textContent.includes("Inbox Alpha One"), "the imported copy is visible");

    game.user = gmUser;
    const { ids: declineIds } = await addPrivateFixtureNotes(gmUser, ["Inbox Decline Bravo"]);
    await requestWrite({ type: "sendPrivateTransfer", toUserId: pip.id, noteIds: declineIds });
    game.user = pip;
    await redraw();
    const notesBefore = Object.keys(privateStore.read(privateStore.findActive(pip.id)).notes).length;
    host.querySelector(".journalinator-private-inbox").click();
    const inbox = host.querySelector(".journalinator-transfer-inbox-panel");
    assert.match(inbox.textContent, /Inbox Decline Bravo/);
    const declineItem = [...inbox.querySelectorAll(".jn-transfer-item")]
      .find(item => item.textContent.includes("Inbox Decline Bravo"));
    assert.ok(declineItem, "the declined offer is identified among pending transfers");
    const declineMark = env.socketLog.length;
    const declineInfo = env.notifications.filter(([level]) => level === "info").length;
    declineItem.querySelector(".jn-transfer-decline").click();
    assert.equal(env.notifications.filter(([level]) => level === "info").length, declineInfo,
      "decline never shows an optimistic notice");
    const declineMessage = env.socketLog.slice(declineMark).map(entry => entry.message)
      .find(message => message.type === "declinePrivateTransfer");
    assert.ok(declineMessage, "decline is sent to the active GM");

    game.user = gmUser;
    env.deliver(declineMessage, pip.id);
    await settle();
    const declineAck = env.socketLog.slice(declineMark).map(entry => entry.message)
      .find(message => message.type === "writeApplied" && message.forUserId === pip.id);
    assert.ok(declineAck);
    game.user = pip;
    env.deliver(declineAck, gmUser.id);
    await settle();
    assert.ok(env.notifications.some(([level, text]) =>
      level === "info" && text.includes("Declined 1 note(s)")));
    assert.equal(Object.keys(privateStore.read(privateStore.findActive(pip.id)).notes).length, notesBefore,
      "declining imports nothing");
  } finally {
    restoreUsers();
    app._onClose();
    host.remove();
    game.user = gmUser;
  }
});

test("a player can send a private copy to the GM and it appears in the GM inbox", async () => {
  const player = makeUser("PlayerSender0001", { name: "Rook" });
  const restoreUsers = installExtraUsers([player]);
  const { ids } = await addPrivateFixtureNotes(player, ["Player To GM Copy"]);

  game.user = player;
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    host.querySelector(".jn-view-switch").click();
    host.querySelector(".jn-view-option[data-view='private']").click();
    await settle();
    await redraw();
    const canvasRoot = host.querySelector(".jn-canvas");
    clickCanvasCard({ root: canvasRoot }, ids[0]);
    host.querySelector(".journalinator-private-send").click();
    const panel = host.querySelector(".journalinator-transfer-send");
    const options = [...panel.querySelectorAll("option")].map(option => option.value);
    assert.ok(!options.includes(player.id), "a player's recipient list excludes that player");
    assert.ok(options.includes(gmUser.id), "the GM is a valid recipient");
    panel.querySelector(".jn-transfer-recipient").value = gmUser.id;

    const mark = env.socketLog.length;
    panel.querySelector(".jn-transfer-confirm").click();
    const sentMessage = env.socketLog.slice(mark).map(entry => entry.message)
      .find(message => message.type === "sendPrivateTransfer");
    assert.ok(sentMessage, "the player's send goes through the active GM");
    assert.equal(sentMessage.toUserId, gmUser.id);

    game.user = gmUser;
    env.deliver(sentMessage, player.id);
    await settle();
    const sentAck = env.socketLog.slice(mark).map(entry => entry.message)
      .find(message => message.type === "writeApplied" && message.forUserId === player.id
        && message.action === "sent");
    assert.ok(sentAck, "the GM acknowledges the player's send");
    game.user = player;
    env.deliver(sentAck, gmUser.id);
    await settle();
    assert.ok(env.notifications.some(([level, text]) =>
      level === "info" && text.includes("Sent 1 note(s) to GM")));

    // The GM now sees the pending copy in their own private inbox.
    game.user = gmUser;
    const gmApp = new JournalApp();
    const gmHost = document.createElement("div");
    gmApp.element = gmHost;
    document.body.appendChild(gmHost);
    const gmRedraw = async () => {
      gmApp._replaceHTML(await gmApp._renderHTML(await gmApp._prepareContext()), gmHost);
      gmApp._onRender();
    };
    gmApp._onFirstRender();
    try {
      await gmRedraw();
      gmHost.querySelector(".jn-view-switch").click();
      gmHost.querySelector(".jn-view-option[data-view='private']").click();
      await settle();
      await gmRedraw();
      assert.ok(gmHost.querySelector(".jn-transfer-badge"), "the GM inbox carries a count badge");
      gmHost.querySelector(".journalinator-private-inbox").click();
      assert.match(gmHost.querySelector(".journalinator-transfer-inbox-panel").textContent,
        /Player To GM Copy/);
    } finally {
      gmApp._onClose();
      gmHost.remove();
    }
  } finally {
    restoreUsers();
    app._onClose();
    host.remove();
    game.user = gmUser;
  }
});

test("banner click closes the inbox without reopening it", async () => {
  const recipient = makeUser("BannerPip000001", { name: "Banner Pip" });
  const restoreUsers = installExtraUsers([recipient]);
  const { ids } = await addPrivateFixtureNotes(gmUser, ["Banner Copy"]);
  await requestWrite({ type: "sendPrivateTransfer", toUserId: recipient.id, noteIds: ids });

  game.user = recipient;
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    await openPrivateView(app, host, redraw);
    const banner = host.querySelector(".journalinator-transfer-banner");
    assert.ok(banner, "the incoming banner is rendered");
    banner.click();
    const panel = host.querySelector(".journalinator-transfer-inbox-panel");
    assert.equal(panel.hidden, false, "the banner opens the inbox");

    banner.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    banner.click();
    assert.equal(panel.hidden, true,
      "clicking the banner again closes it instead of pointerdismiss-then-reopening");
  } finally {
    restoreUsers();
    app._onClose();
    host.remove();
    game.user = gmUser;
  }
});

test("offline disables private send and inbox actions", async () => {
  const user = makeUser("OfflinePlayer0001", { name: "Offline Player" });
  const restoreUsers = installExtraUsers([user]);
  const { ids } = await addPrivateFixtureNotes(user, ["Offline Selection"]);
  game.user = user;
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  const descriptor = Object.getOwnPropertyDescriptor(game.users, "activeGM");
  Object.defineProperty(game.users, "activeGM", { configurable: true, get: () => null });
  try {
    await redraw();
    await openPrivateView(app, host, redraw);
    const canvasRoot = host.querySelector(".jn-canvas");
    clickCanvasCard({ root: canvasRoot }, ids[0]);
    const send = host.querySelector(".journalinator-private-send");
    const inbox = host.querySelector(".journalinator-private-inbox");
    assert.equal(send.disabled, true, "send is disabled without an active GM");
    assert.equal(inbox.disabled, true, "inbox is disabled without an active GM");
    send.click();
    assert.equal(host.querySelector(".journalinator-transfer-send").hidden, true,
      "a disabled send cannot open its popover");
  } finally {
    Object.defineProperty(game.users, "activeGM", descriptor);
    restoreUsers();
    app._onClose();
    host.remove();
    game.user = gmUser;
  }
});

test("send is disabled and warns when the player has no private page", async () => {
  const user = makeUser("NoPagePlayer0001", { name: "No Page" });
  const restoreUsers = installExtraUsers([user]);
  game.user = user;
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    await openPrivateView(app, host, redraw);
    const send = host.querySelector(".journalinator-private-send");
    assert.equal(send.disabled, true, "send is disabled without a private page");
    assert.match(send.getAttribute("aria-label"), /private journal/i);
    send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    assert.equal(host.querySelector(".journalinator-transfer-send").hidden, true);
    assert.ok(env.notifications.some(([level, text]) =>
      level === "warn" && /private journal/i.test(text)),
    "clicking send warns that a private page is needed");
  } finally {
    restoreUsers();
    app._onClose();
    host.remove();
    game.user = gmUser;
  }
});

test("private transfer acknowledgements surface dropped links and waypoints", () => {
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  app._onFirstRender();
  try {
    const before = env.notifications.length;
    Hooks.callAll("journalinatorWriteApplied", {
      forUserId: game.user.id,
      kind: "privateTransfer",
      action: "sent",
      count: 2,
      toUserId: gmUser.id,
      droppedLinks: 1,
      droppedWaypoints: 2
    });
    const warnings = env.notifications.slice(before)
      .filter(([level]) => level === "warn").map(([, text]) => text);
    assert.ok(warnings.some(text => text.includes("Dropped 1 link")), "the link drop is shown");
    assert.ok(warnings.some(text => text.includes("Dropped 2 route waypoint")),
      "the waypoint drop is shown separately");
  } finally {
    app._onClose();
    host.remove();
  }
});

test("shared multi-delete asks first, deletes only after confirmation, and reports recovery", async () => {
  await requestWrite({ type: "createNote", title: "Delete Alpha", x: 6000, y: 0 });
  await requestWrite({ type: "createNote", title: "Delete Beta", x: 6300, y: 0 });
  await settle();
  const alpha = sharedByName("Delete Alpha");
  const beta = sharedByName("Delete Beta");
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    const canvasRoot = host.querySelector(".jn-canvas");
    clickCanvasCard({ root: canvasRoot }, alpha.id);
    clickCanvasCard({ root: canvasRoot }, beta.id, { ctrlKey: true });
    const beforeCancel = env.notifications.length;
    answers.push(false);
    canvasRoot.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await settle();
    assert.equal(alpha.system.deleted, null, "cancelling leaves the first note live");
    assert.equal(beta.system.deleted, null, "cancelling leaves the second note live");
    assert.equal(env.notifications.slice(beforeCancel).filter(([level]) => level === "info").length, 0,
      "cancelling shows no deletion notice");

    answers.push(true);
    const beforeDelete = env.notifications.length;
    canvasRoot.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await settle();
    assert.ok(alpha.system.deleted, "confirming trashes the first note");
    assert.ok(beta.system.deleted, "confirming trashes the second note");
    assert.ok(env.notifications.slice(beforeDelete).some(([level, text]) =>
      level === "info" && text.includes("Deleted 2 note(s)") && text.includes("Ctrl+Z")),
    "the multi-delete notice explains trash and undo recovery");

    await redraw();
    const trash = host.querySelector(".journalinator-trash");
    const count = notesStore.getTrashedNotes().length;
    assert.equal(trash.querySelector(".jn-toolbar-badge").textContent, String(count),
      "the shared Trash button shows the recoverable note count");
    assert.match(trash.getAttribute("aria-label"), new RegExp(`\\(${count}\\)`),
      "the badge count is also in the accessible label");

    trash.click();
    await settle();
    const content = dialogWaits.at(-1)?.content ?? "";
    assert.ok(content.includes(game.i18n.localize("JN.Trash.RecoverableHint")), "shared trash explains recovery");
    assert.ok(content.includes(game.user.name), "the trash dialog names who deleted the note");
    assert.ok(content.includes(String(new Date().getFullYear())), "the trash dialog shows the deletion date");
  } finally {
    app._onClose();
    host.remove();
    for (const note of [alpha, beta]) {
      if (note?.system.deleted) await requestWrite({ type: "restoreNote", noteId: note.id });
    }
  }
});

test("private multi-delete confirms, then badges and dates the private trash", async () => {
  const user = makeUser("DeletePip000001", { name: "Delete Pip" });
  const restoreUsers = installExtraUsers([user]);
  const { page, ids } = await addPrivateFixtureNotes(user, ["Private Delete A", "Private Delete B"]);
  game.user = user;
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    await openPrivateView(app, host, redraw);
    const canvasRoot = host.querySelector(".jn-canvas");
    clickCanvasCard({ root: canvasRoot }, ids[0]);
    clickCanvasCard({ root: canvasRoot }, ids[1], { ctrlKey: true });

    answers.push(false);
    canvasRoot.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await settle();
    let workspace = privateStore.read(page);
    assert.ok(workspace.notes[ids[0]] && workspace.notes[ids[1]], "cancelling keeps both private notes");

    answers.push(true);
    const beforeDelete = env.notifications.length;
    canvasRoot.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await settle();
    await redraw();
    workspace = privateStore.read(page);
    assert.equal(workspace.notes[ids[0]], undefined, "confirming removes the first private note");
    assert.equal(workspace.notes[ids[1]], undefined, "confirming removes the second private note");
    assert.equal(workspace.trash.length, 2, "both private notes are recoverable in the private trash");
    assert.ok(env.notifications.slice(beforeDelete).some(([level, text]) =>
      level === "info" && text.includes("Deleted 2 note(s)")),
    "the private multi-delete notice explains recovery");

    const trash = host.querySelector(".journalinator-trash");
    assert.equal(trash.querySelector(".jn-toolbar-badge").textContent, "2",
      "the private Trash button shows its recoverable count");
    trash.click();
    await settle();
    const content = dialogWaits.at(-1)?.content ?? "";
    assert.ok(content.includes(game.i18n.localize("JN.Trash.RecoverableHint")), "private trash explains recovery");
    assert.ok(content.includes("Deleted by you"), "private trash names the deleting user");
    assert.ok(content.includes(String(new Date().getFullYear())), "private trash shows when the notes were deleted");
  } finally {
    restoreUsers();
    app._onClose();
    host.remove();
    game.user = gmUser;
    await privateStore.remove(page);
  }
});

test("shared delete notice waits for the GM ack and undo survives a failed write", async () => {
  await requestWrite({ type: "createNote", title: "Ack Wait Note", x: 6600, y: 0 });
  await settle();
  const note = sharedByName("Ack Wait Note");
  const player = makeUser("AckWaitPip00001", { name: "Ack Wait Pip" });
  const restoreUsers = installExtraUsers([player]);
  game.user = player;
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    const canvasRoot = host.querySelector(".jn-canvas");
    clickCanvasCard({ root: canvasRoot }, note.id);
    const before = env.notifications.length;
    canvasRoot.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await settle();
    assert.equal(note.system.deleted, null, "the player's delete is only a request; no GM applied it");
    assert.equal(env.notifications.slice(before).filter(([level, text]) =>
      level === "info" && text.includes("Deleted")).length, 0,
    "no success notice is shown before the GM acknowledges the delete");

    const beforeUndo = env.socketLog.length;
    canvasRoot.dispatchEvent(new KeyboardEvent("keydown", {
      key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true
    }));
    await settle();
    const sent = env.socketLog.slice(beforeUndo).map(entry => entry.message);
    assert.ok(sent.some(message => message.type === "restoreNote" && message.noteId === note.id),
      "Ctrl+Z still consumes the queued delete and asks for a restore when the write never landed");
  } finally {
    restoreUsers();
    app._onClose();
    host.remove();
    game.user = gmUser;
    await requestWrite({ type: "deleteNote", noteId: note.id });
    await requestWrite({ type: "restoreNote", noteId: note.id });
  }
});

test("rapid repeated shared Delete opens a single confirmation", async () => {
  await requestWrite({ type: "createNote", title: "Rapid Delete Alpha", x: 6900, y: 0 });
  await requestWrite({ type: "createNote", title: "Rapid Delete Beta", x: 7200, y: 0 });
  await settle();
  const alpha = sharedByName("Rapid Delete Alpha");
  const beta = sharedByName("Rapid Delete Beta");
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  const dialog = foundry.applications.api.DialogV2;
  const originalConfirm = dialog.confirm;
  let confirmations = 0;
  dialog.confirm = async () => { confirmations += 1; return false; };
  try {
    await redraw();
    const canvasRoot = host.querySelector(".jn-canvas");
    clickCanvasCard({ root: canvasRoot }, alpha.id);
    clickCanvasCard({ root: canvasRoot }, beta.id, { ctrlKey: true });
    const pressDelete = () => canvasRoot.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })
    );
    pressDelete();
    pressDelete();
    pressDelete();
    assert.equal(confirmations, 1, "a held or mashed Delete key cannot stack confirmations");
    await settle();
    assert.equal(alpha.system.deleted, null, "a cancelled confirmation deletes nothing");
    assert.equal(beta.system.deleted, null, "a cancelled confirmation deletes nothing");
    pressDelete();
    assert.equal(confirmations, 2, "after cancelling, Delete can ask again");
    await settle();
  } finally {
    dialog.confirm = originalConfirm;
    app._onClose();
    host.remove();
  }
});

test("rapid repeated private Delete opens a single confirmation", async () => {
  const user = makeUser("RapidPip0000001", { name: "Rapid Pip" });
  const restoreUsers = installExtraUsers([user]);
  const { page, ids } = await addPrivateFixtureNotes(user, ["Rapid Private A", "Rapid Private B"]);
  game.user = user;
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  const dialog = foundry.applications.api.DialogV2;
  const originalConfirm = dialog.confirm;
  let confirmations = 0;
  dialog.confirm = async () => { confirmations += 1; return false; };
  try {
    await redraw();
    await openPrivateView(app, host, redraw);
    const canvasRoot = host.querySelector(".jn-canvas");
    clickCanvasCard({ root: canvasRoot }, ids[0]);
    clickCanvasCard({ root: canvasRoot }, ids[1], { ctrlKey: true });
    const pressDelete = () => canvasRoot.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })
    );
    pressDelete();
    pressDelete();
    pressDelete();
    assert.equal(confirmations, 1, "a held or mashed Delete key cannot stack private confirmations");
    await settle();
    const workspace = privateStore.read(page);
    assert.ok(workspace.notes[ids[0]] && workspace.notes[ids[1]], "cancelling keeps both private notes");
    pressDelete();
    assert.equal(confirmations, 2, "after cancelling, private Delete can ask again");
    await settle();
  } finally {
    dialog.confirm = originalConfirm;
    restoreUsers();
    app._onClose();
    host.remove();
    game.user = gmUser;
    await privateStore.remove(page);
  }
});

test("private multi-delete then Ctrl+Z restores the whole batch", async () => {
  const user = makeUser("UndoPip00000001", { name: "Undo Pip" });
  const restoreUsers = installExtraUsers([user]);
  const { page, ids } = await addPrivateFixtureNotes(user, ["Undo Private A", "Undo Private B"]);
  game.user = user;
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    await openPrivateView(app, host, redraw);
    const canvasRoot = host.querySelector(".jn-canvas");
    clickCanvasCard({ root: canvasRoot }, ids[0]);
    clickCanvasCard({ root: canvasRoot }, ids[1], { ctrlKey: true });
    answers.push(true);
    canvasRoot.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await settle();
    await redraw();
    let workspace = privateStore.read(page);
    assert.equal(workspace.notes[ids[0]], undefined, "both notes were deleted");
    assert.equal(workspace.notes[ids[1]], undefined, "both notes were deleted");
    assert.equal(workspace.trash.length, 2, "the batch is recoverable from the private trash");

    const afterDelete = host.querySelector(".jn-canvas");
    afterDelete.dispatchEvent(new KeyboardEvent("keydown", {
      key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true
    }));
    await settle();
    await redraw();
    workspace = privateStore.read(page);
    assert.ok(workspace.notes[ids[0]], "Ctrl+Z restores the first note in the batch");
    assert.ok(workspace.notes[ids[1]], "Ctrl+Z restores the second note in the batch");
    assert.equal(workspace.trash.length, 0, "the restored batch leaves the trash empty");
  } finally {
    restoreUsers();
    app._onClose();
    host.remove();
    game.user = gmUser;
    await privateStore.remove(page);
  }
});

test("private trash restores legacy entries by note id and empties on confirmation", async () => {
  const user = makeUser("LegacyTrashPip01", { name: "Legacy Trash Pip" });
  const restoreUsers = installExtraUsers([user]);
  const { page } = await addPrivateFixtureNotes(user, []);
  game.user = user;
  const workspace = new PrivateWorkspace({ onChange() {} });
  const makeLegacyTrash = async title => {
    const data = privateStore.read(page);
    const made = privateStore.makeNote({
      title, style: "memo", x: 8000, y: 8000, cards: data.layout.cards
    });
    made.note.blocks = [{ blockId: foundry.utils.randomID(), text: `${title} body` }];
    data.trash.unshift({ note: made.note, card: made.card, deletedAt: Date.now() });
    await privateStore.save(page, data, privateStore.flags(page).rev ?? 0);
    return made.note.id;
  };
  try {
    const legacyId = await makeLegacyTrash("Legacy Trash Note");
    const withOrphan = privateStore.read(page);
    withOrphan.trash.unshift({ card: { x: 0, y: 0 }, deletedAt: Date.now() });
    await privateStore.save(page, withOrphan, privateStore.flags(page).rev ?? 0);
    workspace.setPage(page);
    await workspace.openTrash();
    const restoreDialog = renderLastDialog();
    assert.equal(restoreDialog.element.querySelector('[data-id="undefined"]'), null,
      "a legacy card-only entry is not offered as a restore row");
    const restoreButton = restoreDialog.element.querySelector(`.jn-trash-restore[data-id="${legacyId}"]`);
    assert.ok(restoreButton, "a trash entry without undoId is keyed by its note id");
    restoreButton.click();
    await settle();
    let data = privateStore.read(page);
    assert.ok(data.notes[legacyId], "clicking Restore brings the legacy entry back");
    assert.equal(data.trash.length, 1, "the restored legacy entry leaves the trash; the unusable orphan stays");

    const firstId = await makeLegacyTrash("Empty Trash One");
    const secondId = await makeLegacyTrash("Empty Trash Two");
    workspace.setPage(page);
    await workspace.openTrash();
    const emptyDialog = renderLastDialog();
    answers.push(true);
    emptyDialog.element.querySelector(".jn-trash-empty").click();
    await settle();
    data = privateStore.read(page);
    assert.equal(data.trash.length, 0, "confirmed Empty Trash clears every recoverable entry");
    assert.equal(data.notes[firstId], undefined, "emptied notes are not restored");
    assert.equal(data.notes[secondId], undefined, "emptied notes are not restored");

    await workspace.openTrash();
    const emptyState = renderLastDialog();
    assert.ok(emptyState.element.textContent.includes(game.i18n.localize("JN.Trash.Empty")),
      "an empty trash says so");
    assert.equal(emptyState.element.querySelector(".jn-trash-empty"), null,
      "there is nothing to empty when the trash is already empty");
  } finally {
    restoreUsers();
    workspace.destroy();
    game.user = gmUser;
    await privateStore.remove(page);
  }
});

test("shared trash restore clicks return a note to the board", async () => {
  await requestWrite({ type: "createNote", title: "Trash Restore Click", x: 7500, y: 0 });
  await settle();
  const note = sharedByName("Trash Restore Click");
  await requestWrite({ type: "deleteNote", noteId: note.id });
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    host.querySelector(".journalinator-trash").click();
    await settle();
    const dialog = renderLastDialog();
    const restoreButton = dialog.element.querySelector(`.jn-trash-restore[data-id="${note.id}"]`);
    assert.ok(restoreButton, "the trashed note has a Restore button");
    restoreButton.click();
    await settle();
    assert.equal(note.system.deleted, null, "clicking Restore brings the shared note back");
    assert.deepEqual(dialog.closed, [true], "the trash dialog closes after restoring");
  } finally {
    app._onClose();
    host.remove();
  }
});

test("private save conflicts explain the reload and keep the latest workspace", async () => {
  const user = makeUser("ConflictPip0001", { name: "Conflict Pip" });
  const restoreUsers = installExtraUsers([user]);
  const { page, ids } = await addPrivateFixtureNotes(user, ["Conflict Note"]);
  game.user = user;
  const workspace = new PrivateWorkspace({ onChange() {} });
  workspace.setPage(page);
  const originalSave = privateStore.save;
  const before = env.notifications.length;
  try {
    privateStore.save = async () => { throw new Error(game.i18n.localize("JN.Private.SaveConflict")); };
    const saved = await workspace.updateNote(ids[0], { label: "Unsaved local label" });
    assert.equal(saved, false, "a conflicting save is reported as not applied");
    const warnings = env.notifications.slice(before).filter(([level]) => level === "warn").map(([, text]) => text);
    assert.ok(warnings.some(text => /another tab/i.test(text) && /unsaved local changes/i.test(text)),
      "the warning explains who changed the space and that local changes were not saved");
    assert.notEqual(privateStore.read(page).notes[ids[0]].label, "Unsaved local label",
      "the latest reloaded workspace does not contain the unsaved local edit");
  } finally {
    privateStore.save = originalSave;
    restoreUsers();
    workspace.destroy();
    game.user = gmUser;
    await privateStore.remove(page);
  }
});

test("search and filters show how many live notes are hidden, not deleted", async () => {
  const app = new JournalApp();
  const host = document.createElement("div");
  app.element = host;
  document.body.appendChild(host);
  const redraw = async () => {
    app._replaceHTML(await app._renderHTML(await app._prepareContext()), host);
    app._onRender();
  };
  app._onFirstRender();
  try {
    await redraw();
    const indicator = host.querySelector(".jn-filter-indicator");
    assert.equal(indicator.hidden, true, "no indicator without a search or filter");

    const search = host.querySelector(".journalinator-search");
    search.value = "Tavern";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(indicator.hidden, false, "searching reveals the filter indicator");
    assert.match(indicator.textContent, /hidden by filter/, "the indicator names the hidden live notes");
    assert.ok(Number(indicator.dataset.hiddenCount) > 0, "the hidden count is available to tests and users");

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(indicator.hidden, true, "clearing the search hides the indicator");

    const style = host.querySelector('.journalinator-filters [data-kind="style"][value="document"]');
    style.checked = true;
    style.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(indicator.hidden, false, "an active style filter also reveals the indicator");
    assert.ok(indicator.textContent.trim().length > 0, "the indicator always has a label while filtering");
    style.checked = false;
    style.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(indicator.hidden, true, "removing the last filter hides the indicator");
  } finally {
    app._onClose();
    host.remove();
  }
});

test("no unexpected errors were reported", () => {
  const unexpected = errors().filter(([, m]) => !m.includes("links a secret note"));
  assert.deepEqual(unexpected, []);
});
