import { test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, makeContainers, makeUser } from "./fake-foundry.mjs";
import {
  TRANSFER_VERSION, NOTE_SCHEMA_VERSION, MAX_TRANSFER_NOTES, MAX_TRANSFER_TEXT,
  MAX_TRANSFER_BODY, MAX_TRANSFER_LABELS,
  buildPrivateTransfer, importPrivateTransfer, countTransferDrops,
  rotatedCardBounds, boundsOverlap, findFreeSpot
} from "../scripts/private-transfer.mjs";
import { privateStore } from "../scripts/store/private-store.mjs";
import { t } from "../scripts/i18n.mjs";
import { getLayout } from "../scripts/layouts/registry.mjs";
import { tiltForSkin } from "../scripts/skins/registry.mjs";
import { mainPinWorld, originFromBox } from "../scripts/sizing/geometry.mjs";

const sender = makeUser("TransferSender01", { name: "Sender" });
const recipient = makeUser("TransferRecipient01", { name: "Recipient" });
const env = installFoundry({ user: sender, users: [sender, recipient] });
const containers = await makeContainers(env);

const NOTE_KEYS = [
  "attachment", "authorId", "body", "createdAt", "id", "layout", "links", "revision",
  "schemaVersion", "skin", "updatedAt"
];
const CARD_KEYS = [
  "anchors", "autoSizeOrigin", "ports", "rotation", "sizing", "x", "y"
];
const FORBIDDEN_NOTE_KEYS = [
  "title", "kind", "style", "presentation", "blocks", "image", "backgroundImage",
  "label", "nameGenerated", "forceExtended", "formerNames", "hint", "hidden",
  "contributions", "deleted", "lastSave"
];

function note(id, body, extra = {}) {
  return {
    schemaVersion: NOTE_SCHEMA_VERSION,
    id,
    body,
    revision: extra.revision ?? 4,
    layout: extra.layout ?? "plain",
    skin: {
      paper: "amber",
      font: "handwritten",
      torn: false,
      backgroundImage: null,
      tiltSeed: 7,
      ...extra.skin
    },
    attachment: {
      mainPinEnabled: true,
      mainSnapRadius: 24,
      minorSnapRadius: 6,
      pinStyle: "brass",
      ...extra.attachment
    },
    links: extra.links ?? [],
    authorId: "TransferSender01",
    createdAt: 100,
    updatedAt: 200,
    deleted: null,
    lastSave: null
  };
}

function card(x, y, extra = {}) {
  return {
    x,
    y,
    sizing: extra.sizing ?? { mode: "manual", width: 300, minHeight: 150 },
    autoSizeOrigin: extra.autoSizeOrigin ?? { x: x + 120, y },
    rotation: extra.rotation ?? 0,
    ports: extra.ports ?? ["left", "top"],
    anchors: extra.anchors ?? {
      main: { kind: "main", x: 0.5, y: 0, createdBy: "TransferSender01" },
      "pin-anchor": { kind: "minor", x: 0.2, y: 0.3, createdBy: "TransferSender01" }
    }
  };
}

function workspace() {
  const alphaLinks = [
    {
      id: "link-internal",
      targetId: "beta",
      label: "To beta",
      direction: "one",
      color: "#b85347",
      lineStyle: "dashed",
      origin: "drawn",
      edited: true,
      createdBy: "TransferSender01",
      sourceAnchorId: "pin-anchor",
      targetAnchorId: "main",
      sourcePinRef: "p:pinAlpha",
      targetPinRef: "n:beta:main",
      routeAnchors: [
        { noteId: "beta", anchorId: "main" },
        { noteId: "outside", anchorId: "main" }
      ],
      material: "double",
      thickness: 3,
      slack: 20,
      pattern: "interrupted",
      ends: "loose",
      secondaryColor: "#c79848",
      pins: [{ x: 0.25, y: 0.5 }],
      hint: true,
      hidden: true
    },
    {
      id: "link-external",
      targetId: "outside",
      label: "External",
      direction: "two",
      hint: true,
      routeAnchors: [{ noteId: "outside", anchorId: "main" }]
    }
  ];
  return {
    format: 3,
    notes: {
      alpha: note("alpha", "# Alpha\n\nVisible body", { links: alphaLinks }),
      beta: note("beta", "Plain beta body", { revision: 9 }),
      outside: note("outside", "Outside body")
    },
    layout: {
      cards: {
        alpha: card(100, 200),
        beta: card(500, 200, { rotation: 5 }),
        outside: card(900, 200)
      },
      labels: {
        "label-alpha": {
          text: "Attached alpha", x: 1, y: 2, size: 16, color: "#c79848",
          stamp: "skull", noteId: "alpha", corner: "bottom-left"
        },
        "label-free": {
          text: "Free label", x: 0, y: 0, size: 14, color: "", stamp: "",
          noteId: "", corner: "bottom-right"
        },
        "label-outside": {
          text: "Outside label", x: 0, y: 0, size: 14, color: "", stamp: "",
          noteId: "outside", corner: "bottom-right"
        }
      },
      pins: {
        pinAlpha: { noteId: "alpha", x: 0.25, y: 0.75, isDefault: false },
        pinBeta: { noteId: "beta", x: 0.5, y: 0.5, isDefault: false },
        pinAlphaOrphan: { noteId: "alpha", x: 0.4, y: 0.4, isDefault: false },
        pinFree: { noteId: "", x: 40, y: 60, isDefault: false },
        pinOutside: { noteId: "outside", x: 0.5, y: 0.5, isDefault: false }
      },
      pinLinks: {
        internal: { source: "p:pinAlpha", target: "p:pinBeta" },
        external: { source: "p:pinAlpha", target: "p:pinOutside" },
        orphan: { source: "p:pinAlphaOrphan", target: "p:pinOutside" },
        free: { source: "p:pinFree", target: "p:pinBeta" },
        anchorRef: { source: "n:alpha:pin-anchor", target: "n:beta:main" }
      },
      viewport: { x: 3, y: 4, zoom: 2 }
    },
    trash: [],
    history: {
      alpha: [{
        id: "snap-alpha", at: 50, authorId: "TransferSender01", revision: 4,
        body: "# Alpha\n\nOld private body"
      }]
    }
  };
}

function emptyWorkspace() {
  return {
    format: 3,
    notes: {},
    layout: { cards: {}, labels: {}, pins: {}, pinLinks: {}, viewport: null },
    trash: [],
    history: {}
  };
}

function build(source = workspace(), ids = ["alpha", "beta"]) {
  return buildPrivateTransfer(source, ids, {
    fromUserId: sender.id,
    toUserId: recipient.id
  });
}

test("packs a transferVersion 2 envelope with only v2 note/card/link fields", () => {
  const source = workspace();
  const packed = build(source);

  assert.equal(packed.transferVersion, TRANSFER_VERSION);
  assert.equal(packed.transferVersion, 2);
  assert.deepEqual(packed.summary, {
    count: 2,
    titles: ["Alpha", "Plain beta body"],
    droppedLinks: 1,
    droppedWaypoints: 1
  });
  assert.ok(!JSON.stringify(packed.summary).includes("Visible body"),
    "the summary carries only derived titles, never the body");

  const alpha = packed.notes.find(entry => entry.note.id === "alpha");
  const beta = packed.notes.find(entry => entry.note.id === "beta");
  assert.deepEqual(Object.keys(alpha.note).sort(), NOTE_KEYS);
  for (const key of FORBIDDEN_NOTE_KEYS) {
    assert.equal(Object.hasOwn(alpha.note, key), false, `note payload must not carry ${key}`);
  }
  assert.equal(alpha.note.revision, 0, "copies always start at revision zero");
  assert.equal(alpha.note.body, "# Alpha\n\nVisible body");
  assert.equal(alpha.note.layout, "plain");
  assert.equal(alpha.note.skin.paper, "amber");
  assert.equal(alpha.note.attachment.pinStyle, "brass");
  assert.equal(alpha.note.links.length, 2);
  assert.equal(beta.note.revision, 0);

  assert.deepEqual(Object.keys(alpha.card).sort(), CARD_KEYS);
  assert.deepEqual(alpha.card.sizing, { mode: "manual", width: 300, minHeight: 150 });
  assert.deepEqual(alpha.card.ports, ["left", "top"]);
  assert.deepEqual(Object.keys(alpha.card.anchors).sort(), ["main", "pin-anchor"]);
  assert.equal(Object.hasOwn(alpha.card, "width"), false);
  assert.equal(Object.hasOwn(alpha.card, "height"), false);
  assert.equal(Object.hasOwn(alpha.card, "style"), false);

  const serialized = JSON.stringify(packed);
  for (const stale of [
    "GM SECRET", "\"blocks\"", "\"title\"", "\"presentation\"", "\"hint\"",
    "\"hidden\"", "\"nameGenerated\"", "\"forceExtended\"", "\"formerNames\""
  ]) {
    assert.ok(!serialized.includes(stale), `legacy field ${stale} never enters the payload`);
  }
  assert.ok(!serialized.includes("Free label"), "free labels never travel");
  assert.ok(!serialized.includes("Outside label"), "labels of unselected notes never travel");

  // Packing snapshots the source; mutating the payload never reaches it.
  alpha.note.body = "mutated payload";
  assert.equal(source.notes.alpha.body, "# Alpha\n\nVisible body");
  assert.equal(source.notes.alpha.revision, 4);
});

test("derived titles cover empty and image-only notes without leaking bodies", () => {
  const source = emptyWorkspace();
  source.notes.empty = note("empty", "");
  source.notes.image = note("image", "![alt](worlds/pic.webp)");
  source.layout.cards.empty = card(0, 0);
  source.layout.cards.image = card(300, 0);
  const packed = build(source, ["empty", "image"]);
  assert.deepEqual(packed.summary.titles, [
    t("JN.Search.EmptyNote"), t("JN.Search.ImageNote")
  ]);
  assert.equal(JSON.stringify(packed.summary).includes("worlds/pic.webp"), false);
});

test("limits and unsupported versions are rejected without migration", () => {
  const source = workspace();
  assert.throws(() => build(source, Array.from({ length: MAX_TRANSFER_NOTES + 1 },
    (_, index) => `note-${index}`)), new RegExp(`at most ${MAX_TRANSFER_NOTES}`, "i"));

  const hugeBody = emptyWorkspace();
  hugeBody.notes.huge = note("huge", "x".repeat(MAX_TRANSFER_BODY + 1));
  assert.throws(() => build(hugeBody, ["huge"]), new RegExp(`${MAX_TRANSFER_BODY}`, "i"));

  const hugeTotal = emptyWorkspace();
  const half = Math.ceil(MAX_TRANSFER_TEXT / 2) + 1;
  hugeTotal.notes.one = note("one", "x".repeat(half));
  hugeTotal.notes.two = note("two", "y".repeat(half));
  assert.throws(() => build(hugeTotal, ["one", "two"]),
    new RegExp(`${MAX_TRANSFER_TEXT}`, "i"));

  const tooManyLabels = emptyWorkspace();
  tooManyLabels.notes.alpha = note("alpha", "Alpha");
  for (let index = 0; index <= MAX_TRANSFER_LABELS; index++) {
    tooManyLabels.layout.labels[`label-${index}`] = {
      text: `Label ${index}`, x: index, y: index, size: 14, color: "", stamp: "",
      noteId: "alpha", corner: "bottom-right"
    };
  }
  assert.throws(() => build(tooManyLabels, ["alpha"]),
    new RegExp(`${MAX_TRANSFER_LABELS}`, "i"));

  const legacyNote = emptyWorkspace();
  legacyNote.notes.legacy = { ...note("legacy", "old"), schemaVersion: 1 };
  assert.throws(() => build(legacyNote, ["legacy"]), /schema v2/i);

  const oldTransfer = { ...build(source, ["alpha"]), transferVersion: 1 };
  assert.throws(() => importPrivateTransfer(emptyWorkspace(), oldTransfer, recipient.id),
    /Unsupported transfer format/i);

  const legacyPayload = build(source, ["alpha"]);
  legacyPayload.notes[0].note = { ...legacyPayload.notes[0].note, schemaVersion: 1 };
  assert.throws(() => importPrivateTransfer(emptyWorkspace(), legacyPayload, recipient.id),
    /schema v2/i);
});

test("import allocates fresh ids and remaps links, routes, pins, labels and anchors", () => {
  const source = workspace();
  const sourceBefore = JSON.stringify(source);
  const packed = build(source);
  const packedBefore = JSON.stringify(packed);
  const destination = emptyWorkspace();
  const imported = importPrivateTransfer(destination, packed, recipient.id);

  assert.equal(imported.imported.length, 2);
  assert.equal(imported.droppedLinks, 1);
  assert.equal(imported.droppedWaypoints, 1);
  assert.deepEqual(destination, emptyWorkspace(), "the destination workspace is not mutated");
  assert.equal(JSON.stringify(source), sourceBefore, "the source workspace is untouched");
  assert.equal(JSON.stringify(packed), packedBefore, "the transfer payload is not mutated");

  const [alphaId, betaId] = imported.imported;
  assert.notEqual(alphaId, "alpha");
  assert.notEqual(betaId, "beta");
  assert.equal(Object.hasOwn(imported.workspace.notes, "alpha"), false);
  assert.ok(Object.hasOwn(imported.workspace.notes, alphaId));

  const alpha = imported.workspace.notes[alphaId];
  const beta = imported.workspace.notes[betaId];
  assert.equal(alpha.revision, 0);
  assert.equal(beta.revision, 0);
  assert.equal(alpha.authorId, recipient.id);
  assert.equal(beta.authorId, recipient.id);
  assert.equal(alpha.schemaVersion, 2);
  assert.equal(alpha.links.length, 1, "the external link is dropped");
  const link = alpha.links[0];
  assert.notEqual(link.id, "link-internal");
  assert.equal(link.targetId, betaId);
  assert.equal(link.createdBy, recipient.id);
  assert.deepEqual(link.routeAnchors, [{ noteId: betaId, anchorId: "main" }]);
  assert.equal(link.sourcePinRef.startsWith("p:"), true);
  assert.notEqual(link.sourcePinRef, "p:pinAlpha");
  assert.equal(link.targetPinRef, `n:${betaId}:main`);
  assert.equal(link.material, "double");
  assert.equal(link.pattern, "interrupted");
  assert.equal(link.ends, "loose");
  assert.equal(link.pins[0].x, 0.25);
  assert.equal(Object.hasOwn(link, "hint"), false);
  assert.equal(Object.hasOwn(link, "hidden"), false);

  const card = imported.workspace.layout.cards[alphaId];
  assert.deepEqual(Object.keys(card).sort(), CARD_KEYS);
  assert.deepEqual(card.sizing, { mode: "manual", width: 300, minHeight: 150 });
  assert.deepEqual(Object.keys(card.anchors).sort(), ["main", "pin-anchor"]);
  assert.equal(card.anchors["pin-anchor"].x, 0.2);
  assert.equal(card.anchors["pin-anchor"].createdBy, recipient.id);

  const labels = Object.entries(imported.workspace.layout.labels);
  assert.equal(labels.length, 1);
  assert.notEqual(labels[0][0], "label-alpha");
  assert.equal(labels[0][1].noteId, alphaId);
  assert.equal(labels[0][1].stamp, "skull");

  const pins = Object.entries(imported.workspace.layout.pins);
  assert.equal(pins.length, 2, "only pins referenced by a transferred pin link travel");
  assert.deepEqual(pins.map(([, pin]) => pin.noteId).sort(), [alphaId, betaId].sort());
  assert.ok(pins.every(([id]) => id !== "pinAlpha" && id !== "pinBeta"));
  assert.ok(!pins.some(([id]) => id === "pinAlphaOrphan" || id === "pinFree"));

  const pinLinks = Object.entries(imported.workspace.layout.pinLinks);
  assert.equal(pinLinks.length, 2, "the internal board link and the anchor-ref link survive");
  for (const [id, pinLink] of pinLinks) {
    assert.notEqual(id, "internal");
    assert.notEqual(id, "anchorRef");
    if (pinLink.source.startsWith("p:")) {
      assert.ok(pins.some(([pinId]) => `p:${pinId}` === pinLink.source));
    }
    if (pinLink.source.startsWith("n:")) {
      assert.equal(pinLink.source, `n:${alphaId}:pin-anchor`);
    }
    if (pinLink.target.startsWith("n:")) {
      assert.equal(pinLink.target, `n:${betaId}:main`);
    }
  }

  assert.equal(imported.workspace.history[alphaId], undefined,
    "a copy starts with no source history");
  assert.equal(imported.workspace.history.alpha, undefined);
  assert.deepEqual(imported.workspace.layout.viewport, null);

  // A second import gets another complete set of fresh ids without collisions.
  const second = importPrivateTransfer(imported.workspace, packed, recipient.id);
  assert.equal(second.imported.length, 2);
  assert.equal(new Set([
    ...imported.imported, ...second.imported,
    ...Object.keys(imported.workspace.notes)
  ]).size, 4);
});

test("orphan, board-only and free pins stay behind while referenced attached pins travel", () => {
  const packed = build(workspace(), ["alpha", "beta"]);
  const alpha = packed.notes.find(entry => entry.note.id === "alpha");
  const beta = packed.notes.find(entry => entry.note.id === "beta");
  assert.deepEqual(Object.keys(alpha.pins).sort(), ["pinAlpha"]);
  assert.deepEqual(Object.keys(beta.pins).sort(), ["pinBeta"]);
  assert.deepEqual(Object.keys(packed.pinLinks).sort(), ["anchorRef", "internal"]);
  assert.ok(!JSON.stringify(packed).includes("pinAlphaOrphan"));
  assert.ok(!JSON.stringify(packed).includes("pinFree"));
});

test("import places rotated cards with v2 sizing and preserves origin translation", () => {
  const source = emptyWorkspace();
  source.notes.tall = note("tall", "Tall rotated");
  source.layout.cards.tall = card(0, 110, {
    sizing: { mode: "manual", width: 200, minHeight: 80 },
    rotation: 90,
    autoSizeOrigin: { x: 80, y: 110 }
  });
  const destination = emptyWorkspace();
  destination.notes.blocker = note("blocker", "Blocker");
  destination.layout.cards.blocker = card(0, 0, {
    sizing: { mode: "manual", width: 200, minHeight: 100 },
    rotation: 0,
    autoSizeOrigin: { x: 100, y: 0 }
  });

  const packed = build(source, ["tall"]);
  const result = importPrivateTransfer(destination, packed, recipient.id);
  const placed = result.workspace.layout.cards[result.imported[0]];
  const blocker = result.workspace.layout.cards.blocker;
  assert.equal(placed.rotation, 90);
  assert.deepEqual(placed.sizing, { mode: "manual", width: 200, minHeight: 80 });
  assert.equal(boundsOverlap(
    rotatedCardBounds(placed, result.workspace.notes[result.imported[0]]),
    rotatedCardBounds(blocker, destination.notes.blocker)
  ), false, "the rotated candidate reserves its true world-space footprint");
  assert.notDeepEqual({ x: placed.x, y: placed.y }, { x: 0, y: 110 });
  assert.equal(placed.autoSizeOrigin.x - placed.x, 80, "the main-pin origin translates with the card");
  assert.equal(placed.autoSizeOrigin.y - placed.y, 0);
});

test("findFreeSpot understands existing v2 automatic card footprints", () => {
  const existing = { x: 0, y: 0, sizing: { mode: "auto", width: null, minHeight: null }, rotation: 0 };
  const existingNote = note("existing", "Auto");
  const spot = findFreeSpot({ existing }, 300, 150, 0, 0, 0, {
    notes: { existing: existingNote }
  });
  assert.notDeepEqual(spot, { x: 0, y: 0 });
  const candidate = rotatedCardBounds({
    ...spot, sizing: { mode: "manual", width: 300, minHeight: 150 }, rotation: 0
  });
  assert.equal(boundsOverlap(candidate, rotatedCardBounds(existing, existingNote)), false);
});

test("receipt-protected acceptance imports once and duplicate acceptance cannot duplicate notes", async () => {
  const sourcePage = await privateStore.createFor(sender);
  await privateStore.save(sourcePage, workspace(), 0);
  const sourceBefore = JSON.stringify(privateStore.read(sourcePage));
  const packed = build(workspace());
  const transferId = "TransferV2Receipt01";
  await privateStore.addTransfer({ id: transferId, ...packed });

  const accepted = await privateStore.acceptTransfer(transferId, recipient.id);
  assert.equal(accepted.count, 2);
  const recipientPage = privateStore.findActive(recipient.id);
  const after = privateStore.read(recipientPage);
  assert.equal(Object.keys(after.notes).length, 2);
  const importedAlpha = Object.values(after.notes).find(value => value.body.includes("Alpha"));
  assert.ok(importedAlpha);
  assert.equal(importedAlpha.revision, 0);
  assert.equal(importedAlpha.authorId, recipient.id);
  assert.equal(after.history[importedAlpha.id], undefined);
  assert.equal(privateStore.acceptedTransfers(recipientPage).includes(transferId), true);
  assert.equal(JSON.stringify(privateStore.read(sourcePage)), sourceBefore,
    "acceptance leaves the sender workspace unchanged");

  const countBefore = Object.keys(privateStore.read(recipientPage).notes).length;
  await assert.rejects(privateStore.acceptTransfer(transferId, recipient.id),
    /no longer available/i);
  assert.equal(Object.keys(privateStore.read(recipientPage).notes).length, countBefore,
    "a repeated acceptance never duplicates copied notes");
  assert.equal(privateStore.transfer(transferId), null);
});

test("countTransferDrops reports external links and waypoints only", () => {
  assert.deepEqual(countTransferDrops(workspace(), ["alpha", "beta"]), {
    droppedLinks: 1,
    droppedWaypoints: 1
  });
});

test("createNote seeds autoSizeOrigin at the rotated main-pin world point", async () => {
  const socket = await import("../scripts/socket.mjs");
  socket.registerSocket();
  const layoutPage = containers.shared.pages.get(containers.ids.layoutPage);
  const originalRandomID = foundry.utils.randomID;
  const wasGM = sender.isGM;
  sender.isGM = true;

  const create = (requestId, paper, x, y) => socket.requestEditReply({
    type: "createNote",
    requestId,
    body: `${paper} note`,
    layout: "plain",
    skin: { paper, font: "default", torn: false, backgroundImage: null, tiltSeed: 0 },
    x,
    y
  });

  try {
    foundry.utils.randomID = () => "OriginAmber00001";
    const amber = await create("OriginCreateAmber", "amber", 40, 50);
    assert.equal(amber.type, "noteCreated");
    assert.equal(amber.noteId, "OriginAmber00001");

    const amberPage = containers.shared.pages.get(amber.noteId);
    const amberCard = layoutPage.system.cards[amber.noteId];
    const definition = getLayout(amberPage.system.layout);
    const initialHeight = definition.minHeight ?? 120;
    const rotation = amberCard.rotation;
    assert.equal(rotation, tiltForSkin(amberPage.system.skin));
    assert.notEqual(rotation, 0, "the Amber seed must tilt this card");
    assert.equal(amberCard.x, 40, "x stays the unrotated top-left");
    assert.equal(amberCard.y, 50, "y stays the unrotated top-left");

    const box = {
      x: amberCard.x, y: amberCard.y, w: definition.widths[0], h: initialHeight, rotation
    };
    assert.deepEqual(amberCard.autoSizeOrigin, originFromBox(box, rotation));
    assert.deepEqual(amberCard.autoSizeOrigin, mainPinWorld(amberCard, box));

    const radians = rotation * Math.PI / 180;
    assert.equal(amberCard.autoSizeOrigin.x,
      40 + definition.widths[0] / 2 + (initialHeight / 2) * Math.sin(radians));
    assert.equal(amberCard.autoSizeOrigin.y,
      50 + initialHeight / 2 - (initialHeight / 2) * Math.cos(radians));

    foundry.utils.randomID = () => "CreamOrigin00001";
    const cream = await create("OriginCreateCream", "cream", 10, 20);
    assert.equal(cream.type, "noteCreated");
    const creamPage = containers.shared.pages.get(cream.noteId);
    const creamCard = layoutPage.system.cards[cream.noteId];
    const creamWidth = getLayout(creamPage.system.layout).widths[0];
    assert.equal(creamCard.rotation, 0);
    assert.deepEqual(creamCard.autoSizeOrigin, { x: 10 + creamWidth / 2, y: 20 });
  } finally {
    foundry.utils.randomID = originalRandomID;
    sender.isGM = wasGM;
  }
});
