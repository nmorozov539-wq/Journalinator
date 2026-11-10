import { t } from "../i18n.mjs";

const MODULE_ID = "fvtt-journalinator";
const SETTING_KEY = "containerIds";

export function registerContainerSettings() {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    scope: "world",
    config: false,
    type: Object,
    default: null
  });
}

/**
 * Finds or creates the three JournalEntry containers (spec §5.1). Runs only on the GM client.
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

  let ids = game.settings.get(MODULE_ID, SETTING_KEY);
  if (ids && ids.shared && game.journal.get(ids.shared)) {
    return await ensureHistoryPage(ids); // upgrade path for worlds created before Phase 5
  }

  const shared = await JournalEntry.create({
    name: t("JN.Container.Shared"),
    flags: { [MODULE_ID]: { container: "shared" } },
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
  });

  const history = await JournalEntry.create({
    name: t("JN.Container.History"),
    flags: { [MODULE_ID]: { container: "history" } },
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE }
  });

  const secrets = await JournalEntry.create({
    name: t("JN.Container.Secrets"),
    flags: { [MODULE_ID]: { container: "secrets" } },
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE }
  });

  const layoutPage = await JournalEntryPage.create({
    name: "__layout__",
    type: `${MODULE_ID}.layout`,
    system: {}
  }, { parent: shared });

  const statsPage = await JournalEntryPage.create({
    name: "__stats__",
    type: `${MODULE_ID}.stats`,
    system: {}
  }, { parent: shared });

  const historyPage = await JournalEntryPage.create({
    name: "__history__",
    type: `${MODULE_ID}.history`,
    system: {}
  }, { parent: history });

  ids = {
    shared: shared.id,
    history: history.id,
    secrets: secrets.id,
    layoutPage: layoutPage.id,
    statsPage: statsPage.id,
    historyPage: historyPage.id
  };
  await game.settings.set(MODULE_ID, SETTING_KEY, ids);
  return ids;
}

/** Adds the history sub-type page for worlds whose containers were created before Phase 5. */
async function ensureHistoryPage(ids) {
  if (ids.historyPage && game.journal.get(ids.history)?.pages.get(ids.historyPage)) return ids;
  const history = game.journal.get(ids.history);
  const historyPage = await JournalEntryPage.create({
    name: "__history__",
    type: `${MODULE_ID}.history`,
    system: {}
  }, { parent: history });
  ids = { ...ids, historyPage: historyPage.id };
  await game.settings.set(MODULE_ID, SETTING_KEY, ids);
  return ids;
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
    const hidden = new Set([ids.shared, ids.history, ids.secrets]);
    for (const id of hidden) {
      el.querySelector(`li[data-entry-id="${id}"]`)?.remove();
    }
  });
}
