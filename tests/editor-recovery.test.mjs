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

const { default: NoteEditor, getTabSessionId, TAB_SESSION_ID_KEY } =
  await import("../scripts/app/editor.mjs");
const { DraftStore } = await import("../scripts/editor/drafts.mjs");
const { noteBodyHash } = await import("../scripts/editor/session.mjs");
const { classifyDraft } = await import("../scripts/editor/recovery.mjs");

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
  "JN.Profile.CompletePortrait": "Complete the portrait image or choose an image.",
  "JN.Recovery.Title": "Recover unsaved text?",
  "JN.Recovery.DraftFrom": "Draft from {time}",
  "JN.Recovery.NewerSaved": "This note changed since your draft. Recovering it will replace the current text.",
  "JN.Recovery.CurrentSaved": "Current saved text",
  "JN.Recovery.YourDraft": "Your unsaved draft",
  "JN.Recovery.RecoverDraft": "Recover draft",
  "JN.Recovery.ReplaceWithDraft": "Replace with draft",
  "JN.Recovery.CopyText": "Copy text",
  "JN.Recovery.Discard": "Discard",
  "JN.Recovery.MissingNote": "This note no longer exists."
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
    clearTimeout(id) { timers.delete(id); },
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
  constructor(clock, note) {
    this.clock = clock;
    this.note = {
      noteId: NOTE_ID,
      body: note.body ?? "",
      revision: note.revision ?? 0,
      layout: note.layout ?? "plain",
      skin: note.skin ?? { ...SKIN },
      deleted: note.deleted ?? false
    };
    this.calls = [];
    this._token = 0;
  }
  now() { return this.clock.now(); }
  setTimeout(fn, ms) { return this.clock.setTimeout(fn, ms); }
  clearTimeout(id) { this.clock.clearTimeout(id); }
  lease() {
    this._token += 1;
    return {
      canvasId: "shared",
      noteId: NOTE_ID,
      userId: "user-1",
      clientSessionId: "tab-test",
      leaseToken: `lease-${this._token}`,
      gmEpoch: "epoch-1"
    };
  }
  grant() {
    return {
      type: "noteEditGranted",
      lease: this.lease(),
      revision: this.note.revision,
      body: this.note.body,
      layout: this.note.layout,
      skin: this.note.skin,
      deleted: false
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
  begin(args) { this.calls.push({ name: "begin", args }); return Promise.resolve(this.grant()); }
  heartbeat(args) {
    return Promise.resolve({
      type: "noteEditHeartbeatAck",
      leaseToken: args.lease.leaseToken,
      gmEpoch: args.lease.gmEpoch
    });
  }
  preview(args) { this.calls.push({ name: "preview", args }); }
  save(args) {
    this.calls.push({ name: "save", args });
    return Promise.resolve(this.ackSave(args));
  }
  appearance(args) {
    return Promise.resolve({ type: "noteAppearanceAck", layout: args.layout, skin: args.skin });
  }
  end(args) {
    if (args.body !== undefined) this.ackSave(args);
    return Promise.resolve({ type: "noteEditEnded", revision: this.note.revision, released: true });
  }
  state() {
    this.calls.push({ name: "state", args: {} });
    return Promise.resolve({
      note: {
        noteId: NOTE_ID,
        revision: this.note.revision,
        body: this.note.body,
        deleted: this.note.deleted
      }
    });
  }
}

function makeDrafts(clock, storage) {
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

function clearBody() {
  document.body.replaceChildren();
}

async function withDraft({
  note = { body: "# Title\nServer", revision: 1 },
  draft = null,
  draftsOverride = null
} = {}) {
  clearBody();
  const storage = new MemoryStorage();
  globalThis.sessionStorage = storage;
  const sessionId = getTabSessionId(storage);
  assert.equal(storage.getItem(TAB_SESSION_ID_KEY), sessionId);
  const clock = makeClock();
  const drafts = draftsOverride ?? makeDrafts(clock, storage);
  if (draft) {
    const ok = drafts.save(NOTE_ID, sessionId, {
      body: draft.body,
      baseRevision: draft.baseRevision ?? note.revision ?? 0,
      acknowledgedBody: note.body ?? "",
      acknowledgedRevision: note.revision ?? 0,
      at: draft.at ?? clock.now() - 5 * 60 * 1000
    });
    assert.equal(ok, true);
  }
  const fake = new FakeTransport(clock, note);
  const editor = new NoteEditor({
    transport: fake,
    drafts,
    t,
    now: clock.now
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const pending = editor.open(NOTE_ID, {
    host,
    note: {
      system: {
        body: note.body ?? "",
        revision: note.revision ?? 0,
        layout: "plain",
        skin: SKIN,
        deleted: note.deleted ?? false
      }
    }
  });
  return { editor, fake, drafts, clock, sessionId, storage, pending, host };
}

test("identical local text opens silently and removes the unnecessary draft", async () => {
  const env = await withDraft({
    note: { body: "# Title\nBody", revision: 2 },
    draft: { body: "# Title\nBody", baseRevision: 1 }
  });
  const result = await env.pending;
  assert.equal(result.ok, true);
  assert.equal(document.body.querySelector(".jn-recovery"), null);
  assert.equal(env.drafts.load(NOTE_ID, env.sessionId), null);
  assert.equal(env.editor.element.querySelector(".jn-source-input").value, "# Title\nBody");
});

test("Recover draft restores the local text, acquires the lease and saves it", async () => {
  const draftBody = "# Title\nDraft";
  const env = await withDraft({
    note: { body: "# Title\nServer", revision: 1 },
    draft: { body: draftBody, baseRevision: 1, at: 123456 }
  });
  await settle();
  const dialog = document.body.querySelector(".jn-recovery");
  assert.ok(dialog);
  assert.equal(dialog.querySelector(".jn-recovery-title").textContent, "Recover unsaved text?");
  assert.match(dialog.querySelector(".jn-recovery-time").textContent, /^Draft from /);
  assert.equal(dialog.querySelector(".jn-recovery-preview").textContent, draftBody);
  const actions = [...dialog.querySelectorAll(".jn-recovery-action")].map(button => button.dataset.action);
  assert.deepEqual(actions, ["recover", "copy", "discard"]);

  dialog.querySelector('[data-action="recover"]').click();
  const result = await env.pending;
  assert.equal(result.ok, true);
  assert.equal(env.editor.element.querySelector(".jn-source-input").value, draftBody);
  assert.equal(env.editor._session.body, draftBody);
  assert.equal(env.editor._session.confirmedRevision, 1);

  env.clock.advance(800);
  await settle();
  assert.equal(env.fake.note.body, draftBody);
  assert.equal(env.fake.note.revision, 2);
});

test("Discard removes only the draft and opens the confirmed body", async () => {
  const env = await withDraft({
    note: { body: "# Title\nServer", revision: 1 },
    draft: { body: "# Title\nDraft", baseRevision: 1 }
  });
  await settle();
  document.body.querySelector('[data-action="discard"]').click();
  await env.pending;
  assert.equal(env.drafts.load(NOTE_ID, env.sessionId), null);
  assert.equal(env.editor.element.querySelector(".jn-source-input").value, "# Title\nServer");
  env.clock.advance(800);
  await settle();
  assert.equal(env.fake.calls.some(call => call.name === "save"), false);
});

test("Copy text copies the draft and leaves the dialog open", async () => {
  let copied = null;
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async text => { copied = text; } } },
    configurable: true
  });
  const draftBody = "# Title\nCopy me";
  const env = await withDraft({
    note: { body: "# Title\nServer", revision: 1 },
    draft: { body: draftBody, baseRevision: 1 }
  });
  await settle();
  const dialog = document.body.querySelector(".jn-recovery");
  dialog.querySelector('[data-action="copy"]').click();
  await settle();
  assert.equal(copied, draftBody);
  assert.equal(dialog.isConnected, true);
  assert.equal(env.drafts.load(NOTE_ID, env.sessionId).body, draftBody);
  dialog.querySelector('[data-action="discard"]').click();
  await env.pending;
});

test("a newer saved revision shows both panes and refreshes before replacing", async () => {
  const draftBody = "# Title\nMy draft";
  const env = await withDraft({
    note: { body: "# Title\nServer new", revision: 3 },
    draft: { body: draftBody, baseRevision: 1 }
  });
  await settle();
  let dialog = document.body.querySelector(".jn-recovery");
  assert.equal(dialog.dataset.kind, "newer");
  assert.equal(
    dialog.querySelector(".jn-recovery-notice").textContent,
    "This note changed since your draft. Recovering it will replace the current text."
  );
  const panes = [...dialog.querySelectorAll(".jn-recovery-pane")];
  assert.equal(panes.length, 2);
  assert.equal(panes[0].querySelector(".jn-recovery-pane-label").textContent, "Current saved text");
  assert.equal(panes[1].querySelector(".jn-recovery-pane-label").textContent, "Your unsaved draft");
  assert.equal(panes[1].querySelector(".jn-recovery-preview").textContent, draftBody);
  assert.equal(dialog.querySelector('[data-action="recover"]').textContent, "Replace with draft");

  // Someone saves again while the author is deciding.
  env.fake.note.body = "# Title\nServer even newer";
  env.fake.note.revision = 4;
  dialog.querySelector('[data-action="recover"]').click();
  await settle();

  dialog = document.body.querySelector(".jn-recovery");
  assert.ok(dialog, "comparison refreshed instead of overwriting");
  assert.equal(env.fake.note.body, "# Title\nServer even newer");
  assert.match(dialog.querySelector(".jn-recovery-preview").textContent, /Server even newer/);

  dialog.querySelector('[data-action="recover"]').click();
  const result = await env.pending;
  assert.equal(result.ok, true);
  assert.equal(env.editor.element.querySelector(".jn-source-input").value, draftBody);
  assert.equal(env.editor._session.confirmedRevision, 4);

  env.clock.advance(800);
  await settle();
  const save = env.fake.calls.filter(call => call.name === "save").at(-1);
  assert.equal(save.args.baseRevision, 4);
  assert.equal(env.fake.note.body, draftBody);
});

test("a missing or deleted note offers only Copy text and Discard", async () => {
  const env = await withDraft({
    note: { body: "", revision: 0, deleted: true },
    draft: { body: "# Deleted draft", baseRevision: 0 }
  });
  await settle();
  const dialog = document.body.querySelector(".jn-recovery");
  assert.ok(dialog);
  assert.equal(dialog.dataset.kind, "missing");
  const actions = [...dialog.querySelectorAll(".jn-recovery-action")].map(button => button.dataset.action);
  assert.deepEqual(actions, ["copy", "discard"]);
  assert.equal(dialog.querySelector('[data-action="recover"]'), null);

  dialog.querySelector('[data-action="discard"]').click();
  const result = await env.pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing");
  assert.equal(env.drafts.load(NOTE_ID, env.sessionId), null);
  assert.equal(env.editor.isEditing(), false);
});

test("closing recovery with Escape defers and keeps the draft", async () => {
  const env = await withDraft({
    note: { body: "# Title\nServer", revision: 1 },
    draft: { body: "# Title\nDraft", baseRevision: 1 }
  });
  await settle();
  const dialog = document.body.querySelector(".jn-recovery");
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const result = await env.pending;
  assert.equal(result.ok, false);
  assert.equal(result.type, "recovery");
  assert.equal(result.reason, "recoveryDeferred");
  assert.equal(env.drafts.load(NOTE_ID, env.sessionId).body, "# Title\nDraft");
  assert.equal(env.editor.isEditing(), false);
});

test("storage failure skips recovery and reports unavailable local copies", async () => {
  const env = await withDraft({
    note: { body: "# Title\nServer", revision: 1 },
    draftsOverride: {
      isAvailable: () => false,
      load: () => null,
      save: () => false,
      remove: () => false,
      flushPending: () => false
    }
  });
  const result = await env.pending;
  assert.equal(result.ok, true);
  assert.equal(document.body.querySelector(".jn-recovery"), null);
  assert.equal(
    env.editor.element.querySelector(".jn-editor-status-text").textContent,
    "Recovery copy unavailable in this browser."
  );
});

test("classifyDraft labels the recovery states deterministically", () => {
  const draft = { body: "draft", baseRevision: 1 };
  assert.equal(classifyDraft({ draft: null, note: null }).kind, "none");
  assert.equal(classifyDraft({ draft, note: { body: "draft", revision: 1 } }).kind, "identical");
  assert.equal(classifyDraft({ draft, note: { body: "saved", revision: 1 } }).kind, "different");
  assert.equal(classifyDraft({ draft, note: { body: "saved", revision: 2 } }).kind, "newer");
  assert.equal(classifyDraft({ draft, note: { body: "saved", revision: 2 }, exists: false }).kind, "missing");
});
