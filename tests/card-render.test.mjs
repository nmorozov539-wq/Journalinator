import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import showdown from "showdown";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost/" });
for (const key of [
  "document", "window", "Node", "HTMLElement", "Event", "KeyboardEvent",
  "MouseEvent", "InputEvent", "Range", "NodeFilter"
]) globalThis[key] = dom.window[key];
globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
globalThis.removeEventListener = dom.window.removeEventListener.bind(dom.window);
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.showdown = showdown;

const { installFoundry, makeContainers, makeUser } = await import("./fake-foundry.mjs");
const gm = makeUser("GM00000000000001", { isGM: true, name: "GM" });
const env = installFoundry({ user: gm, users: [gm] });
await makeContainers(env);
foundry.utils.cleanHTML = html => html;
foundry.applications = { api: { DialogV2: {
  confirm: async () => true, wait: async () => null, prompt: async () => null
} } };

const socket = await import("../scripts/socket.mjs");
socket.registerSocket();
const { notesStore } = await import("../scripts/store/notes-store.mjs");
const { default: JournalCanvas } = await import("../scripts/app/canvas.mjs");
const { resolveSkin, tiltForSkin } = await import("../scripts/skins/registry.mjs");

const BASE_SKIN = {
  paper: "amber",
  font: "default",
  torn: false,
  backgroundImage: null,
  tiltSeed: 0
};

async function createNote({ body = "", layout = "plain", skin = {} } = {}) {
  const reply = await socket.requestEditReply({
    type: "createNote",
    body,
    layout,
    skin: { ...BASE_SKIN, ...skin },
    x: 10,
    y: 20,
    requestEdit: false
  });
  assert.equal(reply.type, "noteCreated");
  return notesStore.getNote(reply.noteId);
}

async function renderNote(fields = {}, { readOnly = false } = {}) {
  const note = await createNote(fields);
  const canvas = new JournalCanvas({ onSelectNote() {} });
  document.body.append(canvas.root);
  canvas.readOnly = readOnly;
  canvas.update([note], notesStore.getLayout());
  const card = canvas.root.querySelector(`.jn-card[data-id="${note._id}"]`);
  assert.ok(card, "card rendered");
  return { note, canvas, card };
}

function cleanup(canvas) {
  canvas.disconnectGeometry();
  canvas.root.remove();
}

test("Plain cards render the body exactly once with or without a title", async () => {
  const untitled = await renderNote({ body: "Just body text" });
  try {
    assert.match(untitled.card.className, /\bjn-card-plain\b/);
    assert.equal(untitled.card.querySelector("h1, .jn-note-title"), null);
    assert.equal(untitled.card.querySelector(".jn-note-body p")?.textContent, "Just body text");
    assert.equal(untitled.card.querySelectorAll(".jn-note-body").length, 1);
  } finally { cleanup(untitled.canvas); }

  const titled = await renderNote({ body: "# Ada\n\nBody text" });
  try {
    assert.match(titled.card.className, /\bjn-card-plain\b/);
    const title = titled.card.querySelector("h1.jn-note-title");
    assert.equal(title?.textContent, "Ada");
    const html = titled.card.querySelector(".jn-note-body").innerHTML;
    assert.ok(html.indexOf("Ada") < html.indexOf("Body text"), "title precedes body");
    assert.equal((html.match(/Ada/g) ?? []).length, 1, "title content appears once");
    assert.equal(titled.card.querySelectorAll("h1").length, 1);
  } finally { cleanup(titled.canvas); }
});

test("later H1s render as H2 and raw title-looking markup never replaces the body", async () => {
  const rendered = await renderNote({ body: "# First\n\n# Second\n\n> # Quoted" });
  try {
    assert.equal(rendered.card.querySelectorAll("h1").length, 1);
    assert.equal(rendered.card.querySelector("h1.jn-note-title")?.textContent, "First");
    const h2 = [...rendered.card.querySelectorAll("h2")].map(node => node.textContent);
    assert.deepEqual(h2, ["Second", "Quoted"]);
  } finally { cleanup(rendered.canvas); }
});

test("Profile renders title, centered portrait, caption and body in source order", async () => {
  const rendered = await renderNote({
    layout: "profile",
    body: "# Ada\n\n![](https://example.com/portrait.png)\n\n## Captain\n\nBody text"
  });
  try {
    assert.match(rendered.card.className, /\bjn-card-profile\b/);
    assert.doesNotMatch(rendered.card.className, /jn-profile-fallback/);
    const html = rendered.card.querySelector(".jn-note-body").innerHTML;
    const title = html.indexOf("Ada");
    const portrait = html.indexOf("portrait.png");
    const caption = html.indexOf("Captain");
    const body = html.indexOf("Body text");
    assert.ok(title >= 0 && title < portrait && portrait < caption && caption < body,
      "title, portrait, caption, body stay in order");
    assert.ok(rendered.card.querySelector("img.jn-profile-portrait"));
    assert.equal(rendered.card.querySelector(".jn-profile-caption")?.textContent, "Captain");
  } finally { cleanup(rendered.canvas); }
});

test("an invalid selected Profile falls back to Plain and keeps all content", async () => {
  const rendered = await renderNote({ layout: "profile", body: "# Ada\n\nBody text" });
  try {
    assert.match(rendered.card.className, /\bjn-card-plain\b/);
    assert.match(rendered.card.className, /\bjn-profile-fallback\b/);
    assert.equal(rendered.card.querySelector("h1.jn-note-title")?.textContent, "Ada");
    assert.equal(rendered.card.querySelector(".jn-note-body p")?.textContent, "Body text");
    assert.equal(rendered.card.querySelector(".jn-profile-caption"), null);
  } finally { cleanup(rendered.canvas); }
});

test("all skins set paper/font/torn/background classes and deterministic rotation", async () => {
  const paperCases = [
    ["cream", "default", "jn-skin-paper-cream"],
    ["amber", "handwritten", "jn-skin-paper-amber"],
    ["parchment", "serif", "jn-skin-paper-parchment"]
  ];
  for (const [paper, font, className] of paperCases) {
    const rendered = await renderNote({ body: "# Skin", skin: { paper, font } });
    try {
      assert.match(rendered.card.className, new RegExp(`\\b${className}\\b`));
      assert.match(rendered.card.className, new RegExp(`\\bjn-skin-font-${font}\\b`));
      assert.ok(rendered.card.style.getPropertyValue("--jn-skin-paper-token"));
      assert.ok(rendered.card.style.getPropertyValue("--jn-skin-bg"));
      const skin = resolveSkin(rendered.note);
      assert.equal(rendered.card.style.getPropertyValue("--jn-note-rotation"),
        `${tiltForSkin(skin)}deg`);
      const first = rendered.card.style.getPropertyValue("--jn-note-rotation");
      rendered.canvas.update([rendered.note], notesStore.getLayout());
      assert.equal(rendered.card.style.getPropertyValue("--jn-note-rotation"), first,
        "rotation is derived from the stable seed, not randomized per render");
    } finally { cleanup(rendered.canvas); }
  }

  const torn = await renderNote({
    body: "Torn",
    skin: { torn: true, backgroundImage: "worlds/test/paper.png" }
  });
  try {
    assert.match(torn.card.className, /\bjn-torn\b/);
    assert.equal(torn.card.style.getPropertyValue("--jn-skin-torn"), "1");
    assert.match(torn.card.style.getPropertyValue("--jn-skin-bg"), /worlds\/test\/paper\.png/);
    assert.ok(torn.card.style.getPropertyValue("--jn-tear").startsWith("polygon("));
  } finally { cleanup(torn.canvas); }
});

test("no removed label/kind/secret/location classes or title zones are produced", async () => {
  const rendered = await renderNote({ body: "Plain content" });
  try {
    for (const removed of [
      "jn-secret", "jn-kind-location", "jn-hint", "jn-card-memo",
      "jn-card-document", "jn-card-wanted", "jn-has-hidden"
    ]) {
      assert.doesNotMatch(rendered.card.className, new RegExp(`\\b${removed}\\b`));
    }
    assert.equal(rendered.card.querySelector(".jn-card-title, .jn-card-wanted-heading, .jn-card-excerpt"), null);
    assert.equal(rendered.card.querySelector(".jn-card-image-button, .jn-card-background"), null);
    assert.equal(rendered.card.querySelector(".jn-note-body").textContent, "Plain content");
  } finally { cleanup(rendered.canvas); }
});

test("empty and image-only notes render body content and alt text", async () => {
  const empty = await renderNote({ body: "" });
  try {
    assert.equal(empty.card.querySelector(".jn-note-body").innerHTML, "");
    assert.ok(empty.card.querySelector(".jn-card-paper"));
  } finally { cleanup(empty.canvas); }

  const image = await renderNote({ body: "![A portrait](https://example.com/a.png)" });
  try {
    const img = image.card.querySelector(".jn-note-body img");
    assert.ok(img);
    assert.equal(img.getAttribute("alt"), "A portrait");
    assert.equal(img.getAttribute("src"), "https://example.com/a.png");
  } finally { cleanup(image.canvas); }
});

test("task checkboxes are interactive for readers and disabled in read-only mode", async () => {
  const interactive = await renderNote({ body: "- [ ] task" });
  try {
    const box = interactive.card.querySelector("input.jn-task-checkbox");
    assert.ok(box);
    assert.equal(box.disabled, false);
  } finally { cleanup(interactive.canvas); }

  const readOnly = await renderNote({ body: "- [ ] task" }, { readOnly: true });
  try {
    assert.equal(readOnly.card.querySelector("input.jn-task-checkbox").disabled, true);
  } finally { cleanup(readOnly.canvas); }
});

test("rendering calls the Foundry sanitizer and polishes links", async () => {
  let calls = 0;
  const original = foundry.utils.cleanHTML;
  foundry.utils.cleanHTML = html => { calls += 1; return original(html); };
  const rendered = await renderNote({ body: "[Journal](https://example.com)" });
  foundry.utils.cleanHTML = original;
  try {
    assert.ok(calls >= 1, "sanitizer received the rendered body");
    const link = rendered.card.querySelector(".jn-note-body a");
    assert.equal(link?.getAttribute("target"), "_blank");
    assert.equal(link?.getAttribute("rel"), "noopener noreferrer");
  } finally { cleanup(rendered.canvas); }
});
