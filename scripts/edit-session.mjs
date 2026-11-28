/**
 * Whole-note edit leases for shared notes.
 *
 * Shared editing is mediated by the active GM. That client keeps the only authoritative
 * map of leases and previews in memory; every client keeps a read-only mirror of what the
 * active GM last told it. Nothing here is persisted, so a GM failover intentionally loses
 * every lease and starts a fresh opaque epoch.
 *
 * Lease identity is `{canvasId, noteId, userId, clientSessionId, leaseToken, gmEpoch}`.
 * A second tab is a different `clientSessionId` and cannot share the first tab's lease.
 * Heartbeats keep an idle open editor alive; typing is irrelevant (D11).
 */

const MODULE_ID = "fvtt-journalinator";
const CHANNEL = `module.${MODULE_ID}`;
const CANVAS_ID = "shared";

export const HEARTBEAT_MS = 5000;
export const LEASE_MS = 30000;
export const MAX_NOTE_BODY_LENGTH = 200000;

const MAX_SESSION_ID_LENGTH = 100;

function randomToken() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** Random per-tab session id. Never reused between tabs or reloads. */
export const clientSessionId = randomToken().slice(0, MAX_SESSION_ID_LENGTH);

function sessionId(value) {
  if (typeof value !== "string" || !value || value.length > MAX_SESSION_ID_LENGTH) return null;
  return value;
}

function at(value) {
  return Number.isFinite(value) ? value : Date.now();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function copy(value) {
  return value == null ? null : structuredClone(value);
}

/**
 * Deterministic FNV-1a body hash over UTF-16 code units, as 8 lowercase hex digits.
 * Stored in `lastSave` so an autosave retry can be recognized after a lost acknowledgement.
 */
export function noteBodyHash(body) {
  const text = typeof body === "string" ? body : "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// --- Authority state (only meaningful on the active GM's client) --------------------------

let epoch = null;
const leases = new Map(); // noteId -> internal lease entry

function activeGMId() {
  return game.users?.activeGM?.id ?? null;
}

function selfIsActiveGM() {
  return !!game.user?.id && activeGMId() === game.user.id;
}

function leaseIdentity(entry) {
  return {
    canvasId: CANVAS_ID,
    noteId: entry.noteId,
    userId: entry.userId,
    clientSessionId: entry.clientSessionId,
    leaseToken: entry.leaseToken,
    gmEpoch: entry.gmEpoch
  };
}

function publicLease(entry) {
  if (!entry) return null;
  return {
    canvasId: CANVAS_ID,
    noteId: entry.noteId,
    userId: entry.userId,
    userName: entry.userName,
    userColor: entry.userColor,
    clientSessionId: entry.clientSessionId,
    requestId: entry.requestId,
    gmEpoch: entry.gmEpoch,
    grantedAt: entry.grantedAt,
    expiresAt: entry.heartbeatAt + LEASE_MS
  };
}

function liveEntry(noteId, now) {
  const entry = leases.get(noteId);
  if (!entry) return null;
  return now - entry.heartbeatAt > LEASE_MS ? null : entry;
}

/** Starts a new authority generation with a fresh opaque epoch and no leases. */
export function initializeAuthority() {
  epoch = randomToken();
  leases.clear();
  return epoch;
}

export function authorityEpoch() {
  return epoch;
}

/**
 * Grants or refreshes the one lease for a note.
 *
 * Same user + same `clientSessionId` is an idempotent re-begin: the existing token is
 * returned (`existing: true`). Any other holder, including the same user's other tab,
 * is denied with `reason: "locked"` and the current public holder.
 */
export function grantLease({
  noteId, userId, userName = "", userColor = "", clientSessionId: rawSession,
  requestId = "", revision = 0
} = {}) {
  if (!epoch) initializeAuthority();
  if (typeof noteId !== "string" || !noteId) return { lease: null, existing: false, reason: "invalid" };
  if (typeof userId !== "string" || !userId) return { lease: null, existing: false, reason: "invalid" };
  const session = sessionId(rawSession);
  if (!session) return { lease: null, existing: false, reason: "invalid" };

  const existing = leases.get(noteId);
  if (existing) {
    if (existing.userId === userId && existing.clientSessionId === session) {
      existing.requestId = typeof requestId === "string" ? requestId : existing.requestId;
      existing.heartbeatAt = Date.now();
      if (Number.isInteger(revision) && revision >= 0) existing.revision = revision;
      return {
        lease: leaseIdentity(existing),
        existing: true,
        expiresAt: existing.heartbeatAt + LEASE_MS
      };
    }
    return { lease: null, existing: false, reason: "locked", holder: publicLease(existing) };
  }

  const now = Date.now();
  const entry = {
    noteId,
    userId,
    userName: typeof userName === "string" ? userName : "",
    userColor: typeof userColor === "string" ? userColor : "",
    clientSessionId: session,
    requestId: typeof requestId === "string" ? requestId : "",
    leaseToken: randomToken(),
    gmEpoch: epoch,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    grantedAt: now,
    heartbeatAt: now,
    preview: null
  };
  leases.set(noteId, entry);
  return { lease: leaseIdentity(entry), existing: false, expiresAt: now + LEASE_MS };
}

/** Internal authority lease, including the token, or null. */
export function leaseFor(noteId) {
  const entry = leases.get(noteId);
  return entry ? leaseIdentity(entry) : null;
}

/**
 * Validates token/epoch/user/session/note and freshness. `now` is injectable for tests
 * and for a sweep that wants one consistent clock across notes.
 */
export function isLeaseValid(lease, now = Date.now()) {
  if (!isObject(lease) || !epoch) return false;
  if (lease.canvasId !== CANVAS_ID) return false;
  if (lease.gmEpoch !== epoch) return false;
  const entry = leases.get(lease.noteId);
  if (!entry) return false;
  if (entry.gmEpoch !== epoch) return false;
  if (entry.leaseToken !== lease.leaseToken) return false;
  if (entry.userId !== lease.userId) return false;
  if (entry.clientSessionId !== lease.clientSessionId) return false;
  return now - entry.heartbeatAt <= LEASE_MS;
}

/** Records a heartbeat. Returns `{ok, lease, expiresAt}` or `{ok:false, reason}`. */
export function heartbeat(lease, now = Date.now()) {
  if (!isLeaseValid(lease, now)) {
    const entry = leases.get(lease?.noteId);
    const reason = !epoch || lease?.gmEpoch !== epoch
      ? "failover"
      : entry ? "leaseLost" : "expired";
    return { ok: false, reason };
  }
  const entry = leases.get(lease.noteId);
  entry.heartbeatAt = now;
  return { ok: true, lease: leaseIdentity(entry), expiresAt: now + LEASE_MS };
}

/** Removes a matching lease and its preview. A mismatched token is a no-op. */
export function releaseLease(lease, reason = "released") {
  if (!isObject(lease)) return { ok: false, reason: "leaseLost" };
  const entry = leases.get(lease.noteId);
  if (!entry || entry.leaseToken !== lease.leaseToken) return { ok: false, reason: "leaseLost" };
  leases.delete(lease.noteId);
  return { ok: true, lease: leaseIdentity(entry), reason, preview: entry.preview ?? null };
}

/** Removes a note's authority entry regardless of token. Returns the entry, or null. */
export function consumeLease(noteId) {
  const entry = leases.get(noteId);
  if (!entry) return null;
  leases.delete(noteId);
  return { lease: leaseIdentity(entry), preview: entry.preview ?? null };
}

export function setAuthorityRevision(noteId, revision) {
  const entry = leases.get(noteId);
  if (entry && Number.isInteger(revision) && revision >= 0) entry.revision = revision;
}

/**
 * Stores an ephemeral preview. A sequence at or below the stored one is rejected so a
 * delayed packet cannot roll a viewer's text backwards.
 */
export function setPreview(lease, sequence, body, now = Date.now()) {
  if (!isLeaseValid(lease, now)) return { ok: false, reason: "leaseLost" };
  if (!Number.isInteger(sequence) || sequence < 0) return { ok: false, reason: "invalid" };
  if (typeof body !== "string" || body.length > MAX_NOTE_BODY_LENGTH) {
    return { ok: false, reason: "tooLarge" };
  }
  const entry = leases.get(lease.noteId);
  if (entry.preview && sequence <= entry.preview.sequence) {
    return { ok: false, reason: "sequenceOutOfOrder" };
  }
  entry.preview = {
    noteId: entry.noteId,
    leaseToken: entry.leaseToken,
    gmEpoch: entry.gmEpoch,
    userId: entry.userId,
    clientSessionId: entry.clientSessionId,
    userName: entry.userName,
    sequence,
    body,
    at: now
  };
  return { ok: true, preview: copy(entry.preview) };
}

export function getAuthorityPreview(noteId) {
  return copy(leases.get(noteId)?.preview ?? null);
}

/** Public, token-free lease plus preview and current tracked revision. */
export function authoritySnapshot(noteId) {
  const entries = noteId === undefined
    ? [...leases.values()]
    : [leases.get(noteId)].filter(Boolean);
  return entries.map(entry => ({
    noteId: entry.noteId,
    revision: entry.revision,
    deleted: false,
    lease: publicLease(entry),
    preview: copy(entry.preview)
  }));
}

/** Removes expired leases and returns `[{noteId, lease, preview, reason:"expired"}]`. */
export function expireLeases(now = Date.now()) {
  const expired = [];
  for (const [noteId, entry] of [...leases]) {
    if (now - entry.heartbeatAt <= LEASE_MS) continue;
    leases.delete(noteId);
    expired.push({
      noteId,
      lease: leaseIdentity(entry),
      preview: copy(entry.preview),
      reason: "expired"
    });
  }
  return expired;
}

export function isNoteLocked(noteId, now = Date.now()) {
  return !!liveEntry(noteId, now);
}

export function leaseHolder(noteId, now = Date.now()) {
  return liveEntry(noteId, now)?.userId ?? null;
}

/** True for any authority entry, including one awaiting the expiry sweep. */
export function hasAnyLease(noteId) {
  return leases.has(noteId);
}

/**
 * T4b guard helper. Accepts one note id or an array. Group operations must validate the
 * whole set before writing; this returns every locked id instead of the first one.
 */
export function assertUnlocked(noteIds) {
  const ids = Array.isArray(noteIds) ? noteIds : [noteIds];
  const lockedIds = ids.filter(id => typeof id === "string" && isNoteLocked(id));
  return lockedIds.length
    ? { ok: false, reason: "locked", lockedIds }
    : { ok: true, reason: null, lockedIds: [] };
}

export const unlockedNoteIds = assertUnlocked;

// --- Client mirror -----------------------------------------------------------------------

const mirror = new Map(); // noteId -> { lease, preview }
let mirrorEpoch = null;

function currentUserId() {
  return game.user?.id ?? null;
}

function sameJSON(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function emitState(noteId, previous, next, reason = null) {
  if (sameJSON(previous, next)) return;
  Hooks.callAll("journalinatorEditStateChanged", noteId, {
    lease: copy(next?.lease ?? null),
    preview: copy(next?.preview ?? null),
    ...(reason ? { reason } : {})
  });
}

function mirrorEntry(noteId) {
  return mirror.get(noteId) ?? null;
}

function normalizeMirrorEntry(lease, preview) {
  return {
    lease: lease ? copy(lease) : null,
    preview: preview ? copy(preview) : null
  };
}

function writeMirrorEntry(noteId, lease, preview, reason = null) {
  const previous = mirrorEntry(noteId);
  const next = normalizeMirrorEntry(lease, preview);
  if (!next.lease && !next.preview) mirror.delete(noteId);
  else mirror.set(noteId, next);
  emitState(noteId, previous, next, reason);
}

/** True when a lease exists and is not this tab's own. */
export function noteIsLocked(noteId) {
  const lease = mirrorEntry(noteId)?.lease;
  return !!lease && !isNoteHeldByMe(noteId);
}

export function getNoteEditor(noteId) {
  return copy(mirrorEntry(noteId)?.lease ?? null);
}

export function isNoteHeldByMe(noteId) {
  const lease = mirrorEntry(noteId)?.lease;
  return !!lease && lease.userId === currentUserId()
    && lease.clientSessionId === clientSessionId;
}

export function hasEditor(noteId) {
  return !!mirrorEntry(noteId)?.lease;
}

export function getNotePreview(noteId) {
  return copy(mirrorEntry(noteId)?.preview ?? null);
}

export function listEditors() {
  return [...mirror.values()].filter(entry => entry.lease).map(entry => copy(entry.lease));
}

export function listPreviews() {
  return [...mirror.entries()]
    .filter(([, entry]) => entry.preview)
    .map(([noteId, entry]) => ({ noteId, preview: copy(entry.preview) }));
}

/**
 * Replaces the whole mirror from a `noteEditState` snapshot. A different epoch is a
 * failover: old leases are cleared (with hooks) before the snapshot is applied.
 */
export function applyEditState(notes, nextEpoch) {
  if (nextEpoch != null && mirrorEpoch != null && nextEpoch !== mirrorEpoch) {
    clearEditorState("epochChanged");
  }
  mirrorEpoch = nextEpoch != null ? nextEpoch : mirrorEpoch;

  const incoming = new Map();
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || typeof note.noteId !== "string") continue;
    const lease = note.lease ?? null;
    const preview = note.preview ?? null;
    if (lease || preview) incoming.set(note.noteId, normalizeMirrorEntry(lease, preview));
  }

  const changed = new Set([...mirror.keys(), ...incoming.keys()]);
  for (const noteId of changed) {
    const previous = mirrorEntry(noteId);
    const next = incoming.get(noteId) ?? null;
    if (next) mirror.set(noteId, next);
    else mirror.delete(noteId);
    emitState(noteId, previous, next);
  }
}

/** Applies one `noteEditLeaseChanged` broadcast. */
export function applyLeaseChanged(message) {
  if (!isObject(message) || typeof message.noteId !== "string") return;
  if (message.gmEpoch != null && mirrorEpoch != null && message.gmEpoch !== mirrorEpoch) return;
  const previous = mirrorEntry(message.noteId);
  const lease = message.lease ?? null;
  const preview = Object.hasOwn(message, "preview") ? (message.preview ?? null) : (previous?.preview ?? null);
  writeMirrorEntry(message.noteId, lease, lease ? preview : null);
}

/** Applies one relayed `notePreview` broadcast. */
export function applyPreview(message) {
  if (!isObject(message) || typeof message.noteId !== "string") return;
  if (message.gmEpoch != null && mirrorEpoch != null && message.gmEpoch !== mirrorEpoch) return;
  const previous = mirrorEntry(message.noteId);
  if (previous?.lease && message.leaseToken
      && previous.lease.leaseToken && previous.lease.leaseToken !== message.leaseToken) {
    return;
  }
  if (previous?.preview && Number.isInteger(previous.preview.sequence)
      && Number.isInteger(message.sequence) && message.sequence <= previous.preview.sequence) {
    return;
  }
  writeMirrorEntry(message.noteId, previous?.lease ?? null, {
    noteId: message.noteId,
    leaseToken: message.leaseToken,
    gmEpoch: message.gmEpoch,
    userId: message.userId,
    clientSessionId: message.clientSessionId,
    userName: message.userName,
    sequence: message.sequence,
    body: message.body,
    at: message.at
  });
}

/** Applies one `noteEditRevoked` broadcast, ignoring a stale token for a newer lease. */
export function applyRevoked(message) {
  if (!isObject(message) || typeof message.noteId !== "string") return;
  if (message.gmEpoch != null && mirrorEpoch != null && message.gmEpoch !== mirrorEpoch) return;
  const previous = mirrorEntry(message.noteId);
  const lease = previous?.lease ?? null;
  const token = message.leaseToken;
  if (lease && token && lease.leaseToken && lease.leaseToken !== token) return;
  if (previous?.preview && token && previous.preview.leaseToken && previous.preview.leaseToken !== token) return;
  writeMirrorEntry(message.noteId, null, null,
    typeof message.reason === "string" && message.reason ? message.reason : null);
}

/** Drops every mirrored lease/preview, e.g. on active-GM change. */
export function clearEditorState(reason = "cleared") {
  const noteIds = [...mirror.keys()];
  for (const noteId of noteIds) {
    const previous = mirrorEntry(noteId);
    mirror.delete(noteId);
    emitState(noteId, previous, null);
  }
  mirrorEpoch = null;
  return reason;
}

/** Epoch this client currently trusts: its authority epoch when it is the active GM. */
export function gmEpoch() {
  if (selfIsActiveGM() && epoch) return epoch;
  return mirrorEpoch;
}

// --- Broadcasts --------------------------------------------------------------------------

function emitBroadcast(message) {
  game.socket?.emit(CHANNEL, message);
}

/** Broadcasts lease information (token-free) and updates the GM's own mirror. */
export function broadcastLeaseChanged(noteId, lease, preview, gmEpochValue = null) {
  const message = {
    type: "noteEditLeaseChanged",
    noteId,
    lease: lease ? copy(lease) : null,
    preview: preview ? copy(preview) : null,
    ...(gmEpochValue ? { gmEpoch: gmEpochValue } : {})
  };
  applyLeaseChanged(message);
  emitBroadcast(message);
  return message;
}

/** Broadcasts a revocation. The caller must already have invalidated the authority token. */
export function broadcastRevoked({
  noteId, leaseToken, gmEpoch: epochValue = epoch, reason, revision = 0, byUserId
}) {
  const message = {
    type: "noteEditRevoked",
    noteId,
    leaseToken,
    gmEpoch: epochValue,
    reason,
    revision,
    ...(byUserId ? { byUserId } : {})
  };
  applyRevoked(message);
  emitBroadcast(message);
  return message;
}

/** Broadcasts a relayed preview to every user except its author. */
export function broadcastPreview(preview, authorUserId) {
  const recipients = [];
  for (const user of game.users ?? []) {
    if (user?.id && user.id !== authorUserId) recipients.push(user.id);
  }
  game.socket?.emit(CHANNEL, { type: "notePreview", ...copy(preview) }, { recipients });
  return recipients;
}

// --- Timers and active-GM resync ---------------------------------------------------------

let expiryTimer = null;

/** Active-GM expiry sweep. Expired leases are revoked and unlocked, never silently reused. */
export function startEditExpiry() {
  if (expiryTimer) return expiryTimer;
  expiryTimer = setInterval(() => {
    if (!selfIsActiveGM()) return;
    if (!epoch) initializeAuthority();
    for (const expired of expireLeases()) {
      broadcastRevoked({
        noteId: expired.noteId,
        leaseToken: expired.lease.leaseToken,
        gmEpoch: expired.lease.gmEpoch,
        reason: "expired"
      });
      broadcastLeaseChanged(expired.noteId, null, null, expired.lease.gmEpoch);
    }
  }, HEARTBEAT_MS);
  expiryTimer.unref?.();
  return expiryTimer;
}

let lastActiveGMId = Symbol("unset");

function requestMirrorState(activeGM) {
  if (typeof activeGM !== "string") return;
  const requestId = randomToken();
  game.socket?.emit(CHANNEL, { type: "requestNoteEditState", requestId }, { recipients: [activeGM] });
}

/**
 * Watches active-GM changes. A failover invalidates every mirrored lease; the new GM
 * begins with an empty authority and a fresh epoch, and other clients request a snapshot.
 */
export function startEditResync() {
  const check = () => {
    const current = activeGMId();
    if (current === lastActiveGMId) return;
    lastActiveGMId = current;
    clearEditorState("failover");
    if (!current) {
      epoch = null;
      leases.clear();
      return;
    }
    if (current === game.user?.id) {
      initializeAuthority();
      return;
    }
    requestMirrorState(current);
  };

  lastActiveGMId = Symbol("unset");
  check();
  for (const hook of ["createUser", "updateUser", "deleteUser", "userConnected"]) {
    Hooks.on(hook, check);
  }
}
