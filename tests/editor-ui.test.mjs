import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const key of [
  "document", "window", "Node", "HTMLElement", "Event", "KeyboardEvent",
  "MouseEvent", "CompositionEvent", "Range", "NodeFilter"
]) {
  globalThis[key] = dom.window[key];
}

const { default: NoteEditor } = await import("../scripts/app/editor.mjs");
const { DraftStore } = await import("../scripts/editor/drafts.mjs");
const { noteBodyHash } = await import("../scripts/editor/session.mjs");
const { parseDocument } = await import("../scripts/document/parse.mjs");
const { createSocketTransport } = await import("../scripts/editor/socket-transport.mjs");

const NOTE_ID = "Note000000000001";
const SKIN = {
  paper: "amber",
  font: "handwritten",
  torn: false,
  backgroundImage: null,
  tiltSeed: 0
};

const STRINGS = {
  "JN.Editor.Toolbar": "Editing tools",
  "JN.Editor.Title": "Title",
  "JN.Editor.Divider": "Divider",
  "JN.Editor.Portrait": "Portrait",
  "JN.Editor.Layout": "Layout",
  "JN.Editor.Appearance": "Appearance",
  "JN.Editor.Done": "Done",
  "JN.Editor.EditingYou": "Editing · You",
  "JN.Editor.CopyText": "Copy text",
  "JN.Editor.AddTitleGhost": "Add title…",
  "JN.Editor.DividerInCode": "Move the cursor outside code or a comment to insert a divider.",
  "JN.Editor.CodeInsertBlocked": "Move the cursor outside code or a comment to insert an image.",
  "JN.Editor.Status.Opening": "Opening editor…",
  "JN.Editor.Status.Saved": "Saved",
  "JN.Editor.Status.Saving": "Saving…",
  "JN.Editor.Status.Offline": "Offline",
  "JN.Editor.Status.OfflineSaved": "Offline — saved locally",
  "JN.Editor.Status.StorageUnavailable": "Recovery copy unavailable in this browser.",
  "JN.Editor.Status.SaveFailed": "Couldn’t save. Your draft is kept on this device.",
  "JN.Editor.Status.GmEnded": "The GM ended this editing session. Your unsaved text is kept locally.",
  "JN.Editor.Status.LeaseLost": "Editing connection lost. Reopen the note to recover your draft.",
  "JN.Editor.Status.Locked": "Someone else is editing this note.",
  "JN.Editor.Status.ConflictChanged": "This note changed while you were editing. Copy your text before reopening or retrying.",
  "JN.Common.Close": "Close",
  "JN.Common.Cancel": "Cancel",
  "JN.Common.Retry": "Retry",
  "JN.Skin.Paper": "Paper",
  "JN.Skin.Font": "Font",
  "JN.Skin.Torn": "Torn edges",
  "JN.Skin.BackgroundImage": "Background image",
  "JN.Skin.Choose": "Choose",
  "JN.Skin.Remove": "Remove",
  "JN.Skin.Paper.Cream": "Cream",
  "JN.Skin.Paper.Amber": "Amber",
  "JN.Skin.Paper.Parchment": "Parchment",
  "JN.Skin.Font.Default": "Default",
  "JN.Skin.Font.Serif": "Serif",
  "JN.Skin.Font.Handwritten": "Handwritten",
  "JN.Skin.Font.Display": "Display",
  "JN.Layout.Plain": "Plain",
  "JN.Layout.Profile": "Profile",
  "JN.Profile.Fallback": "Showing Plain until the structure is complete.",
  "JN.Profile.AddTitle": "Add title",
  "JN.Profile.InsertPortrait": "Insert portrait",
  "JN.Profile.ChooseImage": "Choose image",
  "JN.Profile.NeedsTitle": "Profile needs a title on the first line.",
  "JN.Profile.MoveTitle": "Move the title to the first line.",
  "JN.Profile.NeedsPortrait": "Profile needs a portrait after the title.",
  "JN.Profile.MovePortrait": "Move the portrait directly below the title or its divider.",
  "JN.Profile.CompletePortrait": "Complete the portrait image or choose an image."
};
const t = (key, data) => {
  const value = STRINGS[key] ?? key;
  if (!data) return value;
  return value.replace(/\{(\w+)\}/g, (_, name) => String(data[name] ?? ""));
};

function makeClock(start = 10000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms = 0) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const timer of timers.values()) {
          if (timer.at > target) continue;
          if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = target;
    }
  };
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

async function settle(rounds = 30) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

class FakeTransport {
  constructor(clock, note = {}) {
    this.clock = clock;
    this.note = {
      noteId: NOTE_ID,
      body: note.body ?? "# Title\nBody",
      revision: note.revision ?? 1,
      layout: note.layout ?? "plain",
      skin: note.skin ?? { ...SKIN },
      deleted: false
    };
    this.calls = [];
    this.beginImpl = null;
    this.saveImpl = null;
    this.appearanceImpl = null;
    this.endImpl = null;
    this.stateImpl = null;
    this._token = 0;
    this._lease = null;
  }

  now() { return this.clock.now(); }
  setTimeout(fn, ms) { return this.clock.setTimeout(fn, ms); }
  clearTimeout(id) { this.clock.clearTimeout(id); }

  lease(noteId = this.note.noteId) {
    this._token += 1;
    this._lease = {
      canvasId: "shared",
      noteId,
      userId: "user-1",
      clientSessionId: "tab-test",
      leaseToken: `lease-${this._token}`,
      gmEpoch: "epoch-1"
    };
    return { ...this._lease };
  }

  grant(overrides = {}) {
    return {
      type: "noteEditGranted",
      lease: this.lease(),
      revision: this.note.revision,
      body: this.note.body,
      layout: this.note.layout,
      skin: this.note.skin,
      deleted: false,
      ...overrides
    };
  }

  ackSave(args) {
    this.note.body = args.body;
    this.note.revision += 1;
    return {
      type: "noteSaveAck",
      revision: this.note.revision,
      sequence: args.sequence,
      bodyHash: noteBodyHash(args.body),
      accepted: true
    };
  }

  begin(args) {
    this.calls.push({ name: "begin", args });
    if (this.beginImpl) return this.beginImpl(args);
    return Promise.resolve(this.grant());
  }

  heartbeat(args) {
    this.calls.push({ name: "heartbeat", args });
    return Promise.resolve({
      type: "noteEditHeartbeatAck",
      leaseToken: args.lease.leaseToken,
      gmEpoch: args.lease.gmEpoch
    });
  }

  preview(args) {
    this.calls.push({ name: "preview", args });
  }

  save(args) {
    this.calls.push({ name: "save", args });
    if (this.saveImpl) return this.saveImpl(args);
    return Promise.resolve(this.ackSave(args));
  }

  appearance(args) {
    this.calls.push({ name: "appearance", args });
    if (this.appearanceImpl) return this.appearanceImpl(args);
    this.note.layout = args.layout;
    this.note.skin = args.skin;
    return Promise.resolve({
      type: "noteAppearanceAck",
      layout: args.layout,
      skin: args.skin
    });
  }

  end(args) {
    this.calls.push({ name: "end", args });
    if (this.endImpl) return this.endImpl(args);
    if (args.body !== undefined) this.ackSave(args);
    return Promise.resolve({
      type: "noteEditEnded",
      revision: this.note.revision,
      released: true
    });
  }

  state() {
    this.calls.push({ name: "state", args: {} });
    if (this.stateImpl) return this.stateImpl();
    return Promise.resolve({
      note: {
        noteId: this.note.noteId,
        revision: this.note.revision,
        body: this.note.body,
        deleted: false
      }
    });
  }
}

function makeDrafts(clock, storage = new MemoryStorage(), available = true) {
  if (!available) {
    return {
      isAvailable: () => false,
      load: () => null,
      save: () => false,
      remove: () => false,
      flushPending: () => false
    };
  }
  return new DraftStore({
    origin: "https://test.invalid",
    worldId: "world-1",
    userId: "user-1",
    canvasId: "shared",
    storage,
    now: clock.now,
    timers: clock
  });
}

function installSessionStorage() {
  globalThis.sessionStorage = new MemoryStorage();
}

function makeHooks() {
  let next = 1;
  const map = new Map();
  return {
    on(name, fn) {
      const id = next;
      next += 1;
      if (!map.has(name)) map.set(name, new Map());
      map.get(name).set(id, fn);
      return id;
    },
    off(name, id) { map.get(name)?.delete(id); },
    callAll(name, ...args) {
      for (const fn of [...(map.get(name)?.values() ?? [])]) fn(...args);
    }
  };
}

async function openEditor({
  body = "# Title\nBody",
  revision = 1,
  layout = "plain",
  skin = SKIN,
  transport = null,
  drafts = null,
  imageDialog = null,
  editorOptions = {},
  note = undefined
} = {}) {
  clearBody();
  installSessionStorage();
  const clock = makeClock();
  const fake = transport ?? new FakeTransport(clock, { body, revision, layout, skin });
  fake.clock = fake.clock ?? clock;
  const draftStore = drafts === null ? makeDrafts(clock) : drafts;
  const editor = new NoteEditor({
    transport: fake,
    drafts: draftStore,
    t,
    now: clock.now,
    imageDialog,
    ...editorOptions
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const result = await editor.open(NOTE_ID, {
    host,
    note: note === undefined
      ? { system: { body, revision, layout, skin, deleted: false } }
      : note
  });
  return { editor, fake, clock, drafts: draftStore, host, result };
}

function clearBody() {
  document.body.replaceChildren();
}

function textareaOf(editor) {
  return editor.element.querySelector(".jn-source-input");
}

function statusText(editor) {
  return editor.element.querySelector(".jn-editor-status-text")?.textContent ?? "";
}

function click(editor, selector) {
  const element = editor.element.querySelector(selector);
  assert.ok(element, `missing ${selector}`);
  element.click();
  return element;
}

function type(editor, value, start = value.length, end = start) {
  const textarea = textareaOf(editor);
  textarea.value = value;
  textarea.selectionStart = start;
  textarea.selectionEnd = end;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return textarea;
}

function keydown(editor, key, extras = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...extras
  });
  textareaOf(editor).dispatchEvent(event);
  return event;
}

function paste(editor, text) {
  const event = new Event("paste", { bubbles: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text }
  });
  textareaOf(editor).dispatchEvent(event);
  return event;
}

test("toolbar order, labels, and the writer row match the specification", async () => {
  const { editor } = await openEditor();
  const toolbar = editor.element.querySelector(".jn-editor-toolbar");
  const order = [...toolbar.children].map(child => (
    child.dataset.action ?? child.querySelector(":scope > .jn-editor-menu-button")?.dataset.action
  )).filter(Boolean);
  assert.deepEqual(order, ["title", "divider", "portrait", "layout", "appearance", "done"]);
  assert.deepEqual(
    ["title", "divider", "portrait", "layout", "appearance", "done"]
      .map(action => toolbar.querySelector(`[data-action="${action}"]`).textContent),
    ["Title", "Divider", "Portrait", "Layout", "Appearance", "Done"]
  );
  assert.ok(toolbar.querySelector(".jn-editor-toolbar-separator"));
  assert.equal(editor.element.querySelector(".jn-editor-writer").textContent, "Editing · You");
});

test("Title handles existing text, an empty marker and an untitled body", async () => {
  let opened = await openEditor({ body: "# Hello\nbody" });
  click(opened.editor, '[data-action="title"]');
  let textarea = textareaOf(opened.editor);
  assert.equal(textarea.value, "# Hello\nbody");
  assert.equal(textarea.selectionStart, 2);
  assert.equal(textarea.selectionEnd, 7);

  opened = await openEditor({ body: "# " });
  click(opened.editor, '[data-action="title"]');
  textarea = textareaOf(opened.editor);
  assert.equal(textarea.value, "# ");
  assert.equal(textarea.selectionStart, 2);

  opened = await openEditor({ body: "body" });
  click(opened.editor, '[data-action="title"]');
  textarea = textareaOf(opened.editor);
  assert.equal(textarea.value, "# \nbody");
  assert.equal(textarea.selectionStart, 2);
  assert.equal(textarea.selectionEnd, 2);
});

test("Divider splits at the caret and becomes a heading underline when appropriate", async () => {
  let opened = await openEditor({ body: "alpha\nbeta" });
  textareaOf(opened.editor).setSelectionRange(3, 3);
  click(opened.editor, '[data-action="divider"]');
  assert.equal(textareaOf(opened.editor).value, "alp\n---\nha\nbeta");

  opened = await openEditor({ body: "# Title" });
  const ta = textareaOf(opened.editor);
  ta.setSelectionRange(ta.value.length, ta.value.length);
  click(opened.editor, '[data-action="divider"]');
  const underlined = textareaOf(opened.editor).value;
  assert.equal(underlined, "# Title\n---");
  assert.ok(parseDocument(underlined).underline, "two lines after the heading parse as an underline");
});

test("Divider refuses code and comment regions without changing the body", async () => {
  let opened = await openEditor({ body: "```\ncode\n```" });
  textareaOf(opened.editor).setSelectionRange(6, 6);
  click(opened.editor, '[data-action="divider"]');
  assert.equal(textareaOf(opened.editor).value, "```\ncode\n```");
  assert.equal(
    opened.editor.element.querySelector(".jn-editor-hint").textContent,
    "Move the cursor outside code or a comment to insert a divider."
  );
  assert.equal(opened.editor.element.querySelector(".jn-editor-hint").hidden, false);

  opened = await openEditor({ body: "<!-- note -->\ntext" });
  textareaOf(opened.editor).setSelectionRange(5, 5);
  click(opened.editor, '[data-action="divider"]');
  assert.equal(textareaOf(opened.editor).value, "<!-- note -->\ntext");
});

test("Portrait inserts standalone, at the Profile slot, and replaces only a valid portrait", async () => {
  const calls = [];
  const imageDialog = options => {
    calls.push(options);
    return {
      src: "worlds/w/x.webp",
      alt: "X",
      markdown: "![X](worlds/w/x.webp)"
    };
  };

  let opened = await openEditor({ body: "text", imageDialog });
  textareaOf(opened.editor).setSelectionRange(4, 4);
  click(opened.editor, '[data-action="portrait"]');
  await settle();
  assert.equal(textareaOf(opened.editor).value, "text\n![X](worlds/w/x.webp)");
  assert.equal(calls.at(-1).mode, "insert");

  opened = await openEditor({
    body: "# Hero\nBody",
    layout: "profile",
    imageDialog
  });
  click(opened.editor, '[data-action="portrait"]');
  await settle();
  assert.equal(
    textareaOf(opened.editor).value,
    "# Hero\n![X](worlds/w/x.webp)\nBody"
  );

  opened = await openEditor({
    body: "# Hero\n![Old](worlds/old.webp)\n\n![Other](worlds/other.webp)\nBody",
    layout: "profile",
    imageDialog
  });
  click(opened.editor, '[data-action="portrait"]');
  await settle();
  assert.equal(calls.at(-1).mode, "replace");
  assert.equal(calls.at(-1).initialSrc, "worlds/old.webp");
  const value = textareaOf(opened.editor).value;
  assert.match(value, /!\[X\]\(worlds\/w\/x\.webp\)/);
  assert.match(value, /!\[Other\]\(worlds\/other\.webp\)/);
  assert.doesNotMatch(value, /Old/);
});

test("Layout menu checks the selected layout and updates the Profile helper", async () => {
  const { editor, fake } = await openEditor({ body: "# Hero\nBody", layout: "plain" });
  click(editor, '[data-action="layout"]');
  const probe = editor.element.querySelector(".jn-editor-layout-menu");
  assert.equal(probe.hidden, false);
  assert.equal(probe.querySelector('[data-value="plain"]').getAttribute("aria-checked"), "true");
  assert.equal(probe.querySelector('[data-value="profile"]').getAttribute("aria-checked"), "false");

  probe.querySelector('[data-value="profile"]').click();
  await settle();
  assert.equal(fake.calls.filter(call => call.name === "appearance").at(-1).args.layout, "profile");
  const helper = editor.element.querySelector(".jn-editor-profile-helper");
  assert.equal(helper.hidden, false);
  assert.equal(
    helper.querySelector(".jn-editor-profile-message").textContent,
    "Profile needs a portrait after the title."
  );

  click(editor, '[data-action="layout"]');
  editor.element.querySelector('.jn-editor-layout-menu [data-value="plain"]').click();
  await settle();
  assert.equal(helper.hidden, true);
});

test("Appearance rows persist paper, font and torn through the session", async () => {
  const { editor, fake } = await openEditor({ body: "# Hero\nBody" });
  click(editor, '[data-action="appearance"]');
  const popover = editor.element.querySelector(".jn-editor-appearance");
  assert.equal(popover.hidden, false);

  popover.querySelector('[data-paper="cream"]').click();
  await settle();
  assert.equal(fake.calls.filter(call => call.name === "appearance").at(-1).args.skin.paper, "cream");

  popover.querySelector('[data-font="serif"]').click();
  await settle();
  assert.equal(fake.calls.filter(call => call.name === "appearance").at(-1).args.skin.font, "serif");

  const torn = popover.querySelector(".jn-editor-torn");
  torn.checked = true;
  torn.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  assert.equal(fake.calls.filter(call => call.name === "appearance").at(-1).args.skin.torn, true);

  popover.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true
  }));
  assert.equal(popover.hidden, true);
});

test("Profile helper shows the first applicable issue, its action and the muted fallback", async () => {
  const cases = [
    {
      body: "Body",
      message: "Profile needs a title on the first line.",
      action: "Add title"
    },
    {
      body: "Body\n# Later",
      message: "Move the title to the first line.",
      action: null
    },
    {
      body: "# Hero\nBody",
      message: "Profile needs a portrait after the title.",
      action: "Insert portrait"
    },
    {
      body: "# Hero\nBody\n![X](x)",
      message: "Move the portrait directly below the title or its divider.",
      action: null
    },
    {
      body: "# Hero\n![broken]",
      message: "Complete the portrait image or choose an image.",
      action: "Choose image"
    }
  ];

  for (const entry of cases) {
    const { editor } = await openEditor({ body: entry.body, layout: "profile" });
    const helper = editor.element.querySelector(".jn-editor-profile-helper");
    assert.equal(helper.hidden, false, entry.body);
    assert.equal(
      helper.querySelector(".jn-editor-profile-message").textContent,
      entry.message,
      entry.body
    );
    assert.equal(
      helper.querySelector(".jn-editor-profile-muted").textContent,
      "Showing Plain until the structure is complete."
    );
    const action = helper.querySelector(".jn-editor-profile-action");
    assert.equal(action.hidden, entry.action === null, entry.body);
    if (entry.action) assert.equal(action.textContent, entry.action);
  }

  const valid = await openEditor({ body: "# Hero\n![X](x)", layout: "profile" });
  assert.equal(valid.editor.element.querySelector(".jn-editor-profile-helper").hidden, true);

  const plain = await openEditor({ body: "# Hero\nBody", layout: "plain" });
  assert.equal(plain.editor.element.querySelector(".jn-editor-profile-helper").hidden, true);
});

test("Profile Add title action inserts the marker and keeps focus on the new title", async () => {
  const { editor } = await openEditor({ body: "Body", layout: "profile" });
  const helper = editor.element.querySelector(".jn-editor-profile-helper");
  assert.equal(helper.hidden, false);
  helper.querySelector(".jn-editor-profile-action").click();
  assert.equal(textareaOf(editor).value, "# \nBody");
  assert.equal(textareaOf(editor).selectionStart, 2);
  // An empty marker is not a usable title yet, so the helper remains until text exists.
  assert.equal(
    helper.querySelector(".jn-editor-profile-message").textContent,
    "Profile needs a title on the first line."
  );

  type(editor, "# Hero\n![X](x)");
  assert.equal(helper.hidden, true);
});

test("Add-title ghost is an overlay for untitled notes and never duplicates an empty marker", async () => {
  let opened = await openEditor({ body: "Text" });
  let ghost = opened.editor.element.querySelector(".jn-editor-add-title");
  assert.equal(ghost.hidden, false);
  assert.equal(ghost.textContent, "Add title…");
  ghost.click();
  assert.equal(textareaOf(opened.editor).value, "# \nText");
  assert.equal(textareaOf(opened.editor).selectionStart, 2);

  opened = await openEditor({ body: "# Title" });
  ghost = opened.editor.element.querySelector(".jn-editor-add-title");
  assert.equal(ghost.hidden, true);

  opened = await openEditor({ body: "# " });
  ghost = opened.editor.element.querySelector(".jn-editor-add-title");
  assert.equal(ghost.hidden, false);
  ghost.click();
  assert.equal(textareaOf(opened.editor).value, "# ");
  assert.equal(textareaOf(opened.editor).selectionStart, 2);
});

test("status shows Opening editor, Saved, Saving and acknowledged save states", async () => {
  clearBody();
  installSessionStorage();
  const clock = makeClock();
  const fake = new FakeTransport(clock, { body: "# Title\nBody" });
  let releaseBegin;
  fake.beginImpl = () => new Promise(resolve => { releaseBegin = resolve; });
  const editor = new NoteEditor({
    transport: fake,
    drafts: makeDrafts(clock),
    t,
    now: clock.now
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const opening = editor.open(NOTE_ID, {
    host,
    note: { system: { body: "# Title\nBody", revision: 1, layout: "plain", skin: SKIN } }
  });
  await settle();
  assert.equal(statusText(editor), "Opening editor…");
  assert.equal(textareaOf(editor).readOnly, true);
  assert.equal(editor.element.querySelector('[data-action="title"]').disabled, true);

  releaseBegin(fake.grant());
  await opening;
  assert.equal(statusText(editor), "Saved");
  assert.equal(textareaOf(editor).readOnly, false);
  assert.equal(editor.element.querySelector('[data-action="title"]').disabled, false);

  let releaseSave;
  fake.saveImpl = args => new Promise(resolve => { releaseSave = () => resolve(fake.ackSave(args)); });
  type(editor, "# Title\nChanged", 14);
  clock.advance(700);
  await settle();
  assert.equal(statusText(editor), "Saving…");
  releaseSave();
  await settle();
  assert.equal(statusText(editor), "Saved");
});

test("offline keeps typing local and never claims a successful local write before it happens", async () => {
  clearBody();
  installSessionStorage();
  const clock = makeClock();
  const fake = new FakeTransport(clock, { body: "# Title\nBody" });
  fake.beginImpl = () => Promise.resolve({ type: "timeout" });
  const editor = new NoteEditor({
    transport: fake,
    drafts: makeDrafts(clock),
    t,
    now: clock.now
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  await editor.open(NOTE_ID, {
    host,
    note: { system: { body: "# Title\nBody", revision: 1, layout: "plain", skin: SKIN } }
  });
  assert.equal(statusText(editor), "Offline");
  assert.equal(textareaOf(editor).readOnly, false);

  type(editor, "# Title\nDraft");
  clock.advance(200);
  await settle();
  assert.equal(statusText(editor), "Offline — saved locally");
});

test("a rejected save keeps the editor open with Retry and Copy text", async () => {
  const { editor, fake, clock } = await openEditor({ body: "# Title\nBody" });
  fake.saveImpl = () => Promise.resolve({
    type: "noteSaveRejected",
    reason: "invalid",
    revision: 1
  });
  type(editor, "# Title\nChanged");
  clock.advance(700);
  await settle();
  assert.equal(statusText(editor), "Couldn’t save. Your draft is kept on this device.");
  assert.ok(editor.element.querySelector('.jn-editor-status-action[data-action="retry"]'));
  assert.ok(editor.element.querySelector('.jn-editor-status-action[data-action="copy"]'));
  assert.equal(editor.isEditing(), true);
});

test("a large paste flushes once and later keystrokes do not force new saves", async () => {
  const { editor, fake, clock } = await openEditor({ body: "# Title\nBody" });
  const pasted = "# Title\n" + "x".repeat(600);
  paste(editor, "x".repeat(600));
  type(editor, pasted);
  await settle();

  let saves = fake.calls.filter(call => call.name === "save");
  assert.equal(saves.length, 1, "the paste flush happens once");
  assert.deepEqual(
    saves[0].args.eventIds.filter(id => id.startsWith("paste-large:")).length,
    1
  );

  type(editor, `${pasted}y`);
  type(editor, `${pasted}yz`);
  await settle();
  saves = fake.calls.filter(call => call.name === "save");
  assert.equal(saves.length, 1, "later keystrokes do not force a save per keystroke");

  clock.advance(700);
  await settle();
  saves = fake.calls.filter(call => call.name === "save");
  assert.equal(saves.length, 2, "normal autosave still happens once");
  assert.deepEqual(saves[1].args.eventIds, []);
});

test("conflict Retry adopts an equal latest body and renders Saved", async () => {
  const { editor, fake, clock } = await openEditor({ body: "# Title\nBody" });
  fake.saveImpl = () => Promise.resolve({
    type: "noteSaveRejected",
    reason: "staleRevision",
    revision: 1
  });
  type(editor, "# Title\nChanged");
  clock.advance(700);
  await settle();
  assert.equal(statusText(editor), "Couldn’t save. Your draft is kept on this device.");
  assert.ok(editor.element.querySelector('.jn-editor-status-action[data-action="retry"]'));

  fake.stateImpl = () => Promise.resolve({
    note: {
      noteId: NOTE_ID,
      revision: 2,
      body: "# Title\nChanged",
      deleted: false
    }
  });
  click(editor, '.jn-editor-status-action[data-action="retry"]');
  await settle();
  assert.equal(statusText(editor), "Saved");
  assert.equal(editor.isEditing(), true);
});

test("conflict Retry keeps local text and shows the conflict hint when latest differs", async () => {
  const { editor, fake, clock } = await openEditor({ body: "# Title\nBody" });
  fake.saveImpl = () => Promise.resolve({
    type: "noteSaveRejected",
    reason: "staleRevision",
    revision: 1
  });
  type(editor, "# Title\nLocal change");
  clock.advance(700);
  await settle();

  fake.stateImpl = () => Promise.resolve({
    note: {
      noteId: NOTE_ID,
      revision: 2,
      body: "# Title\nSomeone else",
      deleted: false
    }
  });
  click(editor, '.jn-editor-status-action[data-action="retry"]');
  await settle();

  assert.equal(textareaOf(editor).value, "# Title\nLocal change");
  assert.equal(
    editor.element.querySelector(".jn-editor-hint").textContent,
    "This note changed while you were editing. Copy your text before reopening or retrying."
  );
  assert.ok(editor.element.querySelector('.jn-editor-status-action[data-action="copy"]'));
  assert.equal(fake.calls.filter(call => call.name === "save").length, 1,
    "no silent overwrite save");
});

test("storage failure never offers recovery and shows the browser-storage status", async () => {
  const { editor } = await openEditor({
    body: "# Title\nBody",
    drafts: makeDrafts(makeClock(), new MemoryStorage(), false)
  });
  assert.equal(statusText(editor), "Recovery copy unavailable in this browser.");
  assert.equal(document.body.querySelector(".jn-recovery"), null);
  assert.ok(editor.element.querySelector('.jn-editor-status-action[data-action="copy"]'));
});

test("forced and lost leases show the required writer copy and keep Close/Copy", async () => {
  let opened = await openEditor();
  let hooks = makeHooks();
  globalThis.Hooks = hooks;
  opened.editor.activate();
  hooks.callAll("journalinatorEditStateChanged", NOTE_ID, { lease: null });
  await settle();
  assert.equal(
    statusText(opened.editor),
    "Editing connection lost. Reopen the note to recover your draft."
  );
  assert.ok(opened.editor.element.querySelector('.jn-editor-status-action[data-action="close"]'));
  assert.ok(opened.editor.element.querySelector('.jn-editor-status-action[data-action="copy"]'));

  opened = await openEditor();
  hooks = makeHooks();
  globalThis.Hooks = hooks;
  opened.editor.activate();
  // The socket emits the mirror clear before the force-unlock hook in the same tick.
  hooks.callAll("journalinatorEditStateChanged", NOTE_ID, { lease: null });
  hooks.callAll("journalinatorNoteForceUnlocked", { noteId: NOTE_ID });
  await settle();
  assert.equal(
    statusText(opened.editor),
    "The GM ended this editing session. Your unsaved text is kept locally."
  );
});

test("Ctrl/Cmd+S flushes without closing; Escape closes after menus", async () => {
  const { editor, fake, clock } = await openEditor({ body: "# Title\nBody" });
  type(editor, "# Title\nChanged");
  const event = keydown(editor, "s", { ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  await settle();
  assert.equal(fake.calls.some(call => call.name === "save"), true);
  assert.equal(fake.calls.some(call => call.name === "end"), false);
  assert.equal(editor.isEditing(), true);

  click(editor, '[data-action="layout"]');
  assert.equal(editor.element.querySelector(".jn-editor-layout-menu").hidden, false);
  keydown(editor, "Escape");
  await settle();
  assert.equal(editor.element.querySelector(".jn-editor-layout-menu").hidden, true);
  assert.equal(editor.isEditing(), true);

  keydown(editor, "Escape");
  await settle();
  assert.equal(fake.calls.some(call => call.name === "end"), true);
  assert.equal(editor.isEditing(), false);
  clock.advance(1000);
});

test("socket transport maps editor-session calls to the T4a commands", async () => {
  const replies = [];
  const writes = [];
  const notesStore = {
    getNote: () => ({ system: { body: "# Stored\nBody", revision: 9 } })
  };
  const transport = createSocketTransport({
    notesStore,
    clientSessionId: "page-session-1",
    requestEditReply: async message => {
      replies.push(message);
      if (message.type === "beginNoteEdit") return { type: "noteEditGranted" };
      if (message.type === "requestNoteEditState") {
        return {
          type: "noteEditState",
          notes: [{ noteId: NOTE_ID, revision: 9, deleted: false }]
        };
      }
      if (message.type === "saveNoteBody") return { type: "noteSaveAck" };
      if (message.type === "endNoteEdit") return { type: "noteEditEnded" };
      return { type: "noteAppearanceAck" };
    },
    requestWrite: message => { writes.push(message); },
    now: () => 1234
  });

  const lease = {
    canvasId: "shared",
    noteId: NOTE_ID,
    userId: "user-1",
    clientSessionId: "page-session-1",
    leaseToken: "token-1",
    gmEpoch: "epoch-1"
  };
  await transport.begin({ noteId: NOTE_ID });
  assert.equal(replies.at(-1).type, "beginNoteEdit");
  assert.equal(replies.at(-1).clientSessionId, "page-session-1");

  transport.preview({ noteId: NOTE_ID, lease, sequence: 1, body: "x" });
  await settle();
  assert.equal(writes.at(-1).type, "previewNoteBody");
  assert.equal(writes.at(-1).body, "x");

  const state = await transport.state({ noteId: NOTE_ID });
  assert.deepEqual(state.note, {
    noteId: NOTE_ID,
    revision: 9,
    body: "# Stored\nBody",
    deleted: false
  });

  await transport.save({
    noteId: NOTE_ID,
    lease,
    sequence: 2,
    baseRevision: 9,
    body: "changed",
    geometry: null,
    eventIds: []
  });
  assert.equal(replies.at(-1).type, "saveNoteBody");
  assert.equal(replies.at(-1).baseRevision, 9);

  await transport.appearance({ noteId: NOTE_ID, lease, layout: "profile", skin: SKIN });
  assert.equal(replies.at(-1).type, "saveNoteAppearance");

  await transport.end({
    noteId: NOTE_ID,
    lease,
    sequence: 3,
    baseRevision: 9,
    geometry: null,
    eventIds: []
  });
  assert.equal(replies.at(-1).type, "endNoteEdit");
  assert.equal(Object.hasOwn(replies.at(-1), "body"), false);
});

test("Done and Escape send one begin/end even when the ended revocation arrives before the ack", async () => {
  for (const how of ["done", "escape", "close"]) {
    const hooks = makeHooks();
    globalThis.Hooks = hooks;
    let begins = 0;
    let ends = 0;
    let requests = 0;
    const clock = makeClock();
    const fake = new FakeTransport(clock);
    const begin = fake.begin.bind(fake);
    fake.begin = args => {
      begins += 1;
      return begin(args);
    };
    fake.endImpl = () => {
      ends += 1;
      // The server broadcasts noteEditRevoked(reason: "ended") before it replies.
      hooks.callAll("journalinatorEditStateChanged", NOTE_ID, { lease: null });
      return Promise.resolve({
        type: "noteEditEnded",
        revision: fake.note.revision,
        released: true
      });
    };
    const { editor } = await openEditor({
      transport: fake,
      editorOptions: { onRequestEdit: () => { requests += 1; } }
    });
    editor.activate();
    try {
      if (how === "done") {
        click(editor, '[data-action="done"]');
        // A second Done while the first close is in flight must not send a second end.
        click(editor, '[data-action="done"]');
      } else if (how === "escape") {
        keydown(editor, "Escape");
      } else {
        void editor.close({ reason: "close" });
      }
      await settle();
      assert.equal(begins, 1, `${how}: exactly one lease was acquired`);
      assert.equal(ends, 1, `${how}: exactly one end was sent`);
      assert.equal(requests, 0, `${how}: the ended revocation never re-opens the editor`);
      assert.equal(editor.isEditing(), false);
      assert.equal(editor.element.querySelector(".jn-source-input"), null);
    } finally {
      editor.deactivate();
      globalThis.Hooks = undefined;
    }
  }
});

test("Done flushes a pending save before releasing the lease", async () => {
  let closed = null;
  const { editor, fake } = await openEditor({
    body: "# Title\nBody",
    editorOptions: { onClose: info => { closed = info; } }
  });
  type(editor, "# Title\nChanged");
  click(editor, '[data-action="done"]');
  await settle();

  const names = fake.calls.map(call => call.name).filter(name => name === "save" || name === "end");
  assert.deepEqual(names, ["save", "end"]);
  assert.equal(editor.isEditing(), false);
  assert.equal(closed?.noteId, NOTE_ID);
  assert.equal(closed?.reason, "done");
});

test("IME composition publishes nothing until compositionend", async () => {
  const { editor, fake, clock } = await openEditor({ body: "# Title\nBody" });
  const textarea = textareaOf(editor);
  textarea.dispatchEvent(new Event("compositionstart"));
  textarea.value = "# Title\nにほん";
  textarea.dispatchEvent(new Event("input"));
  clock.advance(4000);
  await settle();
  assert.equal(fake.calls.some(call => call.name === "preview"), false);
  assert.equal(fake.calls.some(call => call.name === "save"), false);

  textarea.dispatchEvent(new Event("compositionend"));
  clock.advance(800);
  await settle();
  assert.equal(fake.calls.some(call => call.name === "save"), true);
});
