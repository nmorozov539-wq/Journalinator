import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";

const gm = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const first = makeUser("Player000000001", { name: "First" });
const second = makeUser("Player000000002", { name: "Second" });
const third = makeUser("Player000000003", { name: "Third" });
const extraUsers = [
  makeUser("Player000000031", { name: "Pending Recipient" }),
  makeUser("Player000000033", { name: "Retry Recipient" }),
  makeUser("Player000000035", { name: "Receipt Recipient" }),
  makeUser("Player000000036", { name: "Duplicate Recipient" }),
  makeUser("Player000000038", { name: "Raced Recipient" }),
  makeUser("Player000000039", { name: "Race Failure Recipient" })
];
const env = installFoundry({ user: gm, users: [gm, first, second, third, ...extraUsers] });
const containers = await makeContainers(env);
const {
  privateStore, emptyWorkspace, normalizeWorkspace, MAX_PENDING_TRANSFERS, MAX_TRANSFER_STORAGE,
  MAX_ACCEPTED_TRANSFERS, MAX_PENDING_PER_SENDER, TRANSFER_TTL_MS, partitionExpiredTransfers
} = await import("../scripts/store/private-store.mjs");
const {
  buildPrivateTransfer, importPrivateTransfer, findFreeSpot, rotatedCardBounds, defaultCardSize,
  countTransferDrops, MAX_TRANSFER_NOTES, MAX_TRANSFER_TEXT, MAX_TRANSFER_LABELS
} = await import("../scripts/private-transfer.mjs");

test("creates one active workspace per profile", async () => {
  const page = await privateStore.createFor(first);
  assert.equal(page.type, "text", "uses a core page type so stale manifests can still create it");
  assert.ok(privateStore.flags(page).workspace, "workspace payload is stored in flags");
  assert.equal(privateStore.findActive(first.id)?.id, page.id);
  assert.equal(privateStore.flags(page).state, "active");
  assert.equal(privateStore.flags(page).ownerUserId, first.id);
  assert.equal(page.ownership[first.id], CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
  assert.equal(page.name, "First — Private");
  assert.deepEqual(privateStore.read(page), emptyWorkspace());
  assert.equal((await privateStore.createFor(first)).id, page.id, "does not create a duplicate");
});

test("workspace names are unique and renameable", async () => {
  const page = privateStore.findActive(first.id);
  await privateStore.rename(page, "Field notes");
  assert.equal(page.name, "Field notes");
  await assert.rejects(privateStore.rename(page, ""), /empty/);
  const secondPage = await privateStore.createFor(second);
  await assert.rejects(privateStore.rename(secondPage, "field notes"), /already/);
});

test("a detached workspace can be assigned and accepted by another player", async () => {
  const page = privateStore.findActive(first.id);
  await privateStore.detach(page);
  assert.equal(privateStore.flags(page).state, "orphaned");
  assert.equal(privateStore.findActive(first.id), null);

  await privateStore.assign(page, third.id);
  assert.equal(privateStore.findPending(third.id)?.id, page.id);
  assert.equal(privateStore.findActive(third.id), null);

  await privateStore.accept(page, third.id);
  assert.equal(privateStore.findActive(third.id)?.id, page.id);
  assert.equal(privateStore.findPending(third.id), null);
  assert.equal(page.ownership[third.id], CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
});

test("a player with a workspace cannot be assigned another", async () => {
  const page = privateStore.findActive(second.id);
  await privateStore.detach(page);
  await privateStore.createFor(second);
  await assert.rejects(privateStore.assign(page, second.id), /already/);
});

test("saving increments the revision and rejects a stale writer", async () => {
  const page = privateStore.findActive(second.id);
  const data = privateStore.read(page);
  data.notes.note = {
    id: "note", title: "Note", kind: "note", style: "sticky", targetHeading: "",
    image: null, backgroundImage: null,
    blocks: [{ blockId: "block", text: "hello" }], createdAt: 1, updatedAt: 1
  };
  const firstSave = await privateStore.save(page, data, 0);
  assert.equal(firstSave.rev, 1);
  await assert.rejects(privateStore.save(page, data, 0), /another session/);
  assert.equal(privateStore.read(page).notes.note.blocks[0].text, "hello");
});

test("deleting a workspace removes it from active use", async () => {
  const page = privateStore.findActive(second.id);
  await privateStore.remove(page);
  assert.equal(privateStore.findById(page.id), null);
  assert.ok(containers.private);
});

test("a deleted player's workspace is kept and becomes orphaned", async () => {
  const orphan = makeUser("Player000000004", { name: "Orphan" });
  const page = await privateStore.createFor(orphan);
  assert.equal(await privateStore.orphanUser(orphan.id), 1);
  assert.equal(privateStore.flags(page).state, "orphaned");
  assert.equal(privateStore.flags(page).ownerUserId, null);
  assert.ok(privateStore.findById(page.id), "workspace data is not deleted");
});

const legacyNote = (id, title, style, extra = {}) => ({
  id, title, kind: "note", style, targetHeading: "",
  image: null, backgroundImage: null,
  blocks: [{ blockId: `block-${id}`, text: "hello" }],
  links: [], createdAt: 1, updatedAt: 1, ...extra
});

test("format 1 workspaces read as format 2 in memory and save as format 2", async () => {
  const user = makeUser("Player000000005", { name: "Format" });
  const page = await privateStore.createFor(user);
  const legacy = {
    format: 1,
    notes: { legacy: legacyNote("legacy", "New note", "sticky") },
    layout: {
      cards: { legacy: { x: 4, y: 8, width: 200, height: 90, rotation: 2, ports: ["left", "top"] } },
      labels: {}, viewport: { x: 5, y: 6, zoom: 2 }
    },
    trash: []
  };
  privateStore.flags(page).workspace = JSON.stringify(legacy);

  const read = privateStore.read(page);
  assert.equal(read.format, 2);
  assert.equal(read.notes.legacy.label, "");
  assert.equal(read.notes.legacy.presentation.nameGenerated, true);
  assert.deepEqual(read.layout.cards.legacy.ports, ["left", "top"], "ports survive a read");
  assert.deepEqual(read.layout.viewport, { x: 5, y: 6, zoom: 2 });
  assert.equal(privateStore.flags(page).workspace, JSON.stringify(legacy),
    "reading normalizes in memory without rewriting the stored workspace");

  const saved = await privateStore.save(page, read, privateStore.flags(page).rev);
  assert.equal(saved.workspace.format, 2);
  assert.equal(JSON.parse(privateStore.flags(page).workspace).format, 2, "saving writes format 2");
});

test("legacy private styles map to presentation and meaningful titles become labels", () => {
  const workspace = normalizeWorkspace({
    format: 1,
    notes: {
      sticky: legacyNote("sticky", "A real title", "sticky"),
      memo: legacyNote("memo", "New note", "memo"),
      document: legacyNote("document", "Ledger", "document"),
      wanted: legacyNote("wanted", "Wanted: Vex", "wanted"),
      torn: legacyNote("torn", "Torn page", "torn")
    },
    layout: { cards: {}, labels: {}, viewport: null },
    trash: []
  });

  assert.equal(workspace.notes.sticky.label, "A real title");
  assert.equal(workspace.notes.sticky.presentation.nameGenerated, false);
  assert.equal(workspace.notes.sticky.presentation.extendedStyle, "memo");
  assert.equal(workspace.notes.sticky.presentation.forceExtended, false);

  assert.equal(workspace.notes.memo.label, "", "generated placeholder titles are not labels");
  assert.equal(workspace.notes.memo.presentation.nameGenerated, true);
  assert.equal(workspace.notes.memo.presentation.forceExtended, true);

  assert.equal(workspace.notes.document.presentation.extendedStyle, "document");
  assert.equal(workspace.notes.wanted.presentation.extendedStyle, "target");
  assert.equal(workspace.notes.torn.presentation.extendedStyle, "memo");
  assert.equal(workspace.notes.torn.presentation.torn, true);
  for (const note of Object.values(workspace.notes)) {
    assert.equal(note.schemaVersion, 1);
    assert.equal(note.attachment.mainPinEnabled, true);
    assert.equal(note.attachment.mainSnapRadius, 24);
    assert.equal(note.attachment.minorSnapRadius, 6);
    assert.equal(note.attachment.pinStyle, "default");
  }
});

test("legacy private cards gain a canonical main anchor from their note attachment", () => {
  const workspace = normalizeWorkspace({
    format: 1,
    notes: {
      enabled: legacyNote("enabled", "Enabled", "sticky"),
      disabled: legacyNote("disabled", "Disabled", "sticky", {
        attachment: { mainPinEnabled: false }
      })
    },
    layout: {
      cards: {
        enabled: {
          x: 0, y: 0,
          anchors: { minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" } }
        },
        disabled: { x: 10, y: 0 },
        orphan: { x: 20, y: 0 }
      },
      labels: {},
      viewport: null
    },
    trash: [
      { note: legacyNote("trashed", "Trashed", "sticky"), card: { x: 0, y: 0 }, deletedAt: 1 },
      { card: { x: 0, y: 0 }, deletedAt: 2 }
    ]
  });

  assert.deepEqual(workspace.layout.cards.enabled.anchors, {
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" },
    main: { kind: "main", x: 0.5, y: 0, createdBy: "" }
  });
  assert.deepEqual(workspace.layout.cards.disabled.anchors, {},
    "a disabled main pin does not gain an anchor");
  assert.deepEqual(workspace.layout.cards.orphan.anchors, {},
    "a card without a note does not invent a main anchor");
  assert.deepEqual(workspace.trash[0].card.anchors, {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "" }
  }, "a trash card with its note follows that note's attachment");
  assert.deepEqual(workspace.trash[1].card.anchors, {},
    "a trash card without its note does not invent a main anchor");
});

test("new note fields, anchors, ports and link cosmetics survive a workspace roundtrip", () => {
  const input = {
    format: 2,
    notes: {
      note: legacyNote("note", "Roundtrip", "memo", {
        label: "Readable label",
        schemaVersion: 1,
        presentation: {
          extendedStyle: "document", forceExtended: true, font: "hand",
          pictureLayout: "left", torn: true, heading: "Heading", nameGenerated: false
        },
        attachment: {
          mainPinEnabled: false, mainSnapRadius: 99, minorSnapRadius: 2, pinStyle: "brass"
        },
        links: [{
          id: "link", targetId: "other", label: "thread", direction: "one",
          color: "#a393f2", lineStyle: "dashed",
          sourceSide: "left", targetSide: "right",
          sourcePoint: { x: 0.1, y: 0.2 }, targetPoint: { x: 0.8, y: 0.9 },
          pins: [{ x: 5, y: 6 }],
          sourceAnchorId: "main", targetAnchorId: "minor-1",
          routeAnchors: [{ noteId: "other", anchorId: "main" }],
          material: "double", thickness: 9, slack: 2,
          pattern: "alternating", ends: "loose", secondaryColor: "link3"
        }]
      })
    },
    layout: {
      cards: {
        note: {
          x: 1, y: 2, width: 300, height: 100, rotation: 4,
          ports: ["left", "top"],
          anchors: {
            main: { kind: "main", x: 0.5, y: 0, createdBy: "user" },
            minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "user" },
            broken: { kind: "minor", x: "nope", y: 0 }
          }
        }
      },
      labels: {},
      viewport: { x: 1, y: 2, zoom: 3 }
    },
    trash: []
  };

  const workspace = normalizeWorkspace(input);
  const note = workspace.notes.note;
  assert.equal(note.label, "Readable label");
  assert.equal(note.schemaVersion, 1);
  assert.deepEqual(note.presentation, input.notes.note.presentation);
  assert.deepEqual(note.attachment, {
    mainPinEnabled: false, mainSnapRadius: 64, minorSnapRadius: 2, pinStyle: "brass"
  });

  const link = note.links[0];
  assert.equal(link.id, "link");
  assert.equal(link.color, "link1", "legacy hex colors normalize to a slot");
  assert.equal(link.lineStyle, "dashed");
  assert.equal(link.material, "double");
  assert.equal(link.thickness, 5, "thickness is clamped to the supported range");
  assert.equal(link.slack, 0.25, "slack is clamped to the supported range");
  assert.equal(link.pattern, "alternating");
  assert.equal(link.ends, "loose");
  assert.equal(link.secondaryColor, "link3");
  assert.equal(link.sourceAnchorId, "main");
  assert.equal(link.targetAnchorId, "minor-1");
  assert.deepEqual(link.routeAnchors, [{ noteId: "other", anchorId: "main" }]);
  assert.deepEqual(link.pins, [{ x: 5, y: 6 }]);

  const card = workspace.layout.cards.note;
  assert.deepEqual(card.ports, ["left", "top"]);
  assert.deepEqual(card.anchors, {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "user" },
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "user" }
  });
  assert.deepEqual(workspace.layout.viewport, { x: 1, y: 2, zoom: 3 });
  assert.deepEqual(normalizeWorkspace(workspace), workspace, "normalization is idempotent");
});

test("private normalization rejects unsafe link and label colors and bounds anchors", () => {
  const workspace = normalizeWorkspace({
    format: 2,
    notes: {
      note: legacyNote("note", "Unsafe", "memo", {
        links: [{ id: "bad", targetId: "other", secondaryColor: "url(javascript:alert(1))" }]
      })
    },
    layout: {
      cards: {
        note: {
          x: 0, y: 0,
          anchors: {
            main: { kind: "main", x: 0.9, y: 0.9, createdBy: "u" },
            minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" },
            bad: { kind: "other", x: 0.1, y: 0.1 },
            ["x".repeat(101)]: { kind: "minor", x: 0.1, y: 0.1 }
          }
        }
      },
      labels: { bad: { text: "Label", x: 0, y: 0, size: 14, color: "javascript:alert(1)" } },
      viewport: null
    },
    trash: []
  });
  assert.equal(workspace.notes.note.links[0].secondaryColor, "");
  assert.equal(workspace.layout.labels.bad.color, "");
  assert.deepEqual(workspace.layout.cards.note.anchors, {
    main: { kind: "main", x: 0.5, y: 0, createdBy: "u" },
    minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "u" }
  });
});

test("private anchor normalization uses the shared cap and rejects hostile ids", () => {
  const anchors = JSON.parse(`{
    "constructor": {"kind":"minor","x":0.1,"y":0.1},
    "__proto__": {"kind":"minor","x":0.1,"y":0.1},
    "a.b": {"kind":"minor","x":0.1,"y":0.1},
    "legacyMain": {"kind":"main","x":0.9,"y":0.9,"createdBy":"u"},
    "safe": {"kind":"minor","x":0.2,"y":0.3,"createdBy":"u"}
  }`);
  for (let i = 0; i < 300; i++) anchors[`m${i}`] = { kind: "minor", x: 0.5, y: 0.5 };
  const workspace = normalizeWorkspace({
    format: 2,
    notes: { note: legacyNote("note", "Capped", "memo") },
    layout: { cards: { note: { x: 0, y: 0, anchors } }, labels: {}, viewport: null },
    trash: []
  });
  const clean = workspace.layout.cards.note.anchors;
  assert.equal(Object.keys(clean).length, 256, "the shared 256-anchor cap applies");
  assert.ok(clean.main, "the legacy main folded to the canonical key");
  assert.equal(clean.main.x, 0.5);
  assert.equal(clean.main.y, 0);
  assert.equal(Object.hasOwn(clean, "constructor"), false);
  assert.equal(Object.hasOwn(clean, "a.b"), false);
  assert.equal(Object.hasOwn(clean, "__proto__"), false);
});

test("the private editor routes main-pin changes through the workspace guard", async () => {
  globalThis.foundry.applications = { api: { DialogV2: {} } };
  const { default: PrivateNoteEditor } = await import("../scripts/app/private-editor.mjs");
  const editor = Object.create(PrivateNoteEditor.prototype);
  const calls = [];
  editor.callbacks = {
    setMainPinEnabled: (id, enabled) => { calls.push([id, enabled]); return "guarded"; },
    updateNote: () => { throw new Error("the editor must not patch the attachment directly"); }
  };
  assert.equal(editor.setMainPinEnabled("note1", false), "guarded");
  assert.deepEqual(calls, [["note1", false]]);
});

test("makeNote seeds schema fields, ports and a main anchor", () => {
  const named = privateStore.makeNote({ title: "A real title", style: "document", cards: {} });
  assert.equal(named.note.label, "A real title");
  assert.equal(named.note.schemaVersion, 1);
  assert.equal(named.note.presentation.extendedStyle, "document");
  assert.equal(named.note.presentation.forceExtended, true);
  assert.equal(named.note.attachment.mainPinEnabled, true);
  assert.deepEqual(named.card.ports, ["right"]);
  assert.deepEqual(named.card.anchors.main, {
    kind: "main", x: 0.5, y: 0, createdBy: gm.id
  });

  const generated = privateStore.makeNote({ title: "", style: "sticky", cards: {} });
  assert.equal(generated.note.title, "Untitled");
  assert.equal(generated.note.label, "");
  assert.equal(generated.note.presentation.nameGenerated, true);
  assert.equal(generated.note.presentation.extendedStyle, "memo");
  assert.equal(generated.note.presentation.forceExtended, false);

  const view = privateStore.noteView(privateStore.findActive(third.id), named.note);
  assert.equal(view.system.label, "A real title");
  assert.equal(view.system.schemaVersion, 1);
  assert.equal(view.system.presentation.extendedStyle, "document");
  assert.equal(view.system.attachment.mainPinEnabled, true);
});

function transferWorkspace() {
  return normalizeWorkspace({
    format: 2,
    notes: {
      alpha: legacyNote("alpha", "Alpha", "memo", {
        label: "Alpha label",
        image: "assets/stylized/cork.svg",
        backgroundImage: "assets/stylized/paper.webp",
        presentation: {
          extendedStyle: "document", forceExtended: true, font: "hand",
          pictureLayout: "left", torn: true, heading: "Heading", nameGenerated: false
        },
        attachment: {
          mainPinEnabled: true, mainSnapRadius: 12, minorSnapRadius: 4, pinStyle: "brass"
        },
        blocks: [{ blockId: "block-alpha", text: "alpha text", authorId: "author-alpha" }],
        links: [
          {
            id: "link-alpha-beta", targetId: "beta", label: "to beta", direction: "one",
            color: "link1", lineStyle: "dashed", sourceAnchorId: "main", targetAnchorId: "minor-beta",
            routeAnchors: [
              { noteId: "beta", anchorId: "main" },
              { noteId: "outside", anchorId: "main" }
            ],
            material: "double", thickness: 3, slack: 0.1, pattern: "alternating",
            ends: "loose", secondaryColor: "link2",
            sourceSide: "right", targetSide: "left",
            sourcePoint: { x: 1, y: 0.5 }, targetPoint: { x: 0, y: 0.5 }
          },
          { id: "link-alpha-outside", targetId: "outside", label: "external" }
        ]
      }),
      beta: legacyNote("beta", "Beta", "sticky", {
        blocks: [{ blockId: "block-beta", text: "beta text" }],
        links: [{ id: "link-beta-alpha", targetId: "alpha" }]
      }),
      gamma: legacyNote("gamma", "Gamma", "document", {
        blocks: [{ blockId: "block-gamma", text: "gamma text" }]
      })
    },
    layout: {
      cards: {
        alpha: {
          x: 0, y: 0, width: 300, height: 120, rotation: 4, ports: ["left", "top"],
          anchors: {
            main: { kind: "main", x: 0.5, y: 0, createdBy: "author-alpha" },
            minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: "author-alpha" }
          }
        },
        beta: {
          x: 400, y: 0, width: 200, height: 100, rotation: 0, ports: ["right"],
          anchors: {
            main: { kind: "main", x: 0.5, y: 0, createdBy: "author-beta" },
            "minor-beta": { kind: "minor", x: 0.8, y: 0.7, createdBy: "author-beta" }
          }
        },
        gamma: { x: 0, y: 220 }
      },
      labels: {
        alphaText: {
          text: "Attached label", x: 1, y: 2, size: 16, color: "#b85347",
          noteId: "alpha", corner: "top-left"
        },
        betaStamp: {
          text: "", x: 0, y: 0, size: 14, color: "gold", stamp: "skull",
          noteId: "beta", corner: "bottom-right"
        },
        free: {
          text: "Free label", x: 0, y: 0, size: 14, color: "", stamp: "",
          noteId: "", corner: "bottom-right"
        },
        outside: {
          text: "Other note label", x: 0, y: 0, size: 14, color: "", stamp: "",
          noteId: "gamma", corner: "bottom-right"
        }
      },
      viewport: { x: 10, y: 20, zoom: 1.5 }
    },
    trash: []
  });
}

function cardsOverlap(a, b) {
  const aw = Number.isFinite(a.width) && a.width > 0 ? a.width : 200;
  const ah = Number.isFinite(a.height) && a.height > 0 ? a.height : 90;
  const bw = Number.isFinite(b.width) && b.width > 0 ? b.width : 200;
  const bh = Number.isFinite(b.height) && b.height > 0 ? b.height : 90;
  return !(a.x + aw <= b.x || b.x + bw <= a.x || a.y + ah <= b.y || b.y + bh <= a.y);
}

function boundsOverlap(a, b) {
  return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
}

function placeTransferCard(sourceCard, existingCards) {
  const source = normalizeWorkspace({
    format: 2,
    notes: { source: legacyNote("source", "Rotated Source", "memo") },
    layout: { cards: { source: sourceCard }, labels: {}, viewport: null },
    trash: []
  });
  const packed = buildPrivateTransfer(source, ["source"], {
    fromUserId: "sender", toUserId: "recipient"
  });
  const existing = {};
  const notes = {};
  for (const [id, card] of Object.entries(existingCards)) {
    existing[id] = card;
    notes[id] = legacyNote(id, id, "memo");
  }
  const destination = normalizeWorkspace({
    format: 2,
    notes,
    layout: { cards: existing, labels: {}, viewport: null },
    trash: []
  });
  const { workspace, imported } = importPrivateTransfer(destination, packed, "recipient");
  return { card: workspace.layout.cards[imported[0]], existing: workspace.layout.cards };
}

test("private transfer packing copies only selected notes and attached labels", () => {
  const workspace = transferWorkspace();
  const packed = buildPrivateTransfer(workspace, ["alpha", "beta"], {
    fromUserId: "sender", toUserId: "recipient"
  });

  assert.equal(packed.fromUserId, "sender");
  assert.equal(packed.toUserId, "recipient");
  assert.ok(Number.isFinite(packed.createdAt));
  assert.deepEqual(packed.summary, {
    count: 2, titles: ["Alpha", "Beta"], droppedLinks: 1, droppedWaypoints: 1
  }, "the pack preview counts the external link and external route waypoint");
  assert.deepEqual(packed.notes.map(entry => entry.note.id).sort(), ["alpha", "beta"]);
  assert.ok(!packed.notes.some(entry => entry.note.id === "gamma"), "unselected notes never travel");

  const alpha = packed.notes.find(entry => entry.note.id === "alpha");
  assert.equal(alpha.note.image, "assets/stylized/cork.svg");
  assert.equal(alpha.note.backgroundImage, "assets/stylized/paper.webp");
  assert.equal(alpha.note.presentation.font, "hand");
  assert.equal(alpha.note.presentation.torn, true);
  assert.equal(alpha.note.attachment.pinStyle, "brass");
  assert.deepEqual(Object.keys(alpha.labels), ["alphaText"], "only labels attached to alpha");
  assert.deepEqual(alpha.card.ports, ["left", "top"]);

  const beta = packed.notes.find(entry => entry.note.id === "beta");
  assert.deepEqual(Object.keys(beta.labels), ["betaStamp"]);
  assert.equal(beta.labels.betaStamp.stamp, "skull");

  const allLabelText = JSON.stringify(packed.notes.map(entry => entry.labels));
  assert.ok(!allLabelText.includes("Free label"), "free board labels are excluded");
  assert.ok(!allLabelText.includes("Other note label"), "labels of unselected notes are excluded");

  packed.notes[0].note.blocks[0].text = "mutated copy";
  assert.equal(workspace.notes.alpha.blocks[0].text, "alpha text", "packing snapshots the source");
});

test("private transfer build rejects empty, missing, oversized and self transfers", () => {
  const workspace = transferWorkspace();
  assert.throws(() => buildPrivateTransfer(workspace, [], {
    fromUserId: "sender", toUserId: "recipient"
  }), /no notes to send/i);
  assert.throws(() => buildPrivateTransfer(workspace, ["alpha"], {
    fromUserId: "sender", toUserId: "sender"
  }), /yourself/i);
  assert.throws(() => buildPrivateTransfer(workspace, ["missing"], {
    fromUserId: "sender", toUserId: "recipient"
  }), /no longer available/i);
  assert.throws(() => buildPrivateTransfer(workspace, Array.from({ length: MAX_TRANSFER_NOTES + 1 },
    (_, index) => `note-${index}`), { fromUserId: "sender", toUserId: "recipient" }),
  new RegExp(`at most ${MAX_TRANSFER_NOTES} notes`, "i"));

  const huge = normalizeWorkspace({
    format: 2,
    notes: {
      huge: legacyNote("huge", "Huge", "memo", {
        blocks: [{ blockId: "huge-block", text: "x".repeat(MAX_TRANSFER_TEXT + 1) }]
      })
    },
    layout: { cards: { huge: { x: 0, y: 0 } }, labels: {}, viewport: null },
    trash: []
  });
  assert.throws(() => buildPrivateTransfer(huge, ["huge"], {
    fromUserId: "sender", toUserId: "recipient"
  }), /too large/i);
});

test("importing a private transfer remaps ids, drops external links and places cards", () => {
  const packed = buildPrivateTransfer(transferWorkspace(), ["alpha", "beta"], {
    fromUserId: "sender", toUserId: "recipient"
  });
  const destination = normalizeWorkspace({
    format: 2,
    notes: {
      existing: legacyNote("existing", "Existing", "memo", {
        blocks: [{ blockId: "existing-block", text: "existing text" }],
        links: [{ id: "existing-link", targetId: "missing" }]
      })
    },
    layout: {
      cards: { existing: { x: 0, y: 0, width: 200, height: 100 } },
      labels: { free: { text: "Free", x: 0, y: 0, noteId: "" } },
      viewport: { x: 3, y: 4, zoom: 2 }
    },
    trash: []
  });

  const { workspace, imported, droppedLinks, droppedWaypoints } = importPrivateTransfer(
    destination, packed, "recipient"
  );
  assert.equal(imported.length, 2);
  assert.equal(droppedLinks, 1, "only the link to a note outside the transfer is dropped");
  assert.equal(droppedWaypoints, 1,
    "the internal link survives but its external route waypoint is counted separately");
  assert.deepEqual(Object.keys(destination.notes), ["existing"], "the input workspace is not mutated");

  assert.equal(Object.keys(workspace.notes).length, 3);
  assert.ok(workspace.notes.existing, "existing notes are preserved");
  assert.deepEqual(workspace.layout.viewport, { x: 3, y: 4, zoom: 2 });

  const alpha = workspace.notes[imported[0]];
  const beta = workspace.notes[imported[1]];
  assert.equal(alpha.title, "Alpha");
  assert.equal(beta.title, "Beta");
  for (const [oldId, newId] of [["alpha", imported[0]], ["beta", imported[1]]]) {
    assert.notEqual(newId, oldId);
    assert.equal(Object.hasOwn(workspace.notes, oldId), false);
  }
  assert.notEqual(alpha.id, beta.id);

  assert.equal(alpha.label, "Alpha label");
  assert.equal(alpha.image, "assets/stylized/cork.svg");
  assert.equal(alpha.backgroundImage, "assets/stylized/paper.webp");
  assert.equal(alpha.presentation.extendedStyle, "document");
  assert.equal(alpha.presentation.font, "hand");
  assert.equal(alpha.presentation.pictureLayout, "left");
  assert.equal(alpha.presentation.torn, true);
  assert.equal(alpha.attachment.pinStyle, "brass");
  assert.equal(alpha.attachment.mainSnapRadius, 12);
  assert.equal(alpha.blocks[0].text, "alpha text");
  assert.equal(alpha.blocks[0].authorId, "author-alpha");
  assert.notEqual(alpha.blocks[0].blockId, "block-alpha",
    "copied block ids are regenerated to stay collision-free");
  assert.ok(Number.isFinite(alpha.createdAt));
  assert.ok(alpha.updatedAt >= alpha.createdAt);

  const alphaCard = workspace.layout.cards[alpha.id];
  assert.equal(alphaCard.width, 300);
  assert.equal(alphaCard.height, 120);
  assert.equal(alphaCard.rotation, 4);
  assert.deepEqual(alphaCard.ports, ["left", "top"]);
  assert.equal(alphaCard.anchors.main.createdBy, "recipient");
  assert.equal(alphaCard.anchors.minor.createdBy, "recipient");
  assert.notEqual(alphaCard.x, destination.layout.cards.existing.x,
    "the copied card avoids the existing card");

  const betaCard = workspace.layout.cards[beta.id];
  assert.ok(betaCard);
  assert.equal(cardsOverlap(alphaCard, betaCard), false, "imported cards do not overlap each other");
  assert.equal(cardsOverlap(alphaCard, workspace.layout.cards.existing), false);
  assert.equal(cardsOverlap(betaCard, workspace.layout.cards.existing), false);

  assert.equal(alpha.links.length, 1);
  const internal = alpha.links[0];
  assert.equal(internal.targetId, beta.id);
  assert.notEqual(internal.id, "link-alpha-beta", "link ids are regenerated");
  assert.equal(internal.createdBy, "recipient");
  assert.equal(internal.label, "to beta");
  assert.equal(internal.material, "double");
  assert.deepEqual(internal.routeAnchors, [{ noteId: beta.id, anchorId: "main" }],
    "internal route waypoints are remapped and external ones dropped");
  assert.equal(beta.links.length, 1);
  assert.equal(beta.links[0].targetId, alpha.id);
  assert.notEqual(beta.links[0].id, "link-beta-alpha");

  const labels = Object.values(workspace.layout.labels);
  const attachedText = labels.find(label => label.text === "Attached label");
  const attachedStamp = labels.find(label => label.stamp === "skull");
  assert.ok(attachedText);
  assert.equal(attachedText.noteId, alpha.id);
  assert.equal(attachedText.color, "#b85347");
  assert.equal(attachedText.corner, "top-left");
  assert.equal(attachedText.id, undefined, "labels are keyed by their regenerated id");
  assert.ok(attachedStamp);
  assert.equal(attachedStamp.noteId, beta.id);
  assert.ok(!labels.some(label => label.text === "Free label" || label.noteId === "gamma"));

  const second = importPrivateTransfer(workspace, packed, "recipient");
  const allIds = Object.keys(second.workspace.notes);
  assert.equal(allIds.length, 5);
  assert.equal(new Set(allIds).size, allIds.length, "a second import cannot collide with the first");
  const secondCards = Object.values(second.workspace.layout.cards);
  for (let i = 0; i < secondCards.length; i++) {
    for (let j = i + 1; j < secondCards.length; j++) {
      assert.equal(cardsOverlap(secondCards[i], secondCards[j]), false,
        "every imported card finds a free spot");
    }
  }
});

test("findFreeSpot searches outward and never returns an occupied position", () => {
  const cards = { occupied: { x: 0, y: 0, width: 200, height: 100 } };
  const spot = findFreeSpot(cards, 190, 90, 0, 0);
  assert.notDeepEqual(spot, { x: 0, y: 0 });
  const overlap = !(spot.x + 190 + 16 < 0 || spot.x > 200 + 16
    || spot.y + 90 + 16 < 0 || spot.y > 100 + 16);
  assert.equal(overlap, false);
});

test("auto-sized cards reserve their style defaults instead of 200x90", () => {
  assert.deepEqual(defaultCardSize("memo"), { width: 360, height: 240 });
  assert.deepEqual(defaultCardSize("document"), { width: 248, height: 240 });
  assert.ok(defaultCardSize("unknown-style").width >= 360,
    "an unknown style reserves the largest known box rather than shrinking");

  const existing = { x: 0, y: 0, width: null, height: null };
  const memoNote = legacyNote("memo", "Auto Memo", "memo");
  const spot = findFreeSpot({ memo: existing }, 360, 240, 0, 0, 0, {
    notes: { memo: memoNote }
  });
  const candidate = rotatedCardBounds({ ...spot, width: 360, height: 240, rotation: 0 });
  const blocker = rotatedCardBounds(existing, 360, 240);
  assert.equal(boundsOverlap(candidate, blocker), false,
    "a new 360x240 memo does not occupy an auto-sized memo's real box");

  const made = privateStore.makeNote({
    title: "New Memo", style: "memo", x: 0, y: 0,
    cards: { memo: existing }, notes: { memo: memoNote }
  });
  assert.equal(boundsOverlap(
    rotatedCardBounds(made.card, 360, 240),
    rotatedCardBounds(existing, 360, 240)
  ), false, "makeNote uses the same conservative existing-card size");

  const source = normalizeWorkspace({
    format: 2,
    notes: { source: legacyNote("source", "Auto Import", "memo") },
    layout: { cards: { source: { x: 0, y: 0 } }, labels: {}, viewport: null },
    trash: []
  });
  const packed = buildPrivateTransfer(source, ["source"], {
    fromUserId: "sender", toUserId: "recipient"
  });
  const destination = normalizeWorkspace({
    format: 2,
    notes: { blocker: legacyNote("blocker", "Auto Blocker", "memo") },
    layout: { cards: { blocker: { x: 0, y: 0 } }, labels: {}, viewport: null },
    trash: []
  });
  const { workspace, imported } = importPrivateTransfer(destination, packed, "recipient");
  assert.equal(boundsOverlap(
    rotatedCardBounds(workspace.layout.cards[imported[0]], 360, 240),
    rotatedCardBounds(workspace.layout.cards.blocker, 360, 240)
  ), false, "transfer import reserves the auto-sized existing memo footprint");
});

test("private transfer placement uses rotated AABBs for the candidate card", () => {
  // At (0,110) the unrotated 200x20 card would clear the existing 200x100 card, but a 90°
  // rotation makes it 20x200 tall and overlap. The importer must move it.
  const { card, existing } = placeTransferCard(
    { x: 0, y: 110, width: 200, height: 20, rotation: 90 },
    { blocker: { x: 0, y: 0, width: 200, height: 100, rotation: 0 } }
  );
  assert.equal(boundsOverlap(rotatedCardBounds(card), rotatedCardBounds(existing.blocker)), false,
    "the rotated candidate reserves its true world-space footprint");
});

test("private transfer placement uses rotated AABBs for existing cards", () => {
  // The tall existing card is 40x200, so rotating it 90° makes a wide 200x40 footprint. At
  // (50,90) the candidate clears the unrotated box but overlaps the rotated one.
  const { card, existing } = placeTransferCard(
    { x: 50, y: 90, width: 100, height: 30, rotation: 0 },
    { blocker: { x: 0, y: 0, width: 40, height: 200, rotation: 90 } }
  );
  assert.equal(boundsOverlap(rotatedCardBounds(card), rotatedCardBounds(existing.blocker)), false,
    "existing rotated cards block their real footprint");
});

test("private transfer build caps attached labels", () => {
  const labels = {};
  for (let i = 0; i <= MAX_TRANSFER_LABELS; i++) {
    labels[`label-${i}`] = {
      text: `Attached ${i}`, x: i, y: i, size: 14, color: "", stamp: "",
      noteId: "alpha", corner: "bottom-right"
    };
  }
  const workspace = normalizeWorkspace({
    format: 2,
    notes: { alpha: legacyNote("alpha", "Alpha", "memo") },
    layout: { cards: { alpha: { x: 0, y: 0 } }, labels, viewport: null },
    trash: []
  });
  assert.throws(() => buildPrivateTransfer(workspace, ["alpha"], {
    fromUserId: "sender", toUserId: "recipient"
  }), new RegExp(`too many attached labels.*${MAX_TRANSFER_LABELS}`, "i"));
  assert.deepEqual(countTransferDrops(workspace, ["alpha"]), {
    droppedLinks: 0, droppedWaypoints: 0
  });
});

function transferRecord(id, toUserId, fromUserId = "SenderTransfer01", text = "body") {
  return {
    id,
    fromUserId,
    toUserId,
    createdAt: Date.now(),
    notes: [{
      note: legacyNote(`note-${id}`, `Note ${id}`, "sticky", {
        blocks: [{ blockId: `block-${id}`, text }]
      }),
      card: { x: 0, y: 0 },
      labels: {}
    }],
    summary: { count: 1, titles: [`Note ${id}`] }
  };
}

test("private store stores, filters, caps and removes pending transfers", async () => {
  assert.equal(privateStore.container(), containers.private, "the private container is exposed");

  const recipientA = "TransferRecipientA";
  const recipientB = "TransferRecipientB";
  const firstRecord = await privateStore.addTransfer(transferRecord("TransferStore001", recipientA));
  await privateStore.addTransfer(transferRecord("TransferStore002", recipientA, "SenderTransfer02"));
  await privateStore.addTransfer(transferRecord("TransferStore003", recipientB));

  assert.deepEqual(firstRecord.summary, {
    count: 1, titles: ["Note TransferStore001"], droppedLinks: 0, droppedWaypoints: 0
  });
  assert.equal(privateStore.pendingTransfers(recipientA).length, 2);
  assert.equal(privateStore.pendingTransfers(recipientB).length, 1);
  assert.equal(privateStore.pendingTransfers("SomeoneElse0001").length, 0);
  assert.equal(privateStore.transfer("TransferStore002").toUserId, recipientA);
  assert.ok(Object.hasOwn(privateStore.transfers(), "TransferStore003"));

  assert.equal(await privateStore.removeTransfer("TransferStore001"), true);
  assert.equal(privateStore.transfer("TransferStore001"), null);
  assert.equal(privateStore.pendingTransfers(recipientA).length, 1);
  assert.equal(await privateStore.removeTransfer("TransferStore001"), false);
  assert.equal(await privateStore.removeTransfer("constructor"), false);

  const capRecipient = "TransferRecipientCap";
  for (let i = 0; i < MAX_PENDING_TRANSFERS; i++) {
    await privateStore.addTransfer(transferRecord(
      `TransferCap${String(i).padStart(3, "0")}`, capRecipient, `SenderCap${String(i).padStart(3, "0")}`
    ));
  }
  assert.equal(privateStore.pendingTransfers(capRecipient).length, MAX_PENDING_TRANSFERS);
  await assert.rejects(
    privateStore.addTransfer(transferRecord("TransferCapOverflow", capRecipient, "SenderCapOverflow")),
    /too many pending transfers/i
  );
  assert.equal(privateStore.pendingTransfers(capRecipient).length, MAX_PENDING_TRANSFERS);

  await assert.rejects(
    privateStore.addTransfer(transferRecord("TransferTooLarge", recipientA, "Sender", "x".repeat(MAX_TRANSFER_TEXT + 1))),
    /too large/i
  );
  const tooManyNotes = transferRecord("TransferTooMany", recipientA);
  tooManyNotes.notes = Array.from({ length: MAX_TRANSFER_NOTES + 1 }, (_, index) => ({
    note: legacyNote(`many-${index}`, `Many ${index}`, "sticky", {
      blocks: [{ blockId: `many-block-${index}`, text: "x" }]
    }),
    card: { x: 0, y: 0 },
    labels: {}
  }));
  await assert.rejects(privateStore.addTransfer(tooManyNotes), /at most 50 notes/i);
  await assert.rejects(
    privateStore.addTransfer(transferRecord("TransferStore002", recipientB)), /no longer available/i
  );
  await assert.rejects(
    privateStore.addTransfer(transferRecord("__proto__", recipientA)), /no longer available/i,
    "prototype-key transfer ids are rejected"
  );

  for (const id of ["TransferStore002", "TransferStore003", "TransferCapOverflow"]) {
    await privateStore.removeTransfer(id);
  }
  for (let i = 0; i < MAX_PENDING_TRANSFERS; i++) {
    await privateStore.removeTransfer(`TransferCap${String(i).padStart(3, "0")}`);
  }
  assert.equal(privateStore.pendingTransfers(recipientA).length, 0);
  assert.equal(privateStore.pendingTransfers(recipientB).length, 0);
  assert.equal(privateStore.pendingTransfers(capRecipient).length, 0);
});

test("pending transfers expire after 30 days and enforce a per-sender cap", async () => {
  const now = Date.now();
  const partition = partitionExpiredTransfers({
    old: { createdAt: now - TRANSFER_TTL_MS - 1 },
    fresh: { createdAt: now }
  }, now);
  assert.deepEqual(partition.expired, ["old"]);
  assert.deepEqual(Object.keys(partition.fresh), ["fresh"]);

  const expiredRecipient = "TransferExpiryUser";
  const expired = transferRecord("TransferExpired01", expiredRecipient, "SenderExpiry01");
  expired.createdAt = now - TRANSFER_TTL_MS - 1000;
  await privateStore.addTransfer(expired);
  assert.equal(privateStore.transfer("TransferExpired01"), null, "an expired offer is not readable");
  assert.equal(privateStore.pendingTransfers(expiredRecipient).length, 0);
  assert.ok(Object.hasOwn(privateStore.rawTransfers(), "TransferExpired01"),
    "the stale flag survives until a write can delete it");

  await privateStore.addTransfer(transferRecord(
    "TransferExpiryFresh", expiredRecipient, "SenderExpiry02"
  ));
  assert.equal(Object.hasOwn(privateStore.rawTransfers(), "TransferExpired01"), false,
    "adding a transfer deletes expired flag keys");
  assert.equal(privateStore.pendingTransfers(expiredRecipient).length, 1);
  await privateStore.removeTransfer("TransferExpiryFresh");

  const capRecipient = "TransferSenderCapRecipient";
  for (let i = 0; i < MAX_PENDING_PER_SENDER; i++) {
    await privateStore.addTransfer(transferRecord(
      `TransferPerSender${i}`, capRecipient, "SenderSame000001"
    ));
  }
  assert.equal(privateStore.pendingTransfers(capRecipient).length, MAX_PENDING_PER_SENDER);
  await assert.rejects(
    privateStore.addTransfer(transferRecord(
      "TransferPerSenderOverflow", capRecipient, "SenderSame000001"
    )),
    new RegExp(`this sender.*${MAX_PENDING_PER_SENDER}`, "i")
  );
  assert.equal(privateStore.pendingTransfers(capRecipient).length, MAX_PENDING_PER_SENDER);
  await privateStore.addTransfer(transferRecord(
    "TransferPerSenderOther", capRecipient, "SenderOther000002"
  ));
  assert.equal(privateStore.pendingTransfers(capRecipient).length, MAX_PENDING_PER_SENDER + 1,
    "a different sender still fits under the recipient's total cap");

  for (let i = 0; i < MAX_PENDING_PER_SENDER; i++) {
    await privateStore.removeTransfer(`TransferPerSender${i}`);
  }
  await privateStore.removeTransfer("TransferPerSenderOther");
  assert.equal(privateStore.pendingTransfers(capRecipient).length, 0);
});

test("transfer removal uses Foundry deletion keys, not a replacement object", async () => {
  const container = containers.private;
  const originalUpdate = container.update;
  const changes = [];
  container.update = function update(update) {
    changes.push(update);
    return originalUpdate.call(this, update);
  };
  try {
    await privateStore.addTransfer(transferRecord("TransferDeleteKey01", "TransferRecipientDelete"));
    assert.equal(await privateStore.removeTransfer("TransferDeleteKey01"), true);
    assert.ok(changes.some(update => Object.hasOwn(
      update, "flags.fvtt-journalinator.transfers.-=TransferDeleteKey01"
    )), "removeTransfer asks Foundry to delete exactly that key");

    await privateStore.addTransfer(transferRecord(
      "TransferPruneKey01", "TransferRecipientDelete", "DeletedTransferUser"
    ));
    await privateStore.addTransfer(transferRecord(
      "TransferPruneKey02", "DeletedTransferRecipient", "SenderTransfer02"
    ));
    changes.length = 0;
    assert.equal(await privateStore.pruneTransfersForUser("DeletedTransferUser"), 1);
    assert.ok(changes.some(update => Object.hasOwn(
      update, "flags.fvtt-journalinator.transfers.-=TransferPruneKey01"
    )), "pruning also deletes per-key instead of writing a smaller object");
    await privateStore.removeTransfer("TransferPruneKey02");
  } finally {
    container.update = originalUpdate;
  }
});

test("private store accept/decline helpers are recipient-only and create a missing page", async () => {
  const sender = makeUser("Player000000021", { name: "Transfer Sender" });
  const recipient = second;
  const workspace = normalizeWorkspace({
    format: 2,
    notes: { note: legacyNote("note", "Helper Note", "memo", {
      blocks: [{ blockId: "helper-block", text: "helper body" }]
    }) },
    layout: { cards: { note: { x: 0, y: 0 } }, labels: {}, viewport: null },
    trash: []
  });
  const packed = buildPrivateTransfer(workspace, ["note"], {
    fromUserId: sender.id, toUserId: recipient.id
  });
  await privateStore.addTransfer({ id: "TransferAccept01", ...packed });
  assert.equal(privateStore.findActive(recipient.id), null);

  await assert.rejects(privateStore.acceptTransfer("TransferAccept01", first.id),
    /not addressed/i);
  await assert.rejects(privateStore.declineTransfer("TransferAccept01", first.id),
    /not addressed/i);
  assert.equal(privateStore.transfer("TransferAccept01").id, "TransferAccept01");

  const result = await privateStore.acceptTransfer("TransferAccept01", recipient.id);
  assert.equal(result.count, 1);
  assert.equal(result.droppedLinks, 0);
  assert.equal(result.droppedWaypoints, 0);
  const page = privateStore.findActive(recipient.id);
  assert.equal(result.page.id, page.id, "accept creates a private page when none exists");
  assert.equal(Object.keys(privateStore.read(page).notes).length, 1);
  assert.equal(privateStore.transfer("TransferAccept01"), null);
  await privateStore.remove(page);
});

test("private store rejects transfers beyond the storage ceiling", async () => {
  const huge = transferRecord("TransferStorageHuge", "TransferStorageUser");
  huge.padding = "x".repeat(MAX_TRANSFER_STORAGE + 1);
  await assert.rejects(privateStore.addTransfer(huge), /too large/i);
  assert.equal(privateStore.transfer("TransferStorageHuge"), null);
});

test("accepting a transfer activates the recipient's pending private page", async () => {
  const recipient = makeUser("Player000000031", { name: "Pending Recipient" });
  const page = await privateStore.createFor(recipient);
  await privateStore.detach(page);
  await privateStore.assign(page, recipient.id);
  assert.equal(privateStore.findPending(recipient.id)?.id, page.id);
  assert.equal(privateStore.findActive(recipient.id), null);

  const packed = buildPrivateTransfer(normalizeWorkspace({
    format: 2,
    notes: { note: legacyNote("note", "Pending Copy", "memo") },
    layout: { cards: { note: { x: 0, y: 0 } }, labels: {}, viewport: null },
    trash: []
  }), ["note"], { fromUserId: "Player000000032", toUserId: recipient.id });
  await privateStore.addTransfer({ id: "TransferPending01", ...packed });

  const result = await privateStore.acceptTransfer("TransferPending01", recipient.id);
  assert.equal(result.page.id, page.id, "the existing pending page becomes the destination");
  assert.equal(privateStore.findActive(recipient.id)?.id, page.id);
  assert.equal(privateStore.findPending(recipient.id), null);
  assert.ok(Object.values(privateStore.read(page).notes).some(note => note.title === "Pending Copy"),
    "the copy is visible on the newly activated private page");
  await privateStore.remove(page);
});

test("a saved transfer whose removal fails retries without duplicating notes", async () => {
  const recipient = makeUser("Player000000033", { name: "Retry Recipient" });
  const packed = buildPrivateTransfer(normalizeWorkspace({
    format: 2,
    notes: { note: legacyNote("note", "Retry Copy", "memo") },
    layout: { cards: { note: { x: 0, y: 0 } }, labels: {}, viewport: null },
    trash: []
  }), ["note"], { fromUserId: "Player000000034", toUserId: recipient.id });
  await privateStore.addTransfer({ id: "TransferRetry01", ...packed });

  const originalRemove = privateStore.removeTransfer;
  privateStore.removeTransfer = async () => { throw new Error("removal failed"); };
  try {
    await assert.rejects(privateStore.acceptTransfer("TransferRetry01", recipient.id),
      /removal failed/);
  } finally {
    privateStore.removeTransfer = originalRemove;
  }
  const page = privateStore.findActive(recipient.id);
  assert.ok(page, "the workspace save succeeded before removal");
  assert.ok(privateStore.transfer("TransferRetry01"), "the pending record survives the failure");
  assert.ok(privateStore.acceptedTransfers(page).includes("TransferRetry01"),
    "the acceptance receipt is stored with the workspace");
  const notesBefore = Object.keys(privateStore.read(page).notes).length;
  assert.equal(notesBefore, 1);

  const retry = await privateStore.acceptTransfer("TransferRetry01", recipient.id);
  assert.equal(retry.alreadyAccepted, true, "the retry spots the receipt and skips the import");
  assert.equal(Object.keys(privateStore.read(page).notes).length, notesBefore,
    "no duplicate notes are imported");
  assert.equal(privateStore.transfer("TransferRetry01"), null, "the stale offer is now removed");
  assert.equal(privateStore.acceptedTransfers(page).filter(id => id === "TransferRetry01").length, 1,
    "the receipt is not duplicated");
  await privateStore.remove(page);
});

test("a post-save stale overwrite is re-imported once", async () => {
  const recipient = makeUser("Player000000038", { name: "Raced Recipient" });
  const packed = buildPrivateTransfer(normalizeWorkspace({
    format: 2,
    notes: { note: legacyNote("note", "Race Copy", "memo") },
    layout: { cards: { note: { x: 0, y: 0 } }, labels: {}, viewport: null },
    trash: []
  }), ["note"], { fromUserId: "Player000000037", toUserId: recipient.id });
  await privateStore.addTransfer({ id: "TransferRace01", ...packed });

  const page = await privateStore.createFor(recipient);
  const stale = JSON.stringify(privateStore.read(page));
  let overwritten = false;
  const originalUpdate = page.update.bind(page);
  page.update = async changes => {
    const result = await originalUpdate(changes);
    if (!overwritten && Object.hasOwn(
      changes, "flags.fvtt-journalinator.private.workspace"
    )) {
      overwritten = true;
      // Simulate a stale owner save landing after our accept write: workspace only, so the
      // acceptance receipt remains while the imported notes disappear.
      await originalUpdate({ "flags.fvtt-journalinator.private.workspace": stale });
    }
    return result;
  };
  try {
    const result = await privateStore.acceptTransfer("TransferRace01", recipient.id);
    assert.equal(result.count, 1);
  } finally {
    page.update = originalUpdate;
  }
  assert.equal(overwritten, true, "the test actually overwrote the first save");
  assert.equal(privateStore.transfer("TransferRace01"), null, "the transfer is removed after recovery");
  const workspace = privateStore.read(page);
  assert.equal(Object.values(workspace.notes).filter(note => note.title === "Race Copy").length, 1,
    "the retry re-imports exactly one copy");
  assert.ok(privateStore.acceptedTransfers(page).includes("TransferRace01"));
  assert.equal(privateStore.acceptedTransferNoteIds(page, "TransferRace01").length, 1,
    "the receipt records the note ids that survived the retry");
  await privateStore.remove(page);
});

test("a repeated post-save overwrite keeps the transfer for a retry", async () => {
  const recipient = makeUser("Player000000039", { name: "Race Failure Recipient" });
  const packed = buildPrivateTransfer(normalizeWorkspace({
    format: 2,
    notes: { note: legacyNote("note", "Race Kept Copy", "memo") },
    layout: { cards: { note: { x: 0, y: 0 } }, labels: {}, viewport: null },
    trash: []
  }), ["note"], { fromUserId: "Player000000037", toUserId: recipient.id });
  await privateStore.addTransfer({ id: "TransferRace02", ...packed });

  const page = await privateStore.createFor(recipient);
  const stale = JSON.stringify(privateStore.read(page));
  const originalUpdate = page.update.bind(page);
  page.update = async changes => {
    const result = await originalUpdate(changes);
    if (Object.hasOwn(changes, "flags.fvtt-journalinator.private.workspace")) {
      await originalUpdate({ "flags.fvtt-journalinator.private.workspace": stale });
    }
    return result;
  };
  try {
    await assert.rejects(privateStore.acceptTransfer("TransferRace02", recipient.id),
      /overwritten before it could be confirmed/i);
  } finally {
    page.update = originalUpdate;
  }
  assert.ok(privateStore.transfer("TransferRace02"), "the offer is retained, not silently lost");
  assert.equal(Object.values(privateStore.read(page).notes).length, 0,
    "the failed verification leaves no false success");

  const retry = await privateStore.acceptTransfer("TransferRace02", recipient.id);
  assert.equal(retry.count, 1);
  assert.equal(privateStore.transfer("TransferRace02"), null);
  assert.equal(Object.values(privateStore.read(page).notes)
    .filter(note => note.title === "Race Kept Copy").length, 1,
  "a later retry imports the retained transfer without a duplicate");
  await privateStore.remove(page);
});

test("acceptance receipts are capped and a stale workspace revision is rejected", async () => {
  const recipient = makeUser("Player000000035", { name: "Receipt Recipient" });
  const page = await privateStore.createFor(recipient);
  await assert.rejects(privateStore.saveAccepted(
    page, emptyWorkspace(), -1, "TransferReceiptStale"
  ), /another session/);
  assert.ok(!privateStore.acceptedTransfers(page).includes("TransferReceiptStale"),
    "a conflicted save does not record a false receipt");

  for (let i = 0; i <= MAX_ACCEPTED_TRANSFERS; i++) {
    const id = `TransferReceipt${String(i).padStart(3, "0")}`;
    await privateStore.saveAccepted(page, emptyWorkspace(), null, id);
  }
  const receipts = privateStore.acceptedTransfers(page);
  assert.equal(receipts.length, MAX_ACCEPTED_TRANSFERS, "receipts are capped");
  assert.equal(receipts.at(-1), `TransferReceipt${String(MAX_ACCEPTED_TRANSFERS).padStart(3, "0")}`,
    "the oldest receipts are dropped first");
  await privateStore.remove(page);
});

test("accepting the same transfer after success is stale and never duplicates", async () => {
  const recipient = makeUser("Player000000036", { name: "Duplicate Recipient" });
  const packed = buildPrivateTransfer(normalizeWorkspace({
    format: 2,
    notes: { note: legacyNote("note", "Duplicate Copy", "memo") },
    layout: { cards: { note: { x: 0, y: 0 } }, labels: {}, viewport: null },
    trash: []
  }), ["note"], { fromUserId: "Player000000037", toUserId: recipient.id });
  await privateStore.addTransfer({ id: "TransferDuplicate01", ...packed });
  await privateStore.acceptTransfer("TransferDuplicate01", recipient.id);
  const page = privateStore.findActive(recipient.id);
  assert.equal(Object.keys(privateStore.read(page).notes).length, 1);
  await assert.rejects(privateStore.acceptTransfer("TransferDuplicate01", recipient.id),
    /no longer available/i);
  assert.equal(Object.keys(privateStore.read(page).notes).length, 1);
  await privateStore.remove(page);
});

test("pending transfers involving a deleted user are pruned", async () => {
  await privateStore.addTransfer(transferRecord(
    "TransferOrphanFrom", second.id, "DeletedSender0001"
  ));
  await privateStore.addTransfer(transferRecord(
    "TransferOrphanTo", "DeletedRecipient01", first.id
  ));
  assert.ok(privateStore.transfer("TransferOrphanFrom"));
  assert.ok(privateStore.transfer("TransferOrphanTo"));

  await privateStore.orphanUser("DeletedSender0001");
  assert.equal(privateStore.transfer("TransferOrphanFrom"), null,
    "a transfer from a deleted user is removed");
  assert.ok(privateStore.transfer("TransferOrphanTo"), "unrelated transfers survive");

  await privateStore.orphanMissingUsers();
  assert.equal(privateStore.transfer("TransferOrphanTo"), null,
    "offline cleanup removes transfers addressed to a deleted user");
});
