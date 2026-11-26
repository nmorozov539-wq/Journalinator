import { notesStore } from "../store/notes-store.mjs";
import { requestWrite } from "../socket.mjs";
import JournalCanvas from "./canvas.mjs";
import NoteEditor from "./editor.mjs";
import PrivateWorkspace from "./private-workspace.mjs";
import { openPrivateAdmin } from "./private-admin.mjs";
import { privateStore } from "../store/private-store.mjs";
import { defaultNoteTitle, noteCreationPresentation, noteCreationStyle, promptNewNote } from "./note-dialog.mjs";
import { noteFilterKey, noteMatchesQuery, notePresentationLabelKey, noteSearchLabel } from "./note-search.mjs";
import { computeJournalStats, deriveSessions } from "../stats.mjs";
import { CARD_STYLES, cardStyleKey } from "../styles/registry.mjs";
import { applyTheme, getTheme, listThemes } from "../styles/themes.mjs";
import { SCENE_THEME_ID, clearSceneThemeCache, sceneTheme } from "../scene-palette.mjs";
import { canUseGmTier } from "../secrets/access.mjs";
import { vaultStore } from "../secrets/vault-store.mjs";
import { openVaultDialog } from "../secrets/vault-ui.mjs";
import * as secrets from "../secrets/secret-actions.mjs";
import { t } from "../i18n.mjs";
import { stripSecretPrefix } from "../secrets/model.mjs";
import { resolvePresentation } from "../presentation.mjs";
import { resolveActorStatus } from "../actor-status.mjs";

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

function toolbarButton(className, icon, label, disabled = false) {
  return `<button type="button" class="jn-toolbar-icon ${className}"${disabled ? " disabled" : ""} ${tooltipAttrs(label)}>
    <i class="fa-solid ${icon}" aria-hidden="true"></i></button>`;
}

const { ApplicationV2 } = foundry.applications.api;

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
  #focusedCanvasRenders = new WeakSet();
  #lastAppliedTheme = null;
  #deletionHistory = [];
  // Client-side pin undo ids only. The active GM keeps the authoritative before/after
  // fingerprints and refuses a stale id, so we do not need to chase every later write here.
  #pinHistory = [];
  #clipboard = [];
  #replacingHTML = false;
  #editor = new NoteEditor({
    boardOnly: true,
    onEditHiddenBlock: async (id, blockId) => {
      await this.render();
      const slot = this.#canvas.cardEls.get(id)?.querySelector(`.jn-card-block[data-block-id="${CSS.escape(blockId)}"]`);
      if (slot && this.#selectedNoteId === id) this.#editor.editBoardBlock(id, blockId, slot);
    },
    onFocusNote: id => this.#canvas.focusNote(id),
    onSelectNote: id => { this.#selectedNoteId = id; this.render(); },
    onSetMainPinEnabled: (id, enabled) => this.#setMainPinEnabled(id, enabled)
  });
  // Every canvas action is routed by what it touches: GM-only things go to the vault in this
  // client, everything else is a normal shared write request (spec §14).
  #canvas = new JournalCanvas({
    onSelectNote: id => { this.#selectedNoteId = id; this.render(); },
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
    onCreateLink: (sourceId, targetId, ports) => (notesStore.isSecretNote(sourceId) || notesStore.isSecretNote(targetId))
      ? gm(() => secrets.addHiddenLink(sourceId, targetId, ports))
      : requestWrite({ type: "createLink", sourceId, targetId, ...ports }),
    onUpdateLink: (noteId, linkId, fields) => notesStore.isHiddenLink(noteId, linkId)
      ? gm(() => secrets.updateHiddenLink(noteId, linkId, fields))
      : requestWrite({ type: "updateLink", noteId, linkId, fields }),
    onDeleteLink: (noteId, linkId) => notesStore.isHiddenLink(noteId, linkId)
      ? gm(() => secrets.deleteHiddenLink(noteId, linkId))
      : requestWrite({ type: "deleteLink", noteId, linkId }),
    onAddCardAnchor: (noteId, anchor) => this.#addCardAnchor(noteId, anchor),
    onMoveCardAnchor: (noteId, anchorId, x, y) => this.#moveCardAnchor(noteId, anchorId, x, y),
    onRemoveCardAnchor: (noteId, anchorId) => this.#removeCardAnchor(noteId, anchorId),
    onHideLink: (noteId, linkId) => gm(() => secrets.hideSharedLink(noteId, linkId)),
    onRevealLink: (noteId, linkId) => gm(() => secrets.revealLink(noteId, linkId)),
    onToggleLinkHint: (noteId, linkId, hint) => requestWrite({ type: "gmSetLinkHint", noteId, linkId, hint }),
    // Actor links are a GM-side read: players still see the derived badge, but cannot choose
    // which actor a shared note watches.
    onLinkActor: noteId => this.#linkActor(noteId),
    onUnlinkActor: noteId => requestWrite({ type: "linkActor", noteId, actorRef: null })
  });

  #private = new PrivateWorkspace({ onChange: () => this.render() });

  #select(noteId) {
    if (!noteId) return;
    this.#selectedNoteId = noteId;
    this.render();
  }

  #removeLabel(labelId) {
    if (notesStore.isHiddenLabel(labelId)) return gm(() => secrets.removeHiddenLabel(labelId));
    return requestWrite({ type: "removeLabel", labelId });
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

  /** True when any visible note watches this base actor (synthetic token actors included). */
  #actorIsLinked(value) {
    const actorId = typeof value === "string"
      ? value
      : (value?.token?.actorId ?? value?.actorId ?? value?.id);
    if (!actorId) return false;
    return notesStore.getAllNotes().some(note => note.system?.actorRef?.actorId === actorId);
  }

  #sceneIsLinked(sceneId) {
    if (!sceneId) return false;
    return notesStore.getAllNotes().some(note => note.system?.actorRef?.sceneId === sceneId);
  }

  #hasActorLinks() {
    return notesStore.getAllNotes().some(note => note.system?.actorRef?.actorId);
  }

  async #linkActor(noteId) {
    if (!game.user?.isGM) return;
    const note = notesStore.getNote(noteId);
    if (!note || note.secret) return;
    const actors = [...(game.actors ?? [])].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    if (!actors.length) {
      ui.notifications?.warn(t("JN.Actor.NoActors"));
      return;
    }
    const scenes = [...(game.scenes ?? [])].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    const current = note.system?.actorRef ?? null;
    const esc = foundry.utils.escapeHTML;
    const tokenCount = (scene, actorId) => {
      if (!scene?.tokens) return 0;
      let count = 0;
      for (const token of scene.tokens) if (token.actorId === actorId) count++;
      return count;
    };
    const sceneOptions = actorId => [
      `<option value="">${t("JN.Actor.AnyScene")}</option>`,
      ...scenes
        .filter(scene => tokenCount(scene, actorId) > 0)
        .map(scene => `<option value="${esc(scene.id)}">${esc(t("JN.Actor.SceneOption", { scene: scene.name }))}</option>`)
    ].join("");

    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: t("JN.Actor.DialogTitle") },
      position: { width: 480 },
      content: `
        <div class="form-group">
          <label for="jn-actor-link">${t("JN.Actor.Actor")}</label>
          <div class="form-fields"><select id="jn-actor-link" name="actor">
            ${actors.map(actor => `<option value="${esc(actor.id)}" ${current?.actorId === actor.id ? "selected" : ""}>${esc(actor.name)}</option>`).join("")}
          </select></div>
        </div>
        <div class="form-group">
          <label for="jn-actor-scene">${t("JN.Actor.Scope")}</label>
          <div class="form-fields"><select id="jn-actor-scene" name="scene"></select></div>
        </div>
        <p class="journalinator-meta">${t("JN.Actor.Hint")}</p>`,
      render: (_event, dialog) => {
        const actorSelect = dialog.element.querySelector('select[name="actor"]');
        const sceneSelect = dialog.element.querySelector('select[name="scene"]');
        const syncScenes = () => {
          sceneSelect.innerHTML = sceneOptions(actorSelect.value);
          if (current?.actorId === actorSelect.value && current.sceneId
              && [...sceneSelect.options].some(option => option.value === current.sceneId)) {
            sceneSelect.value = current.sceneId;
          }
        };
        actorSelect.addEventListener("change", syncScenes);
        syncScenes();
      },
      buttons: [
        {
          action: "ok",
          label: t("JN.Common.OK"),
          default: true,
          callback: (_event, button) => ({
            actorId: button.form.elements.actor.value,
            sceneId: button.form.elements.scene.value || null
          })
        },
        { action: "cancel", label: t("JN.Common.Cancel"), callback: () => null }
      ],
      rejectClose: false
    });
    if (!result?.actorId) return;
    await requestWrite({ type: "linkActor", noteId, actorRef: result });
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
      if (message?.forUserId !== game.user.id) return;
      if (message.kind !== "pin" || typeof message.undoId !== "string" || !message.undoId) return;
      this.#pinHistory.push({ kind: "pin", undoId: message.undoId });
      if (this.#pinHistory.length > 20) this.#pinHistory.shift();
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

    // Actor badges are derived, so they only need a re-render when a linked actor, its token, or
    // a status effect changes. Token movement is deliberately ignored: updateToken fires on
    // every step, and a badge does not depend on coordinates.
    const rerenderForActor = actor => {
      if (this.#actorIsLinked(actor)) this.render();
    };
    this.#hookIds.push(["updateActor", Hooks.on("updateActor", rerenderForActor)]);
    this.#hookIds.push(["createToken", Hooks.on("createToken", token => rerenderForActor(token))]);
    this.#hookIds.push(["deleteToken", Hooks.on("deleteToken", token => rerenderForActor(token))]);
    this.#hookIds.push(["updateToken", Hooks.on("updateToken", (token, changes) => {
      const touchesDelta = Object.keys(changes ?? {}).some(key => key === "delta" || key.startsWith("delta."));
      if (touchesDelta) rerenderForActor(token);
    })]);
    this.#hookIds.push(["deleteActor", Hooks.on("deleteActor", actor => rerenderForActor(actor))]);
    this.#hookIds.push(["deleteScene", Hooks.on("deleteScene", scene => {
      if (this.#sceneIsLinked(scene?.id)) this.render();
    })]);
    const rerenderForEffect = effect => {
      const parent = effect?.parent;
      if (!parent) return;
      const actor = parent.documentName === "Actor" || parent.isToken ? parent : (parent.actor ?? parent.parent);
      if (actor) rerenderForActor(actor);
    };
    for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
      this.#hookIds.push([hook, Hooks.on(hook, rerenderForEffect)]);
    }
    this.#hookIds.push(["canvasReady", Hooks.on("canvasReady", () => {
      if (this.#hasActorLinks()) this.render();
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
        if (ev.key === "Backspace" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
          consume();
          if (!ev.repeat) this.#private.deleteSelected();
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

      if (ev.key === "Backspace" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
        consume();
        if (ev.repeat) return;
        const labelIds = this.#canvas.getSelectedLabelIds();
        const selected = this.#canvas.getSelectedNoteIds();
        const shared = selected.filter(id => {
          const page = notesStore.getSharedPage(id);
          return page && !page.system.deleted;
        });
        if (!shared.length && !labelIds.length) return;
        this.#canvas.clearSelection();
        for (const labelId of labelIds) this.#removeLabel(labelId);
        if (shared.length) {
          const undoId = foundry.utils.randomID();
          this.#deletionHistory.push({ noteIds: shared, undoId });
          if (this.#deletionHistory.length > 20) this.#deletionHistory.shift();
          for (const noteId of shared) requestWrite({ type: "deleteNote", noteId, undoId });
        }
        return;
      }

      if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey
          && (ev.code === "KeyZ" || ev.key.toLowerCase() === "z")) {
        consume();
        if (ev.repeat) return;
        const pinUndo = this.#pinHistory.pop();
        if (pinUndo) {
          requestWrite({ type: "undoPinChange", undoId: pinUndo.undoId });
          return;
        }
        const deleted = this.#deletionHistory.pop();
        if (!deleted) return;
        for (const noteId of deleted.noteIds) requestWrite({ type: "restoreNote", noteId, undoId: deleted.undoId });
      }
    };
    addEventListener("keydown", this.#onGlobalKeydown, true);
  }

  _onClose() {
    this.#canvas.finishInlineText();
    this.#editor.deactivate();
    this.#canvas.cancelLinkTool();
    this.#canvas.disconnectGeometry();
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
  }

  #matchesQuery(note, q) {
    if (!q) return true;
    const author = game.users.get(note.system.authorId)?.name ?? "";
    return noteMatchesQuery(note, q, author);
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
      themeList: [
        ...listThemes().map(item => ({
          id: item.id,
          label: item.nameKey ? t(item.nameKey) : (item.name || item.id)
        })),
        { id: SCENE_THEME_ID, label: t("JN.Theme.Scene") }
      ],
      authors,
      query: q
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
    const filters = (items, selected, kind) => items.map(([id, label, color]) =>
      `<label class="jn-menu-option"><input type="checkbox" data-kind="${kind}" value="${escape(id)}"
        ${selected.has(id) ? "checked" : ""}>${color ? `<span class="jn-dot" style="background:${escape(String(color))}"></span>` : ""}
        <span>${escape(label)}</span></label>`).join("");
    // The theme selector stays in place for layout/API compatibility but is deliberately inert:
    // no palette popup, no click handlers, and every choice is rendered disabled.
    const themePicker = `<details class="jn-toolbar-dropdown journalinator-theme" aria-disabled="true"
        aria-label="${t("JN.Theme.PickerInactive")}">
      <summary class="jn-toolbar-icon" aria-disabled="true" inert ${tooltipAttrs(t("JN.Theme.PickerInactive"))}><i class="fa-solid fa-palette" aria-hidden="true"></i></summary>
      <div class="jn-toolbar-panel" aria-hidden="true" inert>
        ${context.themeList.map(item => `<button type="button" disabled aria-pressed="${context.themeChoice === item.id}">${escape(item.label)}</button>`).join("")}
      </div>
    </details>`;
    const sharedToolbar = `
      <div class="jn-toolbar-group">
        ${toolbarButton("journalinator-new", "fa-note-sticky", t("JN.TopBar.NewNote"), offline)}
        ${toolbarButton("journalinator-add-label", "fa-font", t("JN.TopBar.AddLabel"), offline)}
        ${toolbarButton("journalinator-add-link", "fa-link", t("JN.Link.Tool"), offline)}
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
        ${toolbarButton("journalinator-trash", "fa-trash", t("JN.TopBar.Trash"))}
        ${toolbarButton("journalinator-stats", "fa-chart-column", t("JN.TopBar.Stats"))}
      </div>`;
    const privateToolbar = `
      <div class="jn-toolbar-group">
        ${privatePage ? toolbarButton("journalinator-private-new", "fa-note-sticky", t("JN.TopBar.NewNote")) : ""}
        ${privatePage ? toolbarButton("journalinator-private-add-label", "fa-font", t("JN.TopBar.AddLabel")) : ""}
        ${privatePage ? toolbarButton("journalinator-private-add-link", "fa-link", t("JN.Link.Tool")) : ""}
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
        ${privatePage ? toolbarButton("journalinator-trash", "fa-trash", t("JN.TopBar.Trash")) : ""}
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
        <div class="jn-toolbar-tools">
          ${privateView ? privateToolbar : sharedToolbar}
        </div>
        ${!privateView && context.gmTier ? this.#gmControlsHTML(context) : ""}
      </header>
      ${!privateView && !context.gmOnline ? `<div class="journalinator-offline-banner">${t("JN.TopBar.Offline")}</div>` : ""}
      ${privateView ? this.#privateBodyHTML(context) : `<div class="journalinator-body">
        <div class="journalinator-canvas-slot"></div>
        <aside class="journalinator-editor"></aside>
      </div>`}
    `;

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
    this.#canvas.statusFor = note => resolveActorStatus(note.system?.actorRef);
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
    const editorInput = result.querySelector(".jn-card-text-input, .jn-block-input");
    if (editorInput) editorInput.focus({ preventScroll: true });
    else if (this.#focusedCanvasRenders.has(result) && document.activeElement === document.body) {
      const canvasRoot = this.#view === "private" ? this.#private.canvas.root : this.#canvas.root;
      canvasRoot.focus({ preventScroll: true });
    }
  }

  _onRender() {
    const root = this.element;
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
    // The theme dropdown is permanently inactive in this presentation. `inert` blocks it in
    // modern browsers; this guard also keeps it closed where `inert` is not implemented.
    const lockedTheme = root.querySelector(".journalinator-theme");
    lockedTheme?.querySelector("summary")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      lockedTheme.open = false;
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
        this.render();
      });
    });

    root.querySelector(".journalinator-private-new")?.addEventListener("click", () => {
      this.#private.createNoteAt({ ...this.#private.canvas.newCardPosition(), title: t("JN.Private.NewNoteTitle") });
    });
    root.querySelector(".journalinator-private-add-label")?.addEventListener("click", () => {
      this.#private.canvas.addLabelButton();
    });
    root.querySelector(".journalinator-private-add-link")?.addEventListener("click", () => {
      this.#private.canvas.toggleLinkTool();
    });

    root.querySelector(".journalinator-new")?.addEventListener("click", () => {
      this.#createNoteAt(this.#canvas.newCardPosition());
    });

    root.querySelector(".journalinator-add-label")?.addEventListener("click", () => {
      this.#canvas.addLabelButton();
    });
    root.querySelector(".journalinator-add-link")?.addEventListener("click", () => this.#canvas.toggleLinkTool());

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

    root.querySelector(".journalinator-stats")?.addEventListener("click", () => this.#openStats());

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
    const notes = notesStore.getAllNotesIncludingTrashed();
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
    const rows = trashed
      .map(n => `<div class="jn-trash-row"><span>${foundry.utils.escapeHTML(n.name)}</span><button type="button" class="jn-trash-restore" data-id="${n._id}"${offline ? " disabled" : ""}>${t("JN.Common.Restore")}</button></div>`)
      .join("") || `<p class="journalinator-empty">${t("JN.Trash.Empty")}</p>`;

    await foundry.applications.api.DialogV2.wait({
      window: { title: t("JN.Trash.Title") },
      content: `<div class="jn-trash-list">${rows}</div>` +
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
