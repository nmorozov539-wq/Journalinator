/**
 * Shared note recovery history.
 *
 * The hidden history page holds `system.snapshots[noteId] = [{ id, at,
 * authorId, revision, body }]`, newest first. It stores text only: titles,
 * geometry, links, skins and author identity are never copied into a snapshot
 * (the snapshot's `authorId` is the editor who caused the checkpoint, not a
 * note owner).
 *
 * Snapshots are capped at `MAX_SNAPSHOTS` DISTINCT bodies. Bodies are compared
 * exactly; duplicate bodies anywhere in the ring are not stored twice. Adding
 * the body that is already newest is a no-op; adding a body that exists deeper
 * in the ring moves that entry to the newest position (fresh id/at/revision).
 * This keeps the ring a de-duplicated version trail rather than a list of
 * repeated saves.
 *
 * Checkpoints:
 *   - edit begin: capture the confirmed body (session start).
 *   - accepted durable save: at most once per `CHECKPOINT_MS` of saved changes,
 *     and only when the body differs from the newest snapshot.
 *   - edit end: capture the final confirmed body when it was saved or differs
 *     from the newest snapshot.
 *   - before restore: `recordPreRestore` is mandatory and ignores the cooldown.
 *     Callers then acquire a fresh lease and perform a normal revisioned
 *     `saveNoteBody`; this module never writes a note body itself.
 *
 * Trashing a note keeps its history. Only a permanent-delete event removes it.
 * Private history is workspace-local and is not stored or read here.
 *
 * Every write is one update to the single history page and is queued so rapid
 * hook events cannot lose a read-modify-write. Missing containers/pages are a
 * no-op: `ensureContainers()` is the only creator.
 */

import { getContainerIds } from "./store/containers.mjs";

const MODULE_ID = "fvtt-journalinator";
const NOTE_TYPE = `${MODULE_ID}.note`;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export const MAX_SNAPSHOTS = 20;
export const CHECKPOINT_MS = 60_000;

let writeQueue = Promise.resolve();
let registered = false;

function enqueue(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

function safeId(value) {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function isActiveGM() {
  return Boolean(
    globalThis.game?.user?.id
    && globalThis.game?.users?.activeGM?.id === globalThis.game.user.id
  );
}

function freshId() {
  return globalThis.foundry?.utils?.randomID?.()
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function historyPage() {
  const ids = getContainerIds();
  if (!ids?.history || !ids?.historyPage) return null;
  return globalThis.game?.journal?.get(ids.history)?.pages?.get(ids.historyPage) ?? null;
}

function sharedEntry() {
  const ids = getContainerIds();
  if (ids?.shared) return globalThis.game?.journal?.get(ids.shared) ?? null;
  return [...(globalThis.game?.journal?.values?.() ?? [])]
    .find(entry => entry.flags?.[MODULE_ID]?.container === "shared") ?? null;
}

function sharedNote(noteId) {
  const id = safeId(noteId);
  if (!id) return null;
  const page = sharedEntry()?.pages?.get(id) ?? null;
  return page?.type === NOTE_TYPE ? page : null;
}

function normalizeSnapshot(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.body !== "string") return null;
  return {
    id: typeof entry.id === "string" && entry.id ? entry.id : freshId(),
    at: Number.isFinite(entry.at) ? entry.at : Date.now(),
    authorId: typeof entry.authorId === "string" ? entry.authorId : "",
    revision: Number.isInteger(entry.revision) && entry.revision >= 0 ? entry.revision : 0,
    body: entry.body
  };
}

/**
 * Returns the stored ring in capture order, de-duplicated by body and capped at
 * MAX_SNAPSHOTS. We sort by timestamp so an older/foreign write that was not
 * newest-first is still presented newest-first without writing a repair.
 *
 * Exported as a pure helper so T7 can reuse the same ring semantics for
 * workspace-local private history; private storage itself stays in T7.
 */
export function normalizeHistorySnapshots(raw) {
  if (!Array.isArray(raw)) return [];
  const sorted = [...raw]
    .map(normalizeSnapshot)
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
  const seen = new Set();
  const out = [];
  for (const entry of sorted) {
    if (seen.has(entry.body)) continue;
    seen.add(entry.body);
    out.push(entry);
    if (out.length >= MAX_SNAPSHOTS) break;
  }
  return out;
}

function allSnapshots(page) {
  const raw = page?.system?.snapshots;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function snapshotsFor(page, noteId) {
  return normalizeHistorySnapshots(allSnapshots(page)[noteId]);
}

/**
 * Pure ring insertion. The newest duplicate is a no-op (`null`); a duplicate
 * deeper in the ring is moved to the front with a fresh timestamp. T7 can reuse
 * this for private history without importing the shared page plumbing.
 */
export function appendHistorySnapshot(list, snapshot) {
  const normalized = normalizeHistorySnapshots(list);
  const existing = normalized.findIndex(entry => entry.body === snapshot.body);
  if (existing === 0) return null;
  const rest = existing > 0 ? normalized.filter((_, index) => index !== existing) : normalized;
  const refreshed = existing > 0
    ? { ...snapshot, at: Math.max(snapshot.at, normalized[0]?.at ?? snapshot.at) }
    : snapshot;
  return [refreshed, ...rest].slice(0, MAX_SNAPSHOTS);
}

/** Creates a well-formed `{ id, at, authorId, revision, body }` snapshot. */
export function createHistorySnapshot({ body, revision, authorId, at }) {
  return {
    id: freshId(),
    at: Number.isFinite(at) ? at : Date.now(),
    authorId: typeof authorId === "string" ? authorId : "",
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    body
  };
}

async function writeSnapshot(noteId, { body, revision, authorId, at }) {
  return enqueue(async () => {
    const id = safeId(noteId);
    const page = historyPage();
    if (!id || !page || typeof body !== "string") return false;
    const list = snapshotsFor(page, id);
    const next = appendHistorySnapshot(list, createHistorySnapshot({ body, revision, authorId, at }));
    if (!next) return false;
    await page.update({ [`system.snapshots.${id}`]: next });
    return true;
  });
}

/** Newest-first snapshots for a note. Missing history/page/note returns `[]`. */
export function listHistory(noteId) {
  const id = safeId(noteId);
  const page = historyPage();
  if (!id || !page) return [];
  return snapshotsFor(page, id).map(entry => ({ ...entry }));
}

/** Adds (or refreshes) one snapshot, ignoring the periodic cooldown. */
export async function addHistorySnapshot(noteId, { body, revision = 0, authorId = "", at = Date.now() } = {}) {
  return writeSnapshot(noteId, { body, revision, authorId, at });
}

/** Session-start checkpoint. Captures the confirmed body as the baseline. */
export async function captureSessionStart(noteId, body, revision, authorId) {
  return writeSnapshot(noteId, { body, revision, authorId, at: Date.now() });
}

/**
 * Periodic checkpoint after a durable save. At most one write per
 * `CHECKPOINT_MS`, only when the body changed from the newest snapshot.
 */
export async function checkpointIfDue(noteId, body, revision, authorId, now = Date.now()) {
  return enqueue(async () => {
    const id = safeId(noteId);
    const page = historyPage();
    if (!id || !page || typeof body !== "string") return false;
    const list = snapshotsFor(page, id);
    if (list[0]?.body === body) return false;
    const at = Number.isFinite(now) ? now : Date.now();
    if (list.length && at - list[0].at < CHECKPOINT_MS) return false;
    const next = appendHistorySnapshot(list, createHistorySnapshot({ body, revision, authorId, at }));
    if (!next) return false;
    await page.update({ [`system.snapshots.${id}`]: next });
    return true;
  });
}

/** Session-end checkpoint of the final confirmed body. */
export async function captureSessionEnd(noteId, body, revision, authorId) {
  return writeSnapshot(noteId, { body, revision, authorId, at: Date.now() });
}

/**
 * Mandatory pre-restore checkpoint. Call with the current body, acquire a fresh
 * lease, then restore the selected snapshot through the normal revisioned save
 * API. This ignores the checkpoint cooldown by design.
 */
export async function recordPreRestore(noteId, body, revision, authorId) {
  return writeSnapshot(noteId, { body, revision, authorId, at: Date.now() });
}

/** Removes history for permanently deleted notes only. Trash keeps history. */
export async function deleteHistory(noteIds) {
  const ids = (Array.isArray(noteIds) ? noteIds : [noteIds]).map(safeId).filter(Boolean);
  if (!ids.length) return false;
  return enqueue(async () => {
    const page = historyPage();
    if (!page) return false;
    const stored = allSnapshots(page);
    const updates = {};
    for (const id of ids) {
      if (Object.hasOwn(stored, id)) updates[`system.snapshots.-=${id}`] = null;
    }
    if (!Object.keys(updates).length) return false;
    await page.update(updates);
    return true;
  });
}

function report(error, hook) {
  console.error(`Journalinator: ${hook} history failed`, error);
}

/**
 * Registers the shared history hook listeners once. They run only on the active
 * GM because the socket write queue lives there; other clients receive the
 * replicated page updates.
 */
export function registerHistoryHooks() {
  if (registered) return;
  registered = true;

  if (typeof globalThis.Hooks?.on !== "function") return;

  globalThis.Hooks.on("journalinatorNoteEditBegan", payload => {
    if (!isActiveGM()) return;
    const body = payload?.body;
    captureSessionStart(payload?.noteId, body, payload?.revision, payload?.authorId)
      .catch(error => report(error, "edit-began"));
  });

  globalThis.Hooks.on("journalinatorNoteSaved", payload => {
    if (!isActiveGM()) return;
    checkpointIfDue(
      payload?.noteId,
      payload?.body,
      payload?.revision,
      payload?.authorId
    ).catch(error => report(error, "saved"));
  });

  globalThis.Hooks.on("journalinatorNoteEditEnded", payload => {
    if (!isActiveGM()) return;
    // Re-read the journal document: the end hook does not carry the final body,
    // and an end-with-flush may have changed both body and revision.
    const noteId = safeId(payload?.noteId);
    if (!noteId) return;
    const page = sharedNote(noteId);
    const body = page?.system?.body;
    const revision = page?.system?.revision;
    const authorId = typeof payload?.authorId === "string" ? payload.authorId : "";
    if (typeof body !== "string") return;
    const newest = listHistory(noteId)[0];
    if (payload?.saved !== true && newest?.body === body) return;
    captureSessionEnd(noteId, body, revision, authorId)
      .catch(error => report(error, "edit-ended"));
  });

  globalThis.Hooks.on("journalinatorNotesPermanentlyDeleted", payload => {
    if (!isActiveGM()) return;
    deleteHistory(payload?.noteIds).catch(error => report(error, "permanent-delete"));
  });
}
