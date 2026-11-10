/**
 * Plain-data helpers for the GM vault (spec §14). No Foundry globals: everything here takes and
 * returns JSON-shaped objects so it is unit-tested directly (tests/model.test.mjs).
 *
 * Vault shape (the decrypted plaintext):
 * {
 *   format: 1, rev: <int>,
 *   notes:        { [noteId]: SecretNote }             GM-only notes, card included
 *   hiddenBlocks: { [sharedNoteId]: { order: [blockId...], blocks: { [blockId]: Block } } }
 *   hiddenLinks:  { [sourceNoteId]: Link[] }           GM-only links whose source is a shared note
 *   labels:       { [labelId]: Label }                  GM-only canvas labels
 * }
 * SecretNote = { id, name, style, image, blocks: Block[], links: Link[], authorId,
 *                createdAt, updatedAt, card: { x, y, width, height, rotation } }
 */

export const VAULT_DATA_FORMAT = 1;

/** Secret note titles carry a `GM-XXXX ` prefix so they never collide with player titles. */
export const SECRET_PREFIX_RE = /^GM-[A-Z0-9]{4} /;
const PREFIX_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function emptyVault() {
  return { format: VAULT_DATA_FORMAT, rev: 0, notes: {}, hiddenBlocks: {}, hiddenLinks: {}, labels: {} };
}

export function normalizeVault(data) {
  const vault = data && typeof data === "object" ? data : {};
  return {
    format: VAULT_DATA_FORMAT,
    rev: Number.isFinite(vault.rev) ? vault.rev : 0,
    notes: vault.notes && typeof vault.notes === "object" ? vault.notes : {},
    hiddenBlocks: vault.hiddenBlocks && typeof vault.hiddenBlocks === "object" ? vault.hiddenBlocks : {},
    hiddenLinks: vault.hiddenLinks && typeof vault.hiddenLinks === "object" ? vault.hiddenLinks : {},
    labels: vault.labels && typeof vault.labels === "object" ? vault.labels : {}
  };
}

export function randomPrefixCode(random = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0]) {
  let code = "";
  for (let i = 0; i < 4; i++) code += PREFIX_ALPHABET[random() % PREFIX_ALPHABET.length];
  return code;
}

export function hasSecretPrefix(title) {
  return SECRET_PREFIX_RE.test(title ?? "");
}

export function stripSecretPrefix(title) {
  return (title ?? "").replace(SECRET_PREFIX_RE, "");
}

/** `Lord Vex` -> `GM-7KQ2 Lord Vex`. Keeps an existing prefix (used by rename). */
export function makeSecretTitle(base, existingTitle = null, code = randomPrefixCode()) {
  const clean = stripSecretPrefix((base ?? "").trim()) || "Untitled";
  const prefix = existingTitle && hasSecretPrefix(existingTitle)
    ? existingTitle.match(SECRET_PREFIX_RE)[0]
    : `GM-${code} `;
  return `${prefix}${clean}`;
}

/**
 * Interleaves GM-hidden blocks into a shared note's blocks.
 *
 * `entry.order` is the GM's last-known full order. Each hidden block is anchored to the next
 * shared block after it in that order that still exists ("insert before successor"); if none
 * survives it goes to the end. Anchoring to the successor keeps a hidden block in place when
 * players split or append to the block *before* it, which is the common case. Hidden blocks
 * missing from `order` are appended at the end.
 */
export function mergeBlocks(sharedBlocks, entry) {
  const shared = (sharedBlocks ?? []).map(b => ({ ...b, hidden: false }));
  const hidden = entry?.blocks ?? {};
  const hiddenIds = Object.keys(hidden);
  if (!hiddenIds.length) return shared;

  const sharedIds = new Set(shared.map(b => b.blockId));
  const before = new Map(); // sharedBlockId | null(end) -> hidden ids, in order
  const placed = new Set();
  const order = Array.isArray(entry.order) ? entry.order : [];

  let successor = null;
  const pendingReverse = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (sharedIds.has(id)) {
      successor = id;
    } else if (hidden[id] && !placed.has(id)) {
      placed.add(id);
      pendingReverse.push([successor, id]);
    }
  }
  for (const [anchor, id] of pendingReverse.reverse()) {
    if (!before.has(anchor)) before.set(anchor, []);
    before.get(anchor).push(id);
  }
  for (const id of hiddenIds) {
    if (placed.has(id)) continue;
    if (!before.has(null)) before.set(null, []);
    before.get(null).push(id);
  }

  const asHidden = id => ({ ...hidden[id], blockId: id, hidden: true });
  const merged = [];
  for (const block of shared) {
    for (const id of before.get(block.blockId) ?? []) merged.push(asHidden(id));
    merged.push(block);
  }
  for (const id of before.get(null) ?? []) merged.push(asHidden(id));
  return merged;
}

export function orderOf(mergedBlocks) {
  return mergedBlocks.map(b => b.blockId);
}

/** Where a declassified hidden block lands in the shared note: before this shared block id, or null for the end. */
export function declassifyAnchor(mergedBlocks, hiddenBlockId) {
  const index = mergedBlocks.findIndex(b => b.blockId === hiddenBlockId);
  if (index === -1) return null;
  for (let i = index + 1; i < mergedBlocks.length; i++) {
    if (!mergedBlocks[i].hidden) return mergedBlocks[i].blockId;
  }
  return null;
}

/**
 * Title resolution for `[[wikilinks]]` written in *secret* text. Secret notes win, by full title
 * and then by title without the GM prefix; then live shared notes. Shared text never uses this —
 * the shared write path only ever looks at shared notes, so a player cannot probe secret titles.
 */
export function resolveSecretTitle(title, { secretNotes, sharedNotes }) {
  const key = (title ?? "").trim().toLowerCase();
  if (!key) return null;
  const secrets = Object.values(secretNotes ?? {});
  return secrets.find(n => n.name.trim().toLowerCase() === key)
    ?? secrets.find(n => stripSecretPrefix(n.name).trim().toLowerCase() === key)
    ?? (sharedNotes ?? []).find(n => !n.deleted && n.name.trim().toLowerCase() === key)
    ?? null;
}

/**
 * Finishes interrupted declassifications and drops orphans. Declassify writes the shared copy
 * first (same id) and removes the secret copy second, so after a crash in between, the id is in
 * both places; the shared copy wins.
 *
 * `shared` is { notes: Map<id, { blockIds: Set<string>, deleted: boolean }> } describing every
 * shared note page that still exists (trash included). `null` means the shared container is
 * unavailable right now, so we cannot tell orphans from live content: prune nothing.
 */
export function reconcileVault(vault, shared) {
  if (!shared) return false;
  let changed = false;
  for (const id of Object.keys(vault.notes)) {
    if (shared.notes.has(id)) { delete vault.notes[id]; changed = true; }
  }
  for (const [noteId, entry] of Object.entries(vault.hiddenBlocks)) {
    const sharedNote = shared.notes.get(noteId);
    if (!sharedNote) { delete vault.hiddenBlocks[noteId]; changed = true; continue; }
    for (const blockId of Object.keys(entry.blocks ?? {})) {
      if (sharedNote.blockIds.has(blockId)) { delete entry.blocks[blockId]; changed = true; }
    }
    if (!Object.keys(entry.blocks ?? {}).length) { delete vault.hiddenBlocks[noteId]; changed = true; }
  }
  for (const noteId of Object.keys(vault.hiddenLinks)) {
    if (!shared.notes.has(noteId) || !vault.hiddenLinks[noteId]?.length) {
      delete vault.hiddenLinks[noteId];
      changed = true;
    }
  }
  return changed;
}

/** Spiral search for a free spot (same as the shared path's), over any card map. */
export function findFreeSpot(cards, w, h, nearX, nearY) {
  for (let r = 0; r < 40; r++) {
    for (let k = 0; k < 8; k++) {
      const x = nearX + Math.cos(k * 0.785) * r * 45;
      const y = nearY + Math.sin(k * 0.785) * r * 45;
      const overlaps = Object.values(cards).some(c => {
        const cw = c.width ?? 200, ch = c.height ?? 90;
        return !(x + w + 16 < c.x || x > c.x + cw + 16 || y + h + 16 < c.y || y > c.y + ch + 16);
      });
      if (!overlaps) return { x, y };
    }
  }
  return { x: nearX, y: nearY };
}
