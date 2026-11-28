import { isLayout } from "../layouts/registry.mjs";
import { isFont, isPaper } from "../skins/registry.mjs";

/**
 * Non-destructive stored-format guard.
 *
 * The rewrite has no migration path (D16): older note data is read-only and the UI
 * shows the incompatible-format notice from UI-SPEC. This module only recognizes
 * current schemaVersion 2 data. It never writes, deletes, migrates or invents
 * defaults, and it never fabricates a body for a legacy page.
 */

export const NOTE_SCHEMA_VERSION = 2;
export const LAYOUT_SCHEMA_VERSION = 2;
export const HISTORY_SCHEMA_VERSION = 2;
export const ACTIVITY_SCHEMA_VERSION = 2;

const isObject = value => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Accept either a Foundry page (`.system`) or a raw system object.
 *
 * Documents are read through their raw `_source.system` when available: Foundry's
 * data model fills missing schema fields with defaults, so reading the initialized
 * system could make an old page look like a current empty v2 note. `_source` is
 * the stored value the guard must judge. Fake pages in tests have no `_source`
 * and fall back to `.system`.
 */
function systemOf(value) {
  if (!isObject(value)) return null;
  if (isObject(value._source?.system)) return value._source.system;
  if (isObject(value.system)) return value.system;
  return value;
}

function hasCurrentSkin(skin) {
  return isObject(skin) && isPaper(skin.paper) && isFont(skin.font);
}

/**
 * True only for a note system the current build can render and write:
 * schemaVersion 2, a string body, a nonnegative integer revision, a registered
 * selected layout, a registered paper/font skin and an attachment object.
 * Thread details are validated by their own write paths, not here.
 */
export function isCurrentNoteSystem(system) {
  const note = systemOf(system);
  if (!note) return false;
  return note.schemaVersion === NOTE_SCHEMA_VERSION
    && typeof note.body === "string"
    && Number.isInteger(note.revision) && note.revision >= 0
    && isLayout(note.layout)
    && hasCurrentSkin(note.skin)
    && isObject(note.attachment);
}

/**
 * Bounded reason why a note page cannot be used, or null when it is current.
 *
 * `legacy-schema` also covers a structurally corrupt schema revision, because the
 * only safe response is the same read-only incompatibility notice. A malformed
 * attachment is part of the appearance configuration and is folded into
 * `invalid-skin` to keep the code set bounded.
 */
export function noteSchemaProblem(page) {
  const note = systemOf(page);
  if (!note || note.schemaVersion !== NOTE_SCHEMA_VERSION) return "legacy-schema";
  if (!Number.isInteger(note.revision) || note.revision < 0) return "legacy-schema";
  if (typeof note.body !== "string") return "missing-body";
  if (!isLayout(note.layout)) return "invalid-layout";
  if (!hasCurrentSkin(note.skin) || !isObject(note.attachment)) return "invalid-skin";
  return null;
}

/**
 * Bounded problem for the shared layout page. A missing layout page is not
 * incompatible data: `ensureContainers` creates it on a fresh world. An existing
 * page with an old/corrupt schema is reported instead.
 */
export function layoutSchemaProblem(page) {
  if (page == null) return null;
  const layout = systemOf(page);
  if (!layout || layout.schemaVersion !== LAYOUT_SCHEMA_VERSION) return "legacy-schema";
  if (layout.cards != null && !isObject(layout.cards)) return "invalid-layout";
  return null;
}

/**
 * Summarizes the shared note pages plus the layout page for the UI guard.
 * `legacyCount` counts incompatible note pages (all entries of kind "note");
 * `noteCount` is the total number of shared note pages inspected.
 */
export function worldSchemaStatus({ notes = [], layout = null } = {}) {
  const list = Array.isArray(notes) ? notes : [...(notes ?? [])];
  const incompatible = [];

  for (const page of list) {
    const code = noteSchemaProblem(page);
    if (code) {
      incompatible.push({
        id: page?.id ?? page?._id ?? "",
        name: page?.name ?? "",
        code,
        kind: "note"
      });
    }
  }

  const layoutCode = layoutSchemaProblem(layout);
  if (layoutCode) {
    incompatible.push({
      id: layout?.id ?? layout?._id ?? "",
      name: layout?.name ?? "",
      code: layoutCode,
      kind: "layout"
    });
  }

  return {
    current: incompatible.length === 0,
    incompatible,
    noteCount: list.length,
    legacyCount: incompatible.filter(entry => entry.kind === "note").length
  };
}

/** Write gate result; never throws and never mutates the status. */
export function requireWritable(status) {
  if (status?.current === true) return { ok: true, reason: null };
  return { ok: false, reason: "incompatible-data" };
}
