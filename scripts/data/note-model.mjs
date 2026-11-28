import { CARD_SIDES, MAX_THREAD_PIN_COORDINATE, MAX_THREAD_PINS } from "../card-ports.mjs";
import {
  LINK_ENDS, LINK_MATERIALS, LINK_PATTERNS, LINK_SLACK, LINK_THICKNESS, PIN_STYLES
} from "../presentation.mjs";
import { FONTS, PAPERS } from "../skins/registry.mjs";

const fields = foundry.data.fields;

/**
 * schemaVersion 2 note.
 *
 * `body` is the sole content authority. Layout/skin are explicit visual settings;
 * titles, captions and portraits are derived from the body by the document parser
 * and are never persisted here. Thread payloads keep the pre-v2 geometry fields
 * except the former secrecy flags.
 */
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
      schemaVersion: new fields.NumberField({ required: true, integer: true, min: 0, initial: 2 }),
      body: new fields.StringField({ required: true, blank: true, initial: "" }),
      revision: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      layout: new fields.StringField({
        required: true, choices: ["plain", "profile"], initial: "plain"
      }),
      skin: new fields.SchemaField({
        paper: new fields.StringField({
          required: true, choices: Object.keys(PAPERS), initial: "amber"
        }),
        font: new fields.StringField({
          required: true, choices: Object.keys(FONTS), initial: "default"
        }),
        torn: new fields.BooleanField({ initial: false }),
        backgroundImage: new fields.StringField({
          required: false, blank: true, nullable: true, initial: null
        }),
        tiltSeed: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 })
      }, { required: true, initial: () => ({}) }),
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
        createdBy: new fields.StringField({ required: false, blank: true, initial: "" })
      })),
      authorId: new fields.StringField({ required: true }),
      createdAt: new fields.NumberField({ required: true }),
      updatedAt: new fields.NumberField({ required: true }),
      deleted: new fields.SchemaField({
        at: new fields.NumberField({ required: true }),
        by: new fields.StringField({ required: true }),
        undoId: new fields.StringField({ required: false, nullable: true, initial: null }),
        lastCard: new fields.ObjectField({ required: false })
      }, { required: false, nullable: true, initial: null }),
      /**
       * Idempotency receipt for the autosave that produced `body`/`revision`.
       * `eventIds` carries paste/template event identities for activity dedupe.
       */
      lastSave: new fields.SchemaField({
        requestId: new fields.StringField({ required: true, blank: true, initial: "" }),
        clientSessionId: new fields.StringField({ required: true, blank: true, initial: "" }),
        sequence: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        revision: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        bodyHash: new fields.StringField({ required: true, blank: true, initial: "" }),
        at: new fields.NumberField({ required: true, initial: 0 }),
        eventIds: new fields.ArrayField(new fields.StringField({ required: true }),
          { required: false, maxLength: 32, initial: [] })
      }, { required: false, nullable: true, initial: null })
    };
  }
}
