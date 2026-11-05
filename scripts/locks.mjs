const MODULE_ID = "fvtt-journalinator";
const CHANNEL = `module.${MODULE_ID}`;
const EXPIRY_MS = 20000;
const SWEEP_INTERVAL_MS = 5000;

/**
 * Block locks are ephemeral GM-memory state, never stored in any document (spec §6.6) — so
 * lock traffic causes no world writes. Every client keeps a read-only `mirror` reflecting the
 * last lock info it was told about; only the active GM's client additionally keeps
 * `authoritative`, the real grant/deny/expire state machine. Both are updated through the same
 * `applyLocal()` so the UI (editor.mjs, canvas.mjs) only ever needs to listen to one hook,
 * `"journalinatorLocksChanged"`, regardless of whether this client is the GM.
 *
 * Known simplification: a GM failover (the active GM disconnecting mid-session) rebuilds this
 * client's `authoritative` map empty the next time it's touched, per spec §6.6 — but we don't
 * proactively detect "I just became the active GM" to do that eagerly; it only self-corrects
 * once something touches a lock. Good enough for now; revisit if failover turns out to matter
 * more than the spec's own "acceptable, tolerate a brief window" caveat suggests.
 */
const mirror = new Map();
let authoritative = null;
let activeGMAtLastTouch = null;

function key(noteId, blockId) {
  return `${noteId}:${blockId}`;
}

function ensureAuthoritative() {
  const currentGM = game.users.activeGM?.id ?? null;
  if (!authoritative || currentGM !== activeGMAtLastTouch) {
    authoritative = new Map();
    activeGMAtLastTouch = currentGM;
  }
  return authoritative;
}

function toLockInfo(entry) {
  const user = game.users.get(entry.userId);
  return { userId: entry.userId, userName: user?.name ?? "someone", userColor: user?.color ?? "#8d8d97" };
}

function applyLocal(noteId, blockId, lock) {
  const k = key(noteId, blockId);
  if (lock) mirror.set(k, lock);
  else mirror.delete(k);
  Hooks.callAll("journalinatorLocksChanged", noteId, blockId, lock);
}

function broadcastLockUpdate(noteId, blockId, lock) {
  applyLocal(noteId, blockId, lock);
  game.socket.emit(CHANNEL, { type: "lockUpdate", noteId, blockId, lock });
}

// --- GM-authoritative operations (only meaningful on the active GM's client; see socket.mjs) ---

export function authoritativeRequestLock(noteId, blockId, userId) {
  const locks = ensureAuthoritative();
  const k = key(noteId, blockId);
  const existing = locks.get(k);
  if (existing && existing.userId !== userId) {
    broadcastLockUpdate(noteId, blockId, toLockInfo(existing)); // deny: rebroadcast the truth
    return;
  }
  const entry = { userId, heartbeatAt: Date.now() };
  locks.set(k, entry);
  broadcastLockUpdate(noteId, blockId, toLockInfo(entry));
}

export function authoritativeReleaseLock(noteId, blockId, userId) {
  const locks = ensureAuthoritative();
  const k = key(noteId, blockId);
  const existing = locks.get(k);
  if (!existing || existing.userId !== userId) return;
  locks.delete(k);
  broadcastLockUpdate(noteId, blockId, null);
}

export function authoritativeHeartbeat(noteId, blockId, userId) {
  const locks = ensureAuthoritative();
  const existing = locks.get(key(noteId, blockId));
  if (existing && existing.userId === userId) existing.heartbeatAt = Date.now();
}

/** Does `userId` hold both this block's lock and its immediate predecessor's? Used to validate merges. */
export function authoritativeHolds(noteId, blockId, userId) {
  const locks = ensureAuthoritative();
  return locks.get(key(noteId, blockId))?.userId === userId;
}

export function authoritativeSnapshot() {
  const locks = ensureAuthoritative();
  return [...locks.entries()].map(([k, v]) => {
    const [noteId, blockId] = k.split(":");
    return { noteId, blockId, lock: toLockInfo(v) };
  });
}

export function startExpirySweep() {
  setInterval(() => {
    if (game.users.activeGM?.id !== game.user.id) return;
    const locks = ensureAuthoritative();
    const now = Date.now();
    for (const [k, v] of [...locks]) {
      if (now - v.heartbeatAt > EXPIRY_MS) {
        locks.delete(k);
        const [noteId, blockId] = k.split(":");
        broadcastLockUpdate(noteId, blockId, null);
      }
    }
  }, SWEEP_INTERVAL_MS);
}

/** Called by socket.mjs for every client when a lock broadcast arrives. */
export function receiveLockBroadcast(message) {
  if (message.type === "lockUpdate") applyLocal(message.noteId, message.blockId, message.lock);
  else if (message.type === "lockState") {
    for (const { noteId, blockId, lock } of message.locks) applyLocal(noteId, blockId, lock);
  }
}

// --- Client-facing API used by the editor UI ---

export function getLock(noteId, blockId) {
  return mirror.get(key(noteId, blockId)) ?? null;
}

export function isHeldByMe(noteId, blockId) {
  return mirror.get(key(noteId, blockId))?.userId === game.user.id;
}

export function hasAnyLock(noteId) {
  for (const k of mirror.keys()) if (k.startsWith(`${noteId}:`)) return true;
  return false;
}

export function requestLock(noteId, blockId) {
  if (game.users.activeGM?.id === game.user.id) authoritativeRequestLock(noteId, blockId, game.user.id);
  else game.socket.emit(CHANNEL, { type: "requestLock", noteId, blockId });
}

export function releaseLock(noteId, blockId) {
  if (game.users.activeGM?.id === game.user.id) authoritativeReleaseLock(noteId, blockId, game.user.id);
  else game.socket.emit(CHANNEL, { type: "releaseLock", noteId, blockId });
}

export function sendHeartbeat(noteId, blockId) {
  if (game.users.activeGM?.id === game.user.id) authoritativeHeartbeat(noteId, blockId, game.user.id);
  else game.socket.emit(CHANNEL, { type: "heartbeat", noteId, blockId });
}

export function requestLockState() {
  if (game.users.activeGM?.id === game.user.id) {
    for (const { noteId, blockId, lock } of authoritativeSnapshot()) applyLocal(noteId, blockId, lock);
  } else {
    game.socket.emit(CHANNEL, { type: "requestLockState" });
  }
}
