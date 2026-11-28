/**
 * In-place shared note editor.
 *
 * One continuous Markdown source surface replaces the old paragraph/block editor. This
 * module owns the toolbar, Profile helper, image dialog, appearance popover, recovery UI
 * and autosave status. It composes the approved T6a `NoteEditorSession` and `DraftStore`
 * with a T4a socket adapter, but does not mount the canvas, render cards, size the paper
 * or register board shortcuts. T8 supplies the host; tests inject a fake transport.
 *
 * Constructor options:
 * - `transport`       NoteEditTransport. Omit to lazily build the socket adapter.
 * - `drafts`          DraftStore. Omit for the default per-origin/world/user store; `null` disables.
 * - `onState(status)` Called after every session status change.
 * - `onClose(info)`   Called after a successful close with `{noteId, reason, result}`.
 * - `onRequestEdit(id)` Host hint after a forced/lost lease, so it can request editing again.
 * - `onSend(event)`   Reserved host observer for outgoing editor activity (transport is authoritative).
 * - `onNoteChanged(info)` Called after acknowledged saves and appearance changes.
 * - `t`               Translation function; defaults to `../i18n.mjs`.
 * - `now`             Clock function for session/draft timestamps.
 * - `imageDialog`     Test/host override returning `{src, alt, markdown}` or `null`.
 */

import { notesStore } from "../store/notes-store.mjs";
import { NoteEditorSession } from "../editor/session.mjs";
import { DraftStore } from "../editor/drafts.mjs";
import { SourceSurface } from "../editor/source-surface.mjs";
import {
  createAddTitleGhost,
  createProfileHelper,
  createSecondaryRow,
  createToolbar
} from "../editor/toolbar.mjs";
import {
  classifyDraft,
  copyToClipboard,
  draftTimestamp,
  openRecoveryDialog
} from "../editor/recovery.mjs";
import { createSocketTransport, readStateEntry } from "../editor/socket-transport.mjs";
import { parseDocument, isOffsetInCodeOrComment } from "../document/parse.mjs";
import { buildImageDialog } from "./image-dialog.mjs";
import { resolveSkin } from "../skins/registry.mjs";
import { t as defaultT } from "../i18n.mjs";

export const TAB_SESSION_ID_KEY = "journalinator.editor.sessionId";
const MAX_SESSION_ID_LENGTH = 100;
const MAX_BODY_LENGTH = 200000;

let fallbackSequence = 0;

function randomId(prefix = "") {
  const cryptoApi = globalThis.crypto;
  let body = "";
  if (cryptoApi?.randomUUID) {
    try {
      body = cryptoApi.randomUUID();
    } catch {
      body = "";
    }
  }
  if (!body && cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    body = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  if (!body) {
    fallbackSequence += 1;
    body = `${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
  }
  return `${prefix}${body}`.slice(0, MAX_SESSION_ID_LENGTH);
}

function sessionStorageSafe() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Per-tab id persisted in sessionStorage (never localStorage). The id names this tab's
 * draft and is reused when the lease is re-begun, so a reload can reclaim the same tab's
 * lease; it is not a fresh lease id.
 */
export function getTabSessionId(storage = sessionStorageSafe()) {
  try {
    const existing = storage?.getItem?.(TAB_SESSION_ID_KEY);
    if (typeof existing === "string" && existing && existing.length <= MAX_SESSION_ID_LENGTH) {
      return existing;
    }
    const id = randomId("tab-");
    storage?.setItem?.(TAB_SESSION_ID_KEY, id);
    return id;
  } catch {
    return randomId("tab-");
  }
}

function normalizeNote(noteId, raw) {
  if (!raw) return null;
  const system = raw.system ?? raw;
  if (!system || typeof system !== "object") return null;
  return {
    noteId: raw.noteId ?? raw._id ?? raw.id ?? noteId,
    revision: Number.isInteger(system.revision) ? system.revision : 0,
    body: typeof system.body === "string" ? system.body : "",
    layout: system.layout === "profile" ? "profile" : "plain",
    skin: system.skin ?? raw.skin ?? null,
    deleted: system.deleted === true || raw.deleted === true
  };
}

function isNonEmptyTitle(parsed) {
  return Boolean(parsed?.title?.present && parsed.title.empty !== true
    && typeof parsed.title.text === "string" && parsed.title.text.trim().length > 0);
}

/** Absolute range of the visible first-line title text (excluding `# ` and closing hashes). */
export function titleTextRange(value) {
  const text = String(value ?? "");
  const lineEnd = text.indexOf("\n");
  const raw = lineEnd < 0 ? text : text.slice(0, lineEnd);
  const atx = parseAtxHeadingLite(raw);
  if (!atx) return null;
  const marker = /^( {0,3}#{1,6})(?:[ \t]+)?/.exec(raw);
  const start = marker ? marker[0].length : 0;
  const title = atx.text ?? "";
  if (!title) return { start, end: start };
  return { start, end: Math.min(raw.length, start + title.length) };
}

function parseAtxHeadingLite(raw) {
  const match = /^( {0,3})(#{1,6})(?:[ \t]+(.*))?$/.exec(raw);
  if (!match) return null;
  let content = match[3] ?? "";
  if (/^#+[ \t]*$/.test(content)) content = "";
  else content = content.replace(/[ \t]+#+[ \t]*$/, "");
  return { level: match[2].length, text: content.replace(/[ \t]+$/, "") };
}

/**
 * Builds a standalone block insertion at a caret/selection, adding newlines only where
 * needed. Returns the text and the caret after the block (before a following line break).
 */
export function insertionAt(value, start, end, block) {
  const text = String(value ?? "");
  const from = Math.max(0, Math.min(text.length, start ?? 0));
  const to = Math.max(from, Math.min(text.length, end ?? from));
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before.length === 0 || before.endsWith("\n") ? "" : "\n";
  const trail = after.length === 0 || after.startsWith("\n") ? "" : "\n";
  return {
    text: lead + block + trail,
    caret: from + lead.length + block.length + trail.length
  };
}

const STATUS_KEYS = {
  opening: "JN.Editor.Status.Opening",
  saved: "JN.Editor.Status.Saved",
  saving: "JN.Editor.Status.Saving",
  offline: "JN.Editor.Status.Offline",
  offlineSaved: "JN.Editor.Status.OfflineSaved",
  storageUnavailable: "JN.Editor.Status.StorageUnavailable",
  saveFailed: "JN.Editor.Status.SaveFailed",
  gmEnded: "JN.Editor.Status.GmEnded",
  leaseLost: "JN.Editor.Status.LeaseLost",
  locked: "JN.Editor.Status.Locked",
  conflictChanged: "JN.Editor.Status.ConflictChanged"
};

const TERMINAL_STATES = new Set(["closed", "disposed"]);

export default class NoteEditor {
  /**
   * @param {Object} [options] See the module header for the full option contract.
   */
  constructor(options = {}) {
    this._transportOption = options.transport ?? null;
    this._transport = this._transportOption;
    this._transportPromise = null;
    this._draftOption = options.drafts;
    this._drafts = null;
    this._draftsCreated = false;

    this._onState = typeof options.onState === "function" ? options.onState : null;
    this._onClose = typeof options.onClose === "function" ? options.onClose : null;
    this._onRequestEdit = typeof options.onRequestEdit === "function" ? options.onRequestEdit : null;
    this._onSend = typeof options.onSend === "function" ? options.onSend : null;
    this._onNoteChanged = typeof options.onNoteChanged === "function" ? options.onNoteChanged : null;
    this._t = typeof options.t === "function" ? options.t : defaultT;
    this._now = typeof options.now === "function" ? options.now : () => Date.now();
    this._imageDialogFactory = typeof options.imageDialog === "function" ? options.imageDialog : null;

    this.root = document.createElement("div");
    this.root.className = "jn-note-editor";

    this.noteId = null;
    this._session = null;
    this._sessionId = null;
    this._source = null;
    this._ui = null;
    this._parsed = null;
    this._selectedLayout = "plain";
    this._host = null;
    this._readOnly = false;
    this._storageUnavailable = false;
    this._pendingPasteIds = [];
    this._hint = null;

    this._activated = false;
    this._hookStateId = null;
    this._hookForcedId = null;
    this._onPageHide = null;
  }

  get element() {
    return this.root;
  }

  // --- Lifecycle -------------------------------------------------------------------------

  /** Registers lease-state and pagehide listeners for the lifetime of the app. */
  activate() {
    if (this._activated) return;
    this._activated = true;
    const hooks = globalThis.Hooks;
    if (hooks?.on) {
      this._hookStateId = hooks.on("journalinatorEditStateChanged", (noteId, state) => {
        this._handleEditStateChanged(noteId, state);
      });
      this._hookForcedId = hooks.on("journalinatorNoteForceUnlocked", payload => {
        this._handleForceUnlocked(payload);
      });
    }
    if (typeof globalThis.addEventListener === "function") {
      this._onPageHide = () => {
        try {
          this._session?.dispose();
        } catch {
          // Pagehide is best-effort; the draft was written by dispose/flushDraft.
        }
      };
      globalThis.addEventListener("pagehide", this._onPageHide);
    }
  }

  /** Saves and releases an open edit without unregistering app hooks. */
  async suspend() {
    if (!this._session) return { ok: true, type: "closed", released: false };
    return this.close({ reason: "suspend" });
  }

  /** Saves/releases, then unregisters hooks and detaches the editor element. */
  async deactivate() {
    this._activated = false;
    this._removeHooks();
    const result = this._session
      ? await this.close({ reason: "deactivate" })
      : { ok: true, type: "closed", released: false };
    this.detach();
    return result;
  }

  _removeHooks() {
    const hooks = globalThis.Hooks;
    if (hooks?.off) {
      if (this._hookStateId !== null) hooks.off("journalinatorEditStateChanged", this._hookStateId);
      if (this._hookForcedId !== null) hooks.off("journalinatorNoteForceUnlocked", this._hookForcedId);
    }
    this._hookStateId = null;
    this._hookForcedId = null;
    if (this._onPageHide && typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("pagehide", this._onPageHide);
    }
    this._onPageHide = null;
  }

  /**
   * Opens a note for in-place editing. Recovery is resolved first; the lease is only
   * acquired after the author has chosen what to do with a differing local draft.
   *
   * @param {string} noteId
   * @param {{host?: HTMLElement, note?: Object}} [options]
   */
  async open(noteId, { host, note } = {}) {
    if (typeof noteId !== "string" || !noteId) {
      return { ok: false, type: "error", reason: "missing" };
    }
    if (host) this._host = host;

    if (this._session) {
      const previous = await this.close({ reason: "switch" });
      if (this._session && !TERMINAL_STATES.has(this._session.state)) {
        return { ok: false, type: "error", reason: previous?.reason ?? "closeFailed" };
      }
    }

    this.noteId = noteId;
    let resolved = note;
    if (resolved === undefined) {
      try {
        resolved = notesStore.getNote(noteId);
      } catch {
        resolved = null;
      }
    }
    let confirmed = normalizeNote(noteId, resolved);
    let exists = Boolean(confirmed && !confirmed.deleted);
    if (!confirmed) {
      confirmed = {
        noteId,
        revision: 0,
        body: "",
        layout: "plain",
        skin: null,
        deleted: true
      };
    }

    const drafts = this._ensureDrafts();
    const sessionId = getTabSessionId();
    this._sessionId = sessionId;

    let transport;
    try {
      transport = await this._ensureTransport();
    } catch (error) {
      this._reportError(error);
      this.noteId = null;
      return { ok: false, type: "error", reason: "transport" };
    }

    let recoveryBody = null;
    if (drafts && this._draftAvailable()) {
      let draft = null;
      try {
        draft = drafts.load(noteId, sessionId);
      } catch (error) {
        this._reportError(error);
        draft = null;
      }
      if (draft) {
        const outcome = await this._recoverDraft({
          draft,
          note: confirmed,
          exists,
          drafts,
          sessionId,
          transport
        });
        if (!outcome.proceed) {
          this.noteId = null;
          return { ok: false, type: "recovery", reason: outcome.reason ?? "deferred" };
        }
        if (outcome.note) confirmed = outcome.note;
        if (outcome.exists !== undefined) exists = outcome.exists;
        if (typeof outcome.body === "string") recoveryBody = outcome.body;
      }
    }

    if (!exists) {
      this.noteId = null;
      return { ok: false, type: "error", reason: "missing" };
    }

    this._selectedLayout = confirmed.layout;
    this._storageUnavailable = !this._draftAvailable();

    let session;
    session = new NoteEditorSession({
      noteId,
      note: {
        body: confirmed.body,
        revision: confirmed.revision,
        layout: confirmed.layout,
        skin: confirmed.skin
      },
      transport,
      drafts,
      clientSessionId: sessionId,
      now: this._now,
      onState: status => {
        if (this._session === session) this._handleSessionState(status);
      },
      onLeaseLost: () => {
        if (this._session === session) this._onRequestEdit?.(this.noteId);
      },
      onSaved: reply => {
        if (this._session === session) this._handleSaved(reply);
      }
    });
    this._session = session;

    if (recoveryBody !== null) session.setBody(recoveryBody, { composing: false });

    this._buildDOM();
    if (this._host) this.attach(this._host);
    this._source.setValue(session.body, { preserveSelection: false });
    this._updateDocumentState();
    this._renderStatus(session.status());

    const result = await session.open();
    if (this._session !== session) {
      // The user closed (or switched notes) while the lease request was in flight. If a
      // grant arrived late, release it instead of leaking a lease to a discarded editor.
      if (session.lease) {
        try {
          await session.close({ release: true });
        } catch {
          // A best-effort late release is enough; the lease also expires on its own.
        }
      }
      return result;
    }
    this._renderStatus(session.status());
    return result;
  }

  /** Re-parses local source and applies any clean remote body/appearance updates. */
  refresh() {
    if (!this._session) return this;
    const noteId = this.noteId ?? this._session.noteId;
    let raw = null;
    try {
      raw = notesStore.getNote(noteId);
    } catch {
      raw = null;
    }
    if (raw) {
      const note = normalizeNote(noteId, raw);
      if (note) {
        this._session.applyRemote({
          body: note.body,
          revision: note.revision,
          layout: note.layout,
          skin: note.skin
        });
      }
    }
    if (this._session.layout) this._selectedLayout = this._session.layout;
    if (this._source && !this._source.isComposing()
        && this._source.getValue() !== this._session.body) {
      this._source.setValue(this._session.body, { preserveSelection: true });
    }
    this._updateDocumentState();
    this._renderStatus(this._session.status());
    return this;
  }

  /** Re-renders chrome only; the textarea is never rebuilt while the session is alive. */
  render() {
    if (!this._session) return this;
    this._ensureDOM();
    this._updateDocumentState();
    this._renderStatus(this._session.status());
    return this;
  }

  /**
   * Flushes and releases. The editor only leaves editing mode after `noteEditEnded`
   * (or an already-closed session). Forced/lost leases close locally without pretending
   * to have released a lease the editor no longer owns.
   */
  async close({ reason = "done" } = {}) {
    this._ui?.toolbar.closeTransient({ restoreFocus: false });
    const session = this._session;
    if (!session) {
      return { ok: true, type: "closed", released: false };
    }

    const localOnly = reason === "forced" || reason === "leaseLost";
    const result = await session.close({ release: !localOnly });
    const ended = result?.type === "noteEditEnded"
      || result?.type === "closed"
      || (result?.ok === true && result?.released === false && TERMINAL_STATES.has(session.state));
    if (ended) {
      this._finishClose({ reason, result });
    } else {
      this._renderStatus(session.status());
    }
    return result;
  }

  isEditing() {
    return Boolean(this._session && !TERMINAL_STATES.has(this._session.state));
  }

  /**
   * Places the caret at the source offset nearest a viewport point. T8's read-mode double click
   * uses this after mounting the editor; it is a thin delegation to the source surface so no
   * other editor behaviour changes.
   */
  focusAtPoint(clientX, clientY) {
    if (!this._source || typeof this._source.caretOffsetFromPoint !== "function") return false;
    const offset = this._source.caretOffsetFromPoint(clientX, clientY);
    this._source.focusRange(offset, offset);
    return true;
  }

  /** Absolute source offset nearest a viewport point, or null when no surface is mounted. */
  caretOffsetFromPoint(clientX, clientY) {
    if (!this._source || typeof this._source.caretOffsetFromPoint !== "function") return null;
    return this._source.caretOffsetFromPoint(clientX, clientY);
  }

  attach(host) {
    if (!host) return this;
    this._host = host;
    host.appendChild(this.root);
    return this;
  }

  detach() {
    this._host = null;
    this.root.remove();
    return this;
  }

  // --- DOM construction ------------------------------------------------------------------

  _ensureDOM() {
    if (this._ui && this._session) return;
    this._buildDOM();
  }

  _buildDOM() {
    const t = this._t;
    this._pasteFlushPending = false;
    this._hint = null;

    const toolbar = createToolbar({
      t,
      onAction: action => this._runAction(action),
      onLayout: layout => {
        void this._selectLayout(layout);
      },
      onSkinChange: patch => {
        void this._applySkinPatch(patch);
      },
      onBackgroundChoose: () => {
        void this._chooseBackground();
      },
      onBackgroundRemove: () => {
        void this._applySkinPatch({ backgroundImage: null });
      }
    });

    const secondary = createSecondaryRow({ t });
    const profile = createProfileHelper({
      t,
      onAction: action => this._runAction(action)
    });

    const hint = document.createElement("div");
    hint.className = "jn-editor-hint";
    hint.setAttribute("role", "note");
    hint.hidden = true;

    const surfaceHost = document.createElement("div");
    surfaceHost.className = "jn-editor-surface-host";
    surfaceHost.style.position = "relative";

    const ghost = createAddTitleGhost({
      t,
      onClick: () => this._applyTitle()
    });

    const source = new SourceSurface({
      onInput: event => this._handleInput(event),
      onCompositionStart: () => {
        this._session?.setBody(this._source.getValue(), { composing: true });
      },
      onCompositionEnd: value => {
        this._session?.setBody(value, { composing: false });
        this._updateDocumentState();
      },
      onPaste: event => {
        if (!event?.id) return;
        this._session?.addEventIds([event.id]);
        this._pasteFlushPending = true;
      }
    });
    source.mount(surfaceHost);
    surfaceHost.appendChild(ghost);
    source.textarea.addEventListener("keydown", event => this._handleKeydown(event));

    this.root.replaceChildren(
      toolbar.element,
      secondary.element,
      profile.element,
      hint,
      surfaceHost
    );
    this.root.dataset.noteId = this.noteId ?? "";
    this.root.classList.add("jn-note-editor-root");

    this._source = source;
    this._ui = { toolbar, secondary, profile, hint, ghost, surfaceHost };
    toolbar.setLayout(this._selectedLayout);
    toolbar.setSkin(resolveSkin(this._session?.skin ?? null));
  }

  // --- Input and document state ----------------------------------------------------------

  _handleInput(event) {
    if (!this._session) return;
    this._session.setBody(event.value, { composing: event.composing });
    this._updateDocumentState();
    this._clearHint();
    if (!event.composing) this._flushPasteEvents();
  }

  _flushPasteEvents() {
    if (!this._session || !this._pasteFlushPending) return;
    this._pasteFlushPending = false;
    const result = this._session.flush({ reason: "paste" });
    // The session owns event-id accounting; its ack removes only the ids that were
    // actually included in that save. Never clear ids from this UI-side promise.
    Promise.resolve(result).then(() => this._renderStatus()).catch(() => {});
  }

  _updateDocumentState() {
    if (!this._source || !this._ui) return;
    const selectedLayout = this._selectedLayout ?? this._session?.layout ?? "plain";
    const body = this._source.getValue();
    this._parsed = parseDocument(body, { selectedLayout });
    this._source.updateParsed(this._parsed);
    this._ui.profile.update(selectedLayout === "profile" ? this._parsed.profileIssue : null);
    this._ui.toolbar.setLayout(selectedLayout);
    const untitled = !this._parsed.title || this._parsed.title.empty === true;
    this._ui.ghost.hidden = this._readOnly || !untitled;
    this._ui.ghost.setAttribute("aria-hidden", String(this._ui.ghost.hidden));
  }

  _setHint(text) {
    if (!this._ui) return;
    this._ui.hint.textContent = text ?? "";
    this._ui.hint.hidden = !text;
    this._hint = text ?? null;
  }

  _clearHint() {
    this._setHint("");
  }

  // --- Toolbar actions -------------------------------------------------------------------

  _runAction(action) {
    if (action === "layout" || action === "appearance") return;
    if (this._readOnly && action !== "done") return;
    this._clearHint();
    if (action === "title" || action === "add-title") {
      this._applyTitle();
    } else if (action === "divider") {
      this._applyDivider();
    } else if (action === "portrait") {
      void this._applyPortrait();
    } else if (action === "done") {
      void this.close({ reason: "done" });
    }
  }

  _currentParse() {
    return parseDocument(this._source?.getValue() ?? "", {
      selectedLayout: this._selectedLayout ?? this._session?.layout ?? "plain"
    });
  }

  _applyTitle() {
    if (!this._source) return;
    const value = this._source.getValue();
    const parsed = this._currentParse();
    const range = titleTextRange(value);
    if (parsed.title) {
      if (range) {
        if (parsed.title.empty) this._source.focusRange(range.start, range.start);
        else this._source.focusRange(range.start, range.end);
      } else {
        this._source.focus();
      }
      this._updateDocumentState();
      return;
    }

    // One native edit keeps the whole insertion in a single undo step. The old body stays
    // byte-for-byte as it was, just shifted below the new empty title marker.
    const insertion = value.length ? "# \n" : "# ";
    this._source.focus();
    this._source.setSelection(0, 0);
    this._source.insertText(insertion);
    if (this._source.getValue() === value) {
      this._source.replaceRange(0, 0, insertion);
    }
    this._source.focusRange(2, 2);
    this._updateDocumentState();
  }

  _applyDivider() {
    if (!this._source) return;
    const parsed = this._currentParse();
    const selection = this._source.getSelection();
    if (isOffsetInCodeOrComment(parsed, selection.start)) {
      this._setHint(this._t("JN.Editor.DividerInCode"));
      return;
    }
    const block = insertionAt(this._source.getValue(), selection.start, selection.end, "---");
    this._source.replaceRange(selection.start, selection.end, block.text);
    this._source.focusRange(block.caret, block.caret);
    this._clearHint();
    this._updateDocumentState();
  }

  async _applyPortrait() {
    if (!this._source || !this._session) return;
    const parsed = this._currentParse();
    const selection = this._source.getSelection();
    const existing = parsed.profile?.portrait ?? null;
    const profileInsert = this._selectedLayout === "profile"
      && isNonEmptyTitle(parsed)
      && !existing;

    if (!existing && !profileInsert && isOffsetInCodeOrComment(parsed, selection.start)) {
      this._setHint(this._t("JN.Editor.CodeInsertBlocked"));
      return;
    }

    const result = await this._openPortraitDialog({
      mode: existing ? "replace" : "insert",
      initialSrc: existing?.src ?? "",
      initialAlt: existing?.alt ?? ""
    });
    if (!result) {
      this._source.focusRange(selection.start, selection.end);
      return;
    }

    if (existing) {
      this._source.replaceRange(existing.start, existing.end, result.markdown);
      this._focusFollowing(existing.start + result.markdown.length);
    } else if (profileInsert) {
      // Preserve comments/blank lines between the title and the rest; insert immediately
      // after the title or its optional underline.
      const anchor = parsed.underline ? parsed.underline.end : parsed.title.end;
      const block = insertionAt(this._source.getValue(), anchor, anchor, result.markdown);
      this._source.replaceRange(anchor, anchor, block.text);
      this._focusFollowing(anchor + block.text.length);
    } else {
      const block = insertionAt(
        this._source.getValue(),
        selection.start,
        selection.end,
        result.markdown
      );
      this._source.replaceRange(selection.start, selection.end, block.text);
      this._focusFollowing(selection.start + block.text.length);
    }
    this._clearHint();
    this._updateDocumentState();
  }

  _focusFollowing(offset) {
    if (!this._source) return;
    const value = this._source.getValue();
    let caret = Math.max(0, Math.min(value.length, offset));
    if (value[caret] === "\n") caret += 1;
    this._source.focusRange(caret, caret);
  }

  async _selectLayout(layout) {
    if (!this._session) return;
    const result = await this._session.setLayout(layout);
    if (result?.ok) {
      this._selectedLayout = result.layout ?? layout;
      this._ui?.toolbar.setLayout(this._selectedLayout);
      this._updateDocumentState();
      this._renderStatus();
      this._onNoteChanged?.({
        noteId: this.noteId,
        layout: this._selectedLayout,
        skin: this._session.skin
      });
    } else {
      this._ui?.toolbar.setLayout(this._selectedLayout);
    }
  }

  async _applySkinPatch(patch) {
    if (!this._session) return;
    const current = resolveSkin(this._session.skin ?? this._ui?.toolbar.getSkin());
    const next = resolveSkin({ ...current, ...patch });
    const result = await this._session.setSkin(next);
    if (result?.ok) {
      const applied = resolveSkin(result.skin ?? next);
      this._ui?.toolbar.setSkin(applied);
      this._renderStatus();
      this._onNoteChanged?.({
        noteId: this.noteId,
        layout: this._session.layout,
        skin: applied
      });
    } else {
      this._ui?.toolbar.setSkin(resolveSkin(this._session.skin ?? current));
    }
  }

  async _chooseBackground() {
    if (!this._session || !this._source) return;
    const current = resolveSkin(this._session.skin);
    const selection = this._source.getSelection();
    const result = await this._openImageDialog({
      title: this._t("JN.Skin.BackgroundImage"),
      mode: "insert",
      initialSrc: current.backgroundImage ?? ""
    });
    if (!result) {
      this._source.focusRange(selection.start, selection.end);
      return;
    }
    if (result.src) await this._applySkinPatch({ backgroundImage: result.src });
  }

  _openPortraitDialog({ mode, initialSrc, initialAlt }) {
    return this._openImageDialog({ mode, initialSrc, initialAlt });
  }

  async _openImageDialog(options) {
    if (this._imageDialogFactory) {
      return this._imageDialogFactory({
        ...options,
        t: this._t
      });
    }
    const dialog = buildImageDialog({ ...options, t: this._t });
    const host = globalThis.document?.body ?? this.root;
    host.appendChild(dialog.element);
    dialog.urlInput.focus();
    dialog.urlInput.select?.();
    this._imageDialog = dialog;
    try {
      return await dialog.promise;
    } finally {
      if (this._imageDialog === dialog) this._imageDialog = null;
    }
  }

  // --- Keyboard and composition ----------------------------------------------------------

  _handleKeydown(event) {
    // Board shortcuts never see textarea keystrokes, regardless of which key it is.
    event.stopPropagation();
    if (event.isComposing || this._source?.isComposing()) return;

    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "s") {
      event.preventDefault();
      const result = this._session?.flush({ reason: "shortcut" });
      Promise.resolve(result).then(() => this._renderStatus()).catch(() => {});
      return;
    }

    if (event.key !== "Escape") return;
    if (this._imageDialog) {
      event.preventDefault();
      this._imageDialog.close();
      return;
    }
    if (this._ui?.toolbar.isTransientOpen()) {
      event.preventDefault();
      this._ui.toolbar.closeTransient();
      return;
    }
    event.preventDefault();
    void this.close({ reason: "escape" });
  }

  // --- Session status --------------------------------------------------------------------

  _handleSessionState(status) {
    this._renderStatus(status);
    this._onState?.(status);
  }

  _handleSaved(reply) {
    this._onNoteChanged?.({
      noteId: this.noteId,
      body: this._session?.confirmedBody,
      revision: this._session?.confirmedRevision,
      reply
    });
  }

  _draftAvailable() {
    if (!this._drafts) return false;
    try {
      return typeof this._drafts.isAvailable === "function" ? this._drafts.isAvailable() : true;
    } catch {
      return false;
    }
  }

  _statusActions(state) {
    const t = this._t;
    const copy = {
      id: "copy",
      label: t("JN.Editor.CopyText"),
      onClick: () => {
        void copyToClipboard(this._source?.getValue() ?? this._session?.body ?? "");
      }
    };
    const close = {
      id: "close",
      label: t("JN.Common.Close"),
      onClick: () => {
        const reason = state === "forced" || state === "leaseLost" ? state : "close";
        void this.close({ reason });
      }
    };
    const retry = {
      id: "retry",
      label: t("JN.Common.Retry"),
      onClick: () => {
        if (state === "conflict") {
          void this._retryConflict();
          return;
        }
        const result = this._session?.flush({ reason: "retry" });
        Promise.resolve(result).then(() => this._renderStatus()).catch(() => {});
      }
    };
    return { copy, close, retry };
  }

  /**
   * Explicit conflict recovery. An equal-body state is adopted as clean; differing or
   * unavailable text keeps the local draft and only shows a hint — it is never
   * overwritten silently.
   */
  async _retryConflict() {
    const result = await this._session?.retryConflict();
    if (result?.ok) {
      this._clearHint();
      this._renderStatus();
      return;
    }
    if (result?.reason === "conflictChanged") {
      this._setHint(this._t(STATUS_KEYS.conflictChanged));
    } else if (result?.reason === "offline") {
      this._setHint(this._t(STATUS_KEYS.offline));
    }
    this._renderStatus();
  }

  _renderStatus(status = this._session?.status()) {
    if (!this._ui) return;
    const t = this._t;
    const state = status?.state ?? "idle";
    const storageUnavailable = !this._draftAvailable();
    this._storageUnavailable = storageUnavailable;
    const actions = this._statusActions(state);

    let label = "";
    let actionsToShow = [];
    let visualState = state;

    if (state === "acquiring") {
      label = t(STATUS_KEYS.opening);
    } else if (TERMINAL_STATES.has(state) || state === "idle") {
      label = "";
    } else if (storageUnavailable) {
      label = t(STATUS_KEYS.storageUnavailable);
      visualState = "storageUnavailable";
      actionsToShow = [actions.copy];
    } else if (state === "forced") {
      label = t(STATUS_KEYS.gmEnded);
      actionsToShow = [actions.close, actions.copy];
    } else if (state === "leaseLost") {
      label = t(STATUS_KEYS.leaseLost);
      actionsToShow = [actions.close, actions.copy];
    } else if (state === "denied") {
      label = t(STATUS_KEYS.locked);
      actionsToShow = [actions.close, actions.copy];
    } else if (state === "offline") {
      if (status?.savedLocally) {
        label = t(STATUS_KEYS.offlineSaved);
      } else {
        label = t(STATUS_KEYS.offline);
      }
      actionsToShow = [actions.close, actions.copy];
    } else if (state === "rejected" || state === "conflict") {
      if (status?.savedLocally) {
        label = t(STATUS_KEYS.saveFailed);
        actionsToShow = [actions.retry, actions.copy];
      } else {
        label = t(STATUS_KEYS.storageUnavailable);
        visualState = "storageUnavailable";
        actionsToShow = [actions.copy];
      }
    } else if (state === "saving" || status?.dirty) {
      label = t(STATUS_KEYS.saving);
    } else if (state === "editing") {
      label = t(STATUS_KEYS.saved);
    } else {
      label = t(STATUS_KEYS.saveFailed);
      actionsToShow = status?.savedLocally ? [actions.retry, actions.copy] : [actions.copy];
    }

    this._ui.secondary.setStatus({
      text: label,
      state: visualState,
      actions: actionsToShow
    });
    // Storage failure keeps the exact required copy while exposing the real server state
    // separately for the card chrome/CSS.
    this._ui.secondary.statusElement.dataset.serverState = state;

    const readOnly = ["acquiring", "denied", "forced", "leaseLost", "closed", "disposed"].includes(state);
    this._readOnly = readOnly;
    if (this._source) this._source.textarea.readOnly = readOnly;
    this._ui.toolbar.setDisabled(readOnly);
    if (this._ui) {
      const untitled = !this._parsed?.title || this._parsed.title.empty === true;
      this._ui.ghost.hidden = readOnly || !untitled;
    }
    this.root.dataset.state = visualState;
  }

  // --- Lease changes ---------------------------------------------------------------------

  _handleEditStateChanged(noteId, state) {
    if (!this._session || noteId !== (this.noteId ?? this._session.noteId)) return;
    const lease = state?.lease ?? null;
    const mine = this._session.lease;
    if (!mine || (lease && lease.leaseToken === mine.leaseToken)) return;
    // The socket broadcasts a revocation before the force-unlock hook. Deferring one
    // microtask lets a same-tick force notification set the precise `forced` state;
    // `applyLeaseLost` is terminal, so a later leaseLost call cannot overwrite it.
    const session = this._session;
    const apply = () => {
      if (this._session !== session) return;
      session.applyLeaseLost("leaseLost");
      this._renderStatus(session.status());
    };
    if (typeof queueMicrotask === "function") queueMicrotask(apply);
    else Promise.resolve().then(apply);
  }

  _handleForceUnlocked(payload) {
    if (!this._session || payload?.noteId !== (this.noteId ?? this._session.noteId)) return;
    this._session.applyLeaseLost("forced");
    this._renderStatus(this._session.status());
  }

  // --- Recovery --------------------------------------------------------------------------

  async _recoverDraft({ draft, note, exists, drafts, sessionId, transport }) {
    let state = classifyDraft({ draft, note, exists });
    if (state.kind === "none") return { proceed: true, note };
    if (state.kind === "identical") {
      drafts.remove(this.noteId, sessionId);
      return { proceed: true, note };
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const dialog = openRecoveryDialog({
        state,
        t: this._t,
        host: globalThis.document?.body ?? this.root,
        formatTime: at => draftTimestamp(at, { now: this._now() })
      });
      this._recoveryDialog = dialog;
      const { action } = await dialog.promise;
      this._recoveryDialog = null;

      if (action === "defer") {
        return { proceed: false, reason: "recoveryDeferred" };
      }
      if (action === "discard") {
        drafts.remove(this.noteId, sessionId);
        return { proceed: true, note: state.note ?? note, exists: state.kind !== "missing" };
      }
      if (action !== "recover") continue;

      let latest = null;
      try {
        latest = await this._readLatest(transport);
      } catch {
        latest = null;
      }
      if (!latest) {
        // Offline/unverifiable: the author explicitly chose their local draft. The session
        // will keep it dirty and report the actual save state.
        return { proceed: true, body: draft.body, note, exists };
      }

      const recheck = classifyDraft({
        draft,
        note: latest.note,
        exists: latest.exists
      });
      if (recheck.kind === "missing") {
        state = recheck;
        continue;
      }
      if (recheck.kind === "identical") {
        drafts.remove(this.noteId, sessionId);
        return { proceed: true, note: latest.note, exists: true };
      }

      const shownBody = state.note?.body ?? "";
      const shownRevision = state.note?.revision ?? 0;
      const latestBody = recheck.note?.body ?? "";
      const latestRevision = recheck.note?.revision ?? 0;
      if (latestBody !== shownBody || (latestRevision !== shownRevision && latestBody !== draft.body)) {
        // Another client changed the note after the comparison was drawn. Refresh rather
        // than silently replacing text the author has not seen.
        state = recheck;
        continue;
      }

      return {
        proceed: true,
        body: draft.body,
        note: latest.note ?? note,
        exists: true
      };
    }

    return { proceed: false, reason: "recoveryLoop" };
  }

  async _readLatest(transport) {
    const reply = await transport.state({ noteId: this.noteId });
    const entry = readStateEntry(reply, this.noteId);
    if (!entry) return null;
    if (entry.deleted === true) {
      return {
        exists: false,
        note: {
          noteId: this.noteId,
          revision: Number.isInteger(entry.revision) ? entry.revision : 0,
          body: "",
          deleted: true
        }
      };
    }
    if (typeof entry.body !== "string") return null;
    return {
      exists: true,
      note: {
        noteId: this.noteId,
        revision: Number.isInteger(entry.revision) ? entry.revision : 0,
        body: entry.body,
        layout: entry.layout,
        skin: entry.skin,
        deleted: false
      }
    };
  }

  // --- Drafts and transport ---------------------------------------------------------------

  _ensureDrafts() {
    if (this._draftsCreated) return this._drafts;
    this._draftsCreated = true;
    if (this._draftOption === null) {
      this._drafts = null;
      return null;
    }
    if (this._draftOption) {
      this._drafts = this._draftOption;
      return this._drafts;
    }
    try {
      this._drafts = new DraftStore({
        origin: globalThis.location?.origin ?? "",
        worldId: globalThis.game?.world?.id ?? "",
        userId: globalThis.game?.user?.id ?? "",
        canvasId: "shared",
        now: this._now
      });
    } catch (error) {
      this._reportError(error);
      this._drafts = null;
    }
    return this._drafts;
  }

  async _ensureTransport() {
    if (this._transport) return this._transport;
    if (!this._transportPromise) {
      this._transportPromise = (async () => {
        try {
          const [socket, editSession] = await Promise.all([
            import("../socket.mjs"),
            import("../edit-session.mjs")
          ]);
          // The lease must use a fresh per-page client session id; the persistent tab id
          // above is only draft identity, so a reload can still find its own draft.
          this._transport = createSocketTransport({
            notesStore,
            clientSessionId: editSession.clientSessionId ?? randomId("page-"),
            requestEditReply: socket.requestEditReply,
            requestWrite: socket.requestWrite,
            now: this._now
          });
        } catch (error) {
          this._transportPromise = null;
          throw error;
        }
        return this._transport;
      })();
    }
    return this._transportPromise;
  }

  _finishClose({ reason, result }) {
    const noteId = this.noteId;
    this._source?.destroy();
    this._source = null;
    this._ui = null;
    this._parsed = null;
    this._session = null;
    this._readOnly = true;
    this.noteId = null;
    this.root.replaceChildren();
    this.root.dataset.noteId = "";
    this.root.dataset.state = "closed";
    this._onClose?.({ noteId, reason, result });
  }

  _reportError(error) {
    // UI callbacks are untrusted; never throw from them or recurse.
    try {
      console.error?.("Journalinator editor:", error);
    } catch {
      // Ignore console failures in constrained environments.
    }
  }
}

export { MAX_BODY_LENGTH };
