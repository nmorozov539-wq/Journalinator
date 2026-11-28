/**
 * Declarative layout registry.
 *
 * Layout definitions are pure data: width steps, minimum height, paper padding and
 * the slots a valid note of that layout needs. Rendering/measurement code consumes
 * these values instead of hard-coding per-layout branches.
 */

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const LAYOUTS = deepFreeze({
  plain: {
    id: "plain",
    labelKey: "JN.Layout.Plain",
    widths: [220, 300, 380],
    minHeight: 120,
    padding: 20,
    requiredSlots: ["title"]
  },
  profile: {
    id: "profile",
    labelKey: "JN.Layout.Profile",
    widths: [300, 380],
    minHeight: 120,
    padding: 20,
    requiredSlots: ["title", "portrait"]
  }
});

export function isLayout(id) {
  return typeof id === "string" && Object.hasOwn(LAYOUTS, id);
}

/**
 * Resolves a layout definition. Unknown or missing ids fall back to Plain so
 * callers can render safely; use `isLayout()` when they need to report an invalid
 * stored value.
 */
export function getLayout(id) {
  return isLayout(id) ? LAYOUTS[id] : LAYOUTS.plain;
}

/** Accepts a layout id, a layout definition, or a note carrying `system.layout`. */
export function resolveLayout(noteOrId) {
  if (typeof noteOrId === "string") return getLayout(noteOrId);
  const id = noteOrId?.system?.layout ?? noteOrId?.layout ?? noteOrId?.id ?? null;
  return getLayout(id);
}

/** Copy of the allowed automatic width steps, smallest first. */
export function autoWidthSteps(layout) {
  return [...resolveLayout(layout).widths];
}

/**
 * Chooses the smallest permitted width that contains `intrinsicWidth` plus
 * horizontal padding. Missing/non-finite/negative intrinsic widths select the
 * layout's smallest step; content wider than the cap selects the largest step and
 * wraps vertically at render time.
 */
export function chooseAutoWidth({ layout, intrinsicWidth, padding = 40 } = {}) {
  const definition = resolveLayout(layout);
  const steps = definition.widths;
  const width = Number(intrinsicWidth);
  if (!Number.isFinite(width) || width < 0) return steps[0];
  const gap = Number.isFinite(Number(padding)) ? Math.max(0, Number(padding)) : 40;
  const required = width + gap;
  return steps.find(step => step >= required) ?? steps[steps.length - 1];
}
