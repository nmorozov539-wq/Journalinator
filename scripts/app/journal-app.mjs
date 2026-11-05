import { notesStore } from "../store/notes-store.mjs";
import { requestWrite } from "../socket.mjs";
import JournalCanvas from "./canvas.mjs";
import { CARD_STYLES } from "../styles/registry.mjs";

const { ApplicationV2 } = foundry.applications.api;

/**
 * Fullscreen app: a top bar (title, search, + New Note, + Label), the note canvas taking the
 * center, and an editor panel on the right. Raw DOM render — no Handlebars — since ApplicationV2
 * supports that directly by implementing _renderHTML/_replaceHTML ourselves.
 *
 * The canvas itself (JournalCanvas) is created once and kept alive across re-renders so a
 * document-sync hook firing elsewhere never resets this client's pan/zoom.
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
  #hookIds = [];
  #canvas = new JournalCanvas({
    onSelectNote: id => { this.#selectedNoteId = id; this.render(); },
    onCreateNoteAt: (x, y) => requestWrite({ type: "createNote", title: "Untitled", x, y }),
    onMoveCard: (noteId, x, y) => requestWrite({ type: "moveCard", noteId, x, y }),
    onResizeCard: (noteId, width, height) => requestWrite({ type: "resizeCard", noteId, width, height }),
    onResetCardSize: noteId => requestWrite({ type: "resizeCard", noteId, width: null, height: null }),
    onAddLabelAt: (x, y) => requestWrite({ type: "addLabel", text: "Label", x, y }),
    onMoveLabel: (labelId, x, y) => requestWrite({ type: "updateLabel", labelId, x, y }),
    onEditLabel: async labelId => {
      const layout = notesStore.getLayout();
      const current = layout?.labels?.[labelId]?.text ?? "";
      const text = await this.#promptText("Edit Label", current);
      if (text === null) return;
      if (text.trim() === "") requestWrite({ type: "removeLabel", labelId });
      else requestWrite({ type: "updateLabel", labelId, text });
    },
    onCreateLink: (sourceId, targetId) => requestWrite({ type: "createLink", sourceId, targetId }),
    onUpdateLink: (noteId, linkId, fields) => requestWrite({ type: "updateLink", noteId, linkId, fields }),
    onDeleteLink: (noteId, linkId) => requestWrite({ type: "deleteLink", noteId, linkId })
  });

  _onFirstRender() {
    const rerender = () => this.render();
    for (const hook of [
      "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage",
      "updateJournalEntry"
    ]) {
      this.#hookIds.push([hook, Hooks.on(hook, rerender)]);
    }
  }

  _onClose() {
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
      allNotes: notes,
      notes: filtered,
      layout: notesStore.getLayout(),
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
        <button type="button" class="journalinator-add-label">+ Label</button>
      </header>
      <div class="journalinator-body">
        <div class="journalinator-canvas-slot"></div>
        <aside class="journalinator-editor"></aside>
      </div>
    `;

    root.querySelector(".journalinator-canvas-slot").appendChild(this.#canvas.root);
    this.#canvas.selectedNoteId = this.#selectedNoteId;
    this.#canvas.update(context.allNotes, context.layout);

    const editor = root.querySelector(".journalinator-editor");
    if (context.selected) {
      const note = context.selected;
      const author = game.users.get(note.system.authorId)?.name ?? "unknown";
      const styleOptions = Object.entries(CARD_STYLES)
        .map(([key, def]) => `<option value="${key}" ${note.system.style === key ? "selected" : ""}>${def.label}</option>`)
        .join("");
      const backlinks = context.allNotes
        .filter(n => (n.system.links ?? []).some(l => l.targetId === note._id))
        .map(n => `<button type="button" class="journalinator-chip" data-id="${n._id}">${foundry.utils.escapeHTML(n.name)}</button>`)
        .join("") || `<small class="journalinator-meta">None yet</small>`;
      editor.innerHTML = `
        <h2>${foundry.utils.escapeHTML(note.name)}</h2>
        <p class="journalinator-meta">by ${foundry.utils.escapeHTML(author)}</p>
        <div class="journalinator-meta">Linked from</div>
        <div class="journalinator-chips">${backlinks}</div>
        <div class="journalinator-row">
          <label>Style <select class="journalinator-style">${styleOptions}</select></label>
        </div>
        <div class="journalinator-row">
          <button type="button" class="journalinator-set-image">${note.system.image ? "Change Image" : "Set Image"}</button>
          ${note.system.image ? `<button type="button" class="journalinator-clear-image">Remove Image</button>` : ""}
          <button type="button" class="journalinator-new-linked">+ New Linked Note</button>
        </div>
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

  _onRender(context) {
    const root = this.element;

    root.querySelector(".journalinator-search")?.addEventListener("input", ev => {
      this.#query = ev.target.value;
      this.render();
    });

    root.querySelector(".journalinator-new")?.addEventListener("click", async () => {
      const title = await this.#promptText("New Note", "");
      if (!title) return;
      requestWrite({ type: "createNote", title });
    });

    root.querySelector(".journalinator-add-label")?.addEventListener("click", () => {
      this.#canvas.addLabelButton();
    });

    root.querySelector(".journalinator-style")?.addEventListener("change", ev => {
      requestWrite({ type: "setNoteStyle", noteId: this.#selectedNoteId, style: ev.target.value });
    });

    root.querySelector(".journalinator-set-image")?.addEventListener("click", () => {
      const note = notesStore.getNote(this.#selectedNoteId);
      new foundry.applications.apps.FilePicker({
        type: "image",
        current: note?.system.image ?? "",
        callback: path => requestWrite({ type: "setNoteImage", noteId: this.#selectedNoteId, image: path })
      }).render(true);
    });

    root.querySelector(".journalinator-clear-image")?.addEventListener("click", () => {
      requestWrite({ type: "setNoteImage", noteId: this.#selectedNoteId, image: null });
    });

    root.querySelector(".journalinator-new-linked")?.addEventListener("click", async () => {
      const title = await this.#promptText("New Linked Note", "");
      if (!title) return;
      requestWrite({ type: "newLinkedNote", sourceId: this.#selectedNoteId, title });
    });

    root.querySelectorAll(".journalinator-chip").forEach(el => {
      el.addEventListener("click", () => this.#canvas.focusNote(el.dataset.id));
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

  async #promptText(title, initial) {
    return foundry.applications.api.DialogV2.prompt({
      window: { title },
      content: `<input type="text" name="value" autofocus value="${foundry.utils.escapeHTML(initial)}">`,
      ok: {
        label: "OK",
        callback: (event, button) => button.form.elements.value.value.trim()
      },
      rejectClose: false
    });
  }
}
