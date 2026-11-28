import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost/" });
for (const key of ["document", "window", "Node", "HTMLElement", "Event", "KeyboardEvent", "MouseEvent"]) {
  globalThis[key] = dom.window[key];
}

const { CREATION_CHOICES, buildCreationPayload, createNoteFromMenu, openCreationMenu, getCreationChoice } =
  await import("../scripts/app/creation-menu.mjs");
const { createNoteFromTemplate } = await import("../scripts/templates.mjs");

const t = (key, data) => {
  const strings = {
    "JN.Creation.MenuTitle": "Create note",
    "JN.Template.Blank": "Blank",
    "JN.Template.BlankHint": "Start with an empty scrap",
    "JN.Template.Document": "Document",
    "JN.Template.DocumentHint": "Start with a title",
    "JN.Template.Profile": "Profile",
    "JN.Template.ProfileHint": "Start with a title and portrait"
  };
  const value = strings[key] ?? key;
  return data ? value.replace(/\{(\w+)\}/g, (_, name) => String(data[name] ?? "")) : value;
};

test("the three templates carry the exact initial body, layout, skin and focus", () => {
  assert.deepEqual(CREATION_CHOICES.map(choice => choice.id), ["blank", "document", "profile"]);
  const blank = getCreationChoice("blank");
  assert.equal(blank.body, "");
  assert.equal(blank.layout, "plain");
  assert.equal(blank.skin.paper, "amber");
  assert.equal(blank.focus, "body-start");

  const document = getCreationChoice("document");
  assert.equal(document.body, "# ");
  assert.equal(document.layout, "plain");
  assert.equal(document.skin.paper, "cream");
  assert.equal(document.focus, "after-title-marker");

  const profile = getCreationChoice("profile");
  assert.equal(profile.body, "# ");
  assert.equal(profile.layout, "profile");
  assert.equal(profile.skin.paper, "parchment");
  assert.equal(profile.focus, "after-title-marker");
  assert.equal(profile.skin.font, "serif");
});

test("Enter activates the first choice and Escape closes without creating", () => {
  const chosen = [];
  const first = openCreationMenu({ clientX: 20, clientY: 30, onChoose: id => chosen.push(id), t });
  const items = [...first.element.querySelectorAll(".jn-creation-choice")];
  assert.equal(items.length, 3);
  assert.equal(document.activeElement, items[0], "first choice is focused");
  items[0].dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", bubbles: true, cancelable: true
  }));
  assert.deepEqual(chosen, ["blank"]);
  assert.equal(first.element.isConnected, false);

  const second = openCreationMenu({ clientX: 20, clientY: 30, onChoose: id => chosen.push(id), t });
  second.element.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", bubbles: true, cancelable: true
  }));
  assert.equal(second.element.isConnected, false);
  assert.deepEqual(chosen, ["blank"], "Escape creates nothing");
});

test("clicking a menu choice reports that template", () => {
  const chosen = [];
  const menu = openCreationMenu({ clientX: 10, clientY: 10, onChoose: id => chosen.push(id), t });
  menu.element.querySelector('[data-template="document"]').click();
  assert.deepEqual(chosen, ["document"]);
  assert.equal(menu.element.isConnected, false);
});

test("creation payload is one requestEdit createNote message", () => {
  for (const id of ["blank", "document", "profile"]) {
    const choice = getCreationChoice(id);
    const payload = buildCreationPayload(id, { x: 12, y: 34, clientSessionId: "tab-1" });
    assert.equal(payload.type, "createNote");
    assert.equal(payload.body, choice.body);
    assert.equal(payload.layout, choice.layout);
    assert.deepEqual(payload.skin, choice.skin);
    assert.equal(payload.x, 12);
    assert.equal(payload.y, 34);
    assert.equal(payload.requestEdit, true);
    assert.equal(payload.clientSessionId, "tab-1");
    assert.equal("title" in payload, false, "no separate name is sent");
  }
});

test("a successful reply mounts the returned note and keeps the template focus", async () => {
  const requests = [];
  const created = [];
  const result = await createNoteFromMenu({
    templateId: "profile",
    x: 40,
    y: 50,
    clientSessionId: "tab-9",
    requestEditReply: async message => {
      requests.push(message);
      return {
        type: "noteCreated",
        noteId: "Note000000000009",
        revision: 0,
        body: "# ",
        layout: "profile",
        skin: { paper: "parchment", font: "serif", torn: false, backgroundImage: null, tiltSeed: 1 }
      };
    },
    onCreated: value => created.push(value)
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "createNote");
  assert.equal(requests[0].requestEdit, true);
  assert.equal(requests[0].clientSessionId, "tab-9");
  assert.equal(result.ok, true);
  assert.equal(result.focus, "after-title-marker");
  assert.equal(created.length, 1);
  assert.equal(created[0].note.noteId, "Note000000000009");
});

test("a rejected creation leaves no card and never reports success", async () => {
  document.body.innerHTML = "";
  const created = [];
  const result = await createNoteFromMenu({
    templateId: "blank",
    x: 1,
    y: 2,
    clientSessionId: "tab-fail",
    requestEditReply: async () => ({ type: "noteCreateRejected", reason: "invalid" }),
    onCreated: value => created.push(value)
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
  assert.equal(created.length, 0);
  assert.equal(document.querySelector(".jn-card"), null);
});

test("duplicate titles are allowed and produce identical heading source", () => {
  const first = createNoteFromTemplate("document", { title: "Same Title" });
  const second = createNoteFromTemplate("document", { title: "Same Title" });
  assert.equal(first.body, "# Same Title");
  assert.equal(second.body, first.body);
  assert.equal(first.layout, "plain");
});
