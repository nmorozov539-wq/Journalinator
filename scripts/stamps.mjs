export const STAMP_IDS = Object.freeze([
  "sun-shield", "compass", "crowned-helm", "gauntlet", "flag",
  "round-shield", "banner", "fortress", "blades", "flame",
  "leaf", "skull", "paw", "alchemy", "sword-shield"
]);

export const STAMP_COLORS = Object.freeze({
  red: "#b85347", gold: "#c79848", green: "#53936b",
  blue: "#5a83ad", purple: "#8b69a5", silver: "#959ca6"
});

export const STAMP_CORNERS = Object.freeze(["top-left", "top-right", "bottom-left", "bottom-right"]);
export const DEFAULT_STAMP_CORNER = "bottom-right";

export function isStampCorner(corner) {
  return STAMP_CORNERS.includes(corner);
}

export function stampUrl(id) {
  return STAMP_IDS.includes(id) ? `modules/fvtt-journalinator/assets/stamps/${id}.png` : null;
}

export function attachedStampIds(labels, noteId) {
  if (!noteId) return [];
  return Object.keys(labels ?? {}).filter(id => labels[id].noteId === noteId && STAMP_IDS.includes(labels[id].stamp));
}
