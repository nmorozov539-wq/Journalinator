import { CARD_STYLES, tintFor } from "../styles/registry.mjs";
import { hasAnyLock } from "../locks.mjs";
import { t } from "../i18n.mjs";

const DRAG_THRESHOLD = 5;
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
    this.view = { x: 0, y: 0, k: 1 };
    this.hasCentered = false;
    this.cardEls = new Map();
    this.labelEls = new Map();
    this.linksById = new Map();
    this.selectedNoteId = null;
    this.selectedNoteIds = new Set();
    this.selectedLinkId = null;
    this.lastLinkClick = null;
    this.linkDrawTimer = null;
    this.dimMatch = () => true; // (note) => does it match the active search/filters?
    this.gmMode = false; // GM view with secrets merged in: shows hide/reveal/hint controls

    this.root = document.createElement("div");
    this.root.className = "jn-canvas";
    this.root.innerHTML = `
      <div class="jn-world">
        <svg class="jn-links"></svg>
      </div>
      <div class="jn-selection-box"></div>
      <div class="jn-context-menu"></div>
      <div class="jn-link-toolbar"></div>
    `;
    this.world = this.root.querySelector(".jn-world");
    this.svg = this.root.querySelector(".jn-links");
    this.selectionBox = this.root.querySelector(".jn-selection-box");
    this.contextMenu = this.root.querySelector(".jn-context-menu");
    this.linkToolbar = this.root.querySelector(".jn-link-toolbar");

    this.#bindPointerEvents();
  }

  update(notes, layout, { dimMatch } = {}) {
    this.notes = notes;
    this.layout = layout ?? { cards: {}, labels: {} };
    if (dimMatch) this.dimMatch = dimMatch;

    const seenCards = new Set();
    for (const note of notes) {
      seenCards.add(note._id);
      this.#renderCard(note);
    }
    for (const [id, el] of [...this.cardEls]) {
      if (!seenCards.has(id)) { el.remove(); this.cardEls.delete(id); }
    }

    const labels = this.layout.labels ?? {};
    const seenLabels = new Set(Object.keys(labels));
    for (const [id, data] of Object.entries(labels)) this.#renderLabel(id, data);
    for (const [id, el] of [...this.labelEls]) {
      if (!seenLabels.has(id)) { el.remove(); this.labelEls.delete(id); }
    }

    if (!this.hasCentered && notes.length) {
      this.#centerOnContent();
      this.hasCentered = true;
    }
    this.#applyTransform();
    this.#drawLinks();
    this.#syncLinkToolbar();
  }

  #renderCard(note) {
    const cardData = this.layout.cards?.[note._id] ?? { x: 0, y: 0, rotation: 0 };
    const styleDef = CARD_STYLES[note.system.style] ?? CARD_STYLES.sticky;
    let el = this.cardEls.get(note._id);
    if (!el) {
      el = document.createElement("div");
      el.className = "jn-card";
      el.dataset.id = note._id;
      el.innerHTML = `
        <i class="jn-card-badge"></i>
        <div class="jn-card-image" hidden></div>
        <h3 class="jn-card-title"></h3>
        <p class="jn-card-excerpt"></p>
        <span class="jn-card-lock-pill">&#9998;</span>
        <b class="jn-card-link jn-card-link-top" data-side="top" title="${t("JN.Canvas.LinkHandle")}"></b>
        <b class="jn-card-link jn-card-link-right" data-side="right" title="${t("JN.Canvas.LinkHandle")}"></b>
        <b class="jn-card-link jn-card-link-bottom" data-side="bottom" title="${t("JN.Canvas.LinkHandle")}"></b>
        <b class="jn-card-link jn-card-link-left" data-side="left" title="${t("JN.Canvas.LinkHandle")}"></b>
        <b class="jn-card-resize"></b>
      `;
      this.world.appendChild(el);
      this.cardEls.set(note._id, el);
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
    el.style.setProperty("--jn-tint", note.system.style === "sticky" ? tintFor(note._id) : "transparent");
    if (cardData.width) { el.style.width = `${cardData.width}px`; el.classList.add("jn-sized"); }
    else { el.style.width = ""; el.classList.remove("jn-sized"); }
    if (cardData.height) { el.style.height = `${cardData.height}px`; }
    else { el.style.height = ""; }

    const author = game.users.get(note.system.authorId);
    el.style.setProperty("--jn-author-color", author?.color ?? "#8d8d97");
    const badge = el.querySelector(".jn-card-badge");
    badge.textContent = (author?.name ?? "?")[0].toUpperCase();

    const image = el.querySelector(".jn-card-image");
    if (note.system.image) {
      image.hidden = false;
      const imageUrl = String(note.system.image).replace(/["\\]/g, "\\$&");
      image.style.backgroundImage = `url("${imageUrl}")`;
    } else {
      image.hidden = true;
    }

    el.querySelector(".jn-card-title").textContent = note.name;
    const excerpt = (note.system.blocks?.[0]?.text ?? "").slice(0, 140);
    el.querySelector(".jn-card-excerpt").textContent = excerpt;
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
    el.textContent = data.text ?? "";
  }

  /** Closest point on card `a`'s edge toward card `b`'s center, plus the outward normal (prototype's `anc()`). */
  #anchor(a, b) {
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
    const dx = (b.x + b.w / 2) - ax, dy = (b.y + b.h / 2) - ay;
    const hw = a.w / 2 + 5, hh = a.h / 2 + 5;
    const tx = hw / Math.abs(dx || 1e-6), ty = hh / Math.abs(dy || 1e-6);
    const t = Math.min(tx, ty), horizontal = tx < ty;
    return {
      x: ax + dx * t, y: ay + dy * t,
      nx: horizontal ? Math.sign(dx) : 0,
      ny: horizontal ? 0 : Math.sign(dy)
    };
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
      h: el?.offsetHeight || Number.parseFloat(el?.style.height) || 70
    };
  }

  #drawLinks() {
    this.linksById = new Map();
    const colorsUsed = new Set();
    let body = "";

    const dimmedIds = new Set(this.notes.filter(n => !this.dimMatch(n)).map(n => n._id));

    for (const note of this.notes) {
      for (const link of note.system.links ?? []) {
        if (!this.cardEls.has(note._id) || !this.cardEls.has(link.targetId)) continue;
        const a = this.#cardBox(note._id), b = this.#cardBox(link.targetId);
        const p = this.#anchor(a, b), r = this.#anchor(b, a);
        const o = Math.max(40, Math.hypot(p.x - r.x, p.y - r.y) * 0.35);
        const c1 = [p.x + p.nx * o, p.y + p.ny * o], c2 = [r.x + r.nx * o, r.y + r.ny * o];
        const d = `M${p.x},${p.y} C${c1} ${c2} ${r.x},${r.y}`;
        const mx = (p.x + 3 * c1[0] + 3 * c2[0] + r.x) / 8, my = (p.y + 3 * c1[1] + 3 * c2[1] + r.y) / 8;
        const color = safeLinkColor(link.color) || LINK_DEFAULT_COLOR;
        const direction = LINK_DIRECTIONS.has(link.direction) ? link.direction : "none";
        colorsUsed.add(color);
        const selected = link.id === this.selectedLinkId;
        const markerId = `jn-arrow-${color.replace("#", "")}`;
        const dimmed = dimmedIds.has(note._id) || dimmedIds.has(link.targetId);
        const linkId = foundry.utils.escapeHTML(String(link.id ?? ""));

        const linkClasses = [link.hidden ? "jn-link-hidden" : "", link.hint ? "jn-link-hint" : ""].join(" ").trim();
        body += `<g data-id="${linkId}" class="${linkClasses}" opacity="${dimmed ? 0.15 : 1}">
          <path d="${d}" fill="none" stroke="${color}" stroke-width="${selected ? 3.5 : 2}"
            ${link.hidden ? 'stroke-dasharray="2 6" stroke-linecap="round"' : link.lineStyle === "dashed" ? 'stroke-dasharray="7 6"' : ""}
            ${direction !== "none" ? `marker-end="url(#${markerId})"` : ""}
            ${direction === "two" ? `marker-start="url(#${markerId})"` : ""}/>
          <path class="jn-link-hit" data-id="${linkId}" d="${d}"/>
          ${link.label || link.hint ? `<text class="jn-link-label" x="${mx}" y="${my + 4}">${link.hint ? "&#10022; " : ""}${foundry.utils.escapeHTML(link.label ?? "")}</text>` : ""}
        </g>`;

        this.linksById.set(link.id, { sourceId: note._id, targetId: link.targetId, mx, my, ...link });
      }
    }

    const defs = [...colorsUsed].map(color => `
      <marker id="jn-arrow-${color.replace("#", "")}" viewBox="0 0 10 10" refX="9" refY="5"
        markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0 0L10 5L0 10z" fill="${color}"/>
      </marker>`).join("");

    this.svg.innerHTML = `<defs>${defs}</defs>${body}`;
  }

  /** Limits expensive SVG rebuilds to one per animation-sized interval while dragging. */
  #queueLinkDraw() {
    if (this.linkDrawTimer !== null) return;
    this.linkDrawTimer = setTimeout(() => {
      this.linkDrawTimer = null;
      this.#drawLinks();
      this.#syncLinkToolbar();
    }, 16);
  }

  #flushLinkDraw() {
    if (this.linkDrawTimer !== null) clearTimeout(this.linkDrawTimer);
    this.linkDrawTimer = null;
    this.#drawLinks();
    this.#syncLinkToolbar();
  }

  #syncLinkToolbar() {
    const link = this.selectedLinkId ? this.linksById.get(this.selectedLinkId) : null;
    if (!link) { this.linkToolbar.style.display = "none"; return; }

    this.linkToolbar.style.left = `${link.mx * this.view.k + this.view.x}px`;
    this.linkToolbar.style.top = `${link.my * this.view.k + this.view.y}px`;
    this.linkToolbar.style.display = "flex";
    const currentColor = safeLinkColor(link.color);
    const direction = LINK_DIRECTIONS.has(link.direction) ? link.direction : "none";
    this.linkToolbar.innerHTML = `
      <input type="text" class="jn-link-label-input" placeholder="${t("JN.Link.Label")}" value="${foundry.utils.escapeHTML(link.label ?? "")}">
      <button type="button" class="jn-link-dir" title="${t("JN.Link.Direction")}">${{ none: "—", one: "→", two: "↔" }[direction]}</button>
      <span class="jn-link-colors">${LINK_COLORS.map(c => `<button type="button" class="jn-link-color${c === currentColor ? " on" : ""}" data-color="${c}" style="background:${c || LINK_DEFAULT_COLOR}"></button>`).join("")}</span>
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

  #startLinkPreview(sourceId, side) {
    this.previewSourceId = sourceId;
    this.previewSourceSide = side;
    this.previewPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    this.previewPath.setAttribute("class", "jn-link-preview");
    this.svg.appendChild(this.previewPath);
  }

  #updateLinkPreview(clientX, clientY) {
    if (!this.previewPath) return;
    const box = this.#cardBox(this.previewSourceId);
    const anchors = {
      top: { x: box.x + box.w / 2, y: box.y, nx: 0, ny: -1 },
      right: { x: box.x + box.w, y: box.y + box.h / 2, nx: 1, ny: 0 },
      bottom: { x: box.x + box.w / 2, y: box.y + box.h, nx: 0, ny: 1 },
      left: { x: box.x, y: box.y + box.h / 2, nx: -1, ny: 0 }
    };
    const start = anchors[this.previewSourceSide] ?? anchors.right;
    const { x, y } = this.#toWorld(clientX, clientY);
    const distance = Math.max(35, Math.hypot(x - start.x, y - start.y) * 0.3);
    const c1x = start.x + start.nx * distance;
    const c1y = start.y + start.ny * distance;
    this.previewPath.setAttribute("d", `M${start.x},${start.y} C${c1x},${c1y} ${x},${y} ${x},${y}`);
  }

  #endLinkPreview() {
    this.previewPath?.remove();
    this.previewPath = null;
    this.previewSourceId = null;
    this.previewSourceSide = null;
  }

  #setSelection(ids, primary = null) {
    this.selectedNoteIds = new Set(ids);
    this.selectedNoteId = primary;
    this.selectedLinkId = null;
    for (const [id, el] of this.cardEls) el.classList.toggle("selected", this.selectedNoteIds.has(id));
    this.#syncLinkToolbar();
    this.callbacks.onSelectNote(primary);
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
    const selected = drag.additive ? new Set(drag.initialIds) : new Set();
    for (const [id, el] of this.cardEls) {
      const box = el.getBoundingClientRect();
      if (box.right >= left && box.left <= right && box.bottom >= top && box.top <= bottom) selected.add(id);
    }
    const ids = [...selected];
    this.#setSelection(ids, ids.length === 1 ? ids[0] : null);
  }

  #closeContextMenu() {
    this.contextMenu.style.display = "none";
    this.contextMenu.innerHTML = "";
  }

  #openContextMenu(clientX, clientY) {
    const point = this.#toWorld(clientX, clientY);
    const gmItems = this.gmMode ? `
      <button type="button" data-action="secret-note">${t("JN.Context.NewSecretNote")}</button>
      <button type="button" data-action="gm-label">${t("JN.Context.NewGMLabel")}</button>` : "";
    this.contextMenu.innerHTML = `
      <button type="button" data-action="note">${t("JN.Context.NewNote")}</button>
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
        if (action === "note") this.callbacks.onCreateNoteAt(point.x - 95, point.y - 35, { kind: "note" });
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

    this.root.addEventListener("wheel", ev => {
      ev.preventDefault();
      this.#closeContextMenu();
      this.#zoomAt(ev.clientX, ev.clientY, this.view.k * Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });

    this.root.addEventListener("pointerdown", ev => {
      if (ev.target.closest(".jn-link-toolbar")) return;
      if (ev.target.closest(".jn-context-menu")) return;
      this.#closeContextMenu();
      if (ev.button === 2) return;
      try { this.root.setPointerCapture(ev.pointerId); } catch { /* no active pointer (e.g. synthetic event) */ }
      const cardEl = ev.target.closest(".jn-card");
      const resizeHandle = ev.target.closest(".jn-card-resize");
      const linkHandle = ev.target.closest(".jn-card-link");
      const labelEl = ev.target.closest(".jn-label");
      const linkHit = ev.target.closest(".jn-link-hit");

      // Middle mouse always pans, even when the pointer starts over a card, handle, or link.
      if (ev.button === 1) {
        ev.preventDefault();
        drag = { type: "pan", sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y, moved: 0 };
      } else if (ev.button !== 0) {
        return;
      } else if (resizeHandle) {
        const id = resizeHandle.closest(".jn-card").dataset.id;
        const el = this.cardEls.get(id);
        drag = { type: "resize", id, sx: ev.clientX, sy: ev.clientY, ow: el.offsetWidth, oh: el.offsetHeight, moved: 0 };
      } else if (linkHandle) {
        const id = linkHandle.closest(".jn-card").dataset.id;
        drag = { type: "link-create", sourceId: id, side: linkHandle.dataset.side, moved: 0 };
        this.#startLinkPreview(id, linkHandle.dataset.side);
        this.#updateLinkPreview(ev.clientX, ev.clientY);
      } else if (cardEl) {
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
          toggle: ev.ctrlKey || ev.metaKey, initialIds,
          sx: ev.clientX, sy: ev.clientY, moved: 0
        };
      } else if (labelEl) {
        const id = labelEl.dataset.id;
        const data = this.layout.labels?.[id] ?? { x: 0, y: 0 };
        drag = { type: "label", id, sx: ev.clientX, sy: ev.clientY, ox: data.x, oy: data.y, moved: 0 };
      } else if (linkHit) {
        drag = { type: "link", id: linkHit.dataset.id, sx: ev.clientX, sy: ev.clientY, moved: 0 };
      } else {
        drag = {
          type: "selection", sx: ev.clientX, sy: ev.clientY, moved: 0,
          additive: ev.ctrlKey || ev.metaKey, initialIds: [...this.selectedNoteIds]
        };
      }
    });

    this.root.addEventListener("pointermove", ev => {
      if (!drag) return;
      const dx = ev.clientX - (drag.sx ?? ev.clientX), dy = ev.clientY - (drag.sy ?? ev.clientY);
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));

      if (drag.type === "resize") {
        const el = this.cardEls.get(drag.id);
        const w = Math.max(130, drag.ow + dx / this.view.k);
        const h = Math.max(80, drag.oh + dy / this.view.k);
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.classList.add("jn-sized");
        this.#queueLinkDraw();
      } else if (drag.type === "card") {
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
        const el = this.labelEls.get(drag.id);
        const x = drag.ox + dx / this.view.k, y = drag.oy + dy / this.view.k;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      } else if (drag.type === "link-create") {
        this.#updateLinkPreview(ev.clientX, ev.clientY);
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

      if (drag.type === "card") {
        if (wasClick) {
          if (drag.toggle) {
            const ids = new Set(drag.initialIds ?? this.selectedNoteIds);
            if (ids.has(drag.id)) ids.delete(drag.id); else ids.add(drag.id);
            const next = [...ids];
            this.#setSelection(next, next.length === 1 ? next[0] : null);
          } else {
            this.#setSelection([drag.id], drag.id);
          }
        } else {
          for (const id of drag.ids) {
            const el = this.cardEls.get(id);
            this.callbacks.onMoveCard(id, parseFloat(el.style.left), parseFloat(el.style.top));
          }
        }
      } else if (drag.type === "resize" && !wasClick) {
        const el = this.cardEls.get(drag.id);
        this.callbacks.onResizeCard(drag.id, el.offsetWidth, el.offsetHeight);
      } else if (drag.type === "link-create") {
        this.#endLinkPreview();
        const targetEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".jn-card");
        if (targetEl && targetEl.dataset.id !== drag.sourceId) {
          this.callbacks.onCreateLink(drag.sourceId, targetEl.dataset.id);
        }
      } else if (drag.type === "label") {
        if (wasClick) {
          this.callbacks.onEditLabel(drag.id);
        } else {
          const el = this.labelEls.get(drag.id);
          this.callbacks.onMoveLabel(drag.id, parseFloat(el.style.left), parseFloat(el.style.top));
        }
      } else if (drag.type === "link" && wasClick) {
        const now = Date.now();
        if (this.lastLinkClick?.id === drag.id && now - this.lastLinkClick.at < 420) {
          const link = this.linksById.get(drag.id);
          if (link) this.callbacks.onDeleteLink(link.sourceId, link.id);
          this.lastLinkClick = null;
          this.selectedLinkId = null;
          this.#syncLinkToolbar();
        } else {
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
      }
      drag = null;
    };
    this.root.addEventListener("pointerup", finishDrag);
    this.root.addEventListener("pointercancel", finishDrag);

    this.root.addEventListener("contextmenu", ev => {
      ev.preventDefault();
      this.#openContextMenu(ev.clientX, ev.clientY);
    });
    this.root.addEventListener("auxclick", ev => {
      if (ev.button === 1) ev.preventDefault();
    });

    this.root.addEventListener("dblclick", ev => {
      if (ev.target.closest(".jn-card-resize")) {
        const cardEl = ev.target.closest(".jn-card");
        const id = cardEl.dataset.id;
        cardEl.style.width = "";
        cardEl.style.height = "";
        cardEl.classList.remove("jn-sized");
        this.callbacks.onResetCardSize(id);
        return;
      }
      const cardEl = ev.target.closest(".jn-card");
      if (cardEl && !ev.target.closest(".jn-card-link")) {
        ev.preventDefault();
        this.#setSelection([cardEl.dataset.id], cardEl.dataset.id);
        this.callbacks.onEditNote?.(cardEl.dataset.id);
      }
    });
  }

  addLabelButton() {
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
