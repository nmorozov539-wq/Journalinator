const fields = foundry.data.fields;

const counter = () => new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 });

/**
 * schemaVersion 2 hidden activity store.
 *
 * Structure: activity[UTC day][userId][noteId] -> counters. Only accepted,
 * deduplicated events contribute. There is no text, session list, marker or
 * ranking data here.
 */
export default class ActivityModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      schemaVersion: new fields.NumberField({ required: true, integer: true, min: 0, initial: 2 }),
      activity: new fields.TypedObjectField(new fields.TypedObjectField(new fields.TypedObjectField(
        new fields.SchemaField({
          charsAdded: counter(),
          charsRemoved: counter(),
          saveCount: counter(),
          notesCreated: counter(),
          titlesSet: counter(),
          imagesAdded: counter(),
          threadsCreated: counter(),
          largePasteCount: counter(),
          templateInsertCount: counter()
        })
      )))
    };
  }
}
