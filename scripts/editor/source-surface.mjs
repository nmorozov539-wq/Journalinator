/**
 * In-place Markdown source surface for the note editor.
 *
 * A real `<textarea>` owns selection, native undo/redo, IME, copy/paste and caret
 * movement. A purely textual mirror sits behind it so Markdown source can be styled
 * (notably the first-line H1 title) without introducing an HTML document model. The
 * textarea text itself is transparent; only its caret/selection chrome remains visible.
 *
 * No user text is ever assigned through `innerHTML`. The mirror is built from text
 * nodes only. The surface never measures or resizes the card; T8/T10 own sizing.
 */

import { parseAtxHeading } from "../document/parse.mjs";

const MAX_MIRROR_LINES = 20000;
const PASTE_LARGE_CODE_POINTS = 500;

let sequence = 0;

function nextId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // Fall through to the byte form below.
    }
  }
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  sequence += 1;
  return `${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function style(element, values) {
  for (const [key, value] of Object.entries(values)) element.style[key] = value;
}

function isTextControl(element) {
  return element?.tagName === "TEXTAREA" || element?.tagName === "INPUT";
}

/**
 * @typedef {Object} SourceSelection
 * @property {number} start
 * @property {number} end
 * @property {string} direction
 */

export class SourceSurface {
  /**
   * @param {Object} [options]
   * @param {(event: {value: string, composing: boolean, inputType: string, data: string|null}) => void} [options.onInput]
   * @param {(selection: SourceSelection) => void} [options.onSelectionChange]
   * @param {() => void} [options.onCompositionStart]
   * @param {(value: string) => void} [options.onCompositionEnd]
   * @param {(event: {id: string, length: number}) => void} [options.onPaste]
   */
  constructor(options = {}) {
    this._options = options;
    this._parsed = null;
    this._composing = false;
    this._destroyed = false;
    this._mirrorValue = "";
    this._lastSelection = { start: 0, end: 0, direction: "none" };

    this.root = document.createElement("div");
    this.root.className = "jn-source";
    this.root.style.position = "relative";
    this.root.style.display = "block";
    this.root.style.boxSizing = "border-box";
    this.root.style.minHeight = "120px";
    this.root.style.fontSize = "16px";
    this.root.style.lineHeight = "1.5";

    this.mirror = document.createElement("div");
    this.mirror.className = "jn-source-mirror";
    this.mirror.setAttribute("aria-hidden", "true");
    this.mirror.style.position = "absolute";
    this.mirror.style.inset = "0";
    this.mirror.style.overflow = "hidden";
    this.mirror.style.pointerEvents = "none";
    this.mirror.style.boxSizing = "border-box";

    this.mirrorInner = document.createElement("div");
    this.mirrorInner.className = "jn-source-mirror-inner";
    this.mirrorInner.style.boxSizing = "border-box";
    this.mirrorInner.style.padding = "20px";
    this.mirrorInner.style.font = "inherit";
    this.mirrorInner.style.fontSize = "16px";
    this.mirrorInner.style.lineHeight = "1.5";
    this.mirrorInner.style.whiteSpace = "pre-wrap";
    this.mirrorInner.style.overflowWrap = "anywhere";
    this.mirrorInner.style.transformOrigin = "top left";
    this.mirror.appendChild(this.mirrorInner);

    this.textarea = document.createElement("textarea");
    this.textarea.className = "jn-source-input";
    this.textarea.spellcheck = true;
    this.textarea.setAttribute("autocapitalize", "sentences");
    this.textarea.setAttribute("wrap", "soft");
    this.textarea.style.position = "absolute";
    this.textarea.style.inset = "0";
    this.textarea.style.width = "100%";
    this.textarea.style.height = "100%";
    this.textarea.style.boxSizing = "border-box";
    this.textarea.style.padding = "20px";
    this.textarea.style.margin = "0";
    this.textarea.style.border = "0";
    this.textarea.style.outline = "none";
    this.textarea.style.resize = "none";
    this.textarea.style.overflow = "auto";
    this.textarea.style.background = "transparent";
    this.textarea.style.color = "transparent";
    // `color: transparent` also makes `currentColor` transparent; use the paper ink so a
    // visible caret still tracks the mirrored glyphs during normal typing.
    this.textarea.style.caretColor = "var(--jn-paper-ink, #3c2b19)";
    this.textarea.style.font = "inherit";
    this.textarea.style.fontSize = "16px";
    this.textarea.style.lineHeight = "1.5";
    this.textarea.style.whiteSpace = "pre-wrap";
    this.textarea.style.overflowWrap = "anywhere";
    this.textarea.style.tabSize = "4";

    this.root.append(this.mirror, this.textarea);

    this._onInput = this._handleInput.bind(this);
    this._onScroll = this._syncScroll.bind(this);
    this._onSelection = this._emitSelection.bind(this);
    this._onCompositionStart = this._handleCompositionStart.bind(this);
    this._onCompositionEnd = this._handleCompositionEnd.bind(this);
    this._onPaste = this._handlePaste.bind(this);
    this._onDocumentSelection = () => {
      if (isTextControl(document.activeElement) && document.activeElement === this.textarea) {
        this._emitSelection();
      }
    };

    this.textarea.addEventListener("input", this._onInput);
    this.textarea.addEventListener("scroll", this._onScroll, { passive: true });
    this.textarea.addEventListener("keyup", this._onSelection);
    this.textarea.addEventListener("click", this._onSelection);
    this.textarea.addEventListener("select", this._onSelection);
    this.textarea.addEventListener("compositionstart", this._onCompositionStart);
    this.textarea.addEventListener("compositionend", this._onCompositionEnd);
    this.textarea.addEventListener("paste", this._onPaste);
    document.addEventListener("selectionchange", this._onDocumentSelection);

    this._renderMirror();
  }

  // --- Lifecycle -------------------------------------------------------------------------

  mount(host) {
    if (!host || this._destroyed) return this;
    host.appendChild(this.root);
    return this;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.textarea.removeEventListener("input", this._onInput);
    this.textarea.removeEventListener("scroll", this._onScroll);
    this.textarea.removeEventListener("keyup", this._onSelection);
    this.textarea.removeEventListener("click", this._onSelection);
    this.textarea.removeEventListener("select", this._onSelection);
    this.textarea.removeEventListener("compositionstart", this._onCompositionStart);
    this.textarea.removeEventListener("compositionend", this._onCompositionEnd);
    this.textarea.removeEventListener("paste", this._onPaste);
    document.removeEventListener("selectionchange", this._onDocumentSelection);
    this.root.remove();
  }

  // --- Value and selection ---------------------------------------------------------------

  getValue() {
    return this.textarea.value;
  }

  /**
   * @param {string} value
   * @param {{preserveSelection?: boolean}} [options]
   */
  setValue(value, { preserveSelection = true } = {}) {
    const next = String(value ?? "");
    if (next === this.textarea.value) {
      this._renderMirror();
      return this;
    }
    const scrollTop = this.textarea.scrollTop;
    const scrollLeft = this.textarea.scrollLeft;
    const start = preserveSelection ? this.textarea.selectionStart : 0;
    const end = preserveSelection ? this.textarea.selectionEnd : 0;
    const direction = preserveSelection ? this.textarea.selectionDirection : "none";
    this.textarea.value = next;
    const length = next.length;
    this.textarea.setSelectionRange(Math.min(start, length), Math.min(end, length), direction);
    this.textarea.scrollTop = scrollTop;
    this.textarea.scrollLeft = scrollLeft;
    this._renderMirror();
    this._syncScroll();
    return this;
  }

  /** @returns {SourceSelection} */
  getSelection() {
    return {
      start: this.textarea.selectionStart ?? 0,
      end: this.textarea.selectionEnd ?? 0,
      direction: this.textarea.selectionDirection ?? "none"
    };
  }

  setSelection(start, end = start, direction = "none") {
    const length = this.textarea.value.length;
    const from = Math.max(0, Math.min(length, Number.isFinite(start) ? start : 0));
    const to = Math.max(from, Math.min(length, Number.isFinite(end) ? end : from));
    this.textarea.setSelectionRange(from, to, direction);
    this._emitSelection();
    return this;
  }

  focus() {
    try {
      this.textarea.focus({ preventScroll: true });
    } catch {
      this.textarea.focus();
    }
    return this;
  }

  focusRange(start, end = start) {
    this.setSelection(start, end);
    this.focus();
    this.scrollToCaret();
    return this;
  }

  isFocused() {
    return document.activeElement === this.textarea;
  }

  isComposing() {
    return this._composing;
  }

  // --- Editing commands ------------------------------------------------------------------

  /**
   * Inserts text at the current selection. When the textarea is focused and the browser
   * supports it, `document.execCommand("insertText")` is used so the insertion becomes one
   * native undo step. `selectStart`/`selectEnd` are absolute offsets applied afterwards.
   *
   * @param {string} text
   * @param {{selectStart?: number, selectEnd?: number}} [options]
   */
  insertText(text, { selectStart, selectEnd } = {}) {
    const value = String(text ?? "");
    const before = this.textarea.value;
    const start = this.textarea.selectionStart ?? 0;
    const end = this.textarea.selectionEnd ?? start;

    let inserted = false;
    if (this.isFocused() && typeof document.execCommand === "function") {
      try {
        inserted = document.execCommand("insertText", false, value) === true;
      } catch {
        inserted = false;
      }
    }

    if (!inserted) {
      this._replaceWithRange(start, end, value);
    } else if (this.textarea.value === before && value.length) {
      // Some implementations report success without changing the field.
      this._replaceWithRange(start, end, value);
    } else if (this._mirrorValue !== this.textarea.value) {
      this._handleInput({ inputType: "insertText", data: value });
    }

    if (selectStart !== undefined) {
      this.setSelection(selectStart, selectEnd === undefined ? selectStart : selectEnd);
      this.scrollToCaret();
    }
    return this;
  }

  /** Replaces an absolute range and publishes one input event. */
  replaceRange(start, end, text) {
    this._replaceWithRange(start, end, String(text ?? ""));
    return this;
  }

  _replaceWithRange(start, end, text) {
    const value = this.textarea.value;
    const from = Math.max(0, Math.min(value.length, Number.isFinite(start) ? start : 0));
    const to = Math.max(from, Math.min(value.length, Number.isFinite(end) ? end : from));
    if (typeof this.textarea.setRangeText === "function") {
      this.textarea.setRangeText(text, from, to, "end");
    } else {
      this.textarea.value = value.slice(0, from) + text + value.slice(to);
      this.textarea.selectionStart = this.textarea.selectionEnd = from + text.length;
    }
    this._dispatchInput(text);
  }

  _dispatchInput(text) {
    let event;
    const InputEventCtor = globalThis.InputEvent;
    if (typeof InputEventCtor === "function") {
      event = new InputEventCtor("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      });
    } else {
      event = new Event("input", { bubbles: true });
      try {
        Object.defineProperty(event, "inputType", { value: "insertText" });
        Object.defineProperty(event, "data", { value: text });
      } catch {
        // Exotic environments may not allow extending events; the listener only needs input.
      }
    }
    this.textarea.dispatchEvent(event);
  }

  // --- Styling and scroll ----------------------------------------------------------------

  /**
   * Applies title styling for the current parse. Only the title class/marker is updated;
   * the textarea itself is never rebuilt.
   *
   * @param {Object|null} parsed Result from `parseDocument`.
   */
  updateParsed(parsed) {
    this._parsed = parsed ?? null;
    this._renderMirror();
    this._syncScroll();
    return this;
  }

  scrollToCaret() {
    const caret = this.textarea.selectionStart ?? 0;
    const value = this.textarea.value;
    const lineIndex = value.slice(0, caret).split("\n").length - 1;
    const lines = this.mirrorInner.children;
    const line = lines[lineIndex];
    if (!line) return this;
    const lineTop = line.offsetTop ?? 0;
    const lineHeight = line.offsetHeight || 24;
    const viewTop = this.textarea.scrollTop ?? 0;
    const viewHeight = this.textarea.clientHeight ?? 0;
    if (viewHeight <= 0) return this;
    const padding = 20;
    if (lineTop < viewTop + padding) {
      this.textarea.scrollTop = Math.max(0, lineTop - padding);
    } else if (lineTop + lineHeight > viewTop + viewHeight - padding) {
      this.textarea.scrollTop = Math.max(0, lineTop + lineHeight - viewHeight + padding);
    }
    this._syncScroll();
    return this;
  }

  /**
   * Maps a viewport point (for example a read-mode double-click) to the nearest source
   * offset using the mirror's line boxes and character ranges.
   */
  caretOffsetFromPoint(clientX, clientY) {
    const lines = [...this.mirrorInner.querySelectorAll(".jn-source-line")];
    if (!lines.length) return 0;

    let target = lines[lines.length - 1];
    let best = Infinity;
    for (const line of lines) {
      const rect = line.getBoundingClientRect?.();
      if (!rect) continue;
      const top = rect.top ?? 0;
      const bottom = rect.bottom ?? (top + (rect.height ?? 0));
      const distance = clientY < top ? top - clientY : (clientY > bottom ? clientY - bottom : 0);
      if (distance < best) {
        best = distance;
        target = line;
      }
    }

    const start = Number(target.dataset.start ?? 0);
    const text = target.textContent ?? "";
    if (!text.length) return start;

    // Prefer per-character Range boxes when the browser can measure them.
    if (typeof document.createRange === "function") {
      const walker = document.createTreeWalker(target, 4); // NodeFilter.SHOW_TEXT
      let offset = 0;
      let node = walker.nextNode();
      while (node) {
        const data = node.data ?? "";
        for (let index = 0; index < data.length; index += 1) {
          try {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const rect = range.getBoundingClientRect();
            if ((rect.width || rect.height) && clientX <= (rect.left ?? 0) + (rect.width ?? 0) / 2) {
              return start + offset;
            }
          } catch {
            // Detached or unmeasurable nodes fall through to the proportion below.
          }
          offset += 1;
        }
        node = walker.nextNode();
      }
    }

    const rect = target.getBoundingClientRect?.();
    const width = rect?.width ?? 0;
    if (!width) return start;
    const ratio = Math.max(0, Math.min(1, (clientX - (rect.left ?? 0)) / width));
    return start + Math.min(text.length, Math.round(text.length * ratio));
  }

  // --- Events ----------------------------------------------------------------------------

  _handleInput(event) {
    this._renderMirror();
    this._syncScroll();
    const detail = {
      value: this.textarea.value,
      composing: this._composing,
      inputType: event?.inputType ?? "insertText",
      data: typeof event?.data === "string" ? event.data : null
    };
    this._options.onInput?.(detail);
    this._emitSelection();
  }

  _emitSelection() {
    const selection = this.getSelection();
    const previous = this._lastSelection;
    if (previous.start === selection.start
        && previous.end === selection.end
        && previous.direction === selection.direction) return;
    this._lastSelection = selection;
    this._options.onSelectionChange?.({ ...selection });
  }

  _handleCompositionStart() {
    this._composing = true;
    // The mirror does not contain the IME candidate text yet. Hide it and reveal the
    // textarea's own (transparent-at-rest) text so the composing string and caret are
    // visible. The value and selection are left untouched.
    this.mirror.style.opacity = "0";
    this.textarea.style.color = "var(--jn-paper-ink, #3c2b19)";
    this._options.onCompositionStart?.();
  }

  _handleCompositionEnd() {
    this._composing = false;
    this.mirror.style.opacity = "1";
    this.textarea.style.color = "transparent";
    this._renderMirror();
    this._syncScroll();
    this._options.onCompositionEnd?.(this.textarea.value);
    this._emitSelection();
  }

  _handlePaste(event) {
    let text = "";
    try {
      text = event?.clipboardData?.getData?.("text/plain") ?? "";
    } catch {
      text = "";
    }
    if (!text) return;
    const length = Array.from(text).length;
    if (length < PASTE_LARGE_CODE_POINTS) return;
    // The event id is enough for activity; never retain or log the pasted text.
    this._options.onPaste?.({
      id: `paste-large:${nextId()}`,
      length
    });
  }

  _syncScroll() {
    this.mirrorInner.style.transform =
      `translate(${-this.textarea.scrollLeft}px, ${-this.textarea.scrollTop}px)`;
  }

  _renderMirror() {
    if (this._destroyed) return;
    const value = this.textarea.value;
    this._mirrorValue = value;
    const lines = value.split("\n");
    const limited = lines.length > MAX_MIRROR_LINES ? lines.slice(0, MAX_MIRROR_LINES) : lines;
    const titleLine = this._parsed?.title?.present === true;

    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (let index = 0; index < limited.length; index += 1) {
      const raw = limited[index];
      const line = document.createElement("div");
      line.className = "jn-source-line";
      line.dataset.line = String(index);
      line.dataset.start = String(offset);
      line.style.display = "block";
      line.style.minHeight = "24px";
      line.style.whiteSpace = "pre-wrap";
      line.style.overflowWrap = "anywhere";

      if (index === 0 && titleLine) {
        line.classList.add("jn-source-title");
        const atx = parseAtxHeading(raw);
        const marker = atx ? /^( {0,3}#{1,6})(?:[ \t]+)?/.exec(raw) : null;
        const markerText = marker ? marker[0] : "";
        const bodyText = raw.slice(markerText.length);
        if (markerText) {
          const marker = document.createElement("span");
          marker.className = "jn-source-title-marker";
          marker.style.opacity = "0.45";
          marker.textContent = markerText;
          line.appendChild(marker);
        }
        if (bodyText) {
          const text = document.createElement("span");
          text.className = "jn-source-title-text";
          text.textContent = bodyText;
          line.appendChild(text);
        }
        // 26 px H1 in a 24 px line box keeps the transparent textarea's caret and
        // selection chrome aligned with the visible mirror; the glyphs stay H1-sized.
        line.style.fontSize = "26px";
        line.style.lineHeight = "24px";
      } else {
        line.textContent = raw;
      }

      if (!raw) line.classList.add("jn-source-line-empty");
      fragment.appendChild(line);
      offset += raw.length + 1;
    }

    if (lines.length > limited.length) {
      const rest = document.createElement("div");
      rest.className = "jn-source-line jn-source-line-truncated";
      rest.style.display = "block";
      rest.style.minHeight = "24px";
      rest.textContent = "…";
      fragment.appendChild(rest);
    }

    this.mirrorInner.replaceChildren(fragment);
    this._syncScroll();
  }
}

export function createSourceSurface(options) {
  return new SourceSurface(options);
}

export const LARGE_PASTE_THRESHOLD = PASTE_LARGE_CODE_POINTS;
