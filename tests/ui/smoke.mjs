/**
 * UI smoke test: renders the real NoteEditor and JournalCanvas in jsdom on top of the fake
 * Foundry and clicks through the GM flows. Catches runtime errors the data-path tests can't.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const JN = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const k of ["document", "HTMLElement", "Node", "Event", "KeyboardEvent", "MouseEvent"]) globalThis[k] = dom.window[k];
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);

const { installFoundry, makeContainers, makeUser } = await import(`${JN}/tests/fake-foundry.mjs`);
const gmUser = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const env = installFoundry({ user: gmUser, users: [gmUser] });
const containers = await makeContainers(env);

// Dialog fakes: queue answers per call.
const answers = [];
globalThis.foundry.applications = {
  api: {
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
const { default: NoteEditor } = await import(`${JN}/scripts/app/editor.mjs`);
const { default: JournalCanvas } = await import(`${JN}/scripts/app/canvas.mjs`);
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

test("secret note shows the GM banner, renames keep the prefix, declassify publishes", async () => {
  editor.open(vexId);
  editor.render();
  assert.ok(editor.root.querySelector(".jn-gm-banner"));
  const prefix = vaultStore.data.notes[vexId].name.slice(0, 8);
  answers.push("Lady Vex");
  editor.root.querySelector(".journalinator-rename").click();
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
  const cultId = await secrets.createSecretNote({ title: "Cult", x: 0, y: 300 });
  await secrets.addHiddenLink(tavernId, cultId);
  const calls = [];
  const canvas = new JournalCanvas(new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) }));
  document.body.appendChild(canvas.root);
  canvas.gmMode = true;
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  const card = canvas.root.querySelector(`.jn-card[data-id="${cultId}"]`);
  assert.ok(card.classList.contains("jn-secret"));
  const hiddenLink = canvas.root.querySelector("g.jn-link-hidden");
  assert.ok(hiddenLink, "hidden link drawn");

  // Player view: no secret card.
  notesStore.setGmView(false);
  canvas.gmMode = false;
  canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
  assert.equal(canvas.root.querySelector(`.jn-card[data-id="${cultId}"]`), null);
  assert.equal(canvas.root.querySelector("g.jn-link-hidden"), null);
  notesStore.setGmView(true);
});

test("no unexpected errors were reported", () => {
  const unexpected = errors().filter(([, m]) => !m.includes("links a secret note"));
  assert.deepEqual(unexpected, []);
});
