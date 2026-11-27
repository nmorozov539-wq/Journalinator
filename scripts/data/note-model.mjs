import { CARD_SIDES, MAX_THREAD_PIN_COORDINATE, MAX_THREAD_PINS } from "../card-ports.mjs";
import {
  LINK_ENDS, LINK_MATERIALS, LINK_PATTERNS, LINK_SLACK, LINK_THICKNESS,
  NOTE_FONT_KEYS, PICTURE_LAYOUTS, PIN_STYLES, PRESENTATION_STYLES
} from "../presentation.mjs";

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
      // Legacy storage keys. Read through presentation.mjs; kept so old worlds and old logic
      // (rename/formerNames, wikilink reconciliation) continue to work.
      style: new fields.StringField({ required: true, initial: "sticky" }),
      targetHeading: new fields.StringField({ required: false, blank: true, initial: "" }),
      schemaVersion: new fields.NumberField({ required: true, integer: true, min: 0, max: 100, initial: 0 }),
      // Optional human-visible label. Internal `name` stays the identity/wikilink key.
      label: new fields.StringField({ required: false, blank: true, initial: "" }),
      presentation: new fields.SchemaField({
        extendedStyle: new fields.StringField({
          required: false, choices: PRESENTATION_STYLES, initial: "memo"
        }),
        forceExtended: new fields.BooleanField({ initial: false }),
        font: new fields.StringField({ required: false, choices: NOTE_FONT_KEYS, initial: "default" }),
        pictureLayout: new fields.StringField({
          required: false, choices: PICTURE_LAYOUTS, initial: "above"
        }),
        torn: new fields.BooleanField({ initial: false }),
        heading: new fields.StringField({ required: false, blank: true, initial: "" }),
        nameGenerated: new fields.BooleanField({ initial: false })
      }, { required: false, initial: () => ({}) }),
      attachment: new fields.SchemaField({
        mainPinEnabled: new fields.BooleanField({ initial: true }),
        mainSnapRadius: new fields.NumberField({
          required: true, min: 0, max: 64, initial: 24
        }),
        minorSnapRadius: new fields.NumberField({
          required: true, min: 0, max: 32, initial: 6
        }),
        pinStyle: new fields.StringField({ required: false, choices: PIN_STYLES, initial: "default" })
      }, { required: false, initial: () => ({}) }),
      image: new fields.StringField({ required: false, nullable: true, blank: true, initial: null }),
      backgroundImage: new fields.StringField({ required: false, nullable: true, blank: true, initial: null }),
      // Optional read-only link to a Foundry actor. The card badge is derived at render time;
      // nothing about the actor's live state is copied into the shared journal.
      actorRef: new fields.SchemaField({
        actorId: new fields.DocumentIdField({ required: true }),
        sceneId: new fields.DocumentIdField({ required: false, nullable: true, initial: null }),
        tokenId: new fields.DocumentIdField({ required: false, nullable: true, initial: null })
      }, { required: false, nullable: true, initial: null }),
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
        // Stable note-local attachment references. Coordinates live only in the layout card's
        // anchor registry; links store IDs so resizing/rotation cannot drift duplicates.
        sourceAnchorId: new fields.StringField({ required: false, blank: true, initial: "" }),
        targetAnchorId: new fields.StringField({ required: false, blank: true, initial: "" }),
        sourcePinRef: new fields.StringField({ required: false, blank: true, initial: "" }),
        targetPinRef: new fields.StringField({ required: false, blank: true, initial: "" }),
        routeAnchors: new fields.ArrayField(new fields.SchemaField({
          noteId: new fields.DocumentIdField(),
          anchorId: new fields.StringField({ required: true })
        }), { required: false, maxLength: 24, initial: [] }),
        material: new fields.StringField({ required: false, choices: LINK_MATERIALS, initial: "linen" }),
        thickness: new fields.NumberField({
          required: true, min: LINK_THICKNESS.min, max: LINK_THICKNESS.max, initial: LINK_THICKNESS.initial
        }),
        slack: new fields.NumberField({
          required: true, min: LINK_SLACK.min, max: LINK_SLACK.max, initial: LINK_SLACK.initial
        }),
        pattern: new fields.StringField({
          required: false, choices: LINK_PATTERNS, initial: "continuous"
        }),
        ends: new fields.StringField({ required: false, choices: LINK_ENDS, initial: "standard" }),
        secondaryColor: new fields.StringField({ required: false, blank: true, initial: "" }),
        label: new fields.StringField({ required: false, blank: true, initial: "" }),
        // Preserved for old logic/history. Never rendered as an arrow or semantic direction.
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
