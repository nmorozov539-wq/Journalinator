import { CARD_STYLES, cardStyleKey } from "../styles/registry.mjs";
import {
  CARD_SIDES, MAX_THREAD_PINS, THREAD_PIN_RADIUS, cardEdgeAt, cardPointAnchor, moveThreadPin, threadAttachment, validThreadPin
} from "../card-ports.mjs";
import { arrowHead, pinnedThreadPath, ThreadMotion } from "../link-thread.mjs";
import { noteImageSource, noteImageUrl } from "../image-url.mjs";
import { hasAnyLock } from "../locks.mjs";
import { renderMarkdown } from "../markdown.mjs";
import { t } from "../i18n.mjs";
import { DEFAULT_STAMP_CORNER, isStampCorner, STAMP_COLORS, STAMP_CORNERS, STAMP_IDS, stampUrl } from "../stamps.mjs";

const DRAG_THRESHOLD = 5;
let threadMaskSequence = 0;
const LINK_COLORS = ["", "#a393f2", "#d6a45c", "#d77b91"];
const LINK_DEFAULT_COLOR = "#8e8e9a";
const LINK_DIRECTIONS = new Set(["none", "one", "two"]);
const SAFE_LINK_COLORS = new Set(LINK_COLORS);

/** Maps anything outside the toolbar palette to the default color before it reaches SVG markup. */
function safeLinkColor(color) {
  const normalized = typeof color === "string" ? color.toLowerCase() : "";
  return SAFE_LINK_COLORS.has(normalized) ? normalized : "";
}

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
    this.cardEls = new Map();
    this.labelEls = new Map();
    this.linksById = new Map();
    this.threads = new Map();
    this.movingThreads = new Set();
    this.threadFrame = null;
    this.threadTime = null;
    this.selectedNoteId = null;
    this.selectedLabelIds = new Set();
    this.selectedNoteIds = new Set();
    this.selectedLinkId = null;
    this.lastLinkClick = null;
    this.linkDrawTimer = null;
    this.cardResizeObserver = null;
    this.inlineText = null;
    this.linkPlacement = null;
    this.dimMatch = () => true; // (note) => does it match the active search/filters?
    this.gmMode = false; // GM view with secrets merged in: shows hide/reveal/hint controls
    this.readOnly = false; // no active GM: allow selecting/reading but no writes

    this.root = document.createElement("div");
    this.root.className = "jn-canvas";
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
      <div class="jn-link-placement-hint" role="status" hidden></div>
    `;
    this.world = this.root.querySelector(".jn-world");
    this.svg = this.root.querySelector(".jn-links");
    this.linkHits = this.root.querySelector(".jn-link-hits");
    this.selectionBox = this.root.querySelector(".jn-selection-box");
    this.contextMenu = this.root.querySelector(".jn-context-menu");
    this.linkToolbar = this.root.querySelector(".jn-link-toolbar");
    this.linkPlacementHint = this.root.querySelector(".jn-link-placement-hint");

    this.#bindPointerEvents();
  }

  update(notes, layout, { dimMatch, deferGeometry = false } = {}) {
    this.notes = notes;
    this.layout = layout ?? { cards: {}, labels: {} };
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
      }
    }

    for (const [id, el] of [...this.labelEls]) {
      if (!seenLabels.has(id)) { el.remove(); this.labelEls.delete(id); }
    }
    if (this.linkPlacement?.source && !this.cardEls.has(this.linkPlacement.source.id)) this.cancelLinkTool();

    if (!deferGeometry) this.refreshGeometry();
  }

  refreshGeometry() {
    if (!this.hasCentered && this.notes.length && this.root.clientWidth && this.root.clientHeight) {
      this.#centerOnContent();
      this.hasCentered = true;
    }
    this.#applyTransform();
    this.#flushLinkDraw();
    if (!this.cardResizeObserver && typeof ResizeObserver === "function") {
      this.cardResizeObserver = new ResizeObserver(() => this.#queueLinkDraw());
      for (const card of this.cardEls.values()) this.cardResizeObserver.observe(card, { box: "border-box" });
    }
  }

  disconnectGeometry() {
    this.cardResizeObserver?.disconnect();
    this.cardResizeObserver = null;
    if (this.linkDrawTimer !== null) clearTimeout(this.linkDrawTimer);
    this.linkDrawTimer = null;
    if (this.threadFrame !== null) this.root.ownerDocument.defaultView.cancelAnimationFrame(this.threadFrame);
    this.threadFrame = this.threadTime = null;
    this.threads.clear();
    this.pinDrag = null;
    this.movingThreads.clear();
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
    const styleDef = CARD_STYLES[cardStyleKey(note.system.style)];
    let el = this.cardEls.get(note._id);
    if (!el) {
      el = document.createElement("div");
      el.className = "jn-card";
      el.dataset.id = note._id;
      el.innerHTML = `
        <img class="jn-card-background" alt="" draggable="false" referrerpolicy="no-referrer" hidden>
        <i class="jn-card-badge"></i>
        <button type="button" class="jn-card-image-button">
          <i class="fa-solid fa-camera" aria-hidden="true"></i><span aria-hidden="true">+</span>
        </button>
        <strong class="jn-card-wanted-heading" data-card-text="heading" tabindex="0"></strong>
        <div class="jn-card-image" hidden><img alt="" draggable="false" referrerpolicy="no-referrer"></div>
        <h3 class="jn-card-title" data-card-text="title" tabindex="0"></h3>
        <div class="jn-card-excerpt"></div>
        <div class="jn-card-stamps"></div>
        <span class="jn-card-lock-pill">&#9998;</span>
        <b class="jn-card-resize"></b>
      `;
      this.world.appendChild(el);
      this.cardEls.set(note._id, el);
      this.cardResizeObserver?.observe(el, { box: "border-box" });
    }

    el.className = `jn-card ${styleDef.cssClass}`;
    el.classList.toggle("jn-secret", !!note.secret);
    el.classList.toggle("jn-kind-location", note.system.kind === "location");
    el.classList.toggle("jn-hint", !!note.system.hint);
    el.classList.toggle("jn-has-hidden", !note.secret && (note.system.blocks ?? []).some(b => b.hidden));
    el.classList.toggle("selected", this.selectedNoteIds.has(note._id) || note._id === this.selectedNoteId);
    el.classList.toggle("jn-being-edited", hasAnyLock(note._id));
    el.classList.toggle("jn-dimmed", !this.dimMatch(note));
    el.style.left = `${cardData.x}px`;
    el.style.top = `${cardData.y}px`;
    el.style.setProperty("--jn-rotation", `${cardData.rotation ?? 0}deg`);
    if (cardData.width) { el.style.width = `${cardData.width}px`; el.classList.add("jn-sized"); }
    else { el.style.width = ""; el.classList.remove("jn-sized"); }
    el.style.minHeight = cardData.height ? `${cardData.height}px` : "";

    const author = game.users.get(note.system.authorId);
    el.style.setProperty("--jn-author-color", author?.color ?? "#8d8d97");
    const badge = el.querySelector(".jn-card-badge");
    badge.textContent = (author?.name ?? "?")[0].toUpperCase();

    const image = el.querySelector(".jn-card-image");
    const portrait = image.querySelector("img");
    const imageButton = el.querySelector(".jn-card-image-button");
    const isTarget = styleDef.cssClass === "jn-card-wanted";
    const source = noteImageSource(note.system.image);
    const imageAnchor = el.querySelector(isTarget ? ".jn-card-wanted-heading" : ".jn-card-excerpt");
    if (image.previousElementSibling !== imageAnchor) imageAnchor.after(image);
    const label = t(source ? "JN.Editor.ChangeImage" : "JN.Editor.SetImage");
    imageButton.title = label;
    imageButton.setAttribute("aria-label", label);
    image.hidden = !source;
    if (source && portrait.getAttribute("src") !== source) portrait.setAttribute("src", source);
    else if (!source) portrait.removeAttribute("src");
    const background = el.querySelector(".jn-card-background");
    const backgroundSource = noteImageUrl(note.system.backgroundImage);
    background.hidden = !backgroundSource;
    if (backgroundSource && background.getAttribute("src") !== backgroundSource) background.setAttribute("src", backgroundSource);
    else if (!backgroundSource) background.removeAttribute("src");

    const title = el.querySelector(".jn-card-title");
    const heading = el.querySelector(".jn-card-wanted-heading");
    if (this.inlineText?.field !== title) title.textContent = note.name;
    if (this.inlineText?.field !== heading) heading.textContent = note.system.targetHeading || t("JN.Style.Wanted");
    this.#renderCardBlocks(el.querySelector(".jn-card-excerpt"), note.system.blocks ?? []);
    const stampSlot = el.querySelector(".jn-card-stamps");
    if (stamp) el.dataset.sealCorner = stamp.dataset.sealCorner;
    else delete el.dataset.sealCorner;
    stampSlot.replaceChildren(...(stamp ? [stamp] : []));
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
    const input = document.createElement("input");
    input.type = "text";
    input.className = "jn-card-text-input";
    input.maxLength = kind === "heading" ? 80 : 200;
    input.value = this.callbacks.onReadCardText?.(id, kind) ?? field.textContent;
    if (kind === "heading") input.placeholder = t("JN.Style.Wanted");
    input.setAttribute("aria-label", t(kind === "heading" ? "JN.Editor.TargetHeading" : "JN.Editor.RenameTitle"));
    this.inlineText = { field, input, id, kind };
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
    input.onblur = null;
    const note = this.notes.find(item => item._id === id);
    if (!note) return;
    field.textContent = kind === "title" ? note.name : note.system.targetHeading || t("JN.Style.Wanted");
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
    return {
      x: Number.isFinite(liveX) ? liveX : data.x,
      y: Number.isFinite(liveY) ? liveY : data.y,
      w: el?.offsetWidth || Number.parseFloat(el?.style.width) || 190,
      h: el?.offsetHeight || Number.parseFloat(el?.style.minHeight) || 70,
      rotation: data.rotation ?? 0
    };
  }

  #drawLinks() {
    this.linksById = new Map();
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

    let body = "";
    let hits = "";
    const threads = new Map();
    const animate = this.root.isConnected && !this.root.ownerDocument.defaultView.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const dimmedIds = new Set(this.notes.filter(n => !this.dimMatch(n)).map(n => n._id));
    for (const { note, link, sourceSide, targetSide } of links) {
      const p = threadAttachment(boxes.get(note._id), link.sourcePoint, sourceSide);
      const r = threadAttachment(boxes.get(link.targetId), link.targetPoint, targetSide);
      const motion = this.threads.get(link.id)?.motion ?? new ThreadMotion(p, r);
      motion.retarget(p, r, animate);
      const savedPins = Array.isArray(link.pins) ? link.pins.slice(0, MAX_THREAD_PINS).filter(validThreadPin) : [];
      const pins = this.pinDrag?.id === link.id ? moveThreadPin(savedPins, this.pinDrag) ?? savedPins : savedPins;
      threads.set(link.id, { start: p, end: r, pins, motion });
      const { path: d, center: { x: mx, y: my }, startLead, endLead, start, end } = pinnedThreadPath(p, r, pins, motion);
      const color = safeLinkColor(link.color) || LINK_DEFAULT_COLOR;
      const direction = LINK_DIRECTIONS.has(link.direction) ? link.direction : "none";
      const selected = link.id === this.selectedLinkId;
      const endpoint = (anchor, directed, lead) => {
        const points = directed ? arrowHead(anchor, lead) : null;
        return `<circle class="jn-thread-pin" cx="${anchor.x - anchor.nx * THREAD_PIN_RADIUS}"
          cy="${anchor.y - anchor.ny * THREAD_PIN_RADIUS}" r="${THREAD_PIN_RADIUS}"/>
          ${points ? `<polygon class="jn-link-arrow${color === LINK_DEFAULT_COLOR ? " jn-thread-arrow-default" : ""}"
          points="${points}" fill="${color}"/>` : ""}`;
      };
      const dimmed = dimmedIds.has(note._id) || dimmedIds.has(link.targetId);
      const linkId = foundry.utils.escapeHTML(String(link.id ?? ""));

      const linkClasses = [link.hidden ? "jn-link-hidden" : "", link.hint ? "jn-link-hint" : ""].join(" ").trim();
      body += `<g data-id="${linkId}" class="${linkClasses}" opacity="${dimmed ? 0.15 : 1}">
        <path class="jn-thread${color === LINK_DEFAULT_COLOR ? " jn-thread-default" : ""}" d="${d}" fill="none" stroke="${color}" stroke-width="${selected ? 3.5 : 2}"
          ${link.hidden ? 'stroke-dasharray="2 6" stroke-linecap="round"' : link.lineStyle === "dashed" ? 'stroke-dasharray="7 6"' : ""}/>
        ${endpoint(start, direction === "two", startLead)}
        ${endpoint(end, direction !== "none", endLead)}
        ${pins.map((pin, index) => `<circle class="jn-thread-pin jn-board-pin" data-pin-index="${index}" cx="${pin.x}" cy="${pin.y}" r="${THREAD_PIN_RADIUS}"/>`).join("")}
        ${link.label || link.hint ? `<text class="jn-link-label" x="${mx}" y="${my + 4}">${link.hint ? "&#10022; " : ""}${foundry.utils.escapeHTML(link.label ?? "")}</text>` : ""}
      </g>`;
      hits += `<path class="jn-link-hit" data-id="${linkId}" d="${d}"/>`;

      this.linksById.set(link.id, { sourceId: note._id, targetId: link.targetId, mx, my, ...link });
    }

    this.svg.innerHTML = this.#threadMask(boxes, threads) + `<g mask="url(#${this.threadMaskId})">${body}</g>`;
    this.linkHits.innerHTML = hits;
    let index = 0;
    for (const thread of threads.values()) {
      const group = this.svg.children[1].children[index];
      thread.line = group.querySelector(".jn-thread");
      thread.label = group.querySelector(".jn-link-label");
      thread.markers = group.querySelectorAll("[data-pin-index]");
      thread.hit = this.linkHits.children[index++];
    }
    this.threads = threads;
    this.movingThreads = new Set([...threads].filter(([, thread]) => thread.motion.moving).map(([id]) => id));
    if (this.previewPath) this.svg.appendChild(this.previewPath);
    if (this.previewPin) this.svg.appendChild(this.previewPin);
    if (this.edgePin) this.svg.appendChild(this.edgePin);
    if (this.draftPins) this.svg.appendChild(this.draftPins);
    if (animate && this.movingThreads.size) this.#requestThreadFrame();
  }

  #threadMask(boxes, threads) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    let silhouettes = "";
    for (const box of boxes.values()) {
      const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
        .map(point => cardPointAnchor(box, point));
      for (const { x, y } of corners) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
      silhouettes += `<polygon points="${corners.map(({ x, y }) => `${x},${y}`).join(" ")}" fill="#777"/>`;
    }
    if (!silhouettes) left = top = right = bottom = 0;
    for (const { pins } of threads.values()) {
      for (const { x, y } of pins) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    // Include the maximum travel of a pulled thread and its control points.
    const bounds = `x="${left - 320}" y="${top - 320}" width="${right - left + 640}" height="${bottom - top + 640}"`;
    return `<defs><mask id="${this.threadMaskId}" maskUnits="userSpaceOnUse" ${bounds}>
      <rect ${bounds} fill="white"/>${silhouettes}
    </mask></defs>`;
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
    const { path, center } = pinnedThreadPath(thread.start, thread.end, thread.pins, thread.motion);
    thread.line.setAttribute("d", path);
    thread.hit.setAttribute("d", path);
    thread.label?.setAttribute("x", center.x);
    thread.label?.setAttribute("y", center.y + 4);
    thread.pins.forEach((pin, index) => {
      thread.markers[index].setAttribute("cx", pin.x);
      thread.markers[index].setAttribute("cy", pin.y);
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
  }

  #positionLinkToolbar(link) {
    this.linkToolbar.style.left = `${link.mx * this.view.k + this.view.x}px`;
    this.linkToolbar.style.top = `${link.my * this.view.k + this.view.y}px`;
  }

  #syncLinkToolbar() {
    const link = this.selectedLinkId ? this.linksById.get(this.selectedLinkId) : null;
    if (!link || this.readOnly) { this.linkToolbar.style.display = "none"; return; }

    this.#positionLinkToolbar(link);
    this.linkToolbar.style.display = "flex";
    const currentColor = safeLinkColor(link.color);
    const direction = LINK_DIRECTIONS.has(link.direction) ? link.direction : "none";
    this.linkToolbar.innerHTML = `
      <input type="text" class="jn-link-label-input" placeholder="${t("JN.Link.Label")}" value="${foundry.utils.escapeHTML(link.label ?? "")}">
      <button type="button" class="jn-link-dir" title="${t("JN.Link.Direction")}">${{ none: "—", one: "→", two: "↔" }[direction]}</button>
      <span class="jn-link-colors">${LINK_COLORS.map(c => `<button type="button" class="jn-link-color${c === currentColor ? " on" : ""}" data-color="${c}" style="background:${c || `var(--jn-thread-color, ${LINK_DEFAULT_COLOR})`}"></button>`).join("")}</span>
      <button type="button" class="jn-link-dash" title="${t("JN.Link.LineStyle")}">${link.lineStyle === "dashed" ? "┄┄" : "──"}</button>
      ${this.#gmLinkButtons(link)}
      <button type="button" class="jn-link-delete" title="${t("JN.Link.Delete")}">✕</button>
    `;

    const update = fields => this.callbacks.onUpdateLink(link.sourceId, link.id, fields);
    // Commit on change (blur), not per keystroke: one socket message and one world write
    // per label edit, matching the block-save rule in spec §6.2.
    this.linkToolbar.querySelector(".jn-link-label-input").onchange = ev => update({ label: ev.target.value });
    this.linkToolbar.querySelector(".jn-link-dir").onclick = () =>
      update({ direction: { none: "one", one: "two", two: "none" }[direction] });
    this.linkToolbar.querySelectorAll(".jn-link-color").forEach(btn => {
      btn.onclick = () => update({ color: btn.dataset.color });
    });
    this.linkToolbar.querySelector(".jn-link-dash").onclick = () =>
      update({ lineStyle: link.lineStyle === "dashed" ? "solid" : "dashed" });
    const gmButton = (selector, fn) => {
      const btn = this.linkToolbar.querySelector(selector);
      if (btn) btn.onclick = () => { fn(); this.selectedLinkId = null; this.linkToolbar.style.display = "none"; };
    };
    gmButton(".jn-link-hide", () => this.callbacks.onHideLink?.(link.sourceId, link.id));
    gmButton(".jn-link-reveal", () => this.callbacks.onRevealLink?.(link.sourceId, link.id));
    const hintBtn = this.linkToolbar.querySelector(".jn-link-hint-toggle");
    if (hintBtn) hintBtn.onclick = () => this.callbacks.onToggleLinkHint?.(link.sourceId, link.id, !link.hint);
    this.linkToolbar.querySelector(".jn-link-delete").onclick = () => {
      this.callbacks.onDeleteLink(link.sourceId, link.id);
      this.selectedLinkId = null;
      this.linkToolbar.style.display = "none";
    };
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

  #applyTransform() {
    this.world.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.k})`;
    this.root.style.backgroundPosition = `${this.view.x}px ${this.view.y}px`;
    this.root.style.backgroundSize = `${24 * this.view.k}px ${24 * this.view.k}px`;
    this.root.classList.toggle("jn-far-zoom", this.view.k < 0.48);
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
    for (const [id, el] of this.cardEls) el.classList.toggle("selected", this.selectedNoteIds.has(id));
    this.#syncLinkToolbar();
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
    this.edgePin.setAttribute("r", THREAD_PIN_RADIUS);
    this.edgePin.style.display = "none";
    this.svg.appendChild(this.edgePin);
    this.draftPins = document.createElementNS("http://www.w3.org/2000/svg", "g");
    this.svg.appendChild(this.draftPins);
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
    this.#endLinkPreview();
  }

  #linkEdgeAt(ev, world) {
    const card = ev.target.closest(".jn-card") ?? document.elementsFromPoint?.(ev.clientX, ev.clientY)
      .map(element => element.closest(".jn-card")).find(element => element && this.world.contains(element));
    if (!card) return;
    const id = card.dataset.id;
    const box = this.#cardBox(id);
    const { point, distance } = cardEdgeAt(box, world);
    if (distance * this.view.k <= 16) return { id, box, point };
  }

  #pickLinkPoint(ev) {
    const world = this.#toWorld(ev.clientX, ev.clientY);
    const edge = this.#linkEdgeAt(ev, world);
    const { source, pins } = this.linkPlacement;
    if (!edge) {
      if (!source || pins.length >= MAX_THREAD_PINS || !validThreadPin(world)) return;
      pins.push(world);
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      marker.setAttribute("class", "jn-thread-pin jn-board-pin");
      marker.setAttribute("cx", world.x);
      marker.setAttribute("cy", world.y);
      marker.setAttribute("r", THREAD_PIN_RADIUS);
      this.draftPins.appendChild(marker);
      this.#updateFreeLinkPreview(world);
      return;
    }
    const { id, point } = edge;
    if (source && source.id !== id) {
      this.cancelLinkTool();
      const anchors = { sourcePoint: source.point, targetPoint: point, pins };
      this.callbacks.onCreateLink?.(source.id, id, anchors);
      return;
    }
    this.linkPlacement.source = { id, point };
    this.linkPlacementHint.textContent = t("JN.Link.PickEnd");
    this.#endLinkPreview();
    this.#startLinkPreview();
    this.previewPin = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    this.previewPin.setAttribute("class", "jn-thread-pin");
    this.previewPin.setAttribute("r", THREAD_PIN_RADIUS);
    this.svg.appendChild(this.previewPin);
    this.#updateFreeLinkPreview(threadAttachment(edge.box, point));
  }

  #updateFreeLinkPreview(cursor) {
    const { id, point } = this.linkPlacement.source;
    const start = threadAttachment(this.#cardBox(id), point);
    this.previewPin.setAttribute("cx", start.x - start.nx * THREAD_PIN_RADIUS);
    this.previewPin.setAttribute("cy", start.y - start.ny * THREAD_PIN_RADIUS);
    this.previewPath.setAttribute("d", pinnedThreadPath(start, cursor, this.linkPlacement.pins).path);
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
      this.contextMenu.innerHTML = `
        <button type="button" data-action="card-stamp">${t("JN.Stamp.Add")}</button>
        <button type="button" data-action="card-background">${t("JN.Editor.ChangeBackground")}</button>`;
    } else this.contextMenu.innerHTML = `
      <button type="button" data-action="note">${t("JN.Context.NewNote")}</button>
      <button type="button" data-action="memo">${t("JN.Style.Memo")}</button>
      <button type="button" data-action="wanted">${t("JN.Style.Wanted")}</button>
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
        else if (action === "note") this.callbacks.onCreateNoteAt(point.x - 95, point.y - 35, { kind: "note" });
        else if (action === "memo") this.callbacks.onCreateNoteAt(point.x - CARD_STYLES.memo.defaultWidth / 2, point.y - 35, { style: "memo" });
        else if (action === "wanted") this.callbacks.onCreateNoteAt(point.x - 125, point.y - 35, { style: "wanted" });
        else if (action === "location") this.callbacks.onCreateNoteAt(point.x - 122, point.y - 45, { kind: "location" });
        else if (action === "label") this.callbacks.onAddLabelAt(point.x, point.y);
        else if (action === "secret-note") this.callbacks.onCreateNoteAt(point.x - 95, point.y - 35, { kind: "note", secret: true });
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

    this.root.addEventListener("click", ev => {
      const camera = ev.target.closest(".jn-card-image-button");
      if (camera && !camera.hidden) {
        ev.stopPropagation();
        this.callbacks.onEditCardImage?.(camera.closest(".jn-card").dataset.id);
        return;
      }
      if (ev.button !== 0 || ev.target.closest(".jn-context-menu, .jn-link-toolbar, input, textarea")) return;
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
      if (ev.target.closest(".jn-card input, .jn-card textarea") && !ev.ctrlKey) return;
      ev.preventDefault();
      this.#closeContextMenu();
      this.#zoomAt(ev.clientX, ev.clientY, this.view.k * Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });

    this.root.addEventListener("pointerdown", ev => {
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
        const edge = this.#linkEdgeAt(ev, world);
        this.edgePin.style.display = edge ? "" : "none";
        if (edge) {
          const { x, y } = cardPointAnchor(edge.box, edge.point);
          this.edgePin.setAttribute("cx", x);
          this.edgePin.setAttribute("cy", y);
        }
        if (this.linkPlacement.source) {
          const end = edge ? threadAttachment(edge.box, edge.point) : { ...world, nx: 0, ny: 0 };
          this.#updateFreeLinkPreview(end);
        }
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

      if (drag.type === "pin") {
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
          this.#syncLinkToolbar();
        } else {
          this.#highlightLabels([]);
          this.lastLinkClick = { id: drag.id, at: now };
          this.selectedLinkId = drag.id;
          this.selectedNoteId = null;
          this.selectedNoteIds.clear();
          for (const el of this.cardEls.values()) el.classList.remove("selected");
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
      drag = null;
    };
    this.root.addEventListener("pointerup", finishDrag);
    this.root.addEventListener("pointercancel", finishDrag);
    this.root.addEventListener("contextmenu", ev => {
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
      if (ev.target.closest("[data-stamp-label-id], .jn-label")) return;
      if (ev.target.closest(".jn-card-resize")) {
        if (this.readOnly) return this.#warnReadOnly();
        const cardEl = ev.target.closest(".jn-card");
        const id = cardEl.dataset.id;
        cardEl.style.width = "";
        cardEl.style.minHeight = "";
        cardEl.classList.remove("jn-sized");
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
