/**
 * Local recovery drafts for the note editor.
 *
 * Drafts are keyed by origin/world/user/canvas/note/client session so one tab never
 * touches another tab's unacknowledged text. Storage is best-effort: quota and security
 * denials are reported through the return value, `isAvailable()` and `lastError()`, and
 * no method here ever throws.
 */

const PREFIX = "journalinator.draft.";
const MAX_LIST = 50;
const WRITE_DELAY_MS = 150;

export const DRAFT_TTL_MS = 30 * 24 * 3600 * 1000;
export const DRAFT_WRITE_MS = WRITE_DELAY_MS;
export const DRAFT_LIST_LIMIT = MAX_LIST;
export const DRAFT_KEY_PREFIX = PREFIX;

function safeSegment(value) {
  const text = value == null ? "" : String(value);
  try {
    // Dots are part of the key separator, so encode them inside a segment too.
    return encodeURIComponent(text).replace(/\./g, "%2E");
  } catch {
    return "";
  }
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeRecord(record, fallbackAt) {
  if (!isObject(record)) return null;
  const normalized = {
    body: typeof record.body === "string" ? record.body : "",
    baseRevision: integer(record.baseRevision) ?? 0,
    acknowledgedBody: typeof record.acknowledgedBody === "string" ? record.acknowledgedBody : null,
    acknowledgedRevision: integer(record.acknowledgedRevision),
    at: Number.isFinite(record.at) ? record.at : fallbackAt
  };
  if (typeof record.pendingRequestId === "string") {
    normalized.pendingRequestId = record.pendingRequestId;
  }
  const pendingSequence = integer(record.pendingSequence);
  if (pendingSequence !== null) normalized.pendingSequence = pendingSequence;
  if (typeof record.pendingBodyHash === "string") {
    normalized.pendingBodyHash = record.pendingBodyHash;
  }
  return normalized;
}

function hasPendingSave(record) {
  return record.pendingRequestId !== undefined
    || record.pendingSequence !== undefined
    || record.pendingBodyHash !== undefined;
}

function errorName(error) {
  return error?.name || error?.message || "storage";
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} RecoveryDraft
 * @property {string} body
 * @property {number} baseRevision
 * @property {string|null} acknowledgedBody
 * @property {number|null} acknowledgedRevision
 * @property {string} [pendingRequestId]
 * @property {number} [pendingSequence]
 * @property {string} [pendingBodyHash]
 * @property {number} at
 */

export class DraftStore {
  /**
   * @param {Object} options
   * @param {string} options.origin
   * @param {string} options.worldId
   * @param {string} options.userId
   * @param {string} options.canvasId
   * @param {Storage} [options.storage]
   * @param {() => number} [options.now]
   * @param {number} [options.ttlMs]
   * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
   */
  constructor({
    origin = "",
    worldId = "",
    userId = "",
    canvasId = "",
    storage = defaultStorage(),
    now = () => Date.now(),
    ttlMs = DRAFT_TTL_MS,
    timers
  } = {}) {
    this.origin = origin == null ? "" : String(origin);
    this.worldId = worldId == null ? "" : String(worldId);
    this.userId = userId == null ? "" : String(userId);
    this.canvasId = canvasId == null ? "" : String(canvasId);
    this.storage = storage ?? null;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DRAFT_TTL_MS;
    this.timers = timers ?? {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    };

    this._prefix = PREFIX + [this.origin, this.worldId, this.userId, this.canvasId]
      .map(safeSegment)
      .join(".") + ".";
    this._pending = new Map();
    this._timer = null;
    this._available = !!this.storage;
    this._lastError = this.storage ? null : "unavailable";
  }

  /** Stable, encoded storage key for one note/session pair. */
  keyFor(noteId, clientSessionId) {
    return this._prefix + safeSegment(noteId) + "." + safeSegment(clientSessionId);
  }

  isAvailable() {
    return this._available;
  }

  lastError() {
    return this._lastError;
  }

  /** Synchronous write. Returns false and records the failure instead of throwing. */
  save(noteId, clientSessionId, record) {
    if (typeof noteId !== "string" || typeof clientSessionId !== "string") return false;
    const normalized = normalizeRecord(record, this.now());
    if (!normalized) return false;
    if (!this.storage) {
      this._available = false;
      this._lastError = this._lastError ?? "unavailable";
      return false;
    }
    try {
      this.storage.setItem(this.keyFor(noteId, clientSessionId), JSON.stringify(normalized));
      this._available = true;
      this._lastError = null;
      return true;
    } catch (error) {
      this._fail(error);
      return false;
    }
  }

  /** Reads one session's draft. Expired or corrupt entries are removed. */
  load(noteId, clientSessionId) {
    if (typeof noteId !== "string" || typeof clientSessionId !== "string") return null;
    return this._loadKey(this.keyFor(noteId, clientSessionId));
  }

  /** Removes only this session's draft; another tab's entry is untouched. */
  remove(noteId, clientSessionId) {
    if (typeof noteId !== "string" || typeof clientSessionId !== "string") return false;
    return this._removeKey(this.keyFor(noteId, clientSessionId));
  }

  /**
   * Deletes entries older than the TTL and acknowledged entries with no pending save.
   * Entries whose body equals `acknowledgedBody` while a save is pending are kept.
   */
  prune(now = this.now()) {
    let removed = 0;
    for (const key of this._storageKeys()) {
      if (!key.startsWith(this._prefix)) continue;
      const raw = this._readRaw(key);
      if (raw === null) continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        if (this._removeKey(key)) removed += 1;
        continue;
      }
      const normalized = normalizeRecord(record, now);
      const expired = !normalized || now - normalized.at > this.ttlMs;
      const acknowledged = normalized
        && normalized.body === normalized.acknowledgedBody
        && !hasPendingSave(normalized);
      if ((expired || acknowledged) && this._removeKey(key)) removed += 1;
    }
    return removed;
  }

  /**
   * All live drafts for this origin/world/user/canvas, bounded to `DRAFT_LIST_LIMIT`.
   * Each entry contains the parsed `noteId` and `clientSessionId`.
   */
  list() {
    const entries = [];
    for (const key of this._storageKeys()) {
      if (!key.startsWith(this._prefix)) continue;
      const suffix = key.slice(this._prefix.length);
      const dot = suffix.indexOf(".");
      if (dot < 0) continue;
      const noteId = decodeSegment(suffix.slice(0, dot));
      const clientSessionId = decodeSegment(suffix.slice(dot + 1));
      const raw = this._readRaw(key);
      if (raw === null) continue;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      const normalized = normalizeRecord(record, this.now());
      if (!normalized || this.now() - normalized.at > this.ttlMs) continue;
      entries.push({ noteId, clientSessionId, ...normalized });
      if (entries.length >= MAX_LIST) break;
    }
    return entries;
  }

  /**
   * Queues a coalesced write. All pending keys share one 150 ms timer; a later record for
   * the same key replaces the earlier one.
   */
  queueSave(noteId, clientSessionId, record) {
    if (typeof noteId !== "string" || typeof clientSessionId !== "string" || !isObject(record)) {
      return false;
    }
    this._pending.set(this.keyFor(noteId, clientSessionId), {
      noteId,
      clientSessionId,
      record
    });
    this._scheduleFlush();
    return true;
  }

  /** Writes every queued record immediately and cancels the timer. */
  flush() {
    this._cancelTimer();
    if (!this._pending.size) return true;
    let ok = true;
    for (const [key, entry] of [...this._pending]) {
      this._pending.delete(key);
      if (!this.save(entry.noteId, entry.clientSessionId, entry.record)) ok = false;
    }
    return ok;
  }

  /** Alias used by pagehide/blur/close integration. */
  flushPending() {
    return this.flush();
  }

  _scheduleFlush() {
    if (this._timer != null) return;
    const setTimer = this.timers?.setTimeout;
    if (typeof setTimer !== "function") {
      this.flush();
      return;
    }
    this._timer = setTimer(() => {
      this._timer = null;
      this.flush();
    }, WRITE_DELAY_MS);
    this._timer?.unref?.();
  }

  _cancelTimer() {
    if (this._timer == null) return;
    try {
      this.timers?.clearTimeout?.(this._timer);
    } catch {
      // Timers are best-effort too; a bad timer must not break persistence calls.
    }
    this._timer = null;
  }

  _loadKey(key) {
    const raw = this._readRaw(key);
    if (raw === null) return null;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      this._removeKey(key);
      return null;
    }
    const normalized = normalizeRecord(record, this.now());
    if (!normalized) {
      this._removeKey(key);
      return null;
    }
    if (this.now() - normalized.at > this.ttlMs) {
      this._removeKey(key);
      return null;
    }
    return normalized;
  }

  _readRaw(key) {
    if (!this.storage) return null;
    try {
      const value = this.storage.getItem(key);
      return typeof value === "string" ? value : null;
    } catch (error) {
      this._fail(error);
      return null;
    }
  }

  _removeKey(key) {
    if (!this.storage) return false;
    try {
      this.storage.removeItem(key);
      this._available = true;
      this._lastError = null;
      return true;
    } catch (error) {
      this._fail(error);
      return false;
    }
  }

  _storageKeys() {
    const storage = this.storage;
    if (!storage) return [];
    try {
      if (typeof storage.key === "function" && Number.isFinite(storage.length)) {
        const keys = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (typeof key === "string") keys.push(key);
        }
        return keys;
      }
      if (storage instanceof Map) return [...storage.keys()];
      if (storage._map instanceof Map) return [...storage._map.keys()];
      if (typeof storage.keys === "function") {
        return [...storage.keys()].filter(key => typeof key === "string");
      }
    } catch (error) {
      this._fail(error);
    }
    return [];
  }

  _fail(error) {
    this._available = false;
    this._lastError = errorName(error);
  }
}
