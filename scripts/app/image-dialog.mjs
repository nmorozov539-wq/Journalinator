/**
 * Insert/Replace portrait dialog and the legacy single-value prompt wrapper.
 *
 * Validation reuses the same accepted-value rule as rendering (`noteImagePath`): plain
 * HTTP(S) URLs or Foundry data paths, never script/data/protocol-relative URLs. The
 * produced Markdown is escaped so it round-trips through the document parser. The source
 * URL is never interpolated into error HTML; all messages are text nodes.
 */

import { noteImagePath } from "../image-url.mjs";
import { pickImage } from "../image-picker.mjs";
import { t as defaultT } from "../i18n.mjs";

const EMPTY_REASON = "JN.Editor.ImageEmptyReason";
const UNSAFE_REASON = "JN.Editor.ImageUnsafeReason";

/**
 * @param {string} input
 * @param {{allowEmpty?: boolean}} [options]
 * @returns {{ok: boolean, src: string, reason: string|null}}
 */
export function validateImageSource(input, { allowEmpty = false } = {}) {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) {
    return allowEmpty
      ? { ok: true, src: "", reason: null }
      : { ok: false, src: "", reason: EMPTY_REASON };
  }
  const src = noteImagePath(value);
  if (!src) return { ok: false, src: "", reason: UNSAFE_REASON };
  return { ok: true, src, reason: null };
}

/** Escapes alt text for `![alt](...)`. */
export function escapeMarkdownText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, " ")
    .replace(/\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/[[\]]/g, "\\$&");
}

/**
 * Destination escaping: angle brackets when whitespace/parentheses make the bare form
 * ambiguous, otherwise backslash-escaped parentheses. The parser accepts both.
 */
export function escapeMarkdownDestination(src) {
  const value = String(src ?? "");
  if (/[\s()<>]/.test(value)) {
    const inner = value
      .replace(/\\/g, "\\\\")
      .replace(/</g, "\\<")
      .replace(/>/g, "\\>");
    return `<${inner}>`;
  }
  return value.replace(/\\/g, "\\\\").replace(/[()]/g, "\\$&");
}

/** @returns {string} `![alt](src)`, safe to insert as a standalone paragraph. */
export function buildImageMarkdown({ src, alt = "" } = {}) {
  return `![${escapeMarkdownText(alt)}](${escapeMarkdownDestination(src)})`;
}

/**
 * @param {Object} options
 * @param {Function} [options.t]
 * @param {"insert"|"replace"} [options.mode]
 * @param {string} [options.title]
 * @param {string} [options.initialSrc]
 * @param {string} [options.initialAlt]
 * @param {string} [options.hint]
 * @param {boolean} [options.allowEmpty]
 * @param {(input: HTMLInputElement) => void} [options.pick]
 */
export function buildImageDialog({
  t = defaultT,
  mode = "insert",
  title,
  initialSrc = "",
  initialAlt = "",
  hint = "",
  allowEmpty = false,
  pick = pickImage
} = {}) {
  const replace = mode === "replace";
  const element = document.createElement("div");
  element.className = "jn-image-dialog";
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "true");
  element.dataset.mode = mode;

  const heading = document.createElement("h3");
  heading.className = "jn-image-dialog-title";
  heading.id = `jn-image-dialog-title-${Math.random().toString(36).slice(2)}`;
  heading.textContent = title ?? t(replace ? "JN.Editor.ReplacePortrait" : "JN.Editor.InsertPortrait");
  element.setAttribute("aria-labelledby", heading.id);

  const urlLabel = document.createElement("label");
  urlLabel.className = "jn-image-field";
  const urlText = document.createElement("span");
  urlText.className = "jn-image-field-label";
  urlText.textContent = t("JN.Editor.ImageURLOrPath");
  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.className = "jn-image-url";
  urlInput.autocomplete = "off";
  urlInput.value = initialSrc;
  urlInput.setAttribute("aria-label", t("JN.Editor.ImageURLOrPath"));
  urlLabel.append(urlText, urlInput);

  const browse = document.createElement("button");
  browse.type = "button";
  browse.className = "jn-image-browse";
  browse.textContent = t("JN.Editor.Browse");
  browse.setAttribute("aria-label", t("JN.Editor.Browse"));

  const reason = document.createElement("p");
  reason.className = "jn-image-dialog-reason";
  reason.hidden = true;

  const hintElement = document.createElement("p");
  hintElement.className = "jn-image-dialog-hint journalinator-meta";
  hintElement.hidden = !hint;
  hintElement.textContent = hint;

  const altLabel = document.createElement("label");
  altLabel.className = "jn-image-field";
  const altText = document.createElement("span");
  altText.className = "jn-image-field-label";
  altText.textContent = t("JN.Editor.AltText");
  const altInput = document.createElement("input");
  altInput.type = "text";
  altInput.className = "jn-image-alt";
  altInput.value = initialAlt;
  altInput.setAttribute("aria-label", t("JN.Editor.AltText"));
  altLabel.append(altText, altInput);

  const actions = document.createElement("div");
  actions.className = "jn-image-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "jn-image-cancel";
  cancel.textContent = t("JN.Common.Cancel");
  cancel.setAttribute("aria-label", t("JN.Common.Cancel"));
  const insert = document.createElement("button");
  insert.type = "button";
  insert.className = "jn-image-insert jn-image-dialog-primary";
  insert.textContent = t(replace ? "JN.Editor.Replace" : "JN.Editor.Insert");
  insert.setAttribute("aria-label", insert.textContent);
  insert.disabled = true;
  actions.append(cancel, insert);

  element.append(heading, urlLabel, browse, hintElement, reason, altLabel, actions);

  let settled = false;
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  const finish = result => {
    if (settled) return;
    settled = true;
    element.remove();
    resolve(result);
  };

  const validate = () => {
    const result = validateImageSource(urlInput.value, { allowEmpty });
    insert.disabled = !result.ok;
    reason.hidden = result.ok;
    reason.textContent = result.ok ? "" : t(result.reason);
    element.dataset.valid = String(result.ok);
    return result;
  };

  urlInput.addEventListener("input", validate);
  urlInput.addEventListener("change", validate);
  for (const input of [urlInput, altInput]) {
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing || insert.disabled) return;
      event.preventDefault();
      insert.click();
    });
  }
  browse.addEventListener("click", event => {
    event.preventDefault();
    pick(urlInput);
    // A picker may fill the input synchronously or fire `change`; validate in both cases.
    validate();
  });
  insert.addEventListener("click", () => {
    const result = validate();
    if (!result.ok) return;
    finish({
      src: result.src,
      alt: altInput.value.trim(),
      markdown: result.src ? buildImageMarkdown({ src: result.src, alt: altInput.value.trim() }) : ""
    });
  });
  cancel.addEventListener("click", () => finish(null));
  element.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    finish(null);
  });

  validate();

  return {
    element,
    promise,
    urlInput,
    altInput,
    browseButton: browse,
    insertButton: insert,
    cancelButton: cancel,
    reasonElement: reason,
    finish,
    close: () => finish(null),
    validate
  };
}

/**
 * Appends the dialog to `host` (document.body by default) and resolves
 * `{src, alt, markdown}` or `null` on cancel/Escape.
 */
export function openImageDialog(options = {}) {
  const host = options.host ?? document.body;
  const dialog = buildImageDialog(options);
  host.appendChild(dialog.element);
  dialog.urlInput.focus();
  dialog.urlInput.select?.();
  return dialog.promise;
}

/**
 * Legacy wrapper used by private surfaces: returns only the accepted source, or `null`
 * when cancelled. An explicit empty value is allowed so existing "clear image" callers
 * keep working.
 */
export async function promptImageSource(title, initial = "", hint = "") {
  const result = await openImageDialog({
    title,
    initialSrc: initial ?? "",
    hint,
    allowEmpty: true
  });
  return result ? result.src : null;
}
