import { CARD_SIDES, MAX_THREAD_PIN_COORDINATE, MAX_THREAD_PINS } from "../card-ports.mjs";

const fields = foundry.data.fields;
const linkPointField = () => new fields.SchemaField({
  x: new fields.NumberField({ required: true, min: 0, max: 1 }),
  y: new fields.NumberField({ required: true, min: 0, max: 1 })
}, { required: false, nullable: true, initial: null });
const pinCoordinate = () => new fields.NumberField({
  required: true, min: -MAX_THREAD_PIN_COORDINATE, max: MAX_THREAD_PIN_COORDINATE
});

export default class NoteModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      kind: new fields.StringField({ required: true, choices: ["note", "location"], initial: "note" }),
      style: new fields.StringField({ required: true, initial: "sticky" }),
      targetHeading: new fields.StringField({ required: false, blank: true, initial: "" }),
      image: new fields.StringField({ required: false, nullable: true, blank: true, initial: null }),
      backgroundImage: new fields.StringField({ required: false, nullable: true, blank: true, initial: null }),
      blocks: new fields.ArrayField(new fields.SchemaField({
        blockId: new fields.StringField({ required: true }),
        text: new fields.StringField({ required: true, blank: true, initial: "" }),
        authorId: new fields.StringField({ required: false, blank: true, initial: "" })
      })),
      links: new fields.ArrayField(new fields.SchemaField({
        id: new fields.StringField({ required: true }),
        targetId: new fields.DocumentIdField(),
        sourceSide: new fields.StringField({ required: false, nullable: true, choices: CARD_SIDES, initial: null }),
        targetSide: new fields.StringField({ required: false, nullable: true, choices: CARD_SIDES, initial: null }),
        sourcePoint: linkPointField(),
        targetPoint: linkPointField(),
        pins: new fields.ArrayField(new fields.SchemaField({ x: pinCoordinate(), y: pinCoordinate() }),
          { required: false, maxLength: MAX_THREAD_PINS, initial: [] }),
        label: new fields.StringField({ required: false, blank: true, initial: "" }),
        direction: new fields.StringField({ required: true, choices: ["none", "one", "two"], initial: "none" }),
        color: new fields.StringField({ required: false, blank: true, initial: "" }),
        lineStyle: new fields.StringField({ required: true, choices: ["solid", "dashed"], initial: "solid" }),
        origin: new fields.StringField({ required: true, choices: ["drawn", "typed"], initial: "drawn" }),
        edited: new fields.BooleanField({ initial: false }),
        createdBy: new fields.StringField({ required: false, blank: true, initial: "" }),
        hint: new fields.BooleanField({ initial: false })
      })),
      authorId: new fields.StringField({ required: true }),
      createdAt: new fields.NumberField({ required: true }),
      updatedAt: new fields.NumberField({ required: true }),
      editCount: new fields.NumberField({ required: true, initial: 0 }),
      contributions: new fields.TypedObjectField(new fields.NumberField({ initial: 0 })),
      hint: new fields.BooleanField({ initial: false }),
      formerNames: new fields.ArrayField(new fields.StringField({ required: true, blank: true }), { initial: [] }),
      deleted: new fields.SchemaField({
        at: new fields.NumberField({ required: true }),
        by: new fields.StringField({ required: true }),
        undoId: new fields.StringField({ required: false, nullable: true, initial: null }),
        lastCard: new fields.ObjectField({ required: false })
      }, { required: false, nullable: true, initial: null })
    };
  }
}
