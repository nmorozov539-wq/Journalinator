import { DEFAULT_STAMP_CORNER, STAMP_CORNERS } from "../stamps.mjs";
import { CARD_SIDES, DEFAULT_CARD_PORTS } from "../card-ports.mjs";

const fields = foundry.data.fields;
const anchorPosition = () => new fields.NumberField({ required: true, min: 0, max: 1 });

export default class LayoutModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      cards: new fields.TypedObjectField(new fields.SchemaField({
        x: new fields.NumberField({ required: true, initial: 0 }),
        y: new fields.NumberField({ required: true, initial: 0 }),
        width: new fields.NumberField({ required: false, nullable: true, initial: null }),
        height: new fields.NumberField({ required: false, nullable: true, initial: null }),
        rotation: new fields.NumberField({ required: true, initial: 0 }),
        ports: new fields.ArrayField(new fields.StringField({ choices: CARD_SIDES }), {
          required: false, initial: () => [...DEFAULT_CARD_PORTS]
        }),
        // Stable local attachment points. `main` is fixed to the top edge by convention;
        // `minor` anchors are arbitrary normalized positions. Only IDs are referenced by links.
        anchors: new fields.TypedObjectField(new fields.SchemaField({
          kind: new fields.StringField({ required: true, choices: ["main", "minor"], initial: "minor" }),
          x: anchorPosition(),
          y: anchorPosition(),
          createdBy: new fields.StringField({ required: false, blank: true, initial: "" })
        }), { required: false, initial: () => ({}) })
      })),
      labels: new fields.TypedObjectField(new fields.SchemaField({
        text: new fields.StringField({ required: true, blank: true, initial: "" }),
        x: new fields.NumberField({ required: true, initial: 0 }),
        y: new fields.NumberField({ required: true, initial: 0 }),
        size: new fields.NumberField({ required: true, initial: 12 }),
        color: new fields.StringField({ required: false, blank: true, initial: "" }),
        stamp: new fields.StringField({ required: false, blank: true, initial: "" }),
        noteId: new fields.StringField({ required: false, blank: true, initial: "" }),
        corner: new fields.StringField({ required: false, choices: STAMP_CORNERS, initial: DEFAULT_STAMP_CORNER })
      })),
      viewport: new fields.SchemaField({
        x: new fields.NumberField({ required: true, initial: 0 }),
        y: new fields.NumberField({ required: true, initial: 0 }),
        zoom: new fields.NumberField({ required: true, initial: 1 })
      }, { required: false, nullable: true, initial: null })
    };
  }
}
