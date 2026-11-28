/**
 * Headless recovery comparison plus the compact "Recover unsaved text?" dialog.
 *
 * Recovery is local to the author: this module never talks to a socket, never publishes
 * draft text and never stores anything itself. The editor decides when to call it and
 * performs the revision recheck before replacing confirmed text.
 */

import { normalizeNewlines } from "../document/parse.mjs";

export const RECOVERY_ACTIONS = Object.freeze(["recover", "copy", "discard", "defer"]);

function bodyOf(value) {
  return normalizeNewlines(typeof value === "string" ? value : "");
}

/**
 * @param {Object} options
 * @param {Object|null} options.draft DraftStore record.
 * @param {Object|null} options.note Normalized/confirmed note `{body, revision, deleted}`.
 * @param {boolean} [options.exists] False for a deleted/missing note.
 * @returns {{kind: "none"|"identical"|"different"|"newer"|"missing", draft: Object|null, note: Object|null}}
 */
export function classifyDraft({ draft, note, exists = true } = {}) {
  if (!draft) return { kind: "none", draft: null, note: note ?? null };
  if (!exists || !note || note.deleted === true) {
    return { kind: "missing", draft, note: note ?? null };
  }
  const draftBody = bodyOf(draft.body);
  const noteBody = bodyOf(note.body);
  if (draftBody === noteBody) return { kind: "identical", draft, note };

  const draftRevision = Number.isInteger(draft.baseRevision) ? draft.baseRevision : 0;
  const noteRevision = Number.isInteger(note.revision) ? note.revision : 0;
  if (noteRevision > draftRevision) return { kind: "newer", draft, note };
  return { kind: "different", draft, note };
}

/** Human timestamp for the dialog; tests can inject a deterministic formatter. */
export function draftTimestamp(at, { now = Date.now(), locale = undefined } = {}) {
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const sameDay = new Date(now).toDateString() === date.toDateString();
    const time = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
    if (sameDay) return time;
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/** Best-effort clipboard copy; never throws and never includes draft text in the DOM. */
export async function copyToClipboard(text) {
  const value = String(text ?? "");
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the selection-based path.
    }
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "readonly");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === "function"
      ? document.execCommand("copy") === true
      : false;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function actionButton({ t, id, labelKey, primary = false, onClick }) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = `jn-recovery-action${primary ? " jn-recovery-primary" : ""}`;
  control.dataset.action = id;
  control.textContent = t(labelKey);
  control.addEventListener("click", onClick);
  return control;
}

function preview(label, text) {
  const pane = document.createElement("div");
  pane.className = "jn-recovery-pane";
  const heading = document.createElement("div");
  heading.className = "jn-recovery-pane-label";
  heading.textContent = label;
  const source = document.createElement("pre");
  source.className = "jn-recovery-preview";
  source.textContent = text;
  pane.append(heading, source);
  return pane;
}

/**
 * Builds the recovery dialog without attaching it. The promise resolves with one of
 * `RECOVERY_ACTIONS`; `defer` is used by Escape and any non-discard close.
 *
 * @param {Object} options
 * @param {Object} options.state Result of `classifyDraft`.
 * @param {Function} options.t
 * @param {(text: string) => Promise<boolean>|boolean} [options.copy]
 * @param {(at: number) => string} [options.formatTime]
 */
export function buildRecoveryDialog({
  state,
  t,
  copy = copyToClipboard,
  formatTime = draftTimestamp
} = {}) {
  const element = document.createElement("div");
  element.className = "jn-recovery";
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "true");
  element.dataset.kind = state.kind;
  element.tabIndex = -1;

  // Fixed full-screen overlay plus a real panel. Without this the prompt was appended under
  // the application/canvas and could be covered and pointer-blocked by the board.
  const panel = document.createElement("div");
  panel.className = "jn-recovery-panel";

  const title = document.createElement("h3");
  title.className = "jn-recovery-title";
  title.textContent = t("JN.Recovery.Title");

  const timestamp = document.createElement("p");
  timestamp.className = "jn-recovery-time";
  const at = state.draft?.at;
  const time = Number.isFinite(at) ? formatTime(at) : "";
  timestamp.textContent = time ? t("JN.Recovery.DraftFrom", { time }) : "";

  const body = document.createElement("div");
  body.className = "jn-recovery-body";

  if (state.kind === "newer") {
    const copyLine = document.createElement("p");
    copyLine.className = "jn-recovery-notice";
    copyLine.textContent = t("JN.Recovery.NewerSaved");
    const compare = document.createElement("div");
    compare.className = "jn-recovery-compare";
    compare.append(
      preview(t("JN.Recovery.CurrentSaved"), state.note?.body ?? ""),
      preview(t("JN.Recovery.YourDraft"), state.draft?.body ?? "")
    );
    body.append(copyLine, compare);
  } else if (state.kind === "missing") {
    const missing = document.createElement("p");
    missing.className = "jn-recovery-notice";
    missing.textContent = t("JN.Recovery.MissingNote");
    body.append(missing);
  } else {
    body.append(preview(t("JN.Recovery.YourDraft"), state.draft?.body ?? ""));
  }

  const actions = document.createElement("div");
  actions.className = "jn-recovery-actions";

  let settled = false;
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  const finish = action => {
    if (settled) return;
    settled = true;
    element.remove();
    resolve({ action });
  };

  if (state.kind !== "missing") {
    actions.append(actionButton({
      t,
      id: "recover",
      labelKey: state.kind === "newer" ? "JN.Recovery.ReplaceWithDraft" : "JN.Recovery.RecoverDraft",
      primary: true,
      onClick: () => finish("recover")
    }));
  }
  actions.append(actionButton({
    t,
    id: "copy",
    labelKey: "JN.Recovery.CopyText",
    onClick: () => {
      // Copy is not destructive: the dialog stays open so the author can still choose.
      void copy(state.draft?.body ?? "");
      element.dataset.copied = "true";
    }
  }));
  actions.append(actionButton({
    t,
    id: "discard",
    labelKey: "JN.Recovery.Discard",
    onClick: () => finish("discard")
  }));

  panel.append(title, timestamp, body, actions);
  element.append(panel);

  element.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    finish("defer");
  });

  return {
    element,
    promise,
    finish,
    close: () => finish("defer")
  };
}

/** Appends the dialog to `host` (document.body by default) and returns its handle. */
export function openRecoveryDialog(options = {}) {
  const host = options.host ?? document.body;
  const dialog = buildRecoveryDialog(options);
  host.appendChild(dialog.element);
  dialog.element.focus?.();
  return dialog;
}
