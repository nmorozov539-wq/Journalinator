import { notesStore } from "../store/notes-store.mjs";
import { requestEditReply, requestWrite } from "../socket.mjs";
import JournalCanvas from "./canvas.mjs";
import NoteEditor from "./editor.mjs";
import PrivateWorkspace from "./private-workspace.mjs";
import { openPrivateAdmin } from "./private-admin.mjs";
import { privateStore } from "../store/private-store.mjs";
import { countSharedTransferDrops, countTransferDrops } from "../private-transfer.mjs";
import { createNoteFromMenu, openCreationMenu } from "./note-dialog.mjs";
import {
  noteMatchesFilters, noteMatchesQuery, noteSearchLabel, noteSecondaryExcerpt
} from "./note-search.mjs";
import { createNoteFromQuery } from "../templates.mjs";
import { openHistoryDialog } from "./history-dialog.mjs";
import {
  incompatibleNoticeHTML,
  isIncompatibleStatus,
  noGmBannerHTML,
  privateIncompatibleNoticeHTML
} from "./notices.mjs";
import { defaultControlTarget } from "./scene-control.mjs";
import { BOARD_BACKGROUND_IDS, applyTheme, getTheme, listThemes } from "../styles/themes.mjs";
import { SCENE_THEME_ID, clearSceneThemeCache, sceneTheme } from "../scene-palette.mjs";
import { t } from "../i18n.mjs";
import { clientSessionId } from "../edit-session.mjs";
import { resolveSkin } from "../skins/registry.mjs";
import { promptImageSource } from "./image-dialog.mjs";
import { toggleTaskListItem } from "../markdown.mjs";

/** The saved theme choice, resolved to a registered theme. `scene` is generated on demand. */
async function resolveThemeChoice(id) {
  if (id === SCENE_THEME_ID) return (await sceneTheme()) ?? getTheme("stylized");
  return getTheme(id);
}

/** Keyboard shortcuts must never replace the browser/editor's native typing behaviour. */
export function isTextEntryTarget(target) {
  return !!target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

/**
 * Debounces `journalinatorThemeChanged`. The id catches ordinary theme switches; the object
 * reference catches a regenerated scene palette that keeps the synthetic "scene" id. Repeated
 * renders return the same cached scene theme object, so they stay silent.
 */
export function themeApplicationChanged(previous, next) {
  if (!next) return false;
  return !previous || previous.id !== next.id || previous.theme !== next;
}

/** Foundry's tooltip manager is instant and themed; fall back to the native title if it is missing. */
function tooltipAttrs(label) {
  const text = foundry.utils.escapeHTML(label.replace(/^\+\s*/, ""));
  return `${game.tooltip ? `data-tooltip="${text}" data-tooltip-direction="DOWN"` : `title="${text}"`} aria-label="${text}"`;
}

function toolbarButton(className, icon, label, disabled = false, badge = null, pressed = false) {
  const count = Number.isFinite(badge) && badge > 0
    ? `<span class="jn-toolbar-badge" aria-hidden="true">${badge}</span>` : "";
  return `<button type="button" class="jn-toolbar-icon ${className}${pressed ? " on" : ""}"${disabled ? " disabled" : ""}
    ${pressed ? 'aria-pressed="true"' : 'aria-pressed="false"'} ${tooltipAttrs(label)}>
    <i class="fa-solid ${icon}" aria-hidden="true"></i>${count}</button>`;
}

/** Stored-layout filters only: All is represented by `null`. */
const NOTE_LAYOUT_FILTERS = Object.freeze([
  ["plain", "JN.Layout.Plain"],
  ["profile", "JN.Layout.Profile"]
]);

/**
 * Quick-switcher creation model. Empty text starts as Blank; anything else becomes a first-line
 * `# <query>` on Plain/Cream. Duplicate titles are intentionally allowed.
 */
export function quickCreateModel(query, { x = 0, y = 0, clientSessionId: session = "" } = {}) {
  const created = createNoteFromQuery(query);
  const message = {
    type: "createNote",
    body: created.body,
    layout: created.layout,
    skin: created.skin,
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    requestEdit: true,
    ...(typeof session === "string" && session ? { clientSessionId: session } : {})
  };
  return { message, focus: created.focus, note: created };
}

/** Sends one quick-switcher creation and calls `onCreated` only for a real `noteCreated` reply. */
export async function createSharedNoteFromQuery({
  query,
  x,
  y,
  clientSessionId,
  requestEditReply,
  onCreated
} = {}) {
  const model = quickCreateModel(query, { x, y, clientSessionId });
  if (typeof requestEditReply !== "function") return { ok: false, reason: "transport" };
  let reply;
  try {
    reply = await requestEditReply(model.message);
  } catch (error) {
    return { ok: false, reason: "transport", error };
  }
  if (!reply || reply.type !== "noteCreated" || typeof reply.noteId !== "string") {
    return { ok: false, reason: reply?.reason ?? reply?.type ?? "rejected", reply };
  }
  const result = {
    ok: true,
    reply,
    focus: model.focus,
    note: {
      noteId: reply.noteId,
      revision: Number.isInteger(reply.revision) ? reply.revision : 0,
      body: typeof reply.body === "string" ? reply.body : model.note.body,
      layout: reply.layout === "profile" ? "profile" : "plain",
      skin: reply.skin ?? model.note.skin
    }
  };
  await onCreated?.(result);
  return result;
}

/** Internal clipboard entry: current v2 content only, never title/blocks/identity. */
export function clipboardEntryForNote(note) {
  const system = note?.system ?? {};
  return {
    body: typeof system.body === "string" ? system.body : "",
    layout: system.layout === "profile" ? "profile" : "plain",
    skin: resolveSkin(note)
  };
}

/** `pasteNote` protocol message; the active GM allocates fresh ids. */
export function clipboardPasteMessage(entry, { x = 0, y = 0 } = {}) {
  return {
    type: "pasteNote",
    body: typeof entry?.body === "string" ? entry.body : "",
    layout: entry?.layout === "profile" ? "profile" : "plain",
    skin: entry?.skin ?? resolveSkin({}),
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0
  };
}

/** Derived trash row model: label/excerpt plus deletion author and date, never the page name. */
export function trashRowModel(note, { t = (key, data) => (data ? key : key), users = game.users } = {}) {
  const deleted = note?.system?.deleted;
  const by = deleted?.by ? users?.get?.(deleted.by)?.name ?? t("JN.Common.Unknown") : "";
  const date = Number.isFinite(deleted?.at)
    ? new Date(deleted.at).toLocaleString(game.i18n?.lang || undefined)
    : "";
  let text = t("JN.Trash.MetadataUnknown");
  if (by && date) {
    text = deleted.by === game.user?.id
      ? t("JN.Trash.DeletedByYouAt", { date })
      : t("JN.Trash.DeletedMeta", { name: by, date });
  } else if (by) {
    text = t("JN.Trash.DeletedBy", { name: by });
  } else if (date) {
    text = t("JN.Trash.DeletedDate", { date });
  }
  return {
    label: noteSearchLabel(note),
    excerpt: noteSecondaryExcerpt(note),
    deletedBy: by,
    deletedAt: Number.isFinite(deleted?.at) ? deleted.at : 0,
    metadata: text
  };
}

/** Resolves a copy selection, refusing the whole action when any note is remote-locked. */
export function collectCopyableNotes(notes, ids, isLocked = () => false) {
  const requested = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === "string" && id))];
  if (requested.some(id => isLocked(id))) return { blocked: true, notes: [] };
  const byId = new Map((Array.isArray(notes) ? notes : []).map(note => [note?._id ?? note?.id, note]));
  return {
    blocked: false,
    notes: requested.map(id => byId.get(id)).filter(note => note && !note.system?.deleted)
  };
}

const { ApplicationV2 } = foundry.applications.api;

/**
 * True while `_onClose` is restoring the token control. SceneControls fires a deactivating
 * onChange for the journalinator control during that restore; init.mjs consults this guard so a
 * close can never bounce back into opening the app again.
 */
let sceneControlRestoreDepth = 0;

export function isRestoringSceneControl() {
  return sceneControlRestoreDepth > 0;
}

/** Release the guard after the asynchronous SceneControls activation settles. */
function restoreControlMode() {
  const controls = globalThis.ui?.controls;
  if (!controls || typeof controls.activate !== "function") return;
  // Closing always returns to tokens/select. Foundry v14 stores the current control as a record,
  // not a string, so there is no reliable "user picked something else" comparison to make here.
  const target = defaultControlTarget(controls.controls);
  if (!target) return;
  sceneControlRestoreDepth += 1;
  let result;
  try {
    result = controls.activate(target);
  } catch (err) {
    sceneControlRestoreDepth = Math.max(0, sceneControlRestoreDepth - 1);
    console.error("Journalinator: could not restore the token control", err);
    return;
  }
  Promise.resolve(result)
    .catch(err => console.error("Journalinator: could not restore the token control", err))
    .finally(() => { sceneControlRestoreDepth = Math.max(0, sceneControlRestoreDepth - 1); });
}

/**
 * Fullscreen app: a top bar (title, quick switcher, + New Note, + Label, Trash and filters),
 * the note canvas taking the center, and an editor panel on the
 * right. Raw DOM render — no Handlebars — since ApplicationV2 supports that directly by
 * implementing _renderHTML/_replaceHTML ourselves.
 *
 * Both the canvas (JournalCanvas) and the editor (NoteEditor) are created once and kept alive
 * across this app's re-renders — a document-sync hook firing elsewhere never resets the
 * canvas's pan/zoom or blows away an in-progress block edit (beyond the content-preserving
 * rebuild NoteEditor already does for that case).
 */
export default class JournalApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "journalinator-app",
    classes: ["journalinator"],
    window: {
      title: "Journalinator",
      resizable: true
    },
    position: { width: 1200, height: 750 }
  };

  #view = "shared";
  #selectedNoteId = null;
  #query = "";
  #filterAuthors = new Set();
  #layoutFilter = null;
  #switcherOpen = false;
  #switcherHighlight = 0;
  #hookIds = [];
  #onGlobalKeydown = null;
  #onToolbarPointerDown = null;
  #toolbarPointerTarget = null;
  #transferDismiss = null;
  #focusedCanvasRenders = new WeakSet();
  #lastAppliedTheme = null;
  #pinsNormalized = false;
  // One chronological undo stack for every client-visible operation. Delete entries are pushed
  // when the request is sent; pin/route entries only after the active GM acknowledges the write,
  // so a rejected or rolled-back operation can never consume a Ctrl+Z.
  #history = [];
  #clipboard = [];
  // Undo entries are pushed when a delete request is sent so Ctrl+Z still works if the GM write
  // later fails. The success notice, however, is delayed until every note in the batch is
  // acknowledged; a rejected/rolled-back write sends no ack, so no false "Deleted N" appears.
  #pendingDeleteAcks = new Map();
  #historyDialog = null;
  #deleteConfirmPending = false;
  #replacingHTML = false;
  #editor = new NoteEditor({
    onClose: ({ noteId }) => this.#onEditorClosed(noteId),
    onRequestEdit: id => this.#beginEditing(id),
    onNoteChanged: () => this.#syncSelectionControls()
  });
  #canvas = new JournalCanvas({
    onSelectNote: id => {
      this.#selectedNoteId = id;
      this.#syncSelectionControls();
    },
    onToggleTask: (id, index) => this.#toggleTask(id, index),
    onEditNote: (id, point) => this.#beginEditing(id, point),
    onCreateNoteAt: (x, y, options) => this.#openCreationMenuAt(x, y, options),
    onPinToolChange: active => {
      const button = this.element?.querySelector(".journalinator-add-pin");
      button?.classList.toggle("on", active);
      button?.setAttribute("aria-pressed", String(active));
    },
    onMoveCard: (noteId, x, y) => requestWrite({ type: "moveCard", noteId, x, y }),
    onMoveCards: moves => requestWrite({ type: "moveCards", moves }),
    onResizeCard: (noteId, width, height) => this.#resizeCard(noteId, width, height),
    onAutoSize: ids => this.#autoSizeNotes(ids),
    onAddLabelAt: (x, y) => requestWrite({ type: "addLabel", text: t("JN.Label.Default"), x, y }),
    onRemoveLabel: labelId => requestWrite({ type: "removeLabel", labelId }),
    onAttachStamp: (noteId, stamp, color, corner) =>
      requestWrite({ type: "addLabel", noteId, stamp, color, corner }),
    onStampCorner: (labelId, corner) => requestWrite({ type: "updateLabel", labelId, corner }),
    onStampColor: (labelId, color) => requestWrite({ type: "updateLabel", labelId, color }),
    onMoveLabel: (labelId, x, y) => requestWrite({ type: "updateLabel", labelId, x, y }),
    onEditLabel: async labelId => {
      const layout = notesStore.getLayout();
      const current = layout?.labels?.[labelId]?.text ?? "";
      const text = await this.#promptText(t("JN.Prompt.EditLabel"), current);
      if (text === null) return;
      if (text.trim() === "") requestWrite({ type: "removeLabel", labelId });
      else requestWrite({ type: "updateLabel", labelId, text });
    },
    onCreateLink: async (sourceId, targetId, ports) => {
      await requestWrite({ type: "createLink", sourceId, targetId, ...ports });
      if (game.users.activeGM?.id === game.user.id && this.#view === "shared"
          && this.#canvas.root.isConnected) {
        this.#canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
      }
    },
    onUpdateLink: (noteId, linkId, fields) => requestWrite({ type: "updateLink", noteId, linkId, fields }),
    onDeleteLink: (noteId, linkId) => requestWrite({ type: "deleteLink", noteId, linkId }),
    onAddCardAnchor: (noteId, anchor) => {
      if (!anchor || anchor.kind !== "minor"
          || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return undefined;
      return requestWrite({ type: "addCardAnchor", noteId, kind: "minor", x: anchor.x, y: anchor.y });
    },
    onMoveCardAnchor: (noteId, anchorId, x, y) =>
      requestWrite({ type: "moveCardAnchor", noteId, anchorId, x, y }),
    onRemoveCardAnchor: (noteId, anchorId) => requestWrite({ type: "removeCardAnchor", noteId, anchorId }),
    onBoardPinAction: action => requestWrite({ type: "boardPinAction", action }),
    onRouteNoteOnLink: (sourceId, linkId, noteId, mode, index, undoId) =>
      requestWrite({ type: "routeNoteOnLink", sourceId, linkId, noteId, mode, index, undoId }),
    onDetachRouteNote: (sourceId, linkId, noteId, undoId) =>
      requestWrite({ type: "detachRouteNote", sourceId, linkId, noteId, undoId }),
    onClearThreadPins: (noteId, linkId) =>
      requestWrite({ type: "clearThreadPins", noteId, linkId }),
    // Read-mode selection surface. Every mutation goes through a short lease, so a lock that
    // arrives after selection still rejects the whole action.
    onSetLayout: (ids, layout) => this.#applyAppearance(ids, { layout }),
    onSetAppearance: (ids, patch) => this.#applyAppearance(ids, patch),
    onChooseBackground: ids => this.#chooseBackground(ids),
    onAutoSize: ids => this.#autoSizeNotes(ids),
    onHistory: id => this.#openHistory(id),
    onSendNote: id => this.#openSendPanel(this.element, null, id, "shared"),
    onCopyNotes: ids => this.#copyNotes(ids),
    onDeleteNotes: ids => this.#deleteNotes(ids)
  });

  #private = new PrivateWorkspace({
    onChange: () => {
      // Autosave/appearance writes update only the retained private canvas while the shared
      // editor is open; a full app render would move the focused textarea.
      if (this.#view === "private" && this.#private?.editor?.isEditing) {
        this.#private.refreshCanvas();
        this.#syncSelectionControls();
        return;
      }
      this.render();
    },
    onSelectionChange: () => this.#syncSelectionControls(),
    onSend: noteId => this.#openSendPanel(this.element, null, noteId, "private"),
    onStamp: (noteId, trigger) => this.#private.canvas.openStampPicker(noteId, trigger),
    onPinToolChange: active => {
      const button = this.element?.querySelector(".journalinator-private-add-pin");
      button?.classList.toggle("on", active);
      button?.setAttribute("aria-pressed", String(active));
    }
  });

  #select(noteId) {
    if (!noteId) return;
    this.#selectedNoteId = noteId;
    this.render();
  }

  #noteFor(noteId) {
    return notesStore.getNote(noteId);
  }

  #noteLocked(noteId) {
    return this.#canvas.isNoteLocked?.(noteId) === true;
  }

  /** Shared writes require both an active GM and a current stored schema. */
  #sharedWritable() {
    if (!game.users?.activeGM) return false;
    return notesStore.getSchemaStatus().current === true;
  }

  #warnIncompatible() {
    ui.notifications?.warn(t("JN.Notices.Incompatible"));
  }

  #warnLocked() {
    ui.notifications?.warn(t("JN.Lock.LockedAction"));
  }

  /**
   * Acquisition for one revisioned helper write (task toggle, appearance, layout). The lease is
   * always released in `finally`, even when the save is rejected or the transport disappears.
   */
  async #withShortLease(noteId, action) {
    if (!notesStore.getSchemaStatus().current) {
      this.#warnIncompatible();
      return null;
    }
    if (this.#noteLocked(noteId)) {
      this.#warnLocked();
      return null;
    }
    let grant;
    try {
      grant = await requestEditReply({
        type: "beginNoteEdit", noteId, clientSessionId
      });
    } catch (error) {
      console.error("Journalinator: could not acquire edit lease", error);
      grant = null;
    }
    if (!grant || grant.type !== "noteEditGranted" || !grant.lease) {
      if (grant?.type === "noteEditDenied") this.#warnLocked();
      return null;
    }
    try {
      return await action(grant.lease, grant);
    } finally {
      try {
        await requestEditReply({ type: "endNoteEdit", noteId, lease: grant.lease });
      } catch (error) {
        // The lease expires on its own; bookkeeping must never mask the action result.
        console.error("Journalinator: could not release short edit lease", error);
      }
    }
  }

  /** Opens the shared Blank/Document/Profile menu, anchored to a toolbar button or board point. */
  #openCreationMenuAt(x, y, { clientX, clientY } = {}) {
    if (!this.#sharedWritable()) {
      if (!game.users?.activeGM) ui.notifications?.warn(t("JN.Notices.NoGM"));
      else this.#warnIncompatible();
      return null;
    }
    const root = this.#canvas.root;
    const rect = root.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const screenX = Number.isFinite(clientX) && clientX
      ? clientX
      : rect.left + this.#canvas.view.x + x * this.#canvas.view.k;
    const screenY = Number.isFinite(clientY) && clientY
      ? clientY
      : rect.top + this.#canvas.view.y + y * this.#canvas.view.k;
    return openCreationMenu({
      clientX: screenX,
      clientY: screenY,
      t,
      onChoose: templateId => { void this.#createFromTemplate(templateId, { x, y }); }
    });
  }

  async #createFromTemplate(templateId, { x, y }) {
    if (!this.#sharedWritable()) {
      if (!game.users?.activeGM) ui.notifications?.warn(t("JN.Notices.NoGM"));
      else this.#warnIncompatible();
      return null;
    }
    const result = await createNoteFromMenu({
      templateId,
      x,
      y,
      clientSessionId,
      requestEditReply,
      onCreated: created => this.#onNoteCreated(created)
    });
    if (!result.ok) {
      ui.notifications?.warn(t("JN.Creation.Failed"));
      return null;
    }
    return result;
  }

  async #onNoteCreated(result) {
    const noteId = result?.reply?.noteId;
    if (!noteId) return;
    this.#selectedNoteId = noteId;
    await this.render();
    await this.#beginEditing(noteId, null, result.note, result.focus);
  }

  /**
   * Mounts the single shared NoteEditor on the card paper. The card keeps its rotation; the
   * editor toolbar/status are screen-space overlays owned by CSS.
   */
  async #beginEditing(noteId, point = null, noteOverride = null, focus = null) {
    if (!noteId) return { ok: false };
    if (this.#view !== "shared") return { ok: false };
    if (!this.#sharedWritable()) {
      if (!game.users?.activeGM) ui.notifications?.warn(t("JN.Notices.NoGM"));
      else this.#warnIncompatible();
      return { ok: false };
    }
    if (this.#noteLocked(noteId)) {
      this.#warnLocked();
      return { ok: false };
    }
    if (this.#editor.isEditing()) {
      await this.#editor.close({ reason: "switch" });
    }
    const note = noteOverride ?? this.#noteFor(noteId);
    if (!note || note.system?.deleted) return { ok: false };
    const card = this.#canvas.cardEls.get(noteId);
    if (!card) return { ok: false };
    this.#selectedNoteId = noteId;
    this.#canvas.setEditingNote(noteId);
    card.classList.add("jn-editing");
    const result = await this.#editor.open(noteId, { host: card, note });
    if (!result?.ok) {
      this.#canvas.setEditingNote(null);
      card.classList.remove("jn-editing");
      return result;
    }
    if (point && Number.isFinite(point.clientX) && Number.isFinite(point.clientY)) {
      this.#editor.focusAtPoint(point.clientX, point.clientY);
    } else if (focus) {
      this.#focusEditorDestination(focus);
    }
    this.#placeEditorChrome(noteId);
    this.#syncSelectionControls();
    return result;
  }

  /** Toolbar sits 12 px above the paper unless that would leave the canvas viewport. */
  #placeEditorChrome(noteId) {
    const card = this.#canvas.cardEls.get(noteId);
    const toolbar = this.#editor.root?.querySelector?.(".jn-editor-toolbar");
    if (!card || !toolbar) return;
    const rootRect = this.#canvas.root.getBoundingClientRect?.() ?? { top: 0 };
    const toolbarRect = toolbar.getBoundingClientRect?.() ?? { top: 0 };
    this.#editor.root.classList.toggle("jn-toolbar-below",
      toolbarRect.top < (rootRect.top ?? 0) + 8);
  }

  #focusEditorDestination(focus) {
    const textarea = this.#editor.root?.querySelector?.("textarea.jn-source-input");
    if (!textarea) return;
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
  }

  #onEditorClosed(noteId) {
    this.#editor.detach();
    this.#canvas.setEditingNote(null);
    const card = this.#canvas.cardEls.get(noteId);
    card?.classList.remove("jn-editing");
    if (this.#view === "shared" && this.#canvas.root.isConnected) {
      this.#canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
    }
    this.#syncSelectionControls();
  }

  /** One revisioned task-toggle write outside the editor, under a short whole-note lease. */
  async #toggleTask(noteId, index) {
    if (!notesStore.getSchemaStatus().current) return this.#warnIncompatible();
    if (this.#noteLocked(noteId)) return this.#warnLocked();
    const note = this.#noteFor(noteId);
    if (!note) return;
    const body = toggleTaskListItem(note.system.body ?? "", index);
    if (typeof body !== "string") return;
    const result = await this.#withShortLease(noteId, (lease, grant) => requestEditReply({
      type: "saveNoteBody",
      noteId,
      lease,
      sequence: 1,
      baseRevision: Number.isInteger(grant.revision) ? grant.revision : (note.system.revision ?? 0),
      body,
      geometry: null,
      eventIds: []
    }));
    if (result?.type === "noteSaveAck") this.render();
  }

  #clampWidth(value) {
    const width = Number(value);
    return Number.isFinite(width) ? Math.max(160, Math.min(800, Math.round(width))) : 300;
  }

  #clampHeight(value) {
    const height = Number(value);
    return Number.isFinite(height) ? Math.max(80, Math.min(1600, Math.round(height))) : 120;
  }

  #resizeCard(noteId, width, height) {
    if (!notesStore.getSchemaStatus().current) return this.#warnIncompatible();
    if (this.#noteLocked(noteId)) return this.#warnLocked();
    const card = notesStore.getLayout()?.cards?.[noteId];
    if (!card) return;
    const nextWidth = this.#clampWidth(width);
    const nextHeight = this.#clampHeight(height);
    return requestWrite({
      type: "setCardSizing",
      noteId,
      sizing: { mode: "manual", width: nextWidth, minHeight: nextHeight },
      autoSizeOrigin: card.autoSizeOrigin ?? { x: card.x + nextWidth / 2, y: card.y }
    });
  }

  #autoSizeNotes(ids) {
    if (!notesStore.getSchemaStatus().current) {
      this.#warnIncompatible();
      return Promise.resolve(false);
    }
    const requested = Array.isArray(ids) ? ids : [];
    if (requested.some(noteId => this.#noteLocked(noteId))) {
      this.#warnLocked();
      return Promise.resolve(false);
    }
    const cards = notesStore.getLayout()?.cards ?? {};
    const writes = [];
    for (const noteId of requested) {
      const card = cards[noteId];
      if (!card) continue;
      const measured = this.#canvas.cardBox(noteId);
      const origin = card.autoSizeOrigin
        ?? { x: card.x + (Number.isFinite(measured?.w) ? measured.w / 2 : 110), y: card.y };
      writes.push(requestWrite({
        type: "setCardSizing",
        noteId,
        sizing: { mode: "auto", width: null, minHeight: null },
        autoSizeOrigin: origin
      }));
    }
    return Promise.allSettled(writes);
  }

  #appearanceSkinPatch(patch) {
    const clean = {};
    for (const key of ["paper", "font", "torn", "backgroundImage"]) {
      if (Object.hasOwn(patch ?? {}, key)) clean[key] = patch[key];
    }
    return clean;
  }

  /** Short-lease appearance/layout write; body text and revision are untouched. */
  async #applyAppearance(ids, patch = {}) {
    if (!Array.isArray(ids) || !ids.length) return false;
    if (!notesStore.getSchemaStatus().current) {
      this.#warnIncompatible();
      return false;
    }
    if (this.#canvas.readOnly) return false;
    if (ids.some(id => this.#noteLocked(id))) {
      this.#warnLocked();
      return false;
    }
    let applied = false;
    for (const noteId of ids) {
      const note = this.#noteFor(noteId);
      if (!note) continue;
      const layout = patch.layout === "profile" || patch.layout === "plain"
        ? patch.layout
        : (note.system.layout === "profile" ? "profile" : "plain");
      const skin = resolveSkin({ ...resolveSkin(note), ...this.#appearanceSkinPatch(patch) });
      const reply = await this.#withShortLease(noteId, lease => requestEditReply({
        type: "saveNoteAppearance", noteId, lease, layout, skin
      }));
      if (reply?.type === "noteAppearanceAck") applied = true;
    }
    if (applied) {
      if (this.#view === "shared" && this.#canvas.root.isConnected) {
        this.#canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
      }
    }
    return applied;
  }

  async #chooseBackground(ids) {
    if (!Array.isArray(ids) || !ids.length) return false;
    const note = this.#noteFor(ids[0]);
    const current = resolveSkin(note).backgroundImage ?? "";
    const src = await promptImageSource(
      t("JN.Skin.BackgroundImage"),
      current,
      t("JN.Skin.BackgroundHint")
    );
    if (src === null || src === undefined) return false;
    return this.#applyAppearance(ids, { backgroundImage: src.trim() || null });
  }

  /** T9 owns the history modal; expose one wiring point without building it here. */
  #historyHandler = null;

  setHistoryHandler(handler) {
    this.#historyHandler = typeof handler === "function" ? handler : null;
  }

  #openHistory(noteId) {
    if (this.#historyHandler) return this.#historyHandler(noteId);
    const note = this.#noteFor(noteId);
    if (!note) return null;
    const dialog = openHistoryDialog({
      noteId,
      note,
      requestEditReply,
      clientSessionId,
      isLocked: () => this.#noteLocked(noteId),
      notify: (level, message) => ui.notifications?.[level]?.(message),
      onRestored: () => {
        if (this.#view === "shared" && this.#canvas.root.isConnected) this.render();
      },
      t
    });
    this.#historyDialog = dialog;
    return dialog;
  }

  /** Clipboard payload is the current v2 content only. */
  #copyNotes(ids) {
    const { blocked, notes } = collectCopyableNotes(
      notesStore.getAllNotes(),
      ids,
      id => this.#canvas.isNoteLocked?.(id) === true
    );
    if (blocked) {
      this.#warnLocked();
      return false;
    }
    if (!notes.length) return false;
    this.#clipboard = notes.map(clipboardEntryForNote);
    ui.notifications?.info(t("JN.Clipboard.Copied", { count: this.#clipboard.length }));
    return true;
  }

  #copySelectedNotes() {
    if (this.#view === "private") {
      return this.#private.copyNotes(this.#private.getSelectedNoteIds());
    }
    return this.#copyNotes(this.#canvas.getSelectedNoteIds());
  }

  async #pasteClipboard() {
    if (this.#view === "private") {
      if (!this.#private.clipboard.length) return false;
      const position = this.#private.canvas.newCardPosition();
      await this.#private.pasteClipboard(position);
      return true;
    }
    if (!this.#clipboard.length) return false;
    if (!this.#sharedWritable()) {
      if (!game.users?.activeGM) ui.notifications?.warn(t("JN.Notices.NoGM"));
      else this.#warnIncompatible();
      return true;
    }
    const position = this.#canvas.newCardPosition();
    for (const entry of this.#clipboard) {
      await requestWrite(clipboardPasteMessage(entry, position));
    }
    ui.notifications?.info(t("JN.Clipboard.Pasted", { count: this.#clipboard.length }));
    return true;
  }

  #deleteNotes(ids) {
    if (!notesStore.getSchemaStatus().current) {
      this.#warnIncompatible();
      return false;
    }
    const unique = [...new Set(Array.isArray(ids) ? ids : [])].filter(id => {
      const page = notesStore.getSharedPage(id);
      return page && !page.system.deleted;
    });
    if (!unique.length) return false;
    if (unique.some(id => this.#noteLocked(id))) {
      this.#warnLocked();
      return false;
    }
    const undoId = foundry.utils.randomID();
    this.#canvas.clearSelection();
    this.#pushHistory({ kind: "delete", noteIds: unique, undoId });
    this.#expectDeleteAcks(undoId, unique.length);
    requestWrite({ type: "deleteNotes", noteIds: unique, undoId });
    return true;
  }

  _onFirstRender() {
    this.#editor.activate();
    this.#normalizePinsOnce();
    const rerender = () => {
      // While the in-place editor is open, refresh the retained canvas instead of moving the
      // whole subtree through a full app render: moving it would blur the textarea and break
      // selection, IME composition and native undo. The card body under the editor is skipped
      // by the canvas itself.
      if (this.#view === "shared" && this.#editor?.isEditing() && this.#canvas?.root?.isConnected) {
        this.#canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
        this.#syncSelectionControls();
        return;
      }
      this.render();
    };
    for (const hook of [
      "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage",
      "updateJournalEntry", "createUser", "updateUser", "deleteUser", "userConnected"
    ]) {
      this.#hookIds.push([hook, Hooks.on(hook, rerender)]);
    }
    this.#hookIds.push(["journalinatorEditStateChanged", Hooks.on("journalinatorEditStateChanged", rerender)]);
    this.#hookIds.push(["journalinatorThemeRegistered", Hooks.on("journalinatorThemeRegistered", rerender)]);
    this.#hookIds.push(["journalinatorWriteApplied", Hooks.on("journalinatorWriteApplied", message => {
      // Commit client-side undo only after the active GM confirms the write actually landed.
      // A rejected, rolled-back or stale operation sends no acknowledgement (or one without an
      // undo id), so it can never consume a later Ctrl+Z.
      if (message?.forUserId !== game.user.id) return;
      if (message.kind === "privateTransfer") {
        // Private copies are cross-user and intentionally not undoable; show the notice only
        // after the active GM confirmed the operation actually landed.
        this.#onPrivateTransferApplied(message);
        return;
      }
      if (message.kind === "delete") {
        this.#onDeleteApplied(message);
        return;
      }
      if (typeof message.undoId !== "string" || !message.undoId) return;
      if (message.kind === "route") {
        this.#pushHistory({ kind: "route", undoId: message.undoId });
        // The success notice is only shown here, after the server acknowledged the operation.
        const key = { route: "JN.Route.Routed", split: "JN.Route.SplitDone", detach: "JN.Route.Detached" }[message.action];
        if (key) ui.notifications?.info(t(key));
        return;
      }
      if (message.kind === "pin") this.#pushHistory({ kind: "pin", undoId: message.undoId });
    })]);
    const rerenderForScene = () => {
      if ((game.settings.get("fvtt-journalinator", "boardTheme") ?? "stylized") !== SCENE_THEME_ID) return;
      clearSceneThemeCache();
      rerender();
    };
    this.#hookIds.push(["canvasReady", Hooks.on("canvasReady", rerenderForScene)]);
    this.#hookIds.push(["updateScene", Hooks.on("updateScene", (scene, changes) => {
      if ("background" in changes || "img" in changes || "backgroundColor" in changes
        || "levels" in changes || "initialLevel" in changes) rerenderForScene();
    })]);

    this.#onGlobalKeydown = ev => {
      // The patch-notes dialog is a read-only overlay: do not let canvas shortcuts (copy,
      // paste, Backspace, undo) fire while it has focus.
      if (ev.target.closest?.(".jn-patch-notes, .jn-patch-notes-button")) return;
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "k") {
        ev.preventDefault();
        const input = this.element.querySelector(".journalinator-search");
        input?.focus();
        input?.select();
        return;
      }

      if (ev.defaultPrevented || ev.isComposing || isTextEntryTarget(ev.target)) return;
      const consume = () => {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      };

      const activeCanvas = this.#view === "private" ? this.#private.canvas : this.#canvas;
      const inCanvas = activeCanvas.root.contains(ev.target);
      const inEditor = this.element.querySelector(".journalinator-editor")?.contains(ev.target);
      if (inCanvas || inEditor) {
        const plainCommand = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey;
        if (plainCommand && ev.key.toLowerCase() === "c") {
          const selection = globalThis.getSelection?.();
          if (selection && !selection.isCollapsed) return;
          if (this.#copySelectedNotes()) consume();
          return;
        }
        if (plainCommand && ev.key.toLowerCase() === "v") {
          if (!this.#clipboard.length) return;
          consume();
          this.#pasteClipboard();
          return;
        }
      }

      if (this.#view === "private") {
        if (!this.#private.canvas.root.contains(ev.target)) return;
        if ((ev.key === "Backspace" || ev.key === "Delete")
            && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
          consume();
          if (!ev.repeat) {
            if (this.#private.canvas.deletePinForShortcut()) return;
            if (!this.#private.canvas.deleteSelectedLink()) this.#private.deleteSelected();
          }
          return;
        }
        if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey
            && (ev.code === "KeyZ" || ev.key.toLowerCase() === "z")) {
          consume();
          if (!ev.repeat) this.#private.undo();
        }
        return;
      }

      if (!this.#canvas.root.contains(ev.target) || !game.users.activeGM) return;

      if ((ev.key === "Backspace" || ev.key === "Delete")
          && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
        consume();
        if (ev.repeat) return;
        if (this.#canvas.deletePinForShortcut()) return;
        if (this.#canvas.deleteSelectedLink()) return;
        const labelIds = this.#canvas.getSelectedLabelIds();
        const selected = this.#canvas.getSelectedNoteIds();
        const shared = selected.filter(id => {
          const page = notesStore.getSharedPage(id);
          return page && !page.system.deleted;
        });
        if (!shared.length && !labelIds.length) return;
        const deleteSelection = () => {
          for (const labelId of labelIds) requestWrite({ type: "removeLabel", labelId });
          if (!shared.length) {
            this.#canvas.clearSelection();
            return;
          }
          this.#deleteNotes(shared);
        };
        // One note stays a single, immediate action; a multi-selection is destructive enough to
        // require an explicit confirmation. Cancelling must also leave selected labels untouched.
        if (shared.length <= 1) {
          deleteSelection();
          return;
        }
        // Ignore repeats (including key auto-repeat) while the confirmation is open, so holding
        // or mashing Delete cannot stack several dialogs and delete the same selection twice.
        if (this.#deleteConfirmPending) return;
        this.#deleteConfirmPending = true;
        void foundry.applications.api.DialogV2.confirm({
          window: { title: t("JN.Delete.ConfirmTitle") },
          content: `<p>${t("JN.Delete.ConfirmMultiple", { count: shared.length })}</p>`
        }).then(confirmed => {
          if (confirmed) deleteSelection();
        }).catch(err => console.error("Journalinator: delete confirmation failed", err))
          .finally(() => { this.#deleteConfirmPending = false; });
        return;
      }

      if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey
          && (ev.code === "KeyZ" || ev.key.toLowerCase() === "z")) {
        consume();
        if (ev.repeat) return;
        // One chronological stack: whatever the user did last is undone first, regardless of
        // whether it was a delete, a pin change, a route insertion/split or a detach. A stale id
        // is refused by the active GM (JN.Pin.UndoStale / JN.Route.UndoStale) after it is consumed.
        const entry = this.#history.pop();
        if (!entry) return;
        if (entry.kind === "route") {
          requestWrite({ type: "undoRouteSplit", undoId: entry.undoId });
        } else if (entry.kind === "pin") {
          requestWrite({ type: "undoPinChange", undoId: entry.undoId });
        } else if (entry.kind === "delete") {
          for (const noteId of entry.noteIds) requestWrite({ type: "restoreNote", noteId, undoId: entry.undoId });
        }
      }
    };
    addEventListener("keydown", this.#onGlobalKeydown, true);
  }

  _onClose() {
    this.#historyDialog?.close?.();
    this.#historyDialog = null;
    this.#canvas.finishInlineText();
    this.#editor.deactivate();
    this.#canvas.cancelLinkTool();
    this.#canvas.disconnectGeometry();
    this.#closeTransferPanels();
    this.#private.destroy();
    this.#switcherOpen = false;
    for (const [hook, id] of this.#hookIds) Hooks.off(hook, id);
    this.#hookIds = [];
    if (this.#onGlobalKeydown) removeEventListener("keydown", this.#onGlobalKeydown, true);
    this.#onGlobalKeydown = null;
    if (this.#onToolbarPointerDown && this.#toolbarPointerTarget) {
      this.#toolbarPointerTarget.removeEventListener("pointerdown", this.#onToolbarPointerDown);
    }
    this.#onToolbarPointerDown = null;
    this.#toolbarPointerTarget = null;
    // Leaving the Journalinator control active after the window closes is what made the next
    // SceneControls deactivation bounce the app open again. Return to tokens before announcing
    // the close, and let init.mjs drop its instance reference through the hook.
    restoreControlMode();
    Hooks.callAll("journalinatorAppClosed", this);
  }

  #matchesQuery(note, q) {
    if (!q) return true;
    const author = game.users.get(note.system.authorId)?.name ?? "";
    return noteMatchesQuery(note, q, author);
  }

  /**
   * Begins collecting per-note delete acknowledgements for one undo batch. The GM sends one ack
   * per note; they are aggregated here by undoId so a multi-delete shows a single notice.
   */
  #expectDeleteAcks(undoId, count) {
    if (typeof undoId !== "string" || !undoId || count < 1) return;
    this.#pendingDeleteAcks.set(undoId, { expected: count, acked: 0 });
  }

  /** Counts a confirmed deletion batch and shows the recovery notice once complete. */
  #onDeleteApplied(message) {
    if (typeof message.undoId !== "string" || !message.undoId) return;
    const pending = this.#pendingDeleteAcks.get(message.undoId);
    if (!pending) return;
    const count = Array.isArray(message.noteIds) ? Math.max(1, message.noteIds.length) : 1;
    pending.acked = Math.min(pending.expected, pending.acked + count);
    if (pending.acked < pending.expected) return;
    this.#pendingDeleteAcks.delete(message.undoId);
    ui.notifications?.info(t("JN.Delete.Notice", { count: pending.acked }));
  }

  /** Append to the single chronological undo stack, capped like the old per-kind arrays. */
  #pushHistory(entry) {
    this.#history.push(entry);
    if (this.#history.length > 20) this.#history.shift();
  }

  /** Update an icon button's tooltip/accessible name after a selection change without re-rendering. */
  #setIconLabel(button, label) {
    if (!button) return;
    const text = foundry.utils.escapeHTML(String(label ?? ""));
    if (game.tooltip) {
      button.dataset.tooltip = text;
      button.dataset.tooltipDirection = "DOWN";
      button.removeAttribute("title");
    } else {
      button.title = String(label ?? "");
    }
    button.setAttribute("aria-label", text);
  }

  /** One idempotent pin cleanup per app session, once an active GM can service the write. */
  #normalizePinsOnce() {
    if (this.#pinsNormalized || !game.users?.activeGM) return;
    if (!notesStore.getSchemaStatus().current) return;
    this.#pinsNormalized = true;
    requestWrite({ type: "normalizePins" });
  }

  /**
   * Selection changes are canvas-local (no app re-render), so the fit/send controls are updated
   * in place. The fit label switches between "all" and "selection". Each Send button stays
   * disabled until its source canvas has a sendable selection, an active GM is online and at
   * least one destination exists for that source.
   */
  #syncSelectionControls() {
    const root = this.element;
    if (!root) return;
    const sharedSelected = this.#canvas?.getSelectedNoteIds?.().length ?? 0;
    const privateSelected = this.#private?.getSelectedNoteIds?.().length ?? 0;
    const sharedFit = root.querySelector(".journalinator-fit");
    const privateFit = root.querySelector(".journalinator-private-fit");
    if (sharedFit) {
      this.#setIconLabel(sharedFit, t(sharedSelected
        ? "JN.TopBar.FitSelection" : "JN.TopBar.FitAll"));
    }
    if (privateFit) {
      this.#setIconLabel(privateFit, t(privateSelected
        ? "JN.TopBar.FitSelection" : "JN.TopBar.FitAll"));
    }
    const offline = !game.users?.activeGM;
    const privateSend = root.querySelector(".journalinator-private-send");
    if (privateSend) {
      const canSend = !offline && !!this.#private?.page && privateSelected > 0;
      privateSend.disabled = !canSend;
      privateSend.classList.toggle("disabled", !canSend);
      this.#setIconLabel(privateSend, offline
        ? t("JN.Private.NeedGM")
        : (!this.#private?.page
          ? t("JN.Transfer.NoPrivateSpace")
          : (privateSelected ? t("JN.Transfer.SendTo") : t("JN.Transfer.SelectNotes"))));
    }

    const sharedSend = root.querySelector(".journalinator-shared-send");
    if (sharedSend) {
      const selection = this.#canvas?.getSelectedNoteIds?.() ?? [];
      const locked = selection.some(id => this.#noteLocked(id));
      const sendable = locked ? [] : this.#sharedSendableIds(selection);
      const hasOtherUser = [...(game.users ?? [])].some(user => user && user.id !== game.user.id);
      const hasDestination = hasOtherUser || !!privateStore.findActive(game.user.id);
      const writeBlocked = !offline && !notesStore.getSchemaStatus().current;
      const canSend = !offline && !writeBlocked && sendable.length > 0 && hasDestination;
      sharedSend.disabled = !canSend;
      sharedSend.classList.toggle("disabled", !canSend);
      this.#setIconLabel(sharedSend, offline
        ? t("JN.Private.NeedGM")
        : (writeBlocked
          ? t("JN.Notices.Incompatible")
          : (locked
            ? t("JN.Transfer.Locked")
            : (!sendable.length
              ? t("JN.Transfer.SelectNotes")
              : (!hasDestination ? t("JN.Transfer.NoRecipients") : t("JN.Transfer.SendTo"))))));
    }
  }

  /** Live shared note ids from a selection. Locked notes are rejected by the caller. */
  #sharedSendableIds(ids) {
    const requested = (Array.isArray(ids) ? ids : []).filter(id => typeof id === "string" && id);
    return requested.filter(id => {
      const page = notesStore.getSharedPage(id);
      return !!page && !page.system.deleted;
    });
  }

  /** Minimal, payload-free view of this client's pending incoming transfers. */
  #pendingIncoming() {
    const userId = game.user?.id;
    if (!userId) return [];
    return privateStore.pendingTransfers(userId)
      .filter(record => record && record.toUserId === userId)
      .map(record => {
        const titles = Array.isArray(record.summary?.titles)
          ? record.summary.titles.filter(title => typeof title === "string").slice(0, 20)
          : [];
        return {
          id: record.id,
          fromUserId: record.fromUserId,
          fromName: game.users.get(record.fromUserId)?.name ?? t("JN.Common.Unknown"),
          count: Number.isFinite(record.summary?.count) ? record.summary.count : titles.length,
          titles,
          createdAt: Number.isFinite(record.createdAt) ? record.createdAt : 0
        };
      });
  }

  /** Summarises links/route waypoints the GM had to drop while copying. */
  #transferDropWarning(message) {
    const links = Number.isFinite(message?.droppedLinks) ? message.droppedLinks : 0;
    const waypoints = Number.isFinite(message?.droppedWaypoints) ? message.droppedWaypoints : 0;
    const parts = [];
    if (links > 0) parts.push(t("JN.Transfer.LinksDropped", { count: links }));
    if (waypoints > 0) parts.push(t("JN.Transfer.WaypointsDropped", { count: waypoints }));
    return parts.join(" ");
  }

  /** Success notices for cross-user copies; deliberately never pushes an undo entry. */
  #onPrivateTransferApplied(message) {
    if (!message || message.kind !== "privateTransfer") return;
    const count = Number.isFinite(message.count) ? message.count : 0;
    const dropped = this.#transferDropWarning(message);
    if (message.action === "sent") {
      const name = game.users.get(message.toUserId)?.name ?? t("JN.Common.Unknown");
      ui.notifications?.info(t("JN.Transfer.SendSuccess", { count, name }));
      if (dropped) ui.notifications?.warn(dropped);
      return;
    }
    if (message.action === "imported") {
      ui.notifications?.info(t("JN.Transfer.ImportedSelf", { count }));
      if (dropped) ui.notifications?.warn(dropped);
      if (this.#view === "private") this.render();
      return;
    }
    if (message.action === "accepted") {
      ui.notifications?.info(t("JN.Transfer.Accepted", { count }));
      if (dropped) ui.notifications?.warn(dropped);
      // An accepted copy may have created this user's private page, so rebuild the private view.
      if (this.#view === "private") this.render();
      return;
    }
    if (message.action === "declined") {
      ui.notifications?.info(t("JN.Transfer.Declined", { count }));
      if (this.#view === "private") this.render();
    }
  }

  #closeTransferPanels(root = this.element) {
    for (const panel of root?.querySelectorAll?.(".jn-transfer-popover") ?? []) panel.hidden = true;
    for (const button of root?.querySelectorAll?.(
      ".journalinator-private-send, .journalinator-shared-send, .jn-shared-send, "
      + ".journalinator-private-inbox, .journalinator-transfer-banner"
    ) ?? []) button.setAttribute("aria-expanded", "false");
    this.#transferDismiss?.();
    this.#transferDismiss = null;
  }

  /** Shows one screen-space transfer panel and installs Escape/outside-click dismissal. */
  #showTransferPanel(panel, trigger) {
    if (!panel) return;
    this.#closeTransferPanels();
    panel.hidden = false;
    trigger?.setAttribute("aria-expanded", "true");
    const doc = panel.ownerDocument;
    const dismiss = event => {
      if (event.type === "keydown") {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        this.#closeTransferPanels();
        trigger?.focus?.();
        return;
      }
      if (panel.contains(event.target) || trigger?.contains?.(event.target)) return;
      this.#closeTransferPanels();
    };
    doc.addEventListener("pointerdown", dismiss, true);
    doc.addEventListener("keydown", dismiss, true);
    this.#transferDismiss = () => {
      doc.removeEventListener("pointerdown", dismiss, true);
      doc.removeEventListener("keydown", dismiss, true);
    };
    const focusTarget = panel.querySelector("select:not([disabled])") ?? panel.querySelector("button, input");
    focusTarget?.focus?.();
  }

  /**
   * Sender popover, source-aware: the private workspace offers the Main Canvas plus other users,
   * while the shared canvas offers each user's private canvas (including the sender's own when an
   * active private page exists). Every path creates an independent copy and leaves the source.
   */
  #openSendPanel(root, trigger = null, noteId = null, sourceView = this.#view) {
    const panel = root.querySelector(".journalinator-transfer-send");
    if (!panel) return;
    if (!game.users?.activeGM) return ui.notifications?.warn(t("JN.Private.NeedGM"));
    if (!panel.hidden) return this.#closeTransferPanels(root);

    const sharedSource = sourceView === "shared";
    const requested = noteId
      ? [noteId]
      : (sharedSource ? this.#canvas.getSelectedNoteIds() : this.#private.getSelectedNoteIds());
    let selected;
    let titles;
    let drops;
    let options;

    if (sharedSource) {
      if (!notesStore.getSchemaStatus().current) {
        return ui.notifications?.warn(t("JN.Notices.Incompatible"));
      }
      if (requested.some(id => this.#canvas?.isNoteLocked?.(id))) {
        return ui.notifications?.warn(t("JN.Lock.LockedAction"));
      }
      selected = this.#sharedSendableIds(requested);
      if (!selected.length) {
        return ui.notifications?.warn(requested.length
          ? t("JN.Transfer.Unavailable") : t("JN.Transfer.None"));
      }
      if (selected.length < requested.length) {
        ui.notifications?.warn(t("JN.Transfer.Unavailable"));
      }
      const ownPage = privateStore.findActive(game.user.id);
      const recipients = [...(game.users ?? [])]
        .filter(user => user && user.id !== game.user.id)
        .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
      const details = user => [
        user.isGM ? t("JN.Transfer.GM") : "",
        user.active === false ? t("JN.Transfer.Offline") : ""
      ].filter(Boolean).join(", ");
      const selfOption = ownPage
        ? `<option value="__self__">${t("JN.Transfer.MyPrivateCanvas")}</option>` : "";
      options = selfOption + recipients.map(user => `<option value="${
        foundry.utils.escapeHTML(user.id)
      }">${foundry.utils.escapeHTML(user.name ?? user.id)}${
        details(user) ? ` (${foundry.utils.escapeHTML(details(user))})` : ""}</option>`).join("");
      if (!options) return ui.notifications?.warn(t("JN.Transfer.NoRecipients"));
      titles = selected
        .map(id => {
          const page = notesStore.getSharedPage(id);
          return page ? noteSearchLabel(page) : "";
        })
        .filter(Boolean);
      drops = countSharedTransferDrops(notesStore.getSharedNotes(), selected);
    } else {
      if (!this.#private.page) return ui.notifications?.warn(t("JN.Transfer.NoPrivateSpace"));
      selected = requested.filter(id => this.#private.workspace?.notes?.[id]);
      if (!selected.length) return ui.notifications?.warn(t("JN.Transfer.None"));
      const recipients = [...(game.users ?? [])]
        .filter(user => user && user.id !== game.user.id)
        .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));
      const details = user => [
        user.isGM ? t("JN.Transfer.GM") : "",
        user.active === false ? t("JN.Transfer.Offline") : ""
      ].filter(Boolean).join(", ");
      options = `<option value="__main__">${t("JN.Private.MainCanvas")}</option>`
        + recipients.map(user => `<option value="${foundry.utils.escapeHTML(user.id)}">${
          foundry.utils.escapeHTML(user.name ?? user.id)
        }${details(user) ? ` (${foundry.utils.escapeHTML(details(user))})` : ""}</option>`).join("");
      titles = selected
        .map(id => {
          const note = this.#private.workspace?.notes?.[id];
          if (!note) return "";
          try {
            return noteSearchLabel(privateStore.noteView(this.#private.page, note));
          } catch {
            return "";
          }
        })
        .filter(Boolean);
      drops = countTransferDrops(this.#private.workspace, selected);
    }

    const dropParts = [];
    if (drops.droppedLinks > 0) {
      dropParts.push(t("JN.Transfer.LinksDropped", { count: drops.droppedLinks }));
    }
    if (drops.droppedWaypoints > 0) {
      dropParts.push(t("JN.Transfer.WaypointsDropped", { count: drops.droppedWaypoints }));
    }
    const dropWarning = dropParts.length
      ? `<p class="jn-transfer-warning jn-transfer-drops">${dropParts.join(" ")}</p>` : "";
    const copyHint = sharedSource
      ? t("JN.Transfer.SharedCopyHint") : t("JN.Transfer.CopyHint");
    const copyOnly = sharedSource
      ? t("JN.Transfer.SharedCopyOnly") : t("JN.Transfer.CopyOnly");
    panel.innerHTML = `
      <div class="jn-transfer-head">
        <h4 id="jn-transfer-send-title">${t("JN.Transfer.Title")}</h4>
        <button type="button" class="jn-transfer-close" aria-label="${t("JN.Common.Close")}">×</button>
      </div>
      <label class="jn-transfer-field"><span>${t("JN.Transfer.Recipient")}</span>
        <select class="jn-transfer-recipient">${options}</select>
      </label>
      <p class="jn-transfer-count">${t("JN.Transfer.SelectedCount", { count: selected.length })}</p>
      ${titles.length ? `<p class="jn-transfer-titles">${titles.map(foundry.utils.escapeHTML).join(", ")}</p>` : ""}
      <p class="jn-transfer-hint">${copyHint}</p>
      <p class="jn-transfer-hint">${copyOnly}</p>
      <p class="jn-transfer-warning">${t("JN.Transfer.LinksWarning")}</p>
      ${dropWarning}
      <div class="jn-transfer-actions">
        <button type="button" class="jn-transfer-cancel">${t("JN.Common.Cancel")}</button>
        <button type="button" class="jn-transfer-confirm">${t("JN.Transfer.Send")}</button>
      </div>`;
    panel.querySelector(".jn-transfer-close")?.addEventListener("click", () => this.#closeTransferPanels(root));
    panel.querySelector(".jn-transfer-cancel")?.addEventListener("click", () => this.#closeTransferPanels(root));
    panel.querySelector(".jn-transfer-confirm")?.addEventListener("click", () => {
      const toUserId = panel.querySelector(".jn-transfer-recipient")?.value;
      if (!toUserId) return;
      if (sharedSource) {
        // The active GM's writeApplied acknowledgement is the only success signal.
        requestWrite({
          type: "sendSharedToPrivate",
          toUserId: toUserId === "__self__" ? game.user.id : toUserId,
          noteIds: selected
        });
        this.#closeTransferPanels(root);
        return;
      }
      if (toUserId === "__main__") {
        if (!this.#sharedWritable()) {
          if (!game.users?.activeGM) ui.notifications?.warn(t("JN.Notices.NoGM"));
          else this.#warnIncompatible();
          return;
        }
        // One batch import so links between the selected notes are remapped together and
        // threads/activity are counted once.
        requestWrite({ type: "publishPrivateNotes", noteIds: selected });
        this.#closeTransferPanels(root);
        return;
      }
      // No optimistic notice: the active GM's writeApplied acknowledgement is the only success.
      requestWrite({ type: "sendPrivateTransfer", toUserId, noteIds: selected });
      this.#closeTransferPanels(root);
    });
    const fallbackTrigger = sharedSource
      ? (root.querySelector(".jn-shared-send") ?? root.querySelector(".journalinator-shared-send"))
      : root.querySelector(".jn-private-send");
    this.#showTransferPanel(panel, trigger ?? fallbackTrigger);
  }

  /** Recipient inbox: every pending copy addressed to this user, with Accept/Decline. */
  #openInboxPanel(root, trigger = null) {
    const panel = root.querySelector(".journalinator-transfer-inbox-panel");
    if (!panel) return;
    if (!game.users?.activeGM) return ui.notifications?.warn(t("JN.Private.NeedGM"));
    if (!panel.hidden) return this.#closeTransferPanels(root);
    const incoming = this.#pendingIncoming();
    const items = incoming.map(item => {
      const date = item.createdAt
        ? new Date(item.createdAt).toLocaleDateString(game.i18n?.lang || undefined)
        : "—";
      return `
        <article class="jn-transfer-item" data-transfer-id="${foundry.utils.escapeHTML(item.id)}">
          <div class="jn-transfer-from">${t("JN.Transfer.Incoming", {
            name: foundry.utils.escapeHTML(item.fromName)
          })}</div>
          <div class="jn-transfer-meta">${t("JN.Transfer.ItemMeta", {
            count: item.count, date: foundry.utils.escapeHTML(date)
          })}</div>
          ${item.titles.length ? `<div class="jn-transfer-titles">${
            item.titles.map(foundry.utils.escapeHTML).join(", ")
          }</div>` : ""}
          <div class="jn-transfer-item-actions">
            <button type="button" class="jn-transfer-decline" data-transfer-id="${foundry.utils.escapeHTML(item.id)}">${t("JN.Transfer.Decline")}</button>
            <button type="button" class="jn-transfer-accept" data-transfer-id="${foundry.utils.escapeHTML(item.id)}">${t("JN.Transfer.Accept")}</button>
          </div>
        </article>`;
    }).join("");
    panel.innerHTML = `
      <div class="jn-transfer-head">
        <h4 id="jn-transfer-inbox-title">${t("JN.Transfer.Inbox")}</h4>
        <button type="button" class="jn-transfer-close" aria-label="${t("JN.Common.Close")}">×</button>
      </div>
      <div class="jn-transfer-list">${items || `<p class="jn-transfer-empty">${t("JN.Transfer.InboxEmpty")}</p>`}</div>`;
    panel.querySelector(".jn-transfer-close")?.addEventListener("click", () => this.#closeTransferPanels(root));
    panel.querySelectorAll(".jn-transfer-accept, .jn-transfer-decline").forEach(button => {
      button.addEventListener("click", () => {
        const transferId = button.dataset.transferId;
        if (!transferId) return;
        // Pending stays visible until the GM acknowledges; no optimistic removal or notice.
        requestWrite({
          type: button.classList.contains("jn-transfer-accept")
            ? "acceptPrivateTransfer" : "declinePrivateTransfer",
          transferId
        });
      });
    });
    this.#showTransferPanel(panel, trigger ?? root.querySelector(".journalinator-private-inbox"));
  }

  #pinsEnabled() {
    try {
      return game.settings?.get?.("fvtt-journalinator", "pinsEnabled") !== false;
    } catch {
      return true;
    }
  }

  #matchesFilters(note) {
    return noteMatchesFilters(note, {
      layout: this.#layoutFilter,
      authorIds: this.#view === "private" ? null : this.#filterAuthors
    });
  }

  #activeNotes() {
    if (this.#view === "private") {
      const page = privateStore.findActive(game.user.id);
      if (!page) return [];
      try {
        return privateStore.noteViews(page);
      } catch (error) {
        if (error?.name !== "JN.Private.IncompatibleFormat") {
          console.error("Journalinator: private note read failed", error);
        }
        return [];
      }
    }
    return notesStore.getSchemaStatus().current ? notesStore.getAllNotes() : [];
  }

  async _prepareContext() {
    const view = this.#view;
    const isPrivate = view === "private";
    const privatePage = privateStore.findActive(game.user.id);
    const pendingPage = privateStore.findPending(game.user.id);
    let privateData = null;
    let privateIncompatible = false;
    if (isPrivate && privatePage) {
      try {
        privateData = privateStore.read(privatePage);
      } catch (error) {
        if (error?.name !== "JN.Private.IncompatibleFormat") {
          console.error("Journalinator: private workspace read failed", error);
        }
        privateIncompatible = true;
      }
    }
    const schemaStatus = isPrivate ? null : notesStore.getSchemaStatus();
    const incompatible = !isPrivate && isIncompatibleStatus(schemaStatus);
    let notes = [];
    if (isPrivate && privateData) {
      try {
        notes = privateStore.noteViews(privatePage, privateData);
      } catch (error) {
        if (error?.name !== "JN.Private.IncompatibleFormat") {
          console.error("Journalinator: private note read failed", error);
        }
        privateIncompatible = true;
      }
    } else if (!isPrivate && !incompatible) {
      notes = notesStore.getAllNotes();
    }
    const q = this.#query.trim().toLowerCase();
    const authors = isPrivate
      ? []
      : [...new Map(notes.map(n => [n.system.authorId, game.users.get(n.system.authorId)])).entries()]
        .filter(([, u]) => u);
    const themeChoice = game.settings.get("fvtt-journalinator", "boardTheme") ?? "stylized";
    const theme = await resolveThemeChoice(themeChoice);
    const gmOnline = !!game.users.activeGM;
    return {
      view,
      allNotes: notes,
      layout: isPrivate ? privateData?.layout ?? null : (incompatible ? null : notesStore.getLayout()),
      privatePage,
      pendingPage,
      privateData,
      privateIncompatible,
      privateName: privatePage?.name ?? pendingPage?.name ?? "",
      canManagePrivate: game.user.isGM,
      gmOnline,
      sharedWritable: !isPrivate && gmOnline && !incompatible,
      schemaStatus,
      incompatible,
      theme: theme.id,
      themeObj: theme,
      themeChoice,
      // The picker is a board *background* chooser: the original procedural cork plus the photo
      // boards. Older saved choices (classic, scene, ...) still render, they just aren't offered.
      themeList: BOARD_BACKGROUND_IDS
        .map(id => listThemes().find(item => item.id === id))
        .filter(Boolean)
        .map(item => ({
          id: item.id,
          label: item.nameKey ? t(item.nameKey) : (item.name || item.id)
        })),
      authors,
      query: q,
      // Toolbar badges only report recoverable notes; they float inside the button and never
      // reserve canvas space.
      trashCount: isPrivate
        ? (privateData?.trash?.length ?? 0)
        : notesStore.getTrashedNotes().length
    };
  }

  async _renderHTML(context) {
    const root = document.createElement("div");
    const privateView = context.view === "private";
    root.className = `journalinator-root${privateView ? " jn-private-view" : ""}`;
    applyTheme(root, context.themeObj);
    // Announce only real changes: a re-render of the same theme (including the cached scene
    // theme) must not spam the hook, but a scene palette regeneration must.
    if (themeApplicationChanged(this.#lastAppliedTheme, context.themeObj)) {
      this.#lastAppliedTheme = { id: context.themeObj.id, theme: context.themeObj };
      Hooks.callAll("journalinatorThemeChanged", context.themeObj.id, context.themeObj);
    }
    const escape = foundry.utils.escapeHTML;
    const offline = !context.gmOnline;
    const privatePage = context.privatePage;
    const incomingCount = privateView ? this.#pendingIncoming().length : 0;
    const trashLabel = t("JN.TopBar.Trash");
    const filters = (items, selected, kind) => items.map(([id, label, color]) =>
      `<label class="jn-menu-option"><input type="checkbox" data-kind="${kind}" value="${escape(id)}"
        ${selected.has(id) ? "checked" : ""}>${color ? `<span class="jn-dot" style="background:${escape(String(color))}"></span>` : ""}
        <span>${escape(label)}</span></label>`).join("");
    const layoutFilters = () => [
      ["", "JN.Filter.All"],
      ...NOTE_LAYOUT_FILTERS
    ].map(([id, labelKey]) => `<label class="jn-menu-option"><input type="radio"
      name="jn-layout-filter" data-kind="layout" value="${escape(id)}"
      ${(this.#layoutFilter ?? "") === id ? "checked" : ""}><span>${escape(t(labelKey))}</span></label>`).join("");
    // Board background picker. A saved choice that is not offered (an old theme id) is shown as
    // the original cork, because that is what it renders with.
    const backgroundLabel = t("JN.Theme.Picker");
    const activeBackground = context.themeList.some(item => item.id === context.themeChoice)
      ? context.themeChoice : "stylized";
    const themePicker = `<details class="jn-toolbar-dropdown journalinator-theme" aria-label="${escape(backgroundLabel)}">
      <summary class="jn-toolbar-icon" ${tooltipAttrs(backgroundLabel)}><i class="fa-solid fa-palette" aria-hidden="true"></i></summary>
      <div class="jn-toolbar-panel">
        ${context.themeList.map(item => `<button type="button" class="jn-theme-option${activeBackground === item.id ? " on" : ""}"
          data-theme-id="${escape(item.id)}" aria-pressed="${activeBackground === item.id}">${escape(item.label)}</button>`).join("")}
      </div>
    </details>`;
    const sharedToolbar = `
      <div class="jn-toolbar-group">
        ${toolbarButton("journalinator-new", "fa-note-sticky", t("JN.TopBar.NewNote"), offline)}
        ${toolbarButton("journalinator-add-label", "fa-font", t("JN.TopBar.AddLabel"), offline)}
        ${toolbarButton("journalinator-add-pin", "fa-thumbtack", t("JN.Pin.Tool"), offline, null, this.#canvas.pinTool)}
      </div>
      <div class="jn-toolbar-group">
        <details class="jn-toolbar-dropdown journalinator-filters${this.#filterAuthors.size || this.#layoutFilter ? " on" : ""}">
          <summary class="jn-toolbar-icon" ${tooltipAttrs(t("JN.Filter.Title"))}><i class="fa-solid fa-filter" aria-hidden="true"></i></summary>
          <div class="jn-toolbar-panel">
            ${context.authors.length ? `<div class="jn-menu-heading">${t("JN.Filter.Authors")}</div>
              ${filters(context.authors.map(([id, u]) => [id, u.name, u.color]), this.#filterAuthors, "author")}` : ""}
            <div class="jn-menu-heading">${t("JN.Filter.Layouts")}</div>
            ${layoutFilters()}
          </div>
        </details>
        ${themePicker}
      </div>
      <div class="jn-toolbar-group">
        ${toolbarButton("journalinator-trash", "fa-trash", trashLabel)}
        ${toolbarButton("journalinator-shared-send", "fa-paper-plane", t("JN.Transfer.SelectNotes"), true)}
        ${toolbarButton("journalinator-fit", "fa-expand", t("JN.TopBar.FitAll"))}
      </div>`;
    const incomingLabel = incomingCount
      ? t("JN.Transfer.InboxCount", { count: incomingCount }) : t("JN.Transfer.Inbox");
    const inboxButton = `<button type="button" class="jn-toolbar-icon journalinator-private-inbox${offline ? " disabled" : ""}"
      aria-expanded="false"${offline ? " disabled" : ""} ${tooltipAttrs(incomingLabel)}>
      <i class="fa-solid fa-inbox" aria-hidden="true"></i>
      ${incomingCount ? `<span class="jn-transfer-badge" aria-hidden="true">${incomingCount}</span>` : ""}
    </button>`;
    const privateToolbar = `
      <div class="jn-toolbar-group">
        ${privatePage ? toolbarButton("journalinator-private-new", "fa-note-sticky", t("JN.TopBar.NewNote")) : ""}
        ${privatePage ? toolbarButton("journalinator-private-add-label", "fa-font", t("JN.TopBar.AddLabel")) : ""}
        ${privatePage ? toolbarButton("journalinator-private-add-pin", "fa-thumbtack", t("JN.Pin.Tool"), false, null, this.#private.canvas.pinTool) : ""}
      </div>
      <div class="jn-toolbar-group">
        <details class="jn-toolbar-dropdown journalinator-filters${this.#layoutFilter ? " on" : ""}">
          <summary class="jn-toolbar-icon" ${tooltipAttrs(t("JN.Filter.Title"))}><i class="fa-solid fa-filter" aria-hidden="true"></i></summary>
          <div class="jn-toolbar-panel">
            <div class="jn-menu-heading">${t("JN.Filter.Layouts")}</div>
            ${layoutFilters()}
          </div>
        </details>
        ${themePicker}
      </div>
      <div class="jn-toolbar-group">
        ${privatePage ? toolbarButton("journalinator-trash", "fa-trash", trashLabel) : ""}
        ${privatePage ? toolbarButton("journalinator-private-send", "fa-paper-plane", t("JN.Transfer.SelectNotes"), true) : ""}
        ${privatePage ? toolbarButton("journalinator-private-fit", "fa-expand", t("JN.TopBar.FitAll")) : ""}
        ${inboxButton}
        ${context.canManagePrivate ? `<button type="button" class="jn-toolbar-icon journalinator-private-admin"
          ${tooltipAttrs(t("JN.Private.AdminTitle"))}><i class="fa-solid fa-user-shield" aria-hidden="true"></i></button>` : ""}
      </div>`;
    const viewLabel = privateView ? t("JN.Private.PrivateCanvas") : t("JN.Private.MainCanvas");
    const viewSwitch = `<details class="jn-view-menu jn-toolbar-dropdown" aria-label="${t("JN.Private.ViewSwitch")}">
          <summary class="jn-view-switch" ${tooltipAttrs(t("JN.Private.ViewSwitch"))}>${viewLabel}<i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary>
          <div class="jn-view-panel">
            <button type="button" class="jn-view-option${privateView ? "" : " on"}" data-view="shared">${t("JN.Private.MainCanvas")}</button>
            <div class="jn-view-private-row">
              <button type="button" class="jn-view-option${privateView ? " on" : ""}" data-view="private">${t("JN.Private.PrivateCanvas")}</button>
              ${privatePage ? `<button type="button" class="jn-view-rename" title="${t("JN.Private.RenameWorkspace")}"
                aria-label="${t("JN.Private.RenameWorkspace")}"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>` : ""}
            </div>
          </div>
        </details>`;
    const userBadge = `<b class="jn-current-user"><span class="jn-dot" style="background:${escape(String(game.user.color ?? "#8d8d97"))}"></span>${escape(game.user.name)}</b>`;

    if (!privateView && context.incompatible) {
      root.innerHTML = `
        <header class="journalinator-topbar">
          ${userBadge}
          ${viewSwitch}
        </header>
        <div class="journalinator-body jn-format-notice-body">${incompatibleNoticeHTML(t)}</div>`;
      return root;
    }
    if (privateView && context.privatePage && context.privateIncompatible) {
      root.innerHTML = `
        <header class="journalinator-topbar">
          ${userBadge}
          ${viewSwitch}
          ${context.canManagePrivate ? `<button type="button" class="jn-toolbar-icon journalinator-private-admin"
            ${tooltipAttrs(t("JN.Private.AdminTitle"))}><i class="fa-solid fa-user-shield" aria-hidden="true"></i></button>` : ""}
        </header>
        <div class="journalinator-body jn-format-notice-body">${privateIncompatibleNoticeHTML(t)}</div>`;
      return root;
    }

    root.innerHTML = `
      <header class="journalinator-topbar">
        ${userBadge}
        ${viewSwitch}
        <div class="journalinator-search-wrap">
          <input type="text" inputmode="search" autocomplete="off" class="journalinator-search"
            aria-label="${t(privateView ? "JN.Private.Search" : "JN.TopBar.Search")}"
            placeholder="${t(privateView ? "JN.Private.Search" : "JN.TopBar.Search")}" value="${foundry.utils.escapeHTML(this.#query)}">
          <div class="jn-switcher"></div>
        </div>
        <span class="jn-filter-indicator" role="status" aria-live="polite" hidden></span>
        <div class="jn-toolbar-tools">
          ${privateView ? privateToolbar : sharedToolbar}
        </div>
      </header>
      ${!privateView && !context.gmOnline ? noGmBannerHTML(t) : ""}
      ${privateView && incomingCount ? `<button type="button" class="jn-transfer-banner journalinator-transfer-banner${offline ? " disabled" : ""}"
        ${offline ? "disabled" : ""}>
        <i class="fa-solid fa-inbox" aria-hidden="true"></i>
        ${t("JN.Transfer.InboxBanner", { count: incomingCount })}
      </button>` : ""}
      ${privateView ? this.#privateBodyHTML(context) : `<div class="journalinator-body">
        <div class="journalinator-canvas-slot"></div>
      </div>`}
      <div class="jn-transfer-popover journalinator-transfer-send" role="dialog"
        aria-labelledby="jn-transfer-send-title" hidden></div>
      ${privateView ? `
        <div class="jn-transfer-popover journalinator-transfer-inbox-panel" role="dialog"
          aria-labelledby="jn-transfer-inbox-title" hidden></div>` : ""}
    `;

    this.#updateFilterIndicator(root);

    if (privateView) {
      if (privatePage && context.privateData && !context.privateIncompatible) {
        try {
          this.#private.setPage(privatePage);
          this.#private.canvas.setTheme(context.themeObj);
          this.#private.canvas.pinsEnabled = this.#pinsEnabled();
          this.#private.renderInto(
            root.querySelector(".journalinator-canvas-slot"),
            root.querySelector(".journalinator-editor")
          );
          this.#private.setDimMatch(note => this.#matchesQuery(note, context.query) && this.#matchesFilters(note));
          if (document.activeElement === this.#private.canvas.root) this.#focusedCanvasRenders.add(root);
        } catch (error) {
          if (error?.name !== "JN.Private.IncompatibleFormat") {
            console.error("Journalinator: private workspace render failed", error);
          }
        }
      }
      if (this.#switcherOpen) this.#renderSwitcher(root, context.allNotes);
      return root;
    }

    // Moving the canvas into the detached render result blurs it, even though we reuse the node.
    if (document.activeElement === this.#canvas.root) this.#focusedCanvasRenders.add(root);
    this.#canvas.readOnly = offline;
    this.#canvas.pinsEnabled = this.#pinsEnabled();
    this.#canvas.setTheme(context.themeObj);
    this.#canvas.mount(root.querySelector(".journalinator-canvas-slot"));
    this.#canvas.selectedNoteId = this.#selectedNoteId;
    this.#canvas.gmMode = false;
    this.#canvas.update(context.allNotes, context.layout, {
      deferGeometry: true,
      dimMatch: note => this.#matchesQuery(note, context.query) && this.#matchesFilters(note)
    });

    if (this.#switcherOpen) this.#renderSwitcher(root, context.allNotes);

    return root;
  }

  #privateBodyHTML(context) {
    if (context.privateIncompatible) {
      return `<div class="journalinator-body jn-format-notice-body">${
        privateIncompatibleNoticeHTML(t)
      }</div>`;
    }
    if (context.privatePage) {
      return `<div class="journalinator-body jn-private-body">
        <div class="journalinator-canvas-slot"></div>
        <aside class="journalinator-editor"></aside>
      </div>`;
    }
    if (context.pendingPage) {
      const disabled = context.gmOnline ? "" : " disabled";
      return `<div class="journalinator-body jn-private-gate-wrap">
        <div class="jn-private-gate">
          <h3>${t("JN.Private.PendingTitle")}</h3>
          <p>${t("JN.Private.PendingBody", { name: foundry.utils.escapeHTML(context.pendingPage.name) })}</p>
          <div class="jn-private-gate-actions">
            <button type="button" class="jn-private-accept"${disabled}>${t("JN.Private.Accept")}</button>
            <button type="button" class="jn-private-decline"${disabled}>${t("JN.Private.Decline")}</button>
          </div>
        </div>
      </div>`;
    }
    const disabled = context.gmOnline ? "" : " disabled";
    return `<div class="journalinator-body jn-private-gate-wrap">
      <div class="jn-private-gate">
        <h3>${t("JN.Private.NoWorkspaceTitle")}</h3>
        <p>${context.gmOnline ? t("JN.Private.NoWorkspaceBody") : t("JN.Private.NeedGM")}</p>
        <div class="jn-private-gate-actions">
          <button type="button" class="jn-private-create"${disabled}>${t("JN.Private.Create")}</button>
        </div>
      </div>
    </div>`;
  }

  _replaceHTML(result, content) {
    const oldSearch = content.querySelector(".journalinator-search");
    const restoreSearch = oldSearch && oldSearch === document.activeElement;
    // The canvas subtree survives a re-render (it is moved into the new root), but moving it
    // blurs the focused control. Capture a stable key from screen-space overlays first so a
    // popover field keeps focus across a write/render cycle.
    const active = content.ownerDocument?.activeElement ?? document.activeElement;
    const popoverFocusKey = active?.closest?.(".jn-floating-popover")
      ? active.dataset.jnFocusKey : null;
    const toolbarGroup = active?.closest?.(".jn-floating-toolbar")
      ? active.dataset.group : null;
    this.#replacingHTML = true;
    try {
      content.replaceChildren(result);
    } finally {
      this.#replacingHTML = false;
    }
    if (this.#view === "private" && this.#private.page) this.#private.canvas.refreshGeometry();
    else this.#canvas.refreshGeometry();
    if (restoreSearch) {
      const search = result.querySelector(".journalinator-search");
      search.focus({ preventScroll: true });
      search.setSelectionRange(oldSearch.selectionStart, oldSearch.selectionEnd, oldSearch.selectionDirection);
      return;
    }
    if (popoverFocusKey) {
      const field = result.querySelector(`[data-jn-focus-key="${CSS.escape(popoverFocusKey)}"]`);
      if (field?.isConnected) {
        field.focus({ preventScroll: true });
        return;
      }
    }
    if (toolbarGroup) {
      const button = result.querySelector(`.jn-floating-toolbar [data-group="${CSS.escape(toolbarGroup)}"]`);
      if (button?.isConnected) {
        button.focus({ preventScroll: true });
        return;
      }
    }
    const editorInput = result.querySelector(".jn-source-input, .jn-card-text-input, .jn-block-input");
    if (editorInput) editorInput.focus({ preventScroll: true });
    else if (this.#focusedCanvasRenders.has(result) && document.activeElement === document.body) {
      const canvasRoot = this.#view === "private" ? this.#private.canvas.root : this.#canvas.root;
      canvasRoot.focus({ preventScroll: true });
    }
  }

  _onRender() {
    const root = this.element;
    this.#normalizePinsOnce();
    // The window element survives re-renders, so install the delegated listener only once. It
    // queries live dropdown nodes instead of closing over the ones from a particular render.
    if (!this.#onToolbarPointerDown) {
      this.#onToolbarPointerDown = ev => {
        for (const dropdown of this.#toolbarPointerTarget?.querySelectorAll(".jn-toolbar-dropdown") ?? []) {
          if (!dropdown.contains(ev.target)) dropdown.open = false;
        }
      };
      this.#toolbarPointerTarget = root;
      root.addEventListener("pointerdown", this.#onToolbarPointerDown);
    }
    const dropdowns = [...root.querySelectorAll(".jn-toolbar-dropdown")];
    for (const dropdown of dropdowns) {
      dropdown.addEventListener("keydown", event => {
        if (event.key !== "Escape" || !dropdown.open) return;
        event.stopPropagation();
        dropdown.open = false;
        dropdown.querySelector("summary").focus();
      });
    }
    // Board background picker: store the choice per client and re-render with the new theme.
    root.querySelectorAll(".journalinator-theme [data-theme-id]").forEach(option => {
      option.addEventListener("click", async () => {
        const id = option.dataset.themeId;
        option.closest("details")?.removeAttribute("open");
        if (!BOARD_BACKGROUND_IDS.includes(id)) return;
        if (game.settings.get("fvtt-journalinator", "boardTheme") === id) return;
        await game.settings.set("fvtt-journalinator", "boardTheme", id);
        this.render();
      });
    });
    const search = root.querySelector(".journalinator-search");
    search?.addEventListener("input", ev => {
      this.#query = ev.target.value;
      this.#switcherOpen = true;
      this.#switcherHighlight = 0;
      this.#renderSwitcher(root, this.#activeNotes());
      this.#filterCanvasForSearch();
    });
    search?.addEventListener("focus", () => {
      this.#switcherOpen = true;
      this.#renderSwitcher(root, this.#activeNotes());
    });
    search?.addEventListener("blur", () => {
      if (this.#replacingHTML || !search.isConnected) return;
      this.#switcherOpen = false;
      root.querySelector(".jn-switcher").style.display = "none";
    });
    search?.addEventListener("keydown", ev => this.#onSearchKeydown(ev));

    root.querySelectorAll(".jn-view-option").forEach(option => {
      option.addEventListener("click", () => {
        const next = option.dataset.view === "private" ? "private" : "shared";
        option.closest("details")?.removeAttribute("open");
        if (next === this.#view) return;
        if (this.#view === "shared") this.#editor.suspend();
        else this.#private.editor.close();
        this.#view = next;
        this.#query = "";
        this.#switcherOpen = false;
        this.#switcherHighlight = 0;
        this.#filterAuthors.clear();
        this.#layoutFilter = null;
        this.#canvas.cancelLinkTool();
        this.#private.canvas.cancelLinkTool();
        this.#canvas.deactivatePinTool();
        this.#private.canvas.deactivatePinTool();
        this.render();
      });
    });

    root.querySelector(".journalinator-private-new")?.addEventListener("click", event => {
      this.#private.canvas.deactivatePinTool();
      const position = this.#private.canvas.newCardPosition();
      const rect = event.currentTarget.getBoundingClientRect?.();
      this.#private.openCreationMenuAt({
        ...position,
        clientX: rect?.left,
        clientY: rect?.bottom,
        anchor: event.currentTarget
      });
    });
    root.querySelector(".journalinator-private-add-label")?.addEventListener("click", () => {
      this.#private.canvas.deactivatePinTool();
      this.#private.canvas.addLabelButton();
    });
    root.querySelector(".journalinator-private-add-pin")?.addEventListener("click", () => {
      this.#private.canvas.togglePinTool();
    });

    root.querySelector(".journalinator-new")?.addEventListener("click", event => {
      this.#canvas.deactivatePinTool();
      const position = this.#canvas.newCardPosition(220, 120);
      const rect = event.currentTarget.getBoundingClientRect?.();
      this.#openCreationMenuAt(position.x, position.y, {
        clientX: rect?.left,
        clientY: rect?.bottom
      });
    });

    root.querySelector(".journalinator-add-label")?.addEventListener("click", () => {
      this.#canvas.deactivatePinTool();
      this.#canvas.addLabelButton();
    });
    root.querySelector(".journalinator-add-pin")?.addEventListener("click", () => this.#canvas.togglePinTool());

    root.querySelector(".journalinator-trash")?.addEventListener("click", () => {
      if (this.#view === "private") this.#private.openTrash();
      else this.#openTrash();
    });

    root.querySelector(".journalinator-private-admin")?.addEventListener("click", () => openPrivateAdmin());
    root.querySelector(".jn-view-rename")?.addEventListener("click", async event => {
      event.stopPropagation();
      event.currentTarget.closest("details")?.removeAttribute("open");
      const page = privateStore.findActive(game.user.id);
      if (!page) return;
      const name = await foundry.applications.api.DialogV2.prompt({
        window: { title: t("JN.Private.RenameWorkspace") },
        content: `<input type="text" name="value" autofocus value="${foundry.utils.escapeHTML(page.name)}" maxlength="100">`,
        ok: { label: t("JN.Common.Save"), callback: (event, button) => button.form.elements.value.value.trim() },
        rejectClose: false
      });
      if (!name) return;
      try { await privateStore.rename(page, name); this.render(); }
      catch (err) { ui.notifications?.warn(err.message); }
    });
    root.querySelector(".jn-private-create")?.addEventListener("click", () => {
      if (!game.users.activeGM) return ui.notifications?.warn(t("JN.Private.NeedGM"));
      requestWrite({ type: "privateCreate" });
    });
    root.querySelector(".jn-private-accept")?.addEventListener("click", () => {
      if (!game.users.activeGM) return ui.notifications?.warn(t("JN.Private.NeedGM"));
      requestWrite({ type: "privateAccept" });
    });
    root.querySelector(".jn-private-decline")?.addEventListener("click", () => {
      if (!game.users.activeGM) return ui.notifications?.warn(t("JN.Private.NeedGM"));
      requestWrite({ type: "privateDecline" });
    });

    root.querySelector(".journalinator-private-fit")?.addEventListener("click", () => {
      const ids = this.#private.getSelectedNoteIds();
      this.#private.canvas.fitNotes(ids.length ? ids : null);
      this.#syncSelectionControls();
    });
    root.querySelector(".journalinator-private-send")?.addEventListener("click", event => {
      this.#openSendPanel(root, event.currentTarget, null, "private");
    });
    root.querySelector(".journalinator-shared-send")?.addEventListener("click", event => {
      this.#openSendPanel(root, event.currentTarget, null, "shared");
    });
    root.querySelector(".journalinator-private-inbox")?.addEventListener("click", event => {
      this.#openInboxPanel(root, event.currentTarget);
    });
    root.querySelector(".journalinator-transfer-banner")?.addEventListener("click", event => {
      // Pass the banner itself as the trigger: the dismiss listener must recognise it as part of
      // the open panel, or pointerdown closes the panel and this click reopens it immediately.
      this.#openInboxPanel(root, event.currentTarget);
    });

    root.querySelector(".journalinator-fit")?.addEventListener("click", () => {
      const ids = this.#canvas.getSelectedNoteIds();
      this.#canvas.fitNotes(ids.length ? ids : null);
      this.#syncSelectionControls();
    });

    root.querySelectorAll("[data-notice-close]").forEach(button => {
      button.addEventListener("click", () => this.close?.());
    });

    root.querySelectorAll(".journalinator-filters input").forEach(input => {
      input.addEventListener("change", () => {
        if (input.dataset.kind === "layout") {
          this.#layoutFilter = input.value || null;
        } else {
          if (input.checked) this.#filterAuthors.add(input.value);
          else this.#filterAuthors.delete(input.value);
        }
        input.closest("details").classList.toggle("on",
          !!(this.#filterAuthors.size || this.#layoutFilter));
        this.#filterCanvasForSearch();
        if (this.#switcherOpen) this.#renderSwitcher(root, this.#activeNotes());
      });
    });
    this.#syncSelectionControls();
    this.#updateFilterIndicator(root);
  }

  #switcherList(allNotes) {
    const q = this.#query.trim().toLowerCase();
    const matching = allNotes.filter(n => this.#matchesQuery(n, q) && this.#matchesFilters(n));
    if (!q) return matching.slice().sort((a, b) => (b.system.updatedAt ?? 0) - (a.system.updatedAt ?? 0)).slice(0, 6);
    return matching;
  }

  #filterCanvasForSearch() {
    const q = this.#query.trim().toLowerCase();
    const match = note => this.#matchesQuery(note, q) && this.#matchesFilters(note);
    if (this.#view === "private") this.#private.setDimMatch(match);
    else this.#canvas.setDimMatch(match);
    this.#updateFilterIndicator();
  }

  /**
   * Small, non-interactive search/filter status in the top bar. Dimmed cards can look like
   * missing notes; this says how many live notes are hidden and disappears when no filter is on.
   */
  #updateFilterIndicator(root = this.element) {
    const indicator = root?.querySelector?.(".jn-filter-indicator");
    if (!indicator) return;
    const active = !!this.#query.trim() || this.#layoutFilter !== null || this.#filterAuthors.size > 0;
    if (!active) {
      indicator.hidden = true;
      indicator.textContent = "";
      delete indicator.dataset.hiddenCount;
      indicator.removeAttribute("title");
      return;
    }
    const q = this.#query.trim().toLowerCase();
    const allNotes = this.#activeNotes();
    const visible = allNotes.filter(note => this.#matchesQuery(note, q) && this.#matchesFilters(note)).length;
    const hidden = Math.max(0, allNotes.length - visible);
    indicator.hidden = false;
    indicator.dataset.hiddenCount = String(hidden);
    indicator.textContent = hidden > 0
      ? t("JN.Filter.HiddenCount", { count: hidden })
      : t("JN.Filter.Active");
    indicator.title = t("JN.Filter.IndicatorHint");
  }

  #canQuickCreate() {
    return this.#view === "private"
      ? !!privateStore.findActive(game.user.id)
      : this.#sharedWritable();
  }

  #renderSwitcher(root, allNotes) {
    const q = this.#query.trim();
    const list = this.#switcherList(allNotes);
    const offerCreate = this.#canQuickCreate();
    const count = list.length + (offerCreate ? 1 : 0);
    this.#switcherHighlight = Math.max(0, Math.min(this.#switcherHighlight, Math.max(0, count - 1)));
    const escape = foundry.utils.escapeHTML;
    const dateText = value => Number.isFinite(value) && value > 0
      ? new Date(value).toLocaleDateString(game.i18n?.lang || undefined)
      : "";

    const el = root.querySelector(".jn-switcher");
    el.innerHTML = (q ? "" : `<div class="jn-switcher-heading">${t("JN.Switcher.Recent")}</div>`) +
      list.map((n, i) => {
        const label = noteSearchLabel(n);
        const excerpt = noteSecondaryExcerpt(n);
        const author = game.users.get(n.system.authorId)?.name ?? "";
        const date = dateText(n.system.updatedAt || n.system.createdAt);
        const meta = [excerpt, author, date].filter(Boolean).join(" · ");
        return `
        <div class="jn-switcher-item${i === this.#switcherHighlight ? " hi" : ""}" data-id="${escape(n._id)}">
          <span class="jn-dot" style="background:${escape(game.users.get(n.system.authorId)?.color ?? "#8d8d97")}"></span>
          <b>${escape(label)}</b>
          ${meta ? `<small>${escape(meta)}</small>` : ""}
        </div>`;
      }).join("") +
      (offerCreate ? `<div class="jn-switcher-item jn-switcher-create${list.length === this.#switcherHighlight ? " hi" : ""}" data-create="1">${
        q
          ? t("JN.Switcher.Create", { title: escape(q) })
          : t("JN.Switcher.CreateBlank")
      }</div>` : "");
    el.style.display = "block";

    el.querySelectorAll(".jn-switcher-item").forEach(item => {
      item.addEventListener("mousedown", ev => {
        ev.preventDefault(); // keep focus on the input through the click
        if (item.dataset.create) this.#createFromSwitcher(q);
        else this.#selectFromSwitcher(item.dataset.id);
      });
    });
  }

  #selectFromSwitcher(noteId) {
    this.#clearSearch();
    if (this.#view === "private") this.#private.focusNote(noteId);
    else this.#canvas.focusNote(noteId);
  }

  async #createFromSwitcher(title) {
    const query = String(title ?? "").trim();
    if (this.#view === "private") {
      this.#clearSearch();
      await this.#private.createFromQuery(query, { ...this.#private.canvas.newCardPosition() });
      return;
    }
    if (!this.#sharedWritable()) {
      if (!game.users?.activeGM) ui.notifications?.warn(t("JN.Notices.NoGM"));
      else this.#warnIncompatible();
      return;
    }
    const position = this.#canvas.newCardPosition();
    this.#clearSearch();
    const result = await createSharedNoteFromQuery({
      query,
      x: position.x,
      y: position.y,
      clientSessionId,
      requestEditReply,
      onCreated: created => this.#onNoteCreated(created)
    });
    if (!result.ok) ui.notifications?.warn(t("JN.Creation.Failed"));
  }

  #clearSearch() {
    this.#query = "";
    this.#switcherOpen = false;
    const search = this.element.querySelector(".journalinator-search");
    search.value = "";
    search.blur();
    this.element.querySelector(".jn-switcher").style.display = "none";
    this.#filterCanvasForSearch();
  }

  #onSearchKeydown(ev) {
    if (!this.#switcherOpen || ev.isComposing) return;
    const allNotes = this.#activeNotes();
    const list = this.#switcherList(allNotes);
    const q = this.#query.trim();
    const offerCreate = this.#canQuickCreate();
    const count = list.length + (offerCreate ? 1 : 0);

    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!count) return;
      const dir = ev.key === "ArrowDown" ? 1 : -1;
      this.#switcherHighlight = (this.#switcherHighlight + dir + count) % count;
      this.#renderSwitcher(this.element, allNotes);
      this.element.querySelector(".jn-switcher-item.hi")?.scrollIntoView?.({ block: "nearest" });
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (this.#switcherHighlight < list.length) this.#selectFromSwitcher(list[this.#switcherHighlight]._id);
      else if (offerCreate) this.#createFromSwitcher(q);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      this.#clearSearch();
    }
  }

  async #openTrash() {
    const offline = !game.users.activeGM || !notesStore.getSchemaStatus().current;
    const trashed = notesStore.getTrashedNotes();
    const esc = foundry.utils.escapeHTML;
    const rows = trashed
      .map(n => {
        const row = trashRowModel(n, { t, users: game.users });
        return `<div class="jn-trash-row">
          <span class="jn-trash-title">${esc(row.label)}</span>
          ${row.excerpt ? `<span class="jn-trash-excerpt">${esc(row.excerpt)}</span>` : ""}
          <span class="jn-trash-meta">${esc(row.metadata)}</span>
          <button type="button" class="jn-trash-restore" data-id="${esc(n._id)}"${offline ? " disabled" : ""}>${t("JN.Common.Restore")}</button>
        </div>`;
      })
      .join("") || `<p class="journalinator-empty">${t("JN.Trash.Empty")}</p>`;

    await foundry.applications.api.DialogV2.wait({
      window: { title: t("JN.Trash.Title") },
      content: (trashed.length ? `<p class="jn-trash-hint">${t("JN.Trash.RecoverableHint")}</p>` : "")
        + `<div class="jn-trash-list">${rows}</div>` +
        (game.user.isGM && trashed.length ? `<button type="button" class="jn-trash-empty"${offline ? " disabled" : ""}>${t("JN.Trash.EmptyButton")}</button>` : ""),
      buttons: [{ action: "close", label: t("JN.Common.Close"), default: true }],
      rejectClose: false,
      render: (event, dialog) => {
        dialog.element.querySelectorAll(".jn-trash-restore").forEach(btn => {
          btn.addEventListener("click", () => {
            requestWrite({ type: "restoreNote", noteId: btn.dataset.id });
            dialog.close();
          });
        });
        dialog.element.querySelector(".jn-trash-empty")?.addEventListener("click", async () => {
          const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: t("JN.Trash.EmptyConfirmTitle") },
            content: `<p>${t("JN.Trash.EmptyConfirm")}</p>`
          });
          if (confirmed) requestWrite({ type: "emptyTrash" });
          dialog.close();
        });
      }
    });
  }

  async #promptText(title, initial) {
    return foundry.applications.api.DialogV2.prompt({
      window: { title },
      content: `<input type="text" name="value" autofocus value="${foundry.utils.escapeHTML(initial)}">`,
      render: (_event, dialog) => {
        const input = dialog.element.querySelector('input[name="value"]');
        input?.focus();
        input?.select();
      },
      ok: {
        label: t("JN.Common.OK"),
        callback: (event, button) => button.form.elements.value.value.trim()
      },
      rejectClose: false
    });
  }
}
