const fields = foundry.data.fields;

/**
 * Per-note snapshot ring buffers (spec §5.6), keyed by note id. Each entry is an opaque
 * `{ at, title, blocks }` blob — no restore UI yet, just storage, so there's no benefit to a
 * stricter schema for the blocks themselves.
 */
export default class HistoryModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      snapshots: new fields.TypedObjectField(new fields.ArrayField(new fields.ObjectField()))
    };
  }
}
