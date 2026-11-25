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
  },
  wanted: {
    labelKey: "JN.Style.Wanted",
    cssClass: "jn-card-wanted",
    tilt: false,
    defaultWidth: 250,
    defaultHeight: 290
  },
  memo: {
    labelKey: "JN.Style.Memo",
    cssClass: "jn-card-memo",
    tilt: false,
    defaultWidth: 360,
    defaultHeight: 240
  }
};

export function cardStyleKey(style) {
  return Object.hasOwn(CARD_STYLES, style) ? style : "sticky";
}

export function seedTilt(style) {
  return CARD_STYLES[style]?.tilt ? Number((Math.random() * 5 - 2.5).toFixed(1)) : 0;
}
