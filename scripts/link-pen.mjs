import { isLinkColor, normalizeLinkColor } from "./link-colors.mjs";
import {
  clampThreadSlack, clampThreadThickness, THREAD_PRESETS, THREAD_PRESET_IDS, THREAD_SLACK, THREAD_THICKNESS
} from "./link-thread.mjs";
import { LINK_ENDS, LINK_MATERIALS, LINK_PATTERNS, defaultLinkCosmetics } from "./presentation.mjs";

/**
 * The link pen: the style every newly drawn thread starts with, plus the player's own saved
 * presets. It is per user (a client setting) and shared by the main and private canvases.
 *
 * Everything here is pure so it can be tested and reused by the toolbar, the right panel and the
 * wheel shortcuts. The GM never trusts a pen: the style travels with the create request and is
 * re-validated by `normalizePinLink`.
 */

export const PEN_SETTING = "linkPen";
export const MAX_PEN_PRESETS = 24;
export const MAX_PRESET_NAME = 40;

/** Wheel notch sizes. Thickness steps in tenths of a pixel, slack in whole percent. */
export const PEN_WHEEL_STEP = Object.freeze({ thickness: 0.2, slack: 0.01 });

/** The fields a pen style carries. Order matters only for stable comparisons. */
export const PEN_STYLE_KEYS = Object.freeze([
  "material", "thickness", "slack", "pattern", "ends", "color", "secondaryColor"
]);

export function defaultPenStyle() {
  return { ...defaultLinkCosmetics(), color: "" };
}

/** Coerces any value into a complete, valid pen style. */
export function normalizePenStyle(raw) {
  const base = defaultPenStyle();
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    material: LINK_MATERIALS.includes(input.material) ? input.material : base.material,
    thickness: clampThreadThickness(Number.isFinite(input.thickness) ? input.thickness : base.thickness),
    slack: clampThreadSlack(Number.isFinite(input.slack) ? input.slack : base.slack),
    pattern: LINK_PATTERNS.includes(input.pattern) ? input.pattern : base.pattern,
    ends: LINK_ENDS.includes(input.ends) ? input.ends : base.ends,
    color: isLinkColor(input.color) ? normalizeLinkColor(input.color) : "",
    secondaryColor: isLinkColor(input.secondaryColor) ? normalizeLinkColor(input.secondaryColor) : ""
  };
}

export function sameStyle(a, b) {
  const x = normalizePenStyle(a), y = normalizePenStyle(b);
  return PEN_STYLE_KEYS.every(key => x[key] === y[key]
    || (typeof x[key] === "number" && Math.abs(x[key] - y[key]) < 1e-6));
}

/** The four approved presets as full styles. Their ids are stable and never user-editable. */
export function builtInPresets() {
  return THREAD_PRESET_IDS.map(id => ({
    id, builtIn: true, style: normalizePenStyle({ ...THREAD_PRESETS[id] })
  }));
}

const presetId = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function cleanName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PRESET_NAME);
}

/** Coerces stored pen state. Unknown or corrupt data degrades to defaults, never throws. */
export function normalizePen(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const presets = [];
  const seen = new Set();
  for (const entry of Array.isArray(input.presets) ? input.presets : []) {
    const name = cleanName(entry?.name);
    const id = typeof entry?.id === "string" ? entry.id.slice(0, 40) : "";
    if (!name || !id || seen.has(id) || THREAD_PRESET_IDS.includes(id)) continue;
    seen.add(id);
    presets.push({ id, name, style: normalizePenStyle(entry.style) });
    if (presets.length >= MAX_PEN_PRESETS) break;
  }
  return { current: normalizePenStyle(input.current), presets };
}

/** Pen after changing some style fields. Returns a new pen. */
export function updatePenStyle(pen, fields) {
  const next = normalizePen(pen);
  next.current = normalizePenStyle({ ...next.current, ...(fields && typeof fields === "object" ? fields : {}) });
  return next;
}

/** Saves the current style as a named user preset (replacing a preset of the same name). */
export function savePenPreset(pen, name, style = null) {
  const next = normalizePen(pen);
  const label = cleanName(name);
  if (!label) return next;
  const saved = normalizePenStyle(style ?? next.current);
  const existing = next.presets.findIndex(preset => preset.name.toLowerCase() === label.toLowerCase());
  if (existing >= 0) next.presets[existing] = { ...next.presets[existing], name: label, style: saved };
  else if (next.presets.length < MAX_PEN_PRESETS) next.presets.push({ id: presetId(), name: label, style: saved });
  return next;
}

export function removePenPreset(pen, id) {
  const next = normalizePen(pen);
  next.presets = next.presets.filter(preset => preset.id !== id);
  return next;
}

/** Looks a preset up by id among the built-ins and the user's own. */
export function findPenPreset(pen, id) {
  return [...builtInPresets(), ...normalizePen(pen).presets].find(preset => preset.id === id) ?? null;
}

/** Applying a preset replaces the whole look, colors included. */
export function applyPenPreset(pen, id) {
  const preset = findPenPreset(pen, id);
  if (!preset) return normalizePen(pen);
  const next = normalizePen(pen);
  // Built-ins only define the three structural values; they keep the player's current dye so
  // picking "Heavy" does not silently repaint the thread.
  next.current = preset.builtIn
    ? normalizePenStyle({ ...preset.style, color: next.current.color, secondaryColor: next.current.secondaryColor })
    : normalizePenStyle(preset.style);
  return next;
}

/**
 * Wheel math shared by the pen and an existing thread. `steps` is the signed number of notches
 * (positive thickens / loosens). Returns only the field that changed, already clamped.
 */
export function wheelAdjust(style, { alt = false, steps = 0 } = {}) {
  const current = normalizePenStyle(style);
  if (alt) {
    const slack = Math.round(clampThreadSlack(current.slack + steps * PEN_WHEEL_STEP.slack) * 100) / 100;
    return { slack: Math.min(THREAD_SLACK.max, Math.max(THREAD_SLACK.min, slack)) };
  }
  const thickness = Math.round(clampThreadThickness(current.thickness + steps * PEN_WHEEL_STEP.thickness) * 10) / 10;
  return { thickness: Math.min(THREAD_THICKNESS.max, Math.max(THREAD_THICKNESS.min, thickness)) };
}

/** Wheel events report pixels, lines or pages and vary wildly by device: reduce to notches. */
export function wheelSteps(event) {
  const raw = Number(event?.deltaY) || 0;
  if (!raw) return 0;
  // Scrolling up (negative deltaY) thickens, like zooming in. One notch is ~100 px.
  const magnitude = Math.max(1, Math.round(Math.abs(raw) / 100));
  return raw < 0 ? magnitude : -magnitude;
}

/** Only the cosmetics a new link may carry, for the create request. */
export function penCreateFields(pen) {
  const { current } = normalizePen(pen);
  return { ...current };
}
