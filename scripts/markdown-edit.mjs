/**
 * Lightweight Markdown typing helpers for the block textarea. They mirror the pairs people type
 * most often without pulling in the whole editor: bracket pairs, quotes, and bold markers.
 */

function replaceRange(textarea, start, end, insertion, selectFrom = null, selectTo = null) {
  textarea.setRangeText(insertion, start, end, "end");
  if (selectFrom !== null) textarea.setSelectionRange(selectFrom, selectTo);
  const EventCtor = textarea.ownerDocument?.defaultView?.Event ?? globalThis.Event;
  textarea.dispatchEvent(new EventCtor("input", { bubbles: true }));
}

function pair(textarea, open, close) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end);
  if (selected) {
    replaceRange(textarea, start, end, open + selected + close, start + open.length, start + open.length + selected.length);
    return;
  }
  replaceRange(textarea, start, end, open + close, start + open.length, start + open.length);
}

/** Wraps bold on the second `*` of a `**` pair, leaving the cursor between the two pairs. */
function completeBold(textarea) {
  const start = textarea.selectionStart;
  if (start !== textarea.selectionEnd) return false;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(start);
  if (!before.endsWith("*") || before.endsWith("**") || after.startsWith("**")) return false;
  // Only complete at an opening boundary. Otherwise the second `*` of a closing pair (after a
  // word) would be expanded into another full pair.
  const previous = before[start - 2] ?? "";
  if (previous && !/[\s([{'"“‘>*_~-]/.test(previous)) return false;
  // One `*` already exists; add the second opener and both closers: **|**
  replaceRange(textarea, start, start, "***", start + 1, start + 1);
  return true;
}

/**
 * Handles one keydown for the Markdown textarea. Returns true when the event was consumed.
 * Native typing is preserved for every key that is not a pair or a closing skip.
 */
export function applyMarkdownAutocomplete(event, textarea) {
  if (event.defaultPrevented || event.isComposing || event.repeat) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;

  if ((event.key === ")" || event.key === "\"") && start === end) {
    if (value[start] === event.key) {
      event.preventDefault();
      textarea.setSelectionRange(start + 1, start + 1);
      return true;
    }
    return false;
  }

  if (event.key === "(") {
    event.preventDefault();
    pair(textarea, "(", ")");
    return true;
  }

  if (event.key === "\"") {
    event.preventDefault();
    pair(textarea, "\"", "\"");
    return true;
  }

  if (event.key === "*") {
    if (completeBold(textarea)) {
      event.preventDefault();
      return true;
    }
  }

  return false;
}
