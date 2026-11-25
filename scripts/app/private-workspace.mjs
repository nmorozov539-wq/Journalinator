import JournalCanvas from "./canvas.mjs";
import PrivateNoteEditor from "./private-editor.mjs";
import { privateStore } from "../store/private-store.mjs";
import { notesStore } from "../store/notes-store.mjs";
import { requestWrite } from "../socket.mjs";
import { CARD_STYLES } from "../styles/registry.mjs";
import { toggleTaskListItem } from "../markdown.mjs";
import { t } from "../i18n.mjs";

const { DialogV2 } = foundry.applications.api;
const esc = text => foundry.utils.escapeHTML(String(text ?? ""));

/** The private tab's canvas, editor, selection, trash, and publish action. */
export default class PrivateWorkspace {
  constructor({ onChange } = {}) {
    this.onChange = onChange ?? (() => {});
    this.page = null;
    this.workspace = null;
    this.selectedNoteId = null;
    this.history = [];
    this.dimMatch = () => true;

    this.canvas = new JournalCanvas({
      onSelectNote: id => {
        this.selectedNoteId = id;
        this.editor.open(id);
        this.editor.render();
      },
      onReadCardText: (id, kind) => {
        const note = this.getNote(id);
        if (!note) return "";
        return kind === "heading" ? note.system.targetHeading : note.name;
      },
      onSaveCardText: (id, kind, value) => this.updateNote(id,
        kind === "heading" ? { targetHeading: value } : { title: value }),
      onEditCardBlock: (id, blockId, slot) => this.editor.editBoardBlock(id, blockId, slot),
      onEditCardImage: id => this.editor.editNoteImage(id),
      onEditNote: id => {
        this.selectedNoteId = id;
        this.editor.open(id);
        this.editor.render();
        const slot = this.canvas.cardEls.get(id)?.querySelector(".jn-card-block");
        if (slot && this.selectedNoteId === id) this.editor.editFirstBlock(id, slot);
      },
      onCreateNoteAt: options => this.createNoteAt(options),
      onMoveCard: (id, x, y) => this.moveCard(id, x, y),
      onResizeCard: (id, width, height) => this.resizeCard(id, width, height),
      onResetCardSize: id => this.resizeCard(id, null, null),
      onToggleTask: (id, blockId, index) => this.toggleTask(id, blockId, index),
      onPublishNote: id => this.publish(id),
      onDeleteNote: id => this.deleteNotes([id])
    });
    this.canvas.simpleMode = true;

    this.editor = new PrivateNoteEditor({
      getNote: id => this.getNote(id),
      updateNote: (id, patch) => this.updateNote(id, patch),
      deleteNote: id => this.deleteNotes([id]),
      publishNote: id => this.publish(id)
    });
  }

  setPage(page) {
    const changed = this.page?.id !== page?.id;
    this.page = page ?? null;
    this.workspace = page ? privateStore.read(page) : null;
    if (changed) {
      this.selectedNoteId = null;
      this.history = [];
      this.canvas.hasCentered = false;
      this.canvas.view = { x: 0, y: 0, k: 1 };
    }
    if (this.selectedNoteId && !this.workspace?.notes?.[this.selectedNoteId]) this.selectedNoteId = null;
  }

  notes() {
    return this.page && this.workspace ? privateStore.noteViews(this.page, this.workspace) : [];
  }

  layout() {
    return this.workspace?.layout ?? { cards: {}, labels: {}, viewport: null };
  }

  getNote(id) {
    if (!this.page || !this.workspace || !id) return null;
    const note = this.workspace.notes[id];
    return note ? privateStore.noteView(this.page, note) : null;
  }

  renderInto(canvasSlot, editorSlot) {
    if (!this.page) return;
    this.canvas.mount(canvasSlot);
    this.canvas.selectedNoteId = this.selectedNoteId;
    this.canvas.gmMode = false;
    this.canvas.readOnly = false;
    this.canvas.simpleMode = true;
    this.canvas.update(this.notes(), this.layout(), {
      deferGeometry: true,
      dimMatch: this.dimMatch
    });
    this.editor.open(this.selectedNoteId);
    this.editor.mount(editorSlot);
    this.editor.render();
  }

  setDimMatch(match) {
    this.dimMatch = match;
    this.canvas.setDimMatch(match);
  }

  focusNote(id) {
    this.selectedNoteId = id;
    this.canvas.focusNote(id);
  }

  getSelectedNoteIds() {
    const ids = this.canvas.getSelectedNoteIds();
    if (ids.length) return ids;
    return this.selectedNoteId && this.workspace?.notes?.[this.selectedNoteId] ? [this.selectedNoteId] : [];
  }

  async #save(mutator) {
    if (!this.page) return false;
    const rev = privateStore.flags(this.page).rev ?? 0;
    const data = foundry.utils.deepClone(this.workspace);
    try {
      mutator(data);
      const result = await privateStore.save(this.page, data, rev);
      this.workspace = result.workspace;
      this.onChange();
      return true;
    } catch (err) {
      ui.notifications?.warn(err.message);
      this.setPage(privateStore.findById(this.page.id));
      this.onChange();
      return false;
    }
  }

  async createNoteAt({ x = 0, y = 0, style = "sticky", kind = "note", title = "", immediate = false } = {}) {
    if (!this.page) return null;
    const cards = this.workspace?.layout?.cards ?? {};
    const { note, card } = privateStore.makeNote({ title, kind, style, x, y, cards });
    const ok = await this.#save(data => {
      data.notes[note.id] = note;
      data.layout.cards[note.id] = card;
    });
    if (!ok) return null;
    this.selectedNoteId = note.id;
    this.onChange();
    return note.id;
  }

  async updateNote(id, patch) {
    if (!this.workspace?.notes?.[id]) return false;
    return this.#save(data => {
      const note = data.notes[id];
      if (!note) return;
      if (typeof patch.title === "string") note.title = patch.title.slice(0, 200);
      if (typeof patch.targetHeading === "string") note.targetHeading = patch.targetHeading.slice(0, 80);
      if (patch.kind === "note" || patch.kind === "location") note.kind = patch.kind;
      if (Object.hasOwn(CARD_STYLES, patch.style)) note.style = patch.style;
      if ("image" in patch) note.image = patch.image;
      if ("backgroundImage" in patch) note.backgroundImage = patch.backgroundImage;
      if (Array.isArray(patch.blocks) && patch.blocks.length) note.blocks = patch.blocks;
      note.updatedAt = Date.now();
    });
  }

  toggleTask(noteId, blockId, index) {
    const note = this.workspace?.notes?.[noteId];
    const block = note?.blocks.find(item => item.blockId === blockId);
    if (!block) return;
    const text = toggleTaskListItem(block.text, index);
    if (text === null) return;
    const blocks = note.blocks.map(item => item.blockId === blockId ? { ...item, text } : item);
    return this.updateNote(noteId, { blocks });
  }

  async moveCard(id, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !this.workspace?.layout?.cards?.[id]) return;
    return this.#save(data => {
      const card = data.layout.cards[id];
      if (card) { card.x = x; card.y = y; }
    });
  }

  async resizeCard(id, width, height) {
    if (!this.workspace?.layout?.cards?.[id]) return;
    return this.#save(data => {
      const card = data.layout.cards[id];
      if (card) { card.width = width; card.height = height; }
    });
  }

  async deleteNotes(ids) {
    const noteIds = ids.filter(id => this.workspace?.notes?.[id]);
    if (!noteIds.length) return;
    const undoId = foundry.utils.randomID();
    const deletedAt = Date.now();
    const ok = await this.#save(data => {
      for (const id of noteIds) {
        const note = data.notes[id];
        if (!note) continue;
        data.trash.unshift({ note, card: data.layout.cards[id] ?? null, deletedAt, undoId });
        delete data.notes[id];
        delete data.layout.cards[id];
      }
    });
    if (!ok) return;
    this.history.push({ noteIds, undoId });
    if (this.history.length > 20) this.history.shift();
    if (noteIds.includes(this.selectedNoteId)) this.selectedNoteId = null;
    this.canvas.clearSelection();
    this.onChange();
  }

  deleteSelected() {
    const ids = this.getSelectedNoteIds();
    if (ids.length) this.deleteNotes(ids);
  }

  async undo() {
    const deletion = this.history.pop();
    if (!deletion) return;
    await this.#save(data => {
      const keep = [];
      for (const entry of data.trash) {
        if (entry.undoId !== deletion.undoId) { keep.push(entry); continue; }
        data.notes[entry.note.id] = entry.note;
        if (entry.card) data.layout.cards[entry.note.id] = entry.card;
      }
      data.trash = keep;
    });
    this.onChange();
  }

  async restoreTrash(undoId) {
    await this.#save(data => {
      const keep = [];
      for (const entry of data.trash) {
        if (undoId && entry.undoId !== undoId) { keep.push(entry); continue; }
        data.notes[entry.note.id] = entry.note;
        if (entry.card) data.layout.cards[entry.note.id] = entry.card;
      }
      data.trash = keep;
    });
    this.onChange();
  }

  async emptyTrash() {
    await this.#save(data => { data.trash = []; });
    this.onChange();
  }

  async openTrash() {
    const trashed = (this.workspace?.trash ?? [])
      .map(entry => ({ ...entry, key: entry.undoId ?? entry.note.id }));
    const grouped = new Map();
    for (const entry of trashed) {
      if (!grouped.has(entry.key)) grouped.set(entry.key, []);
      grouped.get(entry.key).push(entry);
    }
    const rows = [...grouped].map(([key, entries]) => `
      <div class="jn-trash-row"><span>${esc(entries.map(entry => entry.note.title || t("JN.Private.NewNoteTitle")).join(", "))}</span>
        <button type="button" class="jn-trash-restore" data-id="${key}">${t("JN.Common.Restore")}</button></div>`
    ).join("") || `<p class="journalinator-empty">${t("JN.Trash.Empty")}</p>`;
    await DialogV2.wait({
      window: { title: t("JN.Trash.Title") },
      content: `<div class="jn-trash-list">${rows}</div>` +
        (grouped.size ? `<button type="button" class="jn-trash-empty">${t("JN.Trash.EmptyButton")}</button>` : ""),
      buttons: [{ action: "close", label: t("JN.Common.Close"), default: true }],
      rejectClose: false,
      render: (event, dialog) => {
        dialog.element.querySelectorAll(".jn-trash-restore").forEach(button => {
          button.addEventListener("click", async () => {
            await this.restoreTrash(button.dataset.id);
            dialog.close();
          });
        });
        dialog.element.querySelector(".jn-trash-empty")?.addEventListener("click", async () => {
          const confirmed = await DialogV2.confirm({
            window: { title: t("JN.Trash.EmptyConfirmTitle") },
            content: `<p>${t("JN.Trash.EmptyConfirm")}</p>`
          });
          if (confirmed) await this.emptyTrash();
          dialog.close();
        });
      }
    });
  }

  async publish(noteId) {
    await this.editor.close();
    const note = this.workspace?.notes?.[noteId];
    if (!note) return;
    if (!game.users.activeGM) {
      ui.notifications?.warn(t("JN.Private.NoGM"));
      return;
    }
    const title = await DialogV2.prompt({
      window: { title: t("JN.Private.PublishTitle") },
      content: `<p>${t("JN.Private.PublishBody")}</p>
        <input type="text" name="value" autofocus value="${esc(note.title)}" maxlength="200">`,
      ok: { label: t("JN.Private.Publish"), callback: (event, button) => button.form.elements.value.value.trim() },
      rejectClose: false
    });
    if (!title) return;
    if (notesStore.getAllNotes().some(note => note.name.trim().toLowerCase() === title.toLowerCase())) {
      ui.notifications?.warn(t("JN.Socket.TitleTaken", { title }));
      return;
    }
    await requestWrite({
      type: "privatePublish",
      title,
      blocks: note.blocks.map(block => block.text)
    });
    ui.notifications?.info(t("JN.Private.Published", { title }));
  }

  destroy() {
    this.editor.close();
    this.canvas.disconnectGeometry();
    this.canvas.root.remove();
    this.editor.root.remove();
  }
}
