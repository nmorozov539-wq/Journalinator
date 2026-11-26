import { getContainerIds } from "./store/containers.mjs";
import { notesStore } from "./store/notes-store.mjs";
import {
  isCurrentNoteSchema, migrateNoteSystem, resolveAttachment, sanitizeCardAnchorsWithMain
} from "./presentation.mjs";

const MODULE_ID = "fvtt-journalinator";

function noteList(notes) {
  if (notes instanceof Map) return [...notes.values()];
  if (Array.isArray(notes)) return notes;
  if (notes && typeof notes[Symbol.iterator] === "function") return [...notes];
  return Object.values(notes ?? {});
}

/**
 * Pure anchor migration: sanitizes each card's anchor registry, keeps valid minors, and adds the
 * canonical main anchor when its note is live and its attachment block has the main pin enabled.
 * Existing main anchors are canonicalized, not duplicated, so calling this repeatedly is safe.
 *
 * `notes` accepts note-like objects ({ id, system }) in an array, Map, iterable or keyed object.
 * Returns `[{ noteId, anchors }]` patches for the caller to apply. A malformed card is skipped
 * rather than failing the whole batch.
 */
export function migrateCardAnchors(cards, notes) {
  const byId = new Map();
  for (const note of noteList(notes)) {
    const id = note?.id ?? note?._id;
    if (id) byId.set(id, note);
  }
  const updates = [];
  for (const [noteId, card] of Object.entries(cards ?? {})) {
    if (!card || typeof card !== "object" || Array.isArray(card)) continue;
    const note = byId.get(noteId);
    // Prefer stored source data: a TypeDataModel fills missing schema fields with defaults, and
    // resolving those defaults would hide an explicit `mainPinEnabled: false` from an old record.
    const system = note?._source?.system ?? note?.system;
    const existing = card.anchors && typeof card.anchors === "object" && !Array.isArray(card.anchors)
      ? card.anchors : {};
    const wantsMain = !!system && !system.deleted && resolveAttachment({ system }).mainPinEnabled;
    let anchors;
    try {
      anchors = sanitizeCardAnchorsWithMain(existing, wantsMain, system?.authorId ?? "");
    } catch {
      continue;
    }
    // Only emit cards whose stored registry actually changes, so a second run is a no-op.
    if (JSON.stringify(anchors) === JSON.stringify(existing)) continue;
    updates.push({ noteId, anchors });
  }
  return updates;
}

/**
 * GM-only, idempotent migration of shared note pages and their layout cards.
 *
 * Touches only the shared journal's notes/layout. The private journals and the encrypted vault
 * have their own lazy normalizers and are deliberately never read or written here. Trashed notes
 * are migrated too so restoring them later does not resurrect an old schema, but only live notes
 * are considered for new main anchors. History snapshots are not rewritten.
 */
export async function migrateSharedWorld() {
  const result = { notes: 0, anchors: 0, failed: 0 };
  if (!game.user?.isGM) return result;
  const ids = getContainerIds();
  if (!ids) return result;
  const shared = game.journal.get(ids.shared);
  if (!shared) return result;

  const sourceSystem = page => page._source?.system ?? page.system;

  for (const page of notesStore.getAllNotesIncludingTrashed()) {
    if (page.type !== `${MODULE_ID}.note`) continue;
    // `_source` is the stored data, before a data model fills missing fields with defaults. Using
    // it keeps legacy `style` meaningful instead of reading a default-initialized presentation.
    const system = sourceSystem(page);
    if (isCurrentNoteSchema(system)) continue;
    try {
      const patch = migrateNoteSystem(system, page.name);
      const presentation = system.presentation && typeof system.presentation === "object"
        ? system.presentation : {};
      const attachment = system.attachment && typeof system.attachment === "object"
        ? system.attachment : {};
      await page.update({
        "system.schemaVersion": 1,
        "system.label": patch.label,
        // Merge so unknown/extra presentation or attachment fields on an old record are not lost.
        "system.presentation": { ...presentation, ...patch.presentation },
        "system.attachment": { ...attachment, ...patch.attachment }
      });
      result.notes += 1;
    } catch (err) {
      result.failed += 1;
      console.error(`Journalinator: could not migrate shared note ${page.id}`, err);
    }
  }

  const layout = ids.layoutPage ? shared.pages.get(ids.layoutPage) : null;
  if (layout) {
    const liveNotes = notesStore.getAllNotesIncludingTrashed().filter(page => !sourceSystem(page).deleted);
    const updates = migrateCardAnchors(layout.system.cards ?? {}, liveNotes);
    // Apply each card separately: one rejected path must not discard the rest of the batch.
    for (const { noteId, anchors } of updates) {
      try {
        await layout.update({ [`system.cards.${noteId}.anchors`]: anchors });
        result.anchors += 1;
      } catch (err) {
        result.failed += 1;
        console.error(`Journalinator: could not migrate shared card anchors for ${noteId}`, err);
      }
    }
  }
  return result;
}
