const MODULE_ID = "investigation-board";
const STATE_KEY = "journalState";
const LEGACY_KEY = "boardState";
const SOCKET = `module.${MODULE_ID}`;

const STYLE_REGISTRY = Object.freeze({
  sticky: { label: "IB.StyleSticky", icon: "fa-note-sticky", width: 250, height: 190 },
  document: { label: "IB.StyleDocument", icon: "fa-file-lines", width: 290, height: 230 },
  torn: { label: "IB.StyleTorn", icon: "fa-scroll", width: 270, height: 210 }
});

const clone = value => globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const esc = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const safeColor = (value, fallback = "#b48e55") => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

function emptyState() {
  return { schema: 2, revision: 0, notes: [], layout: { cards: [], labels: [] }, events: [] };
}

function normalizeBlock(block = {}) {
  return { blockId: String(block.blockId || uid()), text: String(block.text || "").slice(0, 30000), hidden: Boolean(block.hidden) };
}

function normalizeLink(link = {}) {
  return {
    id: String(link.id || uid()), targetId: String(link.targetId || ""), label: String(link.label || "").slice(0, 160),
    direction: ["none", "one", "two"].includes(link.direction) ? link.direction : "none",
    color: safeColor(link.color, "#b48e55"), lineStyle: link.lineStyle === "dashed" ? "dashed" : "solid",
    origin: link.origin === "typed" ? "typed" : "drawn", authorId: String(link.authorId || ""), createdAt: Number(link.createdAt) || Date.now()
  };
}

function normalizeNote(note = {}) {
  return {
    id: String(note.id || uid()), title: String(note.title || "").slice(0, 240),
    style: Object.hasOwn(STYLE_REGISTRY, note.style) ? note.style : "sticky", image: String(note.image || "").slice(0, 4000),
    blocks: (Array.isArray(note.blocks) ? note.blocks : []).slice(0, 500).map(normalizeBlock),
    links: (Array.isArray(note.links) ? note.links : []).slice(0, 1000).map(normalizeLink),
    authorId: String(note.authorId || ""), createdAt: Number(note.createdAt) || Date.now(), updatedAt: Number(note.updatedAt) || Date.now(),
    contributions: note.contributions && typeof note.contributions === "object" ? Object.fromEntries(Object.entries(note.contributions).map(([id, count]) => [String(id), Math.max(0, Number(count) || 0)])) : {},
    editCount: Math.max(0, Number(note.editCount) || 0), deleted: Boolean(note.deleted), deletedAt: Number(note.deletedAt) || null,
    deletedBy: String(note.deletedBy || ""), trashPosition: note.trashPosition && typeof note.trashPosition === "object" ? clone(note.trashPosition) : null,
    visibility: note.visibility === "gm" ? "gm" : "public"
  };
}

function normalizeState(source) {
  const raw = source && typeof source === "object" ? source : {};
  const state = emptyState();
  state.revision = Math.max(0, Number(raw.revision) || 0);
  state.notes = (Array.isArray(raw.notes) ? raw.notes : []).slice(0, 2500).map(normalizeNote);
  const ids = new Set(state.notes.map(note => note.id));
  for (const note of state.notes) note.links = note.links.filter(link => ids.has(link.targetId) && link.targetId !== note.id);
  state.layout.cards = (Array.isArray(raw.layout?.cards) ? raw.layout.cards : []).filter(card => ids.has(String(card.noteId))).map(card => ({
    noteId: String(card.noteId), x: Number(card.x) || 0, y: Number(card.y) || 0,
    width: clamp(Number(card.width) || 260, 180, 800), height: clamp(Number(card.height) || 200, 120, 800)
  })).filter((card, index, cards) => cards.findIndex(other => other.noteId === card.noteId) === index);
  state.layout.labels = (Array.isArray(raw.layout?.labels) ? raw.layout.labels : []).slice(0, 1000).map(label => ({
    labelId: String(label.labelId || uid()), text: String(label.text || "").slice(0, 500), x: Number(label.x) || 0, y: Number(label.y) || 0,
    size: clamp(Number(label.size) || 28, 12, 96), color: safeColor(label.color, "#d9c9ae")
  }));
  state.events = (Array.isArray(raw.events) ? raw.events : []).slice(-2000).map(event => ({
    id: String(event.id || uid()), type: String(event.type || "update"), userId: String(event.userId || ""),
    noteId: String(event.noteId || ""), amount: Number(event.amount) || 0, timestamp: Number(event.timestamp) || Date.now()
  }));
  return state;
}

function migrateLegacy(legacy) {
  const state = emptyState();
  const board = legacy?.boards?.[0];
  if (!board || !Array.isArray(board.cards)) return state;
  const typeStyles = { note: "sticky", clue: "torn", person: "document", location: "document", image: "document" };
  for (const card of board.cards) {
    const note = normalizeNote({
      id: card.id, title: card.title, style: typeStyles[card.type] || "sticky", image: card.imageUrl,
      blocks: card.text ? [{ blockId: uid(), text: card.text }] : [], authorId: card.authorId,
      createdAt: card.createdAt, updatedAt: card.updatedAt, contributions: card.authorId ? { [card.authorId]: String(card.text || "").length } : {}
    });
    state.notes.push(note);
    state.layout.cards.push({ noteId: note.id, x: Number(card.x) || 0, y: Number(card.y) || 0, width: Number(card.width) || 260, height: Number(card.height) || 190 });
  }
  for (const legacyLink of board.links || []) {
    const source = state.notes.find(note => note.id === legacyLink.from);
    if (source && state.notes.some(note => note.id === legacyLink.to)) source.links.push(normalizeLink({ targetId: legacyLink.to, color: legacyLink.color, direction: "none", origin: "drawn" }));
  }
  return normalizeState(state);
}

function parseWikiLinks(text) {
  const results = [];
  const pattern = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;
  for (const match of String(text || "").matchAll(pattern)) results.push({ title: match[1].trim(), label: (match[2] || "").trim() });
  return results;
}

function inlineMarkdown(text) {
  let html = esc(text);
  html = html.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_match, title, alias) => `<span class="ib-wikilink"><i class="fa-solid fa-link"></i>${alias || title}</span>`);
  html = html.replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/(^|\s)_([^_\n]+)_/g, "$1<em>$2</em>");
  return html;
}

function renderMarkdown(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const nextList = unordered ? "ul" : "ol";
      if (list !== nextList) { closeList(); list = nextList; out.push(`<${list}>`); }
      out.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    if (heading) out.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
    else if (/^>\s?/.test(line)) out.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`);
    else if (!line.trim()) out.push("<br>");
    else out.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  return out.join("");
}

class JournalController {
  constructor(state) {
    this.state = normalizeState(state);
    this.root = null;
    this.app = null;
    this.locks = new Map();
    this.view = { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 };
    this.selectedNoteId = this.state.notes.find(note => !note.deleted)?.id || null;
    this.drawerMode = "notes";
    this.filters = { search: "", style: "", placement: "" };
    this.tool = "select";
    this.editingBlockKey = null;
    this.pendingBlockKey = null;
    this.drafts = new Map();
    this.saveChain = Promise.resolve();
  }

  t(key) { return game.i18n.localize(key); }
  f(key, data) { return game.i18n.format(key, data); }
  get authority() { return game.users.filter(user => user.active && user.isGM).sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null; }
  get isAuthority() { return this.authority?.id === game.user.id; }
  get canEdit() { return Boolean(this.authority); }
  get selectedNote() { return this.state.notes.find(note => note.id === this.selectedNoteId) || null; }
  get lockTimeout() { return Math.max(15, Number(game.settings.get(MODULE_ID, "lockTimeout")) || 90) * 1000; }
  user(id) { return game.users.get(id); }
  userName(id) { return this.user(id)?.name || this.t("IB.UnknownUser"); }
  userColor(id) { return String(this.user(id)?.color?.css || this.user(id)?.color || "#8f887d"); }
  cardFor(noteId) { return this.state.layout.cards.find(card => card.noteId === noteId); }
  noteFor(noteId) { return this.state.notes.find(note => note.id === noteId); }
  lockKey(noteId, blockId) { return `${noteId}:${blockId}`; }

  initialize() {
    game.socket.on(SOCKET, packet => this.onSocket(packet));
    game.socket.emit(SOCKET, { type: "request-state", userId: game.user.id });
    this.lockTimer = window.setInterval(() => { if (this.isAuthority) this.clearExpiredLocks(); }, 10000);
    Hooks.on("userConnected", () => { if (this.isAuthority) setTimeout(() => this.broadcastState(), 300); });
  }

  mount(element, app) {
    this.root = element.querySelector(".ib-journal-shell") || element;
    this.app = app;
    if (!this.root.dataset.bound) {
      this.root.dataset.bound = "true";
      this.root.addEventListener("click", event => this.onClick(event));
      this.root.addEventListener("input", event => this.onInput(event));
      this.root.addEventListener("change", event => this.onChange(event));
      this.root.addEventListener("pointerdown", event => this.onPointerDown(event));
      const viewport = this.root.querySelector(".ib-canvas-viewport");
      viewport.addEventListener("wheel", event => this.onWheel(event), { passive: false });
      viewport.addEventListener("contextmenu", event => event.preventDefault());
    }
    this.renderAll();
  }

  unmount() {
    if (this.editingBlockKey) this.releaseLock(this.editingBlockKey);
    this.root = null;
    this.app = null;
  }

  renderAll() {
    if (!this.root) return;
    this.renderDrawer();
    this.renderCanvas();
    this.renderEditor();
    this.updateToolbar();
    this.setStatus(this.authority ? "ready" : "warning", this.authority ? this.t("IB.Saved") : this.t("IB.NoGM"));
  }

  matchesFilters(note) {
    const query = this.filters.search.toLocaleLowerCase();
    const haystack = `${note.title} ${note.blocks.map(block => block.text).join(" ")} ${this.userName(note.authorId)}`.toLocaleLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (this.filters.style && note.style !== this.filters.style) return false;
    const placed = Boolean(this.cardFor(note.id));
    if (this.filters.placement === "placed" && !placed) return false;
    if (this.filters.placement === "unplaced" && placed) return false;
    return true;
  }

  renderDrawer() {
    const content = this.root.querySelector(".ib-drawer-content");
    this.root.querySelectorAll("[data-drawer-mode]").forEach(button => button.classList.toggle("is-active", button.dataset.drawerMode === this.drawerMode));
    const filters = this.root.querySelector(".ib-drawer-filters");
    filters.hidden = this.drawerMode === "stats";
    const styleSelect = filters.querySelector("[data-filter='style']");
    styleSelect.innerHTML = `<option value="">${esc(this.t("IB.AllStyles"))}</option>${Object.entries(STYLE_REGISTRY).map(([key, style]) => `<option value="${key}" ${this.filters.style === key ? "selected" : ""}>${esc(this.t(style.label))}</option>`).join("")}`;
    filters.querySelector("[data-filter='search']").value = this.filters.search;
    filters.querySelector("[data-filter='placement']").value = this.filters.placement;

    if (this.drawerMode === "stats") {
      content.innerHTML = this.statsHTML();
      this.root.querySelector(".ib-drawer-footer").hidden = true;
      return;
    }
    this.root.querySelector(".ib-drawer-footer").hidden = this.drawerMode !== "notes";
    const deleted = this.drawerMode === "trash";
    const notes = this.state.notes.filter(note => note.deleted === deleted && this.matchesFilters(note)).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!notes.length) {
      content.innerHTML = `<div class="ib-list-empty"><i class="fa-solid ${deleted ? "fa-trash-can" : "fa-note-sticky"}"></i><span>${esc(this.t(deleted ? "IB.TrashEmpty" : "IB.NoNotes"))}</span></div>`;
    } else {
      content.innerHTML = notes.map(note => {
        const placed = Boolean(this.cardFor(note.id));
        const preview = note.blocks.map(block => block.text).join(" ").slice(0, 100);
        return `<article class="ib-note-list-item ${this.selectedNoteId === note.id ? "is-selected" : ""}" data-note-id="${esc(note.id)}">
          <button type="button" class="ib-note-list-main" data-action="select-note"><i class="fa-solid ${STYLE_REGISTRY[note.style].icon}"></i><span><strong>${esc(note.title || this.t("IB.Untitled"))}</strong><small>${esc(preview)}</small></span></button>
          <div class="ib-note-list-meta"><span style="--user-color:${esc(this.userColor(note.authorId))}">${esc(this.userName(note.authorId))}</span>${deleted ? `<button type="button" data-action="restore-note" title="${esc(this.t("IB.Restore"))}"><i class="fa-solid fa-rotate-left"></i></button>` : `<button type="button" data-action="${placed ? "unplace-note" : "place-note"}" title="${esc(this.t(placed ? "IB.RemoveFromCanvas" : "IB.Place"))}"><i class="fa-solid ${placed ? "fa-thumbtack" : "fa-map-pin"}"></i></button>`}</div>
        </article>`;
      }).join("");
    }
    if (deleted && game.user.isGM && this.state.notes.some(note => note.deleted)) content.insertAdjacentHTML("beforeend", `<button type="button" class="ib-empty-trash" data-action="empty-trash"><i class="fa-solid fa-fire"></i>${esc(this.t("IB.EmptyTrash"))}</button>`);
  }

  renderCanvas() {
    const cardsRoot = this.root.querySelector(".ib-canvas-cards");
    const labelsRoot = this.root.querySelector(".ib-canvas-labels");
    const activeCards = this.state.layout.cards.filter(card => !this.noteFor(card.noteId)?.deleted && this.noteFor(card.noteId));
    cardsRoot.innerHTML = activeCards.map(card => {
      const note = this.noteFor(card.noteId);
      const dim = (this.filters.search || this.filters.style || this.filters.placement) && !this.matchesFilters(note);
      const preview = note.blocks.map(block => block.text).join("\n\n").slice(0, 420);
      return `<article class="ib-note-card ib-style-${note.style} ${this.selectedNoteId === note.id ? "is-selected" : ""} ${dim ? "is-dimmed" : ""}" data-note-id="${esc(note.id)}" style="left:${card.x}px;top:${card.y}px;width:${card.width}px;height:${card.height}px">
        <header class="ib-card-handle"><i class="fa-solid ${STYLE_REGISTRY[note.style].icon}"></i><strong>${esc(note.title || this.t("IB.Untitled"))}</strong><span style="--user-color:${esc(this.userColor(note.authorId))}"></span></header>
        ${note.image ? `<img src="${esc(note.image)}" alt="${esc(note.title)}" loading="lazy">` : ""}
        <div class="ib-card-preview">${renderMarkdown(preview)}</div>
        <button type="button" class="ib-link-handle" data-link-start title="${esc(this.t("IB.LinkLabel"))}"><i class="fa-solid fa-circle"></i></button>
        <button type="button" class="ib-card-resize" data-card-resize><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button>
      </article>`;
    }).join("");
    labelsRoot.innerHTML = this.state.layout.labels.map(label => `<button type="button" class="ib-free-label" data-label-id="${esc(label.labelId)}" style="left:${label.x}px;top:${label.y}px;font-size:${label.size}px;color:${esc(label.color)}">${esc(label.text)}</button>`).join("");
    this.renderLinks();
    this.root.querySelector(".ib-canvas-empty").hidden = activeCards.length > 0;
    this.applyTransform();
  }

  renderLinks() {
    if (!this.root) return;
    const svg = this.root.querySelector(".ib-canvas-links");
    const paths = [];
    paths.push(`<defs><marker id="ib-arrow-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker><marker id="ib-arrow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 10 0 L 0 5 L 10 10 z"></path></marker></defs>`);
    for (const source of this.state.notes.filter(note => !note.deleted)) {
      const from = this.cardFor(source.id);
      if (!from) continue;
      for (const link of source.links) {
        const targetNote = this.noteFor(link.targetId);
        const to = this.cardFor(link.targetId);
        if (!to || targetNote?.deleted) continue;
        const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
        const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
        const pathId = `ib-path-${link.id.replace(/[^a-z0-9_-]/gi, "")}`;
        const markers = link.direction === "one" ? 'marker-end="url(#ib-arrow-end)"' : link.direction === "two" ? 'marker-start="url(#ib-arrow-start)" marker-end="url(#ib-arrow-end)"' : "";
        paths.push(`<path id="${pathId}" class="ib-link-path ${link.lineStyle === "dashed" ? "is-dashed" : ""}" data-source-id="${esc(source.id)}" data-link-id="${esc(link.id)}" d="${this.curvePath(a, b)}" style="--link-color:${esc(link.color)}" ${markers}></path>`);
        if (link.label) paths.push(`<text class="ib-link-label"><textPath href="#${pathId}" startOffset="50%">${esc(link.label)}</textPath></text>`);
      }
    }
    svg.innerHTML = paths.join("");
  }

  curvePath(a, b) {
    const bend = clamp(Math.abs(b.x - a.x) * 0.55, 80, 320);
    const sign = b.x >= a.x ? 1 : -1;
    return `M ${a.x} ${a.y} C ${a.x + bend * sign} ${a.y}, ${b.x - bend * sign} ${b.y}, ${b.x} ${b.y}`;
  }

  renderEditor() {
    const root = this.root.querySelector(".ib-note-editor-content");
    const note = this.selectedNote;
    if (!note) { root.innerHTML = `<div class="ib-editor-empty"><i class="fa-solid fa-book-open"></i><p>${esc(this.t("IB.EditorEmpty"))}</p></div>`; return; }
    if (note.deleted) {
      root.innerHTML = `<div class="ib-editor-empty"><i class="fa-solid fa-trash-can"></i><h2>${esc(note.title || this.t("IB.Untitled"))}</h2><button type="button" data-action="restore-note" data-note-id="${esc(note.id)}"><i class="fa-solid fa-rotate-left"></i>${esc(this.t("IB.Restore"))}</button></div>`;
      return;
    }
    const disabled = this.canEdit ? "" : "disabled";
    root.innerHTML = `<header class="ib-editor-header">
      <input class="ib-note-title" data-note-field="title" value="${esc(note.title)}" placeholder="${esc(this.t("IB.Untitled"))}" ${disabled}>
      <div class="ib-editor-actions"><button type="button" data-action="${this.cardFor(note.id) ? "unplace-note" : "place-note"}" data-note-id="${esc(note.id)}" title="${esc(this.t(this.cardFor(note.id) ? "IB.RemoveFromCanvas" : "IB.Place"))}"><i class="fa-solid ${this.cardFor(note.id) ? "fa-thumbtack" : "fa-map-pin"}"></i></button><button type="button" data-action="trash-note" data-note-id="${esc(note.id)}" title="${esc(this.t("IB.MoveToTrash"))}"><i class="fa-solid fa-trash"></i></button></div>
      <div class="ib-editor-fields"><label>${esc(this.t("IB.Style"))}<select data-note-field="style" ${disabled}>${Object.entries(STYLE_REGISTRY).map(([key, style]) => `<option value="${key}" ${note.style === key ? "selected" : ""}>${esc(this.t(style.label))}</option>`).join("")}</select></label><label>${esc(this.t("IB.ImageUrl"))}<input type="url" data-note-field="image" value="${esc(note.image)}" placeholder="https://…" ${disabled}></label></div>
      <div class="ib-note-author" style="--user-color:${esc(this.userColor(note.authorId))}">${esc(this.f("IB.CreatedBy", { name: this.userName(note.authorId) }))}</div>
    </header>
    <section class="ib-block-list">${note.blocks.map((block, index) => this.blockHTML(note, block, index)).join("")}</section>
    <button type="button" class="ib-add-block" data-action="add-block" ${disabled}><i class="fa-solid fa-plus"></i>${esc(this.t("IB.AddBlock"))}</button>
    ${this.backlinksHTML(note)}${this.contributionsHTML(note)}`;
  }

  blockHTML(note, block, index) {
    const key = this.lockKey(note.id, block.blockId);
    const lock = this.locks.get(key);
    const editing = this.editingBlockKey === key;
    const pending = this.pendingBlockKey === key;
    const draft = this.drafts.get(key) ?? block.text;
    if (editing) return `<article class="ib-note-block is-editing" data-block-id="${esc(block.blockId)}"><textarea data-block-draft>${esc(draft)}</textarea><footer><button type="button" class="ib-danger" data-action="delete-block" title="${esc(this.t("IB.Delete"))}"><i class="fa-solid fa-trash"></i></button><button type="button" data-action="move-block-up" title="Move up" ${index === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button><button type="button" data-action="move-block-down" title="Move down" ${index === note.blocks.length - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button><span></span><button type="button" data-action="cancel-block">${esc(this.t("IB.Cancel"))}</button><button type="button" class="ib-primary" data-action="save-block">${esc(this.t("IB.Save"))}</button></footer></article>`;
    const badge = pending ? `<span class="ib-lock-badge is-pending"><i class="fa-solid fa-spinner fa-spin"></i>${esc(this.t("IB.LockPending"))}</span>` : lock ? `<span class="ib-lock-badge" style="--user-color:${esc(this.userColor(lock.userId))}">${esc(this.f("IB.LockedBy", { name: lock.userName }))}</span>` : "";
    return `<article class="ib-note-block" data-block-id="${esc(block.blockId)}" data-index="${index}"><div class="ib-markdown">${renderMarkdown(block.text)}</div>${badge}${!lock && this.canEdit ? `<button type="button" class="ib-edit-block" data-action="edit-block" title="${esc(this.t("IB.Edit"))}"><i class="fa-solid fa-pen"></i></button>` : ""}</article>`;
  }

  backlinksHTML(note) {
    const backlinks = this.state.notes.filter(source => !source.deleted && source.links.some(link => link.targetId === note.id));
    return `<section class="ib-editor-section"><h3>${esc(this.t("IB.Backlinks"))}<span>${backlinks.length}</span></h3>${backlinks.length ? backlinks.map(source => `<button type="button" class="ib-backlink" data-action="select-note" data-note-id="${esc(source.id)}"><i class="fa-solid fa-arrow-left"></i>${esc(source.title || this.t("IB.Untitled"))}</button>`).join("") : `<p class="ib-muted">${esc(this.t("IB.NoBacklinks"))}</p>`}</section>`;
  }

  contributionsHTML(note) {
    const rows = Object.entries(note.contributions).sort((a, b) => b[1] - a[1]);
    return `<section class="ib-editor-section"><h3>${esc(this.t("IB.Contributions"))}</h3>${rows.map(([userId, count]) => `<div class="ib-contribution"><span style="--user-color:${esc(this.userColor(userId))}">${esc(this.userName(userId))}</span><strong>${count}</strong></div>`).join("") || `<p class="ib-muted">—</p>`}</section>`;
  }

  statsHTML() {
    const activeNotes = this.state.notes.filter(note => !note.deleted);
    const totals = {};
    const created = {};
    const drawn = {};
    for (const note of activeNotes) {
      created[note.authorId] = (created[note.authorId] || 0) + 1;
      for (const [userId, count] of Object.entries(note.contributions)) totals[userId] = (totals[userId] || 0) + count;
      for (const link of note.links.filter(link => link.origin === "drawn")) drawn[link.authorId] = (drawn[link.authorId] || 0) + 1;
    }
    const rank = map => Object.entries(map).sort((a, b) => b[1] - a[1]);
    const linkCounts = activeNotes.map(note => ({ note, count: note.links.length + activeNotes.reduce((sum, source) => sum + source.links.filter(link => link.targetId === note.id).length, 0) })).sort((a, b) => b.count - a.count);
    const edited = [...activeNotes].sort((a, b) => b.editCount - a.editCount)[0];
    const leaderboard = (title, map, suffix = "") => `<section class="ib-stat-section"><h3>${esc(title)}</h3>${rank(map).slice(0, 8).map(([id, value], index) => `<div class="ib-stat-row"><b>${index + 1}</b><span style="--user-color:${esc(this.userColor(id))}">${esc(this.userName(id))}</span><strong>${value} ${esc(suffix)}</strong></div>`).join("") || "—"}</section>`;
    return `<div class="ib-stats"><h2><i class="fa-solid fa-trophy"></i>${esc(this.t("IB.MvpBoard"))}</h2>${leaderboard(this.t("IB.CharactersWritten"), totals)}${leaderboard(this.t("IB.NotesCreated"), created)}${leaderboard(this.t("IB.LinksDrawn"), drawn)}<section class="ib-stat-section"><h3>${esc(this.t("IB.MostLinked"))}</h3><p>${esc(linkCounts[0]?.note.title || "—")} <strong>${linkCounts[0]?.count || 0}</strong></p><h3>${esc(this.t("IB.MostEdited"))}</h3><p>${esc(edited?.title || "—")} <strong>${edited?.editCount || 0}</strong></p></section><section class="ib-stat-section"><h3>${esc(this.t("IB.Activity"))}</h3>${this.state.events.slice(-12).reverse().map(event => `<div class="ib-activity"><span style="--user-color:${esc(this.userColor(event.userId))}">${esc(this.userName(event.userId))}</span><small>${esc(event.type)} · ${new Date(event.timestamp).toLocaleString()}</small></div>`).join("") || "—"}</section></div>`;
  }

  updateToolbar() {
    this.root.querySelectorAll("[data-tool]").forEach(button => button.classList.toggle("is-active", button.dataset.tool === this.tool));
    this.root.querySelector(".ib-canvas-viewport").dataset.tool = this.tool;
  }

  applyTransform() {
    if (!this.root) return;
    const world = this.root.querySelector(".ib-canvas-world");
    const viewport = this.root.querySelector(".ib-canvas-viewport");
    world.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.zoom})`;
    viewport.style.setProperty("--grid-size", `${26 * this.view.zoom}px`);
    viewport.style.setProperty("--grid-x", `${this.view.x}px`);
    viewport.style.setProperty("--grid-y", `${this.view.y}px`);
    viewport.classList.toggle("is-far-zoom", this.view.zoom < 0.55);
    this.root.querySelector(".ib-canvas-zoom").textContent = `${Math.round(this.view.zoom * 100)}%`;
  }

  setStatus(kind, text) {
    const status = this.root?.querySelector(".ib-journal-status");
    if (!status) return;
    status.dataset.status = kind;
    status.querySelector("span").textContent = text;
  }

  onClick(event) {
    const actionTarget = event.target.closest("[data-action]");
    const noteElement = event.target.closest("[data-note-id]");
    if (actionTarget) return this.handleAction(actionTarget.dataset.action, actionTarget, event);
    const drawerMode = event.target.closest("[data-drawer-mode]");
    if (drawerMode) { this.drawerMode = drawerMode.dataset.drawerMode; this.renderDrawer(); return; }
    const tool = event.target.closest("[data-tool]");
    if (tool) { if (!this.canEdit && tool.dataset.tool !== "select") return ui.notifications.warn(this.t("IB.ReadOnly")); this.tool = tool.dataset.tool; this.updateToolbar(); return; }
    const path = event.target.closest(".ib-link-path");
    if (path) return this.openLinkPopover(path.dataset.sourceId, path.dataset.linkId, event.clientX, event.clientY);
    const label = event.target.closest("[data-label-id]");
    if (label) return this.editLabel(label.dataset.labelId);
    if (noteElement) { this.selectNote(noteElement.dataset.noteId, noteElement.classList.contains("ib-note-list-item")); }
  }

  handleAction(action, target, event) {
    const noteId = target.dataset.noteId || target.closest("[data-note-id]")?.dataset.noteId || this.selectedNoteId;
    const blockId = target.closest("[data-block-id]")?.dataset.blockId;
    if (action === "close") return this.app?.close();
    if (action === "toggle-focus") return this.root.classList.toggle("is-focus-mode");
    if (action === "new-note") return this.createNote(null, false);
    if (action === "select-note") return this.selectNote(noteId, true);
    if (action === "place-note") return this.placeNote(noteId);
    if (action === "unplace-note") return this.dispatch({ type: "unplace-note", noteId });
    if (action === "trash-note") return this.dispatch({ type: "trash-note", noteId });
    if (action === "restore-note") return this.dispatch({ type: "restore-note", noteId });
    if (action === "empty-trash") { if (game.user.isGM && confirm(this.t("IB.EmptyTrashConfirm"))) this.dispatch({ type: "purge-trash" }); return; }
    if (action === "fit") return this.fitCanvas();
    if (action === "zoom-in") return this.zoomAt(1.2);
    if (action === "zoom-out") return this.zoomAt(1 / 1.2);
    if (action === "edit-block") return this.requestBlockLock(noteId, blockId);
    if (action === "save-block") return this.saveBlock(noteId, blockId);
    if (action === "cancel-block") return this.cancelBlock(noteId, blockId);
    if (action === "delete-block") return this.deleteBlock(noteId, blockId);
    if (action === "move-block-up") return this.moveBlock(noteId, blockId, -1);
    if (action === "move-block-down") return this.moveBlock(noteId, blockId, 1);
    if (action === "add-block") return this.addBlock(noteId);
    if (action === "modal-close") return this.closeModal();
    if (action === "save-link") return this.saveLinkPopover();
    if (action === "delete-link") return this.deleteLinkPopover();
  }

  onInput(event) {
    if (event.target.matches("[data-filter='search']")) { this.filters.search = event.target.value.trim(); this.renderDrawer(); this.renderCanvas(); }
    if (event.target.matches("[data-block-draft]") && this.editingBlockKey) this.drafts.set(this.editingBlockKey, event.target.value);
  }

  onChange(event) {
    if (event.target.matches("[data-filter='style']")) { this.filters.style = event.target.value; this.renderDrawer(); this.renderCanvas(); return; }
    if (event.target.matches("[data-filter='placement']")) { this.filters.placement = event.target.value; this.renderDrawer(); this.renderCanvas(); return; }
    const field = event.target.dataset.noteField;
    if (field && this.selectedNoteId) this.dispatch({ type: "update-note", noteId: this.selectedNoteId, patch: { [field]: event.target.value } });
  }

  onPointerDown(event) {
    const viewport = event.target.closest(".ib-canvas-viewport");
    if (event.button === 2 && viewport) { event.preventDefault(); return this.startPan(event); }
    if (event.button !== 0 || !viewport) return;
    const linkStart = event.target.closest("[data-link-start]");
    if (linkStart) return this.startLinkDrag(event, linkStart.closest("[data-note-id]").dataset.noteId);
    const resize = event.target.closest("[data-card-resize]");
    if (resize) return this.startCardResize(event, resize.closest("[data-note-id]").dataset.noteId);
    const handle = event.target.closest(".ib-card-handle");
    if (handle) return this.startCardDrag(event, handle.closest("[data-note-id]").dataset.noteId);
    if (event.target.closest(".ib-note-card,.ib-free-label,.ib-link-path")) return;
    if (Object.hasOwn(STYLE_REGISTRY, this.tool)) { const point = this.screenToWorld(event.clientX, event.clientY); this.createNote(this.tool, true, point); this.tool = "select"; this.updateToolbar(); return; }
    if (this.tool === "label") { const point = this.screenToWorld(event.clientX, event.clientY); this.createLabel(point); this.tool = "select"; this.updateToolbar(); return; }
    this.startPan(event);
  }

  onWheel(event) { event.preventDefault(); this.zoomAt(Math.exp(-event.deltaY * 0.0012), event.clientX, event.clientY); }
  screenToWorld(clientX, clientY) { const rect = this.root.querySelector(".ib-canvas-viewport").getBoundingClientRect(); return { x: (clientX - rect.left - this.view.x) / this.view.zoom, y: (clientY - rect.top - this.view.y) / this.view.zoom }; }

  startPan(event) {
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, vx: this.view.x, vy: this.view.y };
    this.root.classList.add("is-panning");
    const move = moveEvent => { this.view.x = start.vx + moveEvent.clientX - start.x; this.view.y = start.vy + moveEvent.clientY - start.y; this.applyTransform(); };
    const up = () => { this.root.classList.remove("is-panning"); window.removeEventListener("pointermove", move); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
  }

  startCardDrag(event, noteId) {
    if (!this.canEdit) return ui.notifications.warn(this.t("IB.ReadOnly"));
    event.preventDefault(); event.stopPropagation();
    const card = this.cardFor(noteId); const node = this.root.querySelector(`.ib-note-card[data-note-id="${CSS.escape(noteId)}"]`);
    if (!card || !node) return;
    this.selectedNoteId = noteId; node.classList.add("is-dragging", "is-selected");
    const start = { x: event.clientX, y: event.clientY, cx: card.x, cy: card.y };
    const move = moveEvent => { card.x = start.cx + (moveEvent.clientX - start.x) / this.view.zoom; card.y = start.cy + (moveEvent.clientY - start.y) / this.view.zoom; node.style.left = `${card.x}px`; node.style.top = `${card.y}px`; this.renderLinks(); };
    const up = () => { node.classList.remove("is-dragging"); window.removeEventListener("pointermove", move); this.dispatch({ type: "move-card", noteId, x: card.x, y: card.y }, { render: true, alreadyApplied: true }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
  }

  startCardResize(event, noteId) {
    if (!this.canEdit) return ui.notifications.warn(this.t("IB.ReadOnly"));
    event.preventDefault(); event.stopPropagation();
    const card = this.cardFor(noteId); const node = this.root.querySelector(`.ib-note-card[data-note-id="${CSS.escape(noteId)}"]`);
    const start = { x: event.clientX, y: event.clientY, width: card.width, height: card.height };
    const move = moveEvent => { card.width = clamp(start.width + (moveEvent.clientX - start.x) / this.view.zoom, 180, 800); card.height = clamp(start.height + (moveEvent.clientY - start.y) / this.view.zoom, 120, 800); node.style.width = `${card.width}px`; node.style.height = `${card.height}px`; this.renderLinks(); };
    const up = () => { window.removeEventListener("pointermove", move); this.dispatch({ type: "resize-card", noteId, width: card.width, height: card.height }, { render: true, alreadyApplied: true }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
  }

  startLinkDrag(event, sourceId) {
    if (!this.canEdit) return ui.notifications.warn(this.t("IB.ReadOnly"));
    event.preventDefault(); event.stopPropagation();
    const fromCard = this.cardFor(sourceId); if (!fromCard) return;
    const startPoint = { x: fromCard.x + fromCard.width / 2, y: fromCard.y + fromCard.height / 2 };
    const svg = this.root.querySelector(".ib-canvas-links");
    const preview = document.createElementNS("http://www.w3.org/2000/svg", "path"); preview.classList.add("ib-link-preview"); svg.append(preview);
    const move = moveEvent => { const end = this.screenToWorld(moveEvent.clientX, moveEvent.clientY); preview.setAttribute("d", this.curvePath(startPoint, end)); };
    const up = upEvent => {
      window.removeEventListener("pointermove", move); preview.remove();
      const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest(".ib-note-card")?.dataset.noteId;
      if (target && target !== sourceId) this.dispatch({ type: "add-link", sourceId, link: { id: uid(), targetId: target, label: "", direction: "none", color: "#b48e55", lineStyle: "solid", origin: "drawn", authorId: game.user.id, createdAt: Date.now() } });
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
  }

  zoomAt(factor, clientX, clientY) {
    const rect = this.root.querySelector(".ib-canvas-viewport").getBoundingClientRect();
    const sx = (clientX ?? rect.left + rect.width / 2) - rect.left; const sy = (clientY ?? rect.top + rect.height / 2) - rect.top;
    const worldX = (sx - this.view.x) / this.view.zoom; const worldY = (sy - this.view.y) / this.view.zoom;
    this.view.zoom = clamp(this.view.zoom * factor, 0.2, 3); this.view.x = sx - worldX * this.view.zoom; this.view.y = sy - worldY * this.view.zoom; this.applyTransform();
  }

  fitCanvas() {
    const cards = this.state.layout.cards.filter(card => !this.noteFor(card.noteId)?.deleted); if (!cards.length) return;
    const rect = this.root.querySelector(".ib-canvas-viewport").getBoundingClientRect();
    const minX = Math.min(...cards.map(card => card.x)); const minY = Math.min(...cards.map(card => card.y)); const maxX = Math.max(...cards.map(card => card.x + card.width)); const maxY = Math.max(...cards.map(card => card.y + card.height));
    this.view.zoom = clamp(Math.min((rect.width - 120) / (maxX - minX), (rect.height - 120) / (maxY - minY)), 0.2, 1.4);
    this.view.x = rect.width / 2 - (minX + maxX) / 2 * this.view.zoom; this.view.y = rect.height / 2 - (minY + maxY) / 2 * this.view.zoom; this.applyTransform();
  }

  selectNote(noteId, jump = false) {
    const note = this.noteFor(noteId); if (!note) return;
    this.selectedNoteId = noteId; this.renderDrawer(); this.renderCanvas(); this.renderEditor();
    const card = this.cardFor(noteId); if (jump && card && !note.deleted) {
      const rect = this.root.querySelector(".ib-canvas-viewport").getBoundingClientRect(); this.view.zoom = Math.max(this.view.zoom, 0.8);
      this.view.x = rect.width / 2 - (card.x + card.width / 2) * this.view.zoom; this.view.y = rect.height / 2 - (card.y + card.height / 2) * this.view.zoom; this.applyTransform();
    }
  }

  createNote(style = null, placed = false, point = null) {
    if (!this.canEdit) return ui.notifications.warn(this.t("IB.ReadOnly"));
    const note = normalizeNote({ id: uid(), title: "", style: style || "document", blocks: [{ blockId: uid(), text: "" }], authorId: game.user.id, contributions: {} });
    const cardStyle = STYLE_REGISTRY[note.style];
    const card = placed ? { noteId: note.id, x: (point?.x || 0) - cardStyle.width / 2, y: (point?.y || 0) - cardStyle.height / 2, width: cardStyle.width, height: cardStyle.height } : null;
    this.selectedNoteId = note.id; this.dispatch({ type: "add-note", note, card });
  }

  placeNote(noteId) {
    if (!this.canEdit) return ui.notifications.warn(this.t("IB.ReadOnly"));
    if (this.cardFor(noteId)) return;
    const note = this.noteFor(noteId); const style = STYLE_REGISTRY[note?.style || "sticky"];
    const rect = this.root.querySelector(".ib-canvas-viewport").getBoundingClientRect(); const center = this.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    this.dispatch({ type: "place-note", card: { noteId, x: center.x - style.width / 2, y: center.y - style.height / 2, width: style.width, height: style.height } });
  }

  createLabel(point) { this.openPrompt(this.t("IB.FreeLabel"), "", text => this.dispatch({ type: "add-label", label: { labelId: uid(), text, x: point.x, y: point.y, size: 28, color: "#d9c9ae" } })); }
  editLabel(labelId) { const label = this.state.layout.labels.find(entry => entry.labelId === labelId); if (label) this.openPrompt(this.t("IB.LabelText"), label.text, text => this.dispatch({ type: "update-label", labelId, patch: { text } }), () => this.dispatch({ type: "delete-label", labelId })); }

  openPrompt(title, value, onSave, onDelete = null) {
    const modal = this.root.querySelector(".ib-journal-modal");
    modal.innerHTML = `<div class="ib-modal-backdrop" data-action="modal-close"></div><form class="ib-modal-card"><h2>${esc(title)}</h2><input name="value" value="${esc(value)}" maxlength="500" autofocus><footer>${onDelete ? `<button type="button" class="ib-danger" data-modal-delete>${esc(this.t("IB.Delete"))}</button>` : ""}<span></span><button type="button" data-action="modal-close">${esc(this.t("IB.Cancel"))}</button><button type="submit" class="ib-primary">${esc(this.t("IB.Save"))}</button></footer></form>`;
    modal.classList.add("is-visible"); const form = modal.querySelector("form");
    form.addEventListener("submit", event => { event.preventDefault(); const text = String(new FormData(form).get("value") || "").trim(); if (!text) return; this.closeModal(); onSave(text); });
    modal.querySelector("[data-modal-delete]")?.addEventListener("click", () => { this.closeModal(); onDelete(); });
    requestAnimationFrame(() => { const input = form.elements.namedItem("value"); input.focus(); input.select(); });
  }
  closeModal() { const modal = this.root.querySelector(".ib-journal-modal"); modal.classList.remove("is-visible"); modal.innerHTML = ""; }

  openLinkPopover(sourceId, linkId, clientX, clientY) {
    const source = this.noteFor(sourceId); const link = source?.links.find(entry => entry.id === linkId); if (!link) return;
    const popover = this.root.querySelector(".ib-link-popover");
    popover.dataset.sourceId = sourceId; popover.dataset.linkId = linkId;
    popover.innerHTML = `<label>${esc(this.t("IB.LinkLabel"))}<input name="label" value="${esc(link.label)}"></label><label>${esc(this.t("IB.Direction"))}<select name="direction"><option value="none">${esc(this.t("IB.DirectionNone"))}</option><option value="one">${esc(this.t("IB.DirectionOne"))}</option><option value="two">${esc(this.t("IB.DirectionTwo"))}</option></select></label><label>${esc(this.t("IB.LineStyle"))}<select name="lineStyle"><option value="solid">${esc(this.t("IB.Solid"))}</option><option value="dashed">${esc(this.t("IB.Dashed"))}</option></select></label><label>${esc(this.t("IB.Color"))}<input name="color" type="color" value="${esc(link.color)}"></label><footer><button type="button" class="ib-danger" data-action="delete-link"><i class="fa-solid fa-trash"></i></button><button type="button" class="ib-primary" data-action="save-link">${esc(this.t("IB.Save"))}</button></footer>`;
    popover.querySelector("[name='direction']").value = link.direction; popover.querySelector("[name='lineStyle']").value = link.lineStyle;
    const appRect = this.root.getBoundingClientRect(); popover.style.left = `${clamp(clientX - appRect.left, 10, appRect.width - 250)}px`; popover.style.top = `${clamp(clientY - appRect.top, 60, appRect.height - 300)}px`; popover.classList.add("is-visible");
  }
  saveLinkPopover() { const popover = this.root.querySelector(".ib-link-popover"); const data = { label: popover.querySelector("[name='label']").value, direction: popover.querySelector("[name='direction']").value, lineStyle: popover.querySelector("[name='lineStyle']").value, color: popover.querySelector("[name='color']").value }; this.dispatch({ type: "update-link", sourceId: popover.dataset.sourceId, linkId: popover.dataset.linkId, patch: data }); popover.classList.remove("is-visible"); }
  deleteLinkPopover() { const popover = this.root.querySelector(".ib-link-popover"); this.dispatch({ type: "delete-link", sourceId: popover.dataset.sourceId, linkId: popover.dataset.linkId }); popover.classList.remove("is-visible"); }

  requestBlockLock(noteId, blockId) {
    if (!this.canEdit) return ui.notifications.warn(this.t("IB.ReadOnly"));
    const key = this.lockKey(noteId, blockId); this.pendingBlockKey = key; this.renderEditor();
    const packet = { type: "lock-request", noteId, blockId, userId: game.user.id };
    if (this.isAuthority) this.handleLockRequest(packet); else game.socket.emit(SOCKET, packet);
  }

  handleLockRequest(packet) {
    if (!this.isAuthority) return;
    this.clearExpiredLocks(); const key = this.lockKey(packet.noteId, packet.blockId); const existing = this.locks.get(key); const actor = this.user(packet.userId);
    const valid = actor?.active && this.noteFor(packet.noteId)?.blocks.some(block => block.blockId === packet.blockId);
    const granted = Boolean(valid && (!existing || existing.userId === packet.userId));
    if (granted) this.locks.set(key, { noteId: packet.noteId, blockId: packet.blockId, userId: packet.userId, userName: actor.name, expiresAt: Date.now() + this.lockTimeout });
    if (packet.userId === game.user.id) this.onLockResult({ granted, noteId: packet.noteId, blockId: packet.blockId, lock: this.locks.get(key) });
    else game.socket.emit(SOCKET, { type: "lock-result", targetUserId: packet.userId, granted, noteId: packet.noteId, blockId: packet.blockId, lock: this.locks.get(key), userId: game.user.id });
    this.broadcastLocks();
  }

  onLockResult(packet) {
    const key = this.lockKey(packet.noteId, packet.blockId); this.pendingBlockKey = null;
    if (packet.granted) { this.editingBlockKey = key; const block = this.noteFor(packet.noteId)?.blocks.find(entry => entry.blockId === packet.blockId); this.drafts.set(key, block?.text || ""); this.renderEditor(); requestAnimationFrame(() => this.root?.querySelector("[data-block-draft]")?.focus()); }
    else { this.renderEditor(); ui.notifications.warn(this.f("IB.LockDenied", { name: packet.lock?.userName || this.t("IB.UnknownUser") })); }
  }

  saveBlock(noteId, blockId) {
    const key = this.lockKey(noteId, blockId); const text = this.drafts.get(key) ?? "";
    this.dispatch({ type: "save-block", noteId, blockId, text }, { optimistic: false }); this.editingBlockKey = null; this.pendingBlockKey = null; this.drafts.delete(key); this.renderEditor();
  }
  deleteBlock(noteId, blockId) { const key = this.lockKey(noteId, blockId); this.dispatch({ type: "delete-block", noteId, blockId }, { optimistic: false }); this.editingBlockKey = null; this.drafts.delete(key); this.renderEditor(); }
  moveBlock(noteId, blockId, direction) { const key = this.lockKey(noteId, blockId); this.dispatch({ type: "move-block", noteId, blockId, direction, text: this.drafts.get(key) ?? "" }, { optimistic: false }); this.editingBlockKey = null; this.drafts.delete(key); this.renderEditor(); }
  cancelBlock(noteId, blockId) { const key = this.lockKey(noteId, blockId); this.drafts.delete(key); this.editingBlockKey = null; this.releaseLock(key); this.renderEditor(); }
  addBlock(noteId) { const block = { blockId: uid(), text: "" }; this.dispatch({ type: "add-block", noteId, block }); setTimeout(() => this.requestBlockLock(noteId, block.blockId), 100); }

  releaseLock(key) {
    const lock = this.locks.get(key); if (!lock) return;
    if (this.isAuthority) { this.locks.delete(key); this.broadcastLocks(); }
    else game.socket.emit(SOCKET, { type: "lock-release", noteId: lock.noteId, blockId: lock.blockId, userId: game.user.id });
  }
  clearExpiredLocks() { const now = Date.now(); let changed = false; for (const [key, lock] of this.locks) if (lock.expiresAt <= now || !this.user(lock.userId)?.active) { this.locks.delete(key); changed = true; } if (changed) this.broadcastLocks(); }
  broadcastLocks() { if (this.isAuthority) game.socket.emit(SOCKET, { type: "lock-sync", locks: [...this.locks.values()], userId: game.user.id }); }

  dispatch(action, options = {}) {
    if (!this.canEdit) return ui.notifications.warn(this.t("IB.ReadOnly"));
    const { optimistic = true, render = true, alreadyApplied = false } = options;
    if (this.isAuthority) {
      if (!alreadyApplied && !this.applyAction(action, game.user.id)) return;
      if (alreadyApplied) this.recordActionEvent(action, game.user.id);
      if (render) this.renderAll(); this.persistAndBroadcast(); return;
    }
    if (optimistic && !alreadyApplied) this.applyAction(action, game.user.id);
    if (render && optimistic) this.renderAll();
    this.setStatus("saving", this.t("IB.Saving")); game.socket.emit(SOCKET, { type: "action", action, userId: game.user.id, nonce: uid() });
  }

  applyAction(action, actorId) {
    if (!action || typeof action !== "object") return false;
    const note = this.noteFor(action.noteId);
    switch (action.type) {
      case "add-note": { if (this.noteFor(action.note?.id)) return false; const added = normalizeNote(action.note); this.state.notes.push(added); if (action.card) this.state.layout.cards.push({ ...action.card }); this.recordEvent("note-created", actorId, added.id); return true; }
      case "update-note": { if (!note || note.deleted) return false; const allowed = ["title", "style", "image"]; for (const field of allowed) if (Object.hasOwn(action.patch || {}, field)) note[field] = action.patch[field]; note.title = String(note.title || "").slice(0, 240); note.style = Object.hasOwn(STYLE_REGISTRY, note.style) ? note.style : "sticky"; note.image = String(note.image || "").slice(0, 4000); note.updatedAt = Date.now(); this.recordEvent("note-updated", actorId, note.id); return true; }
      case "add-block": { if (!note || note.deleted) return false; note.blocks.push(normalizeBlock(action.block)); note.updatedAt = Date.now(); return true; }
      case "save-block": { if (!note || note.deleted) return false; const block = note.blocks.find(entry => entry.blockId === action.blockId); if (!block) return false; const oldLength = block.text.length; block.text = String(action.text || "").slice(0, 30000); const added = Math.max(0, block.text.length - oldLength); note.contributions[actorId] = (note.contributions[actorId] || 0) + added; note.updatedAt = Date.now(); note.editCount += 1; this.syncTypedLinks(note, actorId); this.recordEvent("block-saved", actorId, note.id, added); this.locks.delete(this.lockKey(note.id, block.blockId)); this.broadcastLocks(); return true; }
      case "delete-block": { if (!note || note.deleted) return false; const index = note.blocks.findIndex(block => block.blockId === action.blockId); if (index < 0) return false; note.blocks.splice(index, 1); note.updatedAt = Date.now(); note.editCount += 1; this.syncTypedLinks(note, actorId); this.locks.delete(this.lockKey(note.id, action.blockId)); this.broadcastLocks(); this.recordEvent("block-deleted", actorId, note.id); return true; }
      case "move-block": { if (!note || note.deleted) return false; const index = note.blocks.findIndex(block => block.blockId === action.blockId); const target = clamp(index + (Number(action.direction) < 0 ? -1 : 1), 0, note.blocks.length - 1); if (index < 0 || index === target) return false; const block = note.blocks[index]; const oldLength = block.text.length; block.text = String(action.text || block.text).slice(0, 30000); const added = Math.max(0, block.text.length - oldLength); note.contributions[actorId] = (note.contributions[actorId] || 0) + added; note.blocks.splice(index, 1); note.blocks.splice(target, 0, block); note.updatedAt = Date.now(); note.editCount += 1; this.syncTypedLinks(note, actorId); this.locks.delete(this.lockKey(note.id, action.blockId)); this.broadcastLocks(); this.recordEvent("block-moved", actorId, note.id, added); return true; }
      case "place-note": { if (!this.noteFor(action.card?.noteId) || this.cardFor(action.card.noteId)) return false; this.state.layout.cards.push({ ...action.card }); return true; }
      case "unplace-note": { const index = this.state.layout.cards.findIndex(card => card.noteId === action.noteId); if (index < 0) return false; this.state.layout.cards.splice(index, 1); return true; }
      case "move-card": { const card = this.cardFor(action.noteId); if (!card) return false; card.x = Number(action.x) || 0; card.y = Number(action.y) || 0; this.recordActionEvent(action, actorId); return true; }
      case "resize-card": { const card = this.cardFor(action.noteId); if (!card) return false; card.width = clamp(Number(action.width) || card.width, 180, 800); card.height = clamp(Number(action.height) || card.height, 120, 800); return true; }
      case "add-label": this.state.layout.labels.push({ ...action.label }); return true;
      case "update-label": { const label = this.state.layout.labels.find(entry => entry.labelId === action.labelId); if (!label) return false; Object.assign(label, action.patch); return true; }
      case "delete-label": { const before = this.state.layout.labels.length; this.state.layout.labels = this.state.layout.labels.filter(entry => entry.labelId !== action.labelId); return before !== this.state.layout.labels.length; }
      case "add-link": { const source = this.noteFor(action.sourceId); if (!source || !this.noteFor(action.link?.targetId) || source.links.some(link => link.targetId === action.link.targetId)) return false; source.links.push(normalizeLink(action.link)); this.recordEvent("link-drawn", actorId, source.id); return true; }
      case "update-link": { const source = this.noteFor(action.sourceId); const link = source?.links.find(entry => entry.id === action.linkId); if (!link) return false; Object.assign(link, { label: String(action.patch.label || "").slice(0, 160), direction: ["none", "one", "two"].includes(action.patch.direction) ? action.patch.direction : "none", lineStyle: action.patch.lineStyle === "dashed" ? "dashed" : "solid", color: safeColor(action.patch.color), origin: "drawn" }); return true; }
      case "delete-link": { const source = this.noteFor(action.sourceId); const before = source?.links.length || 0; if (!source) return false; source.links = source.links.filter(link => link.id !== action.linkId); return before !== source.links.length; }
      case "trash-note": { if (!note || note.deleted) return false; note.deleted = true; note.deletedAt = Date.now(); note.deletedBy = actorId; const previousCard = this.cardFor(note.id); note.trashPosition = previousCard ? clone(previousCard) : null; this.state.layout.cards = this.state.layout.cards.filter(card => card.noteId !== note.id); this.recordEvent("note-trashed", actorId, note.id); return true; }
      case "restore-note": { if (!note?.deleted) return false; note.deleted = false; note.deletedAt = null; note.deletedBy = ""; if (note.trashPosition && !this.cardFor(note.id) && this.positionIsFree(note.trashPosition)) this.state.layout.cards.push(note.trashPosition); note.trashPosition = null; this.recordEvent("note-restored", actorId, note.id); return true; }
      case "purge-trash": { const deletedIds = new Set(this.state.notes.filter(entry => entry.deleted).map(entry => entry.id)); this.state.notes = this.state.notes.filter(entry => !deletedIds.has(entry.id)); for (const source of this.state.notes) source.links = source.links.filter(link => !deletedIds.has(link.targetId)); if (deletedIds.has(this.selectedNoteId)) this.selectedNoteId = null; return deletedIds.size > 0; }
      default: return false;
    }
  }

  positionIsFree(candidate) { return !this.state.layout.cards.some(card => !(candidate.x + candidate.width < card.x || card.x + card.width < candidate.x || candidate.y + candidate.height < card.y || card.y + card.height < candidate.y)); }
  recordActionEvent(action, actorId) { if (["move-card", "resize-card"].includes(action.type)) this.recordEvent(action.type, actorId, action.noteId); }
  recordEvent(type, userId, noteId = "", amount = 0) { this.state.events.push({ id: uid(), type, userId, noteId, amount, timestamp: Date.now() }); this.state.events = this.state.events.slice(-2000); }

  syncTypedLinks(note, actorId) {
    const refs = note.blocks.flatMap(block => parseWikiLinks(block.text)); const desired = new Map();
    for (const ref of refs) { const matches = this.state.notes.filter(target => !target.deleted && target.id !== note.id && target.title.trim().toLocaleLowerCase() === ref.title.toLocaleLowerCase()); if (matches.length === 1) desired.set(matches[0].id, ref.label); }
    note.links = note.links.filter(link => link.origin !== "typed" || desired.has(link.targetId));
    for (const [targetId, label] of desired) { const existing = note.links.find(link => link.origin === "typed" && link.targetId === targetId); if (existing) existing.label = label; else note.links.push(normalizeLink({ id: uid(), targetId, label, direction: "one", color: "#8796a5", lineStyle: "dashed", origin: "typed", authorId: actorId })); }
  }

  async persistAndBroadcast() {
    if (!this.isAuthority) return;
    this.state.revision += 1; const snapshot = clone(this.state); this.setStatus("saving", this.t("IB.Saving"));
    this.saveChain = this.saveChain.then(async () => { try { await game.settings.set(MODULE_ID, STATE_KEY, snapshot); this.broadcastState(snapshot); this.setStatus("ready", this.t("IB.Saved")); } catch (error) { console.error(`${MODULE_ID} | Save failed`, error); this.setStatus("warning", error.message); } });
    return this.saveChain;
  }

  filterStateForUser(state, userId) {
    const user = this.user(userId); if (user?.isGM) return clone(state);
    const filtered = clone(state); filtered.notes = filtered.notes.filter(note => note.visibility !== "gm"); const ids = new Set(filtered.notes.map(note => note.id));
    for (const note of filtered.notes) { note.blocks = note.blocks.filter(block => !block.hidden); note.links = note.links.filter(link => ids.has(link.targetId)); }
    filtered.layout.cards = filtered.layout.cards.filter(card => ids.has(card.noteId)); return filtered;
  }

  broadcastState(snapshot = this.state, targetUserId = null) {
    const filtered = this.filterStateForUser(snapshot, targetUserId || "");
    game.socket.emit(SOCKET, { type: "state", state: filtered, targetUserId, userId: game.user.id });
  }

  async onSocket(packet) {
    if (!packet || packet.userId === game.user.id) return;
    if (packet.type === "request-state" && this.isAuthority) return this.broadcastState(this.state, packet.userId);
    if (packet.type === "state") { if (packet.userId !== this.authority?.id || (packet.targetUserId && packet.targetUserId !== game.user.id) || packet.state?.revision < this.state.revision) return; this.state = normalizeState(packet.state); this.renderAll(); return; }
    if (packet.type === "action" && this.isAuthority) return this.receiveAction(packet);
    if (packet.type === "lock-request" && this.isAuthority) return this.handleLockRequest(packet);
    if (packet.type === "lock-result" && packet.targetUserId === game.user.id) return this.onLockResult(packet);
    if (packet.type === "lock-sync" && packet.userId === this.authority?.id) { this.locks = new Map((packet.locks || []).map(lock => [this.lockKey(lock.noteId, lock.blockId), lock])); this.renderEditor(); return; }
    if (packet.type === "lock-release" && this.isAuthority) { const key = this.lockKey(packet.noteId, packet.blockId); if (this.locks.get(key)?.userId === packet.userId) { this.locks.delete(key); this.broadcastLocks(); } }
  }

  async receiveAction(packet) {
    const actor = this.user(packet.userId); if (!actor?.active) return;
    const action = packet.action;
    if (["save-block", "delete-block", "move-block"].includes(action?.type)) { const lock = this.locks.get(this.lockKey(action.noteId, action.blockId)); if (lock?.userId !== packet.userId) return; }
    if (action?.type === "purge-trash" && !actor.isGM) return;
    if (this.applyAction(action, packet.userId)) { this.renderAll(); await this.persistAndBroadcast(); }
  }
}

let controller = null;
let JournalApplication = null;
let journalApp = null;

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, STATE_KEY, { name: "Collaborative journal data", hint: "Notes, layout, links, and activity.", scope: "world", config: false, type: Object, default: emptyState() });
  game.settings.register(MODULE_ID, LEGACY_KEY, { name: "Legacy board data", hint: "Used once for migration.", scope: "world", config: false, type: Object, default: { schema: 1, revision: 0, boards: [] } });
  game.settings.register(MODULE_ID, "lockTimeout", { name: "IB.LockTimeout", hint: "IB.LockTimeoutHint", scope: "world", config: true, type: Number, range: { min: 15, max: 300, step: 15 }, default: 90 });

  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
  JournalApplication = class extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = { id: "investigation-board-journal", classes: ["ib-journal-app"], tag: "section", window: { frame: false, positioned: false } };
    static PARTS = { main: { template: `modules/${MODULE_ID}/templates/journal.hbs` } };
    async _prepareContext(options) { return { ...(await super._prepareContext(options)) }; }
    _onRender(context, options) { super._onRender(context, options); controller?.mount(this.element, this); }
    _onClose(options) { controller?.unmount(); journalApp = null; return super._onClose(options); }
  };
});

async function toggleJournal(force = null) {
  if (journalApp?.rendered) { if (force === true) return journalApp.bringToFront(); await journalApp.close(); return; }
  if (force === false) return;
  journalApp = new JournalApplication(); await journalApp.render({ force: true });
}

Hooks.once("ready", async () => {
  let state = normalizeState(game.settings.get(MODULE_ID, STATE_KEY));
  const legacy = game.settings.get(MODULE_ID, LEGACY_KEY);
  const migrated = !state.notes.length && legacy?.boards?.[0]?.cards?.length;
  if (migrated) state = migrateLegacy(legacy);
  controller = new JournalController(state); controller.initialize();
  game.modules.get(MODULE_ID).api = { open: () => toggleJournal(true), close: () => toggleJournal(false), toggle: () => toggleJournal(), getState: () => clone(controller.state), styles: STYLE_REGISTRY };
  if (migrated && controller.isAuthority) { await controller.persistAndBroadcast(); ui.notifications.info(controller.t("IB.Migrated")); }
  window.addEventListener("keydown", event => { if (event.ctrlKey && event.shiftKey && event.code === "KeyI") { event.preventDefault(); toggleJournal(); } });
  console.log(`${MODULE_ID} | Collaborative Journal ready for Foundry VTT ${game.version}`);
});

Hooks.on("getSceneControlButtons", controls => {
  const control = controls.tokens || controls.notes || Object.values(controls)[0]; if (!control?.tools) return;
  control.tools.investigationJournal = { name: "investigationJournal", title: "IB.Open", icon: "fa-solid fa-diagram-project", order: Object.keys(control.tools).length, button: true, visible: true, onChange: () => toggleJournal() };
});
