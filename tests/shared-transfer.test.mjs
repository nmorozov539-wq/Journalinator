import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";

const gm = makeUser("SharedGm00000001", { isGM: true, name: "GM" });
const recipient = makeUser("SharedRecipient01", { name: "Recipient" });
const env = installFoundry({ user: gm, users: [gm, recipient] });
const containers = await makeContainers(env);
const { registerSocket, requestWrite } = await import("../scripts/socket.mjs");
const { privateStore, emptyWorkspace } = await import("../scripts/store/private-store.mjs");
const { buildSharedTransfer, importPrivateTransfer } = await import("../scripts/private-transfer.mjs");
registerSocket();

const layoutPage = () => containers.shared.pages.get(containers.ids.layoutPage);

async function makeSharedNote(title, system = {}) {
  return JournalEntryPage.create({
    name: title,
    type: "fvtt-journalinator.note",
    system: {
      kind: "note",
      style: "memo",
      schemaVersion: 1,
      label: `${title} label`,
      presentation: { extendedStyle: "memo", forceExtended: false },
      attachment: { mainPinEnabled: true, mainSnapRadius: 12, minorSnapRadius: 4, pinStyle: "brass" },
      blocks: [{ blockId: foundry.utils.randomID(), text: `${title} visible` }],
      links: [],
      authorId: gm.id,
      createdAt: 10,
      updatedAt: 20,
      ...system
    }
  }, { parent: containers.shared });
}

test("shared transfer packaging copies only visible content of the selected notes", async () => {
  const alpha = await makeSharedNote("Shared Alpha", {
    blocks: [
      { blockId: "alpha-visible", text: "visible alpha" },
      { blockId: "alpha-secret", text: "GM SECRET BLOCK", hidden: true }
    ],
    links: [
      {
        id: "link-internal", targetId: "", label: "to beta", direction: "one",
        routeAnchors: [{ noteId: "outside", anchorId: "main" }]
      },
      {
        id: "link-external", targetId: "", label: "external", direction: "one",
        routeAnchors: []
      },
      { id: "link-hidden", targetId: "", label: "GM SECRET LINK", hidden: true }
    ]
  });
  const beta = await makeSharedNote("Shared Beta", {
    blocks: [{ blockId: "beta-visible", text: "visible beta" }]
  });
  const outside = await makeSharedNote("Outside");
  alpha.system.links[0].targetId = beta.id;
  alpha.system.links[1].targetId = outside.id;
  alpha.system.links[2].targetId = beta.id;

  await layoutPage().update({
    "system.cards": {
      [alpha.id]: {
        x: 100, y: 200, width: 320, height: 140, rotation: 3, ports: ["left", "top"],
        anchors: {
          main: { kind: "main", x: 0.5, y: 0, createdBy: gm.id },
          minor: { kind: "minor", x: 0.2, y: 0.3, createdBy: gm.id }
        }
      },
      [beta.id]: { x: 500, y: 200, width: 220, height: 120, anchors: {} }
    },
    "system.labels": {
      alphaLabel: { text: "Attached alpha", x: 1, y: 2, size: 16, color: "gold", noteId: alpha.id },
      alphaHidden: { text: "GM SECRET LABEL", x: 0, y: 0, noteId: alpha.id, hidden: true },
      freeLabel: { text: "Free board label", x: 0, y: 0, noteId: "" }
    },
    "system.pins": {
      alphaPin: { noteId: alpha.id, x: 0.25, y: 0.75, isDefault: false },
      betaPin: { noteId: beta.id, x: 0.5, y: 0.5, isDefault: false },
      outsidePin: { noteId: outside.id, x: 0.5, y: 0.5, isDefault: false }
    },
    "system.pinLinks": {
      internal: { source: "p:alphaPin", target: "p:betaPin" },
      external: { source: "p:alphaPin", target: "p:outsidePin" }
    }
  });

  const packed = buildSharedTransfer(containers.shared.pages, layoutPage().system, [alpha.id, beta.id], {
    fromUserId: gm.id,
    toUserId: recipient.id
  });

  assert.deepEqual(packed.summary, {
    count: 2, titles: ["Shared Alpha", "Shared Beta"], droppedLinks: 1, droppedWaypoints: 1
  }, "only the visible external link and its route waypoint are counted as dropped");
  const serialized = JSON.stringify(packed);
  assert.ok(!serialized.includes("GM SECRET"), "hidden blocks, links and labels never enter the pack");
  assert.ok(!serialized.includes("Free board label"), "free board labels never travel");
  assert.equal(Object.keys(packed.pinLinks).length, 1, "only the pin link between selected notes survives");

  const alphaEntry = packed.notes.find(entry => entry.note.id === alpha.id);
  assert.deepEqual(alphaEntry.note.blocks.map(block => block.text), ["visible alpha"]);
  assert.deepEqual(alphaEntry.note.links.map(link => link.id), ["link-internal", "link-external"]);
  assert.deepEqual(alphaEntry.card.ports, ["left", "top"]);
  assert.deepEqual(Object.keys(alphaEntry.labels), ["alphaLabel"]);

  const imported = importPrivateTransfer(emptyWorkspace(), packed, recipient.id);
  assert.equal(imported.imported.length, 2);
  assert.equal(imported.droppedLinks, 1);
  assert.equal(imported.droppedWaypoints, 1);
  const importedAlpha = imported.workspace.notes[imported.imported[0]];
  assert.deepEqual(importedAlpha.blocks.map(block => block.text), ["visible alpha"],
    "the hidden GM block is not imported");
  assert.equal(importedAlpha.links.length, 1, "the external link is dropped during import");
  assert.equal(importedAlpha.links[0].targetId, imported.imported[1], "the internal link is remapped");
  assert.ok(!JSON.stringify(imported.workspace).includes("GM SECRET"));
  assert.equal(Object.keys(imported.workspace.layout.pinLinks).length, 1);
  assert.equal(Object.keys(imported.workspace.layout.pins).length, 2);

  assert.equal(containerNote(alpha.id)?.name, "Shared Alpha", "the shared source remains unchanged");
  assert.deepEqual(containerNote(alpha.id).system.blocks.map(block => block.text),
    ["visible alpha", "GM SECRET BLOCK"], "source blocks are not mutated");
});

function containerNote(id) {
  return containers.shared.pages.get(id);
}

test("a shared note can be sent to another user and accepted without touching the source", async () => {
  const source = await makeSharedNote("Copper Job", {
    blocks: [{ blockId: "copper-visible", text: "Ask at the gate." }]
  });
  await layoutPage().update({
    [`system.cards.${source.id}`]: { x: 40, y: 60, width: 260, height: 120, anchors: {} }
  });

  await requestWrite({ type: "sendSharedToPrivate", toUserId: recipient.id, noteIds: [source.id] });
  const pending = privateStore.pendingTransfers(recipient.id).find(record =>
    record.summary?.titles?.includes("Copper Job"));
  assert.ok(pending, "the active GM stored a pending offer for the recipient");
  assert.equal(pending.fromUserId, gm.id);
  assert.equal(pending.toUserId, recipient.id);

  const result = await privateStore.acceptTransfer(pending.id, recipient.id);
  assert.equal(result.count, 1);
  const page = privateStore.findActive(recipient.id);
  assert.ok(page, "accepting creates the recipient's private page");
  const notes = Object.values(privateStore.read(page).notes);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "Copper Job");
  assert.equal(notes[0].blocks[0].text, "Ask at the gate.");
  assert.notEqual(notes[0].id, source.id, "the recipient gets an independent copy");
  assert.ok(containerNote(source.id), "the shared source remains on the Main Canvas");
  assert.equal(containerNote(source.id).system.blocks[0].text, "Ask at the gate.");
});

test("sending a shared note to your own private canvas imports directly", async () => {
  await privateStore.createFor(gm);
  const source = await makeSharedNote("Self Copy", {
    blocks: [{ blockId: "self-visible", text: "Only the visible line." }]
  });
  await layoutPage().update({
    [`system.cards.${source.id}`]: { x: 0, y: 0, width: 240, height: 110, anchors: {} }
  });
  const pendingBefore = Object.keys(privateStore.transfers()).length;

  await requestWrite({ type: "sendSharedToPrivate", toUserId: gm.id, noteIds: [source.id] });
  assert.equal(Object.keys(privateStore.transfers()).length, pendingBefore,
    "a self-copy is not stored as a pending transfer");

  const page = privateStore.findActive(gm.id);
  const notes = Object.values(privateStore.read(page).notes);
  assert.ok(notes.some(note => note.title === "Self Copy"), "the copy landed in the sender's own page");
  assert.ok(containerNote(source.id), "the shared source stays in place");
});
