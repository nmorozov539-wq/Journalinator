import JournalCanvas from "./canvas.mjs";
import PrivateNoteEditor from "./private-editor.mjs";
import { privateStore, MAX_TITLE_LENGTH } from "../store/private-store.mjs";
import { CARD_STYLES } from "../styles/registry.mjs";
import { linkAnchors, moveThreadPin } from "../card-ports.mjs";
import { anchorSide, validAnchorId } from "../anchors.mjs";
import { isLinkColor, normalizeLinkColor } from "../link-colors.mjs";
import {
  LINK_ENDS, LINK_MATERIALS, LINK_PATTERNS, LINK_SLACK, LINK_THICKNESS, MAX_CARD_ANCHORS,
  NOTE_FONT_KEYS, PICTURE_LAYOUTS, PIN_STYLES, PRESENTATION_STYLES,
  defaultLinkCosmetics, isGeneratedTitle, legacyStylePresentation, resolveAttachment,
  resolvePresentation, sanitizeCardAnchors, stripSecretPrefix
} from "../presentation.mjs";
import { noteCreationPresentation, noteCreationStyle } from "./note-dialog.mjs";
import { attachedStampIds, DEFAULT_STAMP_CORNER, isStampCorner, STAMP_COLORS, stampUrl } from "../stamps.mjs";
import { toggleTaskListItem } from "../markdown.mjs";
import { t } from "../i18n.mjs";

const { DialogV2 } = foundry.applications.api;
const esc = text => foundry.utils.escapeHTML(String(text ?? ""));

/** The private tab's canvas, editor, selection, trash, and clipboard actions. */
export default class PrivateWorkspace {
  constructor({ onChange, onSelectionChange } = {}) {
    this.onChange = onChange ?? (() => {});
    this.onSelectionChange = onSelectionChange ?? (() => {});
    this.page = null;
    this.workspace = null;
    this.selectedNoteId = null;
    this.history = [];
    this.deleteConfirmPending = false;
    this.dimMatch = () => true;

    this.canvas = new JournalCanvas({
      onSelectNote: id => {
        this.selectedNoteId = id;
        this.editor.open(id);
        this.editor.render();
        this.onSelectionChange(this.getSelectedNoteIds());
      },
      onReadCardText: (id, kind) => {
        const note = this.getNote(id);
        if (!note) return "";
        if (kind === "heading") return note.system.targetHeading;
        if (kind === "label") return note.system.label ?? "";
        return note.name;
      },
      onSaveCardText: (id, kind, value) => {
        if (kind === "heading") return this.updateNote(id, { targetHeading: value });
        if (kind === "label") return this.updateNote(id, { label: value });
        return this.updateNote(id, { title: value });
      },
      onEditCardBlock: (id, blockId, slot) => this.editor.editBoardBlock(id, blockId, slot),
      onEditCardImage: id => this.editor.editNoteImage(id),
      onEditCardBackground: id => this.editor.editNoteImage(id, true),
      onEditNote: id => {
        this.selectedNoteId = id;
        this.editor.open(id);
        this.editor.render();
        const slot = this.canvas.cardEls.get(id)?.querySelector(".jn-card-block");
        if (slot && this.selectedNoteId === id) this.editor.editFirstBlock(id, slot);
      },
      onCreateNoteAt: options => this.createNoteAt(options),
      onMoveCard: (id, x, y) => this.moveCard(id, x, y),
      onResizeCard: (id, width, height) => this.resizeCard(id, width, height),
      onResetCardSize: id => this.resizeCard(id, null, null),
      onToggleTask: (id, blockId, index) => this.toggleTask(id, blockId, index),
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
      onSetPresentation: (ids, fields) => this.setNotesPresentation(ids, fields),
      onSetAttachment: (ids, fields) => this.setNotesAttachment(ids, fields)
    });

    this.editor = new PrivateNoteEditor({
      getNote: id => this.getNote(id),
      updateNote: (id, patch) => this.updateNote(id, patch),
      deleteNote: id => this.deleteNotes([id]),
      getBacklinks: id => this.getBacklinks(id),
      onFocusNote: id => this.focusNote(id),
      // Private main-pin disabling is shared-canvas-only: links cannot be redistributed locally,
      // so the toggle is qualified/disabled while any private link references this main pin.
      mainPinLocked: id => this.#mainPinReferenced(id),
      setMainPinEnabled: (id, enabled) => this.setMainPinEnabled(id, enabled)
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

  notes() {
    return this.page && this.workspace ? privateStore.noteViews(this.page, this.workspace) : [];
  }

  layout() {
    return this.workspace?.layout ?? { cards: {}, labels: {}, viewport: null };
  }

  getNote(id) {
    if (!this.page || !this.workspace || !id) return null;
    const note = this.workspace.notes[id];
    return note ? privateStore.noteView(this.page, note) : null;
  }

  getBacklinks(noteId) {
    if (!this.workspace?.notes?.[noteId]) return [];
    const found = new Map();
    for (const note of Object.values(this.workspace.notes)) {
      if (note.id === noteId) continue;
      if (note.links?.some(link => link.targetId === noteId)) found.set(note.id, note.title);
    }
    const self = this.workspace.notes[noteId];
    for (const link of self.links ?? []) {
      const target = this.workspace.notes[link.targetId];
      if (target) found.set(target.id, target.title);
    }
    return [...found].map(([id, name]) => ({ id, name }));
  }

  renderInto(canvasSlot, editorSlot) {
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
    this.editor.open(this.selectedNoteId);
    this.editor.mount(editorSlot);
    this.editor.render();
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

  async #save(mutator) {
    if (!this.page) return false;
    const rev = privateStore.flags(this.page).rev ?? 0;
    const data = foundry.utils.deepClone(this.workspace);
    try {
      mutator(data);
      const result = await privateStore.save(this.page, data, rev);
      this.workspace = result.workspace;
      this.onChange();
      return true;
    } catch (err) {
      ui.notifications?.warn(err.message);
      this.setPage(privateStore.findById(this.page.id));
      this.onChange();
      return false;
    }
  }

  async createNoteAt({
    x = 0, y = 0, style, kind = "note", title = "", immediate = false, presentation, label = ""
  } = {}) {
    if (!this.page) return null;
    const cards = this.workspace?.layout?.cards ?? {};
    const resolvedStyle = noteCreationStyle({ kind, style, presentation });
    const fields = noteCreationPresentation({ kind, style, presentation });
    const { note, card } = privateStore.makeNote({
      title, kind, style: resolvedStyle, x, y, cards, notes: this.workspace?.notes ?? {}
    });
    const noteLabel = typeof label === "string" ? label : "";
    const resolved = resolvePresentation({
      name: note.title,
      system: { ...note, label: noteLabel, presentation: { ...(note.presentation ?? {}), ...fields } }
    });
    const { label: _ignored, ...presentationFields } = resolved;
    note.label = noteLabel;
    note.presentation = presentationFields;
    note.schemaVersion = 1;
    const ok = await this.#save(data => {
      data.notes[note.id] = note;
      data.layout.cards[note.id] = card;
    });
    if (!ok) return null;
    this.selectedNoteId = note.id;
    this.onChange();
    return note.id;
  }

  async updateNote(id, patch) {
    if (!this.workspace?.notes?.[id]) return false;
    return this.#save(data => {
      const note = data.notes[id];
      if (!note) return;
      const oldTitle = String(note.title ?? "");
      const oldBare = stripSecretPrefix(oldTitle).trim();
      const resolved = resolvePresentation({ name: oldTitle, system: note });
      const { label: resolvedLabel, ...presentationFields } = resolved;
      let label = resolvedLabel;
      let presentationTouched = false;
      let labelTouched = false;
      const presentation = { ...presentationFields };

      if (typeof patch.title === "string") {
        const title = patch.title.slice(0, 200);
        note.title = title;
        if (!isGeneratedTitle(title)) {
          presentation.nameGenerated = false;
          if (!label || label === oldBare) label = stripSecretPrefix(title).trim();
          presentationTouched = true;
        }
      }
      if (typeof patch.label === "string") {
        label = patch.label.slice(0, MAX_TITLE_LENGTH);
        labelTouched = true;
      }
      if (patch.presentation && typeof patch.presentation === "object") {
        const fields = patch.presentation;
        if (PRESENTATION_STYLES.includes(fields.extendedStyle)) presentation.extendedStyle = fields.extendedStyle;
        if (NOTE_FONT_KEYS.includes(fields.font)) presentation.font = fields.font;
        if (PICTURE_LAYOUTS.includes(fields.pictureLayout)) presentation.pictureLayout = fields.pictureLayout;
        if (typeof fields.forceExtended === "boolean") presentation.forceExtended = fields.forceExtended;
        if (typeof fields.torn === "boolean") presentation.torn = fields.torn;
        if (typeof fields.heading === "string") presentation.heading = fields.heading.slice(0, 80);
        if (typeof fields.nameGenerated === "boolean") presentation.nameGenerated = fields.nameGenerated;
        presentationTouched = true;
      }
      if (typeof patch.targetHeading === "string") {
        note.targetHeading = patch.targetHeading.slice(0, 80);
        presentation.heading = note.targetHeading.trim();
        presentationTouched = true;
      }
      if (patch.kind === "note" || patch.kind === "location") note.kind = patch.kind;
      if (Object.hasOwn(CARD_STYLES, patch.style)) {
        note.style = patch.style;
        Object.assign(presentation, legacyStylePresentation(patch.style));
        presentationTouched = true;
      }
      if (presentationTouched || labelTouched) {
        note.presentation = presentation;
        note.label = label.slice(0, MAX_TITLE_LENGTH);
        note.schemaVersion = 1;
      }
      if ("image" in patch) note.image = patch.image;
      if ("backgroundImage" in patch) note.backgroundImage = patch.backgroundImage;
      if (patch.attachment && typeof patch.attachment === "object" && !Array.isArray(patch.attachment)) {
        const current = resolveAttachment({ system: { attachment: note.attachment } });
        note.attachment = resolveAttachment({
          system: { attachment: { ...current, ...patch.attachment } }
        });
        note.schemaVersion = 1;
      }
      if (Array.isArray(patch.blocks) && patch.blocks.length) note.blocks = patch.blocks;
      note.updatedAt = Date.now();
    });
  }

  /**
   * Cosmetic presentation batch for the floating toolbar. One save for the whole selection and
   * only the allowlisted presentation fields; labels, blocks, images and links stay untouched.
   */
  setNotesPresentation(ids, fields = {}) {
    const targets = ids.filter(id => this.workspace?.notes?.[id]);
    if (!targets.length || !fields || typeof fields !== "object") return false;
    const allowed = {};
    if (PRESENTATION_STYLES.includes(fields.extendedStyle)) allowed.extendedStyle = fields.extendedStyle;
    if (NOTE_FONT_KEYS.includes(fields.font)) allowed.font = fields.font;
    if (PICTURE_LAYOUTS.includes(fields.pictureLayout)) allowed.pictureLayout = fields.pictureLayout;
    if (typeof fields.torn === "boolean") allowed.torn = fields.torn;
    if (typeof fields.forceExtended === "boolean" && targets.length === 1) {
      allowed.forceExtended = fields.forceExtended;
    }
    if (!Object.keys(allowed).length) return false;
    return this.#save(data => {
      for (const id of targets) {
        const note = data.notes[id];
        if (!note) continue;
        const resolved = resolvePresentation({ name: note.title, system: note });
        const { label: _ignored, ...presentationFields } = resolved;
        note.presentation = { ...presentationFields, ...allowed };
        note.schemaVersion = 1;
        note.updatedAt = Date.now();
      }
    });
  }

  /** Cosmetic pin appearance only; pin enable and snap radii stay out of bulk edits. */
  setNotesAttachment(ids, fields = {}) {
    const targets = ids.filter(id => this.workspace?.notes?.[id]);
    if (!targets.length || !PIN_STYLES.includes(fields.pinStyle)) return false;
    return this.#save(data => {
      for (const id of targets) {
        const note = data.notes[id];
        if (!note) continue;
        const current = resolveAttachment({ system: { attachment: note.attachment } });
        note.attachment = resolveAttachment({
          system: { attachment: { ...current, pinStyle: fields.pinStyle } }
        });
        note.schemaVersion = 1;
        note.updatedAt = Date.now();
      }
    });
  }

  toggleTask(noteId, blockId, index) {
    const note = this.workspace?.notes?.[noteId];
    const block = note?.blocks.find(item => item.blockId === blockId);
    if (!block) return;
    const text = toggleTaskListItem(block.text, index);
    if (text === null) return;
    const blocks = note.blocks.map(item => item.blockId === blockId ? { ...item, text } : item);
    return this.updateNote(noteId, { blocks });
  }

  async addLabel({ x = 0, y = 0, text = t("JN.Label.Default"), size = 14, color = "", stamp = "", noteId = "", corner = DEFAULT_STAMP_CORNER } = {}) {
    const id = foundry.utils.randomID();
    await this.#save(data => {
      data.layout.labels[id] = {
        text: String(text ?? ""), x, y, size, color: String(color ?? ""), stamp, noteId,
        corner: isStampCorner(corner) ? corner : DEFAULT_STAMP_CORNER
      };
    });
    return id;
  }

  async updateLabel(labelId, fields) {
    return this.#save(data => {
      const label = data.layout.labels[labelId];
      if (!label) return;
      if (typeof fields.text === "string") label.text = fields.text.slice(0, 500);
      if (Number.isFinite(fields.x)) label.x = fields.x;
      if (Number.isFinite(fields.y)) label.y = fields.y;
      if (Number.isFinite(fields.size)) label.size = Math.max(8, Math.min(96, fields.size));
      if (Object.values(STAMP_COLORS).includes(fields.color)) label.color = fields.color;
      if (label.stamp && isStampCorner(fields.corner)) label.corner = fields.corner;
    });
  }

  async removeLabels(labelIds) {
    return this.#save(data => {
      for (const id of labelIds) {
        const label = data.layout.labels[id];
        if (!label) continue;
        const ids = label.noteId && stampUrl(label.stamp)
          ? attachedStampIds(data.layout.labels, label.noteId) : [id];
        for (const removeId of ids) delete data.layout.labels[removeId];
      }
    });
  }

  removeLabel(labelId) {
    return this.removeLabels([labelId]);
  }

  async editLabel(labelId) {
    const label = this.workspace?.layout?.labels?.[labelId];
    if (!label || label.stamp) return;
    const text = await DialogV2.prompt({
      window: { title: t("JN.Prompt.EditLabel") },
      content: `<input type="text" name="value" autofocus value="${esc(label.text)}">`,
      ok: { label: t("JN.Common.OK"), callback: (event, button) => button.form.elements.value.value.trim() },
      rejectClose: false
    });
    if (text === null) return;
    if (!text) return this.removeLabel(labelId);
    return this.updateLabel(labelId, { text });
  }

  async attachStamp(noteId, stamp, color = STAMP_COLORS.red, corner = DEFAULT_STAMP_CORNER) {
    if (!stampUrl(stamp) || !this.workspace?.notes?.[noteId]) return;
    return this.#save(data => {
      const ids = attachedStampIds(data.layout.labels, noteId);
      const id = ids[0] ?? foundry.utils.randomID();
      for (const duplicate of ids.slice(1)) delete data.layout.labels[duplicate];
      const previous = data.layout.labels[id];
      data.layout.labels[id] = {
        text: "", x: 0, y: 0, size: 14,
        color: Object.values(STAMP_COLORS).includes(color) ? color : STAMP_COLORS.red,
        stamp, noteId,
        corner: isStampCorner(corner) ? corner : previous?.corner ?? DEFAULT_STAMP_CORNER
      };
    });
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
   * round-trip. Returns the anchor id (or "" when neither is usable).
   */
  #linkAnchor(data, noteId, anchorId, spec) {
    const card = data.layout.cards[noteId];
    if (!card) return "";
    if (validAnchorId(anchorId) && this.#cardAnchor(card, anchorId)) return anchorId;
    // With pins disabled, existing anchors remain usable render data but a link gesture must not
    // silently materialize a new minor. The plain point/side fallback is used instead.
    if (!this.#pinsEnabled()) return "";
    if (spec?.kind !== "minor" || !Number.isFinite(spec.x) || !Number.isFinite(spec.y)) return "";
    const anchors = { ...(card.anchors ?? {}) };
    if (Object.keys(anchors).length >= MAX_CARD_ANCHORS) return "";
    const id = `minor-${foundry.utils.randomID()}`;
    anchors[id] = {
      kind: "minor",
      x: this.#anchorPoint(spec.x),
      y: this.#anchorPoint(spec.y),
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

  async addCardAnchor(noteId, anchor = {}) {
    const card = this.workspace?.layout?.cards?.[noteId];
    if (!card) return null;
    if (anchor.kind !== "minor" || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return null;
    if (Object.keys(card.anchors ?? {}).length >= MAX_CARD_ANCHORS) return null;
    const id = `minor-${foundry.utils.randomID()}`;
    const ok = await this.#save(data => {
      const target = data.layout.cards[noteId];
      if (!target) return;
      const anchors = { ...(target.anchors ?? {}) };
      if (Object.keys(anchors).length >= MAX_CARD_ANCHORS) return;
      anchors[id] = {
        kind: "minor",
        x: this.#anchorPoint(anchor.x),
        y: this.#anchorPoint(anchor.y),
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
      const moved = { ...anchor, x: this.#anchorPoint(x), y: this.#anchorPoint(y) };
      const anchors = { ...(card.anchors ?? {}) };
      anchors[anchorId] = moved;
      card.anchors = anchors;
      const side = anchorSide(moved, { w: card.width ?? 190, h: card.height ?? 90 });
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
          link.sourceSide = anchorSide(anchor, {
            w: sourceCard.width ?? 190, h: sourceCard.height ?? 90
          });
        }
      }
      if (targetAnchorChange) {
        link.targetAnchorId = fields.targetAnchorId;
        const anchor = this.#cardAnchor(targetCard, fields.targetAnchorId);
        if (anchor) {
          link.targetPoint = { x: anchor.x, y: anchor.y };
          link.targetSide = anchorSide(anchor, {
            w: targetCard.width ?? 190, h: targetCard.height ?? 90
          });
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
    });
  }

  async moveCard(id, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !this.workspace?.layout?.cards?.[id]) return;
    return this.#save(data => {
      const card = data.layout.cards[id];
      if (card) { card.x = x; card.y = y; }
    });
  }

  async resizeCard(id, width, height) {
    if (!this.workspace?.layout?.cards?.[id]) return;
    return this.#save(data => {
      const card = data.layout.cards[id];
      if (card) { card.width = width; card.height = height; }
    });
  }

  async deleteNotes(ids) {
    const noteIds = ids.filter(id => this.workspace?.notes?.[id]);
    if (!noteIds.length) return;
    const undoId = foundry.utils.randomID();
    const deletedAt = Date.now();
    const ok = await this.#save(data => {
      for (const id of noteIds) {
        const note = data.notes[id];
        if (!note) continue;
        data.trash.unshift({ note, card: data.layout.cards[id] ?? null, deletedAt, undoId });
        delete data.notes[id];
        delete data.layout.cards[id];
      }
    });
    if (!ok) return;
    this.history.push({ noteIds, undoId });
    if (this.history.length > 20) this.history.shift();
    if (noteIds.includes(this.selectedNoteId)) this.selectedNoteId = null;
    this.canvas.clearSelection();
    ui.notifications?.info(t("JN.Delete.Notice", { count: noteIds.length }));
    this.onChange();
  }

  async deleteSelected() {
    const labelIds = this.getSelectedLabelIds();
    const noteIds = this.getSelectedNoteIds();
    if (!labelIds.length && !noteIds.length) return;
    if (noteIds.length > 1) {
      // A second Delete while the first confirmation is open must not stack another dialog or
      // delete the same selection twice.
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

  getSelectedLabelIds() {
    return this.canvas.getSelectedLabelIds();
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
        // Older trash entries have no undoId. openTrash falls back to the note id as the row key,
        // so accept either identifier here too.
        const matches = entry.undoId === key || (!entry.undoId && entry.note?.id === key);
        if (key && !matches) { keep.push(entry); continue; }
        data.notes[entry.note.id] = entry.note;
        if (entry.card) data.layout.cards[entry.note.id] = entry.card;
      }
      data.trash = keep;
    });
    this.onChange();
  }

  async emptyTrash() {
    await this.#save(data => { data.trash = []; });
    this.onChange();
  }

  async openStats() {
    const notes = Object.values(this.workspace?.notes ?? {});
    const chars = notes.reduce((total, note) =>
      total + note.blocks.reduce((sum, block) => sum + block.text.length, 0), 0);
    const trashed = this.workspace?.trash?.length ?? 0;
    const styles = {};
    const styleKey = note => {
      if (note.kind === "location") return "location";
      return resolvePresentation({ name: note.title, system: note }).extendedStyle;
    };
    const styleLabel = key => key === "location" ? "JN.Kind.Location"
      : key === "document" ? "JN.Style.Document"
        : key === "target" ? "JN.Style.Target" : "JN.Style.Memo";
    for (const note of notes) {
      const style = styleKey(note);
      styles[style] = (styles[style] ?? 0) + 1;
    }
    await DialogV2.wait({
      window: { title: t("JN.Private.StatsTitle") },
      content: `
        <p class="jn-private-stats-excluded">${t("JN.Private.StatsExcluded")}</p>
        <p>${t("JN.Private.StatsNotes", { count: notes.length })}</p>
        <p>${t("JN.Private.StatsChars", { count: chars })}</p>
        <p>${t("JN.Private.StatsTrash", { count: trashed })}</p>
        <div class="journalinator-meta">${t("JN.Private.StatsStyles")}</div>
        ${Object.entries(styles).map(([style, count]) =>
          `<div class="jn-stat-bar"><span>${esc(t(styleLabel(style)))}</span><em>${count}</em></div>`
        ).join("") || `<p class="journalinator-empty">${t("JN.Common.NoneYet")}</p>`}`,
      buttons: [{ action: "close", label: t("JN.Common.Close"), default: true }],
      rejectClose: false
    });
  }

  async openTrash() {
    // A legacy card-only trash entry has no note to restore, so it cannot be a usable row.
    const trashed = (this.workspace?.trash ?? [])
      .filter(entry => entry?.note?.id)
      .map(entry => ({ ...entry, key: entry.undoId ?? entry.note.id }));
    const grouped = new Map();
    for (const entry of trashed) {
      if (!grouped.has(entry.key)) grouped.set(entry.key, []);
      grouped.get(entry.key).push(entry);
    }
    const rows = [...grouped].map(([key, entries]) => {
      const deletedAt = entries.find(entry => Number.isFinite(entry.deletedAt))?.deletedAt;
      const date = Number.isFinite(deletedAt)
        ? new Date(deletedAt).toLocaleString(game.i18n?.lang || undefined) : "";
      const meta = date
        ? t("JN.Trash.DeletedByYouAt", { date: esc(date) })
        : t("JN.Trash.MetadataUnknown");
      return `
      <div class="jn-trash-row">
        <span class="jn-trash-title">${esc(entries.map(entry => entry.note.title || t("JN.Private.NewNoteTitle")).join(", "))}</span>
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

  async pasteNotes(entries, { x = 0, y = 0 } = {}) {
    if (!this.page || !Array.isArray(entries) || !entries.length) return [];
    const ids = [];
    const ok = await this.#save(data => {
      for (const entry of entries) {
        const { note, card } = privateStore.makeNote({
          title: entry?.title, kind: entry?.kind, style: entry?.style, x, y,
          cards: data.layout.cards, notes: data.notes
        });
        const texts = Array.isArray(entry?.blocks) && entry.blocks.length ? entry.blocks : [""];
        note.blocks = texts.map(text => ({ blockId: foundry.utils.randomID(), text: String(text ?? "") }));
        if (typeof entry?.targetHeading === "string") note.targetHeading = entry.targetHeading.slice(0, 80);
        if (typeof entry?.label === "string") note.label = entry.label.slice(0, MAX_TITLE_LENGTH);
        if (entry?.presentation && typeof entry.presentation === "object") {
          const presentation = resolvePresentation({
            name: entry?.title ?? note.title,
            system: { ...note, presentation: { ...(note.presentation ?? {}), ...entry.presentation } }
          });
          const { label: _ignored, ...presentationFields } = presentation;
          note.presentation = presentationFields;
        }
        if (entry?.attachment && typeof entry.attachment === "object") {
          note.attachment = resolveAttachment({
            system: { attachment: { ...(note.attachment ?? {}), ...entry.attachment } }
          });
        }
        if (Number.isInteger(entry?.schemaVersion) && entry.schemaVersion > 0) {
          note.schemaVersion = entry.schemaVersion;
        }
        const pastedAnchors = sanitizeCardAnchors(entry?.card?.anchors ?? entry?.anchors);
        if (Object.keys(pastedAnchors).length) {
          // Copied minors may keep their creator; the main pin is local identity and is stamped
          // from the private owner, never from pasted client data.
          if (pastedAnchors.main) {
            pastedAnchors.main = { ...pastedAnchors.main, createdBy: privateStore.ownerId(this.page) || "" };
          }
          card.anchors = { ...card.anchors, ...pastedAnchors };
        }
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

  destroy() {
    this.editor.close();
    this.canvas.disconnectGeometry();
    this.canvas.root.remove();
    this.editor.root.remove();
  }
}
