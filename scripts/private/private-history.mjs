/**
 * Workspace-local recovery history for private notes.
 *
 * The ring semantics are the shared ones from `scripts/history.mjs` (newest 20
 * distinct bodies, session-start capture, at most one periodic checkpoint per
 * `CHECKPOINT_MS`, mandatory pre-restore and session-end capture). What differs
 * is storage: snapshots live inside the owner's private workspace as
 * `history[noteId] = [{ id, at, authorId, revision, body }]` and are written in
 * the same journal-page update as the note body. They never touch the shared
 * history container, shared search or shared activity.
 *
 * Everything here is pure: functions receive a workspace and return a new one.
 * Persistence, CAS and revision handling stay in `private-store.mjs`.
 */

import {
  CHECKPOINT_MS,
  MAX_SNAPSHOTS,
  appendHistorySnapshot,
  createHistorySnapshot,
  normalizeHistorySnapshots
} from "../history.mjs";

export { CHECKPOINT_MS, MAX_SNAPSHOTS };

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  const deepClone = globalThis.foundry?.utils?.deepClone;
  if (typeof deepClone === "function") return deepClone(value);
  return structuredClone(value);
}

/** Copy of the workspace with a `history` object that can be written independently. */
export function withHistory(workspace) {
  const next = isObject(workspace) ? clone(workspace) : {};
  next.history = isObject(next.history) ? next.history : {};
  return next;
}

/** Newest-first, de-duplicated snapshots for one note. Never writes. */
export function privateHistoryList(workspace, noteId) {
  if (typeof noteId !== "string" || !noteId) return [];
  const raw = workspace?.history?.[noteId];
  return normalizeHistorySnapshots(raw).map(entry => ({ ...entry }));
}

/** Creates a normal snapshot for the private history ring. */
export function privateSnapshot({ body, revision = 0, authorId = "", at = Date.now() } = {}) {
  return createHistorySnapshot({ body, revision, authorId, at });
}

function snapshotFrom(entry) {
  if (typeof entry?.id === "string" && entry.id) {
    return {
      id: entry.id,
      at: Number.isFinite(entry.at) ? entry.at : Date.now(),
      authorId: typeof entry.authorId === "string" ? entry.authorId : "",
      revision: Number.isInteger(entry.revision) && entry.revision >= 0 ? entry.revision : 0,
      body: entry.body
    };
  }
  return privateSnapshot(entry);
}

/**
 * Appends one snapshot to the workspace-local ring.
 *
 * Returns `{ workspace, entry, recorded }`. The input workspace is never
 * mutated. An absent/deleted note id is a no-op. A body already newest is a
 * no-op, matching the shared ring.
 */
export function appendPrivateSnapshot(workspace, noteId, entry) {
  if (typeof noteId !== "string" || !noteId) {
    return { workspace, entry: null, recorded: false };
  }
  if (!isObject(entry) || typeof entry.body !== "string") {
    return { workspace, entry: null, recorded: false };
  }
  const list = privateHistoryList(workspace, noteId);
  const snapshot = snapshotFrom(entry);
  const next = appendHistorySnapshot(list, snapshot);
  if (!next) return { workspace, entry: null, recorded: false };
  const result = withHistory(workspace);
  result.history[noteId] = next;
  return { workspace: result, entry: next[0], recorded: true };
}

/**
 * Periodic checkpoint: skips an unchanged newest body and enforces the shared
 * 60-second cooldown unless `force` is set. Pre-restore/session-end callers pass
 * `force`; abandoned/missing bodies remain no-ops.
 */
export function checkpointPrivateHistory(workspace, noteId, entry, { now, force = false } = {}) {
  if (!isObject(entry) || typeof entry.body !== "string") {
    return { workspace, entry: null, recorded: false };
  }
  const list = privateHistoryList(workspace, noteId);
  if (list.length && list[0].body === entry.body) {
    return { workspace, entry: null, recorded: false };
  }
  const at = Number.isFinite(now) ? now : (Number.isFinite(entry.at) ? entry.at : Date.now());
  if (!force && list.length && at - list[0].at < CHECKPOINT_MS) {
    return { workspace, entry: null, recorded: false };
  }
  return appendPrivateSnapshot(workspace, noteId, { ...entry, at });
}

/**
 * Removes history for permanently deleted notes only. Trashing a note keeps its
 * history entry, so callers must not invoke this on soft delete.
 */
export function deletePrivateHistory(workspace, noteIds) {
  const ids = (Array.isArray(noteIds) ? noteIds : [noteIds])
    .filter(id => typeof id === "string" && id);
  if (!ids.length || !isObject(workspace?.history)) {
    return { workspace, removed: 0 };
  }
  const result = withHistory(workspace);
  let removed = 0;
  for (const id of ids) {
    if (Object.hasOwn(result.history, id)) {
      delete result.history[id];
      removed += 1;
    }
  }
  return { workspace: result, removed };
}
