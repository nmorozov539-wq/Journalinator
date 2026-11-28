import { normalizePen, PEN_SETTING } from "./link-pen.mjs";

/**
 * Settings-backed home of the link pen. One pen per user, shared by the main board, the private
 * board and the toolbar menu. Reads come from an in-memory copy and writes are debounced, so a
 * slider or the mouse wheel never hammers localStorage.
 */

const MODULE_ID = "fvtt-journalinator";
let cache = null;
let timer = null;
const listeners = new Set();

function read() {
  try {
    return normalizePen(game.settings.get(MODULE_ID, PEN_SETTING));
  } catch {
    // Setting not registered (tests, early load): behave as an unconfigured pen.
    return normalizePen(null);
  }
}

export function getLinkPen() {
  cache ??= read();
  return cache;
}

export function setLinkPen(pen) {
  cache = normalizePen(pen);
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try { game.settings.set(MODULE_ID, PEN_SETTING, cache); } catch { /* keep the in-memory pen */ }
  }, 300);
  for (const listener of listeners) {
    try { listener(cache); } catch { /* a bad listener must not block the others */ }
  }
  return cache;
}

/** Notified whenever the pen changes, from any surface. Returns an unsubscribe function. */
export function onLinkPenChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drops the in-memory copy so the next read reloads the stored setting. Tests only. */
export function resetPenCache() {
  cache = null;
  clearTimeout(timer);
  timer = null;
  listeners.clear();
}
