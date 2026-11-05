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
  const keyFor = value => (value ?? "").trim().toLowerCase();

  for (const link of existingLinks) {
    if (link.origin !== "typed") { nextLinks.push(link); continue; }
    const targetNote = findNoteByTitle.byId(link.targetId);
    const currentKey = targetNote ? keyFor(targetNote.name) : null;
    let referenceKey = currentKey && referenced.has(currentKey) ? currentKey : null;

    // If the target was renamed, the block still contains the old [[title]]. Keep the link
    // pointing at the renamed note instead of treating the old title as a brand-new note —
    // unless another live note has since taken that title, in which case that note wins.
    if (!referenceKey && targetNote) {
      referenceKey = [...referenced.keys()].find(key => {
        if (!(targetNote.system.formerNames ?? []).some(name => keyFor(name) === key)) return false;
        const currentOwner = findNoteByTitle.byTitle(key);
        return !currentOwner || currentOwner.id === targetNote.id;
      }) ?? null;
    }

    if (referenceKey) {
      const { label } = referenced.get(referenceKey);
      nextLinks.push(link.edited ? link : { ...link, label });
      handledTitles.add(referenceKey);
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
