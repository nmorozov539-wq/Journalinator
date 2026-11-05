import { CARD_STYLES } from "../styles/registry.mjs";
import { hasAnyLock } from "../locks.mjs";

const DRAG_THRESHOLD = 5;
const LINK_COLORS = ["", "#a393f2", "#d6a45c", "#d77b91"];
const LINK_DEFAULT_COLOR = "#8e8e9a";

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
    this.selectedLinkId = null;

    this.root = document.createElement("div");
    this.root.className = "jn-canvas";
    this.root.innerHTML = `
      <div class="jn-world">
        <svg class="jn-links"></svg>
      </div>
      <div class="jn-tooltip"></div>
      <div class="jn-link-toolbar"></div>
    `;
    this.world = this.root.querySelector(".jn-world");
    this.svg = this.root.querySelector(".jn-links");
    this.tooltip = this.root.querySelector(".jn-tooltip");
    this.linkToolbar = this.root.querySelector(".jn-link-toolbar");

    this.#bindPointerEvents();
  }

  update(notes, layout) {
    this.notes = notes;
    this.layout = layout ?? { cards: {}, labels: {} };

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
        <b class="jn-card-link" title="Drag to another card to link"></b>
        <b class="jn-card-resize"></b>
      `;
      this.world.appendChild(el);
      this.cardEls.set(note._id, el);
    }

    el.className = `jn-card ${styleDef.cssClass}`;
    el.classList.toggle("selected", note._id === this.selectedNoteId);
    el.classList.toggle("jn-being-edited", hasAnyLock(note._id));
    el.style.left = `${cardData.x}px`;
    el.style.top = `${cardData.y}px`;
    el.style.setProperty("--jn-rotation", `${cardData.rotation ?? 0}deg`);
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
      image.style.backgroundImage = `url("${note.system.image}")`;
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
    return { x: data.x, y: data.y, w: el?.offsetWidth ?? 190, h: el?.offsetHeight ?? 70 };
  }

  #drawLinks() {
    this.linksById = new Map();
    const colorsUsed = new Set();
    let body = "";

    for (const note of this.notes) {
      for (const link of note.system.links ?? []) {
        if (!this.cardEls.has(note._id) || !this.cardEls.has(link.targetId)) continue;
        const a = this.#cardBox(note._id), b = this.#cardBox(link.targetId);
        const p = this.#anchor(a, b), r = this.#anchor(b, a);
        const o = Math.max(40, Math.hypot(p.x - r.x, p.y - r.y) * 0.35);
        const c1 = [p.x + p.nx * o, p.y + p.ny * o], c2 = [r.x + r.nx * o, r.y + r.ny * o];
        const d = `M${p.x},${p.y} C${c1} ${c2} ${r.x},${r.y}`;
        const mx = (p.x + 3 * c1[0] + 3 * c2[0] + r.x) / 8, my = (p.y + 3 * c1[1] + 3 * c2[1] + r.y) / 8;
        const color = link.color || LINK_DEFAULT_COLOR;
        colorsUsed.add(color);
        const selected = link.id === this.selectedLinkId;
        const markerId = `jn-arrow-${color.replace("#", "")}`;

        body += `<g data-id="${link.id}">
          <path d="${d}" fill="none" stroke="${color}" stroke-width="${selected ? 3.5 : 2}"
            ${link.lineStyle === "dashed" ? 'stroke-dasharray="7 6"' : ""}
            ${link.direction !== "none" ? `marker-end="url(#${markerId})"` : ""}
            ${link.direction === "two" ? `marker-start="url(#${markerId})"` : ""}/>
          <path class="jn-link-hit" data-id="${link.id}" d="${d}"/>
          ${link.label ? `<text class="jn-link-label" x="${mx}" y="${my + 4}">${foundry.utils.escapeHTML(link.label)}</text>` : ""}
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

  #syncLinkToolbar() {
    const link = this.selectedLinkId ? this.linksById.get(this.selectedLinkId) : null;
    if (!link) { this.linkToolbar.style.display = "none"; return; }

    this.linkToolbar.style.left = `${link.mx * this.view.k + this.view.x}px`;
    this.linkToolbar.style.top = `${link.my * this.view.k + this.view.y}px`;
    this.linkToolbar.style.display = "flex";
    this.linkToolbar.innerHTML = `
      <input type="text" class="jn-link-label-input" placeholder="Label" value="${foundry.utils.escapeHTML(link.label ?? "")}">
      <button type="button" class="jn-link-dir" title="Direction">${{ none: "—", one: "→", two: "↔" }[link.direction]}</button>
      <span class="jn-link-colors">${LINK_COLORS.map(c => `<button type="button" class="jn-link-color${c === (link.color || "") ? " on" : ""}" data-color="${c}" style="background:${c || LINK_DEFAULT_COLOR}"></button>`).join("")}</span>
      <button type="button" class="jn-link-dash" title="Line style">${link.lineStyle === "dashed" ? "┄┄" : "──"}</button>
      <button type="button" class="jn-link-delete" title="Delete link">✕</button>
    `;

    const update = fields => this.callbacks.onUpdateLink(link.sourceId, link.id, fields);
    this.linkToolbar.querySelector(".jn-link-label-input").oninput = ev => update({ label: ev.target.value });
    this.linkToolbar.querySelector(".jn-link-dir").onclick = () =>
      update({ direction: { none: "one", one: "two", two: "none" }[link.direction] });
    this.linkToolbar.querySelectorAll(".jn-link-color").forEach(btn => {
      btn.onclick = () => update({ color: btn.dataset.color });
    });
    this.linkToolbar.querySelector(".jn-link-dash").onclick = () =>
      update({ lineStyle: link.lineStyle === "dashed" ? "solid" : "dashed" });
    this.linkToolbar.querySelector(".jn-link-delete").onclick = () => {
      this.callbacks.onDeleteLink(link.sourceId, link.id);
      this.selectedLinkId = null;
      this.linkToolbar.style.display = "none";
    };
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

  #startLinkPreview(sourceId) {
    this.previewSourceId = sourceId;
    this.previewPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    this.previewPath.setAttribute("class", "jn-link-preview");
    this.svg.appendChild(this.previewPath);
  }

  #updateLinkPreview(clientX, clientY) {
    if (!this.previewPath) return;
    const box = this.#cardBox(this.previewSourceId);
    const sx = box.x + box.w / 2, sy = box.y + box.h / 2;
    const { x, y } = this.#toWorld(clientX, clientY);
    this.previewPath.setAttribute("d", `M${sx},${sy} L${x},${y}`);
  }

  #endLinkPreview() {
    this.previewPath?.remove();
    this.previewPath = null;
    this.previewSourceId = null;
  }

  #bindPointerEvents() {
    let drag = null;

    this.root.addEventListener("wheel", ev => {
      ev.preventDefault();
      this.#zoomAt(ev.clientX, ev.clientY, this.view.k * Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });

    this.root.addEventListener("pointerdown", ev => {
      if (ev.target.closest(".jn-link-toolbar")) return;
      try { this.root.setPointerCapture(ev.pointerId); } catch { /* no active pointer (e.g. synthetic event) */ }
      const cardEl = ev.target.closest(".jn-card");
      const resizeHandle = ev.target.closest(".jn-card-resize");
      const linkHandle = ev.target.closest(".jn-card-link");
      const labelEl = ev.target.closest(".jn-label");
      const linkHit = ev.target.closest(".jn-link-hit");

      if (resizeHandle) {
        const id = resizeHandle.closest(".jn-card").dataset.id;
        const el = this.cardEls.get(id);
        drag = { type: "resize", id, sx: ev.clientX, sy: ev.clientY, ow: el.offsetWidth, oh: el.offsetHeight, moved: 0 };
      } else if (linkHandle) {
        const id = linkHandle.closest(".jn-card").dataset.id;
        drag = { type: "link-create", sourceId: id, moved: 0 };
        this.#startLinkPreview(id);
        this.#updateLinkPreview(ev.clientX, ev.clientY);
      } else if (cardEl) {
        const id = cardEl.dataset.id;
        const card = this.layout.cards?.[id] ?? { x: 0, y: 0 };
        drag = { type: "card", id, sx: ev.clientX, sy: ev.clientY, ox: card.x, oy: card.y, moved: 0 };
      } else if (labelEl) {
        const id = labelEl.dataset.id;
        const data = this.layout.labels?.[id] ?? { x: 0, y: 0 };
        drag = { type: "label", id, sx: ev.clientX, sy: ev.clientY, ox: data.x, oy: data.y, moved: 0 };
      } else if (linkHit) {
        drag = { type: "link", id: linkHit.dataset.id, sx: ev.clientX, sy: ev.clientY, moved: 0 };
      } else {
        drag = { type: "pan", sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y, moved: 0 };
      }
    });

    this.root.addEventListener("pointermove", ev => {
      if (!drag) {
        const cardEl = ev.target.closest(".jn-card");
        this.#showTooltip(cardEl ? cardEl.dataset.id : null, ev.clientX, ev.clientY);
        return;
      }
      const dx = ev.clientX - (drag.sx ?? ev.clientX), dy = ev.clientY - (drag.sy ?? ev.clientY);
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));

      if (drag.type === "resize") {
        const el = this.cardEls.get(drag.id);
        const w = Math.max(130, drag.ow + dx / this.view.k);
        const h = Math.max(80, drag.oh + dy / this.view.k);
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.classList.add("jn-sized");
      } else if (drag.type === "card") {
        const el = this.cardEls.get(drag.id);
        const x = drag.ox + dx / this.view.k, y = drag.oy + dy / this.view.k;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        this.#drawLinks();
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
      }
    });

    const finishDrag = ev => {
      if (!drag) return;
      const wasClick = drag.moved <= DRAG_THRESHOLD;

      if (drag.type === "card") {
        if (wasClick) {
          this.selectedNoteId = drag.id;
          this.selectedLinkId = null;
          this.callbacks.onSelectNote(drag.id);
        } else {
          const el = this.cardEls.get(drag.id);
          this.callbacks.onMoveCard(drag.id, parseFloat(el.style.left), parseFloat(el.style.top));
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
        this.selectedLinkId = drag.id;
        this.selectedNoteId = null;
        this.callbacks.onSelectNote(null);
        this.#syncLinkToolbar();
      } else if (drag.type === "pan" && wasClick) {
        this.selectedNoteId = null;
        this.selectedLinkId = null;
        this.callbacks.onSelectNote(null);
        this.#syncLinkToolbar();
      }
      drag = null;
    };
    this.root.addEventListener("pointerup", finishDrag);
    this.root.addEventListener("pointercancel", finishDrag);

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
      if (ev.target === this.root || ev.target === this.world) {
        const { x, y } = this.#toWorld(ev.clientX, ev.clientY);
        this.callbacks.onCreateNoteAt(x - 95, y - 35);
      }
    });
  }

  #showTooltip(noteId, clientX, clientY) {
    if (!noteId) { this.tooltip.style.display = "none"; return; }
    const note = this.notes?.find(n => n._id === noteId);
    if (!note) { this.tooltip.style.display = "none"; return; }
    const author = game.users.get(note.system.authorId);
    const text = note.system.blocks.map(b => b.text).join(" ");
    this.tooltip.innerHTML = `<b>${foundry.utils.escapeHTML(note.name)}</b><div>${foundry.utils.escapeHTML(text)}</div><div class="jn-tooltip-by">by ${foundry.utils.escapeHTML(author?.name ?? "unknown")}</div>`;
    const rect = this.root.getBoundingClientRect();
    this.tooltip.style.display = "block";
    let left = clientX - rect.left + 16;
    if (left + this.tooltip.offsetWidth > rect.width) left = clientX - rect.left - this.tooltip.offsetWidth - 16;
    this.tooltip.style.left = `${Math.max(6, left)}px`;
    this.tooltip.style.top = `${Math.max(6, clientY - rect.top)}px`;
  }

  addLabelButton() {
    const rect = this.root.getBoundingClientRect();
    const { x, y } = this.#toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    this.callbacks.onAddLabelAt(x, y);
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
    this.selectedNoteId = noteId;
    this.selectedLinkId = null;
    this.callbacks.onSelectNote(noteId);
  }
}
