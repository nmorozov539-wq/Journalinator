import JournalCanvas from "./canvas.mjs";
import PrivateNoteEditor from "./private-editor.mjs";
import { privateStore } from "../store/private-store.mjs";
import { CARD_STYLES, cardStyleKey } from "../styles/registry.mjs";
import { linkAnchors, moveThreadPin } from "../card-ports.mjs";
import { attachedStampIds, DEFAULT_STAMP_CORNER, isStampCorner, STAMP_COLORS, stampUrl } from "../stamps.mjs";
import { toggleTaskListItem } from "../markdown.mjs";
import { t } from "../i18n.mjs";

const { DialogV2 } = foundry.applications.api;
const esc = text => foundry.utils.escapeHTML(String(text ?? ""));

/** The private tab's canvas, editor, selection, trash, and clipboard actions. */
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
      onEditCardBackground: id => this.editor.editNoteImage(id, true),
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
      onDeleteNote: id => this.deleteNotes([id]),
      onAddLabelAt: (x, y) => this.addLabel({ x, y }),
      onRemoveLabel: id => this.removeLabel(id),
      onMoveLabel: (id, x, y) => this.updateLabel(id, { x, y }),
      onEditLabel: id => this.editLabel(id),
      onAttachStamp: (noteId, stamp, color, corner) => this.attachStamp(noteId, stamp, color, corner),
      onStampCorner: (id, corner) => this.updateLabel(id, { corner }),
      onStampColor: (id, color) => this.updateLabel(id, { color }),
      onCreateLink: (sourceId, targetId, ports) => this.createLink(sourceId, targetId, ports),
      onUpdateLink: (noteId, linkId, fields) => this.updateLink(noteId, linkId, fields),
      onDeleteLink: (noteId, linkId) => this.deleteLink(noteId, linkId)
    });

    this.editor = new PrivateNoteEditor({
      getNote: id => this.getNote(id),
      updateNote: (id, patch) => this.updateNote(id, patch),
      deleteNote: id => this.deleteNotes([id]),
      getBacklinks: id => this.getBacklinks(id),
      onFocusNote: id => this.focusNote(id)
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

  getBacklinks(noteId) {
    if (!this.workspace?.notes?.[noteId]) return [];
    const found = new Map();
    for (const note of Object.values(this.workspace.notes)) {
      if (note.id === noteId) continue;
      if (note.links?.some(link => link.targetId === noteId)) found.set(note.id, note.title);
    }
    const self = this.workspace.notes[noteId];
    for (const link of self.links ?? []) {
      const target = this.workspace.notes[link.targetId];
      if (target) found.set(target.id, target.title);
    }
    return [...found].map(([id, name]) => ({ id, name }));
  }

  renderInto(canvasSlot, editorSlot) {
    if (!this.page) return;
    this.canvas.mount(canvasSlot);
    this.canvas.selectedNoteId = this.selectedNoteId;
    this.canvas.gmMode = false;
    this.canvas.readOnly = false;
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

  async addLabel({ x = 0, y = 0, text = t("JN.Label.Default"), size = 14, color = "", stamp = "", noteId = "", corner = DEFAULT_STAMP_CORNER } = {}) {
    const id = foundry.utils.randomID();
    await this.#save(data => {
      data.layout.labels[id] = {
        text: String(text ?? ""), x, y, size, color: String(color ?? ""), stamp, noteId,
        corner: isStampCorner(corner) ? corner : DEFAULT_STAMP_CORNER
      };
    });
    return id;
  }

  async updateLabel(labelId, fields) {
    return this.#save(data => {
      const label = data.layout.labels[labelId];
      if (!label) return;
      if (typeof fields.text === "string") label.text = fields.text.slice(0, 500);
      if (Number.isFinite(fields.x)) label.x = fields.x;
      if (Number.isFinite(fields.y)) label.y = fields.y;
      if (Number.isFinite(fields.size)) label.size = Math.max(8, Math.min(96, fields.size));
      if (Object.values(STAMP_COLORS).includes(fields.color)) label.color = fields.color;
      if (label.stamp && isStampCorner(fields.corner)) label.corner = fields.corner;
    });
  }

  async removeLabels(labelIds) {
    return this.#save(data => {
      for (const id of labelIds) {
        const label = data.layout.labels[id];
        if (!label) continue;
        const ids = label.noteId && stampUrl(label.stamp)
          ? attachedStampIds(data.layout.labels, label.noteId) : [id];
        for (const removeId of ids) delete data.layout.labels[removeId];
      }
    });
  }

  removeLabel(labelId) {
    return this.removeLabels([labelId]);
  }

  async editLabel(labelId) {
    const label = this.workspace?.layout?.labels?.[labelId];
    if (!label || label.stamp) return;
    const text = await DialogV2.prompt({
      window: { title: t("JN.Prompt.EditLabel") },
      content: `<input type="text" name="value" autofocus value="${esc(label.text)}">`,
      ok: { label: t("JN.Common.OK"), callback: (event, button) => button.form.elements.value.value.trim() },
      rejectClose: false
    });
    if (text === null) return;
    if (!text) return this.removeLabel(labelId);
    return this.updateLabel(labelId, { text });
  }

  async attachStamp(noteId, stamp, color = STAMP_COLORS.red, corner = DEFAULT_STAMP_CORNER) {
    if (!stampUrl(stamp) || !this.workspace?.notes?.[noteId]) return;
    return this.#save(data => {
      const ids = attachedStampIds(data.layout.labels, noteId);
      const id = ids[0] ?? foundry.utils.randomID();
      for (const duplicate of ids.slice(1)) delete data.layout.labels[duplicate];
      const previous = data.layout.labels[id];
      data.layout.labels[id] = {
        text: "", x: 0, y: 0, size: 14,
        color: Object.values(STAMP_COLORS).includes(color) ? color : STAMP_COLORS.red,
        stamp, noteId,
        corner: isStampCorner(corner) ? corner : previous?.corner ?? DEFAULT_STAMP_CORNER
      };
    });
  }

  async createLink(sourceId, targetId, ports) {
    if (sourceId === targetId) return;
    return this.#save(data => {
      const source = data.notes[sourceId];
      if (!source || !data.notes[targetId]) return;
      const anchors = linkAnchors(ports);
      const existing = source.links.find(link => link.targetId === targetId);
      if (existing) {
        if (!anchors.sourcePoint || !anchors.targetPoint) return;
        Object.assign(existing, anchors, { origin: "drawn", edited: true });
        return;
      }
      source.links.push({
        id: foundry.utils.randomID(), targetId, ...anchors,
        label: "", direction: "one", color: "", lineStyle: "solid",
        origin: "drawn", edited: false, createdBy: this.page ? privateStore.ownerId(this.page) || "" : ""
      });
    });
  }

  async updateLink(noteId, linkId, fields) {
    return this.#save(data => {
      const link = data.notes[noteId]?.links.find(item => item.id === linkId);
      if (!link) return;
      if (typeof fields.label === "string") link.label = fields.label.slice(0, 200);
      if (["none", "one", "two"].includes(fields.direction)) link.direction = fields.direction;
      if (typeof fields.color === "string" && ["", "#a393f2", "#d6a45c", "#d77b91"].includes(fields.color)) {
        link.color = fields.color;
      }
      if (fields.lineStyle === "solid" || fields.lineStyle === "dashed") link.lineStyle = fields.lineStyle;
      const pins = moveThreadPin(link.pins, fields.pinMove);
      if (pins) link.pins = pins;
      link.edited = true;
    });
  }

  async deleteLink(noteId, linkId) {
    return this.#save(data => {
      const note = data.notes[noteId];
      if (note) note.links = note.links.filter(link => link.id !== linkId);
    });
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

  async deleteSelected() {
    const labelIds = this.getSelectedLabelIds();
    const noteIds = this.getSelectedNoteIds();
    if (!labelIds.length && !noteIds.length) return;
    const undoId = foundry.utils.randomID();
    const deletedAt = Date.now();
    const ok = await this.#save(data => {
      for (const id of labelIds) {
        const label = data.layout.labels[id];
        if (!label) continue;
        const ids = label.noteId && stampUrl(label.stamp)
          ? attachedStampIds(data.layout.labels, label.noteId) : [id];
        for (const removeId of ids) delete data.layout.labels[removeId];
      }
      for (const id of noteIds) {
        const note = data.notes[id];
        if (!note) continue;
        data.trash.unshift({ note, card: data.layout.cards[id] ?? null, deletedAt, undoId });
        delete data.notes[id];
        delete data.layout.cards[id];
      }
    });
    if (!ok) return;
    if (noteIds.length) {
      this.history.push({ noteIds, undoId });
      if (this.history.length > 20) this.history.shift();
    }
    if (noteIds.includes(this.selectedNoteId)) this.selectedNoteId = null;
    this.canvas.clearSelection();
    this.onChange();
  }

  getSelectedLabelIds() {
    return this.canvas.getSelectedLabelIds();
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

  async openStats() {
    const notes = Object.values(this.workspace?.notes ?? {});
    const chars = notes.reduce((total, note) =>
      total + note.blocks.reduce((sum, block) => sum + block.text.length, 0), 0);
    const trashed = this.workspace?.trash?.length ?? 0;
    const styles = {};
    for (const note of notes) {
      const style = cardStyleKey(note.style);
      styles[style] = (styles[style] ?? 0) + 1;
    }
    await DialogV2.wait({
      window: { title: t("JN.Private.StatsTitle") },
      content: `
        <p>${t("JN.Private.StatsNotes", { count: notes.length })}</p>
        <p>${t("JN.Private.StatsChars", { count: chars })}</p>
        <p>${t("JN.Private.StatsTrash", { count: trashed })}</p>
        <div class="journalinator-meta">${t("JN.Private.StatsStyles")}</div>
        ${Object.entries(styles).map(([style, count]) =>
          `<div class="jn-stat-bar"><span>${esc(t(CARD_STYLES[style]?.labelKey ?? "JN.Style.Sticky"))}</span><em>${count}</em></div>`
        ).join("") || `<p class="journalinator-empty">${t("JN.Common.NoneYet")}</p>`}`,
      buttons: [{ action: "close", label: t("JN.Common.Close"), default: true }],
      rejectClose: false
    });
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

  async pasteNotes(entries, { x = 0, y = 0 } = {}) {
    if (!this.page || !Array.isArray(entries) || !entries.length) return [];
    const ids = [];
    const ok = await this.#save(data => {
      for (const entry of entries) {
        const { note, card } = privateStore.makeNote({
          title: entry?.title, kind: entry?.kind, style: entry?.style, x, y, cards: data.layout.cards
        });
        const texts = Array.isArray(entry?.blocks) && entry.blocks.length ? entry.blocks : [""];
        note.blocks = texts.map(text => ({ blockId: foundry.utils.randomID(), text: String(text ?? "") }));
        if (typeof entry?.targetHeading === "string") note.targetHeading = entry.targetHeading.slice(0, 80);
        data.notes[note.id] = note;
        data.layout.cards[note.id] = card;
        ids.push(note.id);
      }
    });
    if (!ok || !ids.length) return [];
    this.selectedNoteId = ids.at(-1);
    this.onChange();
    return ids;
  }

  destroy() {
    this.editor.close();
    this.canvas.disconnectGeometry();
    this.canvas.root.remove();
    this.editor.root.remove();
  }
}
