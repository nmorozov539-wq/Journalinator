import { CARD_STYLES, cardStyleKey } from "../styles/registry.mjs";
import { noteImageUrl } from "../image-url.mjs";
import { applyMarkdownAutocomplete } from "../markdown-edit.mjs";
import { t } from "../i18n.mjs";

const { DialogV2 } = foundry.applications.api;
const esc = text => foundry.utils.escapeHTML(String(text ?? ""));

/** The private side has one writer, so it needs no locks or GM panels. */
export default class PrivateNoteEditor {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.root = document.createElement("div");
    this.root.className = "journalinator-editor-inner";
    this.noteId = null;
    this.editingBlockId = null;
    this.inlineSlot = null;
  }

  mount(slot) {
    slot.appendChild(this.root);
  }

  /** Saves an in-progress block when the private tab is closed or the view is switched. */
  close() {
    return this.#stopEditing({ save: true });
  }

  get #note() {
    return this.noteId ? this.callbacks.getNote(this.noteId) : null;
  }

  open(noteId) {
    if (this.noteId === noteId) return;
    this.#stopEditing({ save: true });
    this.noteId = noteId;
  }

  editFirstBlock(noteId, slot) {
    this.open(noteId);
    this.render();
    const block = this.#note?.system.blocks?.[0];
    if (block) this.editBoardBlock(noteId, block.blockId, slot);
  }

  editBoardBlock(noteId, blockId, slot) {
    this.open(noteId);
    const note = this.#note;
    const block = note?.system.blocks.find(item => item.blockId === blockId);
    if (!block || !slot) return;
    if (this.editingBlockId === blockId) {
      this.inlineSlot = slot;
      this.#ensureTextarea(block.text);
      return;
    }
    this.#stopEditing({ save: true });
    this.inlineSlot = slot;
    this.editingBlockId = blockId;
    this.#ensureTextarea(block.text);
  }

  #ensureTextarea(text) {
    let textarea = this.inlineSlot?.querySelector(".jn-block-input");
    if (!textarea) {
      textarea = document.createElement("textarea");
      textarea.className = "jn-block-input";
      textarea.setAttribute("aria-label", t("JN.Editor.EditCardText"));
      this.inlineSlot?.appendChild(textarea);
    }
    textarea.value = text;
    textarea.onblur = () => this.#stopEditing({ save: true });
    textarea.oninput = () => {};
    textarea.onkeydown = event => this.#onKeydown(event, textarea);
    textarea.focus();
  }

  #activeTextarea() {
    return this.inlineSlot?.querySelector(".jn-block-input") ?? this.root.querySelector(".jn-block-input");
  }

  #onKeydown(event, textarea) {
    if (applyMarkdownAutocomplete(event, textarea)) return;
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.#stopEditing({ save: false });
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      this.#stopEditing({ save: true });
      return;
    }
    if (event.key === "Enter" && textarea.value.slice(0, textarea.selectionStart).endsWith("\n")) {
      event.preventDefault();
      const before = textarea.value.slice(0, textarea.selectionStart).replace(/\n+$/, "");
      const after = textarea.value.slice(textarea.selectionStart);
      const note = this.#note;
      const blocks = note?.system.blocks ?? [];
      const index = blocks.findIndex(block => block.blockId === this.editingBlockId);
      if (!note || index === -1) return;
      const next = [...blocks];
      next.splice(index, 1,
        { ...blocks[index], text: before },
        { blockId: foundry.utils.randomID(), text: after }
      );
      const noteId = this.noteId;
      this.#finishEditing();
      this.callbacks.updateNote(noteId, { blocks: next });
      return;
    }
    if (event.key === "Backspace" && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
      const note = this.#note;
      const blocks = note?.system.blocks ?? [];
      const index = blocks.findIndex(block => block.blockId === this.editingBlockId);
      if (!note || index <= 0) return;
      event.preventDefault();
      const next = [...blocks];
      next[index - 1] = { ...next[index - 1], text: next[index - 1].text + next[index].text };
      next.splice(index, 1);
      const noteId = this.noteId;
      this.#finishEditing();
      this.callbacks.updateNote(noteId, { blocks: next });
    }
  }

  #finishEditing() {
    const textarea = this.#activeTextarea();
    if (textarea) textarea.onblur = null;
    textarea?.remove();
    this.editingBlockId = null;
    this.inlineSlot = null;
  }

  async #stopEditing({ save = false } = {}) {
    if (!this.editingBlockId) return;
    const noteId = this.noteId;
    const blockId = this.editingBlockId;
    const textarea = this.#activeTextarea();
    const text = textarea?.value;
    const note = this.#note;
    this.#finishEditing();
    if (!save || !note || typeof text !== "string") return;
    const blocks = note.system.blocks;
    const index = blocks.findIndex(block => block.blockId === blockId);
    if (index === -1 || blocks[index].text === text) return;
    const next = blocks.map((block, at) => at === index ? { ...block, text } : block);
    await this.callbacks.updateNote(noteId, { blocks: next });
  }

  async editNoteImage(noteId, background = false) {
    const note = this.callbacks.getNote(noteId);
    if (!note) return;
    const key = background ? "backgroundImage" : "image";
    const existing = note.system[key];
    const value = await DialogV2.prompt({
      window: { title: t(background ? "JN.Editor.BackgroundURL" : "JN.Editor.ImageURL") },
      content: `<input type="text" name="value" autofocus value="${esc(existing ?? "")}">${existing
        ? `<p>${esc(t(background ? "JN.Editor.ClearBackgroundHint" : "JN.Editor.ClearImageHint"))}</p>` : ""}`,
      ok: { label: t("JN.Common.OK"), callback: (event, button) => button.form.elements.value.value.trim() },
      rejectClose: false
    });
    if (value == null) return;
    const image = value ? noteImageUrl(value) : null;
    if (value && !image) return ui.notifications?.warn(t("JN.Editor.InvalidImageURL"));
    await this.callbacks.updateNote(noteId, { [key]: image });
  }

  render() {
    const note = this.#note;
    if (!note) {
      this.root.replaceChildren();
      return;
    }
    const currentType = note.system.kind === "location" ? "location" : cardStyleKey(note.system.style);
    const styleOptions = Object.entries(CARD_STYLES)
      .map(([key, def]) => `<option value="${key}" ${currentType === key ? "selected" : ""}>${t(def.labelKey)}</option>`)
      .join("");
    const backlinks = this.callbacks.getBacklinks?.(note.id) ?? [];
    const backlinkHTML = backlinks
      .map(link => `<button type="button" class="journalinator-chip" data-id="${link.id}">${esc(link.name)}</button>`)
      .join("") || `<small class="journalinator-meta">${t("JN.Common.NoneYet")}</small>`;
    const tool = (icon, label, content) => `<details class="jn-note-tool">
      <summary title="${esc(label)}" aria-label="${esc(label)}"><i class="fa-solid ${icon}" aria-hidden="true"></i></summary>
      <div class="jn-note-tool-panel">${content}</div></details>`;

    this.root.innerHTML = `
      <div class="jn-note-tools">
        ${tool("fa-pencil", t("JN.Editor.RenameTitle"), `<div class="journalinator-eh">
          <b><button type="button" class="jn-inline-title" title="${t("JN.Editor.RenameTitle")}">${esc(note.name)}</button></b>
        </div>`)}
        ${tool("fa-link", t("JN.Editor.RelatedNotes"), `<div class="journalinator-chips">${backlinkHTML}</div>`)}
        ${tool("fa-layer-group", t("JN.Editor.Type"), `
          <select class="journalinator-kind" aria-label="${t("JN.Editor.Type")}">${styleOptions}
            <option value="location" ${currentType === "location" ? "selected" : ""}>${t("JN.Kind.Location")}</option>
          </select>`)}
        ${cardStyleKey(note.system.style) === "wanted" ? tool("fa-bullseye", t("JN.Style.Wanted"), `
          <input type="text" class="journalinator-target-heading" aria-label="${t("JN.Style.Wanted")}"
            value="${esc(note.system.targetHeading)}" placeholder="${t("JN.Style.Wanted")}" maxlength="80">`) : ""}
        <button type="button" class="jn-note-action jn-private-delete"
          title="${t("JN.Common.Delete")}" aria-label="${t("JN.Common.Delete")}">
          <i class="fa-solid fa-trash" aria-hidden="true"></i></button>
      </div>
      <div class="jn-doc" hidden></div>`;

    this.#bindHandlers(note);
  }

  #bindHandlers(note) {
    const noteId = this.noteId;
    const titleButton = this.root.querySelector(".jn-inline-title");
    titleButton?.addEventListener("click", () => {
      const input = document.createElement("input");
      input.className = "jn-inline-title-input";
      input.type = "text";
      input.value = note.name;
      input.maxLength = 200;
      titleButton.replaceWith(input);
      const finish = async save => {
        if (!input.isConnected) return;
        const title = input.value.trim();
        input.replaceWith(titleButton);
        if (save && title && title !== note.name) await this.callbacks.updateNote(noteId, { title });
      };
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("keydown", event => {
        if (event.isComposing || !["Enter", "Escape"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        finish(event.key === "Enter");
        titleButton.focus();
      });
      input.focus();
      input.select();
    });

    this.root.querySelectorAll(".journalinator-chip").forEach(chip => {
      chip.addEventListener("click", () => this.callbacks.onFocusNote?.(chip.dataset.id));
    });

    this.root.querySelector(".journalinator-kind")?.addEventListener("change", async event => {
      const type = event.target.value;
      await this.callbacks.updateNote(noteId, type === "location"
        ? { kind: "location", style: "document" } : { kind: "note", style: type });
    });

    const heading = this.root.querySelector(".journalinator-target-heading");
    heading?.addEventListener("change", () => this.callbacks.updateNote(noteId, { targetHeading: heading.value.trim() }));
    heading?.addEventListener("keydown", event => {
      if (event.isComposing || event.key !== "Enter") return;
      event.preventDefault();
      heading.blur();
    });

    this.root.querySelector(".jn-private-delete")?.addEventListener("click", async () => {
      const confirmed = await DialogV2.confirm({
        window: { title: t("JN.Common.Delete") },
        content: `<p>${t("JN.Private.DeleteNoteConfirm", { title: esc(note.name) })}</p>`
      });
      if (!confirmed) return;
      await this.#stopEditing({ save: true });
      await this.callbacks.deleteNote(noteId);
    });
  }
}
