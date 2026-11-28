import { t } from "../i18n.mjs";

const MODULE_ID = "fvtt-journalinator";
const SETTING_KEY = "containerIds";

const CONTAINERS = {
  shared: { nameKey: "JN.Container.Shared", ownership: "OBSERVER" },
  history: { nameKey: "JN.Container.History", ownership: "NONE" },
  private: { nameKey: "JN.Container.Private", ownership: "NONE" }
};

const PAGES = {
  layoutPage: { entry: "shared", name: "__layout__", type: `${MODULE_ID}.layout` },
  activityPage: { entry: "shared", name: "__activity__", type: `${MODULE_ID}.activity` },
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
 * Finds or creates the current JournalEntry containers and their hidden system
 * pages. Runs only on the GM client. This is also the repair path: a deleted
 * layout/activity/history page, or a deleted container still referenced by the
 * setting, is recreated and the setting updated.
 *
 * The current shape is `{ shared, history, private, layoutPage, activityPage,
 * historyPage }`. Unknown keys from an older world are preserved by the spread
 * below. In particular a legacy `secrets` container id is left in the setting and
 * its data is never touched; the old secret and stats pages and containers are
 * neither migrated nor deleted.
 *
 * Ownership NONE hides the history and private entries from the sidebar and
 * blocks their edit UI for players. It is a UI convenience, not a secrecy
 * boundary: Foundry sends every JournalEntry's full data to every connected
 * client regardless of ownership.
 */
export async function ensureContainers() {
  if (!game.user.isGM) return;

  const ids = getContainerIds() ?? {};
  const shared = await ensureContainer("shared", ids.shared);
  const history = await ensureContainer("history", ids.history);
  const privateJournal = await ensureContainer("private", ids.private);
  const entries = { shared, history, private: privateJournal };

  const next = {
    ...ids,
    shared: shared.id,
    history: history.id,
    private: privateJournal.id
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
  // Write the current schema marker explicitly. Older pages are reused untouched,
  // so their raw source still lets the schema guard detect an incompatible world.
  const page = await JournalEntryPage.create({
    name, type, system: { schemaVersion: 2 }
  }, { parent: entry });
  return page.id;
}

export function getContainerIds() {
  return game.settings.get(MODULE_ID, SETTING_KEY);
}

/**
 * Prunes the module's current containers out of the Journal sidebar tree, plus a
 * legacy secrets container id if an older world still has one in the setting.
 * The legacy entry is only hidden here; it is never deleted or edited.
 */
export function registerSidebarHiding() {
  Hooks.on("renderJournalDirectory", (app, element) => {
    const el = element instanceof HTMLElement ? element : element[0];
    const ids = getContainerIds();
    if (!ids) return;
    const hidden = new Set([ids.shared, ids.history, ids.private, ids.secrets].filter(Boolean));
    for (const id of hidden) {
      el.querySelector(`li[data-entry-id="${id}"]`)?.remove();
    }
  });
}
