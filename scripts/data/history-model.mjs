const fields = foundry.data.fields;

/**
 * schemaVersion 2 recovery history.
 *
 * `snapshots` is keyed by note id and each entry is a complete body snapshot.
 * Newest-first ordering and the 20-entry ring are runtime conventions, not a
 * schema constraint.
 */
export default class HistoryModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      schemaVersion: new fields.NumberField({ required: true, integer: true, min: 0, initial: 2 }),
      snapshots: new fields.TypedObjectField(new fields.ArrayField(new fields.SchemaField({
        id: new fields.StringField({ required: true }),
        at: new fields.NumberField({ required: true }),
        authorId: new fields.StringField({ required: true }),
        revision: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        body: new fields.StringField({ required: true, blank: true, initial: "" })
      })))
    };
  }
}
