import { getContainerIds } from "./containers.mjs";
import {
  noteSchemaProblem, requireWritable, worldSchemaStatus
} from "./schema-guard.mjs";

const MODULE_ID = "fvtt-journalinator";
const NOTE_TYPE = `${MODULE_ID}.note`;

/**
 * The single read seam for the app. Everything the UI reads about shared notes,
 * the layout, activity and history goes through here, never straight at the
 * JournalEntry documents.
 *
 * This build reads exactly one stored schema (v2). There is no vault merge and no
 * GM/player content view: every client reads the same shared documents. Legacy
 * pages remain on disk but are excluded from renderable note results, so old block
 * data is never shown as an empty v2 note. `getSharedPage()` is the raw escape
 * hatch for administration and the schema guard.
 *
 * Reads never write, normalize or migrate. The shared write path (socket.mjs)
 * does not read from here; it addresses shared documents directly.
 */
class NotesStore {
  #sharedEntry() {
    const ids = getContainerIds();
    if (!ids?.shared) return null;
    return game.journal.get(ids.shared) ?? null;
  }

  #historyEntry() {
    const ids = getContainerIds();
    if (!ids?.history) return null;
    return game.journal.get(ids.history) ?? null;
  }

  #sharedNotePages() {
    return [...(this.#sharedEntry()?.pages ?? [])].filter(page => page.type === NOTE_TYPE);
  }

  #usable(page) {
    return noteSchemaProblem(page) === null;
  }

  /** Every shared note page, including legacy and trashed pages. */
  getSharedNotes() {
    return this.#sharedNotePages();
  }

  /** Live, schema-current notes for the canvas, search and backlinks. */
  getAllNotes() {
    return this.#sharedNotePages().filter(page => page.system?.deleted == null && this.#usable(page));
  }

  /** Every shared note page ever, trash and legacy included (administration/transfer reads). */
  getAllNotesIncludingTrashed() {
    return this.#sharedNotePages();
  }

  /** Schema-current notes currently in the trash. */
  getTrashedNotes() {
    return this.#sharedNotePages().filter(page => page.system?.deleted != null && this.#usable(page));
  }

  /** A renderable current note, or null for missing or legacy data. */
  getNote(noteId) {
    if (!noteId) return null;
    const page = this.getSharedPage(noteId);
    return page && this.#usable(page) ? page : null;
  }

  /** The raw shared page, for guard and GM actions that must see actual stored data. */
  getSharedPage(noteId) {
    if (!noteId) return null;
    const page = this.#sharedEntry()?.pages.get(noteId) ?? null;
    return page?.type === NOTE_TYPE ? page : null;
  }

  getSharedLayout() {
    const ids = getContainerIds();
    if (!ids?.layoutPage) return null;
    return this.#sharedEntry()?.pages.get(ids.layoutPage)?.system ?? null;
  }

  /** The shared board layout, or null when the current world has not initialized it. */
  getLayout() {
    return this.getSharedLayout();
  }

  /** The hidden shared activity store's system data, or null. */
  getActivity() {
    const ids = getContainerIds();
    if (!ids?.activityPage) return null;
    return this.#sharedEntry()?.pages.get(ids.activityPage)?.system ?? null;
  }

  /** The hidden shared history store's system data, or null. */
  getHistory() {
    const ids = getContainerIds();
    if (!ids?.historyPage) return null;
    return this.#historyEntry()?.pages.get(ids.historyPage)?.system ?? null;
  }

  /** Non-destructive incompatible-format status over shared notes plus the layout page. */
  getSchemaStatus() {
    const ids = getContainerIds() ?? {};
    const layout = ids.layoutPage
      ? this.#sharedEntry()?.pages.get(ids.layoutPage) ?? null
      : null;
    return worldSchemaStatus({ notes: this.#sharedNotePages(), layout });
  }

  /** Whether shared note writes are allowed for the currently stored data. */
  canWriteShared() {
    return requireWritable(this.getSchemaStatus()).ok;
  }
}

export const notesStore = new NotesStore();
