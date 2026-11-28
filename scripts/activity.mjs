/**
 * Hidden shared activity foundation.
 *
 * Structure: `activity[UTC date][userId][noteId] -> counters` from the T2
 * ActivityModel. Only accepted shared events contribute, and only counters are
 * stored: no old/new text, save ids, titles, image URLs or session markers.
 *
 * `recordActivityEvent()` is the pure-ish computation: it parses bodies, runs
 * the bounded code-point diff and returns one `{ date, userId, noteId,
 * counters, dedupeKey }` record without touching Foundry. The hook listeners
 * feed those records through a small in-memory duplicate guard and then write
 * one activity page at a time.
 *
 * Duplicate guard: saves are keyed by `noteId|saveIdentity.requestId`. It is
 * deliberately in memory only, so a GM failover may re-open the window for a
 * repeated save hook; no extra durable field is added to the T2 schema.
 *
 * Private editing never calls these shared hooks, so private work produces no
 * shared activity.
 */

import { getContainerIds } from "./store/containers.mjs";
import { parseDocument, deriveTitle } from "./document/index.mjs";
import { diffCounts } from "./text-diff.mjs";

const MODULE_ID = "fvtt-journalinator";
const SAFE_KEY = /^[A-Za-z0-9_-]{1,100}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const BOARD_NOTE_ID = "__board__";
export const MAX_ACTIVITY_DEDUPE = 2000;

export const COUNTER_KEYS = Object.freeze([
  "charsAdded",
  "charsRemoved",
  "saveCount",
  "notesCreated",
  "titlesSet",
  "imagesAdded",
  "threadsCreated",
  "largePasteCount",
  "templateInsertCount"
]);

let writeQueue = Promise.resolve();
let registered = false;
const seenSaves = new Map();

function enqueue(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

function isActiveGM() {
  return Boolean(
    globalThis.game?.user?.id
    && globalThis.game?.users?.activeGM?.id === globalThis.game.user.id
  );
}

function activityPage() {
  const ids = getContainerIds();
  if (!ids?.shared || !ids?.activityPage) return null;
  return globalThis.game?.journal?.get(ids.shared)?.pages?.get(ids.activityPage) ?? null;
}

function safeKey(value) {
  return typeof value === "string" && SAFE_KEY.test(value) ? value : null;
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** UTC `YYYY-MM-DD` date bucket for a timestamp (default: now). */
export function todayUTC(now = Date.now()) {
  return new Date(timestamp(now)).toISOString().slice(0, 10);
}

export function emptyCounters() {
  return Object.fromEntries(COUNTER_KEYS.map(key => [key, 0]));
}

function normalizeCounters(raw) {
  const out = emptyCounters();
  if (!raw || typeof raw !== "object") return out;
  for (const key of COUNTER_KEYS) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value > 0) out[key] = Math.trunc(value);
  }
  return out;
}

/** Counters for one UTC day/user/note. Missing data returns all zeros. */
export function activityFor(date, userId, noteId) {
  if (!DATE_KEY.test(String(date ?? ""))) return emptyCounters();
  const user = safeKey(userId);
  const note = safeKey(noteId);
  if (!user || !note) return emptyCounters();
  const page = activityPage();
  const raw = page?.system?.activity?.[date]?.[user]?.[note];
  return normalizeCounters(raw);
}

function addCounters(target, delta) {
  let changed = false;
  for (const key of COUNTER_KEYS) {
    const value = Number(delta?.[key]);
    if (!Number.isFinite(value) || value <= 0) continue;
    target[key] += Math.trunc(value);
    changed = true;
  }
  return changed;
}

/**
 * Atomically adds `delta` counters for one UTC day/user/note and returns the
 * merged counters. All-zero deltas do not write. A missing activity page is a
 * no-op (returns null); `ensureContainers()` is the only creator.
 */
export async function mergeCounters(date, userId, noteId, delta) {
  if (!DATE_KEY.test(String(date ?? ""))) return null;
  const user = safeKey(userId);
  const note = safeKey(noteId);
  if (!user || !note) return null;
  return enqueue(async () => {
    const page = activityPage();
    if (!page) return null;
    const existing = normalizeCounters(page.system?.activity?.[date]?.[user]?.[note]);
    if (!addCounters(existing, delta)) return existing;
    await page.update({ [`system.activity.${date}.${user}.${note}`]: existing });
    return existing;
  });
}

/** Strict title line: only a usable first-line title, never a fallback label. */
function titleOf(parsed) {
  if (!parsed?.title?.present || parsed.title.empty) return "";
  return deriveTitle(parsed, { emptyLabel: "", imageLabel: "" }).trim();
}

function imageSourcesOf(parsed) {
  return Array.isArray(parsed?.imageSources) ? parsed.imageSources : [];
}

/** Sum of positive multiset differences (next minus previous). */
function addedImages(previousSources, nextSources) {
  const counts = new Map();
  for (const src of previousSources) counts.set(src, (counts.get(src) ?? 0) + 1);
  let added = 0;
  for (const src of nextSources) {
    const remaining = counts.get(src) ?? 0;
    if (remaining > 0) counts.set(src, remaining - 1);
    else added += 1;
  }
  return added;
}

/** Number of distinct event ids with `prefix`; text is never recorded. */
function countEventIds(eventIds, prefix) {
  if (!Array.isArray(eventIds)) return 0;
  const ids = new Set();
  for (const id of eventIds) {
    if (typeof id === "string" && id.startsWith(prefix)) ids.add(id);
  }
  return ids.size;
}

function nonzero(counters) {
  return COUNTER_KEYS.some(key => counters[key] > 0);
}

/**
 * Pure-ish event computation. Does not read or write Foundry state.
 *
 * Accepts:
 *   { type: "noteCreated", noteId, authorId, at, body, source }
 *   { type: "noteSaved", noteId, authorId, at, previousBody, body, saveIdentity|eventIds }
 *   { type: "threadCreated", noteId, authorId, at, board, kind }
 *
 * Returns `{ date, userId, noteId, counters, dedupeKey }`, or null when the
 * event contributes no counters (`saveCount` only for a body-changing durable
 * save; previews/heartbeats/retries are not events here).
 */
export function recordActivityEvent(event = {}) {
  const userId = safeKey(event.authorId);
  if (!userId) return null;
  const at = timestamp(event.at);
  const date = todayUTC(at);

  if (event.type === "noteCreated") {
    if (typeof event.body !== "string") return null;
    const noteId = safeKey(event.noteId);
    if (!noteId) return null;
    const parsed = parseDocument(event.body);
    const counters = emptyCounters();
    counters.notesCreated = 1;
    counters.charsAdded = Array.from(event.body).length;
    if (event.source === "paste") {
      counters.imagesAdded = imageSourcesOf(parsed).length;
      if (titleOf(parsed)) counters.titlesSet = 1;
    } else {
      // Creation from the template menu, including blank templates. Template
      // marker text, when present, is part of `body` and already counted above.
      counters.templateInsertCount = 1;
    }
    return nonzero(counters)
      ? { date, userId, noteId, counters, dedupeKey: null }
      : null;
  }

  if (event.type === "noteSaved") {
    if (typeof event.body !== "string" || typeof event.previousBody !== "string") return null;
    if (event.body === event.previousBody) return null;
    const noteId = safeKey(event.noteId);
    if (!noteId) return null;

    const previousParsed = parseDocument(event.previousBody);
    const nextParsed = parseDocument(event.body);
    const counts = diffCounts(event.previousBody, event.body);

    const counters = emptyCounters();
    counters.charsAdded = counts.charsAdded;
    counters.charsRemoved = counts.charsRemoved;
    counters.saveCount = 1;

    const previousTitle = titleOf(previousParsed);
    const nextTitle = titleOf(nextParsed);
    if (nextTitle && nextTitle !== previousTitle) counters.titlesSet = 1;

    counters.imagesAdded = addedImages(
      imageSourcesOf(previousParsed),
      imageSourcesOf(nextParsed)
    );

    const eventIds = event.saveIdentity?.eventIds ?? event.eventIds;
    counters.largePasteCount = countEventIds(eventIds, "paste-large:");
    counters.templateInsertCount = countEventIds(eventIds, "template:");

    const requestId = event.saveIdentity?.requestId;
    const dedupeKey = typeof requestId === "string" && requestId
      ? `${noteId}|${requestId}`
      : null;

    return nonzero(counters)
      ? { date, userId, noteId, counters, dedupeKey }
      : null;
  }

  if (event.type === "threadCreated") {
    const rawNote = safeKey(event.noteId);
    const noteId = event.board === true || !rawNote ? BOARD_NOTE_ID : rawNote;
    const counters = emptyCounters();
    counters.threadsCreated = 1;
    // A replacement/split (`replacesLinkId`) is still a newly committed
    // relationship and counts once for this hook.
    return { date, userId, noteId, counters, dedupeKey: null };
  }

  return null;
}

function rememberSave(dedupeKey) {
  if (!dedupeKey) return false;
  if (seenSaves.has(dedupeKey)) return true;
  seenSaves.set(dedupeKey, true);
  if (seenSaves.size > MAX_ACTIVITY_DEDUPE) {
    const oldest = seenSaves.keys().next().value;
    seenSaves.delete(oldest);
  }
  return false;
}

function report(error, hook) {
  console.error(`Journalinator: ${hook} activity failed`, error);
}

function applyEvent(event) {
  const record = recordActivityEvent(event);
  if (!record) return;
  if (rememberSave(record.dedupeKey)) return;
  mergeCounters(record.date, record.userId, record.noteId, record.counters)
    .catch(error => report(error, event.type));
}

/**
 * Registers the shared activity listeners once. They run only on the active GM
 * (the socket write queue owner). No listener exists for private workspaces.
 */
export function registerActivityHooks() {
  if (registered) return;
  registered = true;

  if (typeof globalThis.Hooks?.on !== "function") return;

  globalThis.Hooks.on("journalinatorNoteCreated", payload => {
    if (!isActiveGM()) return;
    applyEvent({
      type: "noteCreated",
      noteId: payload?.noteId,
      authorId: payload?.authorId,
      at: payload?.createdAt,
      body: payload?.body,
      source: payload?.source
    });
  });

  globalThis.Hooks.on("journalinatorNoteSaved", payload => {
    if (!isActiveGM()) return;
    applyEvent({
      type: "noteSaved",
      noteId: payload?.noteId,
      authorId: payload?.authorId,
      at: payload?.saveIdentity?.at,
      previousBody: payload?.previousBody,
      body: payload?.body,
      saveIdentity: payload?.saveIdentity
    });
  });

  globalThis.Hooks.on("journalinatorThreadCreated", payload => {
    if (!isActiveGM()) return;
    applyEvent({
      type: "threadCreated",
      noteId: payload?.noteId,
      authorId: payload?.authorId,
      at: Date.now(),
      board: payload?.board,
      kind: payload?.kind
    });
  });
}
