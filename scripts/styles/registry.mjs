/**
 * Named style definitions for note cards (spec §4.5). Adding a style — including, later, a
 * user-made HTML/CSS template — means adding an entry here, not a hardcoded branch elsewhere.
 */
export const CARD_STYLES = {
  sticky: {
    label: "Sticky Note",
    cssClass: "jn-card-sticky",
    tilt: true,
    defaultWidth: 190
  },
  document: {
    label: "Document",
    cssClass: "jn-card-document",
    tilt: false,
    defaultWidth: 245
  },
  torn: {
    label: "Torn Paper",
    cssClass: "jn-card-torn",
    tilt: true,
    defaultWidth: 225
  }
};

export function seedTilt(style) {
  return CARD_STYLES[style]?.tilt ? Number((Math.random() * 5 - 2.5).toFixed(1)) : 0;
}
