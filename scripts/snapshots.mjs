import { getContainerIds } from "./store/containers.mjs";

const SNAPSHOT_COOLDOWN_MS = 3 * 60 * 1000;
const RING_BUFFER_SIZE = 20;

/**
 * Saves a snapshot of `page`'s current blocks into the History entry (spec §5.6), at most once
 * every few minutes per note, as a ring buffer of ~20. Called from socket.mjs right after any
 * block mutation actually applies — a stand-in for "when a block lock releases and the note
 * changed" that doesn't require threading note content through the lock subsystem, which has
 * no concept of document content by design.
 */
export async function maybeSnapshot(page) {
  const ids = getContainerIds();
  if (!ids?.historyPage) return;
  const historyEntry = game.journal.get(ids.history);
  const historyPage = historyEntry?.pages.get(ids.historyPage);
  if (!historyPage) return;

  const existing = historyPage.system.snapshots?.[page.id] ?? [];
  const last = existing[existing.length - 1];
  if (last && Date.now() - last.at < SNAPSHOT_COOLDOWN_MS) return;
  if (last && JSON.stringify(last.blocks) === JSON.stringify(page.system.blocks)) return;

  const next = [...existing, { at: Date.now(), title: page.name, blocks: page.system.blocks }].slice(-RING_BUFFER_SIZE);
  await historyPage.update({ [`system.snapshots.${page.id}`]: next });
}
