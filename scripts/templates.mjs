import { resolveSkin, seededSkin } from "./skins/registry.mjs";

/**
 * Creation templates are declarative starting points, not stored note types.
 * `focus` names an editor destination; nothing here contains placeholder prose,
 * a derived title, or an external asset.
 */

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const TEMPLATE_LIST = [
  {
    id: "blank",
    labelKey: "JN.Template.Blank",
    descriptionKey: "JN.Template.BlankHint",
    body: "",
    layout: "plain",
    paper: "amber",
    font: "handwritten",
    torn: false,
    focus: "body-start"
  },
  {
    id: "document",
    labelKey: "JN.Template.Document",
    descriptionKey: "JN.Template.DocumentHint",
    body: "# ",
    layout: "plain",
    paper: "cream",
    font: "default",
    torn: false,
    focus: "after-title-marker"
  },
  {
    id: "profile",
    labelKey: "JN.Template.Profile",
    descriptionKey: "JN.Template.ProfileHint",
    body: "# ",
    layout: "profile",
    paper: "parchment",
    font: "serif",
    torn: false,
    focus: "after-title-marker"
  }
];

export const TEMPLATES = deepFreeze(TEMPLATE_LIST);

/** Unknown ids fall back to Blank; use the id returned in a template object for checks. */
export function getTemplate(id) {
  return TEMPLATES.find(template => template.id === id) ?? TEMPLATES[0];
}

/**
 * Skin defaults for a template. With no note id the tilt seed is 0; with a note id
 * the seed is derived from that id so the eventual card is stable everywhere.
 */
export function templateSkin(id, { noteId } = {}) {
  const template = getTemplate(id);
  const skin = resolveSkin({
    paper: template.paper,
    font: template.font,
    torn: template.torn,
    backgroundImage: null,
    tiltSeed: 0
  });
  if (noteId === undefined || noteId === null || noteId === "") return skin;
  return seededSkin(skin, noteId);
}

function titleBody(template, title) {
  const value = String(title ?? "").trim();
  if (!value) return template.body;
  return `# ${value}`;
}

/** Builds the persisted body/layout/skin and initial editor focus for a template. */
export function createNoteFromTemplate(id, { noteId, title } = {}) {
  const template = getTemplate(id);
  return {
    body: template.id === "blank" ? template.body : titleBody(template, title),
    layout: template.layout,
    skin: templateSkin(template.id, { noteId }),
    focus: template.focus
  };
}

/**
 * Quick-switcher creation: empty input is Blank; otherwise the typed text becomes
 * a first-line H1 on Plain/Cream. Duplicate titles are allowed and expected.
 */
export function createNoteFromQuery(query, { noteId } = {}) {
  const value = String(query ?? "").trim();
  if (!value) return createNoteFromTemplate("blank", { noteId });
  const skin = resolveSkin({
    paper: "cream",
    font: "default",
    torn: false,
    backgroundImage: null,
    tiltSeed: 0
  });
  return {
    body: `# ${value}`,
    layout: "plain",
    skin: noteId === undefined || noteId === null || noteId === ""
      ? skin
      : seededSkin(skin, noteId),
    focus: "body-start"
  };
}
