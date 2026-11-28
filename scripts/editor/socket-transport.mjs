/**
 * Socket adapter for the headless {@link NoteEditorSession}.
 *
 * The T4a socket module exposes two seams: `requestEditReply()` for commands with a
 * targeted reply and `requestWrite()` for fire-and-forget traffic. This module is the
 * only place that knows the wire command names, so the editor session and UI stay
 * transport-agnostic and tests can inject a fake transport directly.
 *
 * State replies deliberately omit the note body (it can be a 200,000 character
 * document). The adapter reads the confirmed body from `notesStore` so recovery and
 * timeout reconciliation still compare real text. No Foundry globals are read here;
 * `notesStore` and both request functions are injected.
 */

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Extracts one note's state entry from any accepted `noteEditState` shape.
 * Returns `null` for a timeout or a reply without this note.
 *
 * @param {Object} reply
 * @param {string} noteId
 */
export function readStateEntry(reply, noteId) {
  if (!isObject(reply) || reply.type === "timeout") return null;
  if (Array.isArray(reply.notes)) {
    return reply.notes.find(entry => entry?.noteId === noteId) ?? null;
  }
  if (isObject(reply.note)) return reply.note;
  if (isObject(reply.noteState)) return reply.noteState;
  if (reply.noteId === noteId
      || typeof reply.body === "string"
      || Number.isInteger(reply.revision)) {
    return reply;
  }
  return null;
}

/**
 * @param {Object} options
 * @param {{getNote: (noteId: string) => Object|null}} options.notesStore
 * @param {string} options.clientSessionId Per-tab draft/lease identity.
 * @param {(message: Object, options?: Object) => Promise<Object>} options.requestEditReply
 * @param {(message: Object) => *} options.requestWrite
 * @param {() => number} [options.now]
 * @returns {Object} NoteEditTransport
 */
export function createSocketTransport({
  notesStore,
  clientSessionId,
  requestEditReply,
  requestWrite,
  now = () => Date.now()
} = {}) {
  if (!notesStore || typeof notesStore.getNote !== "function") {
    throw new TypeError("createSocketTransport requires notesStore");
  }
  if (typeof requestEditReply !== "function") {
    throw new TypeError("createSocketTransport requires requestEditReply");
  }
  if (typeof requestWrite !== "function") {
    throw new TypeError("createSocketTransport requires requestWrite");
  }

  const sessionId = String(clientSessionId ?? "default");

  const state = async ({ noteId } = {}) => {
    const reply = await requestEditReply({
      type: "requestNoteEditState",
      noteId
    });
    const entry = readStateEntry(reply, noteId);
    let page = null;
    try {
      page = notesStore.getNote(noteId);
    } catch {
      page = null;
    }
    const system = page?.system ?? page ?? null;
    const body = typeof system?.body === "string" ? system.body : null;
    const revision = Number.isInteger(entry?.revision)
      ? entry.revision
      : (Number.isInteger(system?.revision) ? system.revision : 0);
    return {
      note: {
        noteId,
        revision,
        // State replies omit the body; keep `null` when the note is gone rather than
        // pretending an empty document is confirmed text.
        body,
        deleted: entry?.deleted === true || !page
      }
    };
  };

  return {
    begin({ noteId }) {
      return requestEditReply({
        type: "beginNoteEdit",
        noteId,
        clientSessionId: sessionId
      });
    },

    heartbeat({ noteId, lease }) {
      return requestEditReply({
        type: "noteEditHeartbeat",
        noteId,
        lease
      });
    },

    preview({ noteId, lease, sequence, body }) {
      // Ephemeral and intentionally not awaited. A failed preview must never break typing;
      // the lease heartbeat remains the authority for liveness.
      try {
        Promise.resolve(requestWrite({
          type: "previewNoteBody",
          noteId,
          lease,
          sequence,
          body
        })).catch(() => {});
      } catch {
        // The session treats an unavailable preview as uncertainty on the next save.
      }
    },

    save({ noteId, lease, sequence, baseRevision, body, geometry, eventIds }) {
      return requestEditReply({
        type: "saveNoteBody",
        noteId,
        lease,
        sequence,
        baseRevision,
        body,
        geometry,
        eventIds
      });
    },

    appearance({ noteId, lease, layout, skin }) {
      return requestEditReply({
        type: "saveNoteAppearance",
        noteId,
        lease,
        layout,
        skin
      });
    },

    end({ noteId, lease, sequence, body, baseRevision, geometry, eventIds }) {
      const message = {
        type: "endNoteEdit",
        noteId,
        lease,
        sequence,
        baseRevision,
        geometry,
        eventIds
      };
      // `body: undefined` means "release without a new write"; JSON socket payloads
      // drop the key, matching the GM handler's `message.body !== undefined` check.
      if (body !== undefined) message.body = body;
      return requestEditReply(message);
    },

    state,
    now: () => now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: id => globalThis.clearTimeout(id)
  };
}
