/**
 * Private-canvas adapter for the shared in-place `NoteEditor`.
 *
 * The private canvas uses exactly the same editor UI, parser, toolbar, recovery dialog and
 * autosave session as the shared canvas. What differs is the transport: T7a's
 * `createPrivateTransport` writes the owner's private workspace page under its `rev` CAS and a
 * per-tab local coordinator, with no GM lease, no socket preview and no shared activity.
 *
 * One `NoteEditor` instance is created per open note because its transport is bound to that
 * note. Closing the editor deactivates hooks and detaches the DOM; the canvas card itself keeps
 * its rotation and is never rebuilt while the editor is mounted.
 */

import NoteEditor from "./editor.mjs";
import { DraftStore } from "../editor/drafts.mjs";
import { PrivateEditCoordinator, createPrivateTransport } from "../private/private-session.mjs";
import { privateStore } from "../store/private-store.mjs";
import { t } from "../i18n.mjs";

function origin() {
  try {
    return globalThis.location?.origin ?? "";
  } catch {
    return "";
  }
}

export default class PrivateNoteEditor {
  /**
   * @param {Object} callbacks
   * @param {(id: string) => Object|null} callbacks.getNote
   * @param {() => Object|null} callbacks.getPage
   * @param {() => void} callbacks.reloadWorkspace Reload the page after a saved body/appearance.
   * @param {(info: Object) => void} [callbacks.onClosed]
   * @param {(status: Object) => void} [callbacks.onState]
   * @param {(info: Object) => void} [callbacks.onNoteChanged]
   */
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.root = document.createElement("div");
    this.root.className = "journalinator-editor-inner";
    this.noteId = null;
    this.editor = null;
    this.coordinator = null;
    this.transport = null;
  }

  mount(slot) {
    slot?.appendChild?.(this.root);
  }

  get isEditing() {
    return !!this.editor?.isEditing?.();
  }

  /** Page-backed reader used by the transport so another tab's confirmed write is visible. */
  #page() {
    const known = this.callbacks.getPage?.() ?? null;
    if (!known) return null;
    return privateStore.findById(known.id) ?? known;
  }

  #drafts() {
    try {
      return new DraftStore({
        origin: origin(),
        worldId: globalThis.game?.world?.id ?? "",
        userId: globalThis.game?.user?.id ?? "",
        canvasId: "private"
      });
    } catch {
      return null;
    }
  }

  /**
   * Opens one note on its card. Recovery is resolved by the shared editor before the local
   * coordinator acquires the note.
   *
   * @param {string} noteId
   * @param {{host?: HTMLElement, note?: Object, point?: {clientX: number, clientY: number}, focus?: string}} [options]
   */
  async open(noteId, { host = null, note = null, point = null, focus = null } = {}) {
    if (typeof noteId !== "string" || !noteId) return { ok: false, reason: "missing" };
    if (this.editor && this.noteId === noteId && this.editor.isEditing()) {
      if (point) this.editor.focusAtPoint(point.clientX, point.clientY);
      else if (focus) this.focusDestination(focus);
      return { ok: true, type: "alreadyEditing" };
    }
    if (this.editor) await this.close();

    const page = this.#page();
    const resolved = note ?? this.callbacks.getNote?.(noteId) ?? null;
    if (!page || !resolved) return { ok: false, reason: "missing" };

    const userId = globalThis.game?.user?.id ?? "";
    const coordinator = new PrivateEditCoordinator({
      worldId: globalThis.game?.world?.id ?? "",
      userId,
      workspacePageId: page.id,
      noteId
    });
    const transport = createPrivateTransport({
      privateStore,
      pageProvider: () => this.#page(),
      workspacePage: page,
      noteId,
      userId,
      coordinator
    });

    const editor = new NoteEditor({
      transport,
      drafts: this.#drafts(),
      onState: status => this.callbacks.onState?.(status),
      onRequestEdit: id => {
        // A lost private lock is not retried automatically; the shared status offers Close and
        // Copy text, and reopening the note starts a fresh coordinator.
        this.callbacks.onRequestEdit?.(id);
      },
      onNoteChanged: info => {
        try {
          this.callbacks.reloadWorkspace?.();
        } catch (error) {
          console.error("Journalinator: private workspace reload failed", error);
        }
        this.callbacks.onNoteChanged?.(info);
      },
      onClose: info => {
        const closedNoteId = info?.noteId ?? this.noteId;
        this.editor = null;
        this.coordinator = null;
        this.transport = null;
        this.noteId = null;
        this.root.dataset.noteId = "";
        try {
          editor.deactivate();
        } catch (error) {
          console.error("Journalinator: private editor cleanup failed", error);
        }
        this.callbacks.onClosed?.({ ...info, noteId: closedNoteId });
      }
    });

    this.editor = editor;
    this.coordinator = coordinator;
    this.transport = transport;
    this.noteId = noteId;
    this.root.dataset.noteId = noteId;
    editor.activate();

    const result = await editor.open(noteId, { host: host ?? this.root, note: resolved });
    if (!result?.ok || this.editor !== editor) {
      if (result?.type === "noteEditDenied") {
        ui.notifications?.warn(t("JN.Lock.LockedAction"));
      }
      if (this.editor === editor) {
        try { await editor.close({ reason: "switch" }); } catch { /* best effort */ }
        try { editor.deactivate(); } catch { /* best effort */ }
        this.editor = null;
        this.coordinator = null;
        this.transport = null;
        this.noteId = null;
        this.root.dataset.noteId = "";
      }
      return result ?? { ok: false, reason: "openFailed" };
    }
    if (point && Number.isFinite(point.clientX) && Number.isFinite(point.clientY)) {
      editor.focusAtPoint(point.clientX, point.clientY);
    } else if (focus) {
      this.focusDestination(focus);
    }
    return result;
  }

  focusDestination(focus) {
    const textarea = this.editor?.root?.querySelector?.("textarea.jn-source-input");
    if (!textarea) return false;
    const value = textarea.value ?? "";
    let caret = 0;
    if (focus === "after-title-marker") {
      const end = value.indexOf("\n");
      const first = end < 0 ? value : value.slice(0, end);
      const match = /^( {0,3}#{1,6})(?:[ \t]+)?/.exec(first);
      caret = match ? Math.min(match[0].length, value.length) : 0;
    }
    try {
      textarea.focus({ preventScroll: true });
    } catch {
      textarea.focus();
    }
    textarea.setSelectionRange(caret, caret);
    return true;
  }

  /** Re-renders chrome/status after the workspace reloads. */
  render() {
    this.editor?.render?.();
    return this;
  }

  /** Flushes and releases the shared editor session. */
  async close() {
    const editor = this.editor;
    if (!editor) return { ok: true, type: "closed", released: false };
    return editor.close({ reason: "done" });
  }

  detach() {
    this.root.remove();
  }

  async destroy() {
    await this.close().catch(() => {});
    this.detach();
    this.root.replaceChildren();
  }
}
