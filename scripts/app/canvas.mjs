import {
  CARD_SIDES, MAX_THREAD_PINS, THREAD_PIN_RADIUS, cardEdgeAt, cardPointAnchor, moveThreadPin, threadAttachment, validThreadPin
} from "../card-ports.mjs";
import { MAIN_ANCHOR_ID, anchorWorld, cardNormalizedPoint, isMainAnchor, nearestAnchor, validAnchorId } from "../anchors.mjs";
import { looseTails, pinnedThreadPath, threadLayerSpecs, ThreadMotion, THREAD_PRESETS } from "../link-thread.mjs";
import { LINK_COLOR_SLOTS, normalizeLinkColor } from "../link-colors.mjs";
import PatchNotesPanel from "./patch-notes.mjs";
import { noteImageSource } from "../image-url.mjs";
import { hasAnyLock } from "../locks.mjs";
import { renderMarkdown } from "../markdown.mjs";
import { t } from "../i18n.mjs";
import {
  NOTE_FONT_KEYS, PICTURE_LAYOUTS, PIN_STYLES,
  classifyNote, resolveAttachment, resolveLinkCosmetics, resolvePresentation
} from "../presentation.mjs";
import { tearPoints, tearPolygon, tearSeed } from "../tear.mjs";
import { MAX_ROUTE_ANCHORS } from "../route-notes.mjs";
import { DEFAULT_STAMP_CORNER, isStampCorner, STAMP_COLORS, STAMP_CORNERS, STAMP_IDS, stampUrl } from "../stamps.mjs";

const DRAG_THRESHOLD = 5;
let threadMaskSequence = 0;
const LINK_COLOR_OPTIONS = ["", ...LINK_COLOR_SLOTS];
const CARD_CORNERS = Object.freeze([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
const PATCH_NOTES_SELECTOR = ".jn-patch-notes, .jn-patch-notes-button";
// Screen-space radius for "dropped on a thread". Converted through zoom so it feels the same
// near and far; no snapping happens before the explicit mode chooser is confirmed.
const ROUTE_DROP_RADIUS = 18;

/**
 * Distance from a world point to the existing thread geometry, using the hit path's cubic
 * commands. This is only called while a card drag is live and once on drop; it never rebuilds
 * the SVG or writes to the DOM.
 */
function distanceToThreadPath(d, point) {
  if (typeof d !== "string" || !d) return Infinity;
  const tokens = d.match(/[MC]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  const distanceSq = (x, y) => (x - point.x) ** 2 + (y - point.y) ** 2;
  let cursor = null;
  let minimum = Infinity;
  let index = 0;
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === "M") {
      const x = Number(tokens[index++]);
      const y = Number(tokens[index++]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) break;
      cursor = { x, y };
      minimum = Math.min(minimum, distanceSq(x, y));
      continue;
    }
    if (command !== "C") break;
    const c1 = { x: Number(tokens[index++]), y: Number(tokens[index++]) };
    const c2 = { x: Number(tokens[index++]), y: Number(tokens[index++]) };
    const end = { x: Number(tokens[index++]), y: Number(tokens[index++]) };
    if (!cursor || !Number.isFinite(end.x) || !Number.isFinite(end.y)) {
      cursor = cursor ?? end;
      continue;
    }
    const start = cursor;
    const steps = 14;
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const u = 1 - t;
      const x = u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x;
      const y = u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y;
      minimum = Math.min(minimum, distanceSq(x, y));
    }
    cursor = end;
  }
  return Math.sqrt(minimum);
}

// Extended style class names stay aligned with the legacy theme token keys (`wanted` is Target).
const STYLE_CLASSES = Object.freeze({
  memo: "jn-card-memo",
  document: "jn-card-document",
  target: "jn-card-wanted"
});

// Nominal creation widths; inline manually-sized cards override these.
const CREATE_WIDTHS = Object.freeze({
  note: 120,
  memo: 360,
  document: 248,
  target: 252,
  location: 245
});

const FONT_LABEL_KEYS = Object.freeze({
  default: "JN.Font.Default",
  serif: "JN.Font.Serif",
  hand: "JN.Font.Hand",
  display: "JN.Font.Display"
});
const PICTURE_LABEL_KEYS = Object.freeze({
  above: "JN.Picture.Above",
  below: "JN.Picture.Below",
  left: "JN.Picture.Left",
  right: "JN.Picture.Right"
});
const STYLE_LABEL_KEYS = Object.freeze({
  memo: "JN.Style.Memo",
  document: "JN.Style.Document",
  target: "JN.Style.Target"
});
const PIN_STYLE_LABEL_KEYS = Object.freeze({
  default: "JN.Pin.Styles.Default",
  enamel: "JN.Pin.Styles.Enamel",
  brass: "JN.Pin.Styles.Brass",
  iron: "JN.Pin.Styles.Iron",
  wood: "JN.Pin.Styles.Wood",
  decorative: "JN.Pin.Styles.Decorative",
  wax: "JN.Pin.Styles.Wax"
});

// Floating-toolbar groups. Icons and label keys are data so the button list and popover
// builder cannot drift apart. Cosmetic-only: no label/content/image/permission/topology action.
const NOTE_TOOL_GROUPS = Object.freeze({
  style: { icon: "fa-palette", label: "JN.Toolbar.Style" },
  force: { icon: "fa-expand", label: "JN.Editor.ForceExtended" },
  font: { icon: "fa-font", label: "JN.Editor.Font" },
  picture: { icon: "fa-image", label: "JN.Editor.PictureLayout" },
  torn: { icon: "fa-scissors", label: "JN.Editor.Torn" },
  pin: { icon: "fa-thumbtack", label: "JN.Pin.Style" },
  dimensions: { icon: "fa-ruler", label: "JN.Toolbar.Dimensions" },
  locked: { icon: "fa-lock", label: "JN.Toolbar.BulkDisabled" }
});
// A26 multi-link bulk is intentionally out of scope for this canvas: selection is a single
// `selectedLinkId`, so choosing another thread replaces it and the link popover edits one link.
// (Multi-note cosmetic batches remain supported through `selectedNoteIds`.)
const LINK_TOOL_GROUPS = Object.freeze({
  material: { icon: "fa-layer-group", label: "JN.Link.Material" },
  thickness: { icon: "fa-grip-lines", label: "JN.Link.Thickness" },
  slack: { icon: "fa-wind", label: "JN.Link.Slack" },
  color: { icon: "fa-palette", label: "JN.Link.Color.default" },
  pattern: { icon: "fa-bars-staggered", label: "JN.Link.Pattern" },
  ends: { icon: "fa-scissors", label: "JN.Link.Ends" },
  label: { icon: "fa-tag", label: "JN.Link.Label" },
  presets: { icon: "fa-wand-magic-sparkles", label: "JN.Link.Presets" }
});

/**
 * The note canvas: pan/zoom viewport, absolutely-positioned cards, free text labels, and now
 * drawn links between cards. Owns its own DOM subtree and pan/zoom state persistently —
 * JournalApp re-renders its chrome on every document-sync hook, but this instance is created
 * once and just has its contents refreshed via update(), so panning/zooming never resets
 * because someone else edited a note.
 *
 * Updates are sent on drag/resize END only (spec §8.1) — no live streaming, and no "held by"
 * pick-up marker yet (that arrives with the lock system in Phase 4).
 */
export default class JournalCanvas {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.threadMaskId = "jn-thread-mask-" + ++threadMaskSequence;
    this.view = { x: 0, y: 0, k: 1 };
    this.hasCentered = false;
    this.notes = [];
    this.notesById = new Map();
    this.layout = { cards: {}, labels: {}, viewport: null };
    this.cardEls = new Map();
    this.cardSizes = new Map();
    this.labelEls = new Map();
    this.linksById = new Map();
    this.threads = new Map();
    this.linkSignature = null;
    this.linkGroupEls = new Map();
    this.linkHitEls = new Map();
    this.maskShapeEls = new Map();
    this.toolbarDismiss = null;
    this.pinDrag = null;
    // Note attachment pins are DOM elements on the card, not SVG route pins. `anchorDrag` keeps
    // a live minor-pin position between pointer frames without writing to the persisted layout.
    this.anchorDrag = null;
    this.pinsEnabled = null; // null = read the world setting; boolean lets JournalApp/tests override
    this.pinTarget = null;
    this.snappedPinEl = null;
    this.movingThreads = new Set();
    this.threadFrame = null;
    this.threadTime = null;
    this.zoomFrame = null;
    this.selectedNoteId = null;
    this.selectedLabelIds = new Set();
    this.selectedNoteIds = new Set();
    this.selectedLinkId = null;
    this.lastLinkClick = null;
    this.linkDrawTimer = null;
    this.cardResizeObserver = null;
    // Screen-space overlays are clamped to the canvas. Their bounds are re-applied when the
    // window or the canvas root changes size, with listeners owned by the canvas lifecycle.
    this.rootResizeObserver = null;
    this.windowResize = null;
    this.inlineText = null;
    this.linkPlacement = null;
    // Dropping a single note near a thread previews the target link. The chooser is built only
    // on pointerup, in screen space, so a pan or a plain drag never opens a menu.
    this.routeDrop = null;
    this.routeDragNoteId = null;
    this.routeChooser = null;
    this.routeChooserTarget = null;
    this.routeChooserDismiss = null;
    this.routeChooserReturnFocus = null;
    this.routePreview = null;
    this.routePreviewPin = null;
    // Thread fade is a class toggle on the existing mask silhouettes: hover/editing never
    // rebuilds paths or the SVG.
    this.hoverNoteId = null;
    this.focusedNoteId = null;
    this.dimMatch = () => true; // (note) => does it match the active search/filters?
    this.statusFor = null; // (note) => derived actor status badge or null
    this.gmMode = false; // GM view with secrets merged in: shows hide/reveal/hint controls
    this.readOnly = false; // no active GM: allow selecting/reading but no writes

    this.root = document.createElement("div");
    this.root.className = "jn-canvas";
    // Canvas 2 paints the selected cork material; there is no dot/grid presentation.
    this.root.dataset.boardPattern = "stylized";
    this.patternSize = 320;
    // Programmatic focus keeps canvas keyboard shortcuts scoped to an intentional canvas click
    // without adding the canvas itself to Foundry's normal Tab order.
    this.root.tabIndex = -1;
    this.root.innerHTML = `
      <div class="jn-world">
        <svg class="jn-link-hits" aria-hidden="true"></svg>
        <svg class="jn-links"></svg>
      </div>
      <div class="jn-selection-box"></div>
      <div class="jn-context-menu"></div>
      <div class="jn-link-toolbar"></div>
      <div class="jn-floating-toolbar" role="toolbar" aria-orientation="vertical" aria-label="${t("JN.Toolbar.Title")}" hidden></div>
      <div class="jn-floating-popover" role="dialog" aria-label="${t("JN.Toolbar.Title")}" hidden></div>
      <div class="jn-link-placement-hint" role="status" hidden></div>
    `;
    this.world = this.root.querySelector(".jn-world");
    this.svg = this.root.querySelector(".jn-links");
    this.linkHits = this.root.querySelector(".jn-link-hits");
    this.selectionBox = this.root.querySelector(".jn-selection-box");
    this.contextMenu = this.root.querySelector(".jn-context-menu");
    this.linkToolbar = this.root.querySelector(".jn-link-toolbar");
    this.linkPlacementHint = this.root.querySelector(".jn-link-placement-hint");
    this.floatingToolbar = this.root.querySelector(".jn-floating-toolbar");
    this.floatingPopover = this.root.querySelector(".jn-floating-popover");
    this.floatingPopoverId = `jn-floating-popover-${threadMaskSequence}`;
    this.floatingPopover.id = this.floatingPopoverId;
    this.floatingToolbarSignature = "none";
    this.floatingPopoverDismiss = null;
    this.floatingPopoverKeydown = null;
    this.floatingPopoverReturnFocus = null;
    // Kept while the popover is open so a viewport/root resize can re-clamp it without
    // guessing where the trigger went.
    this.floatingPopoverAnchor = null;
    this.patchNotes = new PatchNotesPanel();
    this.patchNotes.appendTo(this.root);

    this.#bindPointerEvents();
  }

  update(notes, layout, { dimMatch, deferGeometry = false } = {}) {
    this.notes = notes;
    this.notesById = new Map(notes.map(note => [note._id, note]));
    this.layout = layout ?? { cards: {}, labels: {} };
    // A fresh layout is authoritative: any optimistic minor-pin override has either been
    // committed by now or was superseded by another client.
    this.anchorDrag = null;
    if (dimMatch) this.dimMatch = dimMatch;
    for (const id of this.selectedLabelIds) {
      if (!this.layout.labels?.[id]) this.selectedLabelIds.delete(id);
    }

    const attached = new Map();
    const seenLabels = new Set();
    for (const [id, data] of Object.entries(this.layout.labels ?? {})) {
      if (data.noteId) {
        const url = stampUrl(data.stamp);
        if (!url) continue;
        const previous = attached.get(data.noteId);
        if (previous && (data.hidden || !previous.classList.contains("jn-stamp-private"))) continue;
        const image = this.#stampImage(id, data, url);
        image.classList.toggle("jn-stamp-private", !!data.hidden);
        attached.set(data.noteId, image);
      } else {
        seenLabels.add(id);
        this.#renderLabel(id, data);
      }
    }
    const seenCards = new Set();
    for (const note of notes) {
      seenCards.add(note._id);
      this.#renderCard(note, attached.get(note._id));
    }
    for (const [id, el] of [...this.cardEls]) {
      if (!seenCards.has(id)) {
        this.cardResizeObserver?.unobserve(el);
        el.remove();
        this.cardEls.delete(id);
        this.cardSizes.delete(id);
      }
    }

    for (const [id, el] of [...this.labelEls]) {
      if (!seenLabels.has(id)) { el.remove(); this.labelEls.delete(id); }
    }
    if (this.linkPlacement?.source && !this.cardEls.has(this.linkPlacement.source.id)) this.cancelLinkTool();
    if (this.hoverNoteId && !this.cardEls.has(this.hoverNoteId)) this.hoverNoteId = null;
    if (this.focusedNoteId && !this.cardEls.has(this.focusedNoteId)) this.focusedNoteId = null;
    const chooserTarget = this.routeChooserTarget;
    if (chooserTarget && (!this.cardEls.has(chooserTarget.noteId)
        || !this.linksById.has(chooserTarget.linkId))) {
      this.#closeRouteChooser();
    }

    if (!deferGeometry) this.refreshGeometry();
    this.#syncFloatingToolbar();
  }

  refreshGeometry() {
    if (!this.hasCentered && this.notes.length && this.root.clientWidth && this.root.clientHeight) {
      this.#centerOnContent();
      this.hasCentered = true;
    }
    this.#applyTransform();
    this.#flushLinkDraw();
    // Bind the overlay resize observer before the card observer so UI tests that stub the
    // global ResizeObserver still receive card-size callbacks (the card observer is created last).
    this.#bindGeometryResize();
    if (!this.cardResizeObserver && typeof ResizeObserver === "function") {
      this.cardResizeObserver = new ResizeObserver(entries => {
        // Drop only the cards that actually changed size; a plain drag keeps its cached box.
        if (!entries?.length) this.cardSizes.clear();
        else for (const entry of entries) {
          const id = entry.target?.dataset?.id;
          if (id) this.cardSizes.delete(id);
        }
        this.#queueLinkDraw();
      });
      for (const card of this.cardEls.values()) this.cardResizeObserver.observe(card, { box: "border-box" });
    }
  }

  /**
   * Screen-space overlays stay inside the canvas when the app window or canvas root resizes.
   * Both listeners belong to the canvas instance and are removed in disconnectGeometry().
   */
  #bindGeometryResize() {
    const view = this.root.ownerDocument.defaultView;
    if (view && !this.windowResize) {
      this.windowResize = () => this.#repositionFloatingPopoverOnResize();
      view.addEventListener("resize", this.windowResize);
    }
    if (!this.rootResizeObserver && typeof ResizeObserver === "function") {
      this.rootResizeObserver = new ResizeObserver(() => this.#repositionFloatingPopoverOnResize());
      this.rootResizeObserver.observe(this.root, { box: "border-box" });
    }
  }

  #unbindGeometryResize() {
    if (this.windowResize) {
      this.root.ownerDocument.defaultView?.removeEventListener("resize", this.windowResize);
      this.windowResize = null;
    }
    this.rootResizeObserver?.disconnect();
    this.rootResizeObserver = null;
  }

  #repositionFloatingPopoverOnResize() {
    if (this.floatingPopover.hidden) return;
    const anchor = this.floatingPopoverAnchor;
    const rootRect = this.root.getBoundingClientRect();
    if (!anchor?.isConnected || !this.root.isConnected
        || rootRect.width <= 0 || rootRect.height <= 0) {
      this.#closeFloatingPopover();
      return;
    }
    this.#positionFloatingPopover(anchor, this.floatingPopover);
  }

  disconnectGeometry() {
    this.cardResizeObserver?.disconnect();
    this.cardResizeObserver = null;
    this.#unbindGeometryResize();
    if (this.linkDrawTimer !== null) clearTimeout(this.linkDrawTimer);
    this.linkDrawTimer = null;
    this.#unbindToolbarDismiss();
    this.#closeFloatingPopover();
    this.#hideLinkToolbar();
    this.floatingToolbar.hidden = true;
    this.floatingToolbar.replaceChildren();
    this.floatingToolbarSignature = "none";
    if (this.threadFrame !== null) this.root.ownerDocument.defaultView.cancelAnimationFrame(this.threadFrame);
    if (this.zoomFrame !== null) this.root.ownerDocument.defaultView.cancelAnimationFrame(this.zoomFrame);
    this.threadFrame = this.threadTime = null;
    this.zoomFrame = null;
    this.threads.clear();
    this.pinDrag = null;
    this.anchorDrag = null;
    this.pinTarget = null;
    this.snappedPinEl = null;
    this.movingThreads.clear();
    this.#closeRouteChooser();
    this.#clearRouteDrop();
  }

  setDimMatch(dimMatch) {
    this.dimMatch = dimMatch;
    for (const note of this.notes ?? []) {
      this.cardEls.get(note._id)?.classList.toggle("jn-dimmed", !dimMatch(note));
    }
    this.#drawLinks();
    this.#syncLinkToolbar();
  }

  #warnReadOnly() {
    ui.notifications?.warn(t("JN.TopBar.Offline"));
  }

  #renderCard(note, stamp) {
    const cardData = this.layout.cards?.[note._id] ?? { x: 0, y: 0, rotation: 0 };
    const presentation = resolvePresentation(note);
    const mode = classifyNote(note).mode;
    let el = this.cardEls.get(note._id);
    if (!el) {
      el = document.createElement("div");
      el.className = "jn-card";
      el.dataset.id = note._id;
      el.innerHTML = `
        <img class="jn-card-background" alt="" draggable="false" referrerpolicy="no-referrer" hidden>
        <button type="button" class="jn-card-image-button">
          <i class="fa-solid fa-camera" aria-hidden="true"></i><span aria-hidden="true">+</span>
        </button>
        <div class="jn-card-main">
          <strong class="jn-card-wanted-heading" data-card-text="heading" tabindex="0" hidden></strong>
          <h3 class="jn-card-title" data-card-text="label" tabindex="0" hidden></h3>
          <div class="jn-card-body">
            <div class="jn-card-image" hidden><img alt="" draggable="false" referrerpolicy="no-referrer"></div>
            <div class="jn-card-text"><div class="jn-card-excerpt"></div></div>
          </div>
        </div>
        <div class="jn-card-pins"></div>
        <span class="jn-card-signature" aria-hidden="true"></span>
        <span class="jn-card-status" hidden></span>
        <div class="jn-card-stamps"></div>
        <span class="jn-card-lock-pill">&#9998;</span>
        <b class="jn-card-resize"></b>
      `;
      this.world.appendChild(el);
      this.cardEls.set(note._id, el);
      this.cardResizeObserver?.observe(el, { box: "border-box" });
    }

    const styleClass = STYLE_CLASSES[presentation.extendedStyle] ?? STYLE_CLASSES.memo;
    el.className = [
      "jn-card", styleClass,
      mode === "compact" ? "jn-compact" : "jn-extended",
      `jn-font-${presentation.font}`,
      `jn-pic-${presentation.pictureLayout}`,
      presentation.torn ? "jn-torn" : ""
    ].filter(Boolean).join(" ");
    el.classList.toggle("jn-secret", !!note.secret);
    el.classList.toggle("jn-kind-location", note.system.kind === "location");
    el.classList.toggle("jn-hint", !!note.system.hint);
    el.classList.toggle("jn-has-hidden", !note.secret && (note.system.blocks ?? []).some(b => b.hidden));
    el.classList.toggle("selected", this.selectedNoteIds.has(note._id) || note._id === this.selectedNoteId);
    el.classList.toggle("jn-being-edited", hasAnyLock(note._id));
    el.classList.toggle("jn-dimmed", !this.dimMatch(note));

    // The torn outline is a stable function of the permanent document id, never DOM order or
    // another client's view. Only the paper (`.jn-card-main`) is clipped; pins, stamps, the
    // signature and the resize handle stay outside it and keep their hit areas.
    if (presentation.torn) {
      el.style.setProperty("--jn-tear", tearPolygon(note._id));
      // The numeric seed is recorded for diagnostics/tests; the silhouette itself stays a
      // pure function of the stable id.
      el.dataset.tearSeed = String(tearSeed(note._id));
    } else {
      el.style.removeProperty("--jn-tear");
      delete el.dataset.tearSeed;
    }

    el.style.left = `${cardData.x}px`;
    el.style.top = `${cardData.y}px`;
    el.style.setProperty("--jn-rotation", `${cardData.rotation ?? 0}deg`);
    // Any render can change the paper's intrinsic size, so the next geometry pass re-measures.
    this.cardSizes.delete(note._id);
    // Manual sizes live in the layout card; calculated compact/extended sizes live only in CSS.
    const manualWidth = Number.isFinite(cardData.width) && cardData.width > 0;
    const manualHeight = Number.isFinite(cardData.height) && cardData.height > 0;
    el.classList.toggle("jn-sized", manualWidth || manualHeight);
    el.style.width = manualWidth ? `${cardData.width}px` : "";
    el.style.minHeight = manualHeight ? `${cardData.height}px` : "";

    const author = game.users.get(note.system.authorId);
    el.style.setProperty("--jn-author-color", author?.color ?? "#8d8d97");
    const signature = el.querySelector(".jn-card-signature");
    const initial = (author?.name ?? "?").trim().charAt(0).toUpperCase() || "?";
    signature.textContent = initial;
    signature.title = author?.name ?? "";

    const attachment = resolveAttachment(note);
    this.#renderCardPins(el, note, cardData, attachment);

    const image = el.querySelector(".jn-card-image");
    const portrait = image.querySelector("img");
    const imageButton = el.querySelector(".jn-card-image-button");
    const source = noteImageSource(note.system.image);
    // Only an explicit image earns the two-column picture layout; otherwise left/right would
    // leave an empty column behind.
    el.classList.toggle("jn-has-picture", !!source);
    const label = t(source ? "JN.Editor.ChangeImage" : "JN.Editor.SetImage");
    imageButton.title = label;
    imageButton.setAttribute("aria-label", label);
    image.hidden = !source;
    if (source && portrait.getAttribute("src") !== source) portrait.setAttribute("src", source);
    else if (!source) portrait.removeAttribute("src");
    const background = el.querySelector(".jn-card-background");
    const backgroundSource = noteImageSource(note.system.backgroundImage);
    background.hidden = !backgroundSource;
    if (backgroundSource && background.getAttribute("src") !== backgroundSource) background.setAttribute("src", backgroundSource);
    else if (!backgroundSource) background.removeAttribute("src");

    // The optional label is the only visible identity on a card. The internal Foundry name is
    // never rendered in normal view; an empty label simply hides the slot.
    const title = el.querySelector(".jn-card-title");
    const heading = el.querySelector(".jn-card-wanted-heading");
    const text = presentation.label.trim();
    if (this.inlineText?.field !== title) {
      title.textContent = text;
      title.hidden = !text;
    }
    const isTarget = presentation.extendedStyle === "target";
    heading.hidden = !isTarget;
    if (this.inlineText?.field !== heading) {
      heading.textContent = presentation.heading.trim() || t("JN.Style.Wanted");
    }
    this.#renderCardBlocks(el.querySelector(".jn-card-excerpt"), note.system.blocks ?? []);
    const stampSlot = el.querySelector(".jn-card-stamps");
    if (stamp) el.dataset.sealCorner = stamp.dataset.sealCorner;
    else delete el.dataset.sealCorner;
    stampSlot.replaceChildren(...(stamp ? [stamp] : []));

    // Derived actor state, not a stamp: it never occupies the seal slot, is not draggable, and
    // is recalculated on every render from whatever this client is allowed to see.
    const status = this.statusFor?.(note) ?? null;
    const statusSlot = el.querySelector(".jn-card-status");
    el.classList.toggle("jn-has-status", !!status);
    statusSlot.hidden = !status;
    if (!status) statusSlot.replaceChildren();
    else {
      const label = t(status.sceneId ? "JN.Actor.DeadInScene" : "JN.Actor.Dead");
      const image = document.createElement("img");
      image.className = "jn-card-status-icon";
      image.src = stampUrl("skull");
      image.alt = label;
      image.title = label;
      image.draggable = false;
      statusSlot.replaceChildren(image);
    }
  }

  /** Pins are an experimental world feature; an unset legacy setting still means enabled. */
  #pinsOn() {
    if (typeof this.pinsEnabled === "boolean") return this.pinsEnabled;
    try {
      return game.settings?.get?.("fvtt-journalinator", "pinsEnabled") !== false;
    } catch {
      return true;
    }
  }

  /**
   * Paper pins live outside `.jn-card-main`, so the torn clip-path, paper glow and selection
   * outline never hide their hit areas. They are positioned in normalized card coordinates and
   * therefore rotate/resize with the card without any per-frame JavaScript.
   */
  #renderCardPins(el, note, cardData, attachment) {
    const container = el.querySelector(".jn-card-pins");
    if (!container) return;
    const anchors = cardData?.anchors && typeof cardData.anchors === "object" ? cardData.anchors : {};
    const enabled = this.#pinsOn();
    el.classList.toggle("jn-pins-disabled", !enabled);
    el.dataset.pinStyle = attachment.pinStyle || "default";
    if (!enabled) {
      container.replaceChildren();
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const pins = [];
    for (const [anchorId, anchor] of Object.entries(anchors)) {
      if (!validAnchorId(anchorId)) continue;
      if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) continue;
      const main = isMainAnchor(anchor);
      if (main && !attachment.mainPinEnabled) continue;
      const styleKey = attachment.pinStyle || "default";
      const style = styleKey === "default" ? "enamel" : styleKey;
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = `jn-pin ${main ? "jn-pin-main" : "jn-pin-minor"} jn-pin-style-${style}`
        + (styleKey === "default" ? " jn-pin-style-default" : "");
      pin.dataset.noteId = note._id;
      pin.dataset.anchorId = anchorId;
      pin.dataset.anchorKind = main ? "main" : "minor";
      pin.dataset.pinStyle = style;
      pin.dataset.pinStyleKey = styleKey;
      if (main && anchor.createdBy) {
        const creator = game.users?.get?.(anchor.createdBy);
        if (creator?.color) pin.style.setProperty("--jn-pin-color", creator.color);
      }
      const drag = this.anchorDrag;
      const x = drag?.noteId === note._id && drag.anchorId === anchorId ? drag.x : anchor.x;
      const y = drag?.noteId === note._id && drag.anchorId === anchorId ? drag.y : anchor.y;
      pin.style.left = `${Math.min(1, Math.max(0, x)) * 100}%`;
      pin.style.top = `${Math.min(1, Math.max(0, y)) * 100}%`;
      const base = t(main ? "JN.Pin.Main" : "JN.Pin.Minor");
      const label = main ? `${base} · ${t("JN.Pin.DragHint")}` : base;
      pin.title = label;
      pin.setAttribute("aria-label", label);
      pins.push(pin);
    }
    container.replaceChildren(...pins);
  }

  /** Persisted anchor plus an in-progress minor-pin drag override. */
  #cardAnchor(noteId, anchorId) {
    if (!validAnchorId(anchorId)) return null;
    const anchors = this.layout.cards?.[noteId]?.anchors;
    const anchor = anchors && Object.hasOwn(anchors, anchorId) ? anchors[anchorId] : null;
    if (!anchor) return null;
    const drag = this.anchorDrag;
    if (drag && drag.noteId === noteId && drag.anchorId === anchorId) {
      return { ...anchor, x: drag.x, y: drag.y };
    }
    return anchor;
  }

  /** World attachment at an anchor's center with its outward normal, matching thread layout. */
  #anchorWorldAttachment(box, anchor) {
    const world = anchorWorld(box, anchor);
    if (!world) return null;
    return {
      ...world,
      x: world.x + world.nx * THREAD_PIN_RADIUS,
      y: world.y + world.ny * THREAD_PIN_RADIUS
    };
  }

  #anchorAttachment(noteId, box, anchorId) {
    return this.#anchorWorldAttachment(box, this.#cardAnchor(noteId, anchorId));
  }

  #renderCardBlocks(excerpt, blocks) {
    const activeId = excerpt.querySelector(".jn-block-input")?.parentElement.dataset.blockId;
    const visible = blocks.filter(block => block.text || block.hidden || activeId === block.blockId);
    const shown = visible.length ? visible : blocks.slice(0, 1);
    const existing = new Map([...excerpt.children].map(el => [el.dataset.blockId, el]));
    for (const [index, block] of shown.entries()) {
      const row = existing.get(block.blockId) ?? document.createElement("div");
      if (!existing.has(block.blockId)) {
        row.className = "jn-card-block";
        row.dataset.blockId = block.blockId;
        row.dataset.cardText = "block";
        row.tabIndex = 0;
        const body = document.createElement("div");
        body.className = "jn-card-block-body";
        row.appendChild(body);
      }
      const body = row.firstElementChild;
      const markdownKey = `${this.readOnly ? "r" : "w"}\u0000${block.text}`;
      if (body.dataset.markdownKey !== markdownKey) {
        body.dataset.markdownKey = markdownKey;
        if (block.text.trim()) {
          body.innerHTML = renderMarkdown(block.text, { interactiveTasks: !this.readOnly });
        } else {
          body.textContent = t("JN.Editor.EditCardText");
        }
      }
      row.classList.toggle("jn-card-block-empty", !block.text);
      if (excerpt.children[index] !== row) excerpt.insertBefore(row, excerpt.children[index] ?? null);
      existing.delete(block.blockId);
    }
    for (const row of existing.values()) row.remove();
  }

  #editCardText(id, field) {
    if (this.readOnly) return this.#warnReadOnly();
    this.#setSelection([id], id);
    if (field.dataset.cardText === "block") {
      this.callbacks.onEditCardBlock?.(id, field.dataset.blockId, field);
      return;
    }
    const note = this.notes.find(item => item._id === id);
    if (!note || this.inlineText?.field === field) return;
    this.finishInlineText();
    const kind = field.dataset.cardText;
    // The editor owns the internal Foundry name; the card only edits the optional label and
    // the target heading.
    if (kind !== "label" && kind !== "heading") return;
    const presentation = resolvePresentation(note);
    const current = kind === "label" ? presentation.label : presentation.heading;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "jn-card-text-input";
    input.maxLength = kind === "label" ? 200 : 80;
    input.value = this.callbacks.onReadCardText?.(id, kind) ?? current;
    if (kind === "heading") input.placeholder = t("JN.Style.Wanted");
    input.setAttribute("aria-label", t(kind === "heading" ? "JN.Editor.TargetHeading" : "JN.Editor.Label"));
    this.inlineText = { field, input, id, kind };
    this.#syncMaskState();
    field.hidden = false;
    field.replaceChildren(input);
    input.onblur = () => this.finishInlineText();
    input.addEventListener("keydown", event => {
      if (event.isComposing || !["Enter", "Escape"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      this.finishInlineText(event.key === "Enter");
      this.root.focus({ preventScroll: true });
    });
    input.focus();
    input.select();
  }

  mount(slot) {
    const input = this.inlineText?.input;
    if (input) input.onblur = null;
    slot.appendChild(this.root);
    if (input) input.onblur = () => this.finishInlineText();
  }

  finishInlineText(save = true) {
    if (!this.inlineText) return;
    const { field, input, id, kind } = this.inlineText;
    this.inlineText = null;
    this.#syncMaskState();
    input.onblur = null;
    const note = this.notes.find(item => item._id === id);
    if (!note) return;
    const presentation = resolvePresentation(note);
    if (kind === "label") {
      const value = presentation.label.trim();
      field.textContent = value;
      field.hidden = !value;
    } else {
      field.textContent = presentation.heading.trim() || t("JN.Style.Wanted");
    }
    if (save) this.callbacks.onSaveCardText?.(id, kind, input.value.trim());
  }

  #stampImage(labelId, data, url) {
    const image = document.createElement("img");
    image.className = "jn-stamp";
    image.classList.toggle("jn-label-selected", this.selectedLabelIds.has(labelId));
    image.dataset.stampLabelId = labelId;
    image.dataset.sealCorner = isStampCorner(data.corner) ? data.corner : DEFAULT_STAMP_CORNER;
    image.src = url;
    image.alt = t(`JN.Stamp.${data.stamp}`);
    image.style.setProperty("--jn-seal-color", this.#stampColor(data.color));
    image.classList.toggle("jn-stamp-colored", !!data.color);
    image.title = image.alt;
    image.draggable = false;
    return image;
  }

  #renderLabel(id, data) {
    let el = this.labelEls.get(id);
    if (!el) {
      el = document.createElement("div");
      el.className = "jn-label";
      el.dataset.id = id;
      this.world.appendChild(el);
      this.labelEls.set(id, el);
    }
    el.style.left = `${data.x}px`;
    el.style.top = `${data.y}px`;
    el.style.fontSize = `${data.size ?? 14}px`;
    el.style.color = data.color || "";
    el.classList.toggle("jn-label-hidden", !!data.hidden);
    el.classList.toggle("jn-label-selected", this.selectedLabelIds.has(id));
    const url = stampUrl(data.stamp);
    if (url) el.replaceChildren(this.#stampImage(id, data, url));
    else el.textContent = data.text ?? "";
  }

  /** Older links have no pinned side. Route them through the side facing the other card. */
  #facingSide(a, b) {
    return cardEdgeAt(a, { x: b.x + b.w / 2, y: b.y + b.h / 2 }).side;
  }

  #cardBox(id) {
    const data = this.layout.cards?.[id] ?? { x: 0, y: 0 };
    const el = this.cardEls.get(id);
    const liveX = Number.parseFloat(el?.style.left);
    const liveY = Number.parseFloat(el?.style.top);
    // Width/height change only on render, resize or a ResizeObserver callback. Reusing the last
    // measurement avoids forcing a full board layout on every drag frame (the path endpoints
    // still read live x/y, which is all a card move changes).
    let size = this.cardSizes.get(id);
    if (!size) {
      size = {
        w: el?.offsetWidth || Number.parseFloat(el?.style.width) || 190,
        h: el?.offsetHeight || Number.parseFloat(el?.style.minHeight) || 70
      };
      this.cardSizes.set(id, size);
    }
    return {
      x: Number.isFinite(liveX) ? liveX : data.x,
      y: Number.isFinite(liveY) ? liveY : data.y,
      w: size.w,
      h: size.h,
      rotation: data.rotation ?? 0
    };
  }

  /** Public measured card box, e.g. for main-pin projection from the app/editor. */
  cardBox(id) {
    return this.#cardBox(id);
  }

  #drawLinks() {
    const boxes = new Map([...this.cardEls.keys()].map(id => [id, this.#cardBox(id)]));
    const links = [];

    for (const note of this.notes) {
      for (const link of note.system.links ?? []) {
        if (!this.cardEls.has(note._id) || !this.cardEls.has(link.targetId)) continue;
        const a = boxes.get(note._id), b = boxes.get(link.targetId);
        const sourceSide = CARD_SIDES.includes(link.sourceSide) ? link.sourceSide : this.#facingSide(a, b);
        const targetSide = CARD_SIDES.includes(link.targetSide) ? link.targetSide : this.#facingSide(b, a);
        links.push({ note, link, sourceSide, targetSide });
      }
    }
    if (this.selectedLinkId && !links.some(({ link }) => link.id === this.selectedLinkId)) this.selectedLinkId = null;

    const animate = this.root.isConnected && !this.root.ownerDocument.defaultView.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const dimmedIds = new Set(this.notes.filter(n => !this.dimMatch(n)).map(n => n._id));
    const signature = this.#linkSignature(links, boxes, dimmedIds);

    // A drag only moves cards: link topology, cosmetics and state are unchanged, so rebuild the
    // geometry of the existing SVG nodes instead of re-parsing the whole innerHTML string.
    if (signature === this.linkSignature && this.#linkStructureReady(links)
        && this.#updateLinkGeometry(links, boxes, animate, dimmedIds)) {
      this.#syncLinkToolbar();
      return;
    }

    this.linksById = new Map();
    let body = "";
    let hits = "";
    const threads = new Map();
    for (const entry of links) {
      const { note, link } = entry;
      const { p, r, cosmetics, pins, routePoints, waypoints, motion } = this.#resolveThread(entry, boxes, animate);
      threads.set(link.id, { start: p, end: r, pins, routePoints, waypoints, motion });
      const { path: d, center: { x: mx, y: my }, start, end } = pinnedThreadPath(p, r, waypoints, motion, cosmetics.slack);
      const color = normalizeLinkColor(link.color);
      const colorClass = color ? `jn-link-color-${color}` : "jn-link-color-default";
      const accentClass = `jn-link-accent-${cosmetics.secondaryColor || "default"}`;
      const specs = threadLayerSpecs(cosmetics.material, cosmetics.thickness);
      const roleClass = role => `jn-thread-${role.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
      const layerPaths = () => specs.layers.map(layer => `<path class="jn-thread-layer ${roleClass(layer.role)}" d="${d}"
        style="--jn-layer-width:${layer.widthFactor};--jn-layer-opacity:${layer.opacity};--jn-layer-dx:${layer.dx};--jn-layer-dy:${layer.dy}"/>`).join("");
      const accentStack = cosmetics.pattern === "alternating" && !link.hidden
        ? `<g class="jn-link-stack jn-link-stack-accent">${layerPaths()}</g>`
        : "";
      const tails = cosmetics.ends === "loose"
        ? looseTails(start, end).map(tail =>
          `<path class="jn-thread-tail${tail.role === "tailFine" ? " jn-thread-tail-fine" : ""}" d="${tail.d}"/>`).join("")
        : "";
      // No arrowheads and no direction UI: a thread is an undirected visual relationship.
      const endpoint = anchor => `<circle class="jn-thread-pin" cx="${anchor.x - anchor.nx * THREAD_PIN_RADIUS}"
          cy="${anchor.y - anchor.ny * THREAD_PIN_RADIUS}"/>`;
      const dimmed = dimmedIds.has(note._id) || dimmedIds.has(link.targetId);
      // A hidden link keeps its hidden treatment regardless of the chosen pattern.
      const pattern = link.hidden ? "continuous" : cosmetics.pattern;
      const selected = link.id === this.selectedLinkId;
      const linkId = foundry.utils.escapeHTML(String(link.id ?? ""));

      const linkClasses = [
        colorClass,
        accentClass,
        `jn-link-material-${specs.material}`,
        `jn-link-pattern-${pattern}`,
        `jn-link-ends-${cosmetics.ends}`,
        selected ? "jn-link-selected" : "",
        this.routeDrop?.linkId === link.id ? "jn-link-drop-target" : "",
        dimmed ? "jn-link-dimmed" : "",
        link.hidden ? "jn-link-hidden" : "",
        link.hint ? "jn-link-hint" : ""
      ].filter(Boolean).join(" ");
      const k = Math.round(specs.k * 10000) / 10000;
      body += `<g data-id="${linkId}" class="${linkClasses}"
          style="--jn-thread-k:${k};--jn-thread-width:${specs.thickness}">
        <g class="jn-link-strokes" mask="url(#${this.threadMaskId})">
          <g class="jn-link-stack jn-link-stack-primary">${layerPaths()}</g>
          ${accentStack}
          ${tails}
        </g>
        ${endpoint(start)}
        ${endpoint(end)}
        ${pins.map((pin, index) => `<circle class="jn-thread-pin jn-board-pin" data-pin-index="${index}" cx="${pin.x}" cy="${pin.y}"/>`).join("")}
        ${link.label || link.hint ? `<text class="jn-link-label" x="${mx}" y="${my + 4}">${link.hint ? "&#10022; " : ""}${foundry.utils.escapeHTML(link.label ?? "")}</text>` : ""}
      </g>`;
      hits += `<path class="jn-link-hit" data-id="${linkId}" d="${d}"/>`;

      this.linksById.set(link.id, { sourceId: note._id, targetId: link.targetId, mx, my, ...link });
    }

    this.svg.innerHTML = this.#threadMask(boxes, threads) + body;
    this.linkHits.innerHTML = hits;
    this.linkGroupEls = new Map([...this.svg.querySelectorAll("g[data-id]")].map(group => [group.dataset.id, group]));
    this.linkHitEls = new Map([...this.linkHits.querySelectorAll(".jn-link-hit")].map(hit => [hit.dataset.id, hit]));
    this.maskShapeEls = new Map([...this.svg.querySelectorAll(".jn-thread-mask-shape")].map(shape => [shape.dataset.noteId, shape]));
    for (const [id, thread] of threads) {
      const key = String(id);
      const group = this.linkGroupEls.get(key);
      if (!group) continue;
      thread.group = group;
      thread.lines = [...group.querySelectorAll(".jn-thread-layer")];
      thread.tails = [...group.querySelectorAll(".jn-thread-tail")];
      thread.endpointPins = [...group.querySelectorAll(".jn-thread-pin:not(.jn-board-pin)")];
      thread.label = group.querySelector(".jn-link-label");
      thread.markers = [...group.querySelectorAll("[data-pin-index]")];
      thread.hit = this.linkHitEls.get(key) ?? null;
    }
    this.threads = threads;
    this.movingThreads = new Set([...threads].filter(([, thread]) => thread.motion.moving).map(([id]) => id));
    this.linkSignature = signature;
    if (this.previewPath) this.svg.appendChild(this.previewPath);
    if (this.previewPin) this.svg.appendChild(this.previewPin);
    if (this.edgePin) this.svg.appendChild(this.edgePin);
    if (this.draftPins) this.svg.appendChild(this.draftPins);
    if (this.routePreview) this.svg.appendChild(this.routePreview);
    if (this.routePreviewPin) this.svg.appendChild(this.routePreviewPin);
    this.#syncMaskState();
    if (animate && this.movingThreads.size) this.#requestThreadFrame();
  }

  /** Resolves one link's endpoints, pins, cosmetics and reusable spring state. */
  #resolveThread({ note, link, sourceSide, targetSide }, boxes, animate) {
    const sourceBox = boxes.get(note._id);
    const targetBox = boxes.get(link.targetId);
    const p = this.#anchorAttachment(note._id, sourceBox, link.sourceAnchorId)
      ?? threadAttachment(sourceBox, link.sourcePoint, sourceSide);
    const r = this.#anchorAttachment(link.targetId, targetBox, link.targetAnchorId)
      ?? threadAttachment(targetBox, link.targetPoint, targetSide);
    const cosmetics = resolveLinkCosmetics(link);
    const motion = this.threads.get(link.id)?.motion ?? new ThreadMotion(p, r, cosmetics.slack);
    motion.retarget(p, r, animate, cosmetics.slack);
    const savedPins = Array.isArray(link.pins) ? link.pins.slice(0, MAX_THREAD_PINS).filter(validThreadPin) : [];
    const pins = this.pinDrag?.id === link.id ? moveThreadPin(savedPins, this.pinDrag) ?? savedPins : savedPins;
    // Stable route order: source endpoint -> free board pins (in stored order) -> routed note
    // waypoints (in `routeAnchors` order) -> target endpoint. Route A only ever resolves the
    // canonical `main` attachment anchor, so a stale/malicious entry can never route through a
    // minor pin; missing anchors are ignored rather than synthesized.
    const routePoints = this.#routeWorldPoints(link, boxes);
    const waypoints = [...pins, ...routePoints];
    return { p, r, cosmetics, savedPins, pins, routePoints, waypoints, motion };
  }

  /** Resolve `link.routeAnchors` to world points, canonical main anchors only. */
  #routeWorldPoints(link, boxes) {
    const entries = Array.isArray(link.routeAnchors) ? link.routeAnchors : [];
    const points = [];
    // Defensive rendering: a disabled pin experiment or a note that re-enabled/removed its main
    // pin must not draw a waypoint the server would no longer accept. Missing anchors and secret/
    // trashed notes are skipped here too; the active GM prunes them on the next route write.
    if (!this.#pinsOn()) return points;
    for (const entry of entries) {
      if (!entry || entry.anchorId !== MAIN_ANCHOR_ID) continue;
      const box = boxes.get(entry.noteId);
      if (!box) continue;
      const note = this.notes.find(item => item._id === entry.noteId);
      if (!note || note.secret) continue;
      if (resolveAttachment(note).mainPinEnabled === false) continue;
      const anchor = this.#cardAnchor(entry.noteId, entry.anchorId);
      if (!isMainAnchor(anchor)) continue;
      const point = this.#anchorWorldAttachment(box, anchor);
      if (point) points.push(point);
    }
    return points;
  }

  /** World attachment for a note's canonical main pin, if the note has one. */
  #mainRouteAttachment(noteId) {
    const anchor = this.#cardAnchor(noteId, MAIN_ANCHOR_ID);
    if (!isMainAnchor(anchor)) return null;
    return this.#anchorWorldAttachment(this.#cardBox(noteId), anchor);
  }

  /**
   * Why each drop mode is unavailable for this note/link. The chooser always keeps both
   * choices visible and explains a disabled mode instead of hiding or silently changing it.
   */
  #routeAvailability(note, link) {
    const attachment = resolveAttachment(note);
    const main = this.#cardAnchor(note._id, MAIN_ANCHOR_ID);
    let routeReason = "";
    if (!this.#pinsOn() || !attachment.mainPinEnabled || !isMainAnchor(main)) {
      routeReason = "JN.Route.PinOff";
    } else if ((link.routeAnchors?.length ?? 0) >= MAX_ROUTE_ANCHORS) {
      // The server caps a routed thread; disable the action before the user can request it.
      routeReason = "JN.Route.Limit";
    }
    let splitReason = "";
    if (link.origin === "typed") splitReason = "JN.Route.TypedBlocked";
    else if ((link.pins?.length ?? 0) > 0 || (link.routeAnchors?.length ?? 0) > 0) {
      // The server's split policy refuses board pins and routed waypoints; the supplied hint
      // doubles as the explicit explanation instead of hiding the choice.
      splitReason = "JN.Route.SplitHint";
    }
    return {
      routeDisabled: !!routeReason,
      routeReason,
      splitDisabled: !!splitReason,
      splitReason
    };
  }

  /** Class-only highlight + optional route preview while a card drag hovers a thread. */
  #setRouteDropTarget(linkId) {
    if (this.routeDrop?.linkId === linkId) {
      // Keep the tentative Route A waypoint attached to the note while it moves.
      if (linkId) this.#updateRoutePreview(linkId);
      return;
    }
    for (const group of this.svg.querySelectorAll(".jn-link-drop-target")) {
      group.classList.remove("jn-link-drop-target");
    }
    this.routeDrop = linkId ? { linkId } : null;
    if (!linkId) {
      this.#clearRoutePreview();
      return;
    }
    const group = [...this.svg.querySelectorAll("g[data-id]")]
      .find(item => item.dataset.id === String(linkId));
    group?.classList.add("jn-link-drop-target");
    this.#updateRoutePreview(linkId);
  }

  #clearRouteDrop() {
    this.routeDrop = null;
    this.routeDragNoteId = null;
    for (const group of this.svg?.querySelectorAll(".jn-link-drop-target") ?? []) {
      group.classList.remove("jn-link-drop-target");
    }
    this.#clearRoutePreview();
  }

  #clearRoutePreview() {
    this.routePreview?.remove();
    this.routePreview = null;
    this.routePreviewPin?.remove();
    this.routePreviewPin = null;
  }

  /**
   * Route A preview: the existing path plus the dragged note's main pin appended as the last
   * waypoint (the same insertion index the chooser sends). Only drawn when Route A is possible.
   */
  #updateRoutePreview(linkId) {
    const thread = this.threads.get(linkId);
    const link = this.linksById.get(linkId);
    if (!thread || !link) return this.#clearRoutePreview();
    const note = this.notes.find(item => item._id === this.routeDragNoteId);
    const availability = note ? this.#routeAvailability(note, link) : null;
    const main = this.routeDragNoteId ? this.#mainRouteAttachment(this.routeDragNoteId) : null;
    if (!availability || availability.routeDisabled || !main) {
      this.#clearRoutePreview();
      return;
    }
    const waypoints = [...(thread.waypoints ?? thread.pins), main];
    const cosmetics = resolveLinkCosmetics(link);
    // Preview the same physics as the live thread: passing the real motion keeps the tentative
    // path from jumping when a settled/pulled thread is already offset by its spring state.
    const { path } = pinnedThreadPath(thread.start, thread.end, waypoints, thread.motion, cosmetics.slack);
    if (!this.routePreview) {
      this.routePreview = document.createElementNS("http://www.w3.org/2000/svg", "path");
      this.routePreview.setAttribute("class", "jn-route-preview");
      this.svg.appendChild(this.routePreview);
      this.routePreviewPin = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      this.routePreviewPin.setAttribute("class", "jn-route-preview-pin");
      this.svg.appendChild(this.routePreviewPin);
    }
    this.routePreview.setAttribute("d", path);
    this.routePreviewPin.setAttribute("cx", main.x);
    this.routePreviewPin.setAttribute("cy", main.y);
    this.routePreviewPin.setAttribute("r", String(5 / this.view.k));
  }

  /** Find the closest eligible thread under the dragged note's center (screen-space radius). */
  #updateRouteDropTarget(drag, ev) {
    if (typeof this.callbacks.onRouteNoteOnLink !== "function"
        || !drag || drag.type !== "card" || drag.readOnly || drag.ids.length !== 1
        || drag.moved <= DRAG_THRESHOLD) {
      this.#setRouteDropTarget(null);
      return;
    }
    const noteId = drag.id;
    const note = this.notes.find(item => item._id === noteId);
    // Secret/vault notes and hidden links are outside the shared route transaction; never offer
    // an operation the active GM would silently reject.
    if (!note || note.secret) {
      this.#setRouteDropTarget(null);
      return;
    }
    const box = this.#cardBox(noteId);
    const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const radius = ROUTE_DROP_RADIUS / this.view.k;
    let best = null;
    for (const [linkId, thread] of this.threads) {
      const link = this.linksById.get(linkId);
      if (!link || !thread.hit || link.hidden) continue;
      if (link.sourceId === noteId || link.targetId === noteId) continue;
      if ((link.routeAnchors ?? []).some(entry => entry?.noteId === noteId)) continue;
      const distance = distanceToThreadPath(thread.hit.getAttribute("d"), center);
      if (!Number.isFinite(distance) || distance > radius) continue;
      if (!best || distance < best.distance) best = { linkId, distance };
    }
    this.routeDragNoteId = noteId;
    this.#setRouteDropTarget(best?.linkId ?? null);
  }

  /**
   * Screen-space mode chooser, built only after a card drop. It overlays the canvas without
   * changing layout; both choices stay visible and disabled modes carry their explanation.
   */
  #openRouteChooser({ linkId, noteId, clientX, clientY }) {
    const link = this.linksById.get(linkId);
    const note = this.notes.find(item => item._id === noteId);
    if (!link || !note) {
      this.#clearRouteDrop();
      return;
    }
    if (this.routeChooser) this.#closeRouteChooser({ keepDrop: true });
    const availability = this.#routeAvailability(note, link);
    const index = Array.isArray(link.routeAnchors) ? link.routeAnchors.length : 0;
    this.routeChooserTarget = { linkId, noteId };
    const active = this.root.ownerDocument.activeElement;
    this.routeChooserReturnFocus = active && active !== this.root.ownerDocument.body ? active : null;
    const el = document.createElement("div");
    el.className = "jn-route-chooser";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", t("JN.Route.Title"));
    const reason = (key, id) => key
      ? `<small class="jn-route-reason" id="${id}">${t(key)}</small>` : "";
    el.innerHTML = `
      <div class="jn-route-heading">${t("JN.Route.Title")}</div>
      <button type="button" class="jn-route-choice jn-route-through${availability.routeDisabled ? " disabled" : ""}"
        ${availability.routeDisabled ? "disabled" : ""}${availability.routeReason ? ` aria-describedby="jn-route-route-reason"` : ""}>
        <i class="fa-solid fa-route" aria-hidden="true"></i>
        <span><b>${t("JN.Route.RouteThrough")}</b>${reason(availability.routeReason, "jn-route-route-reason")}</span>
      </button>
      <button type="button" class="jn-route-choice jn-route-split${availability.splitDisabled ? " disabled" : ""}"
        ${availability.splitDisabled ? "disabled" : ""}${availability.splitReason ? ` aria-describedby="jn-route-split-reason"` : ""}>
        <i class="fa-solid fa-code-branch" aria-hidden="true"></i>
        <span><b>${t("JN.Route.Split")}</b>${reason(availability.splitReason, "jn-route-split-reason")}</span>
      </button>
      <button type="button" class="jn-route-cancel">${t("JN.Route.Cancel")}</button>
    `;
    this.root.appendChild(el);
    this.routeChooser = el;

    // Position in screen space, clamped like the context menu so it never leaves the canvas.
    const rootRect = this.root.getBoundingClientRect();
    let left = clientX - rootRect.left;
    let top = clientY - rootRect.top;
    const crop = el.getBoundingClientRect();
    left = Math.max(6, Math.min(left, rootRect.width - crop.width - 6));
    top = Math.max(6, Math.min(top, rootRect.height - crop.height - 6));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const chooseRoute = () => {
      if (this.routeChooser !== el || availability.routeDisabled) return;
      // No optimistic toast: JournalApp shows JN.Route.Routed only after the GM acknowledges the
      // write. A rejected route therefore never claims success.
      this.callbacks.onRouteNoteOnLink?.(link.sourceId, link.id, noteId, "route", index, undefined);
      this.#closeRouteChooser({ restoreFocus: true });
    };
    const chooseSplit = () => {
      if (this.routeChooser !== el || availability.splitDisabled) return;
      const undoId = foundry.utils.randomID();
      this.callbacks.onRouteNoteOnLink?.(link.sourceId, link.id, noteId, "split", index, undoId);
      this.#closeRouteChooser({ restoreFocus: true });
    };
    el.querySelector(".jn-route-through").addEventListener("click", chooseRoute);
    el.querySelector(".jn-route-split").addEventListener("click", chooseSplit);
    el.querySelector(".jn-route-cancel").addEventListener("click", () => {
      this.#closeRouteChooser({ restoreFocus: true });
    });
    // A real focus trap: Tab and Shift+Tab cycle only through the enabled choices, never escaping
    // to the rest of the Foundry UI while the modal chooser is open.
    el.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      event.stopPropagation();
      const items = [...el.querySelectorAll("button:not([disabled])")];
      if (!items.length) return;
      const current = items.indexOf(this.root.ownerDocument.activeElement);
      const next = current < 0
        ? (event.shiftKey ? items.length - 1 : 0)
        : (current + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    });
    const focusables = [...el.querySelectorAll("button:not([disabled])")];
    (focusables[0] ?? el.querySelector(".jn-route-cancel")).focus({ preventScroll: true });

    this.routeChooserDismiss = ev => {
      if (this.routeChooser !== el || el.contains(ev.target)) return;
      this.#closeRouteChooser({ restoreFocus: true });
    };
    this.root.ownerDocument.addEventListener("pointerdown", this.routeChooserDismiss, true);
  }

  #closeRouteChooser({ restoreFocus = false, keepDrop = false } = {}) {
    if (this.routeChooserDismiss) {
      this.root.ownerDocument.removeEventListener("pointerdown", this.routeChooserDismiss, true);
      this.routeChooserDismiss = null;
    }
    const chooser = this.routeChooser;
    const returnFocus = this.routeChooserReturnFocus;
    this.routeChooser = null;
    this.routeChooserTarget = null;
    this.routeChooserReturnFocus = null;
    chooser?.remove();
    if (!keepDrop) this.#clearRouteDrop();
    if (restoreFocus) {
      if (returnFocus?.isConnected && typeof returnFocus.focus === "function") {
        returnFocus.focus({ preventScroll: true });
      } else {
        this.root.focus({ preventScroll: true });
      }
    }
  }

  /**
   * Everything that changes the SVG node structure or its classes. Geometry (position, size,
   * rotation) and live pin/pull coordinates are deliberately excluded so drags reuse the DOM.
   */
  #linkSignature(links, boxes, dimmedIds) {
    const cards = [];
    for (const [id, box] of boxes) {
      const card = this.layout.cards?.[id];
      const anchors = card?.anchors && typeof card.anchors === "object" ? card.anchors : {};
      const anchorKey = Object.keys(anchors).sort().map(anchorId => {
        const anchor = anchors[anchorId];
        return `${anchorId}:${anchor?.kind ?? ""}:${anchor?.x ?? ""}:${anchor?.y ?? ""}`;
      }).join("|");
      cards.push(`${String(id)}:${this.cardEls.get(id)?.classList.contains("jn-torn") ? 1 : 0}:${anchorKey}`);
    }
    const parts = links.map(({ note, link, sourceSide, targetSide }) => {
      const cosmetics = resolveLinkCosmetics(link);
      const savedPins = Array.isArray(link.pins) ? link.pins.slice(0, MAX_THREAD_PINS).filter(validThreadPin) : [];
      const dimmed = dimmedIds.has(note._id) || dimmedIds.has(link.targetId);
      return [
        String(link.id), note._id, link.targetId, normalizeLinkColor(link.color),
        cosmetics.secondaryColor, cosmetics.material, cosmetics.thickness, cosmetics.pattern,
        cosmetics.ends, link.hidden ? 1 : 0, link.hint ? 1 : 0, link.label ?? "",
        savedPins.length, link.id === this.selectedLinkId ? 1 : 0, dimmed ? 1 : 0,
        sourceSide, targetSide, link.sourceAnchorId ?? "", link.targetAnchorId ?? "",
        (link.routeAnchors ?? []).map(entry => `${entry?.noteId ?? ""}:${entry?.anchorId ?? ""}`).join(",")
      ].join("\u0001");
    });
    return `${cards.join("\u0002")}\u0003${parts.join("\u0002")}`;
  }

  /** True when the previous full rebuild left every node this fast path needs. */
  #linkStructureReady(links) {
    if (!this.svg.querySelector("mask")) return false;
    if (this.maskShapeEls.size !== this.cardEls.size) return false;
    for (const id of this.cardEls.keys()) {
      if (!this.maskShapeEls.has(String(id))) return false;
    }
    for (const { link } of links) {
      const key = String(link.id);
      if (!this.linkGroupEls.has(key) || !this.linkHitEls.has(key)) return false;
    }
    return true;
  }

  /** Geometry-only refresh: recompute paths, pins, labels, hits and mask points in place. */
  #updateLinkGeometry(links, boxes, animate, dimmedIds) {
    const threads = new Map();
    for (const entry of links) {
      const { note, link } = entry;
      const { p, r, cosmetics, pins, routePoints, waypoints, motion } = this.#resolveThread(entry, boxes, animate);
      const { path: d, center: { x: mx, y: my }, start, end } = pinnedThreadPath(p, r, waypoints, motion, cosmetics.slack);
      const key = String(link.id);
      const group = this.linkGroupEls.get(key);
      const hit = this.linkHitEls.get(key);
      if (!group || !hit) return false;
      const previous = this.threads.get(link.id);
      const thread = {
        start: p, end: r, pins, routePoints, waypoints, motion, group, hit,
        lines: previous?.lines ?? [...group.querySelectorAll(".jn-thread-layer")],
        tails: previous?.tails ?? [...group.querySelectorAll(".jn-thread-tail")],
        endpointPins: previous?.endpointPins ?? [...group.querySelectorAll(".jn-thread-pin:not(.jn-board-pin)")],
        label: previous?.label ?? group.querySelector(".jn-link-label"),
        markers: previous?.markers ?? [...group.querySelectorAll("[data-pin-index]")]
      };
      for (const line of thread.lines) line.setAttribute("d", d);
      if (thread.tails.length) {
        const tailPaths = looseTails(start, end);
        thread.tails.forEach((tail, index) => {
          if (tailPaths[index]) tail.setAttribute("d", tailPaths[index].d);
        });
      }
      thread.endpointPins.forEach((pin, index) => {
        const anchor = index === 0 ? start : end;
        pin.setAttribute("cx", anchor.x - anchor.nx * THREAD_PIN_RADIUS);
        pin.setAttribute("cy", anchor.y - anchor.ny * THREAD_PIN_RADIUS);
      });
      thread.markers.forEach((marker, index) => {
        const pin = pins[index];
        if (!pin) return;
        marker.setAttribute("cx", pin.x);
        marker.setAttribute("cy", pin.y);
      });
      if (thread.label) {
        thread.label.setAttribute("x", mx);
        thread.label.setAttribute("y", my + 4);
      }
      hit.setAttribute("d", d);
      threads.set(link.id, thread);
      this.linksById.set(link.id, { sourceId: note._id, targetId: link.targetId, mx, my, ...link });
    }
    this.threads = threads;
    this.movingThreads = new Set([...threads].filter(([, thread]) => thread.motion.moving).map(([id]) => id));
    if (!this.#updateThreadMask(boxes, threads)) return false;
    this.#syncMaskState();
    if (animate && this.movingThreads.size) this.#requestThreadFrame();
    return true;
  }

  /** Updates mask bounds and polygon points without replacing the mask element. */
  #updateThreadMask(boxes, threads) {
    const mask = this.svg.querySelector("mask");
    const rect = mask?.querySelector(".jn-thread-mask-bg");
    if (!mask || !rect) return false;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const extend = (x, y) => {
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    };
    for (const [id, box] of boxes) {
      const corners = this.#cardSilhouette(id, box);
      const shape = this.maskShapeEls.get(String(id));
      if (!shape) return false;
      for (const { x, y } of corners) extend(x, y);
      shape.setAttribute("points", corners.map(({ x, y }) => `${x},${y}`).join(" "));
    }
    for (const { start, end, pins, waypoints } of threads.values()) {
      extend(start.x, start.y);
      extend(end.x, end.y);
      for (const { x, y } of waypoints ?? pins) extend(x, y);
    }
    if (!Number.isFinite(left)) left = top = right = bottom = 0;
    const pad = 320;
    const width = Math.max(1, right - left + pad * 2);
    const height = Math.max(1, bottom - top + pad * 2);
    const bounds = [
      ["x", left - pad], ["y", top - pad], ["width", width], ["height", height]
    ];
    for (const [name, value] of bounds) {
      mask.setAttribute(name, value);
      rect.setAttribute(name, value);
    }
    return true;
  }

  /** World-space silhouette for one card: rotated rectangle, or the exact seeded torn polygon. */
  #cardSilhouette(id, box) {
    const points = this.cardEls.get(id)?.classList.contains("jn-torn")
      ? tearPoints(id)
      : CARD_CORNERS.map(point => ({ x: point.x * 100, y: point.y * 100 }));
    return points.map(point => cardPointAnchor(box, { x: point.x / 100, y: point.y / 100 }));
  }

  /**
   * One stable fade mask per canvas instance. Every card silhouette is white (no fade) by
   * default; hovering, locking or inline-editing a note flips only that polygon to the theme's
   * fade luminance. The mask is applied to `.jn-link-strokes` only, so pins, labels and hit
   * paths never fade.
   */
  #threadMask(boxes, threads) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    let silhouettes = "";
    const extend = (x, y) => {
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    };
    for (const [id, box] of boxes) {
      const corners = this.#cardSilhouette(id, box);
      for (const { x, y } of corners) extend(x, y);
      silhouettes += `<polygon class="jn-thread-mask-shape" data-note-id="${foundry.utils.escapeHTML(String(id))}"
        points="${corners.map(({ x, y }) => `${x},${y}`).join(" ")}"/>`;
    }
    for (const { start, end, pins, waypoints } of threads.values()) {
      extend(start.x, start.y);
      extend(end.x, end.y);
      for (const { x, y } of waypoints ?? pins) extend(x, y);
    }
    if (!Number.isFinite(left)) left = top = right = bottom = 0;
    // Include the maximum travel of a pulled thread and its control points.
    const pad = 320;
    const width = Math.max(1, right - left + pad * 2);
    const height = Math.max(1, bottom - top + pad * 2);
    const bounds = `x="${left - pad}" y="${top - pad}" width="${width}" height="${height}"`;
    return `<defs><mask id="${this.threadMaskId}" maskUnits="userSpaceOnUse" ${bounds}>
      <rect class="jn-thread-mask-bg" ${bounds}/>${silhouettes}
    </mask></defs>`;
  }

  /** Class-only fade sync: hover/editing never rebuilds the SVG or thread paths. */
  #syncMaskState() {
    const active = new Set();
    if (this.hoverNoteId) active.add(this.hoverNoteId);
    if (this.focusedNoteId) active.add(this.focusedNoteId);
    for (const [id, el] of this.cardEls) {
      if (el.classList.contains("jn-being-edited") || this.inlineText?.id === id) active.add(id);
    }
    for (const shape of this.svg.querySelectorAll(".jn-thread-mask-shape")) {
      shape.classList.toggle("jn-thread-mask-active", active.has(shape.dataset.noteId));
    }
  }

  #requestThreadFrame() {
    if (this.threadFrame !== null) return;
    const win = this.root.ownerDocument.defaultView;
    this.threadFrame = win.requestAnimationFrame?.(now => this.#animateThreads(now)) ?? null;
  }

  #animateThreads(now) {
    this.threadFrame = null;
    const elapsed = this.threadTime === null ? 1 / 60 : Math.min(0.032, (now - this.threadTime) / 1000);
    this.threadTime = now;
    for (const id of this.movingThreads) {
      const thread = this.threads.get(id);
      thread.motion.step(elapsed);
      this.#paintThread(id, thread);
      if (!thread.motion.moving) this.movingThreads.delete(id);
    }
    if (this.movingThreads.size && this.root.isConnected) this.#requestThreadFrame();
    else this.threadTime = null;
  }

  #paintThread(id, thread) {
    const { path, center, start, end } = pinnedThreadPath(thread.start, thread.end, thread.waypoints ?? thread.pins, thread.motion);
    thread.lines?.forEach(line => line.setAttribute("d", path));
    if (thread.tails?.length) {
      const tailPaths = looseTails(start, end);
      thread.tails.forEach((tail, index) => {
        if (tailPaths[index]) tail.setAttribute("d", tailPaths[index].d);
      });
    }
    thread.endpointPins?.forEach((pin, index) => {
      const anchor = index === 0 ? start : end;
      pin.setAttribute("cx", anchor.x - anchor.nx * THREAD_PIN_RADIUS);
      pin.setAttribute("cy", anchor.y - anchor.ny * THREAD_PIN_RADIUS);
    });
    thread.hit?.setAttribute("d", path);
    thread.label?.setAttribute("x", center.x);
    thread.label?.setAttribute("y", center.y + 4);
    thread.pins.forEach((pin, index) => {
      const marker = thread.markers[index];
      if (!marker) return;
      marker.setAttribute("cx", pin.x);
      marker.setAttribute("cy", pin.y);
    });
    const link = this.linksById.get(id);
    link.mx = center.x;
    link.my = center.y;
    if (id === this.selectedLinkId) this.#positionLinkToolbar(link);
  }

  /** Limits expensive SVG rebuilds to one per animation-sized interval while dragging. */
  #queueLinkDraw() {
    if (this.linkDrawTimer !== null) return;
    this.linkDrawTimer = setTimeout(() => {
      this.linkDrawTimer = null;
      this.refreshGeometry();
    }, 16);
  }

  #flushLinkDraw() {
    if (this.linkDrawTimer !== null) clearTimeout(this.linkDrawTimer);
    this.linkDrawTimer = null;
    this.#drawLinks();
    this.#syncLinkToolbar();
    this.#syncFloatingToolbar();
  }

  #positionLinkToolbar(link) {
    this.linkToolbar.style.left = `${link.mx * this.view.k + this.view.x}px`;
    this.linkToolbar.style.top = `${link.my * this.view.k + this.view.y}px`;
  }

  #bindToolbarDismiss() {
    if (this.toolbarDismiss) return;
    const doc = this.root.ownerDocument;
    this.toolbarDismiss = ev => {
      if (this.linkToolbar.contains(ev.target)) return;
      if (ev.target.closest?.(".jn-floating-toolbar, .jn-floating-popover")) return;
      this.#closeLinkToolbar();
    };
    doc.addEventListener("pointerdown", this.toolbarDismiss, true);
  }

  #unbindToolbarDismiss() {
    if (!this.toolbarDismiss) return;
    this.root.ownerDocument.removeEventListener("pointerdown", this.toolbarDismiss, true);
    this.toolbarDismiss = null;
  }

  #hideLinkToolbar() {
    this.linkToolbar.style.display = "none";
    delete this.linkToolbar.dataset.linkId;
    this.#unbindToolbarDismiss();
  }

  /** Closes the panel; Escape/focus return goes back to the link's source card or the canvas. */
  #closeLinkToolbar({ restoreFocus = false } = {}) {
    const link = this.selectedLinkId ? this.linksById.get(this.selectedLinkId) : null;
    this.selectedLinkId = null;
    this.#syncLinkSelection();
    this.#hideLinkToolbar();
    if (!restoreFocus) return;
    const card = link?.sourceId ? this.cardEls.get(link.sourceId) : null;
    const target = card?.querySelector("[data-card-text]:not([hidden])") ?? this.root;
    target.focus?.({ preventScroll: true });
  }

  #syncLinkToolbar() {
    const link = this.selectedLinkId ? this.linksById.get(this.selectedLinkId) : null;
    if (!link || this.readOnly) { this.#hideLinkToolbar(); return; }

    const wasOpen = this.linkToolbar.style.display === "flex"
      && this.linkToolbar.dataset.linkId === String(link.id);
    this.#positionLinkToolbar(link);
    this.linkToolbar.style.display = "flex";
    this.linkToolbar.dataset.linkId = String(link.id);
    this.#bindToolbarDismiss();
    const currentColor = normalizeLinkColor(link.color);
    const cosmetics = resolveLinkCosmetics(link);
    const secondary = cosmetics.secondaryColor;
    const swatch = slot => {
      const label = t(slot ? `JN.Link.Color.${slot}` : "JN.Link.Color.default");
      return `<button type="button" class="jn-link-color jn-link-swatch-${slot || "default"}${slot === currentColor ? " on" : ""}"
        data-color="${slot}" title="${label}" aria-label="${label}" aria-pressed="${slot === currentColor}"></button>`;
    };
    const secondarySwatch = slot => {
      const label = t(slot ? `JN.Link.Secondary.${slot}` : "JN.Link.Secondary.default");
      return `<button type="button" class="jn-link-color jn-link-secondary jn-link-secondary-${slot || "default"}${slot === secondary ? " on" : ""}"
        data-secondary="${slot}" title="${label}" aria-label="${label}" aria-pressed="${slot === secondary}"></button>`;
    };
    const label = id => t(`JN.Link.Preset.${id.charAt(0).toUpperCase()}${id.slice(1)}`);
    const presets = Object.entries(THREAD_PRESETS).map(([id, preset]) =>
      `<button type="button" class="jn-link-preset" data-preset="${id}"
        title="${label(id)} · ${preset.thickness.toFixed(1)} px · ${Math.round(preset.slack * 100)}%">${label(id)}</button>`).join("");
    const options = (values, selected, prefix) => values.map(value =>
      `<option value="${value}"${value === selected ? " selected" : ""}>${t(`JN.Link.${prefix}.${value}`)}</option>`).join("");
    this.linkToolbar.innerHTML = `
      <div class="jn-link-row jn-link-presets" role="group" aria-label="${t("JN.Link.Presets")}">${presets}</div>
      <div class="jn-link-row">
        <label class="jn-link-field">
          <span>${t("JN.Link.Material")}</span>
          <select class="jn-link-material" title="${t("JN.Link.Material")}">
            ${options(["linen", "double"], cosmetics.material, "MaterialOption")}
          </select>
        </label>
        <label class="jn-link-field">
          <span>${t("JN.Link.Thickness")} <output class="jn-link-thickness-out">${cosmetics.thickness.toFixed(1)} px</output></span>
          <input type="range" class="jn-link-thickness" min="0.8" max="5" step="0.1"
            value="${cosmetics.thickness}" title="${t("JN.Link.Thickness")}" aria-label="${t("JN.Link.Thickness")}">
        </label>
        <label class="jn-link-field">
          <span>${t("JN.Link.Slack")} <output class="jn-link-slack-out">${Math.round(cosmetics.slack * 100)}%</output></span>
          <input type="range" class="jn-link-slack" min="0" max="25" step="1"
            value="${Math.round(cosmetics.slack * 100)}" title="${t("JN.Link.Slack")}" aria-label="${t("JN.Link.Slack")}">
        </label>
      </div>
      <div class="jn-link-row">
        <label class="jn-link-field">
          <span>${t("JN.Link.Pattern")}</span>
          <select class="jn-link-pattern" title="${t("JN.Link.Pattern")}">
            ${options(["continuous", "interrupted", "alternating"], cosmetics.pattern, "PatternOption")}
          </select>
        </label>
        <label class="jn-link-field">
          <span>${t("JN.Link.Ends")}</span>
          <select class="jn-link-ends" title="${t("JN.Link.Ends")}">
            ${options(["standard", "loose"], cosmetics.ends, "EndOption")}
          </select>
        </label>
      </div>
      <div class="jn-link-row">
        <span class="jn-link-colors" role="group" aria-label="${t("JN.Link.Color.default")}">${LINK_COLOR_OPTIONS.map(swatch).join("")}</span>
        <span class="jn-link-colors jn-link-secondary-colors" role="group" aria-label="${t("JN.Link.SecondaryColor")}">${LINK_COLOR_OPTIONS.map(secondarySwatch).join("")}</span>
        <input type="text" class="jn-link-label-input" placeholder="${t("JN.Link.Label")}" value="${foundry.utils.escapeHTML(link.label ?? "")}">
      </div>
      <div class="jn-link-row jn-link-actions">
        ${this.#clearBoardPinsButton(link)}
        ${this.#routeDetachButtons(link)}
        ${this.#gmLinkButtons(link)}
        <button type="button" class="jn-link-delete" title="${t("JN.Link.Delete")}">✕</button>
      </div>
    `;

    const update = fields => this.callbacks.onUpdateLink?.(link.sourceId, link.id, fields);
    // Commit on change (blur), not per keystroke: one socket message and one world write
    // per label edit, matching the block-save rule in spec §6.2.
    this.linkToolbar.querySelector(".jn-link-label-input").onchange = ev => update({ label: ev.target.value });
    this.linkToolbar.querySelectorAll(".jn-link-color:not(.jn-link-secondary)").forEach(btn => {
      btn.onclick = () => update({ color: btn.dataset.color });
    });
    // Accent dye is an independent field: these swatches never touch the primary `color`.
    this.linkToolbar.querySelectorAll(".jn-link-secondary").forEach(btn => {
      btn.onclick = () => update({ secondaryColor: btn.dataset.secondary });
    });

    const material = this.linkToolbar.querySelector(".jn-link-material");
    const thickness = this.linkToolbar.querySelector(".jn-link-thickness");
    const slack = this.linkToolbar.querySelector(".jn-link-slack");
    const pattern = this.linkToolbar.querySelector(".jn-link-pattern");
    const ends = this.linkToolbar.querySelector(".jn-link-ends");
    const thicknessOut = this.linkToolbar.querySelector(".jn-link-thickness-out");
    const slackOut = this.linkToolbar.querySelector(".jn-link-slack-out");
    // Range input only updates its readout; the write happens once on change (pointer release).
    thickness.oninput = () => { thicknessOut.textContent = `${Number(thickness.value).toFixed(1)} px`; };
    slack.oninput = () => { slackOut.textContent = `${Math.round(Number(slack.value))}%`; };
    thickness.onchange = () => update({ thickness: Number(thickness.value) });
    slack.onchange = () => update({ slack: Number(slack.value) / 100 });
    material.onchange = () => update({ material: material.value });
    pattern.onchange = () => update({ pattern: pattern.value });
    ends.onchange = () => update({ ends: ends.value });

    // Presets set only their three defaults plus a neutral pattern/end treatment. Every other
    // parameter stays independently controlled.
    this.linkToolbar.querySelectorAll(".jn-link-preset").forEach(btn => {
      btn.onclick = () => {
        const preset = THREAD_PRESETS[btn.dataset.preset];
        if (!preset) return;
        material.value = preset.material;
        thickness.value = String(preset.thickness);
        thicknessOut.textContent = `${preset.thickness.toFixed(1)} px`;
        slack.value = String(Math.round(preset.slack * 100));
        slackOut.textContent = `${Math.round(preset.slack * 100)}%`;
        pattern.value = "continuous";
        ends.value = "standard";
        update({
          material: preset.material,
          thickness: preset.thickness,
          slack: preset.slack,
          pattern: "continuous",
          ends: "standard"
        });
      };
    });
    const gmButton = (selector, fn) => {
      const btn = this.linkToolbar.querySelector(selector);
      if (btn) btn.onclick = () => {
        fn();
        this.#closeLinkToolbar();
      };
    };
    gmButton(".jn-link-hide", () => this.callbacks.onHideLink?.(link.sourceId, link.id));
    gmButton(".jn-link-reveal", () => this.callbacks.onRevealLink?.(link.sourceId, link.id));
    const hintBtn = this.linkToolbar.querySelector(".jn-link-hint-toggle");
    if (hintBtn) hintBtn.onclick = () => this.callbacks.onToggleLinkHint?.(link.sourceId, link.id, !link.hint);
    this.linkToolbar.querySelectorAll(".jn-link-detach").forEach(btn => {
      btn.onclick = () => {
        const undoId = foundry.utils.randomID();
        this.callbacks.onDetachRouteNote?.(link.sourceId, link.id, btn.dataset.routeNoteId, undoId);
        this.#closeLinkToolbar();
      };
    });
    this.linkToolbar.querySelector(".jn-link-clear-pins")?.addEventListener("click", () => {
      this.callbacks.onClearThreadPins?.(link.sourceId, link.id);
      this.#closeLinkToolbar();
    });
    this.linkToolbar.querySelector(".jn-link-delete").onclick = () => {
      this.callbacks.onDeleteLink(link.sourceId, link.id);
      this.#closeLinkToolbar();
    };

    // Opening the panel moves focus to its first control; later geometry/pin syncs rebuild the
    // markup but must not steal focus back from whatever control the user is using.
    if (!wasOpen) {
      const first = this.linkToolbar.querySelector("button, select, input");
      first?.focus?.({ preventScroll: true });
    }
  }

  /** Selection is a class toggle, so clicking a thread never forces a full SVG rebuild. */
  #syncLinkSelection() {
    for (const group of this.svg.querySelectorAll("g[data-id]")) {
      group.classList.toggle("jn-link-selected", group.dataset.id === this.selectedLinkId);
    }
    this.#syncFloatingToolbar();
  }

  // --- Floating contextual toolbar ---------------------------------------------------------
  // Screen-space overlay anchored to the canvas edge, never inside `.jn-world`. It only opens a
  // popover on demand, so selection sync is O(selected) and never builds controls per render.

  #floatingSelection() {
    const link = this.selectedLinkId ? this.linksById.get(this.selectedLinkId) : null;
    if (link) return { kind: "link", link, ids: [], notes: [] };
    const ids = this.getSelectedNoteIds();
    if (!ids.length) return null;
    const notes = ids.map(id => this.notesById.get(id)).filter(Boolean);
    return notes.length ? { kind: "notes", notes, ids: notes.map(note => note._id) } : null;
  }

  #syncFloatingToolbar() {
    const selection = this.#floatingSelection();
    const signature = selection
      ? (selection.kind === "link"
        ? `link:${selection.link.id}:${this.readOnly ? 1 : 0}`
        : `notes:${selection.ids.join(",")}:${this.readOnly ? 1 : 0}:${selection.notes.some(note => note.secret) ? 1 : 0}:${this.#pinsOn() ? 1 : 0}`)
      : "none";
    if (signature === this.floatingToolbarSignature) return;
    this.floatingToolbarSignature = signature;
    this.#closeFloatingPopover();
    if (!selection) {
      this.floatingToolbar.hidden = true;
      this.floatingToolbar.replaceChildren();
      return;
    }
    this.floatingToolbar.replaceChildren(...this.#floatingButtons(selection));
    this.floatingToolbar.hidden = false;
  }

  #floatingButton(group, definition, disabled) {
    const label = t(definition.label);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `jn-ft-btn jn-ft-btn-${group}`;
    button.dataset.group = group;
    const accessible = disabled
      ? `${label} — ${t(this.readOnly ? "JN.Toolbar.ReadOnly" : "JN.Toolbar.Disabled")}`
      : label;
    button.setAttribute("aria-label", accessible);
    button.setAttribute("title", accessible);
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-controls", this.floatingPopoverId);
    button.setAttribute("aria-expanded", "false");
    button.disabled = !!disabled;
    button.innerHTML = `<span class="jn-ft-label" aria-hidden="true">${foundry.utils.escapeHTML(label)}</span>`
      + `<i class="fa-solid ${definition.icon}" aria-hidden="true"></i>`;
    if (!disabled) {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        this.#openFloatingPopover(group, button);
      });
    }
    return button;
  }

  #floatingButtons(selection) {
    if (selection.kind === "link") {
      return Object.entries(LINK_TOOL_GROUPS).map(([group, definition]) =>
        this.#floatingButton(group, definition, this.readOnly));
    }
    const single = selection.notes.length === 1;
    const secretMixed = !single && selection.notes.some(note => note.secret);
    const disabled = this.readOnly || secretMixed;
    const groups = ["style"];
    if (single) groups.push("force");
    groups.push("font", "picture", "torn");
    if (this.#pinsOn()) groups.push("pin");
    if (single) groups.push("dimensions");
    const buttons = [];
    // Mixed shared + GM-only multi-selection: bulk writes are disabled with an explicit reason
    // instead of partially applying to one tier and leaking the difference.
    if (secretMixed) buttons.push(this.#floatingButton("locked", NOTE_TOOL_GROUPS.locked, false));
    for (const group of groups) buttons.push(this.#floatingButton(group, NOTE_TOOL_GROUPS[group], disabled));
    return buttons;
  }

  #openFloatingPopover(group, button) {
    const selection = this.#floatingSelection();
    if (!selection) return;
    if (selection.kind === "link" && !LINK_TOOL_GROUPS[group]) return;
    if (selection.kind === "notes") {
      if (!NOTE_TOOL_GROUPS[group]) return;
      if ((group === "force" || group === "dimensions") && selection.notes.length !== 1) return;
      if (this.readOnly && group !== "locked") return;
      if (group !== "locked" && selection.notes.length > 1 && selection.notes.some(note => note.secret)) return;
    } else if (this.readOnly) return;

    const payload = selection.kind === "link"
      ? this.#linkPopover(group, selection.link)
      : this.#notePopover(group, selection);
    if (!payload) return;

    this.#closeFloatingPopover();
    const el = this.floatingPopover;
    const closeLabel = t("JN.Toolbar.Close");
    el.dataset.group = group;
    el.innerHTML = `
      <div class="jn-ft-pop-head">
        <b>${foundry.utils.escapeHTML(payload.title)}</b>
        <button type="button" class="jn-ft-close" aria-label="${foundry.utils.escapeHTML(closeLabel)}"
          title="${foundry.utils.escapeHTML(closeLabel)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
      <div class="jn-ft-pop-body">${payload.html}</div>
    `;
    el.hidden = false;
    this.floatingPopoverReturnFocus = button;
    this.floatingPopoverAnchor = button;
    button.setAttribute("aria-expanded", "true");
    this.#positionFloatingPopover(button, el);

    el.querySelector(".jn-ft-close").addEventListener("click", () => {
      this.#closeFloatingPopover({ restoreFocus: true });
    });
    payload.bind(el);
    this.#tagPopoverFocus(el);

    const target = el.querySelector(".jn-ft-pop-body select, .jn-ft-pop-body input, .jn-ft-pop-body button")
      ?? el.querySelector(".jn-ft-close");
    target?.focus?.({ preventScroll: true });

    const doc = this.root.ownerDocument;
    this.floatingPopoverDismiss = event => {
      if (this.floatingPopover.hidden) return;
      if (this.floatingPopover.contains(event.target)
          || event.target.closest?.(".jn-floating-toolbar")) return;
      this.#closeFloatingPopover();
    };
    this.floatingPopoverKeydown = event => {
      if (event.key !== "Escape" || this.floatingPopover.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      this.#closeFloatingPopover({ restoreFocus: true });
    };
    doc.addEventListener("pointerdown", this.floatingPopoverDismiss, true);
    doc.addEventListener("keydown", this.floatingPopoverKeydown, true);
  }

  #closeFloatingPopover({ restoreFocus = false } = {}) {
    const doc = this.root.ownerDocument;
    if (this.floatingPopoverDismiss) {
      doc.removeEventListener("pointerdown", this.floatingPopoverDismiss, true);
      this.floatingPopoverDismiss = null;
    }
    if (this.floatingPopoverKeydown) {
      doc.removeEventListener("keydown", this.floatingPopoverKeydown, true);
      this.floatingPopoverKeydown = null;
    }
    const returnFocus = this.floatingPopoverReturnFocus;
    returnFocus?.setAttribute("aria-expanded", "false");
    this.floatingPopoverReturnFocus = null;
    this.floatingPopoverAnchor = null;
    if (!this.floatingPopover.hidden || this.floatingPopover.childElementCount) {
      this.floatingPopover.hidden = true;
      this.floatingPopover.replaceChildren();
      this.floatingPopover.removeAttribute("style");
      delete this.floatingPopover.dataset.group;
    }
    if (restoreFocus && returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
  }

  /** Gives each popover control a stable key so a rebuild can restore focus to the same field. */
  #tagPopoverFocus(el) {
    const controls = el.querySelectorAll("button, select, input, textarea, a[href]");
    for (const [index, node] of [...controls].entries()) {
      const classes = typeof node.className === "string" ? node.className.trim().split(/\s+/).filter(Boolean) : [];
      const key = `pop-${index}-${classes.join("-") || node.tagName.toLowerCase()}`
        .replace(/[^A-Za-z0-9_-]+/g, "-");
      node.dataset.jnFocusKey = key;
    }
  }

  #positionFloatingPopover(button, el) {
    const rootRect = this.root.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const gap = 8;
    const margin = 6;
    // Re-measure from the CSS width every time: a previous narrow-canvas clamp must not stick
    // after the app window grows again. `box-sizing: border-box` makes this the real outer width.
    el.style.removeProperty("width");
    el.style.removeProperty("max-width");
    let popoverRect = el.getBoundingClientRect();
    const maxWidth = Math.max(0, rootRect.width - margin * 2);
    if (popoverRect.width > maxWidth) {
      el.style.width = `${maxWidth}px`;
      popoverRect = el.getBoundingClientRect();
    }
    // Prefer sitting to the left of the toolbar trigger; if that would overflow, place it to the
    // right of the trigger and, finally, clamp both left and right edges inside the canvas.
    const buttonLeft = buttonRect.left - rootRect.left;
    const buttonRight = buttonRect.right - rootRect.left;
    let left = buttonLeft - popoverRect.width - gap;
    if (left < margin) left = buttonRight + gap;
    const maxLeft = Math.max(margin, rootRect.width - popoverRect.width - margin);
    left = Math.max(margin, Math.min(left, maxLeft));
    const right = Math.max(margin, rootRect.width - left - popoverRect.width);
    const maxTop = Math.max(margin, rootRect.height - popoverRect.height - margin);
    const top = Math.max(margin, Math.min(buttonRect.top - rootRect.top, maxTop));
    // Pin the measured border-box width too: left and right then describe the same box even in
    // an RTL containing block, where an over-constrained absolute box prefers `right`.
    if (popoverRect.width > 0) el.style.width = `${popoverRect.width}px`;
    el.style.left = `${left}px`;
    el.style.right = `${right}px`;
    el.style.top = `${top}px`;
    el.style.maxWidth = `${maxWidth}px`;
  }

  #common(values) {
    const value = values[0];
    return { value, mixed: values.some(candidate => candidate !== value) };
  }

  #selectField({ className, label, options, value, mixed }) {
    const safeLabel = foundry.utils.escapeHTML(label);
    const mixedOption = mixed
      ? `<option value="" selected>${foundry.utils.escapeHTML(t("JN.Toolbar.Mixed"))}</option>` : "";
    const choices = options.map(([option, text]) =>
      `<option value="${foundry.utils.escapeHTML(option)}"${!mixed && option === value ? " selected" : ""}>`
      + `${foundry.utils.escapeHTML(text)}</option>`).join("");
    return `<label class="jn-ft-field"><span>${safeLabel}</span>
      <select class="jn-ft-input ${className}" aria-label="${safeLabel}">${mixedOption}${choices}</select>
    </label>`;
  }

  #notePopover(group, selection) {
    const { notes, ids } = selection;
    const presentations = notes.map(note => resolvePresentation(note));
    const attachments = notes.map(note => resolveAttachment(note));
    if (group === "locked") {
      return {
        title: t("JN.Toolbar.BulkDisabled"),
        html: `<p class="jn-ft-note">${foundry.utils.escapeHTML(t("JN.Toolbar.SecretBulkDisabled"))}</p>`,
        bind: () => {}
      };
    }
    if (group === "style") {
      const state = this.#common(presentations.map(presentation => presentation.extendedStyle));
      return {
        title: t("JN.Toolbar.Style"),
        html: this.#selectField({
          className: "jn-ft-style", label: t("JN.Toolbar.Style"), value: state.value, mixed: state.mixed,
          options: Object.entries(STYLE_LABEL_KEYS).map(([key, labelKey]) => [key, t(labelKey)])
        }),
        bind: el => {
          el.querySelector(".jn-ft-style").onchange = event => {
            const value = event.target.value;
            if (!value) return;
            this.callbacks.onSetPresentation?.(ids, { extendedStyle: value });
          };
        }
      };
    }
    if (group === "force") {
      const presentation = presentations[0];
      return {
        title: t("JN.Editor.ForceExtended"),
        html: `<label class="jn-ft-check"><input type="checkbox" class="jn-ft-force"
          ${presentation.forceExtended ? "checked" : ""}><span>${foundry.utils.escapeHTML(t("JN.Editor.ForceExtended"))}</span></label>`,
        bind: el => {
          el.querySelector(".jn-ft-force").onchange = event => {
            this.callbacks.onSetPresentation?.(ids, { forceExtended: event.target.checked });
          };
        }
      };
    }
    if (group === "font") {
      const state = this.#common(presentations.map(presentation => presentation.font));
      return {
        title: t("JN.Editor.Font"),
        html: this.#selectField({
          className: "jn-ft-font", label: t("JN.Editor.Font"), value: state.value, mixed: state.mixed,
          options: NOTE_FONT_KEYS.map(key => [key, t(FONT_LABEL_KEYS[key] ?? "JN.Font.Default")])
        }),
        bind: el => {
          el.querySelector(".jn-ft-font").onchange = event => {
            const value = event.target.value;
            if (!value) return;
            this.callbacks.onSetPresentation?.(ids, { font: value });
          };
        }
      };
    }
    if (group === "picture") {
      const state = this.#common(presentations.map(presentation => presentation.pictureLayout));
      return {
        title: t("JN.Editor.PictureLayout"),
        html: this.#selectField({
          className: "jn-ft-picture", label: t("JN.Editor.PictureLayout"),
          value: state.value, mixed: state.mixed,
          options: PICTURE_LAYOUTS.map(key => [key, t(PICTURE_LABEL_KEYS[key] ?? "JN.Picture.Above")])
        }),
        bind: el => {
          el.querySelector(".jn-ft-picture").onchange = event => {
            const value = event.target.value;
            if (!value) return;
            this.callbacks.onSetPresentation?.(ids, { pictureLayout: value });
          };
        }
      };
    }
    if (group === "torn") {
      const state = this.#common(presentations.map(presentation => presentation.torn));
      return {
        title: t("JN.Editor.Torn"),
        html: this.#selectField({
          className: "jn-ft-torn", label: t("JN.Editor.Torn"), mixed: state.mixed,
          value: state.value ? "on" : "off",
          options: [["on", t("JN.Toolbar.On")], ["off", t("JN.Toolbar.Off")]]
        }),
        bind: el => {
          el.querySelector(".jn-ft-torn").onchange = event => {
            const value = event.target.value;
            if (!value) return;
            this.callbacks.onSetPresentation?.(ids, { torn: value === "on" });
          };
        }
      };
    }
    if (group === "pin") {
      const state = this.#common(attachments.map(attachment => attachment.pinStyle));
      return {
        title: t("JN.Pin.Style"),
        html: this.#selectField({
          className: "jn-ft-pin", label: t("JN.Pin.Style"), value: state.value, mixed: state.mixed,
          options: PIN_STYLES.map(key => [key, t(PIN_STYLE_LABEL_KEYS[key] ?? "JN.Pin.Styles.Default")])
        }),
        bind: el => {
          el.querySelector(".jn-ft-pin").onchange = event => {
            const value = event.target.value;
            if (!value) return;
            this.callbacks.onSetAttachment?.(ids, { pinStyle: value });
          };
        }
      };
    }
    if (group === "dimensions") {
      const id = ids[0];
      const card = this.layout.cards?.[id] ?? {};
      const box = this.#cardBox(id);
      const width = Math.round(Number.isFinite(card.width) && card.width > 0 ? card.width : box.w);
      const height = Math.round(Number.isFinite(card.height) && card.height > 0 ? card.height : box.h);
      const label = text => foundry.utils.escapeHTML(text);
      return {
        title: t("JN.Toolbar.Dimensions"),
        html: `<div class="jn-ft-row">
          <label class="jn-ft-field"><span>${label(t("JN.Toolbar.Width"))}</span>
            <input type="number" class="jn-ft-width" min="130" step="1" value="${width}"
              aria-label="${label(t("JN.Toolbar.Width"))}"></label>
          <label class="jn-ft-field"><span>${label(t("JN.Toolbar.Height"))}</span>
            <input type="number" class="jn-ft-height" min="80" step="1" value="${height}"
              aria-label="${label(t("JN.Toolbar.Height"))}"></label>
        </div>
        <button type="button" class="jn-ft-auto">${label(t("JN.Toolbar.AutoSize"))}</button>`,
        bind: el => {
          const widthInput = el.querySelector(".jn-ft-width");
          const heightInput = el.querySelector(".jn-ft-height");
          const commit = () => {
            const nextWidth = Number(widthInput.value);
            const nextHeight = Number(heightInput.value);
            if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight)) return;
            this.callbacks.onResizeCard?.(
              id, Math.max(130, Math.round(nextWidth)), Math.max(80, Math.round(nextHeight))
            );
          };
          widthInput.onchange = commit;
          heightInput.onchange = commit;
          el.querySelector(".jn-ft-auto").onclick = () => {
            this.callbacks.onResetCardSize?.(id);
            this.#closeFloatingPopover({ restoreFocus: true });
          };
        }
      };
    }
    return null;
  }

  #linkPopover(group, link) {
    const update = fields => this.callbacks.onUpdateLink?.(link.sourceId, link.id, fields);
    const cosmetics = resolveLinkCosmetics(link);
    const esc = text => foundry.utils.escapeHTML(text);
    if (group === "material") {
      return {
        title: t("JN.Link.Material"),
        html: this.#selectField({
          className: "jn-ft-material", label: t("JN.Link.Material"), value: cosmetics.material, mixed: false,
          options: [["linen", t("JN.Link.MaterialOption.linen")], ["double", t("JN.Link.MaterialOption.double")]]
        }),
        bind: el => {
          el.querySelector(".jn-ft-material").onchange = event => update({ material: event.target.value });
        }
      };
    }
    if (group === "thickness") {
      const value = cosmetics.thickness.toFixed(1);
      return {
        title: t("JN.Link.Thickness"),
        html: `<label class="jn-ft-field"><span>${esc(t("JN.Link.Thickness"))}
          <output class="jn-ft-thickness-out">${value} px</output></span>
          <input type="range" class="jn-ft-thickness" min="0.8" max="5" step="0.1" value="${value}"
            aria-label="${esc(t("JN.Link.Thickness"))}"></label>`,
        bind: el => {
          const thickness = el.querySelector(".jn-ft-thickness");
          const out = el.querySelector(".jn-ft-thickness-out");
          thickness.oninput = () => { out.textContent = `${Number(thickness.value).toFixed(1)} px`; };
          thickness.onchange = () => update({ thickness: Number(thickness.value) });
        }
      };
    }
    if (group === "slack") {
      const value = String(Math.round(cosmetics.slack * 100));
      return {
        title: t("JN.Link.Slack"),
        html: `<label class="jn-ft-field"><span>${esc(t("JN.Link.Slack"))}
          <output class="jn-ft-slack-out">${value}%</output></span>
          <input type="range" class="jn-ft-slack" min="0" max="25" step="1" value="${value}"
            aria-label="${esc(t("JN.Link.Slack"))}"></label>`,
        bind: el => {
          const slack = el.querySelector(".jn-ft-slack");
          const out = el.querySelector(".jn-ft-slack-out");
          slack.oninput = () => { out.textContent = `${Math.round(Number(slack.value))}%`; };
          slack.onchange = () => update({ slack: Number(slack.value) / 100 });
        }
      };
    }
    if (group === "color") {
      const current = normalizeLinkColor(link.color);
      const swatches = LINK_COLOR_OPTIONS.map(slot => {
        const label = t(slot ? `JN.Link.Color.${slot}` : "JN.Link.Color.default");
        return `<button type="button" class="jn-ft-swatch jn-ft-swatch-${slot || "default"}${slot === current ? " on" : ""}"
          data-color="${esc(slot)}" title="${esc(label)}" aria-label="${esc(label)}"
          aria-pressed="${slot === current}"></button>`;
      }).join("");
      return {
        title: t("JN.Link.Color.default"),
        html: `<span class="jn-ft-colors" role="group" aria-label="${esc(t("JN.Link.Color.default"))}">${swatches}</span>`,
        bind: el => {
          el.querySelectorAll(".jn-ft-swatch").forEach(button => {
            button.onclick = () => update({ color: button.dataset.color });
          });
        }
      };
    }
    if (group === "pattern" || group === "ends") {
      const isPattern = group === "pattern";
      const values = isPattern
        ? ["continuous", "interrupted", "alternating"]
        : ["standard", "loose"];
      const labelKey = isPattern ? "JN.Link.PatternOption" : "JN.Link.EndOption";
      return {
        title: t(isPattern ? "JN.Link.Pattern" : "JN.Link.Ends"),
        html: this.#selectField({
          className: `jn-ft-${group}`, label: t(isPattern ? "JN.Link.Pattern" : "JN.Link.Ends"),
          value: isPattern ? cosmetics.pattern : cosmetics.ends, mixed: false,
          options: values.map(value => [value, t(`${labelKey}.${value}`)])
        }),
        bind: el => {
          el.querySelector(`.jn-ft-${group}`).onchange = event => {
            update(isPattern ? { pattern: event.target.value } : { ends: event.target.value });
          };
        }
      };
    }
    if (group === "label") {
      return {
        title: t("JN.Link.Label"),
        html: `<label class="jn-ft-field"><span>${esc(t("JN.Link.Label"))}</span>
          <input type="text" class="jn-ft-link-label" maxlength="200" value="${esc(link.label ?? "")}"
            placeholder="${esc(t("JN.Link.Label"))}" aria-label="${esc(t("JN.Link.Label"))}"></label>`,
        bind: el => {
          // Commit on change, matching the link toolbar: one socket write per committed label.
          el.querySelector(".jn-ft-link-label").onchange = event => update({ label: event.target.value });
        }
      };
    }
    if (group === "presets") {
      const label = id => t(`JN.Link.Preset.${id.charAt(0).toUpperCase()}${id.slice(1)}`);
      const presets = Object.entries(THREAD_PRESETS).map(([id, preset]) =>
        `<button type="button" class="jn-ft-preset" data-preset="${id}"
          title="${esc(label(id))} · ${preset.thickness.toFixed(1)} px · ${Math.round(preset.slack * 100)}%">${esc(label(id))}</button>`).join("");
      return {
        title: t("JN.Link.Presets"),
        html: `<div class="jn-ft-presets" role="group" aria-label="${esc(t("JN.Link.Presets"))}">${presets}</div>`,
        bind: el => {
          el.querySelectorAll(".jn-ft-preset").forEach(button => {
            button.onclick = () => {
              const preset = THREAD_PRESETS[button.dataset.preset];
              if (!preset) return;
              update({
                material: preset.material,
                thickness: preset.thickness,
                slack: preset.slack,
                pattern: "continuous",
                ends: "standard"
              });
            };
          });
        }
      };
    }
    return null;
  }

  /** Clear the free board waypoints when a split is blocked by them; route data is untouched. */
  #clearBoardPinsButton(link) {
    if (link.hidden || typeof this.callbacks.onClearThreadPins !== "function") return "";
    if (!Array.isArray(link.pins) || link.pins.length === 0) return "";
    return `<button type="button" class="jn-link-clear-pins" title="${t("JN.Route.ClearPins")}">${t("JN.Route.ClearPins")}</button>`;
  }

  /** Optional detach action for each note routed through this thread (Route A waypoint). */
  #routeDetachButtons(link) {
    // Hidden links live in a separate store with their own route policy; only expose the plain
    // shared detach operation here rather than guessing at vault authority. Local/private
    // canvases have no route callback and therefore offer no false affordance.
    if (link.hidden || typeof this.callbacks.onDetachRouteNote !== "function") return "";
    const routed = Array.isArray(link.routeAnchors) ? link.routeAnchors : [];
    return routed.map(entry => {
      const note = this.notes.find(item => item._id === entry?.noteId);
      const name = note?.system?.label?.trim?.() || note?.name || "";
      const suffix = name ? ` · ${foundry.utils.escapeHTML(name)}` : "";
      return `<button type="button" class="jn-link-detach" data-route-note-id="${foundry.utils.escapeHTML(String(entry?.noteId ?? ""))}"
        title="${t("JN.Route.Detach")}">${t("JN.Route.Detach")}${suffix}</button>`;
    }).join("");
  }

  /** GM-only toolbar buttons: hide a shared link, reveal a hidden one, mark a shared link as a hint. */
  #gmLinkButtons(link) {
    if (!this.gmMode) return "";
    if (link.hidden) {
      const secretEnd = this.notes.some(n => n.secret && (n._id === link.sourceId || n._id === link.targetId));
      return secretEnd ? `<span class="jn-link-gm-tag" title="${t("JN.Link.GMTitle")}">${t("JN.Link.GM")}</span>`
        : `<button type="button" class="jn-link-reveal" title="${t("JN.Link.RevealTitle")}">${t("JN.Link.Reveal")}</button>`;
    }
    return `<button type="button" class="jn-link-hint-toggle${link.hint ? " on" : ""}" title="${t("JN.Link.HintTitle")}">&#10022;</button>` +
      (link.origin === "typed" ? "" : `<button type="button" class="jn-link-hide" title="${t("JN.Link.HideTitle")}">${t("JN.Link.Hide")}</button>`);
  }

  #centerOnContent() {
    const positions = Object.values(this.layout.cards ?? {});
    if (!positions.length) return;
    const xs = positions.map(p => p.x), ys = positions.map(p => p.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const x1 = Math.max(...xs) + 220, y1 = Math.max(...ys) + 150;
    const rect = this.root.getBoundingClientRect();
    const k = Math.max(0.3, Math.min(1, rect.width / (x1 - x0 + 100), rect.height / (y1 - y0 + 100)));
    this.view.k = k || 1;
    this.view.x = (rect.width - (x1 - x0) * this.view.k) / 2 - x0 * this.view.k;
    this.view.y = (rect.height - (y1 - y0) * this.view.k) / 2 - y0 * this.view.k;
  }

  /**
   * Fits card bounds into the viewport (the "Fit all notes"/"Fit selection" toolbar action).
   *
   * Cards only: links, labels, stamps and thread pins deliberately do not widen the bounds, so a
   * long link cannot zoom the board out past the notes it connects. `ids` narrows the fit to a
   * selection; an empty/omitted value means every live card in `cardEls`. Rotated cards are
   * measured by their world-space AABB, with 60px of breathing room. Fit never magnifies past
   * 1.0 and shares the same 0.3 lower clamp as wheel zoom, so a single card stays readable.
   */
  fitNotes(ids = null) {
    const wanted = Array.isArray(ids) && ids.length ? ids : [...this.cardEls.keys()];
    const boxes = [];
    for (const id of wanted) {
      if (!this.cardEls.has(id)) continue;
      const box = this.#cardBox(id);
      const w = Number.isFinite(box.w) && box.w > 0 ? box.w : 190;
      const h = Number.isFinite(box.h) && box.h > 0 ? box.h : 70;
      const rotation = Number.isFinite(box.rotation) ? box.rotation : 0;
      const rad = rotation * Math.PI / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const rw = w * cos + h * sin;
      const rh = w * sin + h * cos;
      const cx = box.x + w / 2;
      const cy = box.y + h / 2;
      boxes.push({ x: cx - rw / 2, y: cy - rh / 2, w: rw, h: rh });
    }
    if (!boxes.length) return false;
    const rect = this.root.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return false;

    const padding = 60;
    const x0 = Math.min(...boxes.map(box => box.x)) - padding;
    const y0 = Math.min(...boxes.map(box => box.y)) - padding;
    const x1 = Math.max(...boxes.map(box => box.x + box.w)) + padding;
    const y1 = Math.max(...boxes.map(box => box.y + box.h)) + padding;
    const width = x1 - x0;
    const height = y1 - y0;
    const raw = Math.min(rect.width / width, rect.height / height);
    // The fit action is for locating cards, not for enlarging a lone note to fill the screen.
    this.view.k = Math.min(1, Math.max(0.3, raw));
    this.view.x = (rect.width - width * this.view.k) / 2 - x0 * this.view.k;
    this.view.y = (rect.height - height * this.view.k) / 2 - y0 * this.view.k;
    this.hasCentered = true;
    this.#applyTransform();
    this.#syncLinkToolbar();
    return true;
  }

  #applyTransform() {
    this.world.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.k})`;
    // Cork tile size is world-anchored: the base size is set once, CSS scales it by zoom, and
    // the tile origin follows pan. That keeps the texture locked to the board instead of
    // drifting or shimmering behind the cards.
    const cork = this.patternSize || 320;
    this.root.style.setProperty("--jn-board-cork-size", `${cork}px`);
    this.root.style.setProperty("--jn-board-zoom", String(this.view.k));
    this.root.style.setProperty("--jn-board-pattern-pos", `${this.view.x}px ${this.view.y}px`);
    this.root.classList.toggle("jn-far-zoom", this.view.k < 0.48);
    this.#queueZoomComp();
  }

  /**
   * Pins and labels live inside the CSS-scaled world while thread strokes are
   * non-scaling. Dividing by the zoom keeps their on-screen size steady for k in [0.5, 2]
   * and eases off outside that range so extreme zooms still feel like zooming.
   */
  #syncZoomComp() {
    const k = this.view.k || 1;
    const comp = Math.min(2, Math.max(0.5, 1 / k));
    this.root.style.setProperty("--jn-zoom-comp", String(Math.round(comp * 1000) / 1000));
  }

  #queueZoomComp() {
    if (this.zoomFrame !== null) return;
    const win = this.root.ownerDocument.defaultView;
    if (!win?.requestAnimationFrame) { this.#syncZoomComp(); return; }
    this.zoomFrame = win.requestAnimationFrame(() => {
      this.zoomFrame = null;
      this.#syncZoomComp();
    });
  }

  /**
   * Board knobs the canvas itself owns: the pattern pans and zooms with the world, so its
   * size/position cannot live purely in CSS. Everything else is on the app root.
   */
  setTheme(theme) {
    // Cork size belongs to the material token, not the retired legacy board-pattern size.
    const materialSize = Number(theme?.materials?.board?.size);
    const boardSize = Number(theme?.board?.patternSize);
    this.patternSize = Number.isFinite(materialSize) && materialSize > 0
      ? materialSize
      : (Number.isFinite(boardSize) && boardSize > 0 ? boardSize : 320);
    // The visual canvas has no legacy dot/grid option. Keep the dataset limited to the two
    // supported values: "stylized" for the cork material or "none" when a theme explicitly
    // disables board patterning.
    this.root.dataset.boardPattern = theme?.board?.pattern === "none" ? "none" : "stylized";
    this.#applyTransform();
  }

  #zoomAt(clientX, clientY, k) {
    k = Math.min(2.2, Math.max(0.3, k));
    const rect = this.root.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    this.view.x = px - (px - this.view.x) * k / this.view.k;
    this.view.y = py - (py - this.view.y) * k / this.view.k;
    this.view.k = k;
    this.#applyTransform();
    this.#syncLinkToolbar();
  }

  #toWorld(clientX, clientY) {
    const rect = this.root.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.x) / this.view.k,
      y: (clientY - rect.top - this.view.y) / this.view.k
    };
  }

  #startLinkPreview() {
    this.previewPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    this.previewPath.setAttribute("class", "jn-link-preview");
    this.svg.appendChild(this.previewPath);
  }

  #endLinkPreview() {
    this.previewPath?.remove();
    this.previewPath = null;
    this.previewPin?.remove();
    this.previewPin = null;
  }

  #setSelection(ids, primary = null, labelIds = []) {
    this.#highlightLabels(labelIds);
    this.selectedNoteIds = new Set(ids);
    this.selectedNoteId = primary;
    this.selectedLinkId = null;
    this.#syncLinkSelection();
    for (const [id, el] of this.cardEls) el.classList.toggle("selected", this.selectedNoteIds.has(id));
    this.#syncLinkToolbar();
    this.#syncFloatingToolbar();
    this.callbacks.onSelectNote(primary);
  }

  #highlightLabels(ids) {
    this.selectedLabelIds = new Set(ids);
    for (const label of this.root.querySelectorAll(".jn-label, .jn-card-stamps .jn-stamp")) {
      label.classList.toggle("jn-label-selected", this.selectedLabelIds.has(label.dataset.stampLabelId ?? label.dataset.id));
    }
  }

  #selectLabel(id) {
    this.#setSelection([], null, [id]);
  }

  #showSelectionBox(sx, sy, x, y) {
    const rect = this.root.getBoundingClientRect();
    const left = Math.min(sx, x) - rect.left;
    const top = Math.min(sy, y) - rect.top;
    this.selectionBox.style.left = `${left}px`;
    this.selectionBox.style.top = `${top}px`;
    this.selectionBox.style.width = `${Math.abs(x - sx)}px`;
    this.selectionBox.style.height = `${Math.abs(y - sy)}px`;
    this.selectionBox.style.display = "block";
  }

  #finishSelection(drag, clientX, clientY) {
    this.selectionBox.style.display = "none";
    if (drag.moved <= DRAG_THRESHOLD) {
      this.#setSelection([], null);
      return;
    }
    const left = Math.min(drag.sx, clientX);
    const right = Math.max(drag.sx, clientX);
    const top = Math.min(drag.sy, clientY);
    const bottom = Math.max(drag.sy, clientY);
    const intersects = el => {
      const box = el.getBoundingClientRect();
      return box.right >= left && box.left <= right && box.bottom >= top && box.top <= bottom;
    };
    const notes = new Set(drag.additive ? drag.initialIds : []);
    const labels = new Set(drag.additive ? drag.initialLabelIds : []);
    for (const [id, el] of this.cardEls) {
      if (intersects(el)) notes.add(id);
    }
    for (const [id, el] of this.labelEls) {
      if (intersects(el)) labels.add(id);
    }
    const ids = [...notes];
    this.#setSelection(ids, ids.length === 1 && !labels.size ? ids[0] : null, labels);
  }

  #closeContextMenu() {
    this.contextMenu.style.display = "none";
    this.contextMenu.innerHTML = "";
  }

  toggleLinkTool() {
    if (this.readOnly) return this.#warnReadOnly();
    if (this.linkPlacement) return this.cancelLinkTool();
    this.#closeContextMenu();
    this.linkPlacement = { source: null, pins: [] };
    this.root.dataset.placingLink = "true";
    this.linkPlacementHint.hidden = false;
    this.linkPlacementHint.textContent = t("JN.Link.PickStart");
    this.edgePin = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    this.edgePin.setAttribute("class", "jn-thread-pin jn-edge-preview");
    this.edgePin.style.display = "none";
    this.svg.appendChild(this.edgePin);
    this.draftPins = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.svg.appendChild(this.draftPins);
    this.pinTarget = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    this.pinTarget.setAttribute("class", "jn-pin-target");
    this.pinTarget.style.display = "none";
    this.svg.appendChild(this.pinTarget);
    this.root.focus({ preventScroll: true });
  }

  cancelLinkTool() {
    if (!this.linkPlacement) return;
    this.linkPlacement = null;
    this.linkPlacementHint.hidden = true;
    delete this.root.dataset.placingLink;
    this.edgePin.remove();
    this.edgePin = null;
    this.draftPins.remove();
    this.draftPins = null;
    this.pinTarget?.remove();
    this.pinTarget = null;
    this.#highlightSnappedPin(null, null);
    this.#endLinkPreview();
  }

  #linkCardAt(ev) {
    return ev.target.closest?.(".jn-card") ?? document.elementsFromPoint?.(ev.clientX, ev.clientY)
      .map(element => element.closest(".jn-card")).find(element => element && this.world.contains(element)) ?? null;
  }

  #linkEdgeAt(card, world) {
    if (!card) return null;
    const id = card.dataset.id;
    const box = this.#cardBox(id);
    const { point, distance } = cardEdgeAt(box, world);
    if (distance * this.view.k <= 16) return { id, box, point };
    return null;
  }

  /** A rendered main/minor pin within its per-note screen-space magnet radius. */
  #linkAnchorAt(card, world) {
    if (!card || !this.#pinsOn()) return null;
    const id = card.dataset.id;
    const note = this.notes.find(item => item._id === id);
    if (!note) return null;
    const attachment = resolveAttachment(note);
    const anchors = {};
    for (const [anchorId, anchor] of Object.entries(this.layout.cards?.[id]?.anchors ?? {})) {
      if (!validAnchorId(anchorId)) continue;
      if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) continue;
      // A disabled main pin is not rendered, so it must not secretly magnetize the cursor.
      if (isMainAnchor(anchor) && !attachment.mainPinEnabled) continue;
      anchors[anchorId] = anchor;
    }
    if (!Object.keys(anchors).length) return null;
    const box = this.#cardBox(id);
    const hit = nearestAnchor(box, anchors, world, {
      zoom: this.view.k,
      mainRadius: attachment.mainSnapRadius,
      minorRadius: attachment.minorSnapRadius
    });
    if (!hit) return null;
    return {
      id, box, anchorId: hit.id, anchor: hit.anchor,
      point: { x: hit.anchor.x, y: hit.anchor.y }
    };
  }

  /** A fresh minor anchor for a click on the card interior, away from an edge or a pin. */
  #linkInteriorAt(card, world) {
    if (!card || !this.#pinsOn()) return null;
    const id = card.dataset.id;
    const box = this.#cardBox(id);
    const { distance } = cardEdgeAt(box, world);
    if (distance * this.view.k <= 16) return null;
    const point = cardNormalizedPoint(box, world);
    if (!point) return null;
    return { id, box, point, anchor: { kind: "minor", x: point.x, y: point.y } };
  }

  #pickLinkPoint(ev) {
    const world = this.#toWorld(ev.clientX, ev.clientY);
    const card = this.#linkCardAt(ev);
    const anchorHit = this.#linkAnchorAt(card, world);
    const edge = anchorHit ? null : this.#linkEdgeAt(card, world);
    const interior = anchorHit || edge ? null : this.#linkInteriorAt(card, world);
    const target = anchorHit ?? edge ?? interior;
    const { source, pins } = this.linkPlacement;
    if (!target) {
      if (!source || pins.length >= MAX_THREAD_PINS || !validThreadPin(world)) return;
      pins.push(world);
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      marker.setAttribute("class", "jn-thread-pin jn-board-pin");
      marker.setAttribute("cx", world.x);
      marker.setAttribute("cy", world.y);
      this.draftPins.appendChild(marker);
      this.#updateFreeLinkPreview(world);
      return;
    }
    const { id, point } = target;
    if (source && source.id !== id) {
      const sourceNote = this.notes.find(item => item._id === source.id);
      const targetNote = this.notes.find(item => item._id === id);
      const secret = !!sourceNote?.secret || !!targetNote?.secret;
      // Secret/hidden links keep plain points: their anchor registries live in different
      // stores, so sharing anchor ids would let either side prune/redistribute the other.
      const anchors = { sourcePoint: source.point, targetPoint: point, pins: [...pins] };
      if (!secret) {
        anchors.sourceAnchorId = source.anchorId ?? "";
        anchors.targetAnchorId = target.anchorId ?? "";
        if (!source.anchorId && source.anchor) anchors.sourceAnchor = source.anchor;
        if (!target.anchorId && target.anchor) anchors.targetAnchor = target.anchor;
      }
      this.cancelLinkTool();
      this.callbacks.onCreateLink?.(source.id, id, anchors);
      return;
    }
    this.linkPlacement.source = target;
    this.linkPlacementHint.textContent = t("JN.Link.PickEnd");
    this.#endLinkPreview();
    this.#startLinkPreview();
    this.previewPin = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    this.previewPin.setAttribute("class", "jn-thread-pin");
    this.svg.appendChild(this.previewPin);
    this.#updateFreeLinkPreview(this.#sourceAttachment() ?? { ...world, nx: 0, ny: 0 });
  }

  #sourceAttachment() {
    const source = this.linkPlacement?.source;
    if (!source) return null;
    const box = this.#cardBox(source.id);
    if (source.anchorId) return this.#anchorAttachment(source.id, box, source.anchorId);
    if (source.anchor) return this.#anchorWorldAttachment(box, source.anchor);
    return threadAttachment(box, source.point);
  }

  #updateFreeLinkPreview(cursor) {
    const start = this.#sourceAttachment();
    if (!start || !this.previewPin || !this.previewPath) return;
    this.previewPin.setAttribute("cx", start.x - start.nx * THREAD_PIN_RADIUS);
    this.previewPin.setAttribute("cy", start.y - start.ny * THREAD_PIN_RADIUS);
    this.previewPath.setAttribute("d", pinnedThreadPath(start, cursor, this.linkPlacement.pins).path);
  }

  #pinElement(noteId, anchorId) {
    for (const pin of this.cardEls.get(noteId)?.querySelectorAll(".jn-pin") ?? []) {
      if (pin.dataset.anchorId === anchorId) return pin;
    }
    return null;
  }

  #highlightSnappedPin(cardId, anchorId) {
    if (this.snappedPinEl && (this.snappedPinEl.dataset.noteId !== cardId
        || this.snappedPinEl.dataset.anchorId !== anchorId)) {
      this.snappedPinEl.classList.remove("jn-pin-snap");
      this.snappedPinEl = null;
    }
    if (!cardId || !anchorId) return;
    const pin = this.#pinElement(cardId, anchorId);
    if (!pin || pin === this.snappedPinEl) return;
    this.snappedPinEl?.classList.remove("jn-pin-snap");
    pin.classList.add("jn-pin-snap");
    this.snappedPinEl = pin;
  }

  /** Live link-tool magnet preview: an existing pin or the proposed new minor point. */
  #updateLinkTargetPreview(ev, world) {
    if (!this.linkPlacement || !this.pinTarget) return;
    const card = this.#linkCardAt(ev);
    const anchorHit = this.#linkAnchorAt(card, world);
    const interior = anchorHit ? null : this.#linkInteriorAt(card, world);
    if (!anchorHit && !interior) {
      this.pinTarget.style.display = "none";
      this.#highlightSnappedPin(null, null);
      return;
    }
    const hit = anchorHit ?? interior;
    const worldPoint = anchorHit
      ? anchorWorld(anchorHit.box, anchorHit.anchor)
      : cardPointAnchor(hit.box, hit.point);
    if (!worldPoint) {
      this.pinTarget.style.display = "none";
      this.#highlightSnappedPin(null, null);
      return;
    }
    const main = !!anchorHit && isMainAnchor(anchorHit.anchor);
    this.pinTarget.style.display = "";
    this.pinTarget.classList.toggle("jn-pin-target-main", main);
    this.pinTarget.classList.toggle("jn-pin-target-minor", !!anchorHit && !main);
    this.pinTarget.classList.toggle("jn-pin-target-new", !anchorHit);
    this.pinTarget.setAttribute("cx", worldPoint.x);
    this.pinTarget.setAttribute("cy", worldPoint.y);
    this.pinTarget.setAttribute("r", String((main ? 12 : anchorHit ? 7 : 6) / this.view.k));
    if (anchorHit) this.pinTarget.dataset.anchorId = anchorHit.anchorId;
    else delete this.pinTarget.dataset.anchorId;
    this.#highlightSnappedPin(anchorHit ? hit.id : null, anchorHit?.anchorId ?? null);
  }

  #stampColor(color) {
    return Object.values(STAMP_COLORS).includes(color) ? color : STAMP_COLORS.red;
  }

  #openContextMenu(clientX, clientY, { noteId, labelId, editStamp = false } = {}) {
    if (this.readOnly) return this.#warnReadOnly();
    const point = this.#toWorld(clientX, clientY);
    if (editStamp) labelId ??= this.cardEls.get(noteId)?.querySelector(".jn-card-stamps .jn-stamp")?.dataset.stampLabelId;
    const label = this.layout.labels?.[labelId];
    let corner = isStampCorner(label?.corner) ? label.corner : DEFAULT_STAMP_CORNER;
    let color = this.#stampColor(label?.color);
    const stampColors = () => `<div class="jn-stamp-colors" role="group" aria-label="${t("JN.Stamp.Colors")}">
      ${Object.entries(STAMP_COLORS).map(([name, value]) => `<button type="button" data-stamp-color="${value}"
        aria-pressed="${value === color}" title="${t(`JN.Stamp.Color.${name}`)}" aria-label="${t(`JN.Stamp.Color.${name}`)}"
        style="--jn-swatch:${value}"></button>`).join("")}</div>`;
    const gmItems = this.gmMode ? `
      <button type="button" data-action="secret-note">${t("JN.Context.NewSecretNote")}</button>
      <button type="button" data-action="gm-label">${t("JN.Context.NewGMLabel")}</button>` : "";
    if (editStamp && noteId) {
      this.contextMenu.innerHTML = `
        ${stampColors()}
        <div class="jn-stamp-corners" role="group" aria-label="${t("JN.Stamp.CornerPicker")}">
          <span>${t("JN.Stamp.CornerPicker")}</span>
          ${STAMP_CORNERS.map((value, index) => `<button type="button" data-stamp-corner="${value}"
            aria-pressed="${value === corner}" title="${t(`JN.Stamp.Corner.${value}`)}"
            aria-label="${t(`JN.Stamp.Corner.${value}`)}">${["↖", "↗", "↙", "↘"][index]}</button>`).join("")}
        </div>
        <div class="jn-stamp-picker" role="group" aria-label="${t("JN.Stamp.Add")}">
          ${STAMP_IDS.map(stamp => `<button type="button" data-stamp="${stamp}" title="${t(`JN.Stamp.${stamp}`)}"
            aria-pressed="${stamp === label?.stamp}"><img src="${stampUrl(stamp)}" alt="${t(`JN.Stamp.${stamp}`)}" draggable="false"></button>`).join("")}
        </div>
        ${labelId ? `<button type="button" data-action="remove-label">${t("JN.Stamp.Remove")}</button>` : ""}`;
    } else if (labelId) {
      const isStamp = !!stampUrl(label?.stamp);
      this.contextMenu.innerHTML = `
        ${isStamp ? stampColors() : `<button type="button" data-action="edit-label">${t("JN.Prompt.EditLabel")}</button>`}
        <button type="button" data-action="remove-label">${t(isStamp ? "JN.Stamp.Remove" : "JN.Common.Delete")}</button>`;
    } else if (noteId) {
      const note = this.notes.find(item => item._id === noteId);
      const actorLinked = !!note?.system?.actorRef?.actorId;
      const actorItems = this.callbacks.onLinkActor && game.user?.isGM && !note?.secret ? `
        <button type="button" data-action="link-actor">${t(actorLinked ? "JN.Actor.Change" : "JN.Actor.Link")}</button>
        ${actorLinked ? `<button type="button" data-action="unlink-actor">${t("JN.Actor.Unlink")}</button>` : ""}` : "";
      this.contextMenu.innerHTML = `
        <button type="button" data-action="card-stamp">${t("JN.Stamp.Add")}</button>
        <button type="button" data-action="card-background">${t("JN.Editor.ChangeBackground")}</button>
        ${this.#pinsOn() && !note?.secret ? `<button type="button" data-action="add-minor-pin">${t("JN.Pin.AddMinor")}</button>` : ""}
        ${actorItems}`;
    } else this.contextMenu.innerHTML = `
      <button type="button" data-action="note">${t("JN.Context.NewNote")}</button>
      <button type="button" data-action="memo">${t("JN.Style.Memo")}</button>
      <button type="button" data-action="document">${t("JN.Style.Document")}</button>
      <button type="button" data-action="target">${t("JN.Style.Wanted")}</button>
      <button type="button" data-action="location">${t("JN.Context.NewLocation")}</button>
      <button type="button" data-action="label">${t("JN.Context.NewLabel")}</button>
      ${gmItems}
    `;
    const rootRect = this.root.getBoundingClientRect();
    this.contextMenu.style.left = `${clientX - rootRect.left}px`;
    this.contextMenu.style.top = `${clientY - rootRect.top}px`;
    this.contextMenu.style.display = "flex";
    const menuRect = this.contextMenu.getBoundingClientRect();
    const left = Math.min(clientX - rootRect.left, rootRect.width - menuRect.width - 6);
    const top = Math.min(clientY - rootRect.top, rootRect.height - menuRect.height - 6);
    this.contextMenu.style.left = `${Math.max(6, left)}px`;
    this.contextMenu.style.top = `${Math.max(6, top)}px`;

    this.contextMenu.querySelectorAll("button").forEach(button => {
      button.addEventListener("click", ev => {
        ev.stopPropagation();
        const action = button.dataset.action;
        if (action === "card-background") {
          this.#closeContextMenu();
          this.callbacks.onEditCardBackground?.(noteId);
          return;
        }
        if (action === "add-minor-pin") {
          if (!noteId) return;
          const anchor = cardNormalizedPoint(this.#cardBox(noteId), point);
          this.#closeContextMenu();
          if (anchor) this.callbacks.onAddCardAnchor?.(noteId, { kind: "minor", x: anchor.x, y: anchor.y });
          return;
        }
        if (action === "delete-private") {
          this.#closeContextMenu();
          this.callbacks.onDeleteNote?.(noteId);
          return;
        }
        if (action === "link-actor") {
          this.#closeContextMenu();
          this.callbacks.onLinkActor?.(noteId);
          return;
        }
        if (action === "unlink-actor") {
          this.#closeContextMenu();
          this.callbacks.onUnlinkActor?.(noteId);
          return;
        }
        if (button.dataset.stampColor) {
          color = button.dataset.stampColor;
          if (labelId) this.callbacks.onStampColor?.(labelId, color);
          this.contextMenu.querySelectorAll("[data-stamp-color]").forEach(choice => {
            choice.setAttribute("aria-pressed", String(choice === button));
          });
          return;
        }
        if (action === "card-stamp") {
          this.#openContextMenu(clientX, clientY, { noteId, editStamp: true });
          return;
        }
        if (button.dataset.stampCorner) {
          corner = button.dataset.stampCorner;
          if (labelId) this.callbacks.onStampCorner?.(labelId, corner);
          this.contextMenu.querySelectorAll("[data-stamp-corner]").forEach(choice => {
            choice.setAttribute("aria-pressed", String(choice === button));
          });
          return;
        }
        if (button.dataset.stamp) this.callbacks.onAttachStamp?.(noteId, button.dataset.stamp, color, corner);
        else if (action === "remove-label") this.callbacks.onRemoveLabel?.(labelId);
        else if (action === "edit-label") this.callbacks.onEditLabel(labelId);
        else if (action === "note") this.callbacks.onCreateNoteAt(point.x - CREATE_WIDTHS.note / 2, point.y - 30, {
          kind: "note", presentation: { extendedStyle: "memo", forceExtended: false }
        });
        else if (action === "memo") this.callbacks.onCreateNoteAt(point.x - CREATE_WIDTHS.memo / 2, point.y - 40, {
          kind: "note", presentation: { extendedStyle: "memo", forceExtended: true }
        });
        else if (action === "document") this.callbacks.onCreateNoteAt(point.x - CREATE_WIDTHS.document / 2, point.y - 40, {
          kind: "note", presentation: { extendedStyle: "document", forceExtended: true }
        });
        else if (action === "target") this.callbacks.onCreateNoteAt(point.x - CREATE_WIDTHS.target / 2, point.y - 40, {
          kind: "note", presentation: { extendedStyle: "target", forceExtended: true }
        });
        else if (action === "location") this.callbacks.onCreateNoteAt(point.x - CREATE_WIDTHS.location / 2, point.y - 45, { kind: "location" });
        else if (action === "label") this.callbacks.onAddLabelAt(point.x, point.y);
        else if (action === "secret-note") this.callbacks.onCreateNoteAt(point.x - CREATE_WIDTHS.note / 2, point.y - 30, { kind: "note", secret: true });
        else if (action === "gm-label") this.callbacks.onAddGmLabelAt?.(point.x, point.y);
        this.#closeContextMenu();
      });
    });
  }

  #bindPointerEvents() {
    let drag = null;
    let lastLabelClick = null;
    let lastCardClick = null;
    let lastBoardClick = null;

    // Hover/editing fade is pure class toggling on the existing mask shapes. No path or DOM
    // rebuild happens here, so a busy board stays responsive.
    this.root.addEventListener("pointerover", ev => {
      const card = ev.target.closest?.(".jn-card");
      if (!card || !this.world.contains(card)) return;
      const id = card.dataset.id;
      if (id === this.hoverNoteId) return;
      this.hoverNoteId = id;
      this.#syncMaskState();
    });
    this.root.addEventListener("pointerout", ev => {
      const card = ev.target.closest?.(".jn-card");
      if (!card) return;
      if (ev.relatedTarget && card.contains(ev.relatedTarget)) return;
      if (this.hoverNoteId !== card.dataset.id) return;
      this.hoverNoteId = null;
      this.#syncMaskState();
    });
    this.root.addEventListener("focusin", ev => {
      if (!ev.target.matches?.("input, textarea")) return;
      const card = ev.target.closest?.(".jn-card");
      if (!card) return;
      this.focusedNoteId = card.dataset.id;
      this.#syncMaskState();
    });
    this.root.addEventListener("focusout", ev => {
      if (!ev.target.matches?.("input, textarea")) return;
      const card = ev.target.closest?.(".jn-card");
      if (!card) return;
      if (ev.relatedTarget && card.contains(ev.relatedTarget)) return;
      if (this.focusedNoteId === card.dataset.id) this.focusedNoteId = null;
      this.#syncMaskState();
    });

    this.root.addEventListener("click", ev => {
      const camera = ev.target.closest(".jn-card-image-button");
      if (camera && !camera.hidden) {
        ev.stopPropagation();
        this.callbacks.onEditCardImage?.(camera.closest(".jn-card").dataset.id);
        return;
      }
      if (ev.button !== 0 || ev.target.closest(`.jn-context-menu, .jn-link-toolbar, .jn-floating-toolbar, .jn-floating-popover, .jn-route-chooser, ${PATCH_NOTES_SELECTOR}, input, textarea`)) return;
      if (ev.altKey && !this.linkPlacement) this.toggleLinkTool();
      if (!this.linkPlacement) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.#pickLinkPoint(ev);
    }, { capture: true });

    this.root.addEventListener("click", ev => {
      const box = ev.target.closest(".jn-card-block input[type=\"checkbox\"]");
      if (!box || this.readOnly) return;
      ev.preventDefault();
      ev.stopPropagation();
      const row = box.closest(".jn-card-block");
      const noteId = box.closest(".jn-card")?.dataset.id;
      const index = [...row.querySelectorAll('input[type="checkbox"]')].indexOf(box);
      if (noteId && index >= 0) this.callbacks.onToggleTask?.(noteId, row.dataset.blockId, index);
    });

    this.root.addEventListener("keydown", ev => {
      if (ev.target.closest(PATCH_NOTES_SELECTOR)) return;
      if (ev.key === "Escape" && this.routeChooser) {
        ev.preventDefault();
        ev.stopPropagation();
        this.#closeRouteChooser({ restoreFocus: true });
        return;
      }
      if (ev.key === "Escape" && this.selectedLinkId) {
        ev.preventDefault();
        ev.stopPropagation();
        this.#closeLinkToolbar({ restoreFocus: true });
        return;
      }
      if (ev.key === "Escape" && this.linkPlacement) {
        ev.preventDefault();
        ev.stopPropagation();
        this.cancelLinkTool();
        this.root.focus({ preventScroll: true });
        return;
      }
      if (ev.isComposing || !["Enter", " "].includes(ev.key)) return;
      if (!ev.target.matches("[data-card-text]")) return;
      ev.preventDefault();
      this.#editCardText(ev.target.closest(".jn-card").dataset.id, ev.target);
    });

    this.root.addEventListener("wheel", ev => {
      if (ev.target.closest(PATCH_NOTES_SELECTOR)) return;
      if (ev.target.closest(".jn-route-chooser")) return;
      if (ev.target.closest(".jn-floating-toolbar, .jn-floating-popover")) return;
      if (ev.target.closest(".jn-card input, .jn-card textarea") && !ev.ctrlKey) return;
      ev.preventDefault();
      this.#closeContextMenu();
      this.#zoomAt(ev.clientX, ev.clientY, this.view.k * Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });

    this.root.addEventListener("pointerdown", ev => {
      if (ev.target.closest(PATCH_NOTES_SELECTOR)) return;
      if (ev.target.closest(".jn-route-chooser")) return;
      if (ev.target.closest(".jn-floating-toolbar, .jn-floating-popover")) return;
      if (ev.target.closest(".jn-card-image-button")) return;
      if (!this.linkPlacement && !ev.altKey
          && ev.target.closest(".jn-card-block a[href], .jn-card-block input[type=\"checkbox\"]")) return;
      if ((this.linkPlacement || ev.altKey) && ev.button === 0 && !ev.target.closest(".jn-context-menu, .jn-link-toolbar, input, textarea")) {
        ev.preventDefault();
        lastBoardClick = null;
        return;
      }
      if (ev.target.closest(".jn-card input, .jn-card textarea")) return;
      if (ev.target.closest(".jn-link-toolbar")) return;
      if (ev.target.closest(".jn-context-menu")) return;
      if (ev.button === 0) ev.preventDefault();
      this.root.focus({ preventScroll: true });
      this.#closeContextMenu();
      this.#clearRouteDrop();
      if (ev.button === 2) {
        this.cancelLinkTool();
        lastBoardClick = null;
        return;
      }
      try { this.root.setPointerCapture(ev.pointerId); } catch { /* no active pointer (e.g. synthetic event) */ }
      const cardEl = ev.target.closest(".jn-card");
      const resizeHandle = this.readOnly ? null : ev.target.closest(".jn-card-resize");
      const labelEl = ev.target.closest(".jn-label");
      const stampId = this.readOnly ? null : ev.target.closest("[data-stamp-label-id]")?.dataset.stampLabelId;
      const linkHit = ev.target.closest(".jn-link-hit");
      const pin = this.readOnly ? null : ev.target.closest("[data-pin-index]");
      const notePin = ev.target.closest(".jn-pin-minor");
      if (ev.button !== 0 || cardEl || labelEl || linkHit) lastBoardClick = null;

      // Middle mouse always pans, even when the pointer starts over a card, handle, or link.
      if (ev.button === 1) {
        ev.preventDefault();
        drag = { type: "pan", sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y, moved: 0 };
      } else if (ev.button !== 0) {
        return;
      } else if (pin) {
        const id = pin.closest("[data-id]").dataset.id;
        const index = Number(pin.dataset.pinIndex);
        const point = this.threads.get(id)?.pins[index];
        if (!point) return;
        drag = { type: "pin", id, index, ox: point.x, oy: point.y,
          sx: ev.clientX, sy: ev.clientY, moved: 0 };
        this.pinDrag = { id, index, ...point };
        lastBoardClick = null;
      } else if (stampId && cardEl) {
        drag = { type: "attached-stamp", id: stampId, sx: ev.clientX, sy: ev.clientY, moved: 0 };
      } else if (resizeHandle) {
        const id = resizeHandle.closest(".jn-card").dataset.id;
        const el = this.cardEls.get(id);
        drag = { type: "resize", id, sx: ev.clientX, sy: ev.clientY, ow: el.offsetWidth, oh: el.offsetHeight, moved: 0 };
      } else if (notePin) {
        // Minor pins move themselves; they never start a card drag. A main pin deliberately
        // falls through to the card branch, so dragging it moves the whole note.
        const card = notePin.closest(".jn-card");
        drag = {
          type: "note-pin", id: card.dataset.id, anchorId: notePin.dataset.anchorId,
          sx: ev.clientX, sy: ev.clientY, moved: 0, readOnly: this.readOnly
        };
      } else if (cardEl) {
        const initialLabelIds = [...this.selectedLabelIds];
        this.#highlightLabels([]);
        const id = cardEl.dataset.id;
        const initialIds = [...this.selectedNoteIds];
        const selected = this.selectedNoteIds.has(id) ? [...this.selectedNoteIds] : [id];
        const origins = new Map(selected.map(noteId => {
          const box = this.#cardBox(noteId);
          return [noteId, { x: box.x, y: box.y }];
        }));
        if (!this.selectedNoteIds.has(id)) {
          this.selectedNoteIds = new Set([id]);
          for (const [noteId, el] of this.cardEls) el.classList.toggle("selected", noteId === id);
        }
        drag = {
          type: "card", id, ids: selected, origins,
          toggle: ev.ctrlKey || ev.metaKey, initialIds, initialLabelIds,
          text: ev.target.closest("[data-card-text]"),
          sx: ev.clientX, sy: ev.clientY, moved: 0, readOnly: this.readOnly
        };
      } else if (labelEl) {
        const id = labelEl.dataset.id;
        const data = this.layout.labels?.[id] ?? { x: 0, y: 0 };
        drag = { type: "label", id, sx: ev.clientX, sy: ev.clientY, ox: data.x, oy: data.y, moved: 0,
          toggle: ev.ctrlKey || ev.metaKey, readOnly: this.readOnly };
      } else if (linkHit) {
        const id = linkHit.dataset.id;
        const motion = this.threads.get(id)?.motion;
        drag = { type: "link", id, sx: ev.clientX, sy: ev.clientY, moved: 0, x: motion?.x ?? 0, y: motion?.y ?? 0,
          readOnly: this.readOnly };
      } else {
        drag = {
          type: "selection", sx: ev.clientX, sy: ev.clientY, moved: 0,
          additive: ev.ctrlKey || ev.metaKey, initialIds: [...this.selectedNoteIds],
          initialLabelIds: [...this.selectedLabelIds]
        };
      }
    });

    this.root.addEventListener("pointermove", ev => {
      if (this.linkPlacement) {
        const world = this.#toWorld(ev.clientX, ev.clientY);
        const card = this.#linkCardAt(ev);
        const edge = this.#linkEdgeAt(card, world);
        this.edgePin.style.display = edge ? "" : "none";
        if (edge) {
          const { x, y } = cardPointAnchor(edge.box, edge.point);
          this.edgePin.setAttribute("cx", x);
          this.edgePin.setAttribute("cy", y);
        }
        if (this.linkPlacement.source) {
          const anchorHit = this.#linkAnchorAt(card, world);
          const interior = anchorHit ? null : this.#linkInteriorAt(card, world);
          let end = { ...world, nx: 0, ny: 0 };
          if (anchorHit) end = this.#anchorWorldAttachment(anchorHit.box, anchorHit.anchor) ?? end;
          else if (interior) {
            const point = cardPointAnchor(interior.box, interior.point);
            end = { ...point, nx: 0, ny: 0 };
          } else if (edge) end = threadAttachment(edge.box, edge.point);
          this.#updateFreeLinkPreview(end);
        }
        this.#updateLinkTargetPreview(ev, world);
      }
      if (!drag) return;
      const dx = ev.clientX - (drag.sx ?? ev.clientX), dy = ev.clientY - (drag.sy ?? ev.clientY);
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));

      if (drag.type === "resize") {
        const el = this.cardEls.get(drag.id);
        const w = Math.max(130, drag.ow + dx / this.view.k);
        const h = Math.max(80, drag.oh + dy / this.view.k);
        el.style.width = `${w}px`;
        el.style.minHeight = `${h}px`;
        el.classList.add("jn-sized");
        this.cardSizes.delete(drag.id);
        this.#queueLinkDraw();
      } else if (drag.type === "note-pin" && drag.moved > DRAG_THRESHOLD) {
        if (drag.readOnly) return;
        const world = this.#toWorld(ev.clientX, ev.clientY);
        const point = cardNormalizedPoint(this.#cardBox(drag.id), world);
        if (!point) return;
        this.anchorDrag = { noteId: drag.id, anchorId: drag.anchorId, x: point.x, y: point.y };
        const pin = this.#pinElement(drag.id, drag.anchorId);
        if (pin) {
          pin.style.left = `${point.x * 100}%`;
          pin.style.top = `${point.y * 100}%`;
        }
        this.#queueLinkDraw();
      } else if (drag.type === "card") {
        if (drag.readOnly) return;
        for (const id of drag.ids) {
          const el = this.cardEls.get(id);
          const origin = drag.origins.get(id);
          el.style.left = `${origin.x + dx / this.view.k}px`;
          el.style.top = `${origin.y + dy / this.view.k}px`;
        }
        // This redraw is deliberately local-only. The GM write is sent after pointerup, so
        // other clients see one final movement while the dragging client gets a fluid preview.
        this.#queueLinkDraw();
        this.#updateRouteDropTarget(drag, ev);
      } else if (drag.type === "label") {
        if (drag.readOnly) return;
        const el = this.labelEls.get(drag.id);
        const x = drag.ox + dx / this.view.k, y = drag.oy + dy / this.view.k;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      } else if (drag.type === "pin" && drag.moved > DRAG_THRESHOLD) {
        const thread = this.threads.get(drag.id);
        if (!thread) return;
        const move = { id: drag.id, index: drag.index, x: drag.ox + dx / this.view.k, y: drag.oy + dy / this.view.k };
        const pins = moveThreadPin(thread.pins, move);
        if (!pins) return;
        this.pinDrag = move;
        thread.pins = pins;
        const mask = this.svg.querySelector("mask");
        const x = Number(mask.getAttribute("x")), y = Number(mask.getAttribute("y"));
        if (move.x < x + 110 || move.x > x + Number(mask.getAttribute("width")) - 110
          || move.y < y + 110 || move.y > y + Number(mask.getAttribute("height")) - 110) {
          const boxes = new Map([...this.cardEls.keys()].map(id => [id, this.#cardBox(id)]));
          this.svg.querySelector("defs").outerHTML = this.#threadMask(boxes, this.threads);
          this.maskShapeEls = new Map([...this.svg.querySelectorAll(".jn-thread-mask-shape")].map(shape => [shape.dataset.noteId, shape]));
          this.#syncMaskState();
        }
        this.#paintThread(drag.id, thread);
      } else if (drag.type === "link" && !drag.readOnly && drag.moved > DRAG_THRESHOLD) {
        const thread = this.threads.get(drag.id);
        if (!thread) return;
        this.movingThreads.delete(drag.id);
        thread.motion.pull(drag.x + dx / this.view.k, drag.y + dy / this.view.k,
          Math.hypot(thread.end.x - thread.start.x, thread.end.y - thread.start.y));
        this.#paintThread(drag.id, thread);
      } else if (drag.type === "pan" && drag.moved > DRAG_THRESHOLD) {
        this.view.x = drag.vx + dx;
        this.view.y = drag.vy + dy;
        this.#applyTransform();
        this.#syncLinkToolbar();
      } else if (drag.type === "selection") {
        this.#showSelectionBox(drag.sx, drag.sy, ev.clientX, ev.clientY);
      }
    });

    const finishDrag = ev => {
      if (!drag) return;
      const wasClick = drag.moved <= DRAG_THRESHOLD;
      if ((drag.type === "card" || drag.type === "resize") && !wasClick) this.#flushLinkDraw();

      if (drag.type === "note-pin") {
        const move = this.anchorDrag;
        if (wasClick) {
          this.#setSelection([drag.id], drag.id);
        } else if (move && !drag.readOnly && ev.type === "pointerup") {
          const noteId = drag.id, anchorId = drag.anchorId;
          const write = this.callbacks.onMoveCardAnchor?.(noteId, anchorId, move.x, move.y);
          // Drop the optimistic override immediately. On rejection/false we also put the pin
          // element back to the stored point, so a failed write cannot leave a fake moved pin.
          this.anchorDrag = null;
          const restorePin = () => {
            const stored = this.layout.cards?.[noteId]?.anchors?.[anchorId];
            const pin = this.#pinElement(noteId, anchorId);
            if (stored && pin) {
              pin.style.left = `${stored.x * 100}%`;
              pin.style.top = `${stored.y * 100}%`;
            }
            this.#flushLinkDraw();
          };
          Promise.resolve(write).then(result => {
            if (result === false) restorePin();
            else this.#flushLinkDraw();
          }).catch(restorePin);
        } else if (!wasClick) {
          this.anchorDrag = null;
          this.#flushLinkDraw();
        }
      } else if (drag.type === "pin") {
        const move = this.pinDrag;
        this.pinDrag = null;
        const link = this.linksById.get(drag.id);
        if (move && link && !wasClick && ev.type === "pointerup") {
          this.callbacks.onUpdateLink?.(link.sourceId, link.id, { pinMove: { index: move.index, x: move.x, y: move.y } });
        } else if (!wasClick) {
          this.#flushLinkDraw();
        }
      } else if (drag.type === "card") {
        if (wasClick) {
          if (drag.toggle) {
            const ids = new Set(drag.initialIds ?? this.selectedNoteIds);
            if (ids.has(drag.id)) ids.delete(drag.id); else ids.add(drag.id);
            const next = [...ids];
            this.#setSelection(next, next.length === 1 && !drag.initialLabelIds.length ? next[0] : null, drag.initialLabelIds);
          } else {
            if (drag.text && ev.type === "pointerup") {
              this.#editCardText(drag.id, drag.text);
              lastCardClick = null;
              drag = null;
              return;
            }
            this.#setSelection([drag.id], drag.id);
            const now = Date.now();
            if (lastCardClick?.id === drag.id && now - lastCardClick.at < 450) {
              this.callbacks.onEditNote?.(drag.id);
              lastCardClick = null;
            } else lastCardClick = { id: drag.id, at: now };
          }
        } else {
          if (drag.readOnly) return;
          for (const id of drag.ids) {
            const el = this.cardEls.get(id);
            this.callbacks.onMoveCard(id, parseFloat(el.style.left), parseFloat(el.style.top));
          }
          // The note move is committed exactly as before. Only after that does an explicit
          // drop chooser appear; without a confirmed choice, route topology is never touched.
          // A cancelled pointer (pointercancel/lost capture) must drop the route highlight and
          // preview instead of leaving a stale target behind.
          if (ev.type === "pointerup") {
            this.#updateRouteDropTarget(drag, ev);
            if (this.routeDrop && drag.ids.length === 1
                && typeof this.callbacks.onRouteNoteOnLink === "function") {
              this.#openRouteChooser({
                linkId: this.routeDrop.linkId, noteId: drag.id,
                clientX: ev.clientX, clientY: ev.clientY
              });
            }
          } else {
            this.#clearRouteDrop();
          }
        }
      } else if (drag.type === "resize" && !wasClick) {
        const el = this.cardEls.get(drag.id);
        this.callbacks.onResizeCard(drag.id, el.offsetWidth, Number.parseFloat(el.style.minHeight) || el.offsetHeight);
      } else if (drag.type === "attached-stamp" && wasClick) {
        this.#selectLabel(drag.id);
      } else if (drag.type === "label") {
        if (wasClick && drag.toggle) {
          const labels = new Set(this.selectedLabelIds);
          if (labels.has(drag.id)) labels.delete(drag.id);
          else labels.add(drag.id);
          const notes = this.getSelectedNoteIds();
          this.#setSelection(notes, notes.length === 1 && !labels.size ? notes[0] : null, labels);
          lastLabelClick = null;
          drag = null;
          return;
        }
        this.#selectLabel(drag.id);
        if (wasClick) {
          const { id } = drag;
          const now = Date.now();
          if (!drag.readOnly && !stampUrl(this.layout.labels?.[id]?.stamp)
              && lastLabelClick?.id === id && now - lastLabelClick.at < 420) {
            this.callbacks.onEditLabel(id);
            lastLabelClick = null;
          } else lastLabelClick = { id, at: now };
        } else if (!drag.readOnly) {
          const el = this.labelEls.get(drag.id);
          this.callbacks.onMoveLabel(drag.id, parseFloat(el.style.left), parseFloat(el.style.top));
        }
      } else if (drag.type === "link" && !wasClick) {
        this.lastLinkClick = null;
        if (drag.readOnly) { drag = null; return; }
        const thread = this.threads.get(drag.id);
        if (thread?.motion.moving) {
          if (this.root.ownerDocument.defaultView.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
            thread.motion.retarget(thread.start, thread.end, false);
            this.#paintThread(drag.id, thread);
          } else {
            this.movingThreads.add(drag.id);
            this.#requestThreadFrame();
          }
        }
      } else if (drag.type === "link" && ev.type === "pointerup") {
        const now = Date.now();
        if (this.lastLinkClick?.id === drag.id && now - this.lastLinkClick.at < 420) {
          const link = this.linksById.get(drag.id);
          if (link && !drag.readOnly) this.callbacks.onDeleteLink(link.sourceId, link.id);
          this.lastLinkClick = null;
          this.selectedLinkId = null;
          this.#syncLinkSelection();
          this.#syncLinkToolbar();
        } else {
          this.#highlightLabels([]);
          this.lastLinkClick = { id: drag.id, at: now };
          this.selectedLinkId = drag.id;
          this.selectedNoteId = null;
          this.selectedNoteIds.clear();
          for (const el of this.cardEls.values()) el.classList.remove("selected");
          this.#syncLinkSelection();
          this.callbacks.onSelectNote(null);
          this.#syncLinkToolbar();
        }
      } else if (drag.type === "selection") {
        this.#finishSelection(drag, ev.clientX, ev.clientY);
        // Pointer capture can retarget native dblclick. Count consecutive empty-board clicks
        // here, in the same place as the card and label double-click gestures.
        if (wasClick && !drag.additive && ev.type === "pointerup") {
          const now = Date.now();
          if (lastBoardClick && now - lastBoardClick.at < 450
              && Math.hypot(ev.clientX - lastBoardClick.x, ev.clientY - lastBoardClick.y) <= 8) {
            this.#openContextMenu(ev.clientX, ev.clientY);
            lastBoardClick = null;
          } else lastBoardClick = { at: now, x: ev.clientX, y: ev.clientY };
        } else lastBoardClick = null;
      }
      if (ev.type !== "pointerup") this.#clearRouteDrop();
      drag = null;
    };
    this.root.addEventListener("pointerup", finishDrag);
    this.root.addEventListener("pointercancel", finishDrag);
    this.root.addEventListener("contextmenu", ev => {
      if (ev.target.closest(PATCH_NOTES_SELECTOR)) {
        ev.preventDefault();
        return;
      }
      if (ev.target.closest(".jn-floating-toolbar, .jn-floating-popover")) {
        ev.preventDefault();
        return;
      }
      if (ev.target.closest(".jn-card input, .jn-card textarea")) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.target.closest(".jn-context-menu")) return;
      const labelId = ev.target.closest("[data-stamp-label-id]")?.dataset.stampLabelId
        ?? ev.target.closest(".jn-label")?.dataset.id;
      const noteId = ev.target.closest(".jn-card")?.dataset.id;
      this.#openContextMenu(ev.clientX, ev.clientY, { noteId, labelId, editStamp: !!(noteId && labelId) });
    });
    this.root.addEventListener("auxclick", ev => {
      if (ev.button === 1) ev.preventDefault();
    });

    this.root.addEventListener("dblclick", ev => {
      if (ev.target.closest(PATCH_NOTES_SELECTOR)) return;
      if (ev.target.closest(".jn-floating-toolbar, .jn-floating-popover")) return;
      if (ev.target.closest("[data-stamp-label-id], .jn-label")) return;
      if (ev.target.closest(".jn-card-resize")) {
        if (this.readOnly) return this.#warnReadOnly();
        const cardEl = ev.target.closest(".jn-card");
        const id = cardEl.dataset.id;
        cardEl.style.width = "";
        cardEl.style.minHeight = "";
        cardEl.classList.remove("jn-sized");
        this.cardSizes.delete(id);
        this.callbacks.onResetCardSize(id);
        return;
      }
    });
  }

  addLabelButton() {
    if (this.readOnly) return this.#warnReadOnly();
    const rect = this.root.getBoundingClientRect();
    const { x, y } = this.#toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    this.callbacks.onAddLabelAt(x, y);
  }

  /** World-space top-left for a new card centered in the current viewport. */
  newCardPosition(width = 190, height = 90) {
    const rect = this.root.getBoundingClientRect();
    const center = this.#toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      x: Math.round(center.x - width / 2),
      y: Math.round(center.y - height / 2)
    };
  }

  /** Snapshot of the current card selection for keyboard actions owned by JournalApp. */
  getSelectedNoteIds() {
    const ids = this.selectedNoteIds.size ? this.selectedNoteIds : [this.selectedNoteId];
    return [...ids].filter(id => this.cardEls.has(id));
  }

  getSelectedLabelIds() {
    return [...this.selectedLabelIds].filter(id => this.layout.labels?.[id]);
  }

  /** Clears both the multi-selection and the primary card selection. */
  clearSelection() {
    this.#setSelection([], null);
  }

  /** Pans to and selects a note — used by backlink chips in the editor. */
  focusNote(noteId) {
    const card = this.layout.cards?.[noteId];
    if (!card) return;
    const el = this.cardEls.get(noteId);
    const w = el?.offsetWidth ?? 190, h = el?.offsetHeight ?? 70;
    const rect = this.root.getBoundingClientRect();
    this.view.x = rect.width / 2 - (card.x + w / 2) * this.view.k;
    this.view.y = rect.height / 2 - (card.y + h / 2) * this.view.k;
    this.#applyTransform();
    this.#setSelection([noteId], noteId);
  }
}
