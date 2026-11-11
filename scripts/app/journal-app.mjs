import { notesStore } from "../store/notes-store.mjs";
import { requestWrite } from "../socket.mjs";
import JournalCanvas from "./canvas.mjs";
import NoteEditor from "./editor.mjs";
import { computeJournalStats, deriveSessions } from "../stats.mjs";
import { CARD_STYLES } from "../styles/registry.mjs";
import { canUseGmTier } from "../secrets/access.mjs";
import { vaultStore } from "../secrets/vault-store.mjs";
import { openVaultDialog } from "../secrets/vault-ui.mjs";
import * as secrets from "../secrets/secret-actions.mjs";
import { t } from "../i18n.mjs";

/** Runs a GM vault action and surfaces failures (e.g. the vault was locked meanwhile). */
function gm(job) {
  return Promise.resolve().then(job).catch(err => {
    console.error(err);
    ui.notifications.error(err.message);
  });
}

const { ApplicationV2 } = foundry.applications.api;

/**
 * Fullscreen app: a top bar (title, quick switcher, + New Note, + Label, Trash, Stats, preview
 * toggle), a filter-chip row, the note canvas taking the center, and an editor panel on the
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

  #selectedNoteId = null;
  #query = "";
  #filterAuthors = new Set();
  #filterStyles = new Set();
  #switcherOpen = false;
  #switcherHighlight = 0;
  #hookIds = [];
  #onGlobalKeydown = null;
  #searchBlurTimer = null;
  #editor = new NoteEditor({
    onFocusNote: id => this.#canvas.focusNote(id),
    onSelectNote: id => { this.#selectedNoteId = id; this.render(); }
  });
  // Every canvas action is routed by what it touches: GM-only things go to the vault in this
  // client, everything else is a normal shared write request (spec §14).
  #canvas = new JournalCanvas({
    onSelectNote: id => { this.#selectedNoteId = id; this.render(); },
    onEditNote: id => {
      this.#selectedNoteId = id;
      this.render();
      this.#editor.editFirstBlock(id);
    },
    onCreateNoteAt: (x, y, { secret = false, kind = "note" } = {}) => {
      const title = kind === "location" ? t("JN.Note.NewLocationTitle") : t("JN.Note.NewNoteTitle");
      if (secret) return gm(async () => this.#select(await secrets.createSecretNote({ title, kind, x, y })));
      requestWrite({ type: "createNote", title, kind, x, y, autoTitle: true });
    },
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
    onCreateLink: (sourceId, targetId) => (notesStore.isSecretNote(sourceId) || notesStore.isSecretNote(targetId))
      ? gm(() => secrets.addHiddenLink(sourceId, targetId))
      : requestWrite({ type: "createLink", sourceId, targetId }),
    onUpdateLink: (noteId, linkId, fields) => notesStore.isHiddenLink(noteId, linkId)
      ? gm(() => secrets.updateHiddenLink(noteId, linkId, fields))
      : requestWrite({ type: "updateLink", noteId, linkId, fields }),
    onDeleteLink: (noteId, linkId) => notesStore.isHiddenLink(noteId, linkId)
      ? gm(() => secrets.deleteHiddenLink(noteId, linkId))
      : requestWrite({ type: "deleteLink", noteId, linkId }),
    onHideLink: (noteId, linkId) => gm(() => secrets.hideSharedLink(noteId, linkId)),
    onRevealLink: (noteId, linkId) => gm(() => secrets.revealLink(noteId, linkId)),
    onToggleLinkHint: (noteId, linkId, hint) => requestWrite({ type: "gmSetLinkHint", noteId, linkId, hint })
  });

  #select(noteId) {
    if (!noteId) return;
    this.#selectedNoteId = noteId;
    this.render();
  }

  _onFirstRender() {
    this.#editor.activate();
    const rerender = () => this.render();
    for (const hook of [
      "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage",
      "updateJournalEntry"
    ]) {
      this.#hookIds.push([hook, Hooks.on(hook, rerender)]);
    }
    this.#hookIds.push(["journalinatorLocksChanged", Hooks.on("journalinatorLocksChanged", rerender)]);
    this.#hookIds.push(["journalinatorVaultChanged", Hooks.on("journalinatorVaultChanged", rerender)]);

    this.#onGlobalKeydown = ev => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "k") {
        ev.preventDefault();
        const input = this.element.querySelector(".journalinator-search");
        input?.focus();
        input?.select();
      }
    };
    addEventListener("keydown", this.#onGlobalKeydown);
  }

  _onClose() {
    this.#editor.deactivate();
    clearTimeout(this.#searchBlurTimer);
    this.#searchBlurTimer = null;
    for (const [hook, id] of this.#hookIds) Hooks.off(hook, id);
    this.#hookIds = [];
    if (this.#onGlobalKeydown) removeEventListener("keydown", this.#onGlobalKeydown);
    this.#onGlobalKeydown = null;
  }

  #matchesQuery(note, q) {
    if (!q) return true;
    const author = game.users.get(note.system.authorId)?.name ?? "";
    const haystack = `${note.name} ${note.system.blocks.map(b => b.text).join(" ")} ${author}`.toLowerCase();
    return haystack.includes(q);
  }

  #matchesFilters(note) {
    if (this.#filterAuthors.size && !this.#filterAuthors.has(note.system.authorId)) return false;
    if (this.#filterStyles.size && !this.#filterStyles.has(note.system.style)) return false;
    return true;
  }

  async _prepareContext() {
    const notes = notesStore.getAllNotes();
    const q = this.#query.trim().toLowerCase();
    const authors = [...new Map(notes.map(n => [n.system.authorId, game.users.get(n.system.authorId)])).entries()]
      .filter(([, u]) => u);
    return {
      allNotes: notes,
      layout: notesStore.getLayout(),
      gmOnline: !!game.users.activeGM,
      gmTier: canUseGmTier(),
      vaultStatus: vaultStore.status,
      merged: notesStore.merged,
      trashCount: notesStore.getTrashedNotes().length,
      authors,
      query: q
    };
  }

  async _renderHTML(context) {
    const root = document.createElement("div");
    root.className = `journalinator-root${context.merged ? " jn-gm-view" : ""}`;
    root.innerHTML = `
      <header class="journalinator-topbar">
        <b>${t("JN.Title")}</b>
        <div class="journalinator-search-wrap">
          <input type="search" class="journalinator-search" placeholder="${t("JN.TopBar.Search")}" value="${foundry.utils.escapeHTML(this.#query)}">
          <div class="jn-switcher"></div>
        </div>
        <button type="button" class="journalinator-new">${t("JN.TopBar.NewNote")}</button>
        <button type="button" class="journalinator-add-label">${t("JN.TopBar.AddLabel")}</button>
        <button type="button" class="journalinator-trash">${context.trashCount ? t("JN.TopBar.TrashCount", { count: context.trashCount }) : t("JN.TopBar.Trash")}</button>
        <button type="button" class="journalinator-stats">${t("JN.TopBar.Stats")}</button>
        ${context.gmTier ? this.#gmControlsHTML(context) : ""}
      </header>
      <div class="journalinator-filterbar">
        ${context.authors.map(([id, u]) => `<button type="button" class="jn-filter-chip${this.#filterAuthors.has(id) ? " on" : ""}" data-kind="author" data-id="${id}"><span class="jn-dot" style="background:${u.color}"></span>${foundry.utils.escapeHTML(u.name)}</button>`).join("")}
        <span class="jn-filter-sep"></span>
        ${Object.entries(CARD_STYLES).map(([key, def]) => `<button type="button" class="jn-filter-chip${this.#filterStyles.has(key) ? " on" : ""}" data-kind="style" data-id="${key}">${t(def.labelKey)}</button>`).join("")}
      </div>
      ${!context.gmOnline ? `<div class="journalinator-offline-banner">${t("JN.TopBar.Offline")}</div>` : ""}
      <div class="journalinator-body">
        <div class="journalinator-canvas-slot"></div>
        <aside class="journalinator-editor"></aside>
      </div>
    `;

    root.querySelector(".journalinator-canvas-slot").appendChild(this.#canvas.root);
    this.#canvas.selectedNoteId = this.#selectedNoteId;
    this.#canvas.gmMode = context.merged;
    this.#canvas.update(context.allNotes, context.layout, {
      dimMatch: note => this.#matchesQuery(note, context.query) && this.#matchesFilters(note)
    });

    this.#editor.open(this.#selectedNoteId);
    root.querySelector(".journalinator-editor").appendChild(this.#editor.root);
    this.#editor.render();

    if (this.#switcherOpen) this.#renderSwitcher(root, context.allNotes);

    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  _onRender() {
    const root = this.element;

    const search = root.querySelector(".journalinator-search");
    search?.addEventListener("input", ev => {
      this.#query = ev.target.value;
      this.#switcherOpen = true;
      this.#switcherHighlight = 0;
      this.render();
    });
    search?.addEventListener("focus", () => {
      if (this.#switcherOpen) return; // already open — avoid the focus()-in-onRender loop below
      this.#switcherOpen = true;
      this.render();
    });
    search?.addEventListener("blur", () => {
      // let a dropdown click register before closing
      clearTimeout(this.#searchBlurTimer);
      this.#searchBlurTimer = setTimeout(() => { this.#switcherOpen = false; this.render(); }, 150);
    });
    search?.addEventListener("keydown", ev => this.#onSearchKeydown(ev));

    // _replaceHTML swaps in a brand new <input> every render, which drops focus — put it back
    // (cursor at the end) whenever the user was actively using the search/switcher.
    if (search && this.#switcherOpen) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }

    root.querySelector(".journalinator-new")?.addEventListener("click", () => {
      requestWrite({
        type: "createNote", title: t("JN.Note.NewNoteTitle"), kind: "note",
        ...this.#canvas.newCardPosition(), autoTitle: true
      });
    });

    root.querySelector(".journalinator-add-label")?.addEventListener("click", () => {
      this.#canvas.addLabelButton();
    });

    root.querySelector(".journalinator-trash")?.addEventListener("click", () => this.#openTrash());

    root.querySelector(".journalinator-vault")?.addEventListener("click", () => openVaultDialog());
    root.querySelector(".journalinator-view-toggle")?.addEventListener("click", () => {
      notesStore.setGmView(!notesStore.gmView);
    });
    root.querySelector(".journalinator-new-secret")?.addEventListener("click", async () => {
      const title = await this.#promptText(t("JN.Prompt.NewSecretNote"), "");
      if (!title) return;
      gm(async () => this.#select(await secrets.createSecretNote({ title, ...this.#canvas.newCardPosition() })));
    });
    root.querySelector(".journalinator-add-gm-label")?.addEventListener("click", () => {
      const { x, y } = this.#canvas.newCardPosition(0, 0);
      gm(() => secrets.addHiddenLabel(x, y));
    });
    root.querySelector(".journalinator-stats")?.addEventListener("click", () => this.#openStats());

    root.querySelectorAll(".jn-filter-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        const set = btn.dataset.kind === "author" ? this.#filterAuthors : this.#filterStyles;
        if (set.has(btn.dataset.id)) set.delete(btn.dataset.id); else set.add(btn.dataset.id);
        this.render();
      });
    });
  }

  #switcherList(allNotes) {
    const q = this.#query.trim().toLowerCase();
    if (!q) return allNotes.slice().sort((a, b) => (b.system.updatedAt ?? 0) - (a.system.updatedAt ?? 0)).slice(0, 6);
    return allNotes.filter(n => this.#matchesQuery(n, q));
  }

  #renderSwitcher(root, allNotes) {
    const q = this.#query.trim();
    const list = this.#switcherList(allNotes);
    const offerCreate = q && !allNotes.some(n => n.name.toLowerCase() === q.toLowerCase());
    this.#switcherHighlight = Math.min(this.#switcherHighlight, list.length - (offerCreate ? 0 : 1));

    const el = root.querySelector(".jn-switcher");
    el.innerHTML = (q ? "" : `<div class="jn-switcher-heading">${t("JN.Switcher.Recent")}</div>`) +
      list.map((n, i) => `
        <div class="jn-switcher-item${i === this.#switcherHighlight ? " hi" : ""}" data-id="${n._id}">
          <span class="jn-dot" style="background:${game.users.get(n.system.authorId)?.color ?? "#8d8d97"}"></span>
          <b>${foundry.utils.escapeHTML(n.name)}</b>
          <small>${n.secret ? t("JN.Switcher.GMOnly") : ""}${CARD_STYLES[n.system.style] ? t(CARD_STYLES[n.system.style].labelKey) : n.system.style}</small>
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
    this.#query = "";
    this.#switcherOpen = false;
    this.#canvas.focusNote(noteId);
  }

  #createFromSwitcher(title) {
    this.#query = "";
    this.#switcherOpen = false;
    requestWrite({ type: "createNote", title, ...this.#canvas.newCardPosition() });
    this.render();
  }

  #onSearchKeydown(ev) {
    if (!this.#switcherOpen) return;
    const allNotes = notesStore.getAllNotes();
    const list = this.#switcherList(allNotes);
    const q = this.#query.trim();
    const offerCreate = q && !allNotes.some(n => n.name.toLowerCase() === q.toLowerCase());
    const count = list.length + (offerCreate ? 1 : 0);

    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!count) return;
      const dir = ev.key === "ArrowDown" ? 1 : -1;
      this.#switcherHighlight = (this.#switcherHighlight + dir + count) % count;
      this.render();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (this.#switcherHighlight < list.length) this.#selectFromSwitcher(list[this.#switcherHighlight]._id);
      else if (offerCreate) this.#createFromSwitcher(q);
      this.render();
    } else if (ev.key === "Escape") {
      this.#query = "";
      this.#switcherOpen = false;
      this.element.querySelector(".journalinator-search")?.blur();
      this.render();
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
    const trashed = notesStore.getTrashedNotes();
    const rows = trashed
      .map(n => `<div class="jn-trash-row"><span>${foundry.utils.escapeHTML(n.name)}</span><button type="button" class="jn-trash-restore" data-id="${n._id}">${t("JN.Common.Restore")}</button></div>`)
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
      ok: {
        label: t("JN.Common.OK"),
        callback: (event, button) => button.form.elements.value.value.trim()
      },
      rejectClose: false
    });
  }
}
