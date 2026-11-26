import { NOTE_FONT_KEYS, PIN_STYLES, PICTURE_LAYOUTS, resolveAttachment, resolvePresentation } from "../presentation.mjs";
import { noteImagePath } from "../image-url.mjs";
import { promptImageSource } from "./image-dialog.mjs";
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
    const value = await promptImageSource(
      t(background ? "JN.Editor.BackgroundURL" : "JN.Editor.ImageURL"),
      existing ?? "",
      existing ? t(background ? "JN.Editor.ClearBackgroundHint" : "JN.Editor.ClearImageHint") : ""
    );
    if (value == null) return;
    const image = value ? noteImagePath(value) : null;
    if (value && !image) return ui.notifications?.warn(t("JN.Editor.InvalidImageURL"));
    await this.callbacks.updateNote(noteId, { [key]: image });
  }

  /** Private workspaces have a single writer, so attachment changes save directly. */
  setNoteAttachment(noteId, fields) {
    const note = this.callbacks.getNote(noteId);
    if (!note || !fields || typeof fields !== "object") return;
    const current = resolveAttachment(note);
    const next = { ...current };
    if (typeof fields.mainPinEnabled === "boolean") next.mainPinEnabled = fields.mainPinEnabled;
    if (Number.isFinite(fields.mainSnapRadius)) next.mainSnapRadius = Math.min(64, Math.max(0, fields.mainSnapRadius));
    if (Number.isFinite(fields.minorSnapRadius)) next.minorSnapRadius = Math.min(32, Math.max(0, fields.minorSnapRadius));
    if (PIN_STYLES.includes(fields.pinStyle)) next.pinStyle = fields.pinStyle;
    return this.callbacks.updateNote(noteId, { attachment: next });
  }

  setMainPinEnabled(noteId, enabled) {
    if (typeof enabled !== "boolean") return;
    // Route through the workspace so the same redistribution/qualification guard applies as to
    // any other private pin toggle; never patch the attachment directly from the editor.
    if (typeof this.callbacks.setMainPinEnabled === "function") {
      return this.callbacks.setMainPinEnabled(noteId, enabled);
    }
    return this.setNoteAttachment(noteId, { mainPinEnabled: enabled });
  }

  #pinsEnabled() {
    try {
      return game.settings?.get?.("fvtt-journalinator", "pinsEnabled") !== false;
    } catch {
      return true;
    }
  }

  #attachmentPanel(note) {
    const attachment = resolveAttachment(note);
    // Private workspaces cannot redistribute links, so removing a main pin that still has
    // links is a shared-canvas-only action. Qualify the control instead of leaving a toggle
    // that would silently strand those links.
    const locked = this.callbacks.mainPinLocked?.(note.id) === true;
    const lockHint = locked ? t("JN.Pin.PrivateSharedOnly") : "";
    const styleOptions = PIN_STYLES.map(key => {
      const labelKey = `JN.Pin.Styles.${key.charAt(0).toUpperCase()}${key.slice(1)}`;
      return `<option value="${key}" ${attachment.pinStyle === key ? "selected" : ""}>${t(labelKey)}</option>`;
    }).join("");
    return `
      <label class="jn-presentation-check" title="${esc(lockHint)}">
        <input type="checkbox" class="journalinator-main-pin" ${attachment.mainPinEnabled ? "checked" : ""}
          ${locked ? "disabled" : ""} title="${esc(lockHint)}">
        ${t("JN.Pin.Enabled")}
      </label>
      ${locked ? `<small class="journalinator-meta">${esc(lockHint)}</small>` : ""}
      <label class="jn-presentation-field">${t("JN.Pin.SnapMain")}
        <input type="number" class="journalinator-main-snap" min="0" max="64" step="1"
          value="${attachment.mainSnapRadius}" aria-label="${t("JN.Pin.SnapMain")}">
      </label>
      <label class="jn-presentation-field">${t("JN.Pin.SnapMinor")}
        <input type="number" class="journalinator-minor-snap" min="0" max="32" step="1"
          value="${attachment.minorSnapRadius}" aria-label="${t("JN.Pin.SnapMinor")}">
      </label>
      <label class="jn-presentation-field">${t("JN.Pin.Style")}
        <select class="journalinator-pin-style" aria-label="${t("JN.Pin.Style")}">${styleOptions}</select>
      </label>`;
  }

  render() {
    const note = this.#note;
    if (!note) {
      this.root.replaceChildren();
      return;
    }
    const presentation = resolvePresentation(note);
    const currentType = note.system.kind === "location"
      ? "location" : (presentation.forceExtended ? presentation.extendedStyle : "auto");
    const styleChoices = [
      ["auto", "JN.Style.Auto"],
      ["memo", "JN.Style.Memo"],
      ["document", "JN.Style.Document"],
      ["target", "JN.Style.Target"],
      ["location", "JN.Kind.Location"]
    ];
    const styleOptions = styleChoices
      .map(([key, labelKey]) => `<option value="${key}" ${currentType === key ? "selected" : ""}>${t(labelKey)}</option>`)
      .join("");
    const fontOptions = NOTE_FONT_KEYS
      .map(key => `<option value="${key}" ${presentation.font === key ? "selected" : ""}>${t(`JN.Font.${key === "default" ? "Default" : key === "serif" ? "Serif" : key === "hand" ? "Hand" : "Display"}`)}</option>`)
      .join("");
    const layoutOptions = PICTURE_LAYOUTS
      .map(key => `<option value="${key}" ${presentation.pictureLayout === key ? "selected" : ""}>${t(`JN.Picture.${key === "above" ? "Above" : key === "below" ? "Below" : key === "left" ? "Left" : "Right"}`)}</option>`)
      .join("");
    const backlinks = this.callbacks.getBacklinks?.(note.id) ?? [];
    const backlinkHTML = backlinks
      .map(link => `<button type="button" class="journalinator-chip" data-id="${link.id}">${esc(link.name)}</button>`)
      .join("") || `<small class="journalinator-meta">${t("JN.Common.NoneYet")}</small>`;
    const tool = (icon, label, content) => `<details class="jn-note-tool">
      <summary title="${esc(label)}" aria-label="${esc(label)}"><i class="fa-solid ${icon}" aria-hidden="true"></i></summary>
      <div class="jn-note-tool-panel">${content}</div></details>`;
    const presentationPanel = `
      <label class="jn-presentation-field">${t("JN.Editor.Font")}
        <select class="journalinator-font" aria-label="${t("JN.Editor.Font")}">${fontOptions}</select>
      </label>
      <label class="jn-presentation-field">${t("JN.Editor.PictureLayout")}
        <select class="journalinator-picture-layout" aria-label="${t("JN.Editor.PictureLayout")}">${layoutOptions}</select>
      </label>
      <label class="jn-presentation-check">
        <input type="checkbox" class="journalinator-force-extended" ${presentation.forceExtended ? "checked" : ""}>
        ${t("JN.Editor.ForceExtended")}
      </label>
      <label class="jn-presentation-check">
        <input type="checkbox" class="journalinator-torn" ${presentation.torn ? "checked" : ""}>
        ${t("JN.Editor.Torn")}
      </label>`;

    this.root.innerHTML = `
      <div class="jn-note-tools">
        ${tool("fa-pencil", t("JN.Editor.RenameTitle"), `<div class="journalinator-eh">
          <b><button type="button" class="jn-inline-title" title="${t("JN.Editor.RenameTitle")}">${esc(note.name)}</button></b>
        </div>`)}
        ${tool("fa-tag", t("JN.Editor.Label"), `<input type="text" class="journalinator-label" aria-label="${t("JN.Editor.Label")}"
          value="${esc(note.system.label ?? "")}" placeholder="${t("JN.Editor.Label")}" maxlength="200">`)}
        ${tool("fa-link", t("JN.Editor.RelatedNotes"), `<div class="journalinator-chips">${backlinkHTML}</div>`)}
        ${tool("fa-layer-group", t("JN.Editor.Type"), `
          <select class="journalinator-kind" aria-label="${t("JN.Editor.Type")}">${styleOptions}</select>`)}
        ${tool("fa-sliders", t("JN.Editor.Presentation"), presentationPanel)}
        ${this.#pinsEnabled() ? tool("fa-thumbtack", t("JN.Pin.Style"), this.#attachmentPanel(note)) : ""}
        ${presentation.extendedStyle === "target" ? tool("fa-bullseye", t("JN.Style.Target"), `
          <input type="text" class="journalinator-target-heading" aria-label="${t("JN.Style.Target")}"
            value="${esc(presentation.heading)}" placeholder="${t("JN.Style.Target")}" maxlength="80">`) : ""}
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

    const labelInput = this.root.querySelector(".journalinator-label");
    labelInput?.addEventListener("change", () => this.callbacks.updateNote(noteId, { label: labelInput.value.trim() }));
    labelInput?.addEventListener("keydown", event => {
      if (event.isComposing || event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      labelInput.blur();
    });

    this.root.querySelector(".journalinator-kind")?.addEventListener("change", async event => {
      const type = event.target.value;
      if (type === "location") {
        await this.callbacks.updateNote(noteId, {
          kind: "location", presentation: { extendedStyle: "document", forceExtended: true }
        });
        return;
      }
      const kind = note.system.kind === "location" ? "note" : note.system.kind;
      if (type === "auto") {
        await this.callbacks.updateNote(noteId, { kind, presentation: { forceExtended: false } });
      } else {
        await this.callbacks.updateNote(noteId, {
          kind, presentation: { extendedStyle: type, forceExtended: true }
        });
      }
    });
    this.root.querySelector(".journalinator-font")?.addEventListener("change", event => {
      this.callbacks.updateNote(noteId, { presentation: { font: event.target.value } });
    });
    this.root.querySelector(".journalinator-picture-layout")?.addEventListener("change", event => {
      this.callbacks.updateNote(noteId, { presentation: { pictureLayout: event.target.value } });
    });
    this.root.querySelector(".journalinator-force-extended")?.addEventListener("change", event => {
      this.callbacks.updateNote(noteId, { presentation: { forceExtended: event.target.checked } });
    });
    this.root.querySelector(".journalinator-torn")?.addEventListener("change", event => {
      this.callbacks.updateNote(noteId, { presentation: { torn: event.target.checked } });
    });
    this.root.querySelector(".journalinator-main-pin")?.addEventListener("change", event => {
      this.setMainPinEnabled(noteId, event.target.checked);
    });
    const mainSnap = this.root.querySelector(".journalinator-main-snap");
    const minorSnap = this.root.querySelector(".journalinator-minor-snap");
    const pinStyle = this.root.querySelector(".journalinator-pin-style");
    mainSnap?.addEventListener("change", () => {
      const value = Number(mainSnap.value);
      if (Number.isFinite(value)) this.setNoteAttachment(noteId, { mainSnapRadius: value });
    });
    minorSnap?.addEventListener("change", () => {
      const value = Number(minorSnap.value);
      if (Number.isFinite(value)) this.setNoteAttachment(noteId, { minorSnapRadius: value });
    });
    pinStyle?.addEventListener("change", () => {
      this.setNoteAttachment(noteId, { pinStyle: pinStyle.value });
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
