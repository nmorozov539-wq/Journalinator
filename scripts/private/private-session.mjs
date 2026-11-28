/**
 * Owner-only private note editing.
 *
 * Private canvases keep their existing permission path: there is no GM lease, no
 * socket traffic, no shared preview and no shared activity. Multiple tabs for one
 * user are coordinated with a localStorage lock and the workspace `rev` guard.
 * The text editor itself is the shared headless `NoteEditorSession`; this module
 * supplies a local `NoteEditTransport` adapter with synthetic `gmEpoch: "local"`.
 *
 * The lock key is
 * `journalinator.private.lock.<worldId>.<userId>.<workspacePageId>.<noteId>` and the
 * value is `{ sessionId, gmEpoch: "local", at }`. A lock is live for `LEASE_MS`
 * after its last heartbeat. Another tab of the same user is reported as `locked`,
 * never silently shared. A `BroadcastChannel` (with a `storage` event fallback)
 * only provides prompt release notices; the stored lock record remains authority.
 */

import { DraftStore } from "../editor/drafts.mjs";
import { NoteEditorSession, noteBodyHash } from "../editor/session.mjs";
import { isFont, isPaper } from "../skins/registry.mjs";
import { isLayout } from "../layouts/registry.mjs";
import { checkpointPrivateHistory } from "./private-history.mjs";

export const LEASE_MS = 30_000;
export const HEARTBEAT_MS = 5_000;
export const LOCK_KEY_PREFIX = "journalinator.private.lock.";
export const MAX_BODY_LENGTH = 200_000;
const MAX_BACKGROUND_LENGTH = 2048;

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function randomId() {
  const foundryRandom = globalThis.foundry?.utils?.randomID;
  if (typeof foundryRandom === "function") return foundryRandom();
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(16));
  if (bytes) {
    return [...bytes].map(byte => (byte % 36).toString(36)).join("");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: id => globalThis.clearTimeout(id)
  };
}

function normalizeLock(value) {
  if (!isObject(value)) return null;
  if (typeof value.sessionId !== "string" || !value.sessionId) return null;
  if (!Number.isFinite(value.at)) return null;
  return {
    sessionId: value.sessionId,
    gmEpoch: "local",
    at: value.at
  };
}

function validSkin(skin) {
  if (!isObject(skin)) return false;
  if (!isPaper(skin.paper) || !isFont(skin.font)) return false;
  if (typeof skin.torn !== "boolean") return false;
  if (!Number.isInteger(skin.tiltSeed) || skin.tiltSeed < 0) return false;
  if (skin.backgroundImage !== null && skin.backgroundImage !== undefined) {
    if (typeof skin.backgroundImage !== "string"
        || skin.backgroundImage.length > MAX_BACKGROUND_LENGTH) return false;
  }
  return true;
}

/**
 * Per-tab local lock for one private note. Not a GM lease: `gmEpoch` is always
 * the literal `"local"`.
 */
export class PrivateEditCoordinator {
  constructor({
    worldId = "",
    userId = "",
    workspacePageId = "",
    noteId = "",
    storage = defaultStorage(),
    now = () => Date.now(),
    timers,
    sessionId,
    broadcast
  } = {}) {
    this.worldId = worldId == null ? "" : String(worldId);
    this.userId = userId == null ? "" : String(userId);
    this.workspacePageId = workspacePageId == null ? "" : String(workspacePageId);
    this.noteId = noteId == null ? "" : String(noteId);
    this.storage = storage ?? null;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.timers = timers ?? defaultTimers();
    this.sessionId = typeof sessionId === "string" && sessionId ? sessionId : randomId();
    this.key = LOCK_KEY_PREFIX
      + [this.worldId, this.userId, this.workspacePageId, this.noteId].join(".");

    this._heartbeatTimer = null;
    this._listeners = new Set();
    this._broadcast = null;
    this._broadcastHandler = null;
    this._storageHandler = null;
    this._disposed = false;

    this._setupNotices(broadcast);
  }

  // --- Storage helpers ------------------------------------------------------------------

  _readRaw() {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.key);
      if (typeof raw !== "string") return null;
      return normalizeLock(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  _write(lock) {
    if (!this.storage) return { ok: false, reason: "storage" };
    try {
      this.storage.setItem(this.key, JSON.stringify(lock));
      return { ok: true };
    } catch {
      return { ok: false, reason: "storage" };
    }
  }

  _remove() {
    if (!this.storage) return false;
    try {
      this.storage.removeItem(this.key);
      return true;
    } catch {
      return false;
    }
  }

  _expired(lock, at = this.now()) {
    return !lock || at - lock.at >= LEASE_MS;
  }

  // --- Public API -----------------------------------------------------------------------

  /** Acquires when absent/expired. A live lock held by another session is `locked`. */
  acquire() {
    if (this._disposed) return { ok: false, type: "closed", reason: "closed" };
    const at = this.now();
    const current = this._readRaw();
    if (current && current.sessionId !== this.sessionId && !this._expired(current, at)) {
      return {
        ok: false,
        type: "locked",
        reason: "locked",
        holder: { sessionId: current.sessionId, at: current.at }
      };
    }
    const lock = { sessionId: this.sessionId, gmEpoch: "local", at };
    const written = this._write(lock);
    if (!written.ok) {
      return { ok: false, type: "unavailable", reason: written.reason ?? "storage" };
    }
    // Verify the write: a storage implementation that silently drops writes must not
    // make two tabs believe they both hold the note.
    const verify = this._readRaw();
    if (!verify || verify.sessionId !== this.sessionId) {
      return {
        ok: false,
        type: "locked",
        reason: "locked",
        holder: verify ? { sessionId: verify.sessionId, at: verify.at } : null
      };
    }
    this._armHeartbeat();
    return { ok: true, type: "acquired", lock, expiresAt: at + LEASE_MS };
  }

  /** Extends our lock. An expired or stolen lock is a loss, never a silent renewal. */
  heartbeat() {
    if (this._disposed) return { ok: false, type: "lost", reason: "closed" };
    const current = this._readRaw();
    if (!current || current.sessionId !== this.sessionId) {
      this._stopHeartbeat();
      return { ok: false, type: "lost", reason: current ? "locked" : "expired" };
    }
    const at = this.now();
    if (this._expired(current, at)) {
      this._stopHeartbeat();
      return { ok: false, type: "lost", reason: "expired" };
    }
    const lock = { sessionId: this.sessionId, gmEpoch: "local", at };
    const written = this._write(lock);
    if (!written.ok) {
      this._stopHeartbeat();
      return { ok: false, type: "lost", reason: written.reason ?? "storage" };
    }
    this._armHeartbeat();
    return { ok: true, type: "heartbeat", lock, expiresAt: at + LEASE_MS };
  }

  /** Releases only our own lock. A lock taken over by another tab is left untouched. */
  release() {
    const current = this._readRaw();
    this._stopHeartbeat();
    if (!current || current.sessionId !== this.sessionId) return false;
    const removed = this._remove();
    if (removed) this._notifyRelease();
    return removed;
  }

  /** Local observation of the lock, for UI status and tests. */
  state() {
    const lock = this._readRaw();
    const at = this.now();
    const expired = this._expired(lock, at);
    return {
      key: this.key,
      sessionId: this.sessionId,
      held: !!lock && !expired,
      byUs: !!lock && lock.sessionId === this.sessionId && !expired,
      expired: !!lock && expired,
      lock: lock ? { ...lock } : null,
      expiresAt: lock ? lock.at + LEASE_MS : null
    };
  }

  isHeldBy(sessionId) {
    const lock = this._readRaw();
    return !!lock && lock.sessionId === sessionId && !this._expired(lock);
  }

  /** Test/admin helper: removes the record without notifying, as if it expired. */
  forceExpire() {
    this._stopHeartbeat();
    return this._remove();
  }

  /** Release notices for the UI. Storage events and BroadcastChannel both feed this. */
  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  dispose() {
    this._disposed = true;
    this._stopHeartbeat();
    this._listeners.clear();
    try {
      this._broadcast?.removeEventListener?.("message", this._broadcastHandler);
      this._broadcast?.close?.();
    } catch {
      // Notice channels are best-effort.
    }
    try {
      globalThis.removeEventListener?.("storage", this._storageHandler);
    } catch {
      // No DOM in Node.
    }
  }

  // --- Internals ------------------------------------------------------------------------

  _armHeartbeat() {
    this._stopHeartbeat();
    const setTimer = this.timers?.setTimeout;
    if (typeof setTimer !== "function") return;
    this._heartbeatTimer = setTimer(() => {
      this._heartbeatTimer = null;
      const result = this.heartbeat();
      if (!result.ok) this._emit({ type: "privateLockLost", reason: result.reason });
    }, HEARTBEAT_MS);
    this._heartbeatTimer?.unref?.();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer == null) return;
    try {
      this.timers?.clearTimeout?.(this._heartbeatTimer);
    } catch {
      // Timers are best-effort.
    }
    this._heartbeatTimer = null;
  }

  _emit(notice) {
    for (const listener of [...this._listeners]) {
      try {
        listener(notice);
      } catch {
        // A UI listener must never break lock bookkeeping.
      }
    }
  }

  _notifyRelease() {
    const notice = {
      type: "privateLockReleased",
      key: this.key,
      sessionId: this.sessionId,
      at: this.now()
    };
    try {
      this._broadcast?.postMessage?.(notice);
    } catch {
      // Storage events may still deliver the change.
    }
    this._emit(notice);
  }

  _setupNotices(broadcast) {
    if (broadcast) {
      this._broadcast = broadcast;
    } else if (typeof globalThis.BroadcastChannel === "function") {
      try {
        this._broadcast = new globalThis.BroadcastChannel(this.key);
        this._broadcast.unref?.();
      } catch {
        this._broadcast = null;
      }
    }
    if (this._broadcast && typeof this._broadcast.addEventListener === "function") {
      this._broadcastHandler = event => {
        const data = event?.data;
        if (!isObject(data) || data.key !== this.key) return;
        if (data.sessionId === this.sessionId) return;
        if (data.type === "privateLockReleased") this._emit(data);
      };
      try {
        this._broadcast.addEventListener("message", this._broadcastHandler);
      } catch {
        this._broadcastHandler = null;
      }
    }
    if (typeof globalThis.addEventListener === "function") {
      this._storageHandler = event => {
        if (event?.key !== this.key) return;
        if (event.newValue === null || event.newValue === undefined) {
          this._emit({
            type: "privateLockReleased",
            key: this.key,
            sessionId: null,
            at: this.now()
          });
        }
      };
      try {
        globalThis.addEventListener("storage", this._storageHandler);
      } catch {
        this._storageHandler = null;
      }
    }
  }
}

function denied(noteId, reason, extra = {}) {
  return { type: "noteEditDenied", noteId, reason, ...extra };
}

function rejected(noteId, reason, extra = {}) {
  return { type: "noteSaveRejected", noteId, reason, ...extra };
}

/**
 * Local `NoteEditTransport` for `NoteEditorSession`.
 *
 * The workspace page is the unit of persistence. Every body save is one page
 * update containing the note and its history; workspace `rev` and note
 * `baseRevision` are checked first. Nothing here touches `game.socket`, shared
 * activity, shared history or a GM lease.
 */
export function createPrivateTransport({
  privateStore,
  pageProvider,
  workspacePage,
  noteId,
  userId,
  coordinator,
  now = () => Date.now(),
  timers
} = {}) {
  if (!privateStore || typeof privateStore.inspectWorkspace !== "function"
      || typeof privateStore.save !== "function") {
    throw new TypeError("createPrivateTransport requires privateStore");
  }
  if (typeof noteId !== "string" || !noteId) {
    throw new TypeError("createPrivateTransport requires a noteId");
  }
  if (!coordinator || typeof coordinator.acquire !== "function") {
    throw new TypeError("createPrivateTransport requires a coordinator");
  }

  const timerSource = timers ?? coordinator.timers ?? defaultTimers();
  const sessionId = coordinator.sessionId;
  let lease = null;
  let workspaceRev = null;
  let confirmedBody = "";
  let confirmedRevision = 0;
  let startCaptured = false;

  const pageNow = () => {
    if (typeof pageProvider === "function") return pageProvider() ?? workspacePage ?? null;
    return pageProvider ?? workspacePage ?? null;
  };
  const noteOf = workspace => workspace?.notes?.[noteId] ?? null;
  const currentNote = status => noteOf(status.workspace);

  const inspect = () => {
    const page = pageNow();
    if (!page) return { page: null, status: null };
    return { page, status: privateStore.inspectWorkspace(page) };
  };

  const lockLost = () => !coordinator.isHeldBy(sessionId);

  const stale = (note, extra = {}) => rejected(noteId, "staleRevision", {
    revision: Number.isInteger(note?.revision) ? note.revision : confirmedRevision,
    workspaceRev,
    ...extra
  });

  const cloneWorkspace = workspace => {
    const deepClone = globalThis.foundry?.utils?.deepClone;
    if (typeof deepClone === "function") return deepClone(workspace);
    return structuredClone(workspace);
  };

  const saveBody = async ({ sequence, baseRevision, body, final = false } = {}) => {
    if (!lease || lockLost()) return rejected(noteId, "leaseLost", { revision: confirmedRevision });
    if (!Number.isInteger(sequence) || sequence < 0) return rejected(noteId, "invalid");
    if (!Number.isInteger(baseRevision) || baseRevision < 0) return rejected(noteId, "invalid");
    if (typeof body !== "string") return rejected(noteId, "invalid");
    if (body.length > MAX_BODY_LENGTH) return rejected(noteId, "tooLarge");

    const { page, status } = inspect();
    if (!page) return rejected(noteId, "missing", { revision: confirmedRevision });
    if (!status?.ok) {
      return rejected(noteId, "incompatible", { revision: confirmedRevision });
    }
    const note = currentNote(status);
    if (!note) return rejected(noteId, "missing", { revision: confirmedRevision });
    if (note.deleted) return rejected(noteId, "trashed", { revision: note.revision });

    const bodyHash = noteBodyHash(body);
    const at = now();
    // An identical body is an acknowledgement, never a workspace write. This matches the
    // shared protocol's no-op ordering and keeps history/activity side effects absent.
    if (body === note.body) {
      confirmedBody = note.body;
      confirmedRevision = note.revision;
      return {
        type: "noteSaveAck",
        noteId,
        revision: note.revision,
        sequence,
        bodyHash,
        acceptedAt: at,
        workspaceRev: status.rev,
        ...(note.lastSave ? { receipt: cloneWorkspace(note.lastSave) } : {})
      };
    }

    if (workspaceRev !== null && status.rev !== workspaceRev) {
      return stale(note, { workspaceRev: status.rev });
    }
    if (baseRevision !== note.revision) return stale(note);

    let working = cloneWorkspace(status.workspace);
    const nextRevision = note.revision + 1;
    const previousBody = note.body;
    const previousRevision = note.revision;
    const needsStart = !startCaptured;

    // Session-start checkpoint of the confirmed pre-edit body. It is written in the
    // same page update as the first saved body.
    if (needsStart) {
      working = checkpointPrivateHistory(working, noteId, {
        body: previousBody,
        revision: previousRevision,
        authorId: userId,
        at
      }, { now: at, force: true }).workspace;
    }

    const lastSave = {
      requestId: `${sessionId}:${sequence}`,
      clientSessionId: sessionId,
      sequence,
      revision: nextRevision,
      bodyHash,
      at,
      eventIds: []
    };
    const savedNote = working.notes[noteId];
    savedNote.body = body;
    savedNote.revision = nextRevision;
    savedNote.updatedAt = at;
    savedNote.lastSave = lastSave;

    if (final) {
      working = checkpointPrivateHistory(working, noteId, {
        body,
        revision: nextRevision,
        authorId: userId,
        at
      }, { now: at, force: true }).workspace;
    } else {
      working = checkpointPrivateHistory(working, noteId, {
        body,
        revision: nextRevision,
        authorId: userId,
        at
      }, { now: at }).workspace;
    }

    try {
      const saved = await privateStore.save(page, working, status.rev);
      workspaceRev = saved.rev;
      confirmedBody = body;
      confirmedRevision = nextRevision;
      if (needsStart) startCaptured = true;
      return {
        type: "noteSaveAck",
        noteId,
        revision: nextRevision,
        sequence,
        bodyHash,
        acceptedAt: at,
        workspaceRev: saved.rev,
        receipt: cloneWorkspace(lastSave)
      };
    } catch (error) {
      if (error?.name === "JN.Private.IncompatibleFormat") {
        return rejected(noteId, "incompatible", { revision: note.revision });
      }
      const after = inspect();
      const afterNote = after.status?.ok ? currentNote(after.status) : null;
      if (afterNote && after.status.rev === status.rev
          && afterNote.revision === note.revision && afterNote.body === previousBody) {
        return rejected(noteId, "invalid", { revision: note.revision });
      }
      // A concurrent workspace writer won the CAS. Do not overwrite it.
      return stale(afterNote ?? note, {
        workspaceRev: after.status?.ok ? after.status.rev : workspaceRev
      });
    }
  };

  const captureFinal = async () => {
    const { page, status } = inspect();
    if (!page) return rejected(noteId, "missing", { revision: confirmedRevision });
    if (!status?.ok) return rejected(noteId, "incompatible", { revision: confirmedRevision });
    const note = currentNote(status);
    if (!note) return rejected(noteId, "missing", { revision: confirmedRevision });
    if (workspaceRev !== null && status.rev !== workspaceRev) {
      return stale(note, { workspaceRev: status.rev });
    }
    const next = cloneWorkspace(status.workspace);
    const result = checkpointPrivateHistory(next, noteId, {
      body: note.body,
      revision: note.revision,
      authorId: userId,
      at: now()
    }, { now: now(), force: true });
    if (!result.recorded) {
      return { ok: true, revision: note.revision, saved: false, workspaceRev: status.rev };
    }
    try {
      const saved = await privateStore.save(page, result.workspace, status.rev);
      workspaceRev = saved.rev;
      confirmedBody = note.body;
      confirmedRevision = note.revision;
      return { ok: true, revision: note.revision, saved: false, workspaceRev: saved.rev };
    } catch (error) {
      if (error?.name === "JN.Private.IncompatibleFormat") {
        return rejected(noteId, "incompatible", { revision: note.revision });
      }
      const after = inspect();
      return stale(after.status?.ok ? currentNote(after.status) : note, {
        workspaceRev: after.status?.ok ? after.status.rev : workspaceRev
      });
    }
  };

  return {
    begin({ noteId: requested } = {}) {
      if (requested !== undefined && requested !== noteId) {
        return denied(noteId, "missing");
      }
      const { page, status } = inspect();
      if (!page) return denied(noteId, "missing");
      if (!status?.ok) return denied(noteId, "incompatible", { format: status?.format ?? null });
      const note = currentNote(status);
      if (!note) return denied(noteId, "missing");
      if (note.deleted) return denied(noteId, "trashed");

      if (lease && coordinator.isHeldBy(sessionId)) {
        return {
          type: "noteEditGranted",
          noteId,
          lease,
          revision: note.revision,
          body: note.body,
          layout: note.layout,
          skin: note.skin,
          deleted: false,
          lastSave: note.lastSave ?? null,
          expiresAt: now() + LEASE_MS,
          workspaceRev: status.rev
        };
      }

      const acquired = coordinator.acquire();
      if (!acquired.ok) {
        return denied(noteId, acquired.reason === "storage" ? "locked" : (acquired.reason ?? "locked"), {
          ...(acquired.holder ? { holder: acquired.holder } : {})
        });
      }

      lease = {
        canvasId: "private",
        noteId,
        userId,
        clientSessionId: sessionId,
        leaseToken: `local:${sessionId}`,
        gmEpoch: "local"
      };
      workspaceRev = status.rev;
      confirmedBody = note.body;
      confirmedRevision = note.revision;
      startCaptured = false;
      return {
        type: "noteEditGranted",
        noteId,
        lease,
        revision: note.revision,
        body: note.body,
        layout: note.layout,
        skin: note.skin,
        deleted: false,
        lastSave: note.lastSave ?? null,
        expiresAt: now() + LEASE_MS,
        workspaceRev: status.rev
      };
    },

    heartbeat({ lease: sent } = {}) {
      if (!lease || (sent && sent.leaseToken !== lease.leaseToken)) {
        return { type: "noteEditRevoked", noteId, reason: "expired", revision: confirmedRevision };
      }
      const result = coordinator.heartbeat();
      if (!result.ok) {
        return {
          type: "noteEditRevoked",
          noteId,
          reason: result.reason === "locked" ? "locked" : "expired",
          revision: confirmedRevision
        };
      }
      return {
        type: "noteEditHeartbeatAck",
        noteId,
        leaseToken: lease.leaseToken,
        gmEpoch: "local",
        revision: confirmedRevision,
        expiresAt: result.expiresAt
      };
    },

    /** Private previews are local only: no socket message and no shared activity. */
    preview() {
      return undefined;
    },

    save({ noteId: requested, sequence, baseRevision, body } = {}) {
      if (requested !== undefined && requested !== noteId) return rejected(noteId, "missing");
      return saveBody({ sequence, baseRevision, body });
    },

    async appearance({ noteId: requested, layout, skin } = {}) {
      if (requested !== undefined && requested !== noteId) return rejected(noteId, "missing");
      if (!lease || lockLost()) return rejected(noteId, "leaseLost", { revision: confirmedRevision });
      if (!isLayout(layout) || !validSkin(skin)) {
        return { type: "noteAppearanceRejected", noteId, reason: "invalid" };
      }
      const { page, status } = inspect();
      if (!page) return rejected(noteId, "missing", { revision: confirmedRevision });
      if (!status?.ok) {
        return { type: "noteAppearanceRejected", noteId, reason: "incompatible" };
      }
      const note = currentNote(status);
      if (!note) return rejected(noteId, "missing", { revision: confirmedRevision });
      if (note.deleted) return { type: "noteAppearanceRejected", noteId, reason: "trashed" };
      if (workspaceRev !== null && status.rev !== workspaceRev) {
        return { type: "noteAppearanceRejected", noteId, reason: "staleRevision",
          revision: note.revision, workspaceRev: status.rev };
      }

      const cleanSkin = {
        paper: skin.paper,
        font: skin.font,
        torn: skin.torn,
        backgroundImage: typeof skin.backgroundImage === "string" && skin.backgroundImage.trim()
          ? skin.backgroundImage : null,
        tiltSeed: skin.tiltSeed
      };
      if (note.layout === layout
          && note.skin.paper === cleanSkin.paper
          && note.skin.font === cleanSkin.font
          && note.skin.torn === cleanSkin.torn
          && (note.skin.backgroundImage ?? null) === cleanSkin.backgroundImage
          && note.skin.tiltSeed === cleanSkin.tiltSeed) {
        return {
          type: "noteAppearanceAck",
          noteId,
          layout,
          skin: note.skin,
          updatedAt: note.updatedAt,
          workspaceRev: status.rev,
          changed: false
        };
      }

      const next = cloneWorkspace(status.workspace);
      const savedNote = next.notes[noteId];
      const updatedAt = now();
      savedNote.layout = layout;
      savedNote.skin = cleanSkin;
      savedNote.updatedAt = updatedAt;
      try {
        const saved = await privateStore.save(page, next, status.rev);
        workspaceRev = saved.rev;
        return {
          type: "noteAppearanceAck",
          noteId,
          layout,
          skin: cleanSkin,
          updatedAt,
          workspaceRev: saved.rev,
          changed: true
        };
      } catch (error) {
        if (error?.name === "JN.Private.IncompatibleFormat") {
          return { type: "noteAppearanceRejected", noteId, reason: "incompatible" };
        }
        const after = inspect();
        return {
          type: "noteAppearanceRejected",
          noteId,
          reason: "staleRevision",
          revision: after.status?.ok ? currentNote(after.status)?.revision ?? note.revision : note.revision,
          workspaceRev: after.status?.ok ? after.status.rev : workspaceRev
        };
      }
    },

    async end({ noteId: requested, sequence, baseRevision, body } = {}) {
      if (requested !== undefined && requested !== noteId) {
        return { type: "noteEditEnded", noteId, revision: confirmedRevision, saved: false, released: false };
      }
      if (!lease || lockLost()) {
        return { type: "noteEditEnded", noteId, revision: confirmedRevision, saved: false, released: false };
      }

      let saved = false;
      let revision = confirmedRevision;
      if (typeof body === "string") {
        const { status } = inspect();
        const note = status?.ok ? currentNote(status) : null;
        if (note && body !== note.body) {
          const result = await saveBody({
            sequence: Number.isInteger(sequence) ? sequence : 0,
            baseRevision: Number.isInteger(baseRevision) ? baseRevision : note.revision,
            body,
            final: true
          });
          if (result.type !== "noteSaveAck") return result;
          saved = true;
          revision = result.revision;
        }
      }

      const final = await captureFinal();
      if (final?.type === "noteSaveRejected") return final;
      if (final?.type === "noteAppearanceRejected") return final;
      revision = final?.revision ?? revision;
      const released = coordinator.release();
      lease = null;
      return {
        type: "noteEditEnded",
        noteId,
        revision,
        saved,
        released
      };
    },

    state() {
      const { page, status } = inspect();
      if (!page || !status?.ok) return { type: "timeout", noteId };
      const note = currentNote(status);
      return {
        type: "noteEditState",
        noteId,
        gmEpoch: "local",
        at: now(),
        workspaceRev: status.rev,
        note: {
          noteId,
          revision: note?.revision ?? 0,
          body: note ? note.body : null,
          deleted: !note || !!note.deleted
        }
      };
    },

    now: () => now(),
    setTimeout: (fn, ms) => timerSource.setTimeout(fn, ms),
    clearTimeout: id => timerSource.clearTimeout(id),

    // Test/introspection helpers; not part of the editor protocol.
    get lease() { return lease; },
    get workspaceRev() { return workspaceRev; },
    get confirmedBody() { return confirmedBody; }
  };
}

/**
 * Convenience constructor for T7b: shared `NoteEditorSession` + local transport +
 * per-tab `DraftStore` identity `{ origin, worldId, userId, canvasId: "private",
 * clientSessionId }`.
 */
export function createPrivateEditorSession({
  privateStore,
  pageProvider,
  workspacePage,
  noteId,
  userId,
  worldId = "",
  origin = "",
  storage,
  coordinator,
  now = () => Date.now(),
  timers,
  clientSessionId,
  onState,
  onError,
  onLeaseLost,
  onSaved
} = {}) {
  const localCoordinator = coordinator ?? new PrivateEditCoordinator({
    worldId,
    userId,
    workspacePageId: workspacePage?.id ?? "",
    noteId,
    storage,
    now,
    timers
  });
  const transport = createPrivateTransport({
    privateStore,
    pageProvider,
    workspacePage,
    noteId,
    userId,
    coordinator: localCoordinator,
    now,
    timers
  });
  const drafts = new DraftStore({
    origin,
    worldId,
    userId,
    canvasId: "private",
    storage,
    now,
    timers
  });
  return new NoteEditorSession({
    noteId,
    transport,
    drafts,
    clientSessionId: clientSessionId ?? localCoordinator.sessionId,
    now,
    timers,
    onState,
    onError,
    onLeaseLost,
    onSaved
  });
}
