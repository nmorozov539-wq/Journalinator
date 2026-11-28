import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import showdown from "showdown";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost/" });
for (const key of ["document", "window", "Node", "HTMLElement", "Event", "KeyboardEvent", "MouseEvent"]) {
  globalThis[key] = dom.window[key];
}
globalThis.showdown = showdown;
globalThis.game = { i18n: { lang: "en" }, users: { get: () => null } };
globalThis.foundry = {
  utils: {
    escapeHTML: value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`),
    cleanHTML: html => html
  }
};

const STRINGS = {
  "JN.History.Title": "Note history",
  "JN.History.Current": "Current version",
  "JN.History.Restore": "Restore this version",
  "JN.History.Confirm": "Replace this note’s text with the selected version? The current text will remain in history.",
  "JN.History.ConfirmRestore": "Restore",
  "JN.History.Restored": "Version restored",
  "JN.History.Empty": "No earlier versions yet.",
  "JN.History.CurrentReason": "This is the current version.",
  "JN.History.Locked": "Someone else is editing this note.",
  "JN.History.RestoreFailed": "Couldn't restore this version.",
  "JN.History.By": "Edited by {name}",
  "JN.History.Version": "Version",
  "JN.History.SelectVersion": "Select a version.",
  "JN.Search.EmptyNote": "Empty note",
  "JN.Common.Close": "Close",
  "JN.Common.Cancel": "Cancel"
};
const t = (key, data) => {
  const value = STRINGS[key] ?? key;
  return data ? value.replace(/\{(\w+)\}/g, (_, name) => String(data[name] ?? "")) : value;
};

const userMap = new Map([
  ["Player0000000001", { name: "Alex" }],
  ["Player0000000002", { name: "Blair" }]
]);
const userLookup = { get: id => userMap.get(id) };

const { createHistoryDialog, historyEntries } = await import("../scripts/app/history-dialog.mjs");

const CURRENT_BODY = "# Current\n\nThe current text.";
const OLD_BODY = "# Old\n\nThe old text.";

function makeNote() {
  return {
    _id: "Note000000000001",
    system: {
      body: CURRENT_BODY,
      revision: 4,
      layout: "plain",
      authorId: "Player0000000001",
      updatedAt: Date.UTC(2026, 10, 28, 12),
      createdAt: Date.UTC(2026, 10, 1, 12)
    }
  };
}

function snapshots() {
  return [
    {
      id: "snap-old-1",
      at: Date.UTC(2026, 10, 27, 10),
      authorId: "Player0000000002",
      revision: 3,
      body: OLD_BODY
    },
    {
      id: "snap-current",
      at: Date.UTC(2026, 10, 28, 12),
      authorId: "Player0000000001",
      revision: 4,
      body: CURRENT_BODY
    }
  ];
}

function cleanup(dialog) {
  dialog.close();
}

test("history entries put the distinct current version first and drop duplicate bodies", () => {
  const entries = historyEntries({ note: makeNote(), snapshots: snapshots(), users: userLookup, t });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].current, true);
  assert.equal(entries[0].label, "Current version");
  assert.equal(entries[0].body, CURRENT_BODY);
  assert.equal(entries[1].body, OLD_BODY);
  assert.equal(entries[1].authorName, "Blair");
});

test("dialog renders the list, current version and sanitized selected preview", () => {
  const note = makeNote();
  const dialog = createHistoryDialog({
    noteId: note._id,
    note,
    list: () => snapshots(),
    requestEditReply: async () => ({ type: "timeout" }),
    recordPreRestore: async () => true,
    users: userLookup,
    t
  });
  dialog.open();
  try {
    const panel = dialog.dialog;
    const rows = [...panel.querySelectorAll(".jn-history-entry")];
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /Current version/);
    assert.match(rows[1].textContent, /Blair/);
    assert.equal(panel.querySelector(".jn-history-preview").innerHTML.includes("The current text."), true);
    assert.match(dialog.dialog.style.width, /720px/);
    assert.match(panel.querySelector(".jn-history-list").style.width, /190px/);
    assert.equal(document.querySelector(".jn-history-overlay"), dialog.element);
  } finally {
    cleanup(dialog);
  }
});

test("an empty or title-only version renders an explicit empty preview, never a blank pane", () => {
  const note = makeNote();
  const extra = [
    { id: "snap-title-only", at: Date.UTC(2026, 10, 26, 10), revision: 2, body: "#" },
    { id: "snap-empty", at: Date.UTC(2026, 10, 25, 10), revision: 1, body: "" }
  ];
  const dialog = createHistoryDialog({
    noteId: note._id,
    note,
    list: () => extra,
    requestEditReply: async () => ({ type: "timeout" }),
    recordPreRestore: async () => true,
    users: userLookup,
    t
  });
  dialog.open();
  try {
    assert.match(dialog.dialog.querySelector(".jn-history-preview").textContent, /Current/);
    dialog.select(1);
    assert.match(dialog.dialog.querySelector(".jn-history-preview").textContent, /Empty note/);
    dialog.select(2);
    assert.match(dialog.dialog.querySelector(".jn-history-preview").textContent, /Empty note/);
    assert.ok(dialog.dialog.querySelector(".jn-history-rendered"));
  } finally {
    cleanup(dialog);
  }
});

test("history CSS keeps the list/preview stacked and overflow-safe", () => {
  const css = readFileSync(new URL("../styles/journal.css", import.meta.url), "utf8");
  assert.match(css, /\.jn-history-overlay\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.jn-history-dialog\s*\{[^}]*max-height:\s*calc\(100vh - 32px\)/s);
  assert.match(css, /\.jn-history-body\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.jn-history-list\s*\{[^}]*overflow:\s*auto/s);
  assert.match(css, /\.jn-history-entry\s*\{[^}]*height:\s*auto/s);
  assert.match(css, /\.jn-history-entry\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.jn-history-preview\s*\{[^}]*min-height:\s*180px/s);
  assert.match(css, /\.jn-history-rendered\s*\{[^}]*min-height:\s*140px/s);
});

test("restore is disabled on current or a remote lock, with a visible reason", () => {
  const note = makeNote();
  let locked = false;
  const dialog = createHistoryDialog({
    noteId: note._id,
    note,
    list: () => snapshots(),
    requestEditReply: async () => ({ type: "timeout" }),
    recordPreRestore: async () => true,
    isLocked: () => locked,
    users: userLookup,
    t
  });
  dialog.open();
  try {
    const restore = dialog.dialog.querySelector(".jn-history-restore");
    const reason = dialog.dialog.querySelector(".jn-history-reason");
    assert.equal(restore.disabled, true);
    assert.equal(reason.textContent, "This is the current version.");

    dialog.select(1);
    assert.equal(restore.disabled, false);
    assert.equal(reason.textContent, "");

    locked = true;
    dialog.select(0);
    dialog.select(1);
    assert.equal(restore.disabled, true);
    assert.equal(reason.textContent, "Someone else is editing this note.");
  } finally {
    cleanup(dialog);
  }
});

test("restore confirmation, lease/pre-restore/save/end order and toast", async () => {
  const note = makeNote();
  const calls = [];
  const notifications = [];
  const leases = [];
  let dialog;
  dialog = createHistoryDialog({
    noteId: note._id,
    note,
    list: () => snapshots(),
    clientSessionId: "tab-history",
    requestEditReply: async message => {
      calls.push(message);
      if (message.type === "beginNoteEdit") {
        return { type: "noteEditGranted", lease: { noteId: note._id, leaseToken: "lease-1" }, revision: 4 };
      }
      if (message.type === "saveNoteBody") {
        return { type: "noteSaveAck", revision: 5, sequence: message.sequence };
      }
      if (message.type === "endNoteEdit") {
        return { type: "noteEditEnded", revision: 5, released: true, saved: true };
      }
      return { type: "timeout" };
    },
    recordPreRestore: async (...args) => { leases.push(args); return true; },
    notify: (level, message) => notifications.push([level, message]),
    users: userLookup,
    t
  });
  dialog.open();
  dialog.select(1);
  dialog.dialog.querySelector(".jn-history-restore").click();
  assert.equal(dialog.dialog.querySelector(".jn-history-confirm").hidden, false);
  assert.equal(
    dialog.dialog.querySelector(".jn-history-confirm-text").textContent,
    "Replace this note’s text with the selected version? The current text will remain in history."
  );
  dialog.dialog.querySelector(".jn-history-confirm-restore").click();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(calls.map(message => message.type), ["beginNoteEdit", "saveNoteBody", "endNoteEdit"]);
  assert.equal(calls[0].clientSessionId, "tab-history");
  assert.deepEqual(leases, [[note._id, CURRENT_BODY, 4, "Player0000000001"]]);
  assert.equal(calls[1].body, OLD_BODY);
  assert.equal(calls[1].baseRevision, 4);
  assert.equal(calls[1].sequence, 1);
  assert.equal(calls[1].geometry, null);
  assert.deepEqual(calls[1].eventIds, []);
  assert.deepEqual(notifications, [["info", "Version restored"]]);
  assert.equal(dialog.element.isConnected, false, "a successful restore closes the dialog");
});

test("empty history shows the exact empty state and Escape closes", () => {
  const note = makeNote();
  const dialog = createHistoryDialog({
    noteId: note._id,
    note,
    list: () => [],
    requestEditReply: async () => ({ type: "timeout" }),
    recordPreRestore: async () => true,
    users: userLookup,
    t
  });
  dialog.open();
  try {
    assert.match(dialog.dialog.querySelector(".jn-history-preview").textContent, /No earlier versions yet\./);
    assert.equal(dialog.dialog.querySelectorAll(".jn-history-entry").length, 1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(dialog.element.isConnected, false);
  } finally {
    cleanup(dialog);
  }
});
