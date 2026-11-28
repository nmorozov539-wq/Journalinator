import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Minimal recording stand-in for the Foundry data-field constructors used by the
 * four models. It captures constructor arguments/options; it is not a general
 * fake Foundry and does not evaluate defaults or validate values.
 */
class RecordingField {
  constructor(options = {}) {
    this.options = options;
  }
}
class StringField extends RecordingField {}
class DocumentIdField extends StringField {}
class NumberField extends RecordingField {}
class BooleanField extends RecordingField {}
class ObjectField extends RecordingField {}
class SchemaField extends RecordingField {
  constructor(schema, options = {}) {
    super(options);
    this.schema = schema;
  }
}
class ArrayField extends RecordingField {
  constructor(element, options = {}) {
    super(options);
    this.element = element;
  }
}
class TypedObjectField extends RecordingField {
  constructor(element, options = {}) {
    super(options);
    this.element = element;
  }
}

globalThis.foundry = {
  abstract: { TypeDataModel: class {} },
  data: {
    fields: {
      StringField,
      DocumentIdField,
      NumberField,
      BooleanField,
      ObjectField,
      SchemaField,
      ArrayField,
      TypedObjectField
    }
  }
};

const { default: NoteModel } = await import("../scripts/data/note-model.mjs");
const { default: LayoutModel } = await import("../scripts/data/layout-model.mjs");
const { default: HistoryModel } = await import("../scripts/data/history-model.mjs");
const { default: ActivityModel } = await import("../scripts/data/activity-model.mjs");
const { PIN_STYLES } = await import("../scripts/presentation.mjs");

const noteSchema = NoteModel.defineSchema();
const layoutSchema = LayoutModel.defineSchema();
const historySchema = HistoryModel.defineSchema();
const activitySchema = ActivityModel.defineSchema();

const keysOf = object => Object.keys(object).sort();
const kindOf = field => field.constructor.name;

function assertNumber(field, { required = true, integer = false, min, max, initial } = {}) {
  assert.equal(kindOf(field), "NumberField");
  assert.equal(field.options.required, required);
  if (integer) assert.equal(field.options.integer, true);
  if (min !== undefined) assert.equal(field.options.min, min);
  if (max !== undefined) assert.equal(field.options.max, max);
  if (initial !== undefined) assert.deepEqual(field.options.initial, initial);
}

test("NoteModel top level is exactly the schema v2 shape", () => {
  assert.deepEqual(keysOf(noteSchema), [
    "attachment", "authorId", "body", "createdAt", "deleted", "lastSave",
    "layout", "links", "revision", "schemaVersion", "skin", "updatedAt"
  ]);
  for (const removed of [
    "kind", "style", "targetHeading", "label", "presentation", "image",
    "backgroundImage", "actorRef", "blocks", "editCount", "contributions",
    "hint", "formerNames"
  ]) {
    assert.equal(Object.hasOwn(noteSchema, removed), false, `${removed} must be absent`);
  }
  assertNumber(noteSchema.schemaVersion, { min: 0, initial: 2 });
  assert.equal(noteSchema.schemaVersion.options.integer, true);
});

test("NoteModel body, revision and selected layout", () => {
  assert.equal(kindOf(noteSchema.body), "StringField");
  assert.equal(noteSchema.body.options.required, true);
  assert.equal(noteSchema.body.options.blank, true);
  assert.equal(noteSchema.body.options.initial, "");

  assertNumber(noteSchema.revision, { integer: true, min: 0, initial: 0 });

  assert.equal(kindOf(noteSchema.layout), "StringField");
  assert.equal(noteSchema.layout.options.required, true);
  assert.deepEqual(noteSchema.layout.options.choices, ["plain", "profile"]);
  assert.equal(noteSchema.layout.options.initial, "plain");
});

test("NoteModel skin carries validated appearance defaults only", () => {
  const skin = noteSchema.skin;
  assert.equal(kindOf(skin), "SchemaField");
  assert.equal(skin.options.required, true);
  assert.deepEqual(keysOf(skin.schema), [
    "backgroundImage", "font", "paper", "tiltSeed", "torn"
  ]);

  assert.deepEqual(skin.schema.paper.options.choices, ["cream", "amber", "parchment"]);
  assert.equal(skin.schema.paper.options.initial, "amber");
  assert.deepEqual(skin.schema.font.options.choices, ["default", "serif", "handwritten", "display"]);
  assert.equal(skin.schema.font.options.initial, "default");
  assert.equal(kindOf(skin.schema.torn), "BooleanField");
  assert.equal(skin.schema.torn.options.initial, false);

  const background = skin.schema.backgroundImage;
  assert.equal(kindOf(background), "StringField");
  assert.equal(background.options.required, false);
  assert.equal(background.options.blank, true);
  assert.equal(background.options.nullable, true);
  assert.equal(background.options.initial, null);

  assertNumber(skin.schema.tiltSeed, { integer: true, min: 0, initial: 0 });
});

test("NoteModel attachment configuration is preserved", () => {
  const attachment = noteSchema.attachment;
  assert.deepEqual(keysOf(attachment.schema), [
    "mainPinEnabled", "mainSnapRadius", "minorSnapRadius", "pinStyle"
  ]);
  assert.equal(attachment.schema.mainPinEnabled.options.initial, true);
  assertNumber(attachment.schema.mainSnapRadius, { min: 0, max: 64, initial: 24 });
  assertNumber(attachment.schema.minorSnapRadius, { min: 0, max: 32, initial: 6 });
  assert.deepEqual(attachment.schema.pinStyle.options.choices, PIN_STYLES);
});

test("NoteModel links keep thread geometry and drop secrecy fields", () => {
  const links = noteSchema.links;
  assert.equal(kindOf(links), "ArrayField");
  const link = links.element;
  assert.equal(kindOf(link), "SchemaField");
  assert.equal(Object.hasOwn(link.schema, "hint"), false);
  for (const removed of ["hidden", "secret", "secretTitle", "gmOnly"]) {
    assert.equal(Object.hasOwn(link.schema, removed), false, `${removed} must be absent`);
  }
  assert.deepEqual(keysOf(link.schema), [
    "color", "createdBy", "direction", "edited", "ends", "id", "label",
    "lineStyle", "material", "origin", "pattern", "pins", "routeAnchors",
    "secondaryColor", "slack", "sourceAnchorId", "sourcePinRef", "sourcePoint",
    "sourceSide", "targetAnchorId", "targetId", "targetPinRef", "targetPoint",
    "targetSide", "thickness"
  ]);
  assert.equal(link.schema.pins.options.maxLength, 24);
  assertNumber(link.schema.pins.element.schema.x, { min: -1000000, max: 1000000 });
  assert.equal(link.schema.routeAnchors.options.maxLength, 24);
  assert.equal(kindOf(link.schema.routeAnchors.element.schema.noteId), "DocumentIdField");
});

test("NoteModel lastSave is the nullable autosave receipt", () => {
  const lastSave = noteSchema.lastSave;
  assert.equal(kindOf(lastSave), "SchemaField");
  assert.equal(lastSave.options.required, false);
  assert.equal(lastSave.options.nullable, true);
  assert.equal(lastSave.options.initial, null);
  assert.deepEqual(keysOf(lastSave.schema), [
    "at", "bodyHash", "clientSessionId", "eventIds", "requestId", "revision", "sequence"
  ]);
  for (const key of ["requestId", "clientSessionId", "bodyHash"]) {
    assert.equal(kindOf(lastSave.schema[key]), "StringField");
    assert.equal(lastSave.schema[key].options.blank, true);
    assert.equal(lastSave.schema[key].options.initial, "");
  }
  assertNumber(lastSave.schema.sequence, { integer: true, min: 0, initial: 0 });
  assertNumber(lastSave.schema.revision, { integer: true, min: 0, initial: 0 });
  assertNumber(lastSave.schema.at);
  const eventIds = lastSave.schema.eventIds;
  assert.equal(kindOf(eventIds), "ArrayField");
  assert.equal(eventIds.options.maxLength, 32);
  assert.deepEqual(eventIds.options.initial, []);
  assert.equal(kindOf(eventIds.element), "StringField");
});

test("NoteModel identity, timestamps and trash state are preserved", () => {
  for (const key of ["authorId", "createdAt", "updatedAt"]) {
    assert.equal(noteSchema[key].options.required, true);
  }
  assert.equal(kindOf(noteSchema.authorId), "StringField");
  assert.equal(kindOf(noteSchema.createdAt), "NumberField");
  assert.equal(kindOf(noteSchema.updatedAt), "NumberField");
  assert.equal(noteSchema.deleted.options.required, false);
  assert.equal(noteSchema.deleted.options.nullable, true);
  assert.equal(noteSchema.deleted.options.initial, null);
  assert.deepEqual(keysOf(noteSchema.deleted.schema), ["at", "by", "lastCard", "undoId"]);
});

test("LayoutModel cards store sizing intent, not derived width/height", () => {
  assertNumber(layoutSchema.schemaVersion, { min: 0, initial: 2 });
  assert.equal(layoutSchema.schemaVersion.options.integer, true);
  assert.deepEqual(keysOf(layoutSchema), [
    "cards", "labels", "pinLinks", "pins", "schemaVersion", "viewport"
  ]);

  const card = layoutSchema.cards.element;
  assert.deepEqual(keysOf(card.schema), [
    "anchors", "autoSizeOrigin", "ports", "rotation", "sizing", "x", "y"
  ]);
  assert.equal(Object.hasOwn(card.schema, "width"), false);
  assert.equal(Object.hasOwn(card.schema, "height"), false);

  const sizing = card.schema.sizing;
  assert.deepEqual(keysOf(sizing.schema), ["minHeight", "mode", "width"]);
  assert.deepEqual(sizing.schema.mode.options.choices, ["auto", "manual"]);
  assert.equal(sizing.schema.mode.options.initial, "auto");
  for (const key of ["width", "minHeight"]) {
    assert.equal(kindOf(sizing.schema[key]), "NumberField");
    assert.equal(sizing.schema[key].options.required, false);
    assert.equal(sizing.schema[key].options.nullable, true);
    assert.equal(sizing.schema[key].options.initial, null);
  }

  const origin = card.schema.autoSizeOrigin;
  assert.equal(origin.options.required, false);
  assert.equal(origin.options.nullable, true);
  assert.equal(origin.options.initial, null);
  assert.deepEqual(keysOf(origin.schema), ["x", "y"]);
});

test("LayoutModel labels, pins, pinLinks and viewport are unchanged", () => {
  assert.deepEqual(keysOf(layoutSchema.labels.element.schema), [
    "color", "corner", "noteId", "size", "stamp", "text", "x", "y"
  ]);
  assert.deepEqual(keysOf(layoutSchema.pins.element.schema), ["isDefault", "noteId", "x", "y"]);
  assert.deepEqual(keysOf(layoutSchema.pinLinks.element.schema), [
    "color", "ends", "label", "material", "pattern", "secondaryColor", "slack", "source", "target", "thickness"
  ]);
  assert.equal(layoutSchema.viewport.options.nullable, true);
  assert.deepEqual(keysOf(layoutSchema.viewport.schema), ["x", "y", "zoom"]);
});

test("HistoryModel stores complete body snapshots per note", () => {
  assertNumber(historySchema.schemaVersion, { min: 0, initial: 2 });
  assert.deepEqual(keysOf(historySchema), ["schemaVersion", "snapshots"]);
  const entries = historySchema.snapshots.element;
  assert.equal(kindOf(entries), "ArrayField");
  const snapshot = entries.element;
  assert.deepEqual(keysOf(snapshot.schema), ["at", "authorId", "body", "id", "revision"]);
  assert.equal(kindOf(snapshot.schema.id), "StringField");
  assert.equal(snapshot.schema.id.options.required, true);
  assertNumber(snapshot.schema.at);
  assert.equal(kindOf(snapshot.schema.authorId), "StringField");
  assert.equal(snapshot.schema.authorId.options.required, true);
  assertNumber(snapshot.schema.revision, { integer: true, min: 0 });
  assert.equal(kindOf(snapshot.schema.body), "StringField");
  assert.equal(snapshot.schema.body.options.required, true);
  assert.equal(snapshot.schema.body.options.blank, true);
});

test("ActivityModel is a date/user/note counter store with no session or ranking data", () => {
  assertNumber(activitySchema.schemaVersion, { min: 0, initial: 2 });
  assert.deepEqual(keysOf(activitySchema), ["activity", "schemaVersion"]);

  const byUser = activitySchema.activity.element;
  const byNote = byUser.element;
  const counters = byNote.element;
  assert.equal(kindOf(activitySchema.activity), "TypedObjectField");
  assert.equal(kindOf(byUser), "TypedObjectField");
  assert.equal(kindOf(byNote), "TypedObjectField");
  assert.equal(kindOf(counters), "SchemaField");

  const expected = [
    "charsAdded", "charsRemoved", "imagesAdded", "largePasteCount", "notesCreated",
    "saveCount", "templateInsertCount", "threadsCreated", "titlesSet"
  ];
  assert.deepEqual(keysOf(counters.schema), expected);
  for (const key of expected) {
    assertNumber(counters.schema[key], { integer: true, min: 0, initial: 0 });
  }
  for (const removed of ["sessions", "markers", "ranking", "score"]) {
    assert.equal(Object.hasOwn(activitySchema, removed), false, `${removed} must be absent`);
  }
});
