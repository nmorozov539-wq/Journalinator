import { notesStore } from "../store/notes-store.mjs";
import { requestWrite } from "../socket.mjs";
import JournalCanvas from "./canvas.mjs";
import NoteEditor from "./editor.mjs";

const { ApplicationV2 } = foundry.applications.api;

/**
 * Fullscreen app: a top bar (title, search, + New Note, + Label), the note canvas taking the
 * center, and an editor panel on the right. Raw DOM render — no Handlebars — since ApplicationV2
 * supports that directly by implementing _renderHTML/_replaceHTML ourselves.
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
  #hookIds = [];
  #editor = new NoteEditor({
    onFocusNote: id => this.#canvas.focusNote(id)
  });
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
    this.#hookIds.push(["journalinatorLocksChanged", Hooks.on("journalinatorLocksChanged", rerender)]);
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
      gmOnline: !!game.users.activeGM
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
      ${!context.gmOnline ? `<div class="journalinator-offline-banner">Read-only — the GM is offline</div>` : ""}
      <div class="journalinator-body">
        <div class="journalinator-canvas-slot"></div>
        <aside class="journalinator-editor"></aside>
      </div>
    `;

    root.querySelector(".journalinator-canvas-slot").appendChild(this.#canvas.root);
    this.#canvas.selectedNoteId = this.#selectedNoteId;
    this.#canvas.update(context.allNotes, context.layout);

    this.#editor.open(this.#selectedNoteId);
    root.querySelector(".journalinator-editor").appendChild(this.#editor.root);
    this.#editor.render();

    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  _onRender() {
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
