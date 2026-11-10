import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeBlocks, orderOf, declassifyAnchor, makeSecretTitle, stripSecretPrefix, hasSecretPrefix,
  resolveSecretTitle, reconcileVault, emptyVault, randomPrefixCode
} from "../scripts/secrets/model.mjs";

const b = id => ({ blockId: id, text: id });
const ids = list => list.map(x => (x.hidden ? `(${x.blockId})` : x.blockId)).join(" ");

test("hidden blocks keep their place", () => {
  const entry = { order: ["A", "H", "B"], blocks: { H: { text: "secret" } } };
  assert.equal(ids(mergeBlocks([b("A"), b("B")], entry)), "A (H) B");
});

test("player split of the block before a hidden block keeps it before its successor", () => {
  const entry = { order: ["A", "H", "B"], blocks: { H: {} } };
  assert.equal(ids(mergeBlocks([b("A"), b("A2"), b("B")], entry)), "A A2 (H) B");
});

test("hidden block at the end stays at the end after player appends", () => {
  const entry = { order: ["A", "H"], blocks: { H: {} } };
  assert.equal(ids(mergeBlocks([b("A"), b("C")], entry)), "A C (H)");
});

test("deleted successor falls through to the next survivor", () => {
  const entry = { order: ["A", "H", "B", "C"], blocks: { H: {} } };
  assert.equal(ids(mergeBlocks([b("A"), b("C")], entry)), "A (H) C");
});

test("consecutive hidden blocks keep their relative order; unknown ones append", () => {
  const entry = { order: ["H1", "H2", "A"], blocks: { H1: {}, H2: {}, H3: {} } };
  const merged = mergeBlocks([b("A")], entry);
  assert.equal(ids(merged), "(H1) (H2) A (H3)");
  assert.deepEqual(orderOf(merged), ["H1", "H2", "A", "H3"]);
});

test("declassify anchor is the next shared block or the end", () => {
  const merged = mergeBlocks([b("A"), b("B")], { order: ["A", "H1", "H2", "B"], blocks: { H1: {}, H2: {} } });
  assert.equal(declassifyAnchor(merged, "H1"), "B");
  assert.equal(declassifyAnchor(merged, "H2"), "B");
  const end = mergeBlocks([b("A")], { order: ["A", "H"], blocks: { H: {} } });
  assert.equal(declassifyAnchor(end, "H"), null);
});

test("secret titles get and keep a GM prefix", () => {
  const t = makeSecretTitle("Lord Vex", null, "7KQ2");
  assert.equal(t, "GM-7KQ2 Lord Vex");
  assert.ok(hasSecretPrefix(t));
  assert.equal(stripSecretPrefix(t), "Lord Vex");
  assert.equal(makeSecretTitle("Lady Vex", t), "GM-7KQ2 Lady Vex");
  assert.equal(makeSecretTitle("GM-7KQ2 Again", null, "AAAA"), "GM-AAAA Again");
  assert.match(randomPrefixCode(), /^[A-Z2-9]{4}$/);
});

test("secret wikilinks prefer secret notes, with or without prefix, then shared", () => {
  const secretNotes = { s1: { id: "s1", name: "GM-AAAA Lord Vex" } };
  const sharedNotes = [{ id: "p1", name: "Lord Vex" }, { id: "p2", name: "Tavern" }, { id: "p3", name: "Gone", deleted: true }];
  assert.equal(resolveSecretTitle("lord vex", { secretNotes, sharedNotes }).id, "s1");
  assert.equal(resolveSecretTitle("GM-AAAA Lord Vex", { secretNotes, sharedNotes }).id, "s1");
  assert.equal(resolveSecretTitle("Tavern", { secretNotes, sharedNotes }).id, "p2");
  assert.equal(resolveSecretTitle("Gone", { secretNotes, sharedNotes }), null);
});

test("reconcile finishes interrupted declassification and drops orphans", () => {
  const vault = emptyVault();
  vault.notes.n1 = { id: "n1" };
  vault.notes.n2 = { id: "n2" };
  vault.hiddenBlocks.p1 = { order: [], blocks: { h1: {}, h2: {} } };
  vault.hiddenBlocks.gone = { order: [], blocks: { h3: {} } };
  vault.hiddenLinks.p1 = [{ id: "l1" }];
  vault.hiddenLinks.gone = [{ id: "l2" }];
  const shared = { notes: new Map([
    ["n1", { blockIds: new Set(), deleted: false }],
    ["p1", { blockIds: new Set(["h1"]), deleted: false }]
  ]) };
  assert.equal(reconcileVault(vault, shared), true);
  assert.deepEqual(Object.keys(vault.notes), ["n2"]);
  assert.deepEqual(Object.keys(vault.hiddenBlocks.p1.blocks), ["h2"]);
  assert.equal(vault.hiddenBlocks.gone, undefined);
  assert.deepEqual(Object.keys(vault.hiddenLinks), ["p1"]);
  assert.equal(reconcileVault(vault, shared), false);
});

test("reconcile touches nothing when the shared journal is unavailable", () => {
  const vault = emptyVault();
  vault.notes.n1 = { id: "n1" };
  vault.hiddenBlocks.p1 = { order: [], blocks: { h1: {} } };
  vault.hiddenLinks.p1 = [{ id: "l1", targetId: "p2" }];
  assert.equal(reconcileVault(vault, null), false);
  assert.deepEqual(Object.keys(vault.notes), ["n1"]);
  assert.deepEqual(Object.keys(vault.hiddenBlocks), ["p1"]);
  assert.deepEqual(Object.keys(vault.hiddenBlocks.p1.blocks), ["h1"]);
  assert.deepEqual(Object.keys(vault.hiddenLinks), ["p1"]);
  assert.deepEqual(vault.hiddenLinks.p1.map(l => l.id), ["l1"]);
});
