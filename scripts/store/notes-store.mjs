import { getContainerIds } from "./containers.mjs";

const MODULE_ID = "fvtt-journalinator";

/**
 * The single read seam for the app (spec §5.7). Everything the UI reads about notes/layout
 * goes through here, never straight at the JournalEntry documents, so the GM-tier merge
 * (secrets + shared) in a later phase is a change to this file only.
 */
class NotesStore {
  #sharedEntry() {
    const ids = getContainerIds();
    if (!ids) return null;
    return game.journal.get(ids.shared) ?? null;
  }

  /** Live, non-deleted notes — everything the canvas, search, and backlinks should see. */
  getAllNotes() {
    const shared = this.#sharedEntry();
    if (!shared) return [];
    return shared.pages
      .filter(p => p.type === `${MODULE_ID}.note` && !p.system.deleted)
      .map(p => this.#mergeWithSecrets(p));
  }

  /** Notes currently in the trash (spec §11) — for the Trash dialog only. */
  getTrashedNotes() {
    const shared = this.#sharedEntry();
    if (!shared) return [];
    return shared.pages
      .filter(p => p.type === `${MODULE_ID}.note` && p.system.deleted)
      .map(p => this.#mergeWithSecrets(p));
  }

  /** Every note ever, trash included — for journal-wide stats (spec §12), which are historical totals. */
  getAllNotesIncludingTrashed() {
    const shared = this.#sharedEntry();
    if (!shared) return [];
    return shared.pages
      .filter(p => p.type === `${MODULE_ID}.note`)
      .map(p => this.#mergeWithSecrets(p));
  }

  getNote(noteId) {
    const shared = this.#sharedEntry();
    const page = shared?.pages.get(noteId) ?? null;
    return page ? this.#mergeWithSecrets(page) : null;
  }

  getLayout() {
    const ids = getContainerIds();
    const shared = this.#sharedEntry();
    const page = ids ? shared?.pages.get(ids.layoutPage) : null;
    return page?.system ?? null;
  }

  getStats() {
    const ids = getContainerIds();
    const shared = this.#sharedEntry();
    const page = ids ? shared?.pages.get(ids.statsPage) : null;
    return page?.system ?? null;
  }

  /** No-op in Phase 1 — the secrets container is unused. Seam for the later GM-tier merge. */
  #mergeWithSecrets(page) {
    return page;
  }
}

export const notesStore = new NotesStore();
