import { getContainerIds } from "./store/containers.mjs";

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function statsPage() {
  const ids = getContainerIds();
  if (!ids) return null;
  const shared = game.journal.get(ids.shared);
  return shared?.pages.get(ids.statsPage) ?? null;
}

/** Adds today's delta ({chars, notes, links}, any subset) to one user's daily bucket (spec §5.5). */
export async function recordActivity(userId, delta) {
  const page = statsPage();
  if (!page) return;
  const date = today();
  const current = page.system.activity?.[date]?.[userId] ?? { chars: 0, notes: 0, links: 0 };
  await page.update({
    [`system.activity.${date}.${userId}`]: {
      chars: current.chars + (delta.chars ?? 0),
      notes: current.notes + (delta.notes ?? 0),
      links: current.links + (delta.links ?? 0)
    }
  });
}

export async function addSessionMarker(label) {
  const page = statsPage();
  if (!page) return;
  const sessions = [...(page.system.sessions ?? []), { date: today(), label }];
  await page.update({ "system.sessions": sessions });
}

/**
 * Pure aggregation over plain note data — no Foundry calls, so it's easy to reason about and
 * reuse from both the stats dialog and (if ever wanted) a test. `notes` should include trashed
 * notes too: these are historical totals ("notes created", "characters written"), not a live
 * canvas view, so a deleted note's past contribution still counts.
 */
export function computeJournalStats(notes) {
  const chars = {}, notesCreated = {}, linksDrawn = {};
  let mostLinked = null, mostLinkedCount = -1;
  let mostEdited = null, mostEditedCount = -1;
  const incomingLinks = new Map();

  for (const note of notes) {
    notesCreated[note.system.authorId] = (notesCreated[note.system.authorId] ?? 0) + 1;
    for (const [userId, amount] of Object.entries(note.system.contributions ?? {})) {
      chars[userId] = (chars[userId] ?? 0) + amount;
    }
    for (const link of note.system.links ?? []) {
      if (link.createdBy) linksDrawn[link.createdBy] = (linksDrawn[link.createdBy] ?? 0) + 1;
      incomingLinks.set(link.targetId, (incomingLinks.get(link.targetId) ?? 0) + 1);
    }
    if ((note.system.editCount ?? 0) > mostEditedCount) {
      mostEditedCount = note.system.editCount ?? 0;
      mostEdited = note;
    }
  }
  for (const note of notes) {
    const count = incomingLinks.get(note._id) ?? 0;
    if (count > mostLinkedCount) { mostLinkedCount = count; mostLinked = note; }
  }

  return {
    chars, notesCreated, linksDrawn,
    mostLinked: mostLinked ? { name: mostLinked.name, count: mostLinkedCount } : null,
    mostEdited: mostEdited ? { name: mostEdited.name, count: mostEditedCount } : null
  };
}

/** Groups daily activity buckets into sessions — by markers if any exist, else by date gaps (spec §5.5). */
export function deriveSessions(activity, sessions) {
  const dates = Object.keys(activity).sort();
  if (!dates.length) return [];

  if (sessions?.length) {
    return sessions.map(s => ({ label: s.label || s.date, totals: sumDates([s.date], activity) }));
  }

  const groups = [];
  let current = [dates[0]];
  for (let i = 1; i < dates.length; i++) {
    const gapDays = (new Date(dates[i]) - new Date(dates[i - 1])) / 86400000;
    if (gapDays > 1) { groups.push(current); current = []; }
    current.push(dates[i]);
  }
  groups.push(current);

  return groups.map(g => ({ label: g[0] === g[g.length - 1] ? g[0] : `${g[0]} – ${g[g.length - 1]}`, totals: sumDates(g, activity) }));
}

function sumDates(dates, activity) {
  const totals = {};
  for (const date of dates) {
    for (const [userId, bucket] of Object.entries(activity[date] ?? {})) {
      totals[userId] = (totals[userId] ?? 0) + bucket.chars;
    }
  }
  return totals;
}
