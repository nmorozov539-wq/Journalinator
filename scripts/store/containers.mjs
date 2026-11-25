import { t } from "../i18n.mjs";

const MODULE_ID = "fvtt-journalinator";
const SETTING_KEY = "containerIds";

const CONTAINERS = {
  shared: { nameKey: "JN.Container.Shared", ownership: "OBSERVER" },
  history: { nameKey: "JN.Container.History", ownership: "NONE" },
  secrets: { nameKey: "JN.Container.Secrets", ownership: "NONE" },
  private: { nameKey: "JN.Container.Private", ownership: "NONE" }
};

const PAGES = {
  layoutPage: { entry: "shared", name: "__layout__", type: `${MODULE_ID}.layout` },
  statsPage: { entry: "shared", name: "__stats__", type: `${MODULE_ID}.stats` },
  historyPage: { entry: "history", name: "__history__", type: `${MODULE_ID}.history` }
};

export function registerContainerSettings() {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    scope: "world",
    config: false,
    type: Object,
    default: null
  });
}

/**
 * Finds or creates the three JournalEntry containers and their system pages (spec §5.1). Runs
 * only on the GM client. This is also the repair path: a deleted layout/stats/history page, or a
 * deleted container that still has an id in the setting, is recreated and the setting updated.
 *
 * Ownership NONE on the GM Secrets entry hides it from the sidebar and blocks the edit UI for
 * players, but does NOT keep its content out of player browsers: Foundry v14 sends every
 * JournalEntry's full data to every connected client regardless of ownership (traced in
 * dist/packages/world.mjs — World.#p() calls db.JournalEntry.dump() with no permission filter).
 * Ownership here is a UI convenience, not a secrecy boundary. The GM tier (spec §14) keeps its
 * secrets on the GM Secrets entry as an encrypted vault (scripts/secrets/), so players only ever
 * receive ciphertext.
 */
export async function ensureContainers() {
  if (!game.user.isGM) return;

  const ids = getContainerIds() ?? {};
  const shared = await ensureContainer("shared", ids.shared);
  const history = await ensureContainer("history", ids.history);
  const secrets = await ensureContainer("secrets", ids.secrets);
  const privateJournal = await ensureContainer("private", ids.private);
  const entries = { shared, history, secrets, private: privateJournal };

  const next = {
    ...ids,
    shared: shared.id, history: history.id, secrets: secrets.id, private: privateJournal.id
  };
  for (const [key, page] of Object.entries(PAGES)) {
    next[key] = await ensurePage(entries[page.entry], ids[key], page.name, page.type);
  }

  if (Object.keys(next).some(key => ids[key] !== next[key])) {
    await game.settings.set(MODULE_ID, SETTING_KEY, next);
  }
  return next;
}

/** Reuses a container by id or by its module flag, then creates it if it was deleted. */
async function ensureContainer(kind, id) {
  const byId = id ? game.journal.get(id) : null;
  if (byId) return byId;
  const byFlag = [...(game.journal?.values?.() ?? [])]
    .find(entry => entry.flags?.[MODULE_ID]?.container === kind);
  if (byFlag) return byFlag;

  const { nameKey, ownership } = CONTAINERS[kind];
  return JournalEntry.create({
    name: t(nameKey),
    flags: { [MODULE_ID]: { container: kind } },
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS[ownership] }
  });
}

/** Reuses a page by id or name/type, then creates it if the old one was deleted. */
async function ensurePage(entry, id, name, type) {
  const byId = id ? entry.pages.get(id) : null;
  if (byId) return byId.id;
  const byName = [...entry.pages.values()].find(page => page.name === name && page.type === type);
  if (byName) return byName.id;
  const page = await JournalEntryPage.create({ name, type, system: {} }, { parent: entry });
  return page.id;
}

export function getContainerIds() {
  return game.settings.get(MODULE_ID, SETTING_KEY);
}

/** Prunes the module's own containers out of the Journal sidebar tree. */
export function registerSidebarHiding() {
  Hooks.on("renderJournalDirectory", (app, element) => {
    const el = element instanceof HTMLElement ? element : element[0];
    const ids = getContainerIds();
    if (!ids) return;
    const hidden = new Set([ids.shared, ids.history, ids.secrets, ids.private]);
    for (const id of hidden) {
      el.querySelector(`li[data-entry-id="${id}"]`)?.remove();
    }
  });
}
