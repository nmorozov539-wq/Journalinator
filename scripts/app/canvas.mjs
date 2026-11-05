import { CARD_STYLES } from "../styles/registry.mjs";

const DRAG_THRESHOLD = 5;

/**
 * The note canvas: pan/zoom viewport, absolutely-positioned cards and free text labels.
 * Owns its own DOM subtree and pan/zoom state persistently — JournalApp re-renders its chrome
 * on every document-sync hook, but this instance is created once and just has its contents
 * refreshed via update(), so panning/zooming never resets because someone else edited a note.
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
    this.selectedNoteId = null;

    this.root = document.createElement("div");
    this.root.className = "jn-canvas";
    this.root.innerHTML = `
      <div class="jn-world">
        <svg class="jn-links"></svg>
      </div>
      <div class="jn-tooltip"></div>
    `;
    this.world = this.root.querySelector(".jn-world");
    this.tooltip = this.root.querySelector(".jn-tooltip");

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
        <b class="jn-card-resize"></b>
      `;
      this.world.appendChild(el);
      this.cardEls.set(note._id, el);
    }

    el.className = `jn-card ${styleDef.cssClass}`;
    el.classList.toggle("selected", note._id === this.selectedNoteId);
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
  }

  #toWorld(clientX, clientY) {
    const rect = this.root.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.view.x) / this.view.k,
      y: (clientY - rect.top - this.view.y) / this.view.k
    };
  }

  #bindPointerEvents() {
    let drag = null;

    this.root.addEventListener("wheel", ev => {
      ev.preventDefault();
      this.#zoomAt(ev.clientX, ev.clientY, this.view.k * Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });

    this.root.addEventListener("pointerdown", ev => {
      if (ev.target.closest(".jn-canvas-toolbar")) return;
      try { this.root.setPointerCapture(ev.pointerId); } catch { /* no active pointer (e.g. synthetic event) */ }
      const cardEl = ev.target.closest(".jn-card");
      const resizeHandle = ev.target.closest(".jn-card-resize");
      const labelEl = ev.target.closest(".jn-label");

      if (resizeHandle) {
        const id = resizeHandle.closest(".jn-card").dataset.id;
        const el = this.cardEls.get(id);
        drag = { type: "resize", id, sx: ev.clientX, sy: ev.clientY, ow: el.offsetWidth, oh: el.offsetHeight, moved: 0 };
      } else if (cardEl) {
        const id = cardEl.dataset.id;
        const card = this.layout.cards?.[id] ?? { x: 0, y: 0 };
        drag = { type: "card", id, sx: ev.clientX, sy: ev.clientY, ox: card.x, oy: card.y, moved: 0 };
      } else if (labelEl) {
        const id = labelEl.dataset.id;
        const data = this.layout.labels?.[id] ?? { x: 0, y: 0 };
        drag = { type: "label", id, sx: ev.clientX, sy: ev.clientY, ox: data.x, oy: data.y, moved: 0 };
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
      const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
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
      } else if (drag.type === "label") {
        const el = this.labelEls.get(drag.id);
        const x = drag.ox + dx / this.view.k, y = drag.oy + dy / this.view.k;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      } else if (drag.type === "pan" && drag.moved > DRAG_THRESHOLD) {
        this.view.x = drag.vx + dx;
        this.view.y = drag.vy + dy;
        this.#applyTransform();
      }
    });

    const finishDrag = ev => {
      if (!drag) return;
      const wasClick = drag.moved <= DRAG_THRESHOLD;

      if (drag.type === "card") {
        if (wasClick) {
          this.selectedNoteId = drag.id;
          this.callbacks.onSelectNote(drag.id);
        } else {
          const el = this.cardEls.get(drag.id);
          this.callbacks.onMoveCard(drag.id, parseFloat(el.style.left), parseFloat(el.style.top));
        }
      } else if (drag.type === "resize" && !wasClick) {
        const el = this.cardEls.get(drag.id);
        this.callbacks.onResizeCard(drag.id, el.offsetWidth, el.offsetHeight);
      } else if (drag.type === "label") {
        if (wasClick) {
          this.callbacks.onEditLabel(drag.id);
        } else {
          const el = this.labelEls.get(drag.id);
          this.callbacks.onMoveLabel(drag.id, parseFloat(el.style.left), parseFloat(el.style.top));
        }
      } else if (drag.type === "pan" && wasClick) {
        this.selectedNoteId = null;
        this.callbacks.onSelectNote(null);
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
}
