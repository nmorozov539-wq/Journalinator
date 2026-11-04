const MODULE_ID = "investigation-board";
const SOCKET = `module.${MODULE_ID}`;
const STATE_KEY = "boardState";
let boardInstance = null;

const TYPES = {
  note: { icon: "fa-note-sticky", color: "#f4d06f" },
  clue: { icon: "fa-magnifying-glass", color: "#e56b6f" },
  person: { icon: "fa-user", color: "#6fb1e5" },
  location: { icon: "fa-location-dot", color: "#76c893" },
  image: { icon: "fa-image", color: "#ad8de3" }
};

const clone = value => {
  if (globalThis.structuredClone) return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function defaultState() {
  return {
    schema: 1,
    revision: 0,
    boards: [{ id: uid(), name: game?.i18n?.localize("IB.DefaultBoard") || "First investigation", cards: [], links: [] }]
  };
}

function normalizeState(source) {
  const input = source && typeof source === "object" ? clone(source) : {};
  const state = {
    schema: 1,
    revision: Number.isFinite(input.revision) ? input.revision : 0,
    boards: Array.isArray(input.boards) ? input.boards.slice(0, 100) : []
  };

  state.boards = state.boards.map(board => ({
    id: String(board.id || uid()),
    name: String(board.name || "Investigation").slice(0, 120),
    cards: (Array.isArray(board.cards) ? board.cards : []).slice(0, 2000).map(card => ({
      id: String(card.id || uid()),
      type: Object.hasOwn(TYPES, card.type) ? card.type : "note",
      title: String(card.title || "").slice(0, 200),
      text: String(card.text || "").slice(0, 20000),
      imageUrl: String(card.imageUrl || "").slice(0, 4000),
      color: /^#[0-9a-f]{6}$/i.test(card.color) ? card.color : TYPES.note.color,
      x: Number.isFinite(card.x) ? card.x : 0,
      y: Number.isFinite(card.y) ? card.y : 0,
      width: clamp(Number(card.width) || 260, 180, 800),
      height: clamp(Number(card.height) || 190, 120, 800),
      authorId: String(card.authorId || ""),
      authorName: String(card.authorName || "").slice(0, 120),
      authorColor: String(card.authorColor || "#8a817c").slice(0, 40),
      createdAt: Number(card.createdAt) || Date.now(),
      updatedAt: Number(card.updatedAt) || Date.now()
    })),
    links: (Array.isArray(board.links) ? board.links : []).slice(0, 4000).map(link => ({
      id: String(link.id || uid()),
      from: String(link.from || ""),
      to: String(link.to || ""),
      color: /^#[0-9a-f]{6}$/i.test(link.color) ? link.color : "#c9b79c"
    }))
  }));

  if (!state.boards.length) state.boards = defaultState().boards;
  for (const board of state.boards) {
    const ids = new Set(board.cards.map(card => card.id));
    board.links = board.links.filter(link => ids.has(link.from) && ids.has(link.to) && link.from !== link.to);
  }
  return state;
}

class InvestigationBoard {
  constructor() {
    this.state = normalizeState(game.settings.get(MODULE_ID, STATE_KEY));
    this.storageKey = `${MODULE_ID}.${game.world.id}.activeBoard`;
    this.windowStorageKey = `${MODULE_ID}.${game.world.id}.window`;
    this.activeBoardId = localStorage.getItem(this.storageKey) || this.state.boards[0].id;
    this.views = new Map();
    this.tool = "select";
    this.selectedCardId = null;
    this.linkStartId = null;
    this.search = "";
    this.element = null;
    this.saveChain = Promise.resolve();
    this.isOpen = false;
  }

  t(key) {
    return game.i18n.localize(key);
  }

  get board() {
    return this.state.boards.find(board => board.id === this.activeBoardId) || this.state.boards[0];
  }

  get view() {
    if (!this.views.has(this.board.id)) this.views.set(this.board.id, { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 });
    return this.views.get(this.board.id);
  }

  get authority() {
    return game.users
      .filter(user => user.active && user.isGM)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
  }

  get isAuthority() {
    return this.authority?.id === game.user.id;
  }

  get canEdit() {
    return game.user.isGM || game.settings.get(MODULE_ID, "allowPlayers");
  }

  initialize() {
    this.createApp();
    game.socket.on(SOCKET, packet => this.onSocket(packet));
    game.socket.emit(SOCKET, { type: "request-state", userId: game.user.id });
    if (this.isAuthority) this.persistAndBroadcast();

    window.addEventListener("keydown", event => this.onKeyDown(event));
    Hooks.on("userConnected", () => {
      if (this.isAuthority) setTimeout(() => this.broadcastState(), 350);
    });
  }

  createApp() {
    if (this.element) return;
    const app = document.createElement("section");
    app.id = "investigation-board-app";
    app.className = "ib-app";
    app.setAttribute("aria-hidden", "true");
    app.innerHTML = `
      <header class="ib-topbar">
        <div class="ib-brand"><i class="fa-solid fa-diagram-project"></i><strong>${esc(this.t("IB.Title"))}</strong></div>
        <select class="ib-board-select" aria-label="${esc(this.t("IB.Title"))}"></select>
        <div class="ib-board-admin">
          <button type="button" data-action="new-board" title="${esc(this.t("IB.NewBoard"))}"><i class="fa-solid fa-plus"></i></button>
          <button type="button" data-action="rename-board" title="${esc(this.t("IB.RenameBoard"))}"><i class="fa-solid fa-pen"></i></button>
          <button type="button" data-action="delete-board" title="${esc(this.t("IB.DeleteBoard"))}"><i class="fa-solid fa-trash"></i></button>
        </div>
        <label class="ib-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" placeholder="${esc(this.t("IB.Search"))}"></label>
        <span class="ib-sync" data-status="ready"><i class="fa-solid fa-cloud"></i><span>${esc(this.t("IB.Saved"))}</span></span>
        <button type="button" data-action="export" title="${esc(this.t("IB.Export"))}"><i class="fa-solid fa-download"></i></button>
        <button type="button" data-action="import" title="${esc(this.t("IB.Import"))}"><i class="fa-solid fa-upload"></i></button>
        <button type="button" class="ib-close" data-action="close" title="${esc(this.t("IB.Close"))}"><i class="fa-solid fa-xmark"></i></button>
        <input class="ib-import-input" type="file" accept="application/json,.json" hidden>
      </header>
      <aside class="ib-toolbar" aria-label="Tools">
        ${this.toolButton("select", "fa-arrow-pointer", "IB.Select")}
        <span class="ib-divider"></span>
        ${this.toolButton("note", "fa-note-sticky", "IB.Note")}
        ${this.toolButton("clue", "fa-magnifying-glass", "IB.Clue")}
        ${this.toolButton("person", "fa-user", "IB.Person")}
        ${this.toolButton("location", "fa-location-dot", "IB.Location")}
        ${this.toolButton("image", "fa-image", "IB.Image")}
        <span class="ib-divider"></span>
        ${this.toolButton("link", "fa-link", "IB.Link")}
        <button type="button" data-action="fit" title="${esc(this.t("IB.Fit"))}"><i class="fa-solid fa-expand"></i></button>
        <button type="button" data-action="zoom-in" title="${esc(this.t("IB.ZoomIn"))}"><i class="fa-solid fa-plus"></i></button>
        <button type="button" data-action="zoom-out" title="${esc(this.t("IB.ZoomOut"))}"><i class="fa-solid fa-minus"></i></button>
      </aside>
      <main class="ib-viewport">
        <div class="ib-world"><svg class="ib-links" viewBox="-50000 -50000 100000 100000" preserveAspectRatio="none" aria-hidden="true"></svg><div class="ib-cards"></div></div>
        <div class="ib-empty"></div>
        <div class="ib-help">${esc(this.t("IB.ShortHelp"))}</div>
        <div class="ib-zoom-label">100%</div>
      </main>
      <div class="ib-modal-layer"></div>`;
    document.body.append(app);
    this.element = app;
    this.restoreWindowGeometry();
    this.bindEvents();
    this.render();
  }

  toolButton(tool, icon, label) {
    return `<button type="button" data-tool="${tool}" title="${esc(this.t(label))}"><i class="fa-solid ${icon}"></i></button>`;
  }

  bindEvents() {
    this.element.addEventListener("click", event => this.onClick(event));
    this.element.addEventListener("dblclick", event => this.onDoubleClick(event));
    this.element.addEventListener("pointerdown", event => this.onPointerDown(event));
    const viewport = this.element.querySelector(".ib-viewport");
    viewport.addEventListener("wheel", event => this.onWheel(event), { passive: false });
    viewport.addEventListener("contextmenu", event => event.preventDefault());
    this.element.querySelector(".ib-topbar").addEventListener("pointerdown", event => this.startWindowDrag(event));
    this.element.querySelector(".ib-board-select").addEventListener("change", event => this.switchBoard(event.target.value));
    this.element.querySelector(".ib-search input").addEventListener("input", event => {
      this.search = event.target.value.trim().toLocaleLowerCase();
      this.renderBoard();
    });
    this.element.querySelector(".ib-import-input").addEventListener("change", event => this.importFile(event));
    const resizeObserver = new ResizeObserver(() => {
      if (this.isOpen) this.saveWindowGeometry();
    });
    resizeObserver.observe(this.element);
  }

  restoreWindowGeometry() {
    let geometry = null;
    try { geometry = JSON.parse(localStorage.getItem(this.windowStorageKey)); } catch (_error) { /* Ignore invalid client data. */ }
    const width = clamp(Number(geometry?.width) || Math.min(1180, window.innerWidth - 100), 720, window.innerWidth - 20);
    const height = clamp(Number(geometry?.height) || Math.min(780, window.innerHeight - 100), 520, window.innerHeight - 20);
    const left = clamp(Number(geometry?.left) || (window.innerWidth - width) / 2, 0, window.innerWidth - width);
    const top = clamp(Number(geometry?.top) || (window.innerHeight - height) / 2, 0, window.innerHeight - height);
    Object.assign(this.element.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  }

  saveWindowGeometry() {
    const rect = this.element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    localStorage.setItem(this.windowStorageKey, JSON.stringify({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }));
  }

  startWindowDrag(event) {
    if (event.button !== 0 || event.target.closest("button,select,input,label")) return;
    event.preventDefault();
    const rect = this.element.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    this.element.classList.add("is-window-dragging");
    const move = moveEvent => {
      const left = clamp(start.left + moveEvent.clientX - start.x, 0, Math.max(0, window.innerWidth - 90));
      const top = clamp(start.top + moveEvent.clientY - start.y, 0, Math.max(0, window.innerHeight - 58));
      this.element.style.left = `${left}px`;
      this.element.style.top = `${top}px`;
    };
    const up = () => {
      this.element.classList.remove("is-window-dragging");
      window.removeEventListener("pointermove", move);
      this.saveWindowGeometry();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }

  toggle(force) {
    const open = force ?? !this.isOpen;
    this.isOpen = open;
    this.element.classList.toggle("is-open", open);
    this.element.setAttribute("aria-hidden", String(!open));
    if (open) {
      this.restoreWindowGeometry();
      this.render();
      requestAnimationFrame(() => this.applyTransform());
    }
  }

  render() {
    if (!this.state.boards.some(board => board.id === this.activeBoardId)) this.activeBoardId = this.state.boards[0].id;
    this.renderBoardOptions();
    this.renderBoard();
    this.updateTools();
    this.element.querySelector("[data-action='import']").hidden = !game.user.isGM;
    this.element.querySelector(".ib-board-admin").hidden = !game.user.isGM;
  }

  renderBoardOptions() {
    const select = this.element.querySelector(".ib-board-select");
    select.innerHTML = this.state.boards.map(board => `<option value="${esc(board.id)}" ${board.id === this.board.id ? "selected" : ""}>${esc(board.name)}</option>`).join("");
  }

  renderBoard() {
    if (!this.element) return;
    const cardsRoot = this.element.querySelector(".ib-cards");
    const linksRoot = this.element.querySelector(".ib-links");
    const showAuthors = game.settings.get(MODULE_ID, "showAuthors");
    const visible = new Set();

    cardsRoot.innerHTML = this.board.cards.map(card => {
      const haystack = `${card.title} ${card.text} ${card.authorName}`.toLocaleLowerCase();
      const matches = !this.search || haystack.includes(this.search);
      if (matches) visible.add(card.id);
      const type = TYPES[card.type] || TYPES.note;
      const image = card.type === "image" && card.imageUrl
        ? `<div class="ib-card-image"><img src="${esc(card.imageUrl)}" alt="${esc(card.title)}" loading="lazy"></div>` : "";
      return `<article class="ib-card ib-type-${card.type} ${this.selectedCardId === card.id ? "is-selected" : ""} ${matches ? "" : "is-filtered"}"
        data-card-id="${esc(card.id)}" style="left:${card.x}px;top:${card.y}px;width:${card.width}px;height:${card.height}px;--card-color:${esc(card.color)}">
        <header class="ib-card-handle">
          <span class="ib-type-icon"><i class="fa-solid ${type.icon}"></i></span>
          <strong>${esc(card.title || this.t("IB.Untitled"))}</strong>
          <button type="button" data-action="edit-card" title="${esc(this.t("IB.EditCard"))}"><i class="fa-solid fa-pen"></i></button>
        </header>
        ${image}
        <div class="ib-card-text">${esc(card.text)}</div>
        ${showAuthors && card.authorName ? `<footer><span style="--author-color:${esc(card.authorColor)}">${esc(card.authorName)}</span></footer>` : ""}
        <button type="button" class="ib-resize" data-resize title="Resize"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button>
      </article>`;
    }).join("");

    linksRoot.innerHTML = this.board.links.map(link => {
      if (this.search && (!visible.has(link.from) || !visible.has(link.to))) return "";
      const from = this.board.cards.find(card => card.id === link.from);
      const to = this.board.cards.find(card => card.id === link.to);
      if (!from || !to) return "";
      return `<line data-link-id="${esc(link.id)}" x1="${from.x + from.width / 2}" y1="${from.y + from.height / 2}" x2="${to.x + to.width / 2}" y2="${to.y + to.height / 2}" style="--link-color:${esc(link.color)}"></line>`;
    }).join("");

    const empty = this.element.querySelector(".ib-empty");
    empty.textContent = this.t("IB.Empty");
    empty.hidden = this.board.cards.length > 0;
    this.applyTransform();
  }

  renderEdges() {
    const links = this.element.querySelectorAll(".ib-links line");
    for (const line of links) {
      const link = this.board.links.find(entry => entry.id === line.dataset.linkId);
      const from = this.board.cards.find(card => card.id === link?.from);
      const to = this.board.cards.find(card => card.id === link?.to);
      if (!from || !to) continue;
      line.setAttribute("x1", from.x + from.width / 2);
      line.setAttribute("y1", from.y + from.height / 2);
      line.setAttribute("x2", to.x + to.width / 2);
      line.setAttribute("y2", to.y + to.height / 2);
    }
  }

  applyTransform() {
    if (!this.element) return;
    const view = this.view;
    this.element.querySelector(".ib-world").style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    const viewport = this.element.querySelector(".ib-viewport");
    viewport.style.setProperty("--grid-size", `${24 * view.zoom}px`);
    viewport.style.setProperty("--grid-x", `${view.x}px`);
    viewport.style.setProperty("--grid-y", `${view.y}px`);
    viewport.classList.toggle("is-far-zoom", view.zoom < 0.55);
    this.element.querySelector(".ib-zoom-label").textContent = `${Math.round(view.zoom * 100)}%`;
  }

  updateTools() {
    this.element.querySelectorAll("[data-tool]").forEach(button => button.classList.toggle("is-active", button.dataset.tool === this.tool));
    this.element.querySelector(".ib-viewport").dataset.tool = this.tool;
  }

  setTool(tool) {
    if (!this.canEdit && tool !== "select") {
      ui.notifications.warn(this.t("IB.ReadOnly"));
      return;
    }
    this.tool = tool;
    this.linkStartId = null;
    this.updateTools();
    if (tool === "link") ui.notifications.info(this.t("IB.LinkFirst"));
  }

  onClick(event) {
    if (event.target.closest(".ib-modal-layer.is-visible")) return;
    const link = event.target.closest("[data-link-id]");
    if (link) {
      if (this.canEdit && confirm(this.t("IB.ConfirmDeleteLink"))) {
        this.commit({ type: "delete-link", boardId: this.board.id, linkId: link.dataset.linkId });
      }
      return;
    }
    const toolButton = event.target.closest("[data-tool]");
    if (toolButton) return this.setTool(toolButton.dataset.tool);

    const actionButton = event.target.closest("[data-action]");
    if (actionButton) {
      const action = actionButton.dataset.action;
      const cardId = actionButton.closest("[data-card-id]")?.dataset.cardId;
      if (action === "close") return this.toggle(false);
      if (action === "new-board") return this.newBoard();
      if (action === "rename-board") return this.renameBoard();
      if (action === "delete-board") return this.deleteBoard();
      if (action === "export") return this.exportState();
      if (action === "import") return this.element.querySelector(".ib-import-input").click();
      if (action === "fit") return this.fitToContent();
      if (action === "zoom-in") return this.zoomAt(1.2);
      if (action === "zoom-out") return this.zoomAt(1 / 1.2);
      if (action === "edit-card" && cardId) return this.openEditor(cardId);
    }

    const card = event.target.closest("[data-card-id]");
    if (!card) {
      this.selectedCardId = null;
      this.renderBoard();
      return;
    }
    const cardId = card.dataset.cardId;
    if (this.tool === "link") return this.handleLinkClick(cardId);
    this.selectedCardId = cardId;
    this.renderBoard();
  }

  onDoubleClick(event) {
    const card = event.target.closest(".ib-card");
    if (card && !event.target.closest("button")) return this.openEditor(card.dataset.cardId);
    if (!event.target.closest(".ib-viewport")) return;
    if (!this.canEdit) return ui.notifications.warn(this.t("IB.ReadOnly"));
    this.addCard("note", this.screenToWorld(event.clientX, event.clientY), true);
  }

  onPointerDown(event) {
    const viewport = event.target.closest(".ib-viewport");
    if (event.button === 2 && viewport) {
      event.preventDefault();
      return this.startPan(event);
    }
    if (event.button !== 0) return;
    if (this.tool === "link" && event.target.closest(".ib-card")) return;
    const resize = event.target.closest("[data-resize]");
    if (resize) return this.startResize(event, resize.closest("[data-card-id]").dataset.cardId);
    const handle = event.target.closest(".ib-card-handle");
    if (handle && !event.target.closest("button")) return this.startCardDrag(event, handle.closest("[data-card-id]").dataset.cardId);
    if (event.target.closest(".ib-card") || !event.target.closest(".ib-viewport")) return;

    if (Object.hasOwn(TYPES, this.tool)) {
      if (!this.canEdit) return ui.notifications.warn(this.t("IB.ReadOnly"));
      this.addCard(this.tool, this.screenToWorld(event.clientX, event.clientY), true);
      this.setTool("select");
      return;
    }
    this.startPan(event);
  }

  startPan(event) {
    event.preventDefault();
    const view = this.view;
    const start = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    this.element.classList.add("is-panning");
    const move = moveEvent => {
      view.x = start.vx + moveEvent.clientX - start.x;
      view.y = start.vy + moveEvent.clientY - start.y;
      this.applyTransform();
    };
    const up = () => {
      this.element.classList.remove("is-panning");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }

  startCardDrag(event, cardId) {
    if (!this.canEdit) return;
    event.preventDefault();
    event.stopPropagation();
    const card = this.board.cards.find(entry => entry.id === cardId);
    const node = this.element.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
    if (!card || !node) return;
    this.selectedCardId = cardId;
    node.classList.add("is-dragging", "is-selected");
    const start = { x: event.clientX, y: event.clientY, cx: card.x, cy: card.y };
    const move = moveEvent => {
      card.x = start.cx + (moveEvent.clientX - start.x) / this.view.zoom;
      card.y = start.cy + (moveEvent.clientY - start.y) / this.view.zoom;
      node.style.left = `${card.x}px`;
      node.style.top = `${card.y}px`;
      this.renderEdges();
    };
    const up = () => {
      node.classList.remove("is-dragging");
      window.removeEventListener("pointermove", move);
      this.commit({ type: "update-card", boardId: this.board.id, cardId, patch: { x: card.x, y: card.y } }, false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }

  startResize(event, cardId) {
    if (!this.canEdit) return;
    event.preventDefault();
    event.stopPropagation();
    const card = this.board.cards.find(entry => entry.id === cardId);
    const node = this.element.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
    if (!card || !node) return;
    const start = { x: event.clientX, y: event.clientY, width: card.width, height: card.height };
    const move = moveEvent => {
      card.width = clamp(start.width + (moveEvent.clientX - start.x) / this.view.zoom, 180, 800);
      card.height = clamp(start.height + (moveEvent.clientY - start.y) / this.view.zoom, 120, 800);
      node.style.width = `${card.width}px`;
      node.style.height = `${card.height}px`;
      this.renderEdges();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      this.commit({ type: "update-card", boardId: this.board.id, cardId, patch: { width: card.width, height: card.height } }, false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }

  onWheel(event) {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0012);
    this.zoomAt(factor, event.clientX, event.clientY);
  }

  zoomAt(factor, clientX, clientY) {
    const viewport = this.element.querySelector(".ib-viewport").getBoundingClientRect();
    const sx = (clientX ?? viewport.left + viewport.width / 2) - viewport.left;
    const sy = (clientY ?? viewport.top + viewport.height / 2) - viewport.top;
    const view = this.view;
    const worldX = (sx - view.x) / view.zoom;
    const worldY = (sy - view.y) / view.zoom;
    view.zoom = clamp(view.zoom * factor, 0.2, 3);
    view.x = sx - worldX * view.zoom;
    view.y = sy - worldY * view.zoom;
    this.applyTransform();
  }

  screenToWorld(clientX, clientY) {
    const rect = this.element.querySelector(".ib-viewport").getBoundingClientRect();
    return { x: (clientX - rect.left - this.view.x) / this.view.zoom, y: (clientY - rect.top - this.view.y) / this.view.zoom };
  }

  fitToContent() {
    const cards = this.board.cards;
    if (!cards.length) {
      this.views.set(this.board.id, { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 });
      return this.applyTransform();
    }
    const rect = this.element.querySelector(".ib-viewport").getBoundingClientRect();
    const minX = Math.min(...cards.map(card => card.x));
    const minY = Math.min(...cards.map(card => card.y));
    const maxX = Math.max(...cards.map(card => card.x + card.width));
    const maxY = Math.max(...cards.map(card => card.y + card.height));
    const zoom = clamp(Math.min((rect.width - 160) / (maxX - minX), (rect.height - 160) / (maxY - minY)), 0.2, 1.5);
    this.views.set(this.board.id, {
      zoom,
      x: rect.width / 2 - (minX + maxX) / 2 * zoom,
      y: rect.height / 2 - (minY + maxY) / 2 * zoom
    });
    this.applyTransform();
  }

  addCard(type, point, edit = false) {
    const card = {
      id: uid(), type, title: "", text: "", imageUrl: "", color: TYPES[type].color,
      x: point.x - 130, y: point.y - 95, width: 260, height: type === "image" ? 260 : 190,
      authorId: game.user.id, authorName: game.user.name,
      authorColor: String(game.user.color?.css || game.user.color || "#8a817c"),
      createdAt: Date.now(), updatedAt: Date.now()
    };
    this.selectedCardId = card.id;
    this.commit({ type: "add-card", boardId: this.board.id, card });
    if (edit) setTimeout(() => this.openEditor(card.id), 0);
  }

  openEditor(cardId) {
    if (!this.canEdit) return ui.notifications.warn(this.t("IB.ReadOnly"));
    const card = this.board.cards.find(entry => entry.id === cardId);
    if (!card) return;
    const layer = this.element.querySelector(".ib-modal-layer");
    layer.innerHTML = `<div class="ib-modal-backdrop" data-modal-close></div>
      <form class="ib-editor">
        <header><h2>${esc(this.t("IB.EditCard"))}</h2><button type="button" data-modal-close><i class="fa-solid fa-xmark"></i></button></header>
        <div class="ib-editor-grid">
          <label>${esc(this.t("IB.CardType"))}<select name="type">${Object.keys(TYPES).map(type => `<option value="${type}" ${type === card.type ? "selected" : ""}>${esc(this.t(`IB.${type[0].toUpperCase()}${type.slice(1)}`))}</option>`).join("")}</select></label>
          <label>${esc(this.t("IB.CardColor"))}<input name="color" type="color" value="${esc(card.color)}"></label>
        </div>
        <label>${esc(this.t("IB.CardTitle"))}<input name="title" value="${esc(card.title)}" maxlength="200" autofocus></label>
        <label>${esc(this.t("IB.CardText"))}<textarea name="text" rows="9" maxlength="20000">${esc(card.text)}</textarea></label>
        <label class="ib-image-url">${esc(this.t("IB.ImageUrl"))}<input name="imageUrl" type="url" value="${esc(card.imageUrl)}" placeholder="https://…"></label>
        <footer><button type="button" class="ib-danger" data-delete-card><i class="fa-solid fa-trash"></i>${esc(this.t("IB.DeleteCard"))}</button><span></span><button type="button" data-modal-close>${esc(this.t("IB.Cancel"))}</button><button type="button" data-save-card class="ib-primary">${esc(this.t("IB.Save"))}</button></footer>
      </form>`;
    layer.classList.add("is-visible");
    const form = layer.querySelector("form");
    const typeField = form.elements.namedItem("type");
    const updateImageVisibility = () => form.querySelector(".ib-image-url").hidden = typeField.value !== "image";
    updateImageVisibility();
    typeField.addEventListener("change", updateImageVisibility);
    layer.querySelectorAll("[data-modal-close]").forEach(node => node.addEventListener("click", () => this.closeModal()));
    layer.querySelector("[data-delete-card]").addEventListener("click", () => {
      if (confirm(this.t("IB.ConfirmDeleteCard"))) {
        this.commit({ type: "delete-card", boardId: this.board.id, cardId });
        this.closeModal();
      }
    });
    const save = () => {
      const data = new FormData(form);
      this.commit({
        type: "update-card", boardId: this.board.id, cardId,
        patch: { type: data.get("type"), color: data.get("color"), title: data.get("title"), text: data.get("text"), imageUrl: data.get("imageUrl"), updatedAt: Date.now() }
      });
      this.closeModal();
    };
    layer.querySelector("[data-save-card]").addEventListener("click", save);
    form.addEventListener("submit", event => { event.preventDefault(); save(); });
    requestAnimationFrame(() => form.elements.namedItem("title").focus());
  }

  closeModal() {
    const layer = this.element.querySelector(".ib-modal-layer");
    layer.classList.remove("is-visible");
    layer.innerHTML = "";
  }

  handleLinkClick(cardId) {
    if (!this.canEdit) return;
    if (!this.linkStartId) {
      this.linkStartId = cardId;
      this.selectedCardId = cardId;
      this.renderBoard();
      return ui.notifications.info(this.t("IB.LinkSecond"));
    }
    if (this.linkStartId === cardId) return;
    const duplicate = this.board.links.some(link => [link.from, link.to].includes(this.linkStartId) && [link.from, link.to].includes(cardId));
    if (!duplicate) this.commit({ type: "add-link", boardId: this.board.id, link: { id: uid(), from: this.linkStartId, to: cardId, color: "#c9b79c" } });
    this.linkStartId = null;
    this.setTool("select");
    ui.notifications.info(this.t("IB.LinkCreated"));
  }

  newBoard() {
    if (!game.user.isGM) return;
    this.openTextPrompt(this.t("IB.NewBoard"), this.t("IB.DefaultBoard"), name => {
      const board = { id: uid(), name, cards: [], links: [] };
      this.activeBoardId = board.id;
      this.commit({ type: "add-board", board });
      this.switchBoard(board.id);
    });
  }

  renameBoard() {
    if (!game.user.isGM) return;
    this.openTextPrompt(this.t("IB.RenameBoard"), this.board.name, name => {
      this.commit({ type: "rename-board", boardId: this.board.id, name });
    });
  }

  openTextPrompt(title, value, onAccept) {
    const layer = this.element.querySelector(".ib-modal-layer");
    layer.innerHTML = `<div class="ib-modal-backdrop" data-modal-close></div>
      <form class="ib-editor ib-prompt">
        <header><h2>${esc(title)}</h2><button type="button" data-modal-close><i class="fa-solid fa-xmark"></i></button></header>
        <label>${esc(this.t("IB.BoardName"))}<input name="name" value="${esc(value)}" maxlength="120" autocomplete="off"></label>
        <footer><span></span><button type="button" data-modal-close>${esc(this.t("IB.Cancel"))}</button><button type="submit" class="ib-primary">${esc(this.t("IB.Save"))}</button></footer>
      </form>`;
    layer.classList.add("is-visible");
    const form = layer.querySelector("form");
    layer.querySelectorAll("[data-modal-close]").forEach(node => node.addEventListener("click", () => this.closeModal()));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const name = String(new FormData(form).get("name") || "").trim().slice(0, 120);
      if (!name) return;
      this.closeModal();
      onAccept(name);
    });
    requestAnimationFrame(() => {
      const input = form.elements.namedItem("name");
      input.focus();
      input.select();
    });
  }

  deleteBoard() {
    if (!game.user.isGM || this.state.boards.length <= 1 || !confirm(this.t("IB.ConfirmDeleteBoard"))) return;
    const boardId = this.board.id;
    this.activeBoardId = this.state.boards.find(board => board.id !== boardId).id;
    this.commit({ type: "delete-board", boardId });
  }

  switchBoard(boardId) {
    if (!this.state.boards.some(board => board.id === boardId)) return;
    this.activeBoardId = boardId;
    this.selectedCardId = null;
    this.linkStartId = null;
    localStorage.setItem(this.storageKey, boardId);
    this.render();
  }

  onKeyDown(event) {
    if (event.ctrlKey && event.shiftKey && event.code === "KeyI") {
      event.preventDefault();
      return this.toggle();
    }
    if (!this.isOpen) return;
    if (event.key === "Escape") {
      if (this.element.querySelector(".ib-modal-layer.is-visible")) return this.closeModal();
      if (this.tool !== "select") return this.setTool("select");
      return this.toggle(false);
    }
    if ((event.key === "Delete" || event.key === "Backspace") && this.selectedCardId && !event.target.matches("input,textarea,select")) {
      event.preventDefault();
      if (this.canEdit && confirm(this.t("IB.ConfirmDeleteCard"))) this.commit({ type: "delete-card", boardId: this.board.id, cardId: this.selectedCardId });
    }
  }

  exportState() {
    const blob = new Blob([JSON.stringify(this.state, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `investigation-board-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  async importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !game.user.isGM) return;
    try {
      const raw = JSON.parse(await file.text());
      if (!raw || !Array.isArray(raw.boards)) throw new Error("Invalid export");
      this.state = normalizeState(raw);
      this.activeBoardId = this.state.boards[0].id;
      this.render();
      await this.persistAndBroadcast();
      ui.notifications.info(this.t("IB.Imported"));
    } catch (error) {
      console.error(`${MODULE_ID} | Import failed`, error);
      ui.notifications.error(this.t("IB.InvalidImport"));
    }
  }

  commit(action, render = true) {
    if (!this.canEdit) return ui.notifications.warn(this.t("IB.ReadOnly"));
    if (!this.applyAction(action)) return;
    if (render) this.render();
    else this.renderEdges();
    this.setStatus("saving", this.isAuthority ? this.t("IB.SyncWaiting") : this.t("IB.SyncWaiting"));
    if (this.isAuthority) this.persistAndBroadcast();
    else {
      game.socket.emit(SOCKET, { type: "action", action, userId: game.user.id, nonce: uid() });
      if (!this.authority) {
        this.setStatus("warning", this.t("IB.NoGM"));
        ui.notifications.warn(this.t("IB.NoGM"));
      }
    }
  }

  applyAction(action) {
    if (!action || typeof action !== "object") return false;
    const board = this.state.boards.find(entry => entry.id === action.boardId);
    switch (action.type) {
      case "add-board":
        if (!action.board || this.state.boards.some(entry => entry.id === action.board.id)) return false;
        this.state.boards.push(normalizeState({ boards: [action.board] }).boards[0]);
        return true;
      case "rename-board":
        if (!board) return false;
        board.name = String(action.name || board.name).slice(0, 120);
        return true;
      case "delete-board":
        if (!board || this.state.boards.length <= 1) return false;
        this.state.boards = this.state.boards.filter(entry => entry.id !== action.boardId);
        if (this.activeBoardId === action.boardId) this.activeBoardId = this.state.boards[0].id;
        return true;
      case "add-card":
        if (!board || !action.card || board.cards.some(card => card.id === action.card.id)) return false;
        board.cards.push(normalizeState({ boards: [{ cards: [action.card], links: [] }] }).boards[0].cards[0]);
        return true;
      case "update-card": { 
        const card = board?.cards.find(entry => entry.id === action.cardId);
        if (!card || !action.patch) return false;
        const allowed = ["type", "title", "text", "imageUrl", "color", "x", "y", "width", "height", "updatedAt"];
        for (const key of allowed) if (Object.hasOwn(action.patch, key)) card[key] = action.patch[key];
        Object.assign(card, normalizeState({ boards: [{ cards: [card], links: [] }] }).boards[0].cards[0]);
        return true;
      }
      case "delete-card":
        if (!board?.cards.some(card => card.id === action.cardId)) return false;
        board.cards = board.cards.filter(card => card.id !== action.cardId);
        board.links = board.links.filter(link => link.from !== action.cardId && link.to !== action.cardId);
        if (this.selectedCardId === action.cardId) this.selectedCardId = null;
        return true;
      case "add-link":
        if (!board || !action.link || board.links.some(link => link.id === action.link.id)) return false;
        if (!board.cards.some(card => card.id === action.link.from) || !board.cards.some(card => card.id === action.link.to)) return false;
        board.links.push({ id: String(action.link.id), from: String(action.link.from), to: String(action.link.to), color: /^#[0-9a-f]{6}$/i.test(action.link.color) ? action.link.color : "#c9b79c" });
        return true;
      case "delete-link":
        if (!board?.links.some(link => link.id === action.linkId)) return false;
        board.links = board.links.filter(link => link.id !== action.linkId);
        return true;
      default:
        return false;
    }
  }

  async persistAndBroadcast() {
    if (!this.isAuthority) return;
    this.state.revision += 1;
    const snapshot = clone(this.state);
    this.saveChain = this.saveChain.then(async () => {
      try {
        await game.settings.set(MODULE_ID, STATE_KEY, snapshot);
        this.broadcastState(snapshot);
        this.setStatus("ready", this.t("IB.Saved"));
      } catch (error) {
        console.error(`${MODULE_ID} | Could not save board state`, error);
        this.setStatus("warning", error.message);
      }
    });
    return this.saveChain;
  }

  broadcastState(snapshot = this.state, targetUserId = null) {
    game.socket.emit(SOCKET, { type: "state", state: clone(snapshot), targetUserId, userId: game.user.id });
  }

  async onSocket(packet) {
    if (!packet || packet.userId === game.user.id) return;
    if (packet.type === "request-state" && this.isAuthority) return this.broadcastState(this.state, packet.userId);
    if (packet.type === "state") {
      if (packet.userId !== this.authority?.id) return;
      if (packet.targetUserId && packet.targetUserId !== game.user.id) return;
      if (packet.state?.revision < this.state.revision) return;
      this.state = normalizeState(packet.state);
      this.render();
      this.setStatus("ready", this.t("IB.Saved"));
      return;
    }
    if (packet.type === "action" && this.isAuthority) {
      const actor = game.users.get(packet.userId);
      const allowed = actor?.isGM || game.settings.get(MODULE_ID, "allowPlayers");
      const gmOnly = ["add-board", "rename-board", "delete-board"];
      if (!allowed || (gmOnly.includes(packet.action?.type) && !actor?.isGM)) return;
      if (this.applyAction(packet.action)) {
        this.render();
        await this.persistAndBroadcast();
      }
    }
  }

  setStatus(kind, text) {
    const status = this.element?.querySelector(".ib-sync");
    if (!status) return;
    status.dataset.status = kind;
    status.querySelector("span").textContent = text;
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, STATE_KEY, {
    name: "Investigation Board data",
    hint: "Stored investigation canvas data.",
    scope: "world",
    config: false,
    type: Object,
    default: { schema: 1, revision: 0, boards: [] }
  });
  game.settings.register(MODULE_ID, "allowPlayers", {
    name: "IB.AllowPlayers",
    hint: "IB.AllowPlayersHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "showAuthors", {
    name: "IB.ShowAuthors",
    hint: "IB.ShowAuthorsHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.once("ready", () => {
  const board = new InvestigationBoard();
  boardInstance = board;
  game.modules.get(MODULE_ID).api = {
    open: () => board.toggle(true),
    close: () => board.toggle(false),
    toggle: () => board.toggle(),
    getState: () => clone(board.state)
  };
  board.initialize();
  console.log(`${MODULE_ID} | Ready for Foundry VTT ${game.version}`);
});

Hooks.on("getSceneControlButtons", controls => {
  const control = controls.tokens || controls.notes || Object.values(controls)[0];
  if (!control?.tools) return;
  control.tools.investigationBoard = {
    name: "investigationBoard",
    title: "IB.Open",
    icon: "fa-solid fa-diagram-project",
    order: Object.keys(control.tools).length,
    button: true,
    visible: true,
    onChange: () => boardInstance?.toggle()
  };
});
