/**
 * New-note creation surface.
 *
 * There is no modal name prompt and no stored note type: Blank, Document and Profile are
 * templates that choose an initial body, layout and skin. `journal-app.mjs` and the canvas use
 * the anchored menu helpers below; the board label/stamp picker stays a separate control.
 */

export {
  CREATION_CHOICES,
  getCreationChoice,
  buildCreationPayload,
  createNoteFromMenu,
  openCreationMenu
} from "./creation-menu.mjs";

/**
 * @deprecated Compatibility shim for the private editor until its T7 adapter is merged.
 * New shared creation uses the template registry directly and never stores a style/kind.
 */
export function noteCreationPresentation({ presentation } = {}) {
  return presentation && typeof presentation === "object" && !Array.isArray(presentation)
    ? { ...presentation }
    : {};
}

/** @deprecated See {@link noteCreationPresentation}. */
export function noteCreationStyle({ style } = {}) {
  return typeof style === "string" && style ? style : "memo";
}
