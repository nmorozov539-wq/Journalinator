const fields = foundry.data.fields;

/** The entire private canvas is one profile-private object per workspace. */
export const EMPTY_WORKSPACE = Object.freeze({
  format: 1,
  notes: {},
  layout: { cards: {}, labels: {}, viewport: null },
  trash: []
});

export default class PrivateWorkspaceModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      workspace: new fields.ObjectField({ required: true, initial: () => structuredClone(EMPTY_WORKSPACE) })
    };
  }
}
