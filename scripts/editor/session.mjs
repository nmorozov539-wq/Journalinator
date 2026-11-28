/**
 * Headless note editor session: lease acquisition, preview/autosave traffic, save
 * acknowledgement handling, timeout reconciliation, appearance saves and local recovery
 * drafts. Nothing in this module touches the DOM, Foundry globals, sockets or the app
 * shell; callers inject a transport and a draft store.
 */

export const PREVIEW_MS = 150;
export const AUTOSAVE_MS = 700;
export const AUTOSAVE_MAX_MS = 3000;
export const HEARTBEAT_MS = 5000;

const MAX_BODY_LENGTH = 200000;

/**
 * @typedef {Object} NoteEditLease
 * @property {string} canvasId
 * @property {string} noteId
 * @property {string} userId
 * @property {string} clientSessionId
 * @property {string} leaseToken
 * @property {string} gmEpoch
 */

/**
 * Transport supplied by the socket adapter (T6b) / private adapter (T7).
 *
 * Replies keep the protocol's targeted-reply shapes. `timeout` is a resolved reply,
 * never a thrown error, so an uncertain save can be reconciled.
 *
 * @typedef {Object} NoteEditTransport
 * @property {(args: {noteId: string}) => Promise<Object>} begin
 *   Resolves `noteEditGranted`, `noteEditDenied` or `timeout`.
 * @property {(args: {noteId: string, lease: NoteEditLease}) => Promise<Object>} heartbeat
 *   Resolves `noteEditHeartbeatAck`, `noteEditRevoked` or `timeout`.
 * @property {(args: {noteId: string, lease: NoteEditLease, sequence: number, body: string}) => void} preview
 *   Fire-and-forget ephemeral preview.
 * @property {(args: {
 *   noteId: string, lease: NoteEditLease, sequence: number, baseRevision: number,
 *   body: string, geometry: Object|null, eventIds: string[]
 * }) => Promise<Object>} save
 *   Resolves `noteSaveAck`, `noteSaveRejected` or `timeout`.
 * @property {(args: {
 *   noteId: string, lease: NoteEditLease, layout: string, skin: Object
 * }) => Promise<Object>} appearance
 *   Resolves `noteAppearanceAck`, `noteAppearanceRejected` or `timeout`.
 * @property {(args: {
 *   noteId: string, lease: NoteEditLease, sequence: number, body: string|undefined,
 *   baseRevision: number, geometry: Object|null, eventIds: string[]
 * }) => Promise<Object>} end
 *   Resolves `noteEditEnded`, `noteSaveRejected` or `timeout`.
 * @property {(args: {noteId: string}) => Promise<Object>} state
 *   Resolves `noteEditState` (optionally carrying `body`/`revision`) or `timeout`.
 * @property {() => number} now
 * @property {(fn: Function, ms: number) => *} setTimeout
 * @property {(id: *) => void} clearTimeout
 */

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value) {
  return Number.isInteger(value) && value >= 0;
}

function errorReason(error) {
  return error?.name || error?.message || "transport";
}

/** FNV-1a over UTF-16 code units, matching the persisted `lastSave.bodyHash`. */
export function noteBodyHash(body) {
  const text = typeof body === "string" ? body : "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const TERMINAL_STATES = new Set(["denied", "leaseLost", "forced", "closed", "disposed"]);
const SEND_STATES = new Set(["editing", "saving"]);

/**
 * @typedef {Object} EditorStatus
 * @property {string} state
 * @property {boolean} dirty
 * @property {boolean} saving
 * @property {number} confirmedRevision
 * @property {number} bodyLength
 * @property {boolean} savedLocally
 * @property {string|null} error
 */

export class NoteEditorSession {
  /**
   * @param {Object} options
   * @param {string} options.noteId
   * @param {{body?: string, revision?: number, layout?: string, skin?: Object}} [options.note]
   * @param {NoteEditTransport} options.transport
   * @param {Object} [options.drafts]
   * @param {string} options.clientSessionId
   * @param {() => number} [options.now]
   * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
   * @param {(status: EditorStatus) => void} [options.onState]
   * @param {(error: *) => void} [options.onError]
   * @param {(reason: string) => void} [options.onLeaseLost]
   * @param {(reply: Object) => void} [options.onSaved]
   */
  constructor({
    noteId,
    note = {},
    transport,
    drafts = null,
    clientSessionId = "default",
    now,
    timers,
    onState,
    onError,
    onLeaseLost,
    onSaved
  } = {}) {
    if (typeof noteId !== "string" || !noteId) {
      throw new TypeError("NoteEditorSession requires a noteId");
    }
    if (!transport || typeof transport.begin !== "function") {
      throw new TypeError("NoteEditorSession requires a transport");
    }

    this.noteId = noteId;
    this.transport = transport;
    this.drafts = drafts;
    this.clientSessionId = String(clientSessionId ?? "default");

    this._now = typeof now === "function"
      ? now
      : (typeof transport.now === "function" ? () => transport.now() : () => Date.now());
    const timerSource = timers ?? transport;
    this._setTimeout = typeof timerSource?.setTimeout === "function"
      ? timerSource.setTimeout.bind(timerSource)
      : globalThis.setTimeout.bind(globalThis);
    this._clearTimeout = typeof timerSource?.clearTimeout === "function"
      ? timerSource.clearTimeout.bind(timerSource)
      : globalThis.clearTimeout.bind(globalThis);

    this._onState = typeof onState === "function" ? onState : null;
    this._onError = typeof onError === "function" ? onError : null;
    this._onLeaseLost = typeof onLeaseLost === "function" ? onLeaseLost : null;
    this._onSaved = typeof onSaved === "function" ? onSaved : null;

    const initialBody = typeof note?.body === "string" ? note.body : "";
    this._initialBody = initialBody;
    this._body = initialBody;
    this._confirmedBody = initialBody;
    this._confirmedRevision = isRevision(note?.revision) ? note.revision : 0;
    this._layout = note?.layout ?? "plain";
    this._skin = note?.skin ?? null;

    this._lease = null;
    this._state = "idle";
    this._error = null;
    this._dirty = false;
    this._composing = false;
    this._sequence = 0;

    this._previewTimer = null;
    this._previewAt = -Infinity;
    this._autosaveTimer = null;
    this._dirtySince = null;
    this._heartbeatTimer = null;
    this._leaseUncertain = false;
    this._draftTimer = null;

    this._inFlight = null;
    this._saveQueued = false;
    this._savedLocally = false;
    this._draftError = null;

    this._geometry = null;
    this._eventIds = [];
    this._appearanceToken = 0;
    this._openPromise = null;
    this._remoteRevision = null;
    this._remoteBody = null;
  }

  // --- Read-only view -------------------------------------------------------------------

  get body() { return this._body; }
  get confirmedBody() { return this._confirmedBody; }
  get revision() { return this._confirmedRevision; }
  get confirmedRevision() { return this._confirmedRevision; }
  get layout() { return this._layout; }
  get skin() { return this._skin; }
  get lease() { return this._lease; }
  get state() { return this._state; }
  get dirty() { return this._dirty; }
  get sequence() { return this._sequence; }

  /** UI-facing status; deliberately a flat object with stable keys. */
  status() {
    return {
      state: this._state,
      dirty: this._dirty,
      saving: this._inFlight != null,
      confirmedRevision: this._confirmedRevision,
      bodyLength: this._body.length,
      savedLocally: this._savedLocally,
      error: this._error
    };
  }

  // --- Lifecycle ------------------------------------------------------------------------

  /**
   * Requests the lease. A denied or acquiring session never sends previews or saves.
   * A transport failure becomes `offline` and keeps the local body.
   */
  open() {
    if (this._openPromise) return this._openPromise;
    if (TERMINAL_STATES.has(this._state)) {
      return Promise.resolve({ ok: false, type: "error", reason: this._state });
    }
    this._setState("acquiring", null);
    this._openPromise = (async () => {
      let reply;
      try {
        reply = await this.transport.begin({ noteId: this.noteId });
      } catch (error) {
        this._reportError(error);
        this._setState("offline", errorReason(error));
        return { ok: false, type: "error", reason: errorReason(error) };
      }

      if (reply?.type === "noteEditGranted" && isObject(reply.lease)) {
        this._lease = reply.lease;
        this._confirmedRevision = isRevision(reply.revision)
          ? reply.revision
          : this._confirmedRevision;
        this._confirmedBody = typeof reply.body === "string" ? reply.body : this._confirmedBody;
        if (reply.layout !== undefined) this._layout = reply.layout;
        if (reply.skin !== undefined) this._skin = reply.skin;

        // A local edit made while acquiring is preserved; otherwise the grant body wins.
        if (this._body === this._initialBody) this._body = this._confirmedBody;
        this._dirty = this._body !== this._confirmedBody;
        this._dirtySince = this._dirty ? this._now() : null;
        this._leaseUncertain = false;
        this._setState("editing", null);
        this._startHeartbeat();
        if (this._dirty) {
          this._scheduleDraft();
          this._schedulePreview();
          this._ensureAutosaveScheduled();
        }
        this._emitStatus();
        return { ok: true, type: "noteEditGranted", reply };
      }

      if (reply?.type === "noteEditDenied") {
        const reason = reply.reason ?? "denied";
        this._setState(reason === "noActiveGM" ? "offline" : "denied", reason);
        return { ok: false, type: reply.type, reason };
      }

      if (reply?.type === "noteSaveRejected") {
        const reason = reply.reason ?? "rejected";
        this._setState("rejected", reason);
        return { ok: false, type: reply.type, reason };
      }

      const reason = reply?.type === "timeout" || !reply ? "timeout" : (reply.reason ?? "unavailable");
      this._setState("offline", reason);
      return { ok: false, type: reply?.type ?? "timeout", reason };
    })();
    return this._openPromise;
  }

  /**
   * Background-throttle recovery. Revalidates the lease before any further send; a missing
   * acknowledgement is treated as lease loss, never as permission to keep writing.
   */
  async revalidate() {
    if (!this._lease || TERMINAL_STATES.has(this._state)) {
      return { ok: false, type: "error", reason: this._state };
    }
    let reply;
    try {
      reply = await this.transport.heartbeat({ noteId: this.noteId, lease: this._lease });
    } catch (error) {
      this._reportError(error);
      this.applyLeaseLost("leaseLost");
      return { ok: false, type: "error", reason: "leaseLost" };
    }
    if (reply?.type === "noteEditHeartbeatAck") {
      if ((reply.leaseToken && reply.leaseToken !== this._lease.leaseToken)
          || (reply.gmEpoch && reply.gmEpoch !== this._lease.gmEpoch)) {
        this.applyLeaseLost("leaseLost");
        return { ok: false, type: "error", reason: "leaseLost" };
      }
      this._leaseUncertain = false;
      if (this._state === "offline") this._setState("editing", null);
      this._scheduleHeartbeat();
      if (this._dirty) this._ensureAutosaveScheduled();
      return { ok: true, type: reply.type, reply };
    }
    const reason = reply?.type === "noteEditRevoked"
      ? (reply.reason ?? "leaseLost")
      : "leaseLost";
    this.applyLeaseLost(reason);
    return { ok: false, type: reply?.type ?? "timeout", reason };
  }

  /**
   * Stops heartbeat, preview and autosave; persists the local draft and keeps the text.
   * `forced` is a GM force-unlock, every other reason is reported as `leaseLost`.
   */
  applyLeaseLost(reason = "leaseLost") {
    if (this._state === "leaseLost" || this._state === "forced"
        || this._state === "closed" || this._state === "disposed") return;
    const forced = reason === "forced";
    this._cancelPreview();
    this._cancelAutosave();
    this._stopHeartbeat();
    this._clearDraftTimer();
    this._leaseUncertain = true;
    this._saveQueued = false;
    this.flushDraft();
    // A pending identity from an in-flight save is meaningless once the lease is gone.
    this._writeDraftNow(null);
    this._lease = null;
    this._setState(forced ? "forced" : "leaseLost", reason);
    this._emitStatus();
    try {
      this._onLeaseLost?.(forced ? "forced" : "leaseLost");
    } catch (error) {
      this._reportError(error);
    }
  }

  /**
   * Flushes a pending save, calls `end`, and releases only after the end acknowledgement.
   * A failed end keeps the lease/session and the local draft; the caller may retry close.
   *
   * @param {{release?: boolean}} [options]
   */
  async close({ release = true } = {}) {
    if (this._state === "closed") {
      return { ok: true, type: "closed", released: true };
    }
    if (this._state === "disposed") {
      return { ok: false, type: "error", reason: "disposed" };
    }

    this._cancelPreview();
    this._cancelAutosave();
    this._stopHeartbeat();

    if (!release) {
      this.flushDraft();
      this._lease = null;
      this._setState("closed", null);
      return { ok: true, type: "closed", released: false };
    }

    if (!this._lease) {
      this.flushDraft();
      this._setState("closed", null);
      return { ok: true, type: "closed", released: false };
    }

    if (this._inFlight) {
      try {
        await this._inFlight.promise;
      } catch {
        // Save failures are represented by state, never by a rejected session promise.
      }
    }

    if (this._dirty && this._canSaveNow()) {
      await this.flush({ reason: "close" });
    }

    if (!this._lease) {
      // The lease was revoked while flushing; keep the terminal session and its draft.
      this.flushDraft();
      return { ok: false, type: "error", reason: this._state };
    }

    const maySendBody = this._canSaveNow()
      && this._state !== "conflict"
      && this._state !== "rejected";
    const payload = {
      noteId: this.noteId,
      lease: this._lease,
      sequence: this._nextSequence(),
      baseRevision: this._confirmedRevision,
      body: maySendBody ? this._body : undefined,
      geometry: this._geometry ?? null,
      eventIds: [...this._eventIds]
    };

    let reply;
    try {
      reply = await this.transport.end(payload);
    } catch (error) {
      this._reportError(error);
      this._setState("offline", errorReason(error));
      this.flushDraft();
      this._restartHeartbeatIfPossible();
      return { ok: false, type: "error", reason: errorReason(error) };
    }

    if (reply?.type === "noteEditEnded") {
      if (isRevision(reply.revision)) this._confirmedRevision = reply.revision;
      this._lease = null;
      this._cancelPreview();
      this._cancelAutosave();
      this._stopHeartbeat();
      this._setState("closed", null);
      if (this._dirty) this.flushDraft();
      else this._removeDraft();
      return {
        ok: reply.released !== false,
        type: "noteEditEnded",
        released: reply.released !== false,
        revision: this._confirmedRevision,
        reply
      };
    }

    if (reply?.type === "noteSaveRejected" || reply?.type === "noteEditDenied") {
      const reason = reply.reason ?? "rejected";
      if (reason === "leaseLost") {
        this.applyLeaseLost("leaseLost");
      } else if (reason === "staleRevision") {
        if (isRevision(reply.revision)) this._confirmedRevision = reply.revision;
        this._setState("conflict", reason);
        this.flushDraft();
      } else if (reason === "noActiveGM") {
        this._setState("offline", reason);
        this.flushDraft();
      } else {
        this._setState("rejected", reason);
        this.flushDraft();
      }
      this._restartHeartbeatIfPossible();
      return { ok: false, type: reply.type, reason, reply };
    }

    const reason = reply?.type === "timeout" || !reply ? "timeout" : (reply.reason ?? "unavailable");
    this._setState("offline", reason);
    this.flushDraft();
    this._restartHeartbeatIfPossible();
    return { ok: false, type: reply?.type ?? "timeout", reason };
  }

  /** Pagehide: stop timers and persist, but never send `end` or claim a release. */
  dispose() {
    if (this._state === "closed" || this._state === "disposed") return;
    this._cancelPreview();
    this._cancelAutosave();
    this._stopHeartbeat();
    this._clearDraftTimer();
    this.flushDraft();
    this._setState("disposed", null);
  }

  // --- Text and save flow ---------------------------------------------------------------

  /**
   * Stores the exact source text. Composition updates local text only; the caller repeats
   * the call with `composing: false` on compositionend to allow preview/autosave.
   *
   * @param {string} body
   * @param {{composing?: boolean}} [options]
   */
  setBody(body, { composing = false } = {}) {
    if (typeof body !== "string") return;
    this._body = body;
    this._composing = !!composing;

    const wasClean = !this._dirty;
    this._dirty = body !== this._confirmedBody;
    if (this._dirty) {
      if (this._dirtySince == null) this._dirtySince = this._now();
    } else {
      this._dirtySince = null;
      this._cancelAutosave();
    }

    this._scheduleDraft();
    if (wasClean !== !this._dirty) this._emitStatus();

    if (composing) {
      this._cancelPreview();
      this._cancelAutosave();
      return;
    }

    if (!this._previewAllowed()) return;
    this._schedulePreview();
    if (this._dirty) this._ensureAutosaveScheduled();
  }

  /**
   * Forces an immediate save when dirty. Returns a synthetic `{type:"noop"}` when the
   * body already equals the confirmed text, without calling the transport or advancing
   * the sequence.
   *
   * @param {{reason?: string, geometry?: Object|null, eventIds?: string[]}} [options]
   */
  async flush({ reason = "manual", geometry, eventIds } = {}) {
    if (geometry !== undefined) this._geometry = geometry;
    if (eventIds !== undefined) this._eventIds = Array.isArray(eventIds) ? [...eventIds] : [];
    void reason;

    this._cancelAutosave();

    if (this._inFlight) {
      if (this._body !== this._inFlight.snapshot.body) this._saveQueued = true;
      return this._inFlight.promise;
    }

    if (!this._dirty) {
      this._removeCleanDraft();
      return { type: "noop" };
    }

    if (this._state === "offline" && this._leaseUncertain) {
      const revalidated = await this.revalidate();
      if (!revalidated.ok) {
        return { type: "error", reason: revalidated.reason ?? "leaseLost" };
      }
    }

    if (!this._canSaveNow()) return this._failure(this._state);

    return this._startSave();
  }

  /** Ctrl/Cmd+S and Done alias. */
  saveNow(options) {
    return this.flush(options);
  }

  /** Writes any coalesced draft now (blur/pagehide/switch/lock loss/close). */
  flushDraft() {
    this._clearDraftTimer();
    this._writeDraftNow();
    try {
      this.drafts?.flushPending?.();
    } catch (error) {
      this._reportError(error);
    }
    return this._savedLocally;
  }

  // --- Remote and appearance updates ----------------------------------------------------

  /**
   * Conservative remote application. Local text is never replaced. Confirmed values move
   * only when the session is clean and nothing is in flight; a dirty session keeps its
   * base revision and only conflicts later if a save actually fails.
   */
  applyRemote({ body, revision, layout, skin } = {}) {
    if (this._state === "closed" || this._state === "disposed") return;
    const nextRevision = isRevision(revision) ? revision : null;
    if (nextRevision !== null && nextRevision < this._confirmedRevision) return;

    if (this._dirty || this._inFlight) {
      if (nextRevision !== null && nextRevision > this._confirmedRevision) {
        this._remoteRevision = nextRevision;
        if (typeof body === "string") this._remoteBody = body;
      }
      return;
    }

    if (nextRevision !== null) this._confirmedRevision = nextRevision;
    if (typeof body === "string") this._confirmedBody = body;
    if (layout !== undefined && layout !== null) this._layout = layout;
    if (skin !== undefined && skin !== null) this._skin = skin;
    this._dirty = false;
    this._dirtySince = null;
    this._emitStatus();
  }

  /** Lease-holder layout change. Confirmed layout changes only after an ack. */
  setLayout(layout) {
    return this._setAppearance({ layout });
  }

  /** Lease-holder skin change. Confirmed skin changes only after an ack. */
  setSkin(skin) {
    return this._setAppearance({ skin });
  }

  // --- Draft helpers --------------------------------------------------------------------

  _draftRecord(pending = undefined) {
    const record = {
      body: this._body,
      baseRevision: this._confirmedRevision,
      acknowledgedBody: this._confirmedBody,
      acknowledgedRevision: this._confirmedRevision,
      at: this._now()
    };
    const snapshot = pending === undefined ? this._inFlight?.snapshot : pending;
    if (snapshot) {
      record.pendingRequestId = snapshot.requestId;
      record.pendingSequence = snapshot.sequence;
      record.pendingBodyHash = snapshot.bodyHash;
    }
    return record;
  }

  _scheduleDraft() {
    if (!this.drafts || this._state === "closed" || this._state === "disposed") return;
    if (this._draftTimer != null) {
      this._clearTimeout(this._draftTimer);
      this._draftTimer = null;
    }
    this._draftTimer = this._setTimeout(() => {
      this._draftTimer = null;
      this._writeDraftNow();
    }, PREVIEW_MS);
    this._draftTimer?.unref?.();
  }

  _clearDraftTimer() {
    if (this._draftTimer == null) return;
    this._clearTimeout(this._draftTimer);
    this._draftTimer = null;
  }

  _writeDraftNow(pending = undefined) {
    if (!this.drafts) return;
    const snapshot = pending === undefined ? this._inFlight?.snapshot : pending;
    if (!this._dirty && !snapshot) {
      this._removeCleanDraft();
      return;
    }
    let ok = false;
    try {
      ok = this.drafts.save(this.noteId, this.clientSessionId, this._draftRecord(snapshot));
    } catch (error) {
      this._reportError(error);
      ok = false;
    }
    this._savedLocally = !!ok;
    this._draftError = ok ? null : "unavailable";
    this._emitStatus();
  }

  _removeDraft() {
    let ok = true;
    try {
      ok = this.drafts?.remove(this.noteId, this.clientSessionId) !== false;
    } catch (error) {
      this._reportError(error);
      ok = false;
    }
    if (ok) {
      this._savedLocally = false;
      this._draftError = null;
    } else {
      this._draftError = "unavailable";
    }
    this._emitStatus();
  }

  _removeCleanDraft() {
    if (this.drafts && !this._dirty && !this._inFlight) this._removeDraft();
  }

  // --- Save internals -------------------------------------------------------------------

  _startSave() {
    const sequence = this._nextSequence();
    const snapshot = {
      body: this._body,
      baseRevision: this._confirmedRevision,
      sequence,
      bodyHash: noteBodyHash(this._body),
      requestId: `${this.clientSessionId}:${sequence}`
    };
    const entry = { snapshot, promise: null };
    this._inFlight = entry;
    this._saveQueued = false;
    this._dirtySince = null;
    this._cancelAutosave();
    this._cancelPreview();
    this._setState("saving", null);

    // Persist the pending identity before the network call so a crash/timeout is recoverable.
    this._writeDraftNow(snapshot);

    const run = (async () => {
      let result;
      try {
        const reply = await this.transport.save({
          noteId: this.noteId,
          lease: this._lease,
          sequence: snapshot.sequence,
          baseRevision: snapshot.baseRevision,
          body: snapshot.body,
          geometry: this._geometry ?? null,
          eventIds: [...this._eventIds]
        });
        result = await this._handleSaveReply(reply, snapshot);
      } catch (error) {
        result = this._handleSaveError(error);
      }
      if (this._inFlight === entry) this._inFlight = null;
      return this._afterSave(result);
    })();
    entry.promise = run;
    return run;
  }

  async _afterSave(result) {
    const queued = this._saveQueued;
    this._saveQueued = false;

    if (this._state === "saving") this._setState("editing", null);

    if (queued) {
      if (!this._dirty) {
        this._removeCleanDraft();
        return { type: "noop" };
      }
      if (this._canSaveNow()) return this._startSave();
      return this._failure(this._state);
    }

    if (this._dirty && this._canAutosaveNow() && this._autosaveTimer == null) {
      this._ensureAutosaveScheduled();
    }
    this._emitStatus();
    return result;
  }

  async _handleSaveReply(reply, snapshot) {
    if (TERMINAL_STATES.has(this._state)) {
      return { type: "error", reason: this._state };
    }
    if (reply?.type === "noteSaveAck") return this._handleSaveAck(reply, snapshot);
    if (reply?.type === "noteSaveRejected") return this._handleSaveRejected(reply, snapshot);
    if (reply?.type === "timeout" || !reply) return this._reconcileTimeout(snapshot);
    if (reply?.type === "noteEditRevoked" || reply?.type === "noteEditForced") {
      this.applyLeaseLost(reply.reason === "forced" ? "forced" : "leaseLost");
      return { type: "noteSaveRejected", reason: "leaseLost" };
    }
    if (reply?.type === "noteEditDenied") {
      const reason = reply.reason ?? "denied";
      if (reason === "noActiveGM") {
        this._setState("offline", reason);
        this._writeDraftNow();
        return { type: "error", reason };
      }
      this._setState("rejected", reason);
      this._writeDraftNow();
      return { type: "noteSaveRejected", reason };
    }
    this._setState("offline", "unexpectedReply");
    this._writeDraftNow();
    return { type: "error", reason: "unexpectedReply" };
  }

  _handleSaveAck(reply, snapshot) {
    const ackHash = typeof reply.bodyHash === "string" ? reply.bodyHash : null;
    const currentHash = noteBodyHash(this._body);
    const sequenceMatches = reply.sequence === undefined || reply.sequence === snapshot.sequence;
    const matchesSnapshot = sequenceMatches
      && (ackHash === null || ackHash === snapshot.bodyHash);
    const matchesCurrent = ackHash !== null && ackHash === currentHash;

    if (!matchesSnapshot && !matchesCurrent) {
      // An acknowledgement for older text must never clear newer typing or its draft.
      if (this._dirty && this._canAutosaveNow()) this._ensureAutosaveScheduled();
      this._emitStatus();
      return { type: "noteSaveAck", accepted: false, revision: reply.revision ?? this._confirmedRevision };
    }

    const ackedRevision = isRevision(reply.revision) ? reply.revision : this._confirmedRevision;
    this._confirmedRevision = Math.max(this._confirmedRevision, ackedRevision);
    const confirmedBody = matchesCurrent ? this._body : snapshot.body;
    this._confirmedBody = confirmedBody;
    this._remoteRevision = null;
    this._remoteBody = null;

    if (this._body === confirmedBody) {
      this._dirty = false;
      this._dirtySince = null;
      this._cancelAutosave();
      this._removeDraft();
      this._setState("editing", null);
      try {
        this._onSaved?.(reply);
      } catch (error) {
        this._reportError(error);
      }
      return {
        type: "noteSaveAck",
        accepted: true,
        revision: this._confirmedRevision,
        sequence: reply.sequence ?? snapshot.sequence
      };
    }

    // The server accepted older text; newer typing remains dirty and keeps its draft.
    this._dirty = true;
    if (this._dirtySince == null) this._dirtySince = this._now();
    this._writeDraftNow(null);
    this._setState("editing", null);
    if (this._canAutosaveNow()) this._ensureAutosaveScheduled();
    return {
      type: "noteSaveAck",
      accepted: true,
      stale: true,
      revision: this._confirmedRevision,
      sequence: reply.sequence ?? snapshot.sequence
    };
  }

  _handleSaveRejected(reply) {
    const reason = reply.reason ?? "rejected";
    this._saveQueued = false;
    this._cancelAutosave();
    this._cancelPreview();

    if (isRevision(reply.revision)) this._confirmedRevision = reply.revision;

    if (reason === "staleRevision") {
      this._setState("conflict", reason);
      this._writeDraftNow(null);
      return { type: "noteSaveRejected", reason, revision: this._confirmedRevision };
    }
    if (reason === "leaseLost") {
      this.applyLeaseLost("leaseLost");
      return { type: "noteSaveRejected", reason };
    }
    if (reason === "tooLarge" || reason === "invalid") {
      this._setState("rejected", reason);
      this._writeDraftNow(null);
      return { type: "noteSaveRejected", reason, revision: this._confirmedRevision };
    }
    if (reason === "noActiveGM") {
      this._setState("offline", reason);
      this._writeDraftNow(null);
      return { type: "noteSaveRejected", reason };
    }
    this._setState("rejected", reason);
    this._writeDraftNow(null);
    return { type: "noteSaveRejected", reason, revision: this._confirmedRevision };
  }

  _handleSaveError(error) {
    if (TERMINAL_STATES.has(this._state)) {
      return { type: "error", reason: this._state };
    }
    this._reportError(error);
    this._saveQueued = false;
    this._cancelAutosave();
    this._cancelPreview();
    if (this._state !== "conflict" && this._state !== "rejected") {
      this._setState("offline", errorReason(error));
    }
    this._writeDraftNow(null);
    return { type: "error", reason: errorReason(error) };
  }

  /**
   * A timeout is uncertain. Reconcile against authoritative state; never claim saved
   * without matching the sent body.
   */
  async _reconcileTimeout(snapshot) {
    if (TERMINAL_STATES.has(this._state)) {
      return { type: "error", reason: this._state };
    }
    let reply;
    try {
      reply = await this.transport.state({ noteId: this.noteId });
    } catch (error) {
      this._reportError(error);
      reply = null;
    }

    const note = this._stateNote(reply);
    if (!note) {
      this._setState("offline", "timeout");
      this._writeDraftNow(null);
      return { type: "timeout", reason: "timeout" };
    }

    const revision = isRevision(note.revision) ? note.revision : null;
    const remoteBody = typeof note.body === "string" ? note.body : null;

    if (remoteBody !== null && remoteBody === snapshot.body) {
      this._confirmedBody = remoteBody;
      if (revision !== null) this._confirmedRevision = Math.max(this._confirmedRevision, revision);
      this._remoteRevision = null;
      this._remoteBody = null;
      if (this._body === remoteBody) {
        this._dirty = false;
        this._dirtySince = null;
        this._cancelAutosave();
        this._removeDraft();
        this._setState("editing", null);
        return { type: "noteSaveAck", accepted: true, reconciled: true, revision: this._confirmedRevision };
      }
      this._dirty = true;
      this._writeDraftNow(null);
      this._setState("editing", null);
      if (this._canAutosaveNow()) this._ensureAutosaveScheduled();
      return { type: "noteSaveAck", accepted: true, stale: true, reconciled: true, revision: this._confirmedRevision };
    }

    if (revision !== null && revision > snapshot.baseRevision) {
      // The revision advanced but the body is different (or unavailable): do not overwrite.
      if (remoteBody !== null) this._confirmedBody = remoteBody;
      this._confirmedRevision = revision;
      this._setState("conflict", "staleRevision");
      this._writeDraftNow(null);
      return { type: "noteSaveRejected", reason: "staleRevision", revision };
    }

    this._setState("offline", "timeout");
    this._writeDraftNow(null);
    return { type: "timeout", reason: "timeout" };
  }

  _stateNote(reply) {
    if (!isObject(reply) || reply.type === "timeout") return null;
    if (Array.isArray(reply.notes)) {
      const note = reply.notes.find(entry => entry?.noteId === this.noteId);
      return isObject(note) ? note : null;
    }
    if (isObject(reply.note)) return reply.note;
    if (isObject(reply.noteState)) return reply.noteState;
    if (typeof reply.body === "string" || isRevision(reply.revision)) return reply;
    return null;
  }

  // --- Preview --------------------------------------------------------------------------

  _schedulePreview() {
    if (!this._previewAllowed() || this._previewTimer != null) return;
    const now = this._now();
    const due = Number.isFinite(this._previewAt)
      ? this._previewAt + PREVIEW_MS
      : now + PREVIEW_MS;
    this._previewTimer = this._setTimeout(() => {
      this._previewTimer = null;
      this._sendPreview();
    }, Math.max(0, due - now));
    this._previewTimer?.unref?.();
  }

  _sendPreview() {
    if (!this._previewAllowed()) return;
    this._previewAt = this._now();
    try {
      this.transport.preview({
        noteId: this.noteId,
        lease: this._lease,
        sequence: this._nextSequence(),
        body: this._body
      });
    } catch (error) {
      this._reportError(error);
      this._leaseUncertain = true;
      this._cancelPreview();
      this._cancelAutosave();
      if (this._state === "editing" || this._state === "saving") {
        this._setState("offline", errorReason(error));
      }
    }
  }

  _cancelPreview() {
    if (this._previewTimer == null) return;
    this._clearTimeout(this._previewTimer);
    this._previewTimer = null;
  }

  _previewAllowed() {
    return !!this._lease
      && !this._composing
      && !this._leaseUncertain
      && SEND_STATES.has(this._state);
  }

  // --- Autosave -------------------------------------------------------------------------

  _ensureAutosaveScheduled() {
    if (!this._dirty || this._composing || !this._canAutosaveNow()) return;
    if (this._dirtySince == null) this._dirtySince = this._now();
    if (this._autosaveTimer != null) {
      this._clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
    }
    const now = this._now();
    const due = Math.min(now + AUTOSAVE_MS, this._dirtySince + AUTOSAVE_MAX_MS);
    this._autosaveTimer = this._setTimeout(() => {
      this._autosaveTimer = null;
      this._autosaveFired();
    }, Math.max(0, due - now));
    this._autosaveTimer?.unref?.();
  }

  _autosaveFired() {
    if (!this._dirty || !this._canAutosaveNow()) return;
    if (this._inFlight) {
      this._saveQueued = true;
      return;
    }
    void this.flush({ reason: "autosave" });
  }

  _cancelAutosave() {
    if (this._autosaveTimer == null) return;
    this._clearTimeout(this._autosaveTimer);
    this._autosaveTimer = null;
  }

  _canAutosaveNow() {
    return !!this._lease
      && !this._leaseUncertain
      && SEND_STATES.has(this._state);
  }

  _canSaveNow() {
    return !!this._lease
      && (SEND_STATES.has(this._state) || this._state === "offline");
  }

  // --- Heartbeat ------------------------------------------------------------------------

  _startHeartbeat() {
    this._stopHeartbeat();
    if (!this._lease || !this._heartbeatAllowed()) return;
    this._heartbeatTimer = this._setTimeout(() => {
      this._heartbeatTimer = null;
      void this._heartbeatTick();
    }, HEARTBEAT_MS);
    this._heartbeatTimer?.unref?.();
  }

  _scheduleHeartbeat() {
    if (!this._lease || !this._heartbeatAllowed()) return;
    this._startHeartbeat();
  }

  _heartbeatAllowed() {
    return !["leaseLost", "forced", "closed", "disposed", "denied"].includes(this._state);
  }

  async _heartbeatTick() {
    if (!this._lease || !this._heartbeatAllowed()) return;
    let reply;
    try {
      reply = await this.transport.heartbeat({ noteId: this.noteId, lease: this._lease });
    } catch (error) {
      this._reportError(error);
      this._leaseUncertain = true;
      this._cancelPreview();
      this._cancelAutosave();
      if (this._state === "editing" || this._state === "saving") {
        this._setState("offline", errorReason(error));
      }
      this._scheduleHeartbeat();
      return;
    }

    if (reply?.type === "noteEditHeartbeatAck") {
      if ((reply.leaseToken && reply.leaseToken !== this._lease.leaseToken)
          || (reply.gmEpoch && reply.gmEpoch !== this._lease.gmEpoch)) {
        this.applyLeaseLost("leaseLost");
        return;
      }
      this._leaseUncertain = false;
      if (this._state === "offline") this._setState("editing", null);
      this._scheduleHeartbeat();
      if (this._dirty && this._canAutosaveNow()) this._ensureAutosaveScheduled();
      return;
    }

    if (reply?.type === "noteEditRevoked") {
      this.applyLeaseLost(reply.reason === "forced" ? "forced" : (reply.reason ?? "leaseLost"));
      return;
    }

    // A missed heartbeat is uncertainty, not proof of loss. Stop sending until the caller
    // revalidates, but keep retrying the heartbeat so an active tab can recover.
    this._leaseUncertain = true;
    this._cancelPreview();
    this._cancelAutosave();
    if (this._state === "editing" || this._state === "saving") {
      this._setState("offline", "timeout");
    }
    this._scheduleHeartbeat();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer == null) return;
    this._clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  _restartHeartbeatIfPossible() {
    if (this._lease && this._heartbeatAllowed() && this._heartbeatTimer == null) {
      this._startHeartbeat();
    }
  }

  // --- Appearance -----------------------------------------------------------------------

  async _setAppearance({ layout, skin }) {
    if (!this._lease || !this._appearanceAllowed()) {
      return { ok: false, reason: this._state === "idle" ? "notOpen" : "unavailable" };
    }
    const nextLayout = layout === undefined ? this._layout : layout;
    const nextSkin = skin === undefined ? this._skin : skin;
    const token = ++this._appearanceToken;
    let reply;
    try {
      reply = await this.transport.appearance({
        noteId: this.noteId,
        lease: this._lease,
        layout: nextLayout,
        skin: nextSkin
      });
    } catch (error) {
      this._reportError(error);
      return { ok: false, reason: errorReason(error) };
    }
    if (token !== this._appearanceToken) return { ok: false, reason: "superseded" };
    if (TERMINAL_STATES.has(this._state)) {
      return { ok: false, reason: "leaseLost" };
    }

    if (reply?.type === "noteAppearanceAck") {
      if (layout !== undefined) this._layout = reply.layout ?? nextLayout;
      if (skin !== undefined) this._skin = reply.skin ?? nextSkin;
      this._emitStatus();
      return { ok: true, type: reply.type, layout: this._layout, skin: this._skin, reply };
    }
    if (reply?.type === "noteAppearanceRejected" || reply?.type === "noteEditDenied") {
      const reason = reply.reason ?? "rejected";
      if (reason === "leaseLost") this.applyLeaseLost("leaseLost");
      else if (reason === "noActiveGM") this._setState("offline", reason);
      else this._setState(this._state, reason);
      this._emitStatus();
      return { ok: false, type: reply.type, reason, reply };
    }
    return { ok: false, type: reply?.type ?? "timeout", reason: "timeout" };
  }

  _appearanceAllowed() {
    return !["leaseLost", "forced", "closed", "disposed", "denied"].includes(this._state);
  }

  // --- Shared helpers -------------------------------------------------------------------

  _nextSequence() {
    this._sequence += 1;
    return this._sequence;
  }

  _failure(reason) {
    return { type: "error", reason: reason ?? "unavailable" };
  }

  _setState(state, error) {
    const changed = this._state !== state || this._error !== (error ?? null);
    this._state = state;
    this._error = error ?? null;
    if (changed) this._emitStatus();
  }

  _emitStatus() {
    if (!this._onState) return;
    try {
      this._onState(this.status());
    } catch (error) {
      this._reportError(error);
    }
  }

  _reportError(error) {
    try {
      this._onError?.(error);
    } catch {
      // Error callbacks are untrusted UI code; never recursion or throw from them.
    }
  }
}

export { MAX_BODY_LENGTH };
