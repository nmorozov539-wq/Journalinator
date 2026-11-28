/**
 * Pure card view model for one v2 note.
 *
 * The card contains the parsed body exactly once. No label, heading, kind, image field,
 * location, blocks or secret data participates in rendering: appearance comes solely from
 * `system.layout` + `system.skin`, and title/caption/portrait are derived by the shared parser.
 */

import { parseDocument } from "../document/parse.mjs";
import { renderDocument } from "../document/render.mjs";
import { resolveSkin, skinToCssVars, tiltForSkin } from "../skins/registry.mjs";

function selectedLayoutOf(note) {
  return note?.system?.layout === "profile" ? "profile" : "plain";
}

/**
 * @param {Object} note Shared note page (`_id`, `system.body`, `system.layout`, `system.skin`).
 * @param {Object} [options]
 * @param {boolean} [options.readOnly] Disables interactive task checkboxes.
 * @param {{body?: string}|null} [options.preview] Ephemeral remote preview body.
 * @param {{rotation?: number, sizing?: Object}|null} [options.card] Layout card.
 * @param {(html: string) => string} [options.sanitizer]
 */
export function createCardView(note, {
  readOnly = false,
  preview = null,
  card = null,
  sanitizer = null
} = {}) {
  const system = note?.system ?? {};
  const selectedLayout = selectedLayoutOf(note);
  const body = preview && typeof preview.body === "string"
    ? preview.body
    : (typeof system.body === "string" ? system.body : "");
  const parsed = parseDocument(body, { selectedLayout });
  const skin = resolveSkin(note);
  const rotation = Number.isFinite(card?.rotation) ? card.rotation : tiltForSkin(skin);
  const cssVars = skinToCssVars(skin, { rotation });
  const sanitize = typeof sanitizer === "function"
    ? sanitizer
    : globalThis.foundry?.utils?.cleanHTML;
  const html = renderDocument(parsed, {
    sanitizer: typeof sanitize === "function" ? sanitize : undefined,
    interactiveTasks: !readOnly
  });
  const classes = [
    "jn-card",
    `jn-card-${parsed.effectiveLayout}`,
    `jn-skin-paper-${skin.paper}`,
    `jn-skin-font-${skin.font}`,
    skin.torn ? "jn-torn" : "",
    selectedLayout === "profile" && parsed.effectiveLayout === "plain"
      ? "jn-profile-fallback"
      : ""
  ].filter(Boolean);

  return {
    body,
    parsed,
    skin,
    rotation,
    cssVars,
    classes,
    html
  };
}

export default createCardView;
