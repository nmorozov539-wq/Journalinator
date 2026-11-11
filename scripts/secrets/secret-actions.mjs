import { vaultStore } from "./vault-store.mjs";
import { notesStore } from "../store/notes-store.mjs";
import { requestWrite } from "../socket.mjs";
import { reconcileTypedLinks, parseWikilinks } from "../wikilinks.mjs";
import { CARD_STYLES, seedTilt } from "../styles/registry.mjs";
import {
  makeSecretTitle, stripSecretPrefix, hasSecretPrefix, mergeBlocks, orderOf, declassifyAnchor,
  resolveSecretTitle, findFreeSpot
} from "./model.mjs";
import { t } from "../i18n.mjs";

/**
 * GM-tier write operations (spec §14). These run in the acting GM's own client and write the
 * encrypted vault directly. They never send hidden content over the module socket: the only
 * socket traffic here is a declassification (content that is becoming public at that moment)
 * or removing/linking shared content.
 *
 * Two-step operations are ordered so a failure never loses text:
 * - declassify: shared write first (same id), wait for it to land, then the vault forgets it.
 *   An interruption leaves the id in both places; reconcileVault drops the vault copy later.
 * - hide a shared block: vault copy first (new id), then remove the shared block. If the removal
 *   is rejected, the vault copy is rolled back.
 */

const MAX_TITLE_LENGTH = 200;
const CONFIRM_TIMEOUT_MS = 10000;

const now = () => Date.now();
const randomID = () => foundry.utils.randomID();
const warn = text => ui.notifications?.warn(`Journalinator: ${text}`);

function noteLike(note) {
  return note ? { id: note.id, name: note.name, system: { formerNames: note.formerNames ?? note.system?.formerNames ?? [] } } : null;
}

/** Resolves when `predicate()` is true after shared documents change, or false on timeout. */
export function waitForShared(predicate, timeoutMs = CONFIRM_TIMEOUT_MS) {
  if (predicate()) return Promise.resolve(true);
  return new Promise(resolve => {
    const hooks = ["createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"];
    const ids = [];
    let timer = null;
    const done = ok => {
      clearTimeout(timer);
      hooks.forEach((hook, i) => Hooks.off(hook, ids[i]));
      resolve(ok);
    };
    hooks.forEach(hook => ids.push(Hooks.on(hook, () => { if (predicate()) done(true); })));
    timer = setTimeout(() => done(predicate()), timeoutMs);
  });
}

async function sendAndConfirm(message, predicate) {
  if (!game.users.activeGM) {
    warn(t("JN.Secret.NoGM"));
    return false;
  }
  await requestWrite(message);
  return waitForShared(predicate);
}

function sharedBlocksOf(noteId) {
  return notesStore.getSharedPage(noteId)?.system.blocks ?? [];
}

function liveSharedNotes() {
  return notesStore.getSharedNotes().filter(p => !p.system.deleted);
}

function mergedCards(vault) {
  const cards = { ...(notesStore.getSharedLayout()?.cards ?? {}) };
  for (const note of Object.values(vault.notes)) if (note.card) cards[note.id] = note.card;
  return cards;
}

function hiddenEntry(vault, noteId) {
  vault.hiddenBlocks[noteId] ??= { order: orderOf(sharedBlocksOf(noteId)), blocks: {} };
  vault.hiddenBlocks[noteId].blocks ??= {};
  return vault.hiddenBlocks[noteId];
}

/** Secret-namespace finder for reconcileTypedLinks, creating secret notes for unknown titles. */
function secretFinder(vault, sourceCard) {
  const byTitle = title => {
    const hit = resolveSecretTitle(title, {
      secretNotes: vault.notes,
      sharedNotes: liveSharedNotes().map(p => ({ id: p.id, name: p.name, formerNames: p.system.formerNames }))
    });
    return noteLike(hit);
  };
  return {
    findNoteByTitle: {
      byId: id => noteLike(vault.notes[id] ?? (() => {
        const page = notesStore.getSharedPage(id);
        return page && !page.system.deleted ? { id: page.id, name: page.name, formerNames: page.system.formerNames } : null;
      })()),
      byTitle
    },
    createNoteNear: async title => {
      const id = createSecretNoteIn(vault, { title, x: (sourceCard?.x ?? 0) + 220, y: sourceCard?.y ?? 0 });
      return noteLike(vault.notes[id]);
    }
  };
}

function createSecretNoteIn(vault, { title, kind = "note", x = 0, y = 0, style = "sticky" }) {
  kind = kind === "location" ? "location" : "note";
  style = Object.hasOwn(CARD_STYLES, style) ? style : "sticky";
  const id = randomID();
  const width = CARD_STYLES[style]?.defaultWidth ?? 190;
  const spot = findFreeSpot(mergedCards(vault), width, 90, x, y);
  vault.notes[id] = {
    id,
    name: makeSecretTitle(title).slice(0, MAX_TITLE_LENGTH),
    kind,
    style,
    image: null,
    blocks: [{ blockId: randomID(), text: "", authorId: game.user.id }],
    links: [],
    authorId: game.user.id,
    createdAt: now(),
    updatedAt: now(),
    card: { x: spot.x, y: spot.y, width: null, height: null, rotation: seedTilt(style) }
  };
  return id;
}

/** Re-derives typed links for secret text: a secret note's own blocks, or a shared note's hidden blocks. */
async function reconcileSecretLinks(vault, noteId) {
  const secret = vault.notes[noteId];
  if (secret) {
    const finder = secretFinder(vault, secret.card);
    secret.links = await reconcileTypedLinks({ system: { links: secret.links ?? [] } }, secret.blocks, { ...finder, senderUserId: game.user.id });
    return;
  }
  const entry = vault.hiddenBlocks[noteId];
  const card = notesStore.getSharedLayout()?.cards?.[noteId];
  const finder = secretFinder(vault, card);
  const hiddenBlocks = Object.values(entry?.blocks ?? {});
  const beforeIds = new Set((vault.hiddenLinks[noteId] ?? []).map(l => l.id));
  const links = await reconcileTypedLinks({ system: { links: vault.hiddenLinks[noteId] ?? [] } }, hiddenBlocks, { ...finder, senderUserId: game.user.id });
  // Shared notes already carry their own drawn/typed links; don't duplicate a target there.
  // That rule only applies to links typed in this pass: any pre-existing hidden link (drawn or
  // typed) is GM-owned and must survive.
  const sharedTargets = new Set((notesStore.getSharedPage(noteId)?.system.links ?? []).map(l => l.targetId));
  const cleaned = links.filter(l => beforeIds.has(l.id) || (l.targetId !== noteId && !sharedTargets.has(l.targetId)));
  if (cleaned.length) vault.hiddenLinks[noteId] = cleaned;
  else delete vault.hiddenLinks[noteId];
}

// --- Mentions guard -------------------------------------------------------------------------

/** Secret notes named with their full `GM-XXXX` title in `text`. Those must never reach shared text. */
export function prefixedSecretMentions(text) {
  const vault = vaultStore.data;
  if (!vault) return [];
  const titles = new Set(Object.values(vault.notes).map(n => n.name.trim().toLowerCase()));
  return parseWikilinks(text ?? "").map(w => w.title).filter(t => hasSecretPrefix(t) && titles.has(t.toLowerCase()));
}

/** Secret notes referenced by their bare name; declassifying would create empty public notes of that name. */
export function bareSecretMentions(text) {
  const vault = vaultStore.data;
  if (!vault) return [];
  const sharedTitles = new Set(liveSharedNotes().map(p => p.name.trim().toLowerCase()));
  const bare = new Set(Object.values(vault.notes).map(n => stripSecretPrefix(n.name).trim().toLowerCase()));
  return parseWikilinks(text ?? "").map(w => w.title)
    .filter(t => !hasSecretPrefix(t) && bare.has(t.toLowerCase()) && !sharedTitles.has(t.toLowerCase()));
}

// --- Notes ----------------------------------------------------------------------------------

export function createSecretNote({ title, kind, x, y, style }) {
  return vaultStore.mutate(vault => createSecretNoteIn(vault, { title, kind, x, y, style }));
}

export function renameSecretNote(noteId, base) {
  const clean = (base ?? "").trim();
  if (!clean) return warn(t("JN.Secret.TitleEmpty"));
  return vaultStore.mutate(vault => {
    const note = vault.notes[noteId];
    if (!note) return;
    const title = makeSecretTitle(clean, note.name);
    if (title.length > MAX_TITLE_LENGTH) return warn(t("JN.Secret.TitleTooLong", { max: MAX_TITLE_LENGTH }));
    if (Object.values(vault.notes).some(n => n.id !== noteId && n.name.toLowerCase() === title.toLowerCase())) {
      return warn(t("JN.Secret.TitleExists", { title }));
    }
    note.formerNames = [...new Set([...(note.formerNames ?? []), note.name])].filter(n => n !== title).slice(-20);
    note.name = title;
    note.updatedAt = now();
  });
}

export function setSecretNoteStyle(noteId, style) {
  if (!Object.hasOwn(CARD_STYLES, style)) return;
  return vaultStore.mutate(vault => { if (vault.notes[noteId]) vault.notes[noteId].style = style; });
}

export function setSecretNoteKind(noteId, kind) {
  if (!new Set(["note", "location"]).has(kind)) return;
  return vaultStore.mutate(vault => {
    const note = vault.notes[noteId];
    if (!note) return;
    note.kind = kind;
    note.updatedAt = now();
  });
}

export function setSecretNoteImage(noteId, image) {
  const clean = typeof image === "string" ? image.trim().slice(0, 1000) || null : null;
  return vaultStore.mutate(vault => { if (vault.notes[noteId]) vault.notes[noteId].image = clean; });
}

export function moveSecretCard(noteId, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  return vaultStore.mutate(vault => {
    const note = vault.notes[noteId];
    if (note) note.card = { ...(note.card ?? {}), x, y };
  });
}

export function resizeSecretCard(noteId, width, height) {
  const size = v => (v === null || (Number.isFinite(v) && v > 0)) ? v : undefined;
  if (size(width) === undefined || size(height) === undefined) return;
  return vaultStore.mutate(vault => {
    const note = vault.notes[noteId];
    if (note) note.card = { ...(note.card ?? {}), width, height };
  });
}

/** Secret notes have no trash: deleting is permanent (the GM confirms first). */
export function deleteSecretNote(noteId) {
  return vaultStore.mutate(vault => {
    delete vault.notes[noteId];
    for (const note of Object.values(vault.notes)) {
      note.links = (note.links ?? []).filter(l => l.targetId !== noteId);
    }
    for (const [source, links] of Object.entries(vault.hiddenLinks)) {
      const kept = links.filter(l => l.targetId !== noteId);
      if (kept.length) vault.hiddenLinks[source] = kept;
      else delete vault.hiddenLinks[source];
    }
  });
}

// --- Blocks ---------------------------------------------------------------------------------

export function saveSecretBlock(noteId, blockId, text) {
  if (typeof text !== "string") return;
  return vaultStore.mutate(async vault => {
    const secret = vault.notes[noteId];
    if (secret) {
      const block = secret.blocks.find(b => b.blockId === blockId);
      if (!block) return;
      block.text = text;
      secret.updatedAt = now();
    } else {
      const block = vault.hiddenBlocks[noteId]?.blocks?.[blockId];
      if (!block) return;
      block.text = text;
    }
    await reconcileSecretLinks(vault, noteId);
  });
}

/** Adds an empty GM-only block. In a shared note it goes right after `afterBlockId` (or at the end). */
export function addHiddenBlock(noteId, afterBlockId = null, text = "") {
  return vaultStore.mutate(vault => {
    const blockId = randomID();
    const block = { blockId, text, authorId: game.user.id };
    const secret = vault.notes[noteId];
    if (secret) {
      const index = afterBlockId ? secret.blocks.findIndex(b => b.blockId === afterBlockId) : -1;
      secret.blocks.splice(index === -1 ? secret.blocks.length : index + 1, 0, block);
      return blockId;
    }
    if (!notesStore.getSharedPage(noteId)) return null;
    const entry = hiddenEntry(vault, noteId);
    const ordered = orderOf(mergeBlocks(sharedBlocksOf(noteId), entry));
    const index = afterBlockId ? ordered.indexOf(afterBlockId) : -1;
    ordered.splice(index === -1 ? ordered.length : index + 1, 0, blockId);
    entry.blocks[blockId] = block;
    entry.order = ordered;
    return blockId;
  });
}

export function splitSecretBlock(noteId, blockId, beforeText, afterText) {
  return vaultStore.mutate(async vault => {
    const secret = vault.notes[noteId];
    const newId = randomID();
    if (secret) {
      const index = secret.blocks.findIndex(b => b.blockId === blockId);
      if (index === -1) return null;
      secret.blocks.splice(index, 1,
        { ...secret.blocks[index], text: beforeText },
        { blockId: newId, text: afterText, authorId: game.user.id });
      secret.updatedAt = now();
    } else {
      const entry = vault.hiddenBlocks[noteId];
      if (!entry?.blocks?.[blockId]) return null;
      const ordered = orderOf(mergeBlocks(sharedBlocksOf(noteId), entry));
      entry.blocks[blockId].text = beforeText;
      entry.blocks[newId] = { blockId: newId, text: afterText, authorId: game.user.id };
      ordered.splice(ordered.indexOf(blockId) + 1, 0, newId);
      entry.order = ordered;
    }
    await reconcileSecretLinks(vault, noteId);
    return newId;
  });
}

/** Merges a secret block into the previous block, if that one is secret too. */
export function mergeSecretBlockUp(noteId, blockId) {
  return vaultStore.mutate(async vault => {
    const secret = vault.notes[noteId];
    if (secret) {
      const index = secret.blocks.findIndex(b => b.blockId === blockId);
      if (index <= 0) return null;
      const prev = secret.blocks[index - 1];
      prev.text += secret.blocks[index].text;
      secret.blocks.splice(index, 1);
      secret.updatedAt = now();
      await reconcileSecretLinks(vault, noteId);
      return prev.blockId;
    }
    const entry = vault.hiddenBlocks[noteId];
    if (!entry?.blocks?.[blockId]) return null;
    const merged = mergeBlocks(sharedBlocksOf(noteId), entry);
    const index = merged.findIndex(b => b.blockId === blockId);
    const prev = merged[index - 1];
    if (!prev?.hidden) return null;
    entry.blocks[prev.blockId].text += entry.blocks[blockId].text;
    delete entry.blocks[blockId];
    entry.order = orderOf(merged).filter(id => id !== blockId);
    await reconcileSecretLinks(vault, noteId);
    return prev.blockId;
  });
}

export function deleteSecretBlock(noteId, blockId) {
  return vaultStore.mutate(async vault => {
    const secret = vault.notes[noteId];
    if (secret) {
      if (secret.blocks.length <= 1) return warn(t("JN.Secret.NeedsBlock"));
      secret.blocks = secret.blocks.filter(b => b.blockId !== blockId);
    } else {
      const entry = vault.hiddenBlocks[noteId];
      if (!entry?.blocks?.[blockId]) return;
      delete entry.blocks[blockId];
      entry.order = (entry.order ?? []).filter(id => id !== blockId);
    }
    await reconcileSecretLinks(vault, noteId);
  });
}

/**
 * Moves a shared block into the vault. Players have already seen it (and History snapshots keep
 * old versions), so the UI warns first; this is for taking something off the board, not undoing
 * a leak.
 */
export async function hideSharedBlock(noteId, blockId) {
  const page = notesStore.getSharedPage(noteId);
  const block = page?.system.blocks.find(b => b.blockId === blockId);
  if (!block) return false;
  if (page.system.blocks.length <= 1) {
    warn(t("JN.Secret.NeedsVisibleBlock"));
    return false;
  }

  const hiddenId = await vaultStore.mutate(async vault => {
    const entry = hiddenEntry(vault, noteId);
    const id = randomID();
    const ordered = orderOf(mergeBlocks(sharedBlocksOf(noteId), entry));
    ordered.splice(ordered.indexOf(blockId) + 1, 0, id);
    entry.blocks[id] = { blockId: id, text: block.text, authorId: block.authorId || game.user.id };
    entry.order = ordered;
    await reconcileSecretLinks(vault, noteId);
    return id;
  });

  const removed = await sendAndConfirm(
    { type: "gmRemoveBlock", noteId, blockId },
    () => !sharedBlocksOf(noteId).some(b => b.blockId === blockId)
  );
  if (!removed) {
    await deleteSecretBlock(noteId, hiddenId);
    warn(t("JN.Secret.RemoveFailed"));
    return false;
  }
  return true;
}

/** Publishes a hidden block of a shared note in its current position. */
export async function declassifyBlock(noteId, blockId) {
  const vault = vaultStore.data;
  const entry = vault?.hiddenBlocks[noteId];
  const block = entry?.blocks?.[blockId];
  if (!block || !notesStore.getSharedPage(noteId)) return false;
  if (prefixedSecretMentions(block.text).length) {
    warn(t("JN.Secret.PrefixedLink"));
    return false;
  }
  const beforeBlockId = declassifyAnchor(mergeBlocks(sharedBlocksOf(noteId), entry), blockId);
  const ok = await sendAndConfirm(
    { type: "gmInsertBlock", noteId, block: { blockId, text: block.text }, beforeBlockId },
    () => sharedBlocksOf(noteId).some(b => b.blockId === blockId)
  );
  if (!ok) {
    warn(t("JN.Secret.DeclassifyTimeout"));
    return false;
  }
  await vaultStore.tidy();
  return true;
}

/** Publishes a whole secret note under `title` (no GM prefix), keeping its id, card, and links. */
export async function declassifyNote(noteId, title) {
  const note = vaultStore.data?.notes[noteId];
  if (!note) return false;
  title = (title ?? "").trim();
  if (!title || title.length > MAX_TITLE_LENGTH) { warn(t("JN.Secret.PickPublicTitle")); return false; }
  if (liveSharedNotes().some(p => p.name.trim().toLowerCase() === title.toLowerCase())) {
    warn(t("JN.Secret.SharedTitleExists", { title }));
    return false;
  }
  const allText = note.blocks.map(b => b.text).join("\n");
  if (prefixedSecretMentions(allText).length) {
    warn(t("JN.Secret.NotePrefixedLink"));
    return false;
  }

  const sharedIds = new Set(liveSharedNotes().map(p => p.id));
  const publicLinks = (note.links ?? [])
    .filter(l => l.origin !== "typed" && sharedIds.has(l.targetId))
    .map(({ targetId, label, direction, color, lineStyle }) => ({ targetId, label, direction, color, lineStyle }));

  const ok = await sendAndConfirm({
    type: "gmCreateNote",
    noteId,
    title,
    kind: note.kind,
    style: note.style,
    image: note.image,
    blocks: note.blocks.map(({ blockId, text }) => ({ blockId, text })),
    links: publicLinks,
    card: note.card
  }, () => !!notesStore.getSharedPage(noteId));
  if (!ok) {
    warn(t("JN.Secret.NoteTimeout"));
    return false;
  }

  // Links to notes that are still secret stay GM-only, now hanging off the shared note.
  await vaultStore.mutate(vault => {
    const stillSecret = (note.links ?? []).filter(l => l.origin !== "typed" && !sharedIds.has(l.targetId) && vault.notes[l.targetId]);
    if (stillSecret.length) vault.hiddenLinks[noteId] = [...(vault.hiddenLinks[noteId] ?? []), ...stillSecret];
    delete vault.notes[noteId];
  });
  return true;
}

// --- Links ----------------------------------------------------------------------------------

function newLink(targetId, extra = {}) {
  return {
    id: randomID(), targetId, label: "", direction: "one", color: "", lineStyle: "solid",
    origin: "drawn", edited: false, createdBy: game.user.id, hint: false, ...extra
  };
}

/** A GM-only link. Links touching a secret note are always GM-only. */
export function addHiddenLink(sourceId, targetId) {
  if (sourceId === targetId) return;
  return vaultStore.mutate(vault => {
    const secret = vault.notes[sourceId];
    const existing = secret ? secret.links : (vault.hiddenLinks[sourceId] ?? []);
    const sharedExisting = notesStore.getSharedPage(sourceId)?.system.links ?? [];
    if ([...existing, ...sharedExisting].some(l => l.targetId === targetId)) return;
    if (secret) secret.links = [...existing, newLink(targetId)];
    else if (notesStore.getSharedPage(sourceId)) vault.hiddenLinks[sourceId] = [...existing, newLink(targetId)];
  });
}

const LINK_FIELDS = ["label", "direction", "color", "lineStyle"];

export function updateHiddenLink(sourceId, linkId, fields) {
  return vaultStore.mutate(vault => {
    const list = vault.notes[sourceId]?.links ?? vault.hiddenLinks[sourceId];
    const link = list?.find(l => l.id === linkId);
    if (!link) return;
    for (const key of LINK_FIELDS) if (key in fields) link[key] = fields[key];
    link.edited = true;
  });
}

export function deleteHiddenLink(sourceId, linkId) {
  return vaultStore.mutate(vault => {
    if (vault.notes[sourceId]) {
      vault.notes[sourceId].links = vault.notes[sourceId].links.filter(l => l.id !== linkId);
      return;
    }
    const kept = (vault.hiddenLinks[sourceId] ?? []).filter(l => l.id !== linkId);
    if (kept.length) vault.hiddenLinks[sourceId] = kept;
    else delete vault.hiddenLinks[sourceId];
  });
}

/** Makes a GM-only link between two shared notes public. */
export async function revealLink(sourceId, linkId) {
  const link = vaultStore.data?.hiddenLinks[sourceId]?.find(l => l.id === linkId);
  const target = link && notesStore.getSharedPage(link.targetId);
  if (!link || !target || target.system.deleted) {
    warn(t("JN.Secret.OnlySharedLink"));
    return false;
  }
  const ok = await sendAndConfirm(
    { type: "gmAddLink", sourceId, link },
    () => (notesStore.getSharedPage(sourceId)?.system.links ?? []).some(l => l.targetId === link.targetId)
  );
  if (ok) await deleteHiddenLink(sourceId, linkId);
  return ok;
}

/** Takes a drawn shared link off the board and keeps it GM-only. */
export async function hideSharedLink(sourceId, linkId) {
  const link = notesStore.getSharedPage(sourceId)?.system.links.find(l => l.id === linkId);
  if (!link) return false;
  if (link.origin === "typed") {
    warn(t("JN.Secret.TypedLink"));
    return false;
  }
  await vaultStore.mutate(vault => {
    const list = vault.hiddenLinks[sourceId] ?? [];
    if (!list.some(l => l.targetId === link.targetId)) {
      vault.hiddenLinks[sourceId] = [...list, { ...newLink(link.targetId), label: link.label, direction: link.direction, color: link.color, lineStyle: link.lineStyle, edited: true }];
    }
  });
  await requestWrite({ type: "deleteLink", noteId: sourceId, linkId });
  return true;
}

// --- Labels ---------------------------------------------------------------------------------

export function addHiddenLabel(x, y, text = "GM label") {
  return vaultStore.mutate(vault => {
    vault.labels[randomID()] = { text, x, y, size: 14, color: "" };
  });
}

export function updateHiddenLabel(labelId, fields) {
  return vaultStore.mutate(vault => {
    const label = vault.labels[labelId];
    if (!label) return;
    if (typeof fields.text === "string") label.text = fields.text.slice(0, 500);
    if (Number.isFinite(fields.x)) label.x = fields.x;
    if (Number.isFinite(fields.y)) label.y = fields.y;
  });
}

export function removeHiddenLabel(labelId) {
  return vaultStore.mutate(vault => { delete vault.labels[labelId]; });
}

export async function revealLabel(labelId) {
  const label = vaultStore.data?.labels[labelId];
  if (!label) return;
  await requestWrite({ type: "addLabel", text: label.text, x: label.x, y: label.y, size: label.size, color: label.color });
  await removeHiddenLabel(labelId);
}
