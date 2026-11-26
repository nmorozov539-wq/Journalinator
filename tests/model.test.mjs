import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeBlocks, orderOf, declassifyAnchor, makeSecretTitle, stripSecretPrefix, hasSecretPrefix,
  resolveSecretTitle, reconcileVault, emptyVault, randomPrefixCode, normalizeVault,
  normalizeVaultCard, VAULT_DATA_FORMAT
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

test("format 1 vaults deep-normalize to format 2 and drop unknown fields", () => {
  const vault = normalizeVault({
    format: 1,
    rev: 7,
    unknownTopLevel: "discard",
    notes: {
      n1: {
        id: "n1",
        name: "GM-ABCD Lord Vex",
        kind: "location",
        style: "wanted",
        targetHeading: "Wanted",
        image: null,
        blocks: [{ blockId: "b1", text: "secret" }],
        links: [{ id: "l1", targetId: "n2", lineStyle: "dashed", color: "#a393f2", secondaryColor: "url(javascript:alert(1))" }],
        authorId: "gm",
        createdAt: 5,
        updatedAt: 6,
        card: {
          x: 10, y: 20, width: 0, height: 100, rotation: 3,
          ports: ["left", "left"],
          anchors: {
            main: { kind: "main", x: 0.5, y: 0, createdBy: "gm" },
            bad: { kind: "minor", x: 2, y: -1, createdBy: 3 }
          }
        },
        unknownNoteField: "discard"
      }
    },
    hiddenBlocks: {
      p1: { order: ["h1", "h1", 5], blocks: { h1: { text: "hidden" } } }
    },
    hiddenLinks: { p1: [{ id: "hl1", targetId: "n1", lineStyle: "dashed" }] },
    labels: {
      lb: { text: "GM label", x: 1, y: 2, size: 14, color: "#b85347", stamp: "skull", noteId: "n1", corner: "center" },
      bad: { text: "Malicious", x: 0, y: 0, size: 14, color: "url(javascript:alert(1))" }
    }
  });

  assert.equal(vault.format, VAULT_DATA_FORMAT);
  assert.equal(VAULT_DATA_FORMAT, 2);
  assert.equal(vault.rev, 7);
  assert.ok(!Object.hasOwn(vault, "unknownTopLevel"));
  assert.deepEqual(Object.keys(vault), ["format", "rev", "notes", "hiddenBlocks", "hiddenLinks", "labels"]);

  const note = vault.notes.n1;
  assert.equal(note.id, "n1");
  assert.ok(!Object.hasOwn(note, "unknownNoteField"));
  assert.equal(note.label, "Lord Vex", "the GM prefix is not part of the human label");
  assert.equal(note.presentation.nameGenerated, false);
  assert.equal(note.schemaVersion, 1);
  assert.equal(note.presentation.extendedStyle, "target");
  assert.equal(note.presentation.forceExtended, true);
  assert.deepEqual(note.attachment, {
    mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "default"
  });
  assert.deepEqual(note.blocks, [{ blockId: "b1", text: "secret", authorId: "" }]);

  const link = note.links[0];
  assert.equal(link.id, "l1");
  assert.equal(link.color, "link1");
  assert.equal(link.lineStyle, "dashed");
  assert.equal(link.pattern, "interrupted", "old dashed links become interrupted threads");
  assert.equal(link.material, "linen");
  assert.equal(link.thickness, 2.6);
  assert.equal(link.slack, 0.09);
  assert.equal(link.ends, "standard");
  assert.equal(link.secondaryColor, "", "unsafe secondary colors degrade to none");
  assert.equal(link.sourceAnchorId, "");
  assert.deepEqual(link.routeAnchors, []);

  assert.deepEqual(vault.hiddenBlocks.p1.order, ["h1"]);
  assert.deepEqual(vault.hiddenBlocks.p1.blocks.h1, { blockId: "h1", text: "hidden", authorId: "" });
  assert.equal(vault.hiddenLinks.p1[0].pattern, "interrupted");
  assert.deepEqual(vault.hiddenLinks.p1[0].routeAnchors, []);
  assert.equal(vault.hiddenLinks.p1[0].material, "linen");

  assert.equal(vault.labels.lb.stamp, "skull");
  assert.equal(vault.labels.lb.color, "#b85347");
  assert.equal(vault.labels.lb.corner, "bottom-right", "invalid corners fall back");
  assert.equal(vault.labels.bad.color, "", "vault label colors use the bounded stamp palette");

  const card = note.card;
  assert.equal(card.width, null);
  assert.equal(card.height, 100);
  assert.deepEqual(card.ports, ["right"], "invalid port lists fall back to the default");
  assert.deepEqual(card.anchors.main, { kind: "main", x: 0.5, y: 0, createdBy: "gm" });
  assert.equal(card.anchors.bad, undefined, "anchors outside 0..1 are dropped");
});

test("legacy vault links lose shared anchor references on read/import", () => {
  const vault = normalizeVault({
    format: 2,
    notes: {
      secret: {
        id: "secret",
        name: "GM-ABCD Secret",
        blocks: [{ blockId: "b1", text: "secret" }],
        links: [{
          id: "secret-link", targetId: "shared",
          sourceAnchorId: "main", targetAnchorId: "minor-1",
          routeAnchors: [{ noteId: "shared", anchorId: "main" }],
          sourcePoint: { x: 0.1, y: 0 }, targetSide: "left"
        }]
      }
    },
    hiddenLinks: {
      shared: [{
        id: "hidden-link", targetId: "shared-target",
        sourceAnchorId: "main", targetAnchorId: "minor-2",
        routeAnchors: [{ noteId: "shared", anchorId: "main" }],
        sourceSide: "right", targetPoint: { x: 1, y: 0.5 }
      }]
    }
  });

  const secretLink = vault.notes.secret.links[0];
  assert.equal(secretLink.sourceAnchorId, "");
  assert.equal(secretLink.targetAnchorId, "");
  assert.deepEqual(secretLink.routeAnchors, []);
  assert.deepEqual(secretLink.sourcePoint, { x: 0.1, y: 0 },
    "the point fallback is preserved");
  assert.equal(secretLink.targetSide, "left");

  const hidden = vault.hiddenLinks.shared[0];
  assert.equal(hidden.sourceAnchorId, "");
  assert.equal(hidden.targetAnchorId, "");
  assert.deepEqual(hidden.routeAnchors, []);
  assert.equal(hidden.sourceSide, "right", "the side fallback is preserved");
  assert.deepEqual(hidden.targetPoint, { x: 1, y: 0.5 });
});

test("vault notes receive label, presentation and attachment defaults", () => {
  const vault = normalizeVault({
    format: 1,
    notes: {
      a: { id: "a", name: "GM-ABCD Untitled", style: "sticky" },
      b: { id: "b", name: "GM-EFGH Tavern", style: "torn" }
    }
  });
  assert.equal(vault.notes.a.label, "");
  assert.equal(vault.notes.a.presentation.nameGenerated, true);
  assert.equal(vault.notes.a.presentation.extendedStyle, "memo");
  assert.equal(vault.notes.a.presentation.forceExtended, false);
  assert.equal(vault.notes.a.attachment.mainPinEnabled, true);
  assert.deepEqual(vault.notes.a.blocks, []);
  assert.equal(vault.notes.a.card, null);

  assert.equal(vault.notes.b.label, "Tavern");
  assert.equal(vault.notes.b.presentation.extendedStyle, "memo");
  assert.equal(vault.notes.b.presentation.forceExtended, true);
  assert.equal(vault.notes.b.presentation.torn, true);
  assert.equal(vault.notes.b.attachment.pinStyle, "default");
  assert.equal(emptyVault().format, 2);
});

test("legacy vault cards gain a canonical main anchor from their note attachment", () => {
  const vault = normalizeVault({
    format: 1,
    notes: {
      enabled: {
        id: "enabled", name: "GM-ABCD Enabled", style: "sticky", authorId: "gm",
        card: {
          x: 0, y: 0,
          anchors: { minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "gm" } }
        }
      },
      disabled: {
        id: "disabled", name: "GM-EFGH Disabled", style: "sticky",
        attachment: { mainPinEnabled: false }, card: { x: 10, y: 0 }
      },
      existing: {
        id: "existing", name: "GM-IJKL Existing", style: "sticky", authorId: "gm",
        card: {
          x: 20, y: 0,
          anchors: {
            main: { kind: "main", x: 0.9, y: 0.9, createdBy: "gm" },
            minor: { kind: "minor", x: 0.1, y: 0.2, createdBy: "gm" }
          }
        }
      }
    }
  });

  assert.deepEqual(vault.notes.enabled.card.anchors, {
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "gm" },
    main: { kind: "main", x: 0.5, y: 0, createdBy: "gm" }
  });
  assert.deepEqual(vault.notes.disabled.card.anchors, {},
    "a disabled main pin does not gain an anchor");
  assert.deepEqual(vault.notes.existing.card.anchors, {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "gm" },
    minor: { kind: "minor", x: 0.1, y: 0.2, createdBy: "gm" }
  }, "an existing main is canonicalized and valid minors survive");

  // The standalone card normalizer defaults to the conventional main anchor.
  assert.deepEqual(normalizeVaultCard({ x: 0, y: 0 }).anchors, {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "" }
  });
});

test("vault normalization is idempotent", () => {
  const once = normalizeVault({
    format: 1,
    rev: 2,
    notes: {
      n1: {
        id: "n1", name: "GM-ABCD Dossier", style: "document",
        blocks: [{ text: "no id yet" }],
        links: [{ targetId: "n2", label: "thread" }],
        card: { x: 1, y: 2, ports: ["top"], anchors: { main: { x: 0.5, y: 0 } } }
      }
    },
    hiddenBlocks: { p1: { order: [], blocks: { h1: { text: "hidden" } } } },
    hiddenLinks: { p1: [{ targetId: "n1" }] },
    labels: { lb: { text: "label" } }
  });
  assert.equal(once.format, 2);
  assert.ok(once.notes.n1.blocks[0].blockId);
  assert.ok(once.notes.n1.links[0].id);
  assert.deepEqual(normalizeVault(structuredClone(once)), once);
});
