import { DEFAULT_STAMP_CORNER, STAMP_CORNERS } from "../stamps.mjs";
import { CARD_SIDES, DEFAULT_CARD_PORTS } from "../card-ports.mjs";

const fields = foundry.data.fields;
const anchorPosition = () => new fields.NumberField({ required: true, min: 0, max: 1 });

/**
 * schemaVersion 2 board layout.
 *
 * Cards store explicit sizing intent instead of derived width/height. In automatic
 * mode every client measures content and derives the rendered box; in manual mode
 * `sizing.width` and `sizing.minHeight` are the user's overrides. `autoSizeOrigin`
 * is the stable world point of the main pin (a virtual top-center point when the
 * main pin is disabled) used to keep the pin fixed while automatic dimensions change.
 */
export default class LayoutModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      schemaVersion: new fields.NumberField({ required: true, integer: true, min: 0, initial: 2 }),
      cards: new fields.TypedObjectField(new fields.SchemaField({
        x: new fields.NumberField({ required: true, initial: 0 }),
        y: new fields.NumberField({ required: true, initial: 0 }),
        sizing: new fields.SchemaField({
          mode: new fields.StringField({
            required: true, choices: ["auto", "manual"], initial: "auto"
          }),
          width: new fields.NumberField({ required: false, nullable: true, initial: null }),
          minHeight: new fields.NumberField({ required: false, nullable: true, initial: null })
        }, { required: true, initial: () => ({}) }),
        autoSizeOrigin: new fields.SchemaField({
          x: new fields.NumberField({ required: true, initial: 0 }),
          y: new fields.NumberField({ required: true, initial: 0 })
        }, { required: false, nullable: true, initial: null }),
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
      pins: new fields.TypedObjectField(new fields.SchemaField({
        noteId: new fields.StringField({ required: false, blank: true, initial: "" }),
        x: new fields.NumberField({ required: true }),
        y: new fields.NumberField({ required: true }),
        isDefault: new fields.BooleanField({ initial: false })
      }), { required: false, initial: () => ({}) }),
      pinLinks: new fields.TypedObjectField(new fields.SchemaField({
        source: new fields.StringField({ required: true }),
        target: new fields.StringField({ required: true }),
        label: new fields.StringField({ required: false, initial: "" }),
        color: new fields.StringField({ required: false, initial: "" }),
        secondaryColor: new fields.StringField({ required: false, initial: "" }),
        material: new fields.StringField({ required: false, initial: "linen" }),
        thickness: new fields.NumberField({ required: false, initial: 2.6 }),
        slack: new fields.NumberField({ required: false, initial: 0 }),
        pattern: new fields.StringField({ required: false, initial: "continuous" }),
        ends: new fields.StringField({ required: false, initial: "standard" })
      }), { required: false, initial: () => ({}) }),
      viewport: new fields.SchemaField({
        x: new fields.NumberField({ required: true, initial: 0 }),
        y: new fields.NumberField({ required: true, initial: 0 }),
        zoom: new fields.NumberField({ required: true, initial: 1 })
      }, { required: false, nullable: true, initial: null })
    };
  }
}
