import { notesStore } from "../store/notes-store.mjs";
import { requestWrite } from "../socket.mjs";
import JournalCanvas from "./canvas.mjs";
import NoteEditor from "./editor.mjs";
import PrivateWorkspace from "./private-workspace.mjs";
import { openPrivateAdmin } from "./private-admin.mjs";
import { privateStore } from "../store/private-store.mjs";
import { countSharedTransferDrops, countTransferDrops } from "../private-transfer.mjs";
import { defaultNoteTitle, noteCreationPresentation, noteCreationStyle, promptNewNote } from "./note-dialog.mjs";
import { noteFilterKey, noteMatchesQuery, notePresentationLabelKey, noteSearchLabel } from "./note-search.mjs";
import { computeJournalStats, deriveSessions, selectLiveSharedNotes } from "../stats.mjs";
import { CARD_STYLES, cardStyleKey } from "../styles/registry.mjs";
import { defaultControlTarget } from "./scene-control.mjs";
import { BOARD_BACKGROUND_IDS, applyTheme, getTheme, listThemes } from "../styles/themes.mjs";
import { SCENE_THEME_ID, clearSceneThemeCache, sceneTheme } from "../scene-palette.mjs";
import { canUseGmTier } from "../secrets/access.mjs";
import { vaultStore } from "../secrets/vault-store.mjs";
import { openVaultDialog } from "../secrets/vault-ui.mjs";
import * as secrets from "../secrets/secret-actions.mjs";
import { t } from "../i18n.mjs";
import { stripSecretPrefix } from "../secrets/model.mjs";
import { NOTE_FONT_KEYS, PICTURE_LAYOUTS, PIN_STYLES, PRESENTATION_STYLES, resolvePresentation } from "../presentation.mjs";

/** Runs a GM vault action and surfaces failures (e.g. the vault was locked meanwhile). */
function gm(job) {
  return Promise.resolve().then(job).catch(err => {
    console.error(err);
    ui.notifications.error(err.message);
  });
}

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

/** Filter keys are presentation semantics, not legacy style storage keys. */
const NOTE_FILTERS = Object.freeze([
  ["memo", "JN.Style.Memo"],
  ["document", "JN.Style.Document"],
  ["target", "JN.Style.Target"],
  ["location", "JN.Kind.Location"]
]);

/**
 * Fullscreen app: a top bar (title, quick switcher, + New Note, + Label, Trash, Stats, preview
 * toggle and filters), the note canvas taking the center, and an editor panel on the
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
  #filterStyles = new Set();
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
  #deleteConfirmPending = false;
  #replacingHTML = false;
  #editor = new NoteEditor({
    boardOnly: true,
    onEditHiddenBlock: async (id, blockId) => {
      await this.render();
      const slot = this.#canvas.cardEls.get(id)?.querySelector(`.jn-card-block[data-block-id="${CSS.escape(blockId)}"]`);
      if (slot && this.#selectedNoteId === id) this.#editor.editBoardBlock(id, blockId, slot);
    },
    onFocusNote: id => this.#canvas.focusNote(id),
    onSelectNote: id => { this.#selectedNoteId = id; this.#editor.open(id); this.#editor.render(); },
    onSetMainPinEnabled: (id, enabled) => this.#setMainPinEnabled(id, enabled),
    onStamp: (id, trigger) => this.#canvas.openStampPicker(id, trigger),
    onSend: id => this.#openSendPanel(this.element, null, id, "shared")
  });
  // Every canvas action is routed by what it touches: GM-only things go to the vault in this
  // client, everything else is a normal shared write request (spec §14).
  #canvas = new JournalCanvas({
    onSelectNote: id => {
      this.#selectedNoteId = id;
      this.#editor.open(id);
      this.#editor.render();
      this.#syncSelectionControls();
    },
    onReadCardText: (id, kind) => {
      const note = notesStore.getNote(id);
      if (!note) return "";
      if (kind === "heading") return resolvePresentation(note).heading;
      if (kind === "label") return note.system.label ?? "";
      return note.secret ? stripSecretPrefix(note.name) : note.name;
    },
    onSaveCardText: (id, kind, value) => {
      if (kind === "heading") return this.#editor.setTargetHeading(id, value);
      if (kind === "label") return this.#editor.setNoteLabel(id, value);
      return this.#editor.renameNote(id, value);
    },
    onEditCardBlock: (id, blockId, slot) => {
      this.#editor.editBoardBlock(id, blockId, slot);
    },
    onToggleTask: (id, blockId, index) => this.#editor.toggleTask(id, blockId, index),
    onEditCardImage: id => this.#editor.editNoteImage(id),
    onEditCardBackground: id => this.#editor.editNoteImage(id, true),
    onEditNote: async id => {
      this.#selectedNoteId = id;
      await this.render();
      const slot = this.#canvas.cardEls.get(id)?.querySelector(".jn-card-block");
      if (slot && this.#selectedNoteId === id) this.#editor.editFirstBlock(id, slot);
    },
    onCreateNoteAt: (x, y, options) => this.#createNoteAt({ ...options, x, y, immediate: true }),
    onPinToolChange: active => {
      const button = this.element?.querySelector(".journalinator-add-pin");
      button?.classList.toggle("on", active);
      button?.setAttribute("aria-pressed", String(active));
    },
    onMoveCard: (noteId, x, y) => notesStore.isSecretNote(noteId)
      ? gm(() => secrets.moveSecretCard(noteId, x, y))
      : requestWrite({ type: "moveCard", noteId, x, y }),
    onResizeCard: (noteId, width, height) => notesStore.isSecretNote(noteId)
      ? gm(() => secrets.resizeSecretCard(noteId, width, height))
      : requestWrite({ type: "resizeCard", noteId, width, height }),
    onResetCardSize: noteId => notesStore.isSecretNote(noteId)
      ? gm(() => secrets.resizeSecretCard(noteId, null, null))
      : requestWrite({ type: "resizeCard", noteId, width: null, height: null }),
    onAddLabelAt: (x, y) => requestWrite({ type: "addLabel", text: t("JN.Label.Default"), x, y }),
    onRemoveLabel: labelId => this.#removeLabel(labelId),
    onAttachStamp: (noteId, stamp, color, corner) => notesStore.isSecretNote(noteId)
      ? gm(() => secrets.addSecretStamp(noteId, stamp, color, corner))
      : requestWrite({ type: "addLabel", noteId, stamp, color, corner }),
    onStampCorner: (labelId, corner) => notesStore.isHiddenLabel(labelId)
      ? gm(() => secrets.updateHiddenLabel(labelId, { corner }))
      : requestWrite({ type: "updateLabel", labelId, corner }),
    onStampColor: (labelId, color) => notesStore.isHiddenLabel(labelId)
      ? gm(() => secrets.updateHiddenLabel(labelId, { color }))
      : requestWrite({ type: "updateLabel", labelId, color }),
    onAddGmLabelAt: (x, y) => gm(() => secrets.addHiddenLabel(x, y)),
    onMoveLabel: (labelId, x, y) => notesStore.isHiddenLabel(labelId)
      ? gm(() => secrets.updateHiddenLabel(labelId, { x, y }))
      : requestWrite({ type: "updateLabel", labelId, x, y }),
    onEditLabel: async labelId => {
      if (notesStore.isHiddenLabel(labelId)) return this.#editHiddenLabel(labelId);
      const layout = notesStore.getLayout();
      const current = layout?.labels?.[labelId]?.text ?? "";
      const text = await this.#promptText(t("JN.Prompt.EditLabel"), current);
      if (text === null) return;
      if (text.trim() === "") requestWrite({ type: "removeLabel", labelId });
      else requestWrite({ type: "updateLabel", labelId, text });
    },
    onCreateLink: async (sourceId, targetId, ports) => {
      if (notesStore.isSecretNote(sourceId) || notesStore.isSecretNote(targetId)) {
        await gm(() => secrets.addHiddenLink(sourceId, targetId, ports));
      } else {
        await requestWrite({ type: "createLink", sourceId, targetId, ...ports });
      }
      // A new dot writes the layout and then the note link. Foundry can coalesce those document
      // hooks into a render between writes. Refresh the retained canvas from the final documents.
      if (game.users.activeGM?.id === game.user.id && this.#view === "shared"
          && this.#canvas.root.isConnected) {
        this.#canvas.update(notesStore.getAllNotes(), notesStore.getLayout());
      }
    },
    onUpdateLink: (noteId, linkId, fields) => notesStore.isHiddenLink(noteId, linkId)
      ? gm(() => secrets.updateHiddenLink(noteId, linkId, fields))
      : requestWrite({ type: "updateLink", noteId, linkId, fields }),
    // Floating-toolbar cosmetic batches. Presentation changes never touch label/content/images;
    // attachment batches are restricted to the cosmetic pin appearance (never pin enable/radius).
    onSetPresentation: (ids, fields) => this.#setNotePresentation(ids, fields),
    onSetAttachment: (ids, fields) => this.#setNoteAttachment(ids, fields),
    onDeleteLink: (noteId, linkId) => notesStore.isHiddenLink(noteId, linkId)
      ? gm(() => secrets.deleteHiddenLink(noteId, linkId))
      : requestWrite({ type: "deleteLink", noteId, linkId }),
    onAddCardAnchor: (noteId, anchor) => this.#addCardAnchor(noteId, anchor),
    onMoveCardAnchor: (noteId, anchorId, x, y) => this.#moveCardAnchor(noteId, anchorId, x, y),
    onRemoveCardAnchor: (noteId, anchorId) => this.#removeCardAnchor(noteId, anchorId),
    onBoardPinAction: action => requestWrite({ type: "boardPinAction", action }),
    // Route A keeps the original link and appends a main-pin waypoint; Route B is an atomic
    // split whose undo id becomes usable only after the GM's writeApplied acknowledgement.
    onRouteNoteOnLink: (sourceId, linkId, noteId, mode, index, undoId) =>
      requestWrite({ type: "routeNoteOnLink", sourceId, linkId, noteId, mode, index, undoId }),
    onDetachRouteNote: (sourceId, linkId, noteId, undoId) =>
      requestWrite({ type: "detachRouteNote", sourceId, linkId, noteId, undoId }),
    onClearThreadPins: (noteId, linkId) =>
      requestWrite({ type: "clearThreadPins", noteId, linkId }),
    onHideLink: (noteId, linkId) => gm(() => secrets.hideSharedLink(noteId, linkId)),
    onRevealLink: (noteId, linkId) => gm(() => secrets.revealLink(noteId, linkId)),
    onToggleLinkHint: (noteId, linkId, hint) => requestWrite({ type: "gmSetLinkHint", noteId, linkId, hint }),
  });

  #private = new PrivateWorkspace({
    onChange: () => this.render(),
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

  #removeLabel(labelId) {
    if (notesStore.isHiddenLabel(labelId)) return gm(() => secrets.removeHiddenLabel(labelId));
    return requestWrite({ type: "removeLabel", labelId });
  }

  #warnBatch(key) {
    ui.notifications?.warn(t(key));
  }

  /**
   * Resolve every requested cosmetic target before deciding where the batch goes. A stale/
   * trashed id, a mixed shared + GM-only selection, or several GM-only notes is refused as a
   * whole so the batch can never apply to a silent subset.
   */
  #resolveCosmeticBatch(ids) {
    const shared = [];
    const secret = [];
    const seen = new Set();
    for (const id of ids) {
      if (typeof id !== "string" || !id || seen.has(id)) return { error: "stale" };
      seen.add(id);
      if (notesStore.isSecretNote(id)) {
        secret.push(id);
        continue;
      }
      const page = notesStore.getSharedPage(id);
      if (!page || page.system.deleted) return { error: "stale" };
      shared.push(id);
    }
    if (shared.length && secret.length) return { error: "mixed" };
    if (secret.length > 1) return { error: "manySecrets" };
    return { shared, secret };
  }

  #batchErrorKey(error) {
    if (error === "mixed") return "JN.Toolbar.BatchMixed";
    if (error === "manySecrets") return "JN.Toolbar.BatchManySecrets";
    return "JN.Toolbar.BatchStale";
  }

  /**
   * Cosmetic presentation batch for the floating toolbar. Shared notes go through the validated
   * batch socket request; a GM-only note stays on the vault path. Mixing tiers is refused rather
   * than silently writing one side. Labels, blocks, images and link topology are never included.
   */
  #setNotePresentation(ids, fields) {
    if (!Array.isArray(ids) || !ids.length || !fields || typeof fields !== "object") return;
    if (this.#canvas.readOnly) return;
    const batch = this.#resolveCosmeticBatch(ids);
    if (batch.error) return this.#warnBatch(this.#batchErrorKey(batch.error));
    const clean = {};
    if (PRESENTATION_STYLES.includes(fields.extendedStyle)) clean.extendedStyle = fields.extendedStyle;
    if (NOTE_FONT_KEYS.includes(fields.font)) clean.font = fields.font;
    if (PICTURE_LAYOUTS.includes(fields.pictureLayout)) clean.pictureLayout = fields.pictureLayout;
    if (typeof fields.torn === "boolean") clean.torn = fields.torn;
    // Force-extended is a single-note control; never let a batch widen the set unexpectedly.
    if (typeof fields.forceExtended === "boolean") {
      if (ids.length !== 1) return this.#warnBatch("JN.Toolbar.BatchSingle");
      clean.forceExtended = fields.forceExtended;
    }
    if (!Object.keys(clean).length) return;
    if (batch.secret.length) {
      return gm(() => secrets.setSecretNotePresentation(batch.secret[0], clean));
    }
    return requestWrite({ type: "setNotePresentation", noteIds: batch.shared, fields: clean });
  }

  /**
   * Cosmetic attachment batch. The generic attachment socket request deliberately rejects
   * `mainPinEnabled`, and the toolbar only ever offers pin appearance for a selection, so snap
   * radii, pin enable/disable and redistribution stay out of bulk edits.
   */
  #setNoteAttachment(ids, fields) {
    if (!Array.isArray(ids) || !ids.length || !fields || typeof fields !== "object") return;
    if (this.#canvas.readOnly) return;
    if (!PIN_STYLES.includes(fields.pinStyle)) return;
    const batch = this.#resolveCosmeticBatch(ids);
    if (batch.error) return this.#warnBatch(this.#batchErrorKey(batch.error));
    const clean = { pinStyle: fields.pinStyle };
    if (batch.secret.length) {
      return gm(() => secrets.setSecretNoteAttachment(batch.secret[0], clean));
    }
    return requestWrite({ type: "setNoteAttachment", noteIds: batch.shared, fields: clean });
  }

  /** Main-pin removal is undoable; enabling only reveals the pin again. */
  #setMainPinEnabled(noteId, enabled) {
    if (typeof enabled !== "boolean") return;
    // Projection uses the real measured card size, which is more accurate than stored geometry
    // for auto-sized cards. Only w/h are sent; the server keeps x/y/rotation authoritative.
    const measured = this.#canvas.cardBox(noteId);
    const box = measured ? { w: measured.w, h: measured.h } : undefined;
    if (!enabled) {
      const undoId = foundry.utils.randomID();
      // The active GM acknowledges the successful write; only then does it become an undo step.
      // A rejected/failed request must not consume Ctrl+Z.
      return requestWrite({ type: "setMainPinEnabled", noteId, enabled: false, undoId, box });
    }
    return requestWrite({ type: "setMainPinEnabled", noteId, enabled: true, box });
  }

  /**
   * Secret helpers may not expose card-anchor writes; skip rather than falling back to a shared
   * request that cannot resolve a vault note. Normal shared notes use the GM-mediated handlers.
   */
  #addCardAnchor(noteId, anchor) {
    if (!anchor || anchor.kind !== "minor"
        || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return;
    if (notesStore.isSecretNote(noteId)) {
      return typeof secrets.addSecretCardAnchor === "function"
        ? gm(() => secrets.addSecretCardAnchor(noteId, anchor)) : undefined;
    }
    return requestWrite({
      type: "addCardAnchor", noteId, kind: "minor", x: anchor.x, y: anchor.y
    });
  }

  #moveCardAnchor(noteId, anchorId, x, y) {
    if (typeof anchorId !== "string" || !anchorId
        || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (notesStore.isSecretNote(noteId)) {
      return typeof secrets.moveSecretCardAnchor === "function"
        ? gm(() => secrets.moveSecretCardAnchor(noteId, anchorId, x, y)) : undefined;
    }
    return requestWrite({ type: "moveCardAnchor", noteId, anchorId, x, y });
  }

  #removeCardAnchor(noteId, anchorId) {
    if (typeof anchorId !== "string" || !anchorId) return;
    if (notesStore.isSecretNote(noteId)) {
      return typeof secrets.removeSecretCardAnchor === "function"
        ? gm(() => secrets.removeSecretCardAnchor(noteId, anchorId)) : undefined;
    }
    return requestWrite({ type: "removeCardAnchor", noteId, anchorId });
  }

  async #createNoteAt({
    x, y, secret = false, kind = "note", style, initialTitle, immediate = false, presentation, label = ""
  }) {
    if (!game.users.activeGM) {
      ui.notifications?.warn(t("JN.TopBar.Offline"));
      return;
    }
    const requestedPresentation = noteCreationPresentation({ kind, style, presentation });
    const requestedStyle = noteCreationStyle({ kind, style, presentation });
    const titleStyle = kind === "location" ? "document"
      : (requestedPresentation.forceExtended ? requestedPresentation.extendedStyle : "auto");
    const note = immediate
      ? {
        title: defaultNoteTitle(kind, titleStyle), style: requestedStyle,
        autoTitle: true, presentation: requestedPresentation, label
      }
      : await promptNewNote(t(secret ? "JN.Prompt.NewSecretNote" : "JN.Prompt.NewNote"), { kind, style, initialTitle });
    if (!note) return;

    const fields = noteCreationPresentation({ kind, style: note.style, presentation: note.presentation });
    const finalStyle = noteCreationStyle({ kind, style: note.style, presentation: note.presentation });
    const finalLabel = typeof note.label === "string" ? note.label : "";
    if (secret) {
      return gm(async () => {
        const noteId = await secrets.createSecretNote({
          title: note.title, kind, x, y, style: finalStyle
        });
        if (!noteId) return;
        await secrets.setSecretNotePresentation(noteId, fields);
        await secrets.setSecretNoteLabel(noteId, finalLabel);
        this.#select(noteId);
      });
    }
    return requestWrite({
      type: "createNote", title: note.title, style: finalStyle, kind, x, y,
      autoTitle: note.autoTitle === true, presentation: fields, label: finalLabel
    });
  }

  #copySelectedNotes() {
    const ids = this.#view === "private"
      ? this.#private.canvas.getSelectedNoteIds()
      : this.#canvas.getSelectedNoteIds();
    const notes = ids.map(id => this.#view === "private" ? this.#private.getNote(id) : notesStore.getNote(id))
      .filter(note => note && !note.system.deleted)
      // Never let a GM-only note or hidden paragraph leak into a shared paste.
      .filter(note => this.#view !== "shared" || !note.secret);
    if (!notes.length) return false;
    const layout = this.#view === "private" ? this.#private.layout() : notesStore.getLayout();
    const cards = layout?.cards ?? {};
    this.#clipboard = notes.map(note => ({
      title: note.name?.trim() || t("JN.Private.NewNoteTitle"),
      blocks: (note.system.blocks ?? []).filter(block => !block.hidden).map(block => block.text),
      style: cardStyleKey(note.system.style),
      kind: note.system.kind === "location" ? "location" : "note",
      targetHeading: typeof note.system.targetHeading === "string" ? note.system.targetHeading : "",
      label: typeof note.system.label === "string" ? note.system.label : "",
      presentation: note.system.presentation && typeof note.system.presentation === "object"
        ? note.system.presentation : undefined,
      attachment: note.system.attachment && typeof note.system.attachment === "object"
        ? note.system.attachment : undefined,
      schemaVersion: note.system.schemaVersion,
      // The note model has no card, so read the selected card's anchors from the layout.
      card: { anchors: cards[note.id]?.anchors ?? {} }
    }));
    ui.notifications?.info(t("JN.Clipboard.Copied", { count: this.#clipboard.length }));
    return true;
  }

  async #pasteClipboard() {
    if (!this.#clipboard.length) return false;
    if (this.#view === "private") {
      const page = privateStore.findActive(game.user.id);
      if (!page) return false;
      const position = this.#private.canvas.newCardPosition();
      await this.#private.pasteNotes(this.#clipboard, position);
      ui.notifications?.info(t("JN.Clipboard.Pasted", { count: this.#clipboard.length }));
      return true;
    }
    if (!game.users.activeGM) {
      ui.notifications?.warn(t("JN.Private.NoGM"));
      return true;
    }
    const position = this.#canvas.newCardPosition();
    for (const entry of this.#clipboard) {
      await requestWrite({
        type: "pasteNote", title: entry.title, blocks: entry.blocks,
        style: entry.style, kind: entry.kind, targetHeading: entry.targetHeading,
        label: entry.label, presentation: entry.presentation, attachment: entry.attachment,
        schemaVersion: entry.schemaVersion, card: entry.card,
        x: position.x, y: position.y
      });
    }
    ui.notifications?.info(t("JN.Clipboard.Pasted", { count: this.#clipboard.length }));
    return true;
  }

  _onFirstRender() {
    this.#editor.activate();
    this.#normalizePinsOnce();
    const rerender = () => this.render();
    for (const hook of [
      "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage",
      "updateJournalEntry", "createUser", "updateUser", "deleteUser", "userConnected"
    ]) {
      this.#hookIds.push([hook, Hooks.on(hook, rerender)]);
    }
    this.#hookIds.push(["journalinatorLocksChanged", Hooks.on("journalinatorLocksChanged", rerender)]);
    this.#hookIds.push(["journalinatorVaultChanged", Hooks.on("journalinatorVaultChanged", rerender)]);
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
          this.#canvas.clearSelection();
          for (const labelId of labelIds) this.#removeLabel(labelId);
          if (!shared.length) return;
          const undoId = foundry.utils.randomID();
          this.#pushHistory({ kind: "delete", noteIds: shared, undoId });
          this.#expectDeleteAcks(undoId, shared.length);
          for (const noteId of shared) requestWrite({ type: "deleteNote", noteId, undoId });
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

  /** Counts a confirmed note deletion and shows the recovery notice once the batch is complete. */
  #onDeleteApplied(message) {
    if (typeof message.undoId !== "string" || !message.undoId) return;
    const pending = this.#pendingDeleteAcks.get(message.undoId);
    if (!pending) return;
    pending.acked += 1;
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
      const sendable = this.#sharedSendableIds(selection);
      const hasOtherUser = [...(game.users ?? [])].some(user => user && user.id !== game.user.id);
      const hasDestination = hasOtherUser || !!privateStore.findActive(game.user.id);
      const canSend = !offline && sendable.length > 0 && hasDestination;
      sharedSend.disabled = !canSend;
      sharedSend.classList.toggle("disabled", !canSend);
      this.#setIconLabel(sharedSend, offline
        ? t("JN.Private.NeedGM")
        : (!sendable.length
          ? t(selection.length ? "JN.Transfer.VisibleOnly" : "JN.Transfer.SelectNotes")
          : (!hasDestination ? t("JN.Transfer.NoRecipients") : t("JN.Transfer.SendTo"))));
    }
  }

  /** Live, non-secret shared note ids from a selection; vault notes are never sendable. */
  #sharedSendableIds(ids) {
    return (Array.isArray(ids) ? ids : []).filter(id => {
      if (typeof id !== "string" || !id || notesStore.isSecretNote(id)) return false;
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
      selected = this.#sharedSendableIds(requested);
      if (!selected.length) {
        return ui.notifications?.warn(requested.length
          ? t("JN.Transfer.VisibleOnly") : t("JN.Transfer.None"));
      }
      if (selected.length < requested.length) {
        ui.notifications?.warn(t("JN.Transfer.HiddenExcluded"));
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
        .map(id => notesStore.getSharedPage(id)?.name ?? "")
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
        .map(id => this.#private.workspace?.notes?.[id]?.title ?? "")
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
        for (const id of selected) this.#publishPrivateNote(id);
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

  async #publishPrivateNote(id) {
    const note = this.#private.getNote(id);
    const card = this.#private.layout()?.cards?.[id];
    if (!note || !card || !game.users.activeGM) return;
    await requestWrite({
      type: "pasteNote", title: note.name?.trim() || t("JN.Private.NewNoteTitle"),
      blocks: (note.system.blocks ?? []).filter(block => !block.hidden).map(block => block.text),
      style: cardStyleKey(note.system.style), kind: note.system.kind,
      targetHeading: note.system.targetHeading ?? "", label: note.system.label ?? "",
      presentation: note.system.presentation, attachment: note.system.attachment,
      schemaVersion: note.system.schemaVersion,
      card: { anchors: card.anchors ?? {} }, x: card.x, y: card.y
    });
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
    if (this.#view === "private") {
      return !this.#filterStyles.size || this.#filterStyles.has(noteFilterKey(note));
    }
    if (this.#filterAuthors.size && !this.#filterAuthors.has(note.system.authorId)) return false;
    if (this.#filterStyles.size && !this.#filterStyles.has(noteFilterKey(note))) return false;
    return true;
  }

  #activeNotes() {
    if (this.#view === "private") {
      const page = privateStore.findActive(game.user.id);
      return page ? privateStore.noteViews(page) : [];
    }
    return notesStore.getAllNotes();
  }

  async _prepareContext() {
    const view = this.#view;
    const isPrivate = view === "private";
    const privatePage = privateStore.findActive(game.user.id);
    const pendingPage = privateStore.findPending(game.user.id);
    const privateData = isPrivate && privatePage ? privateStore.read(privatePage) : null;
    const notes = isPrivate && privateData
      ? privateStore.noteViews(privatePage, privateData)
      : notesStore.getAllNotes();
    const q = this.#query.trim().toLowerCase();
    const authors = isPrivate ? [] : [...new Map(notes.map(n => [n.system.authorId, game.users.get(n.system.authorId)])).entries()]
      .filter(([, u]) => u);
    const themeChoice = game.settings.get("fvtt-journalinator", "boardTheme") ?? "stylized";
    const theme = await resolveThemeChoice(themeChoice);
    return {
      view,
      allNotes: notes,
      layout: isPrivate && privateData ? privateData.layout : notesStore.getLayout(),
      privatePage,
      pendingPage,
      privateName: privatePage?.name ?? pendingPage?.name ?? "",
      canManagePrivate: game.user.isGM,
      gmOnline: !!game.users.activeGM,
      gmTier: canUseGmTier(),
      vaultStatus: vaultStore.status,
      merged: notesStore.merged,
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
    root.className = `journalinator-root${context.merged ? " jn-gm-view" : ""}${privateView ? " jn-private-view" : ""}`;
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
        <details class="jn-toolbar-dropdown journalinator-filters${this.#filterAuthors.size || this.#filterStyles.size ? " on" : ""}">
          <summary class="jn-toolbar-icon" ${tooltipAttrs(t("JN.Filter.Title"))}><i class="fa-solid fa-filter" aria-hidden="true"></i></summary>
          <div class="jn-toolbar-panel">
            ${context.authors.length ? `<div class="jn-menu-heading">${t("JN.Filter.Authors")}</div>
              ${filters(context.authors.map(([id, u]) => [id, u.name, u.color]), this.#filterAuthors, "author")}` : ""}
            <div class="jn-menu-heading">${t("JN.Filter.Styles")}</div>
            ${filters(NOTE_FILTERS.map(([id, labelKey]) => [id, t(labelKey)]), this.#filterStyles, "style")}
          </div>
        </details>
        ${themePicker}
      </div>
      <div class="jn-toolbar-group">
        ${toolbarButton("journalinator-trash", "fa-trash", trashLabel)}
        ${toolbarButton("journalinator-stats", "fa-chart-column", t("JN.TopBar.Stats"))}
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
        <details class="jn-toolbar-dropdown journalinator-filters${this.#filterStyles.size ? " on" : ""}">
          <summary class="jn-toolbar-icon" ${tooltipAttrs(t("JN.Filter.Title"))}><i class="fa-solid fa-filter" aria-hidden="true"></i></summary>
          <div class="jn-toolbar-panel">
            <div class="jn-menu-heading">${t("JN.Filter.Styles")}</div>
            ${filters(NOTE_FILTERS.map(([id, labelKey]) => [id, t(labelKey)]), this.#filterStyles, "style")}
          </div>
        </details>
        ${themePicker}
      </div>
      <div class="jn-toolbar-group">
        ${privatePage ? toolbarButton("journalinator-private-stats", "fa-chart-column", t("JN.TopBar.Stats")) : ""}
        ${privatePage ? toolbarButton("journalinator-trash", "fa-trash", trashLabel) : ""}
        ${privatePage ? toolbarButton("journalinator-private-send", "fa-paper-plane", t("JN.Transfer.SelectNotes"), true) : ""}
        ${privatePage ? toolbarButton("journalinator-private-fit", "fa-expand", t("JN.TopBar.FitAll")) : ""}
        ${inboxButton}
        ${context.canManagePrivate ? `<button type="button" class="jn-toolbar-icon journalinator-private-admin"
          ${tooltipAttrs(t("JN.Private.AdminTitle"))}><i class="fa-solid fa-user-shield" aria-hidden="true"></i></button>` : ""}
      </div>`;
    const viewLabel = privateView ? t("JN.Private.PrivateCanvas") : t("JN.Private.MainCanvas");
    root.innerHTML = `
      <header class="journalinator-topbar">
        <b class="jn-current-user"><span class="jn-dot" style="background:${escape(String(game.user.color ?? "#8d8d97"))}"></span>${escape(game.user.name)}</b>
        <details class="jn-view-menu jn-toolbar-dropdown" aria-label="${t("JN.Private.ViewSwitch")}">
          <summary class="jn-view-switch" ${tooltipAttrs(t("JN.Private.ViewSwitch"))}>${viewLabel}<i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary>
          <div class="jn-view-panel">
            <button type="button" class="jn-view-option${privateView ? "" : " on"}" data-view="shared">${t("JN.Private.MainCanvas")}</button>
            <div class="jn-view-private-row">
              <button type="button" class="jn-view-option${privateView ? " on" : ""}" data-view="private">${t("JN.Private.PrivateCanvas")}</button>
              ${privatePage ? `<button type="button" class="jn-view-rename" title="${t("JN.Private.RenameWorkspace")}"
                aria-label="${t("JN.Private.RenameWorkspace")}"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>` : ""}
            </div>
          </div>
        </details>
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
        ${!privateView && context.gmTier ? this.#gmControlsHTML(context) : ""}
      </header>
      ${!privateView && !context.gmOnline ? `<div class="journalinator-offline-banner">${t("JN.TopBar.Offline")}</div>` : ""}
      ${privateView && incomingCount ? `<button type="button" class="jn-transfer-banner journalinator-transfer-banner${offline ? " disabled" : ""}"
        ${offline ? "disabled" : ""}>
        <i class="fa-solid fa-inbox" aria-hidden="true"></i>
        ${t("JN.Transfer.InboxBanner", { count: incomingCount })}
      </button>` : ""}
      ${privateView ? this.#privateBodyHTML(context) : `<div class="journalinator-body">
        <div class="journalinator-canvas-slot"></div>
        <aside class="journalinator-editor"></aside>
      </div>`}
      <div class="jn-transfer-popover journalinator-transfer-send" role="dialog"
        aria-labelledby="jn-transfer-send-title" hidden></div>
      ${privateView ? `
        <div class="jn-transfer-popover journalinator-transfer-inbox-panel" role="dialog"
          aria-labelledby="jn-transfer-inbox-title" hidden></div>` : ""}
    `;

    this.#updateFilterIndicator(root);

    if (privateView) {
      this.#private.setPage(privatePage);
      if (privatePage) {
        this.#private.canvas.setTheme(context.themeObj);
        this.#private.canvas.pinsEnabled = this.#pinsEnabled();
        this.#private.renderInto(root.querySelector(".journalinator-canvas-slot"), root.querySelector(".journalinator-editor"));
        this.#private.setDimMatch(note => this.#matchesQuery(note, context.query) && this.#matchesFilters(note));
        if (document.activeElement === this.#private.canvas.root) this.#focusedCanvasRenders.add(root);
      }
      if (this.#switcherOpen) this.#renderSwitcher(root, context.allNotes);
      return root;
    }

    // Moving the canvas into the detached render result blurs it, even though we reuse the node.
    if (document.activeElement === this.#canvas.root) this.#focusedCanvasRenders.add(root);
    this.#editor.suspendBlur();
    this.#canvas.readOnly = offline;
    this.#editor.readOnly = offline;
    this.#canvas.pinsEnabled = this.#pinsEnabled();
    this.#canvas.setTheme(context.themeObj);
    this.#canvas.mount(root.querySelector(".journalinator-canvas-slot"));
    this.#canvas.selectedNoteId = this.#selectedNoteId;
    this.#canvas.gmMode = context.merged;
    this.#canvas.update(context.allNotes, context.layout, {
      deferGeometry: true,
      dimMatch: note => this.#matchesQuery(note, context.query) && this.#matchesFilters(note)
    });

    this.#editor.open(this.#selectedNoteId);
    this.#editor.mount(root.querySelector(".journalinator-editor"));
    this.#editor.render();

    if (this.#switcherOpen) this.#renderSwitcher(root, context.allNotes);

    return root;
  }

  #privateBodyHTML(context) {
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
    const editorInput = result.querySelector(".jn-card-text-input, .jn-block-input");
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
        this.#filterStyles.clear();
        this.#canvas.cancelLinkTool();
        this.#private.canvas.cancelLinkTool();
        this.#canvas.deactivatePinTool();
        this.#private.canvas.deactivatePinTool();
        this.render();
      });
    });

    root.querySelector(".journalinator-private-new")?.addEventListener("click", () => {
      this.#private.canvas.deactivatePinTool();
      this.#private.createNoteAt({ ...this.#private.canvas.newCardPosition(), title: t("JN.Private.NewNoteTitle") });
    });
    root.querySelector(".journalinator-private-add-label")?.addEventListener("click", () => {
      this.#private.canvas.deactivatePinTool();
      this.#private.canvas.addLabelButton();
    });
    root.querySelector(".journalinator-private-add-pin")?.addEventListener("click", () => {
      this.#private.canvas.togglePinTool();
    });

    root.querySelector(".journalinator-new")?.addEventListener("click", () => {
      this.#canvas.deactivatePinTool();
      this.#createNoteAt(this.#canvas.newCardPosition());
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

    root.querySelector(".journalinator-vault")?.addEventListener("click", () => openVaultDialog());
    root.querySelector(".journalinator-view-toggle")?.addEventListener("click", () => {
      notesStore.setGmView(!notesStore.gmView);
    });
    root.querySelector(".journalinator-new-secret")?.addEventListener("click", () => {
      this.#createNoteAt({ ...this.#canvas.newCardPosition(), secret: true });
    });
    root.querySelector(".journalinator-add-gm-label")?.addEventListener("click", () => {
      const { x, y } = this.#canvas.newCardPosition(0, 0);
      gm(() => secrets.addHiddenLabel(x, y));
    });
    root.querySelector(".journalinator-private-stats")?.addEventListener("click", () => {
      this.#private.openStats();
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

    root.querySelector(".journalinator-stats")?.addEventListener("click", () => this.#openStats());
    root.querySelector(".journalinator-fit")?.addEventListener("click", () => {
      const ids = this.#canvas.getSelectedNoteIds();
      this.#canvas.fitNotes(ids.length ? ids : null);
      this.#syncSelectionControls();
    });

    root.querySelectorAll(".journalinator-filters input").forEach(input => {
      input.addEventListener("change", () => {
        const set = input.dataset.kind === "author" ? this.#filterAuthors : this.#filterStyles;
        if (input.checked) set.add(input.value);
        else set.delete(input.value);
        input.closest("details").classList.toggle("on", !!(this.#filterAuthors.size || this.#filterStyles.size));
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
    const active = !!this.#query.trim() || this.#filterStyles.size > 0 || this.#filterAuthors.size > 0;
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

  #renderSwitcher(root, allNotes) {
    const q = this.#query.trim();
    const list = this.#switcherList(allNotes);
    const canCreate = this.#view === "private"
      ? !!privateStore.findActive(game.user.id)
      : !!game.users.activeGM;
    const offerCreate = canCreate && q && !allNotes.some(n => n.name.toLowerCase() === q.toLowerCase());
    this.#switcherHighlight = Math.max(0, Math.min(this.#switcherHighlight, list.length - (offerCreate ? 0 : 1)));

    const el = root.querySelector(".jn-switcher");
    el.innerHTML = (q ? "" : `<div class="jn-switcher-heading">${t("JN.Switcher.Recent")}</div>`) +
      list.map((n, i) => `
        <div class="jn-switcher-item${i === this.#switcherHighlight ? " hi" : ""}" data-id="${n._id}">
          <span class="jn-dot" style="background:${game.users.get(n.system.authorId)?.color ?? "#8d8d97"}"></span>
          <b>${foundry.utils.escapeHTML(noteSearchLabel(n))}</b>
          <small>${n.secret ? t("JN.Switcher.GMOnly") : ""}${t(notePresentationLabelKey(n))}</small>
        </div>`).join("") +
      (offerCreate ? `<div class="jn-switcher-item jn-switcher-create${list.length === this.#switcherHighlight ? " hi" : ""}" data-create="1">${t("JN.Switcher.Create", { title: foundry.utils.escapeHTML(q) })}</div>` : "");
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

  #createFromSwitcher(title) {
    this.#clearSearch();
    if (this.#view === "private") {
      this.#private.createNoteAt({ ...this.#private.canvas.newCardPosition(), title });
      return;
    }
    this.#createNoteAt({ ...this.#canvas.newCardPosition(), initialTitle: title });
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
    const canCreate = this.#view === "private"
      ? !!privateStore.findActive(game.user.id)
      : !!game.users.activeGM;
    const offerCreate = canCreate && q && !allNotes.some(n => n.name.toLowerCase() === q.toLowerCase());
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

  #bar(label, value, max) {
    const pct = max > 0 ? Math.round((value / max) * 100) : 0;
    return `
      <div class="jn-stat-bar">
        <span>${foundry.utils.escapeHTML(label)}</span>
        <div><i style="width:${pct}%"></i></div>
        <em>${value}</em>
      </div>`;
  }

  async #openStats() {
    // Main-canvas statistics are shared-canvas work only: live shared pages, never trash, never
    // a user's private workspace, and never vault/secret notes even while the GM vault is
    // unlocked and merged into the canvas. The trash line keeps the live count from looking wrong.
    const notes = selectLiveSharedNotes(notesStore.getSharedNotes());
    const trashCount = notesStore.getTrashedNotes().length;
    const stats = computeJournalStats(notes);
    const rawStats = notesStore.getStats();
    const sessions = deriveSessions(rawStats?.activity ?? {}, rawStats?.sessions ?? []);
    const name = id => game.users.get(id)?.name ?? t("JN.Common.Someone");

    const mvpEntries = Object.entries(stats.chars).sort((a, b) => b[1] - a[1]);
    const maxChars = Math.max(1, ...mvpEntries.map(([, v]) => v));
    const mvpHtml = mvpEntries.length
      ? mvpEntries.map(([id, v], i) => this.#bar(`${i === 0 ? "★ " : ""}${name(id)}`, v, maxChars)).join("")
      : `<p class="journalinator-empty">${t("JN.Stats.EmptyMVP")}</p>`;

    const maxNotes = Math.max(1, ...Object.values(stats.notesCreated));
    const notesHtml = Object.entries(stats.notesCreated).map(([id, v]) => this.#bar(name(id), v, maxNotes)).join("");

    const maxLinks = Math.max(1, ...Object.values(stats.linksDrawn), 1);
    const linksHtml = Object.entries(stats.linksDrawn).map(([id, v]) => this.#bar(name(id), v, maxLinks)).join("")
      || `<p class="journalinator-empty">${t("JN.Stats.EmptyLinks")}</p>`;

    const maxSession = Math.max(1, ...sessions.flatMap(s => Object.values(s.totals)));
    const sessionsHtml = sessions.length
      ? sessions.map(s => `<div class="jn-session-group"><div class="journalinator-meta">${foundry.utils.escapeHTML(s.label)}</div>${
          Object.entries(s.totals).map(([id, v]) => this.#bar(name(id), v, maxSession)).join("")
        }</div>`).join("")
      : `<p class="journalinator-empty">${t("JN.Stats.EmptyActivity")}</p>`;

    await foundry.applications.api.DialogV2.wait({
      window: { title: t("JN.Stats.Title") },
      position: { width: 420 },
      content: `
        <p class="jn-stats-live">${t("JN.Stats.LiveNotes", { count: notes.length })}</p>
        ${trashCount ? `<p class="jn-stats-trash">${t("JN.Stats.TrashNotCounted", { count: trashCount })}</p>` : ""}
        <div class="journalinator-meta">${t("JN.Stats.MVP")}</div>
        ${mvpHtml}
        <div class="journalinator-meta">${t("JN.Stats.NotesCreated")}</div>
        ${notesHtml}
        <div class="journalinator-meta">${t("JN.Stats.LinksDrawn")}</div>
        ${linksHtml}
        <div class="journalinator-meta">${t("JN.Stats.MostLinked")}</div>
        <p>${stats.mostLinked ? `${foundry.utils.escapeHTML(stats.mostLinked.name)} (${stats.mostLinked.count})` : "—"}</p>
        <div class="journalinator-meta">${t("JN.Stats.MostEdited")}</div>
        <p>${stats.mostEdited ? `${foundry.utils.escapeHTML(stats.mostEdited.name)} (${t("JN.Stats.Edits", { count: stats.mostEdited.count })})` : "—"}</p>
        <div class="journalinator-meta">${t("JN.Stats.Activity")}</div>
        ${sessionsHtml}
        ${game.user.isGM ? `<button type="button" class="jn-add-session">${t("JN.Stats.AddSession")}</button>` : ""}
      `,
      buttons: [{ action: "close", label: t("JN.Stats.Close"), default: true }],
      rejectClose: false,
      render: (event, dialog) => {
        dialog.element.querySelector(".jn-add-session")?.addEventListener("click", async () => {
          const label = await this.#promptText(t("JN.Prompt.SessionMarker"), "");
          if (!label) return;
          requestWrite({ type: "addSessionMarker", label });
          dialog.close();
        });
      }
    });
  }

  async #openTrash() {
    const offline = !game.users.activeGM;
    const trashed = notesStore.getTrashedNotes();
    const dateText = at => Number.isFinite(at)
      ? new Date(at).toLocaleString(game.i18n?.lang || undefined) : "";
    const metadata = note => {
      const deleted = note.system?.deleted;
      const by = deleted?.by ? game.users.get(deleted.by)?.name ?? t("JN.Common.Unknown") : "";
      const date = dateText(deleted?.at);
      if (!by && !date) return `<span class="jn-trash-meta">${t("JN.Trash.MetadataUnknown")}</span>`;
      const text = by && date
        ? t("JN.Trash.DeletedMeta", { name: foundry.utils.escapeHTML(by), date: foundry.utils.escapeHTML(date) })
        : (by
          ? t("JN.Trash.DeletedBy", { name: foundry.utils.escapeHTML(by) })
          : t("JN.Trash.DeletedDate", { date: foundry.utils.escapeHTML(date) }));
      return `<span class="jn-trash-meta">${text}</span>`;
    };
    const rows = trashed
      .map(n => `<div class="jn-trash-row"><span class="jn-trash-title">${foundry.utils.escapeHTML(n.name)}</span>${metadata(n)}<button type="button" class="jn-trash-restore" data-id="${n._id}"${offline ? " disabled" : ""}>${t("JN.Common.Restore")}</button></div>`)
      .join("") || `<p class="journalinator-empty">${t("JN.Trash.Empty")}</p>`;

    await foundry.applications.api.DialogV2.wait({
      window: { title: t("JN.Trash.Title") },
      content: (trashed.length ? `<p class="jn-trash-hint">${t("JN.Trash.RecoverableHint")}</p>` : "")
        + `<div class="jn-trash-list">${rows}</div>` +
        (game.user.isGM && trashed.length ? `<button type="button" class="jn-trash-empty">${t("JN.Trash.EmptyButton")}</button>` : ""),
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

  #gmControlsHTML(context) {
    const vaultLabel = {
      absent: t("JN.TopBar.SecretsSetup"),
      locked: t("JN.TopBar.SecretsLocked"),
      unlocked: t("JN.TopBar.SecretsUnlocked"),
      error: t("JN.TopBar.SecretsError")
    }[context.vaultStatus] ?? t("JN.TopBar.Secrets");
    const unlocked = context.vaultStatus === "unlocked";
    return `
      <span class="jn-gm-controls">
        <button type="button" class="journalinator-vault">${vaultLabel}</button>
        ${unlocked ? `<button type="button" class="journalinator-view-toggle" title="${t("JN.TopBar.GMViewTitle")}">${notesStore.gmView ? t("JN.TopBar.GMView") : t("JN.TopBar.PlayerView")}</button>` : ""}
        ${context.merged ? `
          <button type="button" class="journalinator-new-secret" title="${t("JN.TopBar.NewSecretTitle")}">${t("JN.TopBar.NewSecret")}</button>
          <button type="button" class="journalinator-add-gm-label">${t("JN.TopBar.AddGMLabel")}</button>` : ""}
      </span>`;
  }

  async #editHiddenLabel(labelId) {
    const label = notesStore.getLayout()?.labels?.[labelId];
    if (!label) return;
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: t("JN.Prompt.GMLabel") },
      content: `<input type="text" name="value" autofocus value="${foundry.utils.escapeHTML(label.text ?? "")}">`,
      buttons: [
        { action: "save", label: t("JN.Common.Save"), default: true, callback: (event, button) => ({ action: "save", text: button.form.elements.value.value.trim() }) },
        { action: "reveal", label: t("JN.Editor.LabelMakePublic"), callback: () => ({ action: "reveal" }) },
        { action: "delete", label: t("JN.Common.Delete"), callback: () => ({ action: "delete" }) }
      ],
      rejectClose: false
    });
    if (!result) return;
    if (result.action === "reveal") return gm(() => secrets.revealLabel(labelId));
    if (result.action === "delete" || (result.action === "save" && !result.text)) return gm(() => secrets.removeHiddenLabel(labelId));
    return gm(() => secrets.updateHiddenLabel(labelId, { text: result.text }));
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
