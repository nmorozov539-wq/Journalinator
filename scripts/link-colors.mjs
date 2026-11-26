/**
 * Link colors are theme slots, not literals. Existing worlds stored the three toolbar hexes;
 * those are mapped to slots at read time so no world-data migration is needed. Every write
 * stores a slot key (or "" for the theme's default thread color).
 */
export const LINK_COLOR_SLOTS = Object.freeze(["link1", "link2", "link3"]);

export const LEGACY_LINK_COLORS = Object.freeze({
  "#a393f2": "link1",
  "#d6a45c": "link2",
  "#d77b91": "link3"
});

const normalized = value => (typeof value === "string" ? value.trim().toLowerCase() : null);

/** "", a slot key, or a legacy hex (case-insensitive); everything else becomes "". */
export function normalizeLinkColor(value) {
  const color = normalized(value);
  if (!color) return "";
  if (LINK_COLOR_SLOTS.includes(color)) return color;
  return LEGACY_LINK_COLORS[color] ?? "";
}

/** Strict acceptance used by the write sanitizers: a value is valid only if it maps. */
export function isLinkColor(value) {
  const color = normalized(value);
  if (color === null) return false;
  return color === "" || LINK_COLOR_SLOTS.includes(color) || Object.hasOwn(LEGACY_LINK_COLORS, color);
}
