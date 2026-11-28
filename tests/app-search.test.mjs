import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost/" });
for (const key of ["document", "window", "Node", "HTMLElement", "Event", "KeyboardEvent", "MouseEvent"]) {
  globalThis[key] = dom.window[key];
}

const { installFoundry, makeContainers, makeUser } = await import("./fake-foundry.mjs");
const gm = makeUser("GM00000000000001", { isGM: true, name: "GM" });
const player = makeUser("Player0000000001", { name: "Alex" });
const env = installFoundry({ user: gm, users: [gm, player] });
await makeContainers(env);
foundry.applications = { api: {
  ApplicationV2: class { constructor() { this.element = null; } render() { return this; } },
  DialogV2: { confirm: async () => true, prompt: async () => null, wait: async () => null }
} };

const STRINGS = {
  "JN.Search.EmptyNote": "Empty note",
  "JN.Search.ImageNote": "Image note",
  "JN.Layout.Plain": "Plain",
  "JN.Layout.Profile": "Profile",
  "JN.Trash.MetadataUnknown": "Deletion details unavailable",
  "JN.Trash.DeletedMeta": "Deleted by {name} · {date}",
  "JN.Trash.DeletedBy": "Deleted by {name}",
  "JN.Trash.DeletedDate": "Deleted {date}",
  "JN.Trash.DeletedByYouAt": "Deleted by you · {date}",
  "JN.Common.Unknown": "Unknown"
};
const baseLocalize = game.i18n.localize;
game.i18n.localize = (key, data) => {
  const value = STRINGS[key] ?? baseLocalize(key, data);
  return data ? value.replace(/\{(\w+)\}/g, (_, name) => String(data[name] ?? "")) : value;
};

const {
  noteFilterKey, noteMatchesFilters, noteMatchesQuery, noteSearchLabel,
  noteSearchExcerpt, noteSecondaryExcerpt
} = await import("../scripts/app/note-search.mjs");
const { trashRowModel } = await import("../scripts/app/journal-app.mjs");

const PAGE_NAME = "jn-note-internal-only";

function note({ id = "n1", body = "", layout = "plain", authorId = player.id, createdAt = 0, updatedAt = 0, deleted = null } = {}) {
  return {
    _id: id,
    id,
    name: PAGE_NAME,
    system: { body, layout, authorId, createdAt, updatedAt, deleted }
  };
}

test("derived labels and excerpts never use the Foundry page name", () => {
  const titled = note({ body: "# Harbor\n\nVisible lighthouse text", authorId: player.id });
  assert.equal(noteSearchLabel(titled), "Harbor");
  assert.equal(noteSearchExcerpt(titled), "Visible lighthouse text");
  assert.equal(noteSecondaryExcerpt(titled), "Visible lighthouse text");
  assert.equal(noteSearchLabel(titled).includes(PAGE_NAME), false);

  const untitled = note({ body: "The fog rolls in over the docks" });
  assert.equal(noteSearchLabel(untitled), "The fog rolls in over the docks");
  assert.equal(noteSecondaryExcerpt(untitled), "", "no duplicate secondary line when it equals the label");

  assert.equal(noteSearchLabel(note({ body: "" })), "Empty note");
  assert.equal(noteSearchLabel(note({ body: "![alt](portrait.png)" })), "Image note");
  assert.equal(noteSearchLabel(note({ body: "<!-- hidden -->" })), "Empty note");
});

test("duplicate derived titles are allowed", () => {
  const first = note({ id: "a", body: "# Same title\n\nfirst body" });
  const second = note({ id: "b", body: "# Same title\n\nsecond body" });
  assert.equal(noteSearchLabel(first), "Same title");
  assert.equal(noteSearchLabel(second), "Same title");
});

test("search matches derived title, visible body and author, never the page name", () => {
  const target = note({ body: "# Harbor\n\nVisible lighthouse text", authorId: player.id });
  assert.equal(noteMatchesQuery(target, "harbor"), true);
  assert.equal(noteMatchesQuery(target, "lighthouse"), true);
  assert.equal(noteMatchesQuery(target, "alex", player.name), true);
  assert.equal(noteMatchesQuery(target, "internal-only"), false);
  assert.equal(noteMatchesQuery(target, "secret"), false);

  const hidden = note({ body: "# Note\n\n<!-- secret phrase -->", authorId: player.id });
  assert.equal(noteMatchesQuery(hidden, "secret phrase"), false);
});

test("layout filters use the stored layout, not the effective Profile fallback", () => {
  const plain = note({ id: "p", body: "# Not a profile", layout: "plain" });
  const profile = note({ id: "r", body: "# Profile title\n\n![portrait](x.png)", layout: "profile" });
  const profileFallback = note({ id: "f", body: "no title", layout: "profile" });
  assert.equal(noteFilterKey(plain), "plain");
  assert.equal(noteFilterKey(profile), "profile");
  assert.equal(noteFilterKey(profileFallback), "profile", "stored selection stays profile even when it renders Plain");

  const all = [plain, profile, profileFallback];
  assert.deepEqual(all.filter(entry => noteMatchesFilters(entry, { layout: null })), all);
  assert.deepEqual(all.filter(entry => noteMatchesFilters(entry, { layout: "plain" })), [plain]);
  assert.deepEqual(all.filter(entry => noteMatchesFilters(entry, { layout: "profile" })), [profile, profileFallback]);
  const authors = new Set([player.id]);
  assert.deepEqual(all.filter(entry => noteMatchesFilters(entry, { layout: null, authorIds: authors })), all);
  const other = note({ id: "o", authorId: "Other00000000001" });
  assert.equal(noteMatchesFilters(other, { authorIds: authors }), false);
});

test("trash rows use derived labels, excerpts and deletion metadata", () => {
  const deleted = note({
    body: "# Harbor\n\nOld body text",
    deleted: { at: Date.UTC(2026, 10, 28, 12), by: gm.id }
  });
  const row = trashRowModel(deleted, { users: game.users, t: game.i18n.localize });
  assert.equal(row.label, "Harbor");
  assert.equal(row.excerpt, "Old body text");
  assert.ok(row.deletedAt > 0);
  assert.match(row.metadata, /Deleted by you/);
  assert.equal(row.metadata.includes(PAGE_NAME), false);
  assert.equal(row.label.includes(PAGE_NAME), false);
});
