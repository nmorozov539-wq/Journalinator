const fields = foundry.data.fields;

export default class LayoutModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      cards: new fields.TypedObjectField(new fields.SchemaField({
        x: new fields.NumberField({ required: true, initial: 0 }),
        y: new fields.NumberField({ required: true, initial: 0 }),
        width: new fields.NumberField({ required: false, nullable: true, initial: null }),
        height: new fields.NumberField({ required: false, nullable: true, initial: null }),
        rotation: new fields.NumberField({ required: true, initial: 0 })
      })),
      labels: new fields.TypedObjectField(new fields.SchemaField({
        text: new fields.StringField({ required: true, blank: true, initial: "" }),
        x: new fields.NumberField({ required: true, initial: 0 }),
        y: new fields.NumberField({ required: true, initial: 0 }),
        size: new fields.NumberField({ required: true, initial: 12 }),
        color: new fields.StringField({ required: false, blank: true, initial: "" })
      })),
      viewport: new fields.SchemaField({
        x: new fields.NumberField({ required: true, initial: 0 }),
        y: new fields.NumberField({ required: true, initial: 0 }),
        zoom: new fields.NumberField({ required: true, initial: 1 })
      }, { required: false, nullable: true, initial: null })
    };
  }
}
