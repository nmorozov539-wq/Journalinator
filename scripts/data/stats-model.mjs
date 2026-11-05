const fields = foundry.data.fields;

export default class StatsModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      activity: new fields.TypedObjectField(new fields.TypedObjectField(new fields.SchemaField({
        chars: new fields.NumberField({ required: true, initial: 0 }),
        notes: new fields.NumberField({ required: true, initial: 0 }),
        links: new fields.NumberField({ required: true, initial: 0 })
      }))),
      sessions: new fields.ArrayField(new fields.SchemaField({
        date: new fields.StringField({ required: true }),
        label: new fields.StringField({ required: false, blank: true, initial: "" })
      }))
    };
  }
}
