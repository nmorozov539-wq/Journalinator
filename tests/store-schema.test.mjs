import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installFoundry, makeContainers, makeUser, JournalEntryPage
} from "./fake-foundry.mjs";

const MODULE_ID = "fvtt-journalinator";
const NOTE_TYPE = `${MODULE_ID}.note`;

const gmUser = makeUser("GMuser0000000001", { isGM: true, name: "GM" });
const env = installFoundry({ user: gmUser, users: [gmUser] });
const containers = await makeContainers(env);
const { notesStore } = await import("../scripts/store/notes-store.mjs");
const {
  NOTE_SCHEMA_VERSION, LAYOUT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, ACTIVITY_SCHEMA_VERSION,
  isCurrentNoteSystem, noteSchemaProblem, layoutSchemaProblem, worldSchemaStatus, requireWritable
} = await import("../scripts/store/schema-guard.mjs");

const live = await JournalEntryPage.create({
  name: "jn-note-live",
  type: NOTE_TYPE,
  system: {
    schemaVersion: 2,
    body: "# Live",
    revision: 3,
    layout: "profile",
    authorId: gmUser.id,
    createdAt: 10,
    updatedAt: 20
  }
}, { parent: containers.shared });

const legacy = await JournalEntryPage.create({
  name: "jn-note-legacy",
  type: NOTE_TYPE,
  system: {
    schemaVersion: 1,
    body: "# Old",
    style: "sticky",
    blocks: [{ blockId: "b1", text: "old words" }]
  }
}, { parent: containers.shared });
const legacyBefore = JSON.stringify(legacy.system);

const trashed = await JournalEntryPage.create({
  name: "jn-note-trashed",
  type: NOTE_TYPE,
  system: {
    schemaVersion: 2,
    body: "# Trashed",
    revision: 1,
    deleted: { at: 5, by: gmUser.id }
  }
}, { parent: containers.shared });

test("the store returns current v2 notes and never renders legacy block data", () => {
  const shared = notesStore.getSharedNotes();
  assert.deepEqual(new Set(shared.map(page => page.id)), new Set([live.id, legacy.id, trashed.id]));

  assert.deepEqual(notesStore.getAllNotes().map(page => page.id), [live.id]);
  assert.deepEqual(notesStore.getAllNotesIncludingTrashed().map(page => page.id),
    [live.id, legacy.id, trashed.id]);
  assert.deepEqual(notesStore.getTrashedNotes().map(page => page.id), [trashed.id]);

  assert.equal(notesStore.getNote(live.id), live);
  assert.equal(notesStore.getNote(trashed.id), trashed);
  assert.equal(notesStore.getNote(legacy.id), null);
  assert.equal(notesStore.getNote("missing"), null);
  assert.equal(notesStore.getSharedPage(legacy.id), legacy, "raw access still sees legacy pages");

  assert.equal(JSON.stringify(legacy.system), legacyBefore, "reads must not rewrite legacy data");
});

test("schema status flags incompatible data and blocks shared writes", () => {
  const status = notesStore.getSchemaStatus();
  assert.equal(status.current, false);
  assert.deepEqual(status.incompatible, [{
    id: legacy.id,
    name: legacy.name,
    code: "legacy-schema",
    kind: "note"
  }]);
  assert.equal(status.noteCount, 3);
  assert.equal(status.legacyCount, 1);
  assert.equal(notesStore.canWriteShared(), false);
  assert.deepEqual(requireWritable(status), { ok: false, reason: "incompatible-data" });
});

test("layout, activity and history getters read their hidden pages without secrets", async () => {
  const ids = containers.ids;
  const layoutPage = containers.shared.pages.get(ids.layoutPage);
  await layoutPage.update({ system: { cards: { n1: { x: 120, y: 45 } } } });

  const activityPage = containers.shared.pages.get(ids.activityPage);
  await activityPage.update({
    system: { activity: { "2026-11-28": { [gmUser.id]: { [live.id]: { saveCount: 2 } } } } }
  });

  const historyPage = containers.history.pages.get(ids.historyPage);
  await historyPage.update({
    system: {
      snapshots: {
        [live.id]: [{ id: "s1", at: 1, authorId: gmUser.id, revision: 2, body: "# Older" }]
      }
    }
  });

  assert.equal(notesStore.getSharedLayout().cards.n1.x, 120);
  assert.equal(notesStore.getLayout(), notesStore.getSharedLayout());
  assert.equal(notesStore.getActivity().activity["2026-11-28"][gmUser.id][live.id].saveCount, 2);
  assert.equal(notesStore.getHistory().snapshots[live.id][0].body, "# Older");

  assert.equal(ids.secrets, undefined);
  assert.equal(env.journal.size, 3);
  const kinds = [...env.journal.values()]
    .map(entry => entry.flags?.[MODULE_ID]?.container)
    .filter(Boolean);
  assert.deepEqual(new Set(kinds), new Set(["shared", "history", "private"]));
});

test("the schema guard is pure and bounded", () => {
  assert.deepEqual([
    NOTE_SCHEMA_VERSION, LAYOUT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, ACTIVITY_SCHEMA_VERSION
  ], [2, 2, 2, 2]);

  const valid = {
    schemaVersion: 2,
    body: "",
    revision: 0,
    layout: "plain",
    skin: { paper: "amber", font: "default", torn: false, backgroundImage: null, tiltSeed: 0 },
    attachment: { mainPinEnabled: true, mainSnapRadius: 24, minorSnapRadius: 6, pinStyle: "default" }
  };
  const page = system => ({ id: "n1", name: "jn-note-n1", system });

  assert.equal(isCurrentNoteSystem(valid), true);
  assert.equal(noteSchemaProblem(page(valid)), null);
  assert.equal(noteSchemaProblem(page({ schemaVersion: 1, blocks: [] })), "legacy-schema");
  assert.equal(noteSchemaProblem(page({ ...valid, revision: -1 })), "legacy-schema");
  assert.equal(noteSchemaProblem(page({ ...valid, body: null })), "missing-body");
  assert.equal(noteSchemaProblem(page({ ...valid, layout: "document" })), "invalid-layout");
  assert.equal(noteSchemaProblem(page({
    ...valid, skin: { paper: "document", font: "default" }
  })), "invalid-skin");
  assert.equal(noteSchemaProblem(page({ ...valid, attachment: null })), "invalid-skin");
  assert.equal(noteSchemaProblem(null), "legacy-schema");
  assert.equal(noteSchemaProblem({
    id: "old",
    name: "jn-note-old",
    _source: { system: {} },
    system: valid
  }), "legacy-schema", "the raw stored source wins over model-filled defaults");
  assert.equal(noteSchemaProblem({
    _source: { system: { ...valid, authorId: gmUser.id, createdAt: 10, updatedAt: 20 } },
    system: { ...valid, body: 4 }
  }), null);

  // A model-filled v2 default must not turn a page that never stored schemaVersion into v2.
  const { schemaVersion: _omitted, ...withoutVersion } = valid;
  assert.equal(noteSchemaProblem(page(withoutVersion)), "legacy-schema");
  assert.equal(noteSchemaProblem({
    id: "defaulted",
    name: "jn-note-defaulted",
    _source: { system: withoutVersion },
    system: valid
  }), "legacy-schema", "missing explicit version in the stored source is legacy");
  assert.equal(noteSchemaProblem(page({ ...valid, schemaVersion: 1 })), "legacy-schema");
  assert.equal(noteSchemaProblem(page({ ...valid, blocks: [], kind: "note" })), "legacy-schema");
  assert.equal(noteSchemaProblem(page({ ...valid, style: "sticky" })), "legacy-schema");

  // Foundry also defaulted schemaVersion=2 on the real legacy page in v14. The legacy core
  // page text is the remaining stored marker; current note creation never writes it.
  const legacyDocument = {
    id: "LegacyNote",
    name: "Legacy Note",
    _source: { system: valid, text: { content: "# Legacy\n\nOld body" } },
    system: valid
  };
  assert.equal(noteSchemaProblem(legacyDocument), "legacy-schema");
  const v2Document = { ...valid, authorId: gmUser.id, createdAt: 10, updatedAt: 20 };
  const currentDocument = {
    id: "CurrentNote",
    name: "jn-note-current",
    _source: { system: v2Document, text: { content: "" } },
    system: v2Document
  };
  assert.equal(noteSchemaProblem(currentDocument), null);
  assert.equal(noteSchemaProblem({
    id: "NoIdentity",
    name: "jn-note-no-identity",
    _source: { system: valid, text: { content: "" } },
    system: valid
  }), "legacy-schema", "defaulted v2 fields without v2 identity are still legacy");

  const current = worldSchemaStatus({
    notes: [page(valid)],
    layout: { id: "l1", name: "__layout__", system: { schemaVersion: 2, cards: {} } }
  });
  assert.deepEqual(current, {
    current: true, incompatible: [], noteCount: 1, legacyCount: 0
  });
  assert.deepEqual(requireWritable(current), { ok: true, reason: null });
  assert.equal(worldSchemaStatus({ notes: [], layout: null }).current, true);

  assert.equal(layoutSchemaProblem(null), null);
  assert.equal(layoutSchemaProblem({ system: { schemaVersion: 2, cards: {} } }), null);
  assert.equal(layoutSchemaProblem({ system: { cards: {} } }), "legacy-schema");
  assert.equal(layoutSchemaProblem({ system: { schemaVersion: 2, cards: [] } }), "invalid-layout");

  const incompatible = worldSchemaStatus({
    notes: [page({ schemaVersion: 1, blocks: [] })],
    layout: { id: "l1", name: "__layout__", system: { schemaVersion: 1 } }
  });
  assert.equal(incompatible.current, false);
  assert.deepEqual(incompatible.incompatible.map(entry => entry.kind), ["note", "layout"]);
  assert.deepEqual(requireWritable(incompatible), { ok: false, reason: "incompatible-data" });
  assert.deepEqual(requireWritable(null), { ok: false, reason: "incompatible-data" });
});
