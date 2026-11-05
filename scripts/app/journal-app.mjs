import { notesStore } from "../store/notes-store.mjs";
import { requestWrite } from "../socket.mjs";

const { ApplicationV2 } = foundry.applications.api;

/**
 * Phase 1 shell: a fullscreen app with a top bar (title + search), a plain note list standing
 * in for the canvas (Phase 2 builds the real SVG/drag canvas), and an editor panel. Raw DOM
 * render — no Handlebars — since ApplicationV2 supports that directly by implementing
 * _renderHTML/_replaceHTML ourselves (confirmed in client/applications/api/application.mjs).
 */
export default class JournalApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "journalinator-app",
    classes: ["journalinator"],
    window: {
      title: "Journalinator",
      resizable: true
    },
    position: { width: 1000, height: 700 }
  };

  #selectedNoteId = null;
  #query = "";
  #hookIds = [];

  _onFirstRender(context, options) {
    const rerender = () => this.render();
    for (const hook of ["createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"]) {
      this.#hookIds.push([hook, Hooks.on(hook, rerender)]);
    }
  }

  _onClose(options) {
    for (const [hook, id] of this.#hookIds) Hooks.off(hook, id);
    this.#hookIds = [];
  }

  async _prepareContext() {
    const notes = notesStore.getAllNotes();
    const q = this.#query.trim().toLowerCase();
    const filtered = q
      ? notes.filter(n => (n.name + " " + n.system.blocks.map(b => b.text).join(" ")).toLowerCase().includes(q))
      : notes;
    return {
      notes: filtered,
      selected: this.#selectedNoteId ? notesStore.getNote(this.#selectedNoteId) : null
    };
  }

  async _renderHTML(context) {
    const root = document.createElement("div");
    root.className = "journalinator-root";
    root.innerHTML = `
      <header class="journalinator-topbar">
        <b>Journalinator</b>
        <input type="search" class="journalinator-search" placeholder="Search notes...">
        <button type="button" class="journalinator-new">+ New Note</button>
      </header>
      <div class="journalinator-body">
        <div class="journalinator-list"></div>
        <aside class="journalinator-editor"></aside>
      </div>
    `;

    const list = root.querySelector(".journalinator-list");
    for (const note of context.notes) {
      const item = document.createElement("div");
      item.className = "journalinator-item";
      item.dataset.id = note._id;
      const excerpt = (note.system.blocks[0]?.text ?? "").slice(0, 80);
      item.innerHTML = `<b>${foundry.utils.escapeHTML(note.name)}</b><p>${foundry.utils.escapeHTML(excerpt)}</p>`;
      list.appendChild(item);
    }

    const editor = root.querySelector(".journalinator-editor");
    if (context.selected) {
      const note = context.selected;
      editor.innerHTML = `
        <h2>${foundry.utils.escapeHTML(note.name)}</h2>
        <p class="journalinator-meta">by ${foundry.utils.escapeHTML(game.users.get(note.system.authorId)?.name ?? "unknown")}</p>
        <textarea class="journalinator-textarea">${foundry.utils.escapeHTML(note.system.blocks.map(b => b.text).join("\n\n"))}</textarea>
        <button type="button" class="journalinator-save">Save</button>
      `;
    } else {
      editor.innerHTML = `<p class="journalinator-empty">Select a note to open it.</p>`;
    }

    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  _onRender(context, options) {
    const root = this.element;

    root.querySelector(".journalinator-search")?.addEventListener("input", ev => {
      this.#query = ev.target.value;
      this.render();
    });

    root.querySelector(".journalinator-new")?.addEventListener("click", async () => {
      const title = await this.#promptTitle();
      if (!title) return;
      requestWrite({ type: "createNote", title });
    });

    root.querySelectorAll(".journalinator-item").forEach(el => {
      el.addEventListener("click", () => {
        this.#selectedNoteId = el.dataset.id;
        this.render();
      });
    });

    root.querySelector(".journalinator-save")?.addEventListener("click", () => {
      const textarea = root.querySelector(".journalinator-textarea");
      const note = notesStore.getNote(this.#selectedNoteId);
      if (!note) return;
      const blocks = textarea.value.split("\n\n").map((text, i) => ({
        blockId: note.system.blocks[i]?.blockId ?? foundry.utils.randomID(),
        text
      }));
      requestWrite({ type: "saveNote", noteId: this.#selectedNoteId, blocks });
    });
  }

  async #promptTitle() {
    return foundry.applications.api.DialogV2.prompt({
      window: { title: "New Note" },
      content: `<input type="text" name="title" autofocus placeholder="Note title">`,
      ok: {
        label: "Create",
        callback: (event, button) => button.form.elements.title.value.trim()
      }
    });
  }
}
