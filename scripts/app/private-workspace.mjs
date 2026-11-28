import JournalCanvas from "./canvas.mjs";
import PrivateNoteEditor from "./private-editor.mjs";
import { privateStore } from "../store/private-store.mjs";
import { linkAnchors, moveThreadPin } from "../card-ports.mjs";
import {
  anchorSide, mergeNearbyMinorAnchors, minorOnEdge, nearestMinorAnchor, promoteLegacyLinkAnchors,
  pruneAnchorRegistry, validAnchorId
} from "../anchors.mjs";
import { boardPinRef, normalizePinLink, resolvePin, validPinPosition } from "../board-pins.mjs";
import { isLinkColor, normalizeLinkColor } from "../link-colors.mjs";
import {
  LINK_ENDS, LINK_MATERIALS, LINK_PATTERNS, LINK_SLACK, LINK_THICKNESS, MAX_CARD_ANCHORS,
  PIN_STYLES, defaultLinkCosmetics, resolveAttachment
} from "../presentation.mjs";
import { getCreationChoice, openCreationMenu } from "./creation-menu.mjs";
import { createNoteFromQuery } from "../templates.mjs";
import { getLayout } from "../layouts/registry.mjs";
import { resolveSkin } from "../skins/registry.mjs";
import { originFromBox, validAutoOrigin } from "../sizing/geometry.mjs";
import { attachedStampIds, DEFAULT_STAMP_CORNER, isStampCorner, STAMP_COLORS, stampUrl } from "../stamps.mjs";
import { toggleTaskListItem } from "../markdown.mjs";
import { openHistoryDialog } from "./history-dialog.mjs";
import { PrivateEditCoordinator, createPrivateTransport } from "../private/private-session.mjs";
import { deletePrivateHistory } from "../private/private-history.mjs";
import { noteAuthorName, noteDateText, noteSearchExcerpt, noteSearchLabel } from "./note-search.mjs";
import { t } from "../i18n.mjs";

const { DialogV2 } = foundry.applications.api;
const esc = text => foundry.utils.escapeHTML(String(text ?? ""));

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

/** The private tab's v2 canvas, shared editor, selection, history, trash and clipboard actions. */
export default class PrivateWorkspace {
  constructor({
    onChange, onSelectionChange, onSend, onStamp, onPinToolChange, onCopy
  } = {}) {
    this.onChange = onChange ?? (() => {});
    this.onSelectionChange = onSelectionChange ?? (() => {});
    this.onSend = onSend ?? (() => {});
    this.onStamp = onStamp ?? (() => {});
    this.onPinToolChange = onPinToolChange ?? (() => {});
    this.onCopy = onCopy ?? (() => {});
    this.page = null;
    this.workspace = null;
    this.selectedNoteId = null;
    this.history = [];
    this.clipboard = [];
    this.deleteConfirmPending = false;
    this.dimMatch = () => true;

    this.canvas = new JournalCanvas({
      onSelectNote: id => {
        this.selectedNoteId = id;
        this.onSelectionChange(this.getSelectedNoteIds());
      },
      onEditNote: (id, point) => this.beginEditing(id, point),
      onCreateNoteAt: (x, y) => this.openCreationMenuAt({ x, y }),
      onPinToolChange: active => this.onPinToolChange(active),
      onMoveCard: (id, x, y) => this.moveCard(id, x, y),
      onMoveCards: moves => this.moveCards(moves),
      onResizeCard: (id, width, height) => this.resizeCard(id, width, height),
      onToggleTask: (id, index) => this.toggleTask(id, index),
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
      onDeleteLink: (noteId, linkId) => this.deleteLink(noteId, linkId),
      onAddCardAnchor: (noteId, anchor) => this.addCardAnchor(noteId, anchor),
      onMoveCardAnchor: (noteId, anchorId, x, y) => this.moveCardAnchor(noteId, anchorId, x, y),
      onRemoveCardAnchor: (noteId, anchorId) => this.removeCardAnchor(noteId, anchorId),
      onBoardPinAction: action => this.boardPinAction(action),
      onSetLayout: (ids, layout) => this.applyAppearance(ids, { layout }),
      onSetAppearance: (ids, patch) => this.applyAppearance(ids, patch),
      onChooseBackground: ids => this.chooseBackground(ids),
      onAutoSize: ids => this.autoSizeNotes(ids),
      onHistory: id => this.openHistory(id),
      onSendNote: id => this.onSend(id),
      onCopyNotes: ids => this.copyNotes(ids),
      onDeleteNotes: ids => this.deleteNotes(ids)
    });

    this.editor = new PrivateNoteEditor({
      getPage: () => this.page,
      getNote: id => this.getNote(id),
      reloadWorkspace: () => this.reloadWorkspace(),
      onNoteChanged: () => this.onSelectionChange(this.getSelectedNoteIds()),
      onClosed: info => this.#onEditorClosed(info),
      onState: () => this.#positionEditorChrome()
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

  #page() {
    return this.page ? privateStore.findById(this.page.id) ?? this.page : null;
  }

  notes() {
    return this.page && this.workspace ? privateStore.noteViews(this.page, this.workspace) : [];
  }

  layout() {
    return this.workspace?.layout ?? { cards: {}, labels: {}, pins: {}, pinLinks: {}, viewport: null };
  }

  getNote(id) {
    if (!this.page || !this.workspace || !id) return null;
    const note = this.workspace.notes[id];
    return note ? privateStore.noteView(this.page, note) : null;
  }

  #noteLabel(noteId) {
    const note = this.getNote(noteId);
    return note ? noteSearchLabel(note) : "";
  }

  getBacklinks(noteId) {
    if (!this.workspace?.notes?.[noteId]) return [];
    const found = new Map();
    for (const note of Object.values(this.workspace.notes)) {
      if (note.id === noteId) continue;
      if (note.links?.some(link => link.targetId === noteId)) found.set(note.id, this.#noteLabel(note.id));
    }
    const self = this.workspace.notes[noteId];
    for (const link of self.links ?? []) {
      const target = this.workspace.notes[link.targetId];
      if (target) found.set(target.id, this.#noteLabel(target.id));
    }
    return [...found].map(([id, name]) => ({ id, name }));
  }

  renderInto(canvasSlot) {
    if (!this.page) return;
    this.canvas.mount(canvasSlot);
    this.canvas.selectedNoteId = this.selectedNoteId;
    this.canvas.gmMode = false;
    this.canvas.readOnly = false;
    try {
      this.canvas.pinsEnabled = game.settings?.get?.("fvtt-journalinator", "pinsEnabled") !== false;
    } catch {
      this.canvas.pinsEnabled = true;
    }
    this.canvas.update(this.notes(), this.layout(), {
      deferGeometry: true,
      dimMatch: this.dimMatch
    });
    if (this.editor.isEditing) {
      const card = this.canvas.cardEls.get(this.editor.noteId);
      if (card) {
        this.canvas.setEditingNote(this.editor.noteId);
        card.classList.add("jn-editing");
        if (this.editor.root.parentElement !== card) card.appendChild(this.editor.root);
      }
    }
  }

  /** Local canvas-only refresh used during editing; never rebuilds the app or editor DOM. */
  refreshCanvas() {
    if (!this.page || !this.canvas.root.isConnected) return;
    this.canvas.selectedNoteId = this.selectedNoteId;
    this.canvas.update(this.notes(), this.layout(), { dimMatch: this.dimMatch });
    if (this.editor.isEditing) {
      this.canvas.setEditingNote(this.editor.noteId);
      this.canvas.cardEls.get(this.editor.noteId)?.classList.add("jn-editing");
    }
  }

  /** Re-reads confirmed workspace data after an editor/transport write. */
  reloadWorkspace() {
    const page = this.#page();
    if (!page) return;
    this.page = page;
    this.workspace = privateStore.read(page);
    if (this.selectedNoteId && !this.workspace.notes[this.selectedNoteId]) this.selectedNoteId = null;
    this.refreshCanvas();
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

  getSelectedLabelIds() {
    return this.canvas.getSelectedLabelIds();
  }

  #box(card, note) {
    const definition = getLayout(note?.layout);
    if (card?.sizing?.mode === "manual"
        && Number.isFinite(card.sizing.width) && Number.isFinite(card.sizing.minHeight)) {
      return { x: card.x, y: card.y, w: card.sizing.width, h: card.sizing.minHeight,
        rotation: card.rotation ?? 0 };
    }
    return {
      x: Number.isFinite(card?.x) ? card.x : 0,
      y: Number.isFinite(card?.y) ? card.y : 0,
      w: Number.isFinite(card?.width) && card.width > 0 ? card.width : definition.widths[definition.widths.length - 1],
      h: Number.isFinite(card?.height) && card.height > 0 ? card.height : definition.minHeight,
      rotation: Number.isFinite(card?.rotation) ? card.rotation : 0
    };
  }

  async #save(mutator, { silent = false } = {}) {
    if (!this.page) return false;
    const page = this.#page();
    const rev = privateStore.flags(page).rev ?? 0;
    const data = foundry.utils.deepClone(this.workspace);
    try {
      mutator(data);
      // Every private mutation is a safe normalization point: stacked duplicate minors left by
      // older link creation fold into one pin, and their links/pin links follow the canonical id.
      const owners = [
        ...Object.values(data.notes ?? {}),
        ...(data.trash ?? []).map(entry => entry?.note).filter(Boolean)
      ];
      const promoted = this.#pinsEnabled()
        ? promoteLegacyLinkAnchors(data.layout?.cards ?? {}, owners)
        : { cards: data.layout?.cards ?? {}, changed: [], links: [] };
      if (promoted.changed.length) data.layout.cards = promoted.cards;
      const byId = new Map(owners.filter(note => note?.id).map(note => [note.id, note]));
      for (const { noteId, links } of promoted.links) {
        const owner = byId.get(noteId);
        if (owner) owner.links = links;
      }
      const merged = mergeNearbyMinorAnchors(data.layout?.cards ?? {}, owners, {
        pinLinks: data.layout?.pinLinks ?? {}
      });
      if (merged.changed.length) data.layout.cards = merged.cards;
      if (merged.links.length || merged.pinLinks.length) {
        for (const { noteId, links } of merged.links) {
          const owner = byId.get(noteId);
          if (owner) owner.links = links;
        }
        for (const { id, source, target } of merged.pinLinks) {
          const pinLink = data.layout?.pinLinks?.[id];
          if (pinLink) Object.assign(pinLink, { source, target });
        }
      }
      const result = await privateStore.save(page, data, rev);
      this.workspace = result.workspace;
      if (!silent) this.onChange();
      return true;
    } catch (err) {
      ui.notifications?.warn(err.message);
      try { this.reloadWorkspace(); } catch { /* keep the last confirmed workspace */ }
      if (!silent) this.onChange();
      return false;
    }
  }

  /** Opens the shared Blank/Document/Profile menu, anchored to a toolbar button or board point. */
  openCreationMenuAt({ x = 0, y = 0, clientX, clientY, anchor = null } = {}) {
    if (!this.page) return null;
    const rect = this.canvas.root.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const screenX = Number.isFinite(clientX) && clientX > 0
      ? clientX
      : rect.left + this.canvas.view.x + x * this.canvas.view.k;
    const screenY = Number.isFinite(clientY) && clientY > 0
      ? clientY
      : rect.top + this.canvas.view.y + y * this.canvas.view.k;
    return openCreationMenu({
      anchor,
      clientX: screenX,
      clientY: screenY,
      t,
      onChoose: templateId => { void this.createFromTemplate(templateId, { x, y }); }
    });
  }

  async createFromTemplate(templateId, { x = 0, y = 0 } = {}) {
    if (!this.page) return null;
    const choice = getCreationChoice(templateId);
    return this.#createNote({
      body: choice.body,
      layout: choice.layout,
      skin: choice.skin,
      x,
      y,
      focus: choice.focus
    });
  }

  /** Quick-switcher creation: typed text is a real first-line heading; empty is Blank. */
  createFromQuery(query, { x = 0, y = 0 } = {}) {
    const created = createNoteFromQuery(query);
    return this.#createNote({ ...created, x, y });
  }

  async #createNote({ body = "", layout = "plain", skin = null, x = 0, y = 0, focus = "body-start" }) {
    const cards = this.workspace?.layout?.cards ?? {};
    const notes = this.workspace?.notes ?? {};
    const { note, card } = privateStore.makeNote({ body, layout, skin, x, y, cards, notes });
    const ok = await this.#save(data => {
      data.notes[note.id] = note;
      data.layout.cards[note.id] = card;
    }, { silent: true });
    if (!ok) return null;
    this.selectedNoteId = note.id;
    this.canvas.selectedNoteId = note.id;
    this.refreshCanvas();
    await this.beginEditing(note.id, null, focus, privateStore.noteView(this.page, note));
    return note.id;
  }

  /** Compatibility entry point for old create-button calls; always a Blank template. */
  createNoteAt({ x = 0, y = 0, templateId = "blank" } = {}) {
    return this.createFromTemplate(templateId, { x, y });
  }

  async beginEditing(noteId, point = null, focus = null, noteOverride = null) {
    if (!noteId || !this.page) return { ok: false };
    if (this.editor.isEditing) {
      if (this.editor.noteId === noteId) {
        if (point) this.editor.editor?.focusAtPoint(point.clientX, point.clientY);
        else if (focus) this.editor.focusDestination(focus);
        return { ok: true };
      }
      await this.editor.close();
    }
    const note = noteOverride ?? this.getNote(noteId);
    const card = this.canvas.cardEls.get(noteId);
    if (!note || !card) return { ok: false, reason: "missing" };
    this.selectedNoteId = noteId;
    this.canvas.selectedNoteId = noteId;
    this.canvas.setEditingNote(noteId);
    card.classList.add("jn-editing");
    const result = await this.editor.open(noteId, { host: card, note, point, focus });
    if (!result?.ok) {
      this.canvas.setEditingNote(null);
      card.classList.remove("jn-editing");
      this.onSelectionChange(this.getSelectedNoteIds());
      return result;
    }
    this.#positionEditorChrome();
    this.onSelectionChange(this.getSelectedNoteIds());
    return result;
  }

  #positionEditorChrome() {
    const noteId = this.editor.noteId;
    const card = noteId ? this.canvas.cardEls.get(noteId) : null;
    const toolbar = this.editor.editor?.root?.querySelector?.(".jn-editor-toolbar");
    if (!card || !toolbar) return;
    const rootRect = this.canvas.root.getBoundingClientRect?.() ?? { top: 0 };
    const toolbarRect = toolbar.getBoundingClientRect?.() ?? { top: 0 };
    this.editor.editor.root.classList.toggle("jn-toolbar-below",
      toolbarRect.top < (rootRect.top ?? 0) + 8);
  }

  #onEditorClosed({ noteId } = {}) {
    this.canvas.setEditingNote(null);
    this.canvas.cardEls.get(noteId)?.classList.remove("jn-editing");
    try { this.reloadWorkspace(); } catch { /* incompatible reload is handled by the app */ }
    this.onSelectionChange(this.getSelectedNoteIds());
  }

  /** Narrow metadata write for the pin extras; body/text never goes through here. */
  async updateNote(id, patch = {}) {
    if (!this.workspace?.notes?.[id]) return false;
    return this.#save(data => {
      const note = data.notes[id];
      if (!note) return;
      if (patch.attachment && typeof patch.attachment === "object" && !Array.isArray(patch.attachment)) {
        const current = resolveAttachment({ attachment: note.attachment });
        note.attachment = resolveAttachment({
          attachment: { ...current, ...patch.attachment }
        });
      }
      note.updatedAt = Date.now();
    });
  }

  /** @deprecated Kept for callers that still patch pin attachment fields. */
  setNotesAttachment(ids, fields = {}) {
    const targets = ids.filter(id => this.workspace?.notes?.[id]);
    if (!targets.length || !PIN_STYLES.includes(fields.pinStyle)) return false;
    return this.#save(data => {
      for (const id of targets) {
        const note = data.notes[id];
        if (!note) continue;
        const current = resolveAttachment({ attachment: note.attachment });
        note.attachment = resolveAttachment({
          attachment: { ...current, pinStyle: fields.pinStyle }
        });
        note.updatedAt = Date.now();
      }
    });
  }

  /** Short local lease around one private write (no GM, no shared preview). */
  async #withLease(noteId, action, { checkpoint = true } = {}) {
    const page = this.#page();
    if (!page || !this.workspace?.notes?.[noteId]) return null;
    const coordinator = new PrivateEditCoordinator({
      worldId: game.world?.id ?? "",
      userId: game.user?.id ?? "",
      workspacePageId: page.id,
      noteId
    });
    const transport = createPrivateTransport({
      privateStore,
      pageProvider: () => this.#page(),
      workspacePage: page,
      noteId,
      userId: game.user?.id ?? "",
      coordinator
    });
    let grant = null;
    try {
      grant = await transport.begin({ noteId });
      if (grant?.type !== "noteEditGranted") {
        ui.notifications?.warn(t("JN.Lock.LockedAction"));
        return null;
      }
      return await action(transport, grant);
    } finally {
      if (grant?.type === "noteEditGranted") {
        try {
          if (checkpoint) await transport.end({ noteId, lease: grant.lease });
          else coordinator.release();
        } catch (error) {
          console.error("Journalinator: private lease release failed", error);
        }
      }
    }
  }

  /** Layout/skin only; body, revision and links stay untouched. */
  async applyAppearance(ids, patch = {}) {
    const targets = (Array.isArray(ids) ? ids : []).filter(id => this.workspace?.notes?.[id]);
    if (!targets.length || !patch || typeof patch !== "object") return false;
    let applied = false;
    for (const noteId of targets) {
      const note = this.workspace.notes[noteId];
      const layout = patch.layout === "profile" || patch.layout === "plain"
        ? patch.layout
        : (note.layout === "profile" ? "profile" : "plain");
      const clean = {};
      for (const key of ["paper", "font", "torn", "backgroundImage"]) {
        if (Object.hasOwn(patch, key)) clean[key] = patch[key];
      }
      const skin = resolveSkin({ ...resolveSkin(note.skin), ...clean });
      const reply = await this.#withLease(noteId, transport => transport.appearance({
        noteId, layout, skin
      }), { checkpoint: false });
      if (reply?.type === "noteAppearanceAck") applied = true;
    }
    if (applied) {
      try { this.reloadWorkspace(); } catch { /* app handles incompatible reload */ }
      this.onSelectionChange(this.getSelectedNoteIds());
    }
    return applied;
  }

  async chooseBackground(ids) {
    const target = (Array.isArray(ids) ? ids : [])[0];
    const note = this.workspace?.notes?.[target];
    if (!note) return false;
    const current = resolveSkin(note.skin).backgroundImage ?? "";
    const { promptImageSource } = await import("./image-dialog.mjs");
    const src = await promptImageSource(
      t("JN.Skin.BackgroundImage"),
      current,
      t("JN.Skin.BackgroundHint")
    );
    if (src === null || src === undefined) return false;
    return this.applyAppearance([target], { backgroundImage: src.trim() || null });
  }

  /** Auto clears manual overrides; the stable origin is the rotated main-pin world point. */
  async autoSizeNotes(ids) {
    const targets = (Array.isArray(ids) ? ids : []).filter(id => this.workspace?.layout?.cards?.[id]);
    if (!targets.length) return false;
    return this.#save(data => {
      for (const noteId of targets) {
        const card = data.layout.cards[noteId];
        if (!card) continue;
        const note = data.notes[noteId];
        const measured = this.canvas.cardBox(noteId);
        const origin = validAutoOrigin(card.autoSizeOrigin)
          ? { ...card.autoSizeOrigin }
          : originFromBox(measured ?? this.#box(card, note), card.rotation ?? 0);
        card.sizing = { mode: "auto", width: null, minHeight: null };
        card.autoSizeOrigin = origin;
      }
    });
  }

  /** Checkbox click outside editing: one short private lease and one revisioned body save. */
  async toggleTask(noteId, index) {
    const note = this.workspace?.notes?.[noteId];
    if (!note) return false;
    const body = toggleTaskListItem(note.body ?? "", index);
    if (typeof body !== "string") return false;
    const reply = await this.#withLease(noteId, (transport, grant) => transport.save({
      noteId,
      lease: grant.lease,
      sequence: 1,
      baseRevision: Number.isInteger(grant.revision) ? grant.revision : note.revision,
      body
    }));
    if (reply?.type === "noteSaveAck") {
      try { this.reloadWorkspace(); } catch { /* app handles incompatible reload */ }
      return true;
    }
    return false;
  }

  /**
   * Private adapters for the shared history dialog. `recordPreRestore` writes the mandatory
   * checkpoint through the workspace CAS; the transport is rebuilt afterwards so its captured
   * workspace revision includes that checkpoint, then begin/save/end run through T7a.
   */
  #historySession(noteId) {
    const page = this.#page();
    let coordinator = null;
    let transport = null;
    const newTransport = () => {
      coordinator ??= new PrivateEditCoordinator({
        worldId: game.world?.id ?? "",
        userId: game.user?.id ?? "",
        workspacePageId: page?.id ?? "",
        noteId
      });
      transport = createPrivateTransport({
        privateStore,
        pageProvider: () => this.#page(),
        workspacePage: page,
        noteId,
        userId: game.user?.id ?? "",
        coordinator
      });
      return transport;
    };
    const request = async message => {
      if (!page) return { type: "timeout" };
      if (message?.type === "beginNoteEdit") {
        return newTransport().begin({ noteId });
      }
      if (message?.type === "saveNoteBody") {
        const active = transport ?? newTransport();
        if (!active.lease) await active.begin({ noteId });
        return active.save({
          noteId,
          lease: message.lease,
          sequence: message.sequence,
          baseRevision: Number.isInteger(message.baseRevision)
            ? message.baseRevision
            : privateStore.read(this.#page()).notes[noteId]?.revision ?? 0,
          body: message.body
        });
      }
      if (message?.type === "endNoteEdit") {
        if (!transport) return { type: "noteEditEnded", noteId, released: false, saved: false };
        return transport.end({
          noteId,
          lease: message.lease,
          sequence: message.sequence,
          baseRevision: message.baseRevision,
          body: message.body
        });
      }
      return { type: "timeout" };
    };
    const recordPreRestore = async (targetNoteId, body, revision, authorId) => {
      const currentPage = this.#page();
      if (!currentPage || targetNoteId !== noteId) return;
      const status = privateStore.inspectWorkspace(currentPage);
      if (!status.ok) throw new Error(t("JN.Notices.Incompatible"));
      const result = await privateStore.recordPreRestore(currentPage, noteId, {
        body,
        revision: Number.isInteger(revision) ? revision : 0,
        authorId: authorId || game.user?.id || "",
        at: Date.now()
      }, { expectedRev: status.rev });
      // The checkpoint moved the workspace rev; the restore save must re-begin on the new data.
      transport = null;
      return result;
    };
    return { request, recordPreRestore };
  }

  /** Shared history modal with workspace-local adapters; never touches shared history. */
  openHistory(noteId) {
    const page = this.page;
    const note = this.getNote(noteId);
    if (!page || !note) return null;
    const adapters = this.#historySession(noteId);
    return openHistoryDialog({
      noteId,
      note,
      list: () => privateStore.listHistory(page, noteId),
      recordPreRestore: adapters.recordPreRestore,
      requestEditReply: adapters.request,
      currentAuthorId: game.user?.id ?? "",
      isLocked: () => false,
      notify: (level, message) => ui.notifications?.[level]?.(message),
      onRestored: () => {
        try { this.reloadWorkspace(); } catch { /* app handles incompatible reload */ }
        this.onChange();
      },
      t
    });
  }

  moveCard(id, x, y) {
    const card = this.workspace?.layout?.cards?.[id];
    if (!card || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    return this.#save(data => {
      const target = data.layout.cards[id];
      if (!target) return;
      const dx = x - (target.x ?? 0);
      const dy = y - (target.y ?? 0);
      const note = data.notes[id];
      const measured = this.canvas.cardBox(id);
      const origin = validAutoOrigin(target.autoSizeOrigin)
        ? target.autoSizeOrigin
        : originFromBox(measured ?? this.#box(target, note), target.rotation ?? 0);
      target.x = x;
      target.y = y;
      target.autoSizeOrigin = { x: origin.x + dx, y: origin.y + dy };
    });
  }

  moveCards(moves) {
    if (!Array.isArray(moves) || !moves.length) return false;
    return this.#save(data => {
      for (const move of moves) {
        const target = data.layout.cards[move?.noteId];
        if (!target || !Number.isFinite(move.x) || !Number.isFinite(move.y)) continue;
        const dx = move.x - (target.x ?? 0);
        const dy = move.y - (target.y ?? 0);
        const measured = this.canvas.cardBox(move.noteId);
        const origin = validAutoOrigin(target.autoSizeOrigin)
          ? target.autoSizeOrigin
          : originFromBox(measured ?? this.#box(target, data.notes[move.noteId]), target.rotation ?? 0);
        target.x = move.x;
        target.y = move.y;
        target.autoSizeOrigin = { x: origin.x + dx, y: origin.y + dy };
      }
    });
  }

  /** Resize enters manual sizing; automatic origin is retained for a later Auto toggle. */
  resizeCard(id, width, height) {
    if (!this.workspace?.layout?.cards?.[id]) return false;
    return this.#save(data => {
      const card = data.layout.cards[id];
      if (!card) return;
      card.sizing = {
        mode: "manual",
        width: clamp(width, 160, 800, 300),
        minHeight: clamp(height, 80, 1600, 120)
      };
    });
  }

  deleteNotes(ids) {
    const noteIds = ids.filter(id => this.workspace?.notes?.[id]);
    if (!noteIds.length) return false;
    const undoId = foundry.utils.randomID();
    const deletedAt = Date.now();
    return this.#save(data => {
      for (const id of noteIds) {
        const note = data.notes[id];
        if (!note) continue;
        // History stays with the trash entry; only permanent deletion removes it.
        data.trash.unshift({ note, card: data.layout.cards[id] ?? null, deletedAt, undoId });
        delete data.notes[id];
        delete data.layout.cards[id];
      }
    }).then(ok => {
      if (!ok) return false;
      this.history.push({ noteIds, undoId });
      if (this.history.length > 20) this.history.shift();
      if (noteIds.includes(this.selectedNoteId)) this.selectedNoteId = null;
      this.canvas.clearSelection();
      ui.notifications?.info(t("JN.Delete.Notice", { count: noteIds.length }));
      this.onChange();
      return true;
    });
  }

  async deleteSelected() {
    const labelIds = this.getSelectedLabelIds();
    const noteIds = this.getSelectedNoteIds();
    if (!labelIds.length && !noteIds.length) return;
    if (noteIds.length > 1) {
      if (this.deleteConfirmPending) return;
      this.deleteConfirmPending = true;
      let confirmed;
      try {
        confirmed = await DialogV2.confirm({
          window: { title: t("JN.Delete.ConfirmTitle") },
          content: `<p>${t("JN.Delete.ConfirmMultiplePrivate", { count: noteIds.length })}</p>`
        });
      } finally {
        this.deleteConfirmPending = false;
      }
      if (!confirmed) return;
    }
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
    if (noteIds.length) ui.notifications?.info(t("JN.Delete.Notice", { count: noteIds.length }));
    this.onChange();
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

  async restoreTrash(key) {
    await this.#save(data => {
      const keep = [];
      for (const entry of data.trash) {
        const matches = entry.undoId === key || (!entry.undoId && entry.note?.id === key);
        if (key && !matches) { keep.push(entry); continue; }
        data.notes[entry.note.id] = entry.note;
        if (entry.card) data.layout.cards[entry.note.id] = entry.card;
      }
      data.trash = keep;
    });
    this.onChange();
  }

  /** Emptying the trash permanently deletes those notes and their private history. */
  async emptyTrash() {
    const ids = (this.workspace?.trash ?? []).map(entry => entry?.note?.id).filter(Boolean);
    await this.#save(data => {
      data.trash = [];
      if (ids.length) {
        const result = deletePrivateHistory(data, ids);
        data.history = result.workspace.history;
      }
    });
    this.onChange();
  }

  async openTrash() {
    const trashed = (this.workspace?.trash ?? [])
      .filter(entry => entry?.note?.id)
      .map(entry => ({ ...entry, key: entry.undoId ?? entry.note.id }));
    const grouped = new Map();
    for (const entry of trashed) {
      if (!grouped.has(entry.key)) grouped.set(entry.key, []);
      grouped.get(entry.key).push(entry);
    }
    const rows = [...grouped].map(([key, entries]) => {
      const note = entries[0]?.note;
      const view = note ? privateStore.noteView(this.page, note) : null;
      const label = view ? noteSearchLabel(view) : t("JN.Search.EmptyNote");
      const excerpt = view ? noteSearchExcerpt(view) : "";
      const author = view ? noteAuthorName(view) : "";
      const created = view ? noteDateText(view, "created") : "";
      const deletedAt = entries.find(entry => Number.isFinite(entry.deletedAt))?.deletedAt;
      const date = Number.isFinite(deletedAt)
        ? new Date(deletedAt).toLocaleString(game.i18n?.lang || undefined) : "";
      const meta = date
        ? t("JN.Trash.DeletedByYouAt", { date: esc(date) })
        : t("JN.Trash.MetadataUnknown");
      const details = [excerpt, author, created].filter(Boolean).join(" · ");
      return `
      <div class="jn-trash-row">
        <span class="jn-trash-title">${esc(label)}</span>
        ${details ? `<span class="jn-trash-excerpt">${esc(details)}</span>` : ""}
        <span class="jn-trash-meta">${meta}</span>
        <button type="button" class="jn-trash-restore" data-id="${key}">${t("JN.Common.Restore")}</button></div>`;
    }).join("") || `<p class="journalinator-empty">${t("JN.Trash.Empty")}</p>`;
    await DialogV2.wait({
      window: { title: t("JN.Trash.Title") },
      content: (grouped.size ? `<p class="jn-trash-hint">${t("JN.Trash.RecoverableHint")}</p>` : "")
        + `<div class="jn-trash-list">${rows}</div>` +
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

  /** In-memory v2 clipboard for the private canvas. */
  copyNotes(ids) {
    const entries = (Array.isArray(ids) ? ids : [])
      .map(id => this.workspace?.notes?.[id])
      .filter(Boolean)
      .map(note => ({
        body: note.body,
        layout: note.layout,
        skin: resolveSkin(note.skin)
      }));
    if (!entries.length) return false;
    this.clipboard = entries;
    this.onCopy?.(entries);
    ui.notifications?.info(t("JN.Clipboard.Copied", { count: entries.length }));
    return true;
  }

  async pasteNotes(entries, { x = 0, y = 0 } = {}) {
    if (!this.page || !Array.isArray(entries) || !entries.length) return [];
    const ids = [];
    const ok = await this.#save(data => {
      for (const entry of entries) {
        const { note, card } = privateStore.makeNote({
          body: typeof entry?.body === "string" ? entry.body : "",
          layout: entry?.layout === "profile" ? "profile" : "plain",
          skin: entry?.skin ?? null,
          x, y,
          cards: data.layout.cards,
          notes: data.notes
        });
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

  async pasteClipboard(position = {}) {
    if (!this.clipboard.length) return [];
    return this.pasteNotes(this.clipboard, position);
  }

  destroy() {
    void this.editor.destroy();
    this.canvas.disconnectGeometry();
    this.canvas.root.remove();
    this.editor.root.remove();
  }

  #anchorPoint(value) {
    return Math.min(1, Math.max(0, value));
  }

  /** Pins are an optional world feature; an unset legacy setting still means enabled. */
  #pinsEnabled() {
    try {
      return game.settings?.get?.("fvtt-journalinator", "pinsEnabled") !== false;
    } catch {
      return true;
    }
  }

  /** Own/valid anchor on a private card, never a prototype or dotted-path lookup. */
  #cardAnchor(card, anchorId) {
    return validAnchorId(anchorId) && card?.anchors && Object.hasOwn(card.anchors, anchorId)
      ? card.anchors[anchorId] : null;
  }

  /**
   * True when any private link (including a trashed note's link, which returns on restore)
   * references this note's canonical main anchor as an endpoint or route waypoint.
   */
  #mainPinReferenced(noteId, data = this.workspace) {
    if (!data || !noteId) return false;
    const owners = [
      ...Object.values(data.notes ?? {}),
      ...(data.trash ?? []).map(entry => entry?.note).filter(Boolean)
    ];
    for (const note of owners) {
      for (const link of note.links ?? []) {
        if (note.id === noteId && link.sourceAnchorId === "main") return true;
        if (link.targetId === noteId && link.targetAnchorId === "main") return true;
        if ((link.routeAnchors ?? []).some(entry =>
          entry?.noteId === noteId && entry?.anchorId === "main")) return true;
      }
    }
    return false;
  }

  /** A minor anchor is safe to delete only when no private link still names it. */
  #anchorReferenced(noteId, anchorId, data) {
    const owners = [
      ...Object.values(data.notes ?? {}),
      ...(data.trash ?? []).map(entry => entry?.note).filter(Boolean)
    ];
    for (const note of owners) {
      for (const link of note.links ?? []) {
        if (note.id === noteId && link.sourceAnchorId === anchorId) return true;
        if (link.targetId === noteId && link.targetAnchorId === anchorId) return true;
        if ((link.routeAnchors ?? []).some(entry =>
          entry?.noteId === noteId && entry?.anchorId === anchorId)) return true;
      }
    }
    return false;
  }

  /**
   * Applies one anchor reference/spec pair from a canvas link gesture. Existing ids win; a new
   * minor spec is materialized locally because private workspaces have no GM write authority
   * round-trip. A spec landing on an existing minor reuses that pin instead of stacking another.
   * Returns the anchor id (or "" when neither is usable).
   */
  #linkAnchor(data, noteId, anchorId, spec) {
    const card = data.layout.cards[noteId];
    if (!card) return "";
    if (validAnchorId(anchorId) && this.#cardAnchor(card, anchorId)) return anchorId;
    // With pins disabled, existing anchors remain usable render data but a link gesture must not
    // silently materialize a new minor. The plain point/side fallback is used instead.
    if (!this.#pinsEnabled()) return "";
    if (spec?.kind !== "minor" || !Number.isFinite(spec.x) || !Number.isFinite(spec.y)) return "";
    const box = this.#box(card, data.notes[noteId]);
    const reuse = nearestMinorAnchor(box, card.anchors ?? {}, spec);
    if (reuse) return reuse.id;
    const anchors = { ...(card.anchors ?? {}) };
    if (Object.keys(anchors).length >= MAX_CARD_ANCHORS) return "";
    const id = `minor-${foundry.utils.randomID()}`;
    const point = minorOnEdge(spec, box);
    anchors[id] = {
      kind: "minor",
      x: point.x,
      y: point.y,
      createdBy: this.page ? privateStore.ownerId(this.page) || "" : ""
    };
    card.anchors = anchors;
    return id;
  }

  async createLink(sourceId, targetId, ports) {
    if (sourceId === targetId) return;
    return this.#save(data => {
      const source = data.notes[sourceId];
      if (!source || !data.notes[targetId]) return;
      const anchors = linkAnchors(ports);
      const sourceAnchorId = this.#linkAnchor(data, sourceId, ports?.sourceAnchorId, ports?.sourceAnchor);
      const targetAnchorId = this.#linkAnchor(data, targetId, ports?.targetAnchorId, ports?.targetAnchor);
      const external = { sourceAnchorId, targetAnchorId };
      const existing = source.links.find(link => link.targetId === targetId);
      if (existing) {
        if (!anchors.sourcePoint || !anchors.targetPoint) return;
        Object.assign(existing, anchors, external, { origin: "drawn", edited: true });
        return;
      }
      source.links.push({
        id: foundry.utils.randomID(), targetId, ...anchors, ...external,
        ...defaultLinkCosmetics(), routeAnchors: [],
        label: "", direction: "one", color: "", lineStyle: "solid",
        origin: "drawn", edited: false, createdBy: this.page ? privateStore.ownerId(this.page) || "" : ""
      });
    });
  }

  async boardPinAction(action) {
    if (!this.workspace || !["add", "move", "connect", "delete", "updateLink", "deleteLink"].includes(action?.type)) return false;
    return this.#save(data => {
      const layout = data.layout;
      layout.pins ??= {};
      layout.pinLinks ??= {};
      const boxes = new Map(Object.entries(layout.cards).map(([id, card]) => [
        id, this.#box(card, data.notes[id])
      ]));
      if (action.type === "add") {
        if (action.noteId && !layout.cards[action.noteId]) return;
        if (!validPinPosition(action.noteId, action.x, action.y)) return;
        const id = foundry.utils.randomID();
        layout.pins[id] = { noteId: action.noteId ?? "", x: action.x, y: action.y,
          isDefault: false };
        return;
      }
      if (action.type === "connect") {
        if (action.source === action.target || !resolvePin(action.source, layout, boxes)
            || !resolvePin(action.target, layout, boxes)) return;
        if (Object.values(layout.pinLinks).some(link => link.source === action.source
            && link.target === action.target || link.source === action.target
            && link.target === action.source)) return;
        layout.pinLinks[foundry.utils.randomID()] = normalizePinLink({ source: action.source, target: action.target });
        return;
      }
      if (action.type === "updateLink" || action.type === "deleteLink") {
        if (!layout.pinLinks[action.linkId]) return;
        if (action.type === "deleteLink") delete layout.pinLinks[action.linkId];
        else layout.pinLinks[action.linkId] = normalizePinLink(layout.pinLinks[action.linkId], action.fields);
        return;
      }
      if (action.type === "delete") {
        const ref = action.ref;
        if (typeof ref !== "string") return;
        let oldNoteId = "", anchorId = "";
        if (ref.startsWith("p:")) {
          const id = ref.slice(2);
          if (!layout.pins[id] || layout.pins[id].isDefault) return;
          delete layout.pins[id];
        } else if (ref.startsWith("n:")) {
          const split = ref.indexOf(":", 2);
          oldNoteId = ref.slice(2, split);
          anchorId = ref.slice(split + 1);
          const anchors = layout.cards[oldNoteId]?.anchors;
          if (split < 0 || anchors?.[anchorId]?.kind !== "minor") return;
          delete anchors[anchorId];
        } else return;
        for (const [id, link] of Object.entries(layout.pinLinks)) {
          if (link.source === ref || link.target === ref) delete layout.pinLinks[id];
        }
        for (const note of Object.values(data.notes)) {
          note.links = (note.links ?? []).filter(link => link.sourcePinRef !== ref
            && link.targetPinRef !== ref
            && !(note.id === oldNoteId && link.sourceAnchorId === anchorId)
            && !(link.targetId === oldNoteId && link.targetAnchorId === anchorId));
        }
        return;
      }
      if (action.noteId && !layout.cards[action.noteId]) return;
      if (!validPinPosition(action.noteId, action.x, action.y)) return;
      const ref = action.ref;
      let id = ref?.startsWith("p:") ? ref.slice(2) : "";
      if (!id && ref?.startsWith("n:")) {
        const split = ref.indexOf(":", 2);
        const oldNoteId = ref.slice(2, split), anchorId = ref.slice(split + 1);
        const card = layout.cards[oldNoteId], anchor = card?.anchors?.[anchorId];
        if (!anchor || anchor.kind !== "minor") return;
        id = foundry.utils.randomID();
        delete card.anchors[anchorId];
        const newRef = boardPinRef(id);
        for (const note of Object.values(data.notes)) for (const link of note.links ?? []) {
          if (note.id === oldNoteId && link.sourceAnchorId === anchorId) {
            link.sourcePinRef = newRef;
            link.sourceAnchorId = "";
          }
          if (link.targetId === oldNoteId && link.targetAnchorId === anchorId) {
            link.targetPinRef = newRef;
            link.targetAnchorId = "";
          }
        }
        for (const link of Object.values(layout.pinLinks)) {
          if (link.source === ref) link.source = newRef;
          if (link.target === ref) link.target = newRef;
        }
      } else if (!layout.pins[id]) return;
      layout.pins[id] = { noteId: action.noteId ?? "", x: action.x, y: action.y,
        isDefault: false };
    });
  }

  async addCardAnchor(noteId, anchor = {}) {
    const card = this.workspace?.layout?.cards?.[noteId];
    if (!card) return null;
    if (anchor.kind !== "minor" || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return null;
    if (Object.keys(card.anchors ?? {}).length >= MAX_CARD_ANCHORS) return null;
    const currentBox = this.#box(card, this.workspace.notes[noteId]);
    const reuse = nearestMinorAnchor(currentBox,
      card.anchors ?? {}, minorOnEdge(anchor, currentBox));
    if (reuse) return reuse.id;
    const id = `minor-${foundry.utils.randomID()}`;
    const ok = await this.#save(data => {
      const target = data.layout.cards[noteId];
      if (!target) return;
      const anchors = { ...(target.anchors ?? {}) };
      if (Object.keys(anchors).length >= MAX_CARD_ANCHORS) return;
      const point = minorOnEdge(anchor, this.#box(target, data.notes[noteId]));
      anchors[id] = {
        kind: "minor",
        x: point.x,
        y: point.y,
        createdBy: this.page ? privateStore.ownerId(this.page) || "" : ""
      };
      target.anchors = anchors;
    });
    return ok ? id : null;
  }

  async moveCardAnchor(noteId, anchorId, x, y) {
    if (!validAnchorId(anchorId) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    return this.#save(data => {
      const card = data.layout.cards[noteId];
      const anchor = this.#cardAnchor(card, anchorId);
      if (!anchor || anchor.kind === "main") return;
      const box = this.#box(card, data.notes[noteId]);
      const moved = minorOnEdge({ ...anchor, x, y }, box);
      const anchors = { ...(card.anchors ?? {}) };
      anchors[anchorId] = moved;
      card.anchors = anchors;
      const side = anchorSide(moved, box);
      // Keep every private link (including a trashed owner's, which returns on restore) pointing
      // at the moved anchor through its normalized point/side fallback.
      const owners = [
        ...Object.values(data.notes ?? {}),
        ...(data.trash ?? []).map(entry => entry?.note).filter(Boolean)
      ];
      for (const owner of owners) {
        for (const link of owner.links ?? []) {
          if (owner.id === noteId && link.sourceAnchorId === anchorId) {
            link.sourcePoint = { x: moved.x, y: moved.y };
            if (side) link.sourceSide = side;
          }
          if (link.targetId === noteId && link.targetAnchorId === anchorId) {
            link.targetPoint = { x: moved.x, y: moved.y };
            if (side) link.targetSide = side;
          }
        }
      }
    });
  }

  async removeCardAnchor(noteId, anchorId) {
    if (!validAnchorId(anchorId) || !this.workspace?.layout?.cards?.[noteId]) return false;
    if (this.#anchorReferenced(noteId, anchorId, this.workspace)) return false;
    return this.#save(data => {
      const card = data.layout.cards[noteId];
      const anchor = this.#cardAnchor(card, anchorId);
      if (!card || !anchor || anchor.kind === "main") return;
      if (this.#anchorReferenced(noteId, anchorId, data)) return;
      const anchors = { ...(card.anchors ?? {}) };
      delete anchors[anchorId];
      card.anchors = anchors;
    });
  }

  async setMainPinEnabled(noteId, enabled) {
    if (typeof enabled !== "boolean" || !this.workspace?.notes?.[noteId]) return false;
    if (!this.#pinsEnabled()) return false;
    // Private workspaces have no link-redistribution engine. Disabling while links still point
    // at `main` would leave them dangling forever, so this remains a shared-canvas-only action;
    // the editor qualifies the toggle instead of pretending it works here.
    if (!enabled && this.#mainPinReferenced(noteId)) {
      ui.notifications?.warn(t("JN.Pin.PrivateSharedOnly"));
      return false;
    }
    return this.updateNote(noteId, { attachment: { mainPinEnabled: enabled } });
  }

  async updateLink(noteId, linkId, fields = {}) {
    return this.#save(data => {
      const link = data.notes[noteId]?.links.find(item => item.id === linkId);
      if (!link) return;
      const sourceCard = data.layout.cards[noteId];
      const targetCard = data.layout.cards[link.targetId];
      const sourceAnchorChange = typeof fields.sourceAnchorId === "string";
      const targetAnchorChange = typeof fields.targetAnchorId === "string";
      // Reject a dotted/prototype/malformed id before any cosmetic field is applied. A valid id
      // that simply has no local pin yet is kept as legacy data (its fallback point/side stays).
      if (sourceAnchorChange && fields.sourceAnchorId !== ""
          && !validAnchorId(fields.sourceAnchorId)) return;
      if (targetAnchorChange && fields.targetAnchorId !== ""
          && !validAnchorId(fields.targetAnchorId)) return;
      if (typeof fields.label === "string") link.label = fields.label.slice(0, 200);
      if (["none", "one", "two"].includes(fields.direction)) link.direction = fields.direction;
      if (isLinkColor(fields.color)) link.color = normalizeLinkColor(fields.color);
      if (fields.lineStyle === "solid" || fields.lineStyle === "dashed") link.lineStyle = fields.lineStyle;
      if (LINK_MATERIALS.includes(fields.material)) link.material = fields.material;
      if (Number.isFinite(fields.thickness)) {
        link.thickness = Math.min(LINK_THICKNESS.max, Math.max(LINK_THICKNESS.min, fields.thickness));
      }
      if (Number.isFinite(fields.slack)) {
        link.slack = Math.min(LINK_SLACK.max, Math.max(LINK_SLACK.min, fields.slack));
      }
      if (LINK_PATTERNS.includes(fields.pattern)) {
        link.pattern = fields.pattern;
        if (fields.lineStyle === undefined) {
          link.lineStyle = fields.pattern === "interrupted" ? "dashed" : "solid";
        }
      }
      if (LINK_ENDS.includes(fields.ends)) link.ends = fields.ends;
      if (typeof fields.secondaryColor === "string") {
        link.secondaryColor = isLinkColor(fields.secondaryColor)
          ? normalizeLinkColor(fields.secondaryColor) : "";
      }
      // Anchor ids are cosmetic attachment points; link identity and target are never editable
      // here. A changed anchor also refreshes its point/side fallback for hidden/later exports.
      if (sourceAnchorChange) {
        link.sourceAnchorId = fields.sourceAnchorId;
        const anchor = this.#cardAnchor(sourceCard, fields.sourceAnchorId);
        if (anchor) {
          link.sourcePoint = { x: anchor.x, y: anchor.y };
          link.sourceSide = anchorSide(anchor, this.#box(sourceCard, data.notes[noteId]));
        }
      }
      if (targetAnchorChange) {
        link.targetAnchorId = fields.targetAnchorId;
        const anchor = this.#cardAnchor(targetCard, fields.targetAnchorId);
        if (anchor) {
          link.targetPoint = { x: anchor.x, y: anchor.y };
          link.targetSide = anchorSide(anchor, this.#box(targetCard, data.notes[link.targetId]));
        }
      }
      const pins = moveThreadPin(link.pins, fields.pinMove);
      if (pins) link.pins = pins;
      link.edited = true;
    });
  }

  async deleteLink(noteId, linkId) {
    return this.#save(data => {
      const note = data.notes[noteId];
      if (note) note.links = note.links.filter(link => link.id !== linkId);
      const owners = [...Object.values(data.notes ?? {}),
        ...(data.trash ?? []).map(entry => entry?.note).filter(Boolean)];
      for (const { noteId: id, anchors } of pruneAnchorRegistry(data.layout.cards, owners)) {
        data.layout.cards[id].anchors = anchors;
      }
    });
  }

}
