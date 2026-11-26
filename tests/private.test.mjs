import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";

const gm = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const first = makeUser("Player000000001", { name: "First" });
const second = makeUser("Player000000002", { name: "Second" });
const third = makeUser("Player000000003", { name: "Third" });
const env = installFoundry({ user: gm, users: [gm, first, second, third] });
const containers = await makeContainers(env);
const { privateStore, emptyWorkspace, normalizeWorkspace } = await import("../scripts/store/private-store.mjs");

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
