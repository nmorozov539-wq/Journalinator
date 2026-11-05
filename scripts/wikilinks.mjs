const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;

/** Parses `[[Target]]` / `[[Target|label]]` occurrences out of a block of text (spec §6.8). */
export function parseWikilinks(text) {
  const results = [];
  for (const match of text.matchAll(WIKILINK_RE)) {
    results.push({ title: match[1].trim(), label: match[2]?.trim() ?? "" });
  }
  return results;
}

/**
 * Reconciles a note's typed links against the `[[wikilinks]]` currently present in its blocks.
 * Runs on the GM client as part of saving a note (spec §6.8):
 * - Each still-referenced title gets (or keeps) a `origin: "typed"` link; the alias becomes the label.
 * - A title with no matching note gets a new note created beside `sourceNote`, then links to it.
 * - A typed, *unedited* link whose `[[...]]` text was removed gets removed; an edited one is kept.
 *
 * `findNoteByTitle` and `createNoteNear` are injected so this stays free of Foundry document calls,
 * easier to reason about and to unit-test later.
 */
export async function reconcileTypedLinks(sourceNote, blocks, { findNoteByTitle, createNoteNear, senderUserId }) {
  const referenced = new Map();
  for (const block of blocks) {
    for (const { title, label } of parseWikilinks(block.text)) {
      referenced.set(title.toLowerCase(), { title, label });
    }
  }

  const existingLinks = sourceNote.system.links ?? [];
  const nextLinks = [];
  const handledTitles = new Set();

  for (const link of existingLinks) {
    if (link.origin !== "typed") { nextLinks.push(link); continue; }
    const targetNote = findNoteByTitle.byId(link.targetId);
    const key = targetNote ? targetNote.name.toLowerCase() : null;
    const stillReferenced = key && referenced.has(key);
    if (stillReferenced) {
      const { label } = referenced.get(key);
      nextLinks.push(link.edited ? link : { ...link, label });
      handledTitles.add(key);
    } else if (link.edited) {
      nextLinks.push(link); // edited typed links survive even if the [[...]] text is gone
    }
    // else: drop it — unedited typed link whose wikilink text was deleted
  }

  for (const [key, { title, label }] of referenced) {
    if (handledTitles.has(key)) continue;
    let targetNote = findNoteByTitle.byTitle(title);
    if (!targetNote) {
      targetNote = await createNoteNear(title);
      ui.notifications?.info(`Journalinator: "${title}" didn't exist yet, so it was created on the canvas.`);
    }
    nextLinks.push({
      id: foundry.utils.randomID(),
      targetId: targetNote.id,
      label,
      direction: "one",
      color: "",
      lineStyle: "solid",
      origin: "typed",
      edited: false,
      createdBy: senderUserId
    });
  }

  return nextLinks;
}
