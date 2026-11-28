import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeUser } from "./fake-foundry.mjs";

const sender = makeUser("PinSender00000001", { name: "Sender" });
installFoundry({ user: sender, users: [sender] });
const { privateStore } = await import("../scripts/store/private-store.mjs");
const { buildPrivateTransfer, importPrivateTransfer } = await import("../scripts/private-transfer.mjs");

test("private transfers copy note pins and remap connection identities", () => {
  const source = { notes: {}, layout: { cards: {}, labels: {}, pins: {}, pinLinks: {}, viewport: null },
    trash: [] };
  const first = privateStore.makeNote({ body: "# First", x: 10, y: 20,
    cards: source.layout.cards });
  source.notes[first.note.id] = first.note;
  source.layout.cards[first.note.id] = first.card;
  const second = privateStore.makeNote({ body: "# Second", x: 300, y: 20,
    cards: source.layout.cards });
  source.notes[second.note.id] = second.note;
  source.layout.cards[second.note.id] = second.card;
  source.layout.pins.manual = { noteId: first.note.id, x: 0.25, y: 0.75, isDefault: false };
  source.layout.pins.orphan = { noteId: first.note.id, x: 0.5, y: 0.5, isDefault: false };
  source.layout.pins.freeOrphan = { noteId: "", x: 700, y: 300, isDefault: false };
  source.layout.pinLinks.connection = {
    source: "p:manual", target: `n:${second.note.id}:main`
  };
  source.layout.pinLinks.orphanLink = {
    source: "p:orphan", target: "p:freeOrphan"
  };
  const transfer = buildPrivateTransfer(source, [first.note.id, second.note.id], {
    fromUserId: sender.id, toUserId: "PinTarget00000001"
  });
  assert.deepEqual(transfer.notes.flatMap(entry => Object.keys(entry.pins ?? {})),
    ["manual"], "a pin with no link inside the transfer is orphaned and stays behind");
  const imported = importPrivateTransfer({ notes: {}, layout: { cards: {}, labels: {},
    pins: {}, pinLinks: {} }, trash: [] }, transfer, "PinTarget00000001");
  const [newFirst, newSecond] = imported.imported;
  const [newPinId, newPin] = Object.entries(imported.workspace.layout.pins)[0];
  assert.equal(Object.keys(imported.workspace.layout.pins).length, 1,
    "orphaned pins are not recreated on the destination canvas");
  assert.notEqual(newPinId, "manual");
  assert.deepEqual([newPin.noteId, newPin.x, newPin.y], [newFirst, 0.25, 0.75]);
  assert.deepEqual(Object.values(imported.workspace.layout.pinLinks)[0], {
    source: `p:${newPinId}`, target: `n:${newSecond}:main`,
    label: "", color: "", material: "linen", thickness: 2.6, slack: 0.09,
    pattern: "continuous", ends: "standard", secondaryColor: ""
  }, "v2 pin links carry normalized cosmetics");
  assert.equal(source.layout.pins.manual.noteId, first.note.id,
    "the sender keeps the original pin and note");
});
