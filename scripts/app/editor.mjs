import { notesStore } from "../store/notes-store.mjs";
import { requestWrite } from "../socket.mjs";
import { requestLock, releaseLock, sendHeartbeat, requestLockState, getLock, isHeldByMe } from "../locks.mjs";
import { NOTE_FONT_KEYS, PICTURE_LAYOUTS, resolvePresentation } from "../presentation.mjs";
import { noteImagePath } from "../image-url.mjs";
import { promptImageSource } from "./image-dialog.mjs";
import * as secrets from "../secrets/secret-actions.mjs";
import { stripSecretPrefix } from "../secrets/model.mjs";
import { renderMarkdown, toggleTaskListItem } from "../markdown.mjs";
import { applyMarkdownAutocomplete } from "../markdown-edit.mjs";
import { t } from "../i18n.mjs";

const { DialogV2 } = foundry.applications.api;
const esc = text => foundry.utils.escapeHTML(String(text ?? ""));

/** Runs a GM vault action and surfaces failures (e.g. the vault was locked meanwhile). */
function gm(job) {
  return Promise.resolve().then(job).catch(err => {
    console.error(err);
    ui.notifications.error(err.message);
  });
}

const HEARTBEAT_INTERVAL_MS = 8000;
const DRAFT_SAVE_DELAY_MS = 300;
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The note editor: one continuous document (spec §9), paragraph by paragraph, each block
 * individually lock-arbitrated (spec §6.3-§6.6). Owns its own persistent DOM node — created
 * once by JournalApp and kept alive across its re-renders, same reasoning as JournalCanvas —
 * so a document-sync hook firing for an unrelated note never tears down an in-progress edit.
 *
 * Known rough edge: an unrelated hook still calls render() here (there's no surgical per-block
 * DOM patching yet), so a block you're actively typing in gets its <textarea> torn down and
 * rebuilt on every unrelated edit anywhere in the journal. Content is preserved via persistent
 * `drafts` (captured on input and right before each rebuild, mirrored to localStorage), so
 * nothing is lost, but the cursor jumps to the end of the text each time. Good enough for
 * Phase 4; worth revisiting in the polish phase.
 */
export default class NoteEditor {
  constructor(callbacks) {
    this.callbacks = callbacks; // { onFocusNote(id), onSelectNote(id) }
    this.root = document.createElement("div");
    this.root.className = "journalinator-editor-inner";
    this.noteId = null;
    this.editingBlockId = null;
    this.editingSecret = false; // editing a GM-only block: local, no lock, saved to the vault
    this.pendingBlockId = null;
    this.inlineSlot = null;
    this.pendingMerge = null; // { blockId, prevBlockId }
    this.pendingTaskToggle = null; // { noteId, blockId, index, text } waiting for a lock
    this.drafts = new Map();
    this.heartbeatTimer = null;
    this.hookId = null;
    this.draftTimer = null;
    this.onPageHide = null;
    this.readOnly = false; // no active GM: notes can be read but not edited
  }

  /**
   * Registers the lock listener for the lifetime of an open app. Kept separate from the
   * constructor so a closed app leaves no global hook behind.
   */
  activate() {
    if (this.hookId !== null) return;
    this.hookId = Hooks.on("journalinatorLocksChanged", (noteId, blockId, lock) => {
      if (noteId !== this.noteId) return;
      this.#onLockChanged(blockId, lock);
    });
    this.onPageHide = () => this.#persistCurrentDraft();
    addEventListener("pagehide", this.onPageHide);
  }

  /** Saves an in-progress block when the view changes without tearing down the editor hooks. */
  suspend() {
    this.#stopEditing({ save: true });
    this.#clearDraftTimer();
    this.#releasePendingLocks();
    this.#stopHeartbeat();
  }

  /**
   * Saves any in-progress block, releases every lock this editor may hold or still be
   * requesting, stops the heartbeat, and unregisters the hook. Called when the app closes.
   */
  deactivate() {
    this.#stopEditing({ save: true });
    this.#clearDraftTimer();
    this.#releasePendingLocks();
    this.#stopHeartbeat();
    this.drafts.clear();
    this.noteId = null;
    if (this.onPageHide) {
      removeEventListener("pagehide", this.onPageHide);
      this.onPageHide = null;
    }
    if (this.hookId !== null) {
      Hooks.off("journalinatorLocksChanged", this.hookId);
      this.hookId = null;
    }
  }

  /** Switches the open note if it changed; always call render() afterward to (re)draw. */
  open(noteId) {
    if (this.noteId === noteId) return;
    this.#stopEditing({ save: true });
    this.#releasePendingLocks();
    this.noteId = noteId;
    this.#loadDrafts(noteId);
    if (noteId) requestLockState();
  }

  /** Opens a card and immediately starts editing its first text block. */
  editFirstBlock(noteId, slot) {
    this.open(noteId);
    this.render();
    if (this.readOnly) return;
    const note = notesStore.getNote(noteId);
    const block = note?.system.blocks?.[0];
    if (block && slot) this.editBoardBlock(noteId, slot.dataset.blockId, slot);
    else if (block) this.#clickBlock(block.blockId);
  }

  editBoardBlock(noteId, blockId, slot) {
    this.open(noteId);
    if (this.readOnly) {
      this.render();
      return this.#warnReadOnly();
    }
    if (this.editingBlockId === blockId) {
      this.inlineSlot = slot;
      this.render();
      return;
    }
    this.#stopEditing({ save: true });
    this.#releasePendingLocks();
    this.inlineSlot = slot;
    if (!this.#clickBlock(blockId)) this.inlineSlot = null;
  }

  /** Toggles a rendered GFM task checkbox, taking the block lock when the block is shared. */
  toggleTask(noteId, blockId, index) {
    if (this.readOnly) return this.#warnReadOnly();
    if (this.pendingTaskToggle) {
      releaseLock(this.pendingTaskToggle.noteId, this.pendingTaskToggle.blockId);
      this.pendingTaskToggle = null;
    }
    const note = notesStore.getNote(noteId);
    const block = note?.system.blocks.find(item => item.blockId === blockId);
    if (!block) return;
    // The lock listener only follows the open note, so make this note current before requesting.
    this.open(noteId);
    const next = toggleTaskListItem(block.text, index);
    if (next === null) return;

    if (note.secret || notesStore.isHiddenBlock(noteId, blockId)) {
      gm(() => secrets.saveSecretBlock(noteId, blockId, next));
      return;
    }
    const lock = getLock(noteId, blockId);
    if (lock && lock.userId !== game.user.id) return;
    if (isHeldByMe(noteId, blockId)) {
      this.#saveTaskToggle(noteId, blockId, next);
      return;
    }
    this.pendingTaskToggle = { noteId, blockId, index, text: next };
    requestLock(noteId, blockId);
  }

  #saveTaskToggle(noteId, blockId, text) {
    const write = requestWrite({ type: "saveBlock", noteId, blockId, text });
    this.#releaseAfterWrite(write, noteId, blockId);
  }

  #warnReadOnly() {
    ui.notifications?.warn(t("JN.TopBar.Offline"));
  }

  renameNote(noteId, title) {
    if (this.readOnly) return this.#warnReadOnly();
    const note = notesStore.getNote(noteId);
    if (!note || note.system.deleted || !title) return;
    const current = note.secret ? stripSecretPrefix(note.name) : note.name;
    if (title === current) return;
    return note.secret ? gm(() => secrets.renameSecretNote(noteId, title))
      : requestWrite({ type: "renameNote", noteId, title });
  }

  setTargetHeading(noteId, heading) {
    if (this.readOnly) return this.#warnReadOnly();
    const note = notesStore.getNote(noteId);
    if (!note || note.system.deleted || heading === (note.system.targetHeading ?? "")) return;
    return note.secret ? gm(() => secrets.setSecretTargetHeading(noteId, heading))
      : requestWrite({ type: "setTargetHeading", noteId, heading });
  }

  /** Optional display label; empty is valid and never renames the internal Foundry page. */
  setNoteLabel(noteId, label) {
    if (this.readOnly) return this.#warnReadOnly();
    const note = notesStore.getNote(noteId);
    if (!note || note.system.deleted) return;
    const value = String(label ?? "").trim();
    if (value === (note.system.label ?? "")) return;
    return note.secret ? gm(() => secrets.setSecretNoteLabel(noteId, value))
      : requestWrite({ type: "setNoteLabel", noteId, label: value });
  }

  /** Stores explicit presentation fields; unknown values are rejected by the socket handler. */
  setNotePresentation(noteId, fields) {
    if (this.readOnly) return this.#warnReadOnly();
    const note = notesStore.getNote(noteId);
    if (!note || note.system.deleted || !fields || typeof fields !== "object") return;
    return note.secret ? gm(() => secrets.setSecretNotePresentation(noteId, fields))
      : requestWrite({ type: "setNotePresentation", noteIds: [noteId], fields });
  }

  setNoteKind(noteId, kind) {
    if (this.readOnly) return this.#warnReadOnly();
    const note = notesStore.getNote(noteId);
    if (!note || note.system.deleted || !["note", "location"].includes(kind)) return;
    return note.secret ? gm(() => secrets.setSecretNoteKind(noteId, kind))
      : requestWrite({ type: "setNoteKind", noteId, kind });
  }

  async editNoteImage(noteId, background = false) {
    if (this.readOnly) return this.#warnReadOnly();
    const note = notesStore.getNote(noteId);
    if (!note || note.system.deleted) return;
    const existing = note.system[background ? "backgroundImage" : "image"];
    const value = await promptImageSource(
      t(background ? "JN.Editor.BackgroundURL" : "JN.Editor.ImageURL"),
      existing ?? "",
      existing ? t(background ? "JN.Editor.ClearBackgroundHint" : "JN.Editor.ClearImageHint") : ""
    );
    if (value == null) return;
    const image = value ? noteImagePath(value) : null;
    if (value && !image) return ui.notifications.warn(t("JN.Editor.InvalidImageURL"));
    return note.secret ? gm(() => secrets.setSecretNoteImage(noteId, image, background))
      : requestWrite({ type: "setNoteImage", noteId, image, background });
  }

  #activeTextarea() {
    return this.inlineSlot?.querySelector(".jn-block-input") ?? this.root.querySelector(".jn-block-input");
  }

  suspendBlur() {
    const textarea = this.#activeTextarea();
    if (textarea) textarea.onblur = null;
  }

  #clearInlineInput() {
    const textarea = this.inlineSlot?.querySelector(".jn-block-input");
    if (!textarea) return;
    textarea.onblur = null;
    textarea.remove();
  }

  #finishInlineInput() {
    const inline = !!this.inlineSlot;
    this.#clearInlineInput();
    this.inlineSlot = null;
    if (inline) this.render();
  }

  mount(slot) {
    this.suspendBlur();
    slot.appendChild(this.root);
  }

  render() {
    this.#captureDraftBeforeRebuild();
    this.suspendBlur();
    this.#clearInlineInput();
    this.root.classList.toggle("jn-readonly", this.readOnly);
    const note = this.noteId ? notesStore.getNote(this.noteId) : null;
    if (!note) {
      this.root.replaceChildren();
      return;
    }

    if (note.system.deleted) {
      const restore = t("JN.Common.Restore");
      this.root.innerHTML = `
        <div class="jn-note-tools">
          <button type="button" class="journalinator-restore" title="${esc(restore)}" aria-label="${esc(restore)}">
            <i class="fa-solid fa-trash-arrow-up" aria-hidden="true"></i>
          </button>
        </div>
      `;
      this.root.querySelector(".journalinator-restore").addEventListener("click", () => {
        if (this.readOnly) return this.#warnReadOnly();
        requestWrite({ type: "restoreNote", noteId: this.noteId });
      });
      return;
    }

    this.#pruneSavedDrafts(note);

    const allNotes = notesStore.getAllNotes();
    const authorColor = game.users.get(note.system.authorId)?.color ?? "#8d8d97";
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
    const backlinks = allNotes
      .map(n => [n, (n.system.links ?? []).find(l => l.targetId === note._id)
        ?? (note.system.links ?? []).find(l => l.targetId === n._id)])
      .filter(([, link]) => link)
      .map(([n, link]) => `<button type="button" class="journalinator-chip${link.hidden ? " jn-chip-hidden" : ""}" data-id="${n._id}"${link.hidden ? ` title="${t("JN.Editor.GMOnlyLink")}"` : ""}>${foundry.utils.escapeHTML(n.name)}</button>`)
      .join("") || `<small class="journalinator-meta">${t("JN.Common.NoneYet")}</small>`;
    const gmView = notesStore.merged;
    const tool = (icon, label, content) => `<details class="jn-note-tool">
      <summary title="${esc(label)}" aria-label="${esc(label)}"><i class="fa-solid ${icon}" aria-hidden="true"></i></summary>
      <div class="jn-note-tool-panel">${content}</div></details>`;
    const type = `<select class="journalinator-kind" aria-label="${t("JN.Editor.Type")}">${styleOptions}</select>`;
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
    const gmTools = note.secret ? `
      <div class="jn-gm-banner">
        <button type="button" class="journalinator-declassify">${t("JN.Editor.Declassify")}</button>
        <button type="button" class="journalinator-delete" title="${t("JN.Editor.DeletePermanentTitle")}">&#128465;</button>
      </div>` : `
      <div class="journalinator-row jn-gm-row">
        <button type="button" class="journalinator-hint-toggle${note.system.hint ? " on" : ""}" title="${t("JN.Editor.HintTitle")}">&#10022; ${note.system.hint ? t("JN.Editor.GMHint") : t("JN.Editor.MarkHint")}</button>
        <button type="button" class="journalinator-add-hidden">${t("JN.Editor.AddHiddenBlock")}</button>
      </div>`;

    this.root.innerHTML = `
      <div class="jn-note-tools">
        ${tool("fa-pencil", t("JN.Editor.RenameTitle"), `<div class="journalinator-eh">
          <span class="jn-dot" style="background:${authorColor}"></span>
          <b><button type="button" class="jn-inline-title" title="${t("JN.Editor.RenameTitle")}">${esc(note.name)}</button></b>
        </div>`)}
        ${tool("fa-tag", t("JN.Editor.Label"), `<input type="text" class="journalinator-label" aria-label="${t("JN.Editor.Label")}"
          value="${esc(note.system.label ?? "")}" placeholder="${t("JN.Editor.Label")}" maxlength="200">`)}
        ${tool("fa-link", t("JN.Editor.RelatedNotes"), `<div class="journalinator-chips">${backlinks}</div>`)}
        ${tool("fa-layer-group", t("JN.Editor.Type"), type)}
        ${tool("fa-sliders", t("JN.Editor.Presentation"), presentationPanel)}
        ${presentation.extendedStyle === "target" ? tool("fa-bullseye", t("JN.Style.Target"), `
          <input type="text" class="journalinator-target-heading" aria-label="${t("JN.Style.Target")}"
            value="${esc(presentation.heading)}" placeholder="${t("JN.Style.Target")}" maxlength="80">`) : ""}
        ${gmView || note.secret ? tool("fa-lock", t("JN.Editor.GMOnly"), gmTools + (this.callbacks.boardOnly ? note.system.blocks.map((block, index) =>
          `<div class="jn-note-block-tools" data-block-id="${esc(block.blockId)}"><span>${index + 1}</span>
            ${this.#gmBlockActions(note, block, !block.hidden && !!getLock(note._id, block.blockId))}</div>`).join("") : "")) : ""}
      </div>
      <div class="jn-doc" ${this.callbacks.boardOnly ? "hidden" : ""}>
        ${note.system.blocks.filter(block => !this.callbacks.boardOnly || block.blockId === this.editingBlockId)
          .map(block => this.#renderBlockHTML(note, block)).join("")}
      </div>
    `;

    const liveTextarea = this.root.querySelector(".jn-block-input");
    if (liveTextarea && this.inlineSlot?.parentNode) this.inlineSlot.appendChild(liveTextarea);
    this.#bindHandlers(note);
    liveTextarea?.focus();
  }

  #renderBlockHTML(note, block) {
    const lock = block.hidden ? null : getLock(note._id, block.blockId);
    const mine = lock?.userId === game.user.id;
    const lockedByOther = lock && !mine;
    const pending = this.pendingBlockId === block.blockId && !lock;
    const editing = this.editingBlockId === block.blockId;
    const author = game.users.get(block.authorId || note.system.authorId);
    const vars = `--jn-au:${author?.color ?? "#8d8d97"};--jn-lc:${lock?.userColor ?? "transparent"}`;
    const classes = ["jn-block"];
    if (lockedByOther || mine) classes.push("jn-locked");
    if (pending) classes.push("jn-pending");
    if (editing) classes.push("editing");
    if (block.hidden && !note.secret) classes.push("jn-hidden-block");

    let tag = "";
    if (lockedByOther) tag = `<span class="jn-tag">${t("JN.Editor.EditingBy", { name: foundry.utils.escapeHTML(lock.userName) })}</span>`;
    else if (mine) tag = `<span class="jn-tag">${t("JN.Editor.YouEditing")}</span>`;
    else if (pending) tag = `<span class="jn-tag">${t("JN.Editor.Requesting")}</span>`;
    else if (!editing && this.drafts.has(block.blockId)) tag = `<span class="jn-tag jn-draft-tag">${t("JN.Editor.UnsavedDraft")}</span>`;

    if (editing) {
      const text = this.drafts.get(block.blockId) ?? block.text;
      return `<div class="${classes.join(" ")}" data-block-id="${block.blockId}" style="${vars}">${tag}<textarea class="jn-block-input">${foundry.utils.escapeHTML(text)}</textarea></div>`;
    }
    const cursor = lockedByOther ? "not-allowed" : "text";
    const rendered = renderMarkdown(block.text, { interactiveTasks: !this.readOnly });
    const body = rendered
      ? `<div class="jn-block-markdown">${rendered}</div>`
      : `<span class="jn-empty-block">${block.hidden ? t("JN.Editor.EmptyHiddenBlock") : t("JN.Editor.EmptyBlock")}</span>`;
    return `<div class="${classes.join(" ")}" data-block-id="${block.blockId}" style="${vars};cursor:${cursor}" title="${foundry.utils.escapeHTML(author?.name ?? "")}">${tag}${this.#gmBlockActions(note, block, lockedByOther)}${body}</div>`;
  }

  /** Hover controls for GMs: hide a shared block, reveal/delete a hidden one, add a hidden block after. */
  #gmBlockActions(note, block, lockedByOther) {
    if (!notesStore.merged) return "";
    const buttons = [];
    if (note.secret) {
      if (note.system.blocks.length > 1) buttons.push(`<button type="button" data-act="delete" title="${t("JN.Editor.DeleteBlockTitle")}">&#10005;</button>`);
    } else if (block.hidden) {
      buttons.push(`<button type="button" data-act="reveal" title="${t("JN.Editor.ShowBlockTitle")}">${t("JN.Common.Reveal")}</button>`);
      buttons.push(`<button type="button" data-act="delete" title="${t("JN.Editor.DeleteHiddenBlockTitle")}">&#10005;</button>`);
    } else if (!lockedByOther) {
      buttons.push(`<button type="button" data-act="hide" title="${t("JN.Editor.HideBlockTitle")}">${t("JN.Common.Hide")}</button>`);
    }
    buttons.push(`<button type="button" data-act="add" title="${t("JN.Editor.AddHiddenAfterTitle")}">+</button>`);
    return `<span class="jn-block-gm">${buttons.join("")}</span>`;
  }

  #bindHandlers(note) {
    const noteId = this.noteId;
    const tools = this.root.querySelectorAll(".jn-note-tool");
    for (const tool of tools) tool.addEventListener("toggle", () => {
      if (!tool.open) return;
      for (const other of tools) if (other !== tool) other.open = false;
    });
    for (const tool of tools) tool.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !tool.open || event.defaultPrevented) return;
      event.stopPropagation();
      tool.open = false;
      tool.querySelector("summary").focus();
    });
    const initialTitle = note.secret ? stripSecretPrefix(note.name) : note.name;
    const rename = title => this.renameNote(noteId, title);
    const titleButton = this.root.querySelector(".jn-inline-title");
    titleButton.addEventListener("click", () => {
      const input = document.createElement("input");
      input.className = "jn-inline-title-input";
      input.type = "text";
      input.value = initialTitle;
      input.setAttribute("aria-label", t("JN.Editor.RenameTitle"));
      titleButton.replaceWith(input);
      const finish = save => {
        if (!input.isConnected) return;
        const title = input.value.trim();
        input.replaceWith(titleButton);
        if (save) rename(title);
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

    this.root.querySelector(".journalinator-declassify")?.addEventListener("click", () => this.#declassifyNote(note));
    this.root.querySelector(".journalinator-hint-toggle")?.addEventListener("click", () => {
      requestWrite({ type: "gmSetHint", noteId, hint: !note.system.hint });
    });
    this.root.querySelector(".journalinator-add-hidden")?.addEventListener("click", () => this.#addHiddenAfter(null));
    this.root.querySelectorAll(".jn-block-gm button").forEach(btn => {
      btn.addEventListener("click", ev => {
        ev.stopPropagation();
        const blockId = btn.closest("[data-block-id]").dataset.blockId;
        this.#gmBlockAction(note, blockId, btn.dataset.act);
      });
    });

    this.root.querySelector(".journalinator-delete")?.addEventListener("click", async () => {
      if (note.secret) {
        const ok = await DialogV2.confirm({
          window: { title: t("JN.Editor.DeleteSecretNote") },
          content: `<p>${t("JN.Editor.DeleteSecretConfirm", { name: esc(note.name) })}</p>`
        });
        if (!ok) return;
        this.#stopEditing();
        await gm(() => secrets.deleteSecretNote(noteId));
        this.callbacks.onSelectNote?.(null);
        return;
      }
      this.#stopEditing();
      requestWrite({ type: "deleteNote", noteId });
    });

    this.root.querySelectorAll(".journalinator-chip").forEach(el => {
      el.addEventListener("click", () => this.callbacks.onFocusNote(el.dataset.id));
    });

    const labelInput = this.root.querySelector(".journalinator-label");
    const commitLabel = () => this.setNoteLabel(noteId, labelInput.value);
    labelInput?.addEventListener("change", commitLabel);
    labelInput?.addEventListener("keydown", event => {
      if (event.isComposing || event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      labelInput.blur();
    });

    this.root.querySelector(".journalinator-kind")?.addEventListener("change", ev => {
      const type = ev.target.value;
      if (type === "location") {
        this.setNoteKind(noteId, "location");
        this.setNotePresentation(noteId, { extendedStyle: "document", forceExtended: true });
        return;
      }
      if (note.system.kind === "location") this.setNoteKind(noteId, "note");
      if (type === "auto") this.setNotePresentation(noteId, { forceExtended: false });
      else this.setNotePresentation(noteId, { extendedStyle: type, forceExtended: true });
    });
    this.root.querySelector(".journalinator-font")?.addEventListener("change", ev => {
      this.setNotePresentation(noteId, { font: ev.target.value });
    });
    this.root.querySelector(".journalinator-picture-layout")?.addEventListener("change", ev => {
      this.setNotePresentation(noteId, { pictureLayout: ev.target.value });
    });
    this.root.querySelector(".journalinator-force-extended")?.addEventListener("change", ev => {
      this.setNotePresentation(noteId, { forceExtended: ev.target.checked });
    });
    this.root.querySelector(".journalinator-torn")?.addEventListener("change", ev => {
      this.setNotePresentation(noteId, { torn: ev.target.checked });
    });

    const targetHeading = this.root.querySelector(".journalinator-target-heading");
    targetHeading?.addEventListener("change", () => {
      this.setTargetHeading(noteId, targetHeading.value.trim());
    });
    targetHeading?.addEventListener("keydown", event => {
      if (event.isComposing || event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      targetHeading.blur();
    });

    this.root.querySelectorAll(".jn-block:not(.editing)").forEach(el => {
      el.addEventListener("click", ev => {
        if (ev.target.closest("a[href], input[type=\"checkbox\"]")) return;
        this.#clickBlock(el.dataset.blockId);
      });
      el.querySelectorAll('input[type="checkbox"]').forEach((box, index) => {
        box.addEventListener("click", ev => {
          ev.preventDefault();
          ev.stopPropagation();
          this.toggleTask(note._id, el.dataset.blockId, index);
        });
      });
    });

    const textarea = this.#activeTextarea();
    if (textarea) {
      textarea.addEventListener("keydown", ev => applyMarkdownAutocomplete(ev, textarea));
      textarea.addEventListener("input", () => this.#queueDraftSave());
      textarea.onblur = () => this.#stopEditing({ save: true });
      if (this.inlineSlot) {
        textarea.setAttribute("aria-label", t("JN.Editor.EditCardText"));
        textarea.addEventListener("keydown", ev => {
          if (ev.isComposing || !(ev.key === "Escape" || (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)))) return;
          ev.preventDefault();
          ev.stopImmediatePropagation();
          this.#stopEditing({ save: ev.key !== "Escape" });
        });
      }
      textarea.addEventListener("keydown", ev => this.#onTextareaKeydown(ev, note));
    }
  }

  #clickBlock(blockId) {
    if (this.readOnly) {
      this.#warnReadOnly();
      return false;
    }
    if (this.pendingTaskToggle) {
      releaseLock(this.pendingTaskToggle.noteId, this.pendingTaskToggle.blockId);
      this.pendingTaskToggle = null;
    }
    if (this.editingBlockId === blockId || this.pendingBlockId === blockId) return;
    if (notesStore.isHiddenBlock(this.noteId, blockId)) {
      // GM-only blocks take no lock: lock traffic is broadcast and would reveal the block exists.
      this.#stopEditing({ save: true });
      this.editingBlockId = blockId;
      this.editingSecret = true;
      this.render();
      return true;
    }
    const lock = getLock(this.noteId, blockId);
    if (lock && lock.userId !== game.user.id) return; // locked by someone else — not clickable
    this.pendingBlockId = blockId;
    this.render();
    requestLock(this.noteId, blockId);
    return true;
  }

  #onLockChanged(blockId, lock) {
    const mine = lock?.userId === game.user.id;

    if (this.pendingTaskToggle?.blockId === blockId) {
      const task = this.pendingTaskToggle;
      this.pendingTaskToggle = null;
      if (mine) this.#saveTaskToggle(task.noteId, task.blockId, task.text);
      else this.render();
      return;
    }

    if (this.pendingBlockId === blockId) {
      this.pendingBlockId = null;
      if (mine) {
        this.editingBlockId = blockId;
        this.#startHeartbeat(blockId);
      } else this.inlineSlot = null;
      this.render();
      return;
    }

    if (this.pendingMerge?.prevBlockId === blockId) {
      if (!mine) {
        // The previous block is held by someone else (or the request timed out): stop waiting,
        // otherwise a later unrelated grant could trigger a merge the user no longer expects.
        this.pendingMerge = null;
        this.render();
        return;
      }
      const { blockId: currentBlockId, prevBlockId } = this.pendingMerge;
      this.pendingMerge = null;
      this.#performMerge(currentBlockId, prevBlockId);
      return;
    }

    if (this.editingBlockId === blockId && !mine) {
      // lost the lock involuntarily (expired, or a conflicting grant elsewhere) — rescue the draft
      const textarea = this.#activeTextarea();
      if (textarea) {
        this.drafts.set(blockId, textarea.value);
        this.#persistDraft(blockId, textarea.value);
      }
      this.editingBlockId = null;
      this.#stopHeartbeat();
      this.#clearDraftTimer();
      this.render();
      this.inlineSlot = null;
      return;
    }

    this.render();
  }

  #startHeartbeat(blockId) {
    this.#stopHeartbeat();
    this.heartbeatTimer = setInterval(() => sendHeartbeat(this.noteId, blockId), HEARTBEAT_INTERVAL_MS);
  }

  #stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** Releases locks we asked for but have not yet promoted to an active block edit. */
  #releasePendingLocks() {
    if (!this.noteId) return;
    if (this.pendingBlockId) releaseLock(this.noteId, this.pendingBlockId);
    if (this.pendingMerge) releaseLock(this.noteId, this.pendingMerge.prevBlockId);
    if (this.pendingTaskToggle) releaseLock(this.pendingTaskToggle.noteId, this.pendingTaskToggle.blockId);
    this.pendingBlockId = null;
    this.pendingMerge = null;
    this.pendingTaskToggle = null;
    if (!this.editingBlockId) this.inlineSlot = null;
  }

  #stopEditing({ save = false } = {}) {
    if (!this.editingBlockId) return;
    const blockId = this.editingBlockId;
    const noteId = this.noteId;
    this.#clearDraftTimer();
    const textarea = this.#activeTextarea();
    const note = notesStore.getNote(noteId);
    const originalText = note?.system.blocks.find(b => b.blockId === blockId)?.text ?? "";
    let write = null;

    const secret = this.editingSecret;
    this.editingSecret = false;

    if (save && textarea && textarea.value !== originalText) {
      this.drafts.set(blockId, textarea.value);
      this.#persistDraft(blockId, textarea.value);
      if (secret) write = gm(() => secrets.saveSecretBlock(noteId, blockId, textarea.value));
      else if (this.#blocksSecretMention(textarea.value)) write = null; // kept as a draft
      else write = requestWrite({ type: "saveBlock", noteId, blockId, text: textarea.value });
    } else if (save && !textarea && this.drafts.has(blockId)) {
      // No textarea to send, but a persisted draft exists; keep it for recovery.
    } else {
      this.#removeDraft(blockId);
    }

    this.editingBlockId = null;
    this.#finishInlineInput();
    if (secret) return;

    // For the active GM, requestWrite is queued; releasing first would let the queued
    // saveBlock fail its lock check. Wait for the write before releasing in that case.
    if (write) this.#releaseAfterWrite(write, noteId, blockId);
    else releaseLock(noteId, blockId);
    this.#stopHeartbeat();
  }

  #releaseAfterWrite(write, noteId, ...blockIds) {
    Promise.resolve(write).finally(() => {
      for (const blockId of blockIds) {
        const reacquired = this.noteId === noteId && (
          this.editingBlockId === blockId ||
          this.pendingBlockId === blockId ||
          this.pendingMerge?.prevBlockId === blockId
        );
        if (!reacquired) releaseLock(noteId, blockId);
      }
    });
  }

  #captureDraftBeforeRebuild() {
    if (!this.editingBlockId) return;
    const textarea = this.#activeTextarea();
    if (textarea) {
      this.drafts.set(this.editingBlockId, textarea.value);
      this.#persistDraft(this.editingBlockId, textarea.value);
    }
  }

  #queueDraftSave() {
    if (!this.editingBlockId) return;
    this.#clearDraftTimer();
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      this.#persistCurrentDraft();
    }, DRAFT_SAVE_DELAY_MS);
  }

  #clearDraftTimer() {
    clearTimeout(this.draftTimer);
    this.draftTimer = null;
  }

  #persistCurrentDraft() {
    if (!this.editingBlockId) return;
    const textarea = this.#activeTextarea();
    if (!textarea) return;
    this.drafts.set(this.editingBlockId, textarea.value);
    this.#persistDraft(this.editingBlockId, textarea.value);
  }

  #draftPrefix(noteId = this.noteId) {
    const worldId = game.world?.id ?? "world";
    const userId = game.user?.id ?? "user";
    return `journalinator.draft.${worldId}.${userId}.${noteId}.`;
  }

  #storage() {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }

  #persistDraft(blockId, text) {
    const storage = this.#storage();
    if (!storage || !this.noteId) return;
    try {
      storage.setItem(this.#draftPrefix() + blockId, JSON.stringify({ text, at: Date.now() }));
    } catch {
      // Quota/private-mode failures are non-fatal; the in-memory draft still works.
    }
  }

  #removeDraft(blockId) {
    this.drafts.delete(blockId);
    const storage = this.#storage();
    if (!storage || !this.noteId) return;
    try {
      storage.removeItem(this.#draftPrefix() + blockId);
    } catch {
      // ignore
    }
  }

  #loadDrafts(noteId) {
    this.drafts.clear();
    if (!noteId) return;
    const storage = this.#storage();
    if (!storage) return;
    const note = notesStore.getNote(noteId);
    const blockText = new Map((note?.system.blocks ?? []).map(block => [block.blockId, block.text]));
    const prefix = this.#draftPrefix(noteId);

    try {
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) {
        const blockId = key.slice(prefix.length);
        let raw;
        try {
          raw = JSON.parse(storage.getItem(key) ?? "null");
        } catch {
          storage.removeItem(key);
          continue;
        }
        const stale = !raw || typeof raw.text !== "string" ||
          !Number.isFinite(raw.at) || Date.now() - raw.at > DRAFT_TTL_MS;
        const blockGone = Boolean(note) && !blockText.has(blockId);
        const alreadySaved = Boolean(note) && blockText.get(blockId) === raw?.text;
        if (stale || blockGone || alreadySaved) {
          storage.removeItem(key);
          continue;
        }
        this.drafts.set(blockId, raw.text);
      }
    } catch {
      // Storage can be unavailable; memory drafts still work for this session.
    }
  }

  #pruneSavedDrafts(note) {
    for (const [blockId, text] of [...this.drafts]) {
      const block = note.system.blocks.find(b => b.blockId === blockId);
      if (!block || block.text === text) this.#removeDraft(blockId);
    }
  }

  #onTextareaKeydown(ev, note) {
    if (ev.isComposing) return;
    const textarea = ev.target;
    const blockId = this.editingBlockId;

    if (ev.key === "Enter" && textarea.value.slice(0, textarea.selectionStart).endsWith("\n")) {
      ev.preventDefault();
      const noteId = this.noteId;
      const beforeText = textarea.value.slice(0, textarea.selectionStart).replace(/\n+$/, "");
      const afterText = textarea.value.slice(textarea.selectionStart);
      if (this.editingSecret) {
        this.#clearDraftTimer();
        this.#removeDraft(blockId);
        this.editingBlockId = null;
        this.editingSecret = false;
        this.#finishInlineInput();
        gm(() => secrets.splitSecretBlock(noteId, blockId, beforeText, afterText));
        return;
      }
      if (this.#blocksSecretMention(beforeText + afterText)) return;
      this.#clearDraftTimer();
      this.#removeDraft(blockId);
      this.editingBlockId = null;
      this.#finishInlineInput();
      this.#stopHeartbeat();
      const write = requestWrite({ type: "splitBlock", noteId, blockId, beforeText, afterText });
      this.#releaseAfterWrite(write, noteId, blockId);
      return;
    }

    if (ev.key === "Backspace" && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
      const blocks = note.system.blocks;
      const index = blocks.findIndex(b => b.blockId === blockId);
      if (index <= 0) return; // first block — nothing to merge into
      // Hidden and shared blocks never merge into each other.
      if (!!blocks[index - 1].hidden !== this.editingSecret) return;
      ev.preventDefault();
      const prevBlockId = blocks[index - 1].blockId;
      if (this.editingSecret) {
        const noteId = this.noteId;
        // Capture the textarea first: a merge must use what is on screen, not the last save.
        const text = textarea.value;
        this.#clearDraftTimer();
        this.#removeDraft(blockId);
        this.editingBlockId = null;
        this.editingSecret = false;
        this.#finishInlineInput();
        gm(() => secrets.mergeSecretBlockUp(noteId, blockId, text));
        return;
      }
      if (isHeldByMe(this.noteId, prevBlockId)) {
        this.#performMerge(blockId, prevBlockId);
      } else {
        this.pendingMerge = { blockId, prevBlockId };
        requestLock(this.noteId, prevBlockId);
      }
    }
  }

  #performMerge(blockId, prevBlockId) {
    const noteId = this.noteId;
    // The active textarea may contain edits that were never saved. Pass them along so the
    // merge does not resurrect the older stored text and silently discard the user's typing.
    const text = this.#activeTextarea()?.value;
    this.#clearDraftTimer();
    this.#removeDraft(blockId);
    this.editingBlockId = null;
    this.#finishInlineInput();
    this.#stopHeartbeat();
    const write = requestWrite({
      type: "mergeBlockUp", noteId, blockId, ...(typeof text === "string" ? { text } : {})
    });
    this.#releaseAfterWrite(write, noteId, blockId, prevBlockId);
  }

  /**
   * GMs only: refuses to send shared text that links a secret note by its `GM-XXXX` title, which
   * would otherwise create a public note carrying that title. The text stays as a local draft.
   */
  #blocksSecretMention(text) {
    if (!notesStore.merged) return false;
    const mentions = secrets.prefixedSecretMentions(text);
    if (!mentions.length) return false;
    ui.notifications.error(t("JN.Editor.PrefixedMentionError", { mentions: mentions.join(", ") }));
    return true;
  }

  async #confirmBareMentions(text, what) {
    const mentions = secrets.bareSecretMentions(text);
    if (!mentions.length) return true;
    return DialogV2.confirm({
      window: { title: t("JN.Editor.SecretMentionsTitle") },
      content: `<p>${t("JN.Editor.SecretMentionsBody", { what, names: mentions.map(esc).join(", ") })}</p><p>${t("JN.Editor.SecretMentionsContinue")}</p>`
    });
  }

  async #addHiddenAfter(afterBlockId) {
    const noteId = this.noteId;
    this.#stopEditing({ save: true });
    const newId = await gm(() => secrets.addHiddenBlock(noteId, afterBlockId));
    if (!newId || this.noteId !== noteId) return;
    if (this.callbacks.onEditHiddenBlock) return this.callbacks.onEditHiddenBlock(noteId, newId);
    this.editingBlockId = newId;
    this.editingSecret = true;
    this.render();
  }

  async #gmBlockAction(note, blockId, act) {
    const noteId = note._id;
    const block = note.system.blocks.find(b => b.blockId === blockId);
    if (!block) return;
    if (act === "add") return this.#addHiddenAfter(blockId);

    // Include anything typed in the active textarea so a reveal confirmation sees the text that
    // is about to be published, not the older saved copy.
    const currentText = this.editingBlockId === blockId && this.noteId === noteId
      ? (this.#activeTextarea()?.value ?? block.text) : block.text;
    if (this.editingBlockId === blockId) this.#stopEditing({ save: true });

    if (act === "delete") {
      const ok = !block.text || await DialogV2.confirm({
        window: { title: t("JN.Editor.DeleteHiddenBlockTitle") },
        content: `<p>${t("JN.Editor.DeleteHiddenConfirm")}</p>`
      });
      if (ok) gm(() => secrets.deleteSecretBlock(noteId, blockId));
      return;
    }

    if (act === "reveal") {
      if (!(await this.#confirmBareMentions(currentText, t("JN.Editor.WhatBlock")))) return;
      gm(() => secrets.declassifyBlock(noteId, blockId));
      return;
    }

    if (act === "hide") {
      const ok = await DialogV2.confirm({
        window: { title: t("JN.Editor.HideBlockDialogTitle") },
        content: `<p>${t("JN.Editor.HideBlockConfirm")}</p><p>${t("JN.Editor.HideBlockQuestion")}</p>`
      });
      if (ok) gm(() => secrets.hideSharedBlock(noteId, blockId));
    }
  }

  async #declassifyNote(note) {
    // Capture the in-progress textarea before opening the title dialog: opening it can blur the
    // editor and save, after which `note` is an older snapshot.
    const text = note.system.blocks.map(block => {
      const live = this.noteId === note._id && this.editingBlockId === block.blockId
        ? this.#activeTextarea()?.value : null;
      return live ?? block.text;
    }).join("\n");
    const title = await this.#promptText(t("JN.Editor.DeclassifyPublicTitle"), stripSecretPrefix(note.name));
    if (!title) return;
    if (!(await this.#confirmBareMentions(text, t("JN.Editor.WhatNote")))) return;
    this.#stopEditing({ save: true });
    gm(() => secrets.declassifyNote(note._id, title));
  }

  async #promptText(title, initial, hint = "") {
    return foundry.applications.api.DialogV2.prompt({
      window: { title },
      content: `<input type="text" name="value" autofocus value="${esc(initial)}">${hint ? `<p>${esc(hint)}</p>` : ""}`,
      ok: { label: t("JN.Common.OK"), callback: (event, button) => button.form.elements.value.value.trim() },
      rejectClose: false
    });
  }
}
