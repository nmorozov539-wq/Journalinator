import { notesStore } from "../store/notes-store.mjs";
import { requestWrite } from "../socket.mjs";
import { requestLock, releaseLock, sendHeartbeat, requestLockState, getLock, isHeldByMe } from "../locks.mjs";
import { CARD_STYLES } from "../styles/registry.mjs";

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
    this.callbacks = callbacks; // { onFocusNote(id) }
    this.root = document.createElement("div");
    this.root.className = "journalinator-editor-inner";
    this.noteId = null;
    this.editingBlockId = null;
    this.pendingBlockId = null;
    this.pendingMerge = null; // { blockId, prevBlockId }
    this.drafts = new Map();
    this.showAuthors = false;
    this.heartbeatTimer = null;
    this.hookId = null;
    this.draftTimer = null;
    this.onPageHide = null;
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

  render() {
    this.#captureDraftBeforeRebuild();
    const note = this.noteId ? notesStore.getNote(this.noteId) : null;
    if (!note) {
      this.root.innerHTML = `<p class="journalinator-empty">Select a note to open it.</p>`;
      return;
    }

    if (note.system.deleted) {
      this.root.innerHTML = `
        <div class="journalinator-eh"><b>${foundry.utils.escapeHTML(note.name)}</b></div>
        <p class="journalinator-meta">This note is in the trash.</p>
        <button type="button" class="journalinator-restore">Restore</button>
      `;
      this.root.querySelector(".journalinator-restore").addEventListener("click", () => {
        requestWrite({ type: "restoreNote", noteId: this.noteId });
      });
      return;
    }

    this.#pruneSavedDrafts(note);

    const allNotes = notesStore.getAllNotes();
    const authorColor = game.users.get(note.system.authorId)?.color ?? "#8d8d97";
    const authorName = game.users.get(note.system.authorId)?.name ?? "unknown";
    const styleOptions = Object.entries(CARD_STYLES)
      .map(([key, def]) => `<option value="${key}" ${note.system.style === key ? "selected" : ""}>${def.label}</option>`)
      .join("");
    const backlinks = allNotes
      .filter(n => (n.system.links ?? []).some(l => l.targetId === note._id))
      .map(n => `<button type="button" class="journalinator-chip" data-id="${n._id}">${foundry.utils.escapeHTML(n.name)}</button>`)
      .join("") || `<small class="journalinator-meta">None yet</small>`;
    const contributors = Object.entries(note.system.contributions ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([userId, chars]) => `${foundry.utils.escapeHTML(game.users.get(userId)?.name ?? "someone")} (${chars})`)
      .join(", ");

    this.root.innerHTML = `
      <div class="journalinator-eh">
        <span class="jn-dot" style="background:${authorColor}"></span>
        <b>${foundry.utils.escapeHTML(note.name)}</b>
        <button type="button" class="journalinator-rename" title="Rename note">&#9998;</button>
        <button type="button" class="journalinator-authors-toggle">${this.showAuthors ? "Hide authors" : "Authors"}</button>
        <button type="button" class="journalinator-delete" title="Move to trash">&#128465;</button>
      </div>
      <div class="journalinator-meta">Linked from</div>
      <div class="journalinator-chips">${backlinks}</div>
      <div class="journalinator-row">
        <label>Style <select class="journalinator-style">${styleOptions}</select></label>
      </div>
      <div class="journalinator-row">
        <button type="button" class="journalinator-set-image">${note.system.image ? "Change Image" : "Set Image"}</button>
        ${note.system.image ? `<button type="button" class="journalinator-clear-image">Remove Image</button>` : ""}
        <button type="button" class="journalinator-new-linked">+ New Linked Note</button>
      </div>
      <p class="journalinator-meta">by ${foundry.utils.escapeHTML(authorName)} &middot; ${note.system.editCount ?? 0} edits</p>
      ${contributors ? `<p class="journalinator-meta">Characters added: ${contributors}</p>` : ""}
      <div class="jn-doc ${this.showAuthors ? "jn-show-authors" : ""}">
        ${note.system.blocks.map(b => this.#renderBlockHTML(note, b)).join("")}
      </div>
    `;

    this.#bindHandlers(note);
    const liveTextarea = this.root.querySelector(".jn-block.editing textarea");
    liveTextarea?.focus();
  }

  #renderBlockHTML(note, block) {
    const lock = getLock(note._id, block.blockId);
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

    let tag = "";
    if (lockedByOther) tag = `<span class="jn-tag">${foundry.utils.escapeHTML(lock.userName)} is editing&hellip;</span>`;
    else if (mine) tag = `<span class="jn-tag">You're editing</span>`;
    else if (pending) tag = `<span class="jn-tag">Requesting&hellip;</span>`;
    else if (!editing && this.drafts.has(block.blockId)) tag = `<span class="jn-tag jn-draft-tag">unsaved draft</span>`;

    if (editing) {
      const text = this.drafts.get(block.blockId) ?? block.text;
      return `<div class="${classes.join(" ")}" data-block-id="${block.blockId}" style="${vars}">${tag}<textarea class="jn-block-input">${foundry.utils.escapeHTML(text)}</textarea></div>`;
    }
    const cursor = lockedByOther ? "not-allowed" : "text";
    return `<p class="${classes.join(" ")}" data-block-id="${block.blockId}" style="${vars};cursor:${cursor}" title="${foundry.utils.escapeHTML(author?.name ?? "")}">${tag}${foundry.utils.escapeHTML(block.text)}</p>`;
  }

  #bindHandlers(note) {
    this.root.querySelector(".journalinator-rename")?.addEventListener("click", async () => {
      const title = await this.#promptText("Rename Note", note.name);
      if (!title || title === note.name) return;
      requestWrite({ type: "renameNote", noteId: this.noteId, title });
    });

    this.root.querySelector(".journalinator-authors-toggle")?.addEventListener("click", () => {
      this.showAuthors = !this.showAuthors;
      this.render();
    });

    this.root.querySelector(".journalinator-delete")?.addEventListener("click", () => {
      this.#stopEditing();
      requestWrite({ type: "deleteNote", noteId: this.noteId });
    });

    this.root.querySelectorAll(".journalinator-chip").forEach(el => {
      el.addEventListener("click", () => this.callbacks.onFocusNote(el.dataset.id));
    });

    this.root.querySelector(".journalinator-style")?.addEventListener("change", ev => {
      requestWrite({ type: "setNoteStyle", noteId: this.noteId, style: ev.target.value });
    });

    this.root.querySelector(".journalinator-set-image")?.addEventListener("click", () => {
      new foundry.applications.apps.FilePicker({
        type: "image",
        current: note.system.image ?? "",
        callback: path => requestWrite({ type: "setNoteImage", noteId: this.noteId, image: path })
      }).render(true);
    });

    this.root.querySelector(".journalinator-clear-image")?.addEventListener("click", () => {
      requestWrite({ type: "setNoteImage", noteId: this.noteId, image: null });
    });

    this.root.querySelector(".journalinator-new-linked")?.addEventListener("click", async () => {
      const title = await this.#promptText("New Linked Note", "");
      if (!title) return;
      requestWrite({ type: "newLinkedNote", sourceId: this.noteId, title });
    });

    this.root.querySelectorAll(".jn-block:not(.editing)").forEach(el => {
      el.addEventListener("click", () => this.#clickBlock(el.dataset.blockId));
    });

    const textarea = this.root.querySelector(".jn-block-input");
    if (textarea) {
      textarea.addEventListener("input", () => this.#queueDraftSave());
      textarea.addEventListener("blur", () => this.#stopEditing({ save: true }));
      textarea.addEventListener("keydown", ev => this.#onTextareaKeydown(ev, note));
    }
  }

  #clickBlock(blockId) {
    if (this.editingBlockId === blockId || this.pendingBlockId === blockId) return;
    const lock = getLock(this.noteId, blockId);
    if (lock && lock.userId !== game.user.id) return; // locked by someone else — not clickable
    this.pendingBlockId = blockId;
    this.render();
    requestLock(this.noteId, blockId);
  }

  #onLockChanged(blockId, lock) {
    const mine = lock?.userId === game.user.id;

    if (this.pendingBlockId === blockId) {
      this.pendingBlockId = null;
      if (mine) {
        this.editingBlockId = blockId;
        this.#startHeartbeat(blockId);
      }
      this.render();
      return;
    }

    if (this.pendingMerge?.prevBlockId === blockId && mine) {
      const { blockId: currentBlockId, prevBlockId } = this.pendingMerge;
      this.pendingMerge = null;
      this.#performMerge(currentBlockId, prevBlockId);
      return;
    }

    if (this.editingBlockId === blockId && !mine) {
      // lost the lock involuntarily (expired, or a conflicting grant elsewhere) — rescue the draft
      const textarea = this.root.querySelector(".jn-block-input");
      if (textarea) {
        this.drafts.set(blockId, textarea.value);
        this.#persistDraft(blockId, textarea.value);
      }
      this.editingBlockId = null;
      this.#stopHeartbeat();
      this.#clearDraftTimer();
      this.render();
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
    this.pendingBlockId = null;
    this.pendingMerge = null;
  }

  #stopEditing({ save = false } = {}) {
    if (!this.editingBlockId) return;
    const blockId = this.editingBlockId;
    const noteId = this.noteId;
    this.#clearDraftTimer();
    const textarea = this.root.querySelector(".jn-block-input");
    const note = notesStore.getNote(noteId);
    const originalText = note?.system.blocks.find(b => b.blockId === blockId)?.text ?? "";
    let write = null;

    if (save && textarea && textarea.value !== originalText) {
      this.drafts.set(blockId, textarea.value);
      this.#persistDraft(blockId, textarea.value);
      write = requestWrite({ type: "saveBlock", noteId, blockId, text: textarea.value });
    } else if (save && !textarea && this.drafts.has(blockId)) {
      // No textarea to send, but a persisted draft exists; keep it for recovery.
    } else {
      this.#removeDraft(blockId);
    }

    // For the active GM, requestWrite is queued; releasing first would let the queued
    // saveBlock fail its lock check. Wait for the write before releasing in that case.
    if (write) this.#releaseAfterWrite(write, noteId, blockId);
    else releaseLock(noteId, blockId);
    this.editingBlockId = null;
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
    const textarea = this.root.querySelector(".jn-block-input");
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
    const textarea = this.root.querySelector(".jn-block-input");
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
    const textarea = ev.target;
    const blockId = this.editingBlockId;

    if (ev.key === "Enter" && textarea.value.slice(0, textarea.selectionStart).endsWith("\n")) {
      ev.preventDefault();
      const noteId = this.noteId;
      const beforeText = textarea.value.slice(0, textarea.selectionStart).replace(/\n+$/, "");
      const afterText = textarea.value.slice(textarea.selectionStart);
      this.#clearDraftTimer();
      this.#removeDraft(blockId);
      this.editingBlockId = null;
      this.#stopHeartbeat();
      const write = requestWrite({ type: "splitBlock", noteId, blockId, beforeText, afterText });
      this.#releaseAfterWrite(write, noteId, blockId);
      return;
    }

    if (ev.key === "Backspace" && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
      const blocks = note.system.blocks;
      const index = blocks.findIndex(b => b.blockId === blockId);
      if (index <= 0) return; // first block — nothing to merge into
      ev.preventDefault();
      const prevBlockId = blocks[index - 1].blockId;
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
    this.#clearDraftTimer();
    this.#removeDraft(blockId);
    this.editingBlockId = null;
    this.#stopHeartbeat();
    const write = requestWrite({ type: "mergeBlockUp", noteId, blockId });
    this.#releaseAfterWrite(write, noteId, blockId, prevBlockId);
  }

  async #promptText(title, initial) {
    return foundry.applications.api.DialogV2.prompt({
      window: { title },
      content: `<input type="text" name="value" autofocus value="${foundry.utils.escapeHTML(initial)}">`,
      ok: { label: "OK", callback: (event, button) => button.form.elements.value.value.trim() },
      rejectClose: false
    });
  }
}
