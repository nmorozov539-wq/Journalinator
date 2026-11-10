import { getContainerIds } from "./containers.mjs";
import { vaultStore } from "../secrets/vault-store.mjs";
import { canUseGmTier } from "../secrets/access.mjs";
import { mergeBlocks } from "../secrets/model.mjs";

const MODULE_ID = "fvtt-journalinator";
const NOTE_TYPE = `${MODULE_ID}.note`;

/**
 * The single read seam for the app (spec §5.7). Everything the UI reads about notes/layout goes
 * through here, never straight at the JournalEntry documents.
 *
 * Players (and a GM in "view as players" mode, or with the vault locked) get shared content only.
 * A GM-tier user with an unlocked vault gets the merged view: hidden blocks interleaved into
 * shared notes, GM-only links, GM-only notes and their cards, GM-only labels. Merged objects are
 * plain data shaped like note pages ({ _id, id, name, system }) with `secret` on GM-only notes,
 * `hidden` on GM-only blocks/links/labels.
 *
 * The shared write path (socket.mjs) never reads from here. It looks at shared documents only, so
 * nothing a player sends can resolve against, collide with, or be steered by secret content.
 */
class NotesStore {
  #gmView = true;

  /** True when the GM view (merged with secrets) is what the UI should show. */
  get merged() {
    return this.#gmView && canUseGmTier() && vaultStore.isUnlocked;
  }

  get gmView() { return this.#gmView; }

  setGmView(on) {
    this.#gmView = !!on;
    Hooks.callAll("journalinatorVaultChanged", vaultStore.status);
  }

  #sharedEntry() {
    const ids = getContainerIds();
    if (!ids) return null;
    return game.journal.get(ids.shared) ?? null;
  }

  #sharedNotePages() {
    return (this.#sharedEntry()?.pages ?? []).filter(p => p.type === NOTE_TYPE);
  }

  /** Live, non-deleted notes — everything the canvas, search, and backlinks should see. */
  getAllNotes() {
    const live = this.#sharedNotePages().filter(p => !p.system.deleted);
    if (!this.merged) return live;
    const vault = vaultStore.data;
    return [
      ...live.map(p => this.#mergeShared(p, vault)),
      ...Object.values(vault.notes).map(n => this.#secretNote(n))
    ];
  }

  /** Notes currently in the trash (spec §11). Shared only — secret notes have no trash. */
  getTrashedNotes() {
    return this.#sharedNotePages().filter(p => p.system.deleted);
  }

  /** Every shared note ever, trash included — journal-wide stats are about shared work only. */
  getAllNotesIncludingTrashed() {
    return this.#sharedNotePages();
  }

  getNote(noteId) {
    if (!noteId) return null;
    const page = this.#sharedEntry()?.pages.get(noteId) ?? null;
    if (page?.type === NOTE_TYPE) return this.merged ? this.#mergeShared(page, vaultStore.data) : page;
    if (this.merged) {
      const secret = vaultStore.data.notes[noteId];
      if (secret) return this.#secretNote(secret);
    }
    return null;
  }

  /** The raw shared page, for GM actions that must reason about what players actually have. */
  getSharedPage(noteId) {
    const page = this.#sharedEntry()?.pages.get(noteId) ?? null;
    return page?.type === NOTE_TYPE ? page : null;
  }

  getSharedNotes() {
    return this.#sharedNotePages();
  }

  getSharedLayout() {
    const ids = getContainerIds();
    const page = ids ? this.#sharedEntry()?.pages.get(ids.layoutPage) : null;
    return page?.system ?? null;
  }

  getLayout() {
    const shared = this.getSharedLayout();
    if (!this.merged) return shared;
    const vault = vaultStore.data;
    const cards = { ...(shared?.cards ?? {}) };
    for (const note of Object.values(vault.notes)) {
      if (note.card) cards[note.id] = { ...note.card };
    }
    const labels = { ...(shared?.labels ?? {}) };
    for (const [id, label] of Object.entries(vault.labels)) labels[id] = { ...label, hidden: true };
    return { cards, labels, viewport: shared?.viewport ?? null };
  }

  getStats() {
    const ids = getContainerIds();
    const page = ids ? this.#sharedEntry()?.pages.get(ids.statsPage) : null;
    return page?.system ?? null;
  }

  isSecretNote(noteId) {
    return this.merged && !!vaultStore.data.notes[noteId];
  }

  isHiddenBlock(noteId, blockId) {
    if (!this.merged) return false;
    const vault = vaultStore.data;
    return !!vault.notes[noteId] || !!vault.hiddenBlocks[noteId]?.blocks?.[blockId];
  }

  isHiddenLink(sourceId, linkId) {
    if (!this.merged) return false;
    const vault = vaultStore.data;
    if (vault.notes[sourceId]) return true;
    return (vault.hiddenLinks[sourceId] ?? []).some(l => l.id === linkId);
  }

  isHiddenLabel(labelId) {
    return this.merged && !!vaultStore.data.labels[labelId];
  }

  #mergeShared(page, vault) {
    const system = page.system.toObject ? page.system.toObject() : foundry.utils.deepClone(page.system);
    const hiddenLinks = (vault.hiddenLinks[page.id] ?? []).map(l => ({ ...l, hidden: true }));
    return {
      _id: page.id,
      id: page.id,
      name: page.name,
      secret: false,
      system: {
        ...system,
        blocks: mergeBlocks(system.blocks, vault.hiddenBlocks[page.id]),
        links: [...(system.links ?? []).map(l => ({ ...l, hidden: false })), ...hiddenLinks]
      }
    };
  }

  #secretNote(note) {
    return {
      _id: note.id,
      id: note.id,
      name: note.name,
      secret: true,
      system: {
        style: note.style ?? "sticky",
        image: note.image ?? null,
        blocks: (note.blocks ?? []).map(b => ({ ...b, hidden: true })),
        links: (note.links ?? []).map(l => ({ ...l, hidden: true })),
        authorId: note.authorId ?? "",
        createdAt: note.createdAt ?? 0,
        updatedAt: note.updatedAt ?? 0,
        editCount: 0,
        contributions: {},
        formerNames: note.formerNames ?? [],
        deleted: null,
        hint: false
      }
    };
  }
}

export const notesStore = new NotesStore();
