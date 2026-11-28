import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Hooks, JournalEntryPage, installFoundry, makeContainers, makeUser
} from "./fake-foundry.mjs";

const MODULE_ID = "fvtt-journalinator";
const NOTE_TYPE = `${MODULE_ID}.note`;

const gm = makeUser("SharedGm00000001", { isGM: true, name: "GM" });
const recipient = makeUser("SharedRecipient01", { name: "Recipient" });
const env = installFoundry({ user: gm, users: [gm, recipient] });
const containers = await makeContainers(env);
const { registerSocket, requestWrite } = await import("../scripts/socket.mjs");
const { privateStore } = await import("../scripts/store/private-store.mjs");
const {
  buildSharedTransfer, importPrivateTransfer, MAX_TRANSFER_TEXT
} = await import("../scripts/private-transfer.mjs");
const edit = await import("../scripts/edit-session.mjs");
const activity = await import("../scripts/activity.mjs");
registerSocket();
activity.registerActivityHooks();

const layoutPage = () => containers.shared.pages.get(containers.ids.layoutPage);
const historyPage = () => containers.history.pages.get(containers.ids.historyPage);
const activityPage = () => containers.shared.pages.get(containers.ids.activityPage);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 1000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) return false;
    await sleep(5);
  }
  return true;
}

function skin(extra = {}) {
  return {
    paper: "amber",
    font: "default",
    torn: false,
    backgroundImage: null,
    tiltSeed: 11,
    ...extra
  };
}

function attachment(extra = {}) {
  return {
    mainPinEnabled: true,
    mainSnapRadius: 24,
    minorSnapRadius: 6,
    pinStyle: "default",
    ...extra
  };
}

function v2Card(x, y, extra = {}) {
  return {
    x,
    y,
    sizing: extra.sizing ?? { mode: "manual", width: 300, minHeight: 150 },
    autoSizeOrigin: extra.autoSizeOrigin ?? { x: x + 150, y },
    rotation: extra.rotation ?? 0,
    ports: extra.ports ?? ["right"],
    anchors: extra.anchors ?? {
      main: { kind: "main", x: 0.5, y: 0, createdBy: gm.id }
    }
  };
}

async function makeSharedNote(body, extra = {}) {
  const page = await JournalEntryPage.create({
    name: `jn-note-${foundry.utils.randomID()}`,
    type: NOTE_TYPE,
    system: {
      schemaVersion: 2,
      body,
      revision: 0,
      layout: extra.layout ?? "plain",
      skin: skin(extra.skin),
      attachment: attachment(extra.attachment),
      links: extra.links ?? [],
      authorId: gm.id,
      createdAt: 10,
      updatedAt: 20,
      deleted: null,
      lastSave: null
    }
  }, { parent: containers.shared });
  await layoutPage().update({
    [`system.cards.${page.id}`]: v2Card(extra.x ?? 0, extra.y ?? 0, extra.card)
  });
  return page;
}

function sharedBody(body) {
  return [...containers.shared.pages.values()].find(page =>
    page.type === NOTE_TYPE && page.system.body === body);
}

function pendingFor(title, userId = recipient.id) {
  return privateStore.pendingTransfers(userId)
    .find(record => record.summary?.titles?.includes(title));
}

function warnCount() {
  return env.notifications.filter(entry => entry[0] === "warn").length;
}

test("shared v2 pages pack body/layout/skin/attachment/links and transferable pins", async () => {
  const alpha = await makeSharedNote("# Shared Alpha\n\nVisible body", {
    layout: "profile",
    skin: { paper: "parchment", font: "serif", torn: true, backgroundImage: "worlds/paper.webp" },
    attachment: { pinStyle: "brass" },
    x: 100,
    y: 200,
    card: { sizing: { mode: "manual", width: 300, minHeight: 170 }, rotation: 4 }
  });
  const beta = await makeSharedNote("Shared beta body", { x: 500, y: 200 });
  const outside = await makeSharedNote("Outside body", { x: 900, y: 200 });
  alpha.system.links = [
    {
      id: "shared-internal",
      targetId: beta.id,
      label: "To beta",
      direction: "one",
      routeAnchors: [
        { noteId: beta.id, anchorId: "main" },
        { noteId: outside.id, anchorId: "main" }
      ],
      sourcePinRef: "p:alphaPin",
      targetPinRef: `n:${beta.id}:main`,
      hint: true,
      hidden: true
    },
    {
      id: "shared-external",
      targetId: outside.id,
      label: "External",
      direction: "one"
    }
  ];
  await layoutPage().update({
    "system.labels": {
      alphaLabel: {
        text: "Attached alpha", x: 1, y: 2, size: 16, color: "#c79848",
        stamp: "skull", noteId: alpha.id, corner: "bottom-right"
      },
      freeLabel: { text: "Free label", x: 0, y: 0, size: 14, color: "", stamp: "", noteId: "" },
      outsideLabel: { text: "Outside label", x: 0, y: 0, noteId: outside.id }
    },
    "system.pins": {
      alphaPin: { noteId: alpha.id, x: 0.25, y: 0.75, isDefault: false },
      betaPin: { noteId: beta.id, x: 0.5, y: 0.5, isDefault: false },
      outsidePin: { noteId: outside.id, x: 0.5, y: 0.5, isDefault: false },
      alphaOrphan: { noteId: alpha.id, x: 0.4, y: 0.4, isDefault: false },
      freePin: { noteId: "", x: 30, y: 40, isDefault: false }
    },
    "system.pinLinks": {
      internal: { source: "p:alphaPin", target: "p:betaPin" },
      external: { source: "p:alphaPin", target: "p:outsidePin" },
      orphan: { source: "p:alphaOrphan", target: "p:outsidePin" },
      free: { source: "p:freePin", target: "p:betaPin" }
    }
  });

  const packed = buildSharedTransfer(containers.shared.pages, layoutPage().system,
    [alpha.id, beta.id], { fromUserId: gm.id, toUserId: recipient.id });

  assert.equal(packed.transferVersion, 2);
  assert.deepEqual(packed.summary, {
    count: 2,
    titles: ["Shared Alpha", "Shared beta body"],
    droppedLinks: 1,
    droppedWaypoints: 1
  });
  const packedAlpha = packed.notes.find(entry => entry.note.id === alpha.id);
  assert.deepEqual(Object.keys(packedAlpha.note).sort(), [
    "attachment", "authorId", "body", "createdAt", "id", "layout", "links", "revision",
    "schemaVersion", "skin", "updatedAt"
  ]);
  assert.equal(packedAlpha.note.body, "# Shared Alpha\n\nVisible body");
  assert.equal(packedAlpha.note.layout, "profile");
  assert.equal(packedAlpha.note.skin.paper, "parchment");
  assert.equal(packedAlpha.note.attachment.pinStyle, "brass");
  assert.equal(packedAlpha.note.revision, 0);
  assert.equal(packedAlpha.note.links[0].routeAnchors.length, 2);
  assert.equal(Object.hasOwn(packedAlpha.note.links[0], "hint"), false);
  assert.equal(Object.hasOwn(packedAlpha.note.links[0], "hidden"), false);
  assert.deepEqual(packedAlpha.card.sizing, { mode: "manual", width: 300, minHeight: 170 });
  assert.equal(Object.hasOwn(packedAlpha.card, "width"), false);
  assert.deepEqual(Object.keys(packedAlpha.labels), ["alphaLabel"]);
  assert.deepEqual(Object.keys(packedAlpha.pins), ["alphaPin"]);
  assert.deepEqual(Object.keys(packed.pinLinks), ["internal"]);
  assert.ok(!JSON.stringify(packed).includes("Free label"));
  assert.ok(!JSON.stringify(packed).includes("Outside label"));

  const imported = importPrivateTransfer({
    format: 3,
    notes: {},
    layout: { cards: {}, labels: {}, pins: {}, pinLinks: {}, viewport: null },
    trash: [],
    history: {}
  }, packed, recipient.id);
  assert.equal(imported.imported.length, 2);
  assert.equal(imported.droppedLinks, 1);
  assert.equal(imported.droppedWaypoints, 1);
  const importedAlpha = imported.workspace.notes[imported.imported[0]];
  assert.equal(importedAlpha.authorId, recipient.id);
  assert.equal(importedAlpha.revision, 0);
  assert.equal(importedAlpha.links.length, 1);
  assert.equal(importedAlpha.links[0].targetId, imported.imported[1]);
  assert.equal(importedAlpha.links[0].routeAnchors.length, 1);
  assert.equal(Object.hasOwn(imported.workspace.layout.cards[imported.imported[0]], "width"), false);
});

test("shared→private send stores a v2 offer and acceptance creates an independent copy", async () => {
  const source = await makeSharedNote("# Copper Job\n\nAsk at the gate.", {
    x: 40, y: 60, card: { sizing: { mode: "manual", width: 260, minHeight: 120 } }
  });
  const before = JSON.stringify(source.system);

  await requestWrite({
    type: "sendSharedToPrivate", toUserId: recipient.id, noteIds: [source.id]
  });
  const pending = pendingFor("Copper Job");
  assert.ok(pending, "the active GM stored a pending v2 offer");
  assert.equal(pending.transferVersion, 2);
  assert.equal(pending.notes[0].note.schemaVersion, 2);
  assert.equal(pending.notes[0].note.body, "# Copper Job\n\nAsk at the gate.");
  assert.equal(Object.hasOwn(pending.notes[0].note, "blocks"), false);

  const result = await privateStore.acceptTransfer(pending.id, recipient.id);
  assert.equal(result.count, 1);
  const page = privateStore.findActive(recipient.id);
  const notes = Object.values(privateStore.read(page).notes);
  const copy = notes.find(note => note.body === "# Copper Job\n\nAsk at the gate.");
  assert.ok(copy, "the recipient receives the v2 body");
  assert.equal(copy.schemaVersion, 2);
  assert.equal(copy.revision, 0);
  assert.equal(copy.authorId, recipient.id);
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.layout, "plain");
  assert.equal(Object.hasOwn(copy, "blocks"), false);
  assert.equal(Object.hasOwn(copy, "title"), false);
  const card = privateStore.read(page).layout.cards[copy.id];
  assert.deepEqual(card.sizing, { mode: "manual", width: 260, minHeight: 120 });
  assert.equal(Object.hasOwn(card, "width"), false);
  assert.equal(JSON.stringify(source.system), before, "the shared source remains unchanged");
  assert.equal(sharedBody("# Copper Job\n\nAsk at the gate.").id, source.id);
});

test("a shared note sent to your own private canvas imports directly with no pending offer", async () => {
  await privateStore.createFor(gm);
  const source = await makeSharedNote("# Self Copy\n\nOnly the visible line.", {
    x: 0, y: 0
  });
  const pendingBefore = Object.keys(privateStore.transfers()).length;

  await requestWrite({ type: "sendSharedToPrivate", toUserId: gm.id, noteIds: [source.id] });
  assert.equal(Object.keys(privateStore.transfers()).length, pendingBefore,
    "a self-copy is never stored as a pending transfer");
  const page = privateStore.findActive(gm.id);
  const copy = Object.values(privateStore.read(page).notes)
    .find(note => note.body === "# Self Copy\n\nOnly the visible line.");
  assert.ok(copy, "the copy landed in the sender's own private page");
  assert.equal(copy.authorId, gm.id);
  assert.equal(sharedBody("# Self Copy\n\nOnly the visible line.").id, source.id);
});

test("a locked shared source is rejected before any transfer or private write", async () => {
  const source = await makeSharedNote("# Locked Source\n\nDo not copy half an edit.", {
    x: 700, y: 700
  });
  const before = JSON.stringify(source.system);
  const pendingBefore = Object.keys(privateStore.transfers()).length;
  const recipientPageBefore = privateStore.findActive(recipient.id)?.id ?? null;
  const recipientNotesBefore = recipientPageBefore
    ? Object.keys(privateStore.read(privateStore.findActive(recipient.id)).notes).length : 0;
  const lease = edit.grantLease({
    noteId: source.id,
    userId: recipient.id,
    userName: recipient.name,
    userColor: recipient.color,
    clientSessionId: "locked-source-tab",
    requestId: "locked-source-request",
    revision: 0
  });
  assert.ok(lease.lease);

  const warnings = warnCount();
  try {
    await requestWrite({
      type: "sendSharedToPrivate", toUserId: recipient.id, noteIds: [source.id]
    });
  } finally {
    const current = edit.leaseFor(source.id);
    if (current) edit.releaseLease(current, "test-cleanup");
  }
  assert.ok(warnCount() > warnings, "the sender sees a lock rejection");
  assert.equal(Object.keys(privateStore.transfers()).length, pendingBefore,
    "no pending offer was created");
  assert.equal(JSON.stringify(source.system), before, "the locked shared source is untouched");
  assert.equal(privateStore.findActive(recipient.id)?.id ?? null, recipientPageBefore);
  if (recipientPageBefore) {
    assert.equal(Object.keys(privateStore.read(privateStore.findActive(recipient.id)).notes).length,
      recipientNotesBefore, "no private copy was imported");
  }
});

test("shared→private and private→private transfers produce no shared activity", async () => {
  const source = await makeSharedNote("# Quiet Copy\n\nNo shared counters.", { x: 300, y: 700 });
  const activityBefore = JSON.stringify(activityPage().system.activity ?? {});
  const historyBefore = JSON.stringify(historyPage().system);

  await requestWrite({
    type: "sendSharedToPrivate", toUserId: recipient.id, noteIds: [source.id]
  });
  const pending = pendingFor("Quiet Copy");
  assert.ok(pending);
  await privateStore.acceptTransfer(pending.id, recipient.id);

  const gmPage = await privateStore.createFor(gm);
  const workspace = privateStore.read(gmPage);
  const made = privateStore.makeNote({
    body: "# Private Quiet\n\nPrivate body only",
    noteId: "PrivateQuiet01",
    cards: workspace.layout.cards
  });
  workspace.notes[made.note.id] = made.note;
  workspace.layout.cards[made.note.id] = made.card;
  await privateStore.save(gmPage, workspace, privateStore.flags(gmPage).rev ?? 0);
  await requestWrite({
    type: "sendPrivateTransfer", toUserId: recipient.id, noteIds: [made.note.id]
  });
  const privatePending = privateStore.pendingTransfers(recipient.id)
    .find(record => record.summary?.titles?.includes("Private Quiet"));
  assert.ok(privatePending);
  await privateStore.acceptTransfer(privatePending.id, recipient.id);

  assert.equal(JSON.stringify(activityPage().system.activity ?? {}), activityBefore,
    "private copies never write shared activity");
  assert.equal(JSON.stringify(historyPage().system), historyBefore,
    "private copies never write shared history");
});

test("private→shared publish attributes the copy to the publisher and records imported activity once", async () => {
  const gmPage = privateStore.findActive(gm.id) ?? await privateStore.createFor(gm);
  const workspace = privateStore.read(gmPage);
  const first = privateStore.makeNote({
    body: "# Publish One\n\nImported alpha body",
    noteId: "PublishNote00001",
    x: 40,
    y: 40,
    cards: workspace.layout.cards
  });
  const second = privateStore.makeNote({
    body: "Publish two body",
    noteId: "PublishNote00002",
    x: 400,
    y: 40,
    cards: { ...workspace.layout.cards, [first.note.id]: first.card }
  });
  first.note.links = [{
    id: "publish-internal",
    targetId: second.note.id,
    label: "to two",
    direction: "one",
    routeAnchors: [{ noteId: second.note.id, anchorId: "main" }]
  }];
  workspace.notes[first.note.id] = first.note;
  workspace.notes[second.note.id] = second.note;
  workspace.layout.cards[first.note.id] = first.card;
  workspace.layout.cards[second.note.id] = second.card;
  workspace.layout.labels.publishLabel = {
    text: "Published label", x: 1, y: 2, size: 14, color: "", stamp: "",
    noteId: first.note.id, corner: "bottom-right"
  };
  workspace.history[first.note.id] = [{
    id: "publish-snapshot", at: 1, authorId: gm.id, revision: 0,
    body: "# Publish One\n\nOlder private body"
  }];
  await privateStore.save(gmPage, workspace, privateStore.flags(gmPage).rev ?? 0);
  const sourceBefore = JSON.stringify(privateStore.read(gmPage));
  const sharedHistoryBefore = JSON.stringify(historyPage().system);

  const acks = [];
  const hookId = Hooks.on("journalinatorWriteApplied", message => acks.push(message));
  try {
    await requestWrite({
      type: "publishPrivateNotes",
      noteIds: [first.note.id, second.note.id]
    });
  } finally {
    Hooks.off("journalinatorWriteApplied", hookId);
  }
  const ack = acks.find(message => message.kind === "publish" && message.action === "published");
  assert.ok(ack, "the publisher receives a writeApplied acknowledgement");
  assert.equal(ack.count, 2);
  assert.equal(ack.noteIds.length, 2);

  const publishedOne = sharedBody("# Publish One\n\nImported alpha body");
  const publishedTwo = sharedBody("Publish two body");
  assert.ok(publishedOne && publishedTwo, "both private notes were published as new shared pages");
  assert.equal(publishedOne.system.authorId, gm.id);
  assert.equal(publishedOne.system.revision, 0);
  assert.equal(publishedOne.system.schemaVersion, 2);
  assert.equal(publishedOne.system.links.length, 1);
  assert.equal(publishedOne.system.links[0].targetId, publishedTwo.id,
    "links between published notes are remapped to the new shared ids");
  assert.equal(publishedOne.system.links[0].label, "to two");
  const card = layoutPage().system.cards[publishedOne.id];
  assert.deepEqual(card.sizing, first.card.sizing);
  assert.equal(Object.hasOwn(card, "width"), false);
  const label = Object.values(layoutPage().system.labels)
    .find(entry => entry.noteId === publishedOne.id && entry.text === "Published label");
  assert.ok(label, "attached labels are published with the copy");

  assert.equal(JSON.stringify(historyPage().system), sharedHistoryBefore,
    "private history is never copied into shared history");
  assert.equal(JSON.stringify(privateStore.read(gmPage)), sourceBefore,
    "the private source workspace and its history remain untouched");

  const date = activity.todayUTC();
  const oneCounters = await waitFor(() => {
    const counters = activity.activityFor(date, gm.id, publishedOne.id);
    return counters.notesCreated === 1 && counters.threadsCreated === 1;
  }) ? activity.activityFor(date, gm.id, publishedOne.id) : null;
  assert.ok(oneCounters, "the new shared note records one creation and thread");
  assert.equal(oneCounters.charsAdded, Array.from(first.note.body).length);
  assert.equal(oneCounters.threadsCreated, 1, "the imported note link records one thread");
  assert.equal(oneCounters.templateInsertCount, 0, "publishing is not a template insert");
  assert.equal(oneCounters.saveCount, 0);

  const twoCounters = activity.activityFor(date, gm.id, publishedTwo.id);
  assert.equal(twoCounters.notesCreated, 1);
  assert.equal(twoCounters.charsAdded, Array.from(second.note.body).length);
  assert.equal(twoCounters.threadsCreated, 0);
  const totalCreated = [publishedOne, publishedTwo]
    .reduce((sum, page) => sum + activity.activityFor(date, gm.id, page.id).notesCreated, 0);
  assert.equal(totalCreated, 2, "creation counters are not duplicated");
});

test("an oversized shared transfer is rejected without a pending offer", async () => {
  const source = await makeSharedNote("x".repeat(MAX_TRANSFER_TEXT + 1), { x: 1200, y: 1200 });
  const pendingBefore = Object.keys(privateStore.transfers()).length;
  const warnings = warnCount();
  await requestWrite({
    type: "sendSharedToPrivate", toUserId: recipient.id, noteIds: [source.id]
  });
  assert.ok(warnCount() > warnings);
  assert.equal(Object.keys(privateStore.transfers()).length, pendingBefore);
});
