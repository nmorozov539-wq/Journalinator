const fields = foundry.data.fields;

export default class NoteModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      style: new fields.StringField({ required: true, initial: "sticky" }),
      image: new fields.FilePathField({ categories: ["IMAGE"], required: false, nullable: true, initial: null }),
      blocks: new fields.ArrayField(new fields.SchemaField({
        blockId: new fields.StringField({ required: true }),
        text: new fields.StringField({ required: true, blank: true, initial: "" })
      })),
      links: new fields.ArrayField(new fields.SchemaField({
        id: new fields.StringField({ required: true }),
        targetId: new fields.DocumentIdField(),
        label: new fields.StringField({ required: false, blank: true, initial: "" }),
        direction: new fields.StringField({ required: true, choices: ["none", "one", "two"], initial: "none" }),
        color: new fields.StringField({ required: false, blank: true, initial: "" }),
        lineStyle: new fields.StringField({ required: true, choices: ["solid", "dashed"], initial: "solid" }),
        origin: new fields.StringField({ required: true, choices: ["drawn", "typed"], initial: "drawn" }),
        edited: new fields.BooleanField({ initial: false }),
        createdBy: new fields.StringField({ required: false, blank: true, initial: "" })
      })),
      authorId: new fields.StringField({ required: true }),
      createdAt: new fields.NumberField({ required: true }),
      updatedAt: new fields.NumberField({ required: true }),
      editCount: new fields.NumberField({ required: true, initial: 0 }),
      contributions: new fields.TypedObjectField(new fields.NumberField({ initial: 0 })),
      deleted: new fields.SchemaField({
        at: new fields.NumberField({ required: true }),
        by: new fields.StringField({ required: true }),
        lastCard: new fields.ObjectField({ required: false })
      }, { required: false, nullable: true, initial: null })
    };
  }
}
