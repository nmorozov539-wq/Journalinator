/**
 * Shared note history modal.
 *
 * The list is newest-first with a distinct `Current version` row. Selecting a row renders that
 * version through the T1 document renderer and Foundry's sanitizer. Restore is a text-only,
 * lease-protected operation: begin a fresh edit session, capture the current body with T5
 * `recordPreRestore`, save the selected body as the next revision, then end the lease.
 *
 * No geometry, links, skin, author identity or thread state is restored from history.
 */
import { listHistory, recordPreRestore as recordSharedPreRestore } from "../history.mjs";
import { renderNoteBody } from "../document/index.mjs";
import { t as defaultT } from "../i18n.mjs";

function escapeHTML(value) {
  const escape = globalThis.foundry?.utils?.escapeHTML;
  if (typeof escape === "function") return String(escape(value));
  return String(value ?? "").replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

function dateText(at) {
  return Number.isFinite(at) && at > 0
    ? new Date(at).toLocaleString(globalThis.game?.i18n?.lang || undefined)
    : "";
}

function noteSnapshot(note) {
  const system = note?.system ?? note ?? {};
  return {
    body: typeof system.body === "string" ? system.body : "",
    revision: Number.isInteger(system.revision) ? system.revision : 0,
    layout: system.layout === "profile" ? "profile" : "plain",
    authorId: typeof system.authorId === "string" ? system.authorId : "",
    updatedAt: Number.isFinite(system.updatedAt) ? system.updatedAt : 0,
    createdAt: Number.isFinite(system.createdAt) ? system.createdAt : 0
  };
}

/**
 * Builds the displayed versions: current first, then stored snapshots newest-first without a
 * duplicate of the current body. Exported for tests and for a possible private adapter.
 */
export function historyEntries({ note, snapshots = [], users = globalThis.game?.users, t = defaultT } = {}) {
  const current = noteSnapshot(note);
  const entries = [{
    id: "current",
    current: true,
    body: current.body,
    revision: current.revision,
    at: current.updatedAt || current.createdAt,
    authorId: current.authorId,
    label: t("JN.History.Current")
  }];
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (!snapshot || typeof snapshot.body !== "string") continue;
    if (snapshot.body === current.body) continue;
    const author = users?.get?.(snapshot.authorId)?.name ?? "";
    entries.push({
      id: String(snapshot.id ?? `${snapshot.at ?? 0}:${entries.length}`),
      current: false,
      body: snapshot.body,
      revision: Number.isInteger(snapshot.revision) ? snapshot.revision : 0,
      at: Number.isFinite(snapshot.at) ? snapshot.at : 0,
      authorId: typeof snapshot.authorId === "string" ? snapshot.authorId : "",
      authorName: author
    });
  }
  return entries;
}

function renderVersionBody(entry, note, t = defaultT) {
  const body = typeof entry?.body === "string" ? entry.body : "";
  // An empty version is meaningful history (a pre-title checkpoint). Render an explicit
  // empty-state instead of a blank, apparently broken pane. "#" alone renders to empty HTML
  // through the document renderer, so judge the rendered result too.
  const empty = () => `<p class="jn-history-empty">${escapeHTML(t("JN.Search.EmptyNote"))}</p>`;
  if (!body.trim()) return empty();
  const layout = noteSnapshot(note).layout;
  try {
    const rendered = renderNoteBody(body, {
      selectedLayout: layout,
      sanitizer: globalThis.foundry?.utils?.cleanHTML
    });
    const html = rendered?.html ?? "";
    return html.trim() ? html : empty();
  } catch (error) {
    console.error("Journalinator: history preview render failed", error);
    return `<pre>${escapeHTML(body)}</pre>`;
  }
}

/**
 * Creates (but does not append) the modal.
 *
 * @param {Object} options
 * @param {string} options.noteId
 * @param {Object} options.note
 * @param {(noteId: string) => Array} [options.list]
 * @param {(noteId: string, body: string, revision: number, authorId: string) => Promise} [options.recordPreRestore]
 * @param {(message: Object) => Promise<Object>} options.requestEditReply
 * @param {string} [options.clientSessionId]
 * @param {() => boolean} [options.isLocked]
 * @param {(level: string, message: string) => void} [options.notify]
 * @param {(info: Object) => void} [options.onRestored]
 * @param {Function} [options.t]
 * @param {Document} [options.document]
 */
export function createHistoryDialog({
  noteId,
  note,
  list = listHistory,
  recordPreRestore = recordSharedPreRestore,
  requestEditReply,
  clientSessionId = "",
  currentAuthorId = globalThis.game?.user?.id ?? "",
  isLocked = () => false,
  getCurrent = null,
  notify,
  onRestored,
  t = defaultT,
  users = globalThis.game?.users,
  document: doc = globalThis.document
} = {}) {
  let snapshots = [];
  try {
    snapshots = list(noteId) ?? [];
  } catch (error) {
    console.error("Journalinator: history read failed", error);
  }
  let entries = historyEntries({ note, snapshots, users, t });
  let selectedIndex = 0;
  let previousFocus = doc?.activeElement ?? null;
  let closed = false;
  let busy = false;
  let listening = false;

  const overlay = doc.createElement("div");
  overlay.className = "jn-history-overlay";
  overlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:10000", "display:flex",
    "align-items:center", "justify-content:center", "padding:16px",
    "background:rgba(0,0,0,0.45)"
  ].join(";");

  const dialog = doc.createElement("div");
  dialog.className = "jn-history-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "jn-history-title");
  dialog.style.cssText = [
    "width:min(720px, calc(100vw - 32px))",
    "max-width:calc(100vw - 32px)",
    "max-height:calc(100vh - 32px)",
    "display:flex", "flex-direction:column",
    "background:var(--jn-panel, #1f1f24)", "color:var(--jn-text, #f2f2f2)",
    "border-radius:6px", "box-shadow:0 12px 40px rgba(0,0,0,0.5)", "overflow:hidden"
  ].join(";");
  overlay.appendChild(dialog);
  overlay.addEventListener("pointerdown", event => {
    if (event.target === overlay) close();
  });

  dialog.innerHTML = `
    <header class="jn-history-head" style="display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.12)">
      <h2 id="jn-history-title" style="margin:0;font-size:16px;flex:1">${escapeHTML(t("JN.History.Title"))}</h2>
      <button type="button" class="jn-history-close" aria-label="${escapeHTML(t("JN.Common.Close"))}"
        style="min-width:32px;min-height:32px">×</button>
    </header>
    <div class="jn-history-body" style="display:flex;flex-wrap:wrap;min-height:0;flex:1">
      <div class="jn-history-list" role="listbox" aria-label="${escapeHTML(t("JN.History.Title"))}"
        style="width:190px;flex:0 0 190px;max-width:100%;overflow:auto;border-right:1px solid rgba(255,255,255,0.12);padding:8px"></div>
      <div class="jn-history-preview" style="flex:1 1 320px;min-width:0;overflow:auto;padding:12px 16px"></div>
    </div>
    <div class="jn-history-confirm" hidden style="padding:12px 16px;border-top:1px solid rgba(255,255,255,0.12)">
      <p class="jn-history-confirm-text" style="margin:0 0 10px">${escapeHTML(t("JN.History.Confirm"))}</p>
      <div class="jn-history-confirm-actions" style="display:flex;justify-content:flex-end;gap:8px">
        <button type="button" class="jn-history-cancel">${escapeHTML(t("JN.Common.Cancel"))}</button>
        <button type="button" class="jn-history-confirm-restore">${escapeHTML(t("JN.History.ConfirmRestore"))}</button>
      </div>
    </div>
    <footer class="jn-history-foot" style="display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid rgba(255,255,255,0.12)">
      <span class="jn-history-reason" role="status" aria-live="polite" style="flex:1;font-size:12px;opacity:0.85"></span>
      <button type="button" class="jn-history-restore">${escapeHTML(t("JN.History.Restore"))}</button>
      <button type="button" class="jn-history-close">${escapeHTML(t("JN.Common.Close"))}</button>
    </footer>
  `;

  const listEl = dialog.querySelector(".jn-history-list");
  const previewEl = dialog.querySelector(".jn-history-preview");
  const reasonEl = dialog.querySelector(".jn-history-reason");
  const restoreButton = dialog.querySelector(".jn-history-restore");
  const confirmEl = dialog.querySelector(".jn-history-confirm");
  const confirmButton = dialog.querySelector(".jn-history-confirm-restore");

  function restoreBlockedReason() {
    if (!entries[selectedIndex]) return t("JN.History.SelectVersion");
    if (entries[selectedIndex].current) return t("JN.History.CurrentReason");
    if (isLocked()) return t("JN.History.Locked");
    return "";
  }

  function renderList() {
    listEl.innerHTML = entries.map((entry, index) => {
      const date = entry.current ? "" : dateText(entry.at);
      const author = entry.current ? "" : (entry.authorName ? t("JN.History.By", { name: entry.authorName }) : "");
      const meta = [date, author].filter(Boolean).join(" · ");
      const label = entry.current ? entry.label : (date || t("JN.History.Version"));
      return `<button type="button" class="jn-history-entry${index === selectedIndex ? " on" : ""}${entry.current ? " current" : ""}"
        role="option" aria-selected="${index === selectedIndex}" data-index="${index}"
        style="display:block;width:100%;text-align:left;padding:8px;margin:0 0 4px;min-height:32px">
        <b style="display:block;font-size:13px">${escapeHTML(label)}</b>
        ${meta ? `<small style="display:block;font-size:12px;opacity:0.8">${escapeHTML(meta)}</small>` : ""}
      </button>`;
    }).join("");
    listEl.querySelectorAll(".jn-history-entry").forEach(button => {
      button.addEventListener("click", () => {
        selectedIndex = Number(button.dataset.index) || 0;
        confirmEl.hidden = true;
        render();
      });
    });
  }

  function renderPreview() {
    const entry = entries[selectedIndex] ?? entries[0];
    const empty = entries.length === 1
      ? `<p class="jn-history-empty" style="opacity:0.8">${escapeHTML(t("JN.History.Empty"))}</p>`
      : "";
    previewEl.innerHTML = empty
      + `<article class="jn-history-rendered">${renderVersionBody(entry, note, t)}</article>`;
  }

  function renderRestore() {
    const reason = restoreBlockedReason();
    reasonEl.textContent = reason;
    restoreButton.disabled = busy || Boolean(reason);
    restoreButton.setAttribute("aria-disabled", String(Boolean(reason)));
  }

  function render() {
    renderList();
    renderPreview();
    renderRestore();
  }

  function showError(message) {
    reasonEl.textContent = message;
  }

  async function restore() {
    if (busy) return;
    const entry = entries[selectedIndex];
    const reason = restoreBlockedReason();
    if (!entry || reason) {
      showError(reason);
      return;
    }
    if (typeof requestEditReply !== "function") {
      showError(t("JN.History.RestoreFailed"));
      return;
    }
    busy = true;
    confirmEl.hidden = true;
    renderRestore();
    const current = typeof getCurrent === "function" ? getCurrent(noteId) ?? note : note;
    const currentSnapshot = noteSnapshot(current);
    let lease = null;
    let ended = false;
    try {
      const grant = await requestEditReply({
        type: "beginNoteEdit",
        noteId,
        clientSessionId
      });
      if (!grant || grant.type !== "noteEditGranted" || !grant.lease) {
        showError(t("JN.History.Locked"));
        return;
      }
      lease = grant.lease;
      const baseRevision = Number.isInteger(grant.revision)
        ? grant.revision
        : currentSnapshot.revision;
      await recordPreRestore(
        noteId,
        currentSnapshot.body,
        baseRevision,
        currentAuthorId || currentSnapshot.authorId
      );
      const saved = await requestEditReply({
        type: "saveNoteBody",
        noteId,
        lease,
        sequence: 1,
        baseRevision,
        body: entry.body,
        geometry: null,
        eventIds: []
      });
      if (saved?.type !== "noteSaveAck") {
        showError(t("JN.History.RestoreFailed"));
        return;
      }
      const end = await requestEditReply({ type: "endNoteEdit", noteId, lease });
      ended = true;
      if (end?.type === "noteEditEnded" || end?.type === "noteSaveRejected") {
        // The save already succeeded (or was rejected, handled above); the lease is released
        // either way. Only a persisted body is ever announced as restored.
      }
      notify?.("info", t("JN.History.Restored"));
      onRestored?.({
        noteId,
        body: entry.body,
        revision: Number.isInteger(saved.revision) ? saved.revision : baseRevision + 1
      });
      close();
    } catch (error) {
      console.error("Journalinator: history restore failed", error);
      showError(t("JN.History.RestoreFailed"));
    } finally {
      busy = false;
      if (!ended && lease) {
        try {
          await requestEditReply({ type: "endNoteEdit", noteId, lease });
        } catch (error) {
          console.error("Journalinator: history restore lease release failed", error);
        }
      }
      if (!closed) renderRestore();
    }
  }

  function onKeydown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    if (listening) doc.removeEventListener("keydown", onKeydown, true);
    listening = false;
    overlay.remove();
    try {
      previousFocus?.focus?.({ preventScroll: true });
    } catch {
      previousFocus?.focus?.();
    }
  }

  dialog.querySelectorAll(".jn-history-close").forEach(button => {
    button.addEventListener("click", close);
  });
  restoreButton.addEventListener("click", () => {
    if (restoreButton.disabled) return;
    confirmEl.hidden = false;
    confirmButton.focus?.({ preventScroll: true });
  });
  dialog.querySelector(".jn-history-cancel")?.addEventListener("click", () => {
    confirmEl.hidden = true;
    restoreButton.focus?.({ preventScroll: true });
  });
  confirmButton.addEventListener("click", () => { void restore(); });

  render();

  return {
    element: overlay,
    dialog,
    get entries() { return entries.slice(); },
    get selectedIndex() { return selectedIndex; },
    open() {
      if (closed) return this;
      (doc.body ?? doc.documentElement).appendChild(overlay);
      if (!listening) {
        doc.addEventListener("keydown", onKeydown, true);
        listening = true;
      }
      dialog.querySelector(".jn-history-entry.on")?.focus?.({ preventScroll: true });
      return this;
    },
    close,
    select(index) {
      selectedIndex = Math.max(0, Math.min(entries.length - 1, Number(index) || 0));
      confirmEl.hidden = true;
      render();
      return this;
    },
    restore: () => restore()
  };
}

/** Opens the history modal and appends it to the document. */
export function openHistoryDialog(options = {}) {
  const dialog = createHistoryDialog(options);
  dialog.open();
  return dialog;
}
