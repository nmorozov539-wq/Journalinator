/**
 * Named style definitions for note cards (spec §4.5). Adding a style — including, later, a
 * user-made HTML/CSS template — means adding an entry here, not a hardcoded branch elsewhere.
 */
export const CARD_STYLES = {
  sticky: {
    labelKey: "JN.Style.Sticky",
    cssClass: "jn-card-sticky",
    tilt: true,
    defaultWidth: 190
  },
  document: {
    labelKey: "JN.Style.Document",
    cssClass: "jn-card-document",
    tilt: false,
    defaultWidth: 245
  },
  torn: {
    labelKey: "JN.Style.Torn",
    cssClass: "jn-card-torn",
    tilt: true,
    defaultWidth: 225
  }
};

export function seedTilt(style) {
  return CARD_STYLES[style]?.tilt ? Number((Math.random() * 5 - 2.5).toFixed(1)) : 0;
}

/** Sticky notes get a small desaturated tint — rose, sage, or amber (spec §13) — picked
 * deterministically from the note's own id so it never changes on reload without being stored. */
const STICKY_TINTS = ["#3d2c31", "#2c3a31", "#3b3827"];
export function tintFor(noteId) {
  let hash = 0;
  for (let i = 0; i < noteId.length; i++) hash = (hash * 31 + noteId.charCodeAt(i)) | 0;
  return STICKY_TINTS[Math.abs(hash) % STICKY_TINTS.length];
}
