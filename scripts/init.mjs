import NoteModel from "./data/note-model.mjs";
import LayoutModel from "./data/layout-model.mjs";
import StatsModel from "./data/stats-model.mjs";
import HistoryModel from "./data/history-model.mjs";
import PrivateWorkspaceModel from "./data/private-model.mjs";
import { registerContainerSettings, ensureContainers, registerSidebarHiding } from "./store/containers.mjs";
import { registerSocket } from "./socket.mjs";
import { startExpirySweep, startLockResync } from "./locks.mjs";
import JournalApp from "./app/journal-app.mjs";
import { registerGmTierSettings } from "./secrets/access.mjs";
import { vaultStore } from "./secrets/vault-store.mjs";
import { privateStore } from "./store/private-store.mjs";
import { migrateSharedWorld } from "./migrate.mjs";
import { t } from "./i18n.mjs";
import {
  BUILTIN_THEME_IDS, getTheme, isThemeId, listThemes, loadSavedThemes, registerTheme, savedThemes
} from "./styles/themes.mjs";

const MODULE_ID = "fvtt-journalinator";

Hooks.once("init", () => {
  Object.assign(CONFIG.JournalEntryPage.dataModels, {
    [`${MODULE_ID}.note`]: NoteModel,
    [`${MODULE_ID}.layout`]: LayoutModel,
    [`${MODULE_ID}.stats`]: StatsModel,
    [`${MODULE_ID}.history`]: HistoryModel,
    [`${MODULE_ID}.private`]: PrivateWorkspaceModel
  });
  registerContainerSettings();
  registerGmTierSettings();
  // World-scoped schema marker: 0 = legacy records may still exist, 1 = shared migration finished.
  game.settings.register(MODULE_ID, "schemaVersion", {
    scope: "world", config: false, type: Number, default: 0
  });
  game.settings.register(MODULE_ID, "boardTheme", {
    scope: "client", config: false, type: String, default: "classic"
  });
  game.settings.register(MODULE_ID, "customThemes", {
    scope: "client", config: false, type: Object, default: {}
  });
  loadSavedThemes(game.settings.get(MODULE_ID, "customThemes"));
  exposeThemeApi();
  registerSidebarHiding();
});

/**
 * Public theme API. A companion module (or a macro) can register a theme and have it appear
 * in every open picker:
 *
 *   game.journalinator.themes.register("moody", { board: { ... }, styles: { sticky: { ... } } });
 *
 * Registrations persist in the client setting by default; pass `{ persist: false }` for a
 * session-only theme. `journalinatorThemeRegistered` fires on registration and
 * `journalinatorThemeChanged` fires when a theme is applied.
 */
function exposeThemeApi() {
  game.journalinator = {
    themes: {
      register(id, theme, options = {}) {
        if (!isThemeId(id)) throw new Error(`Journalinator: invalid theme id "${id}"`);
        if (BUILTIN_THEME_IDS.includes(id)) throw new Error(`Journalinator: "${id}" is a built-in theme id`);
        const registered = registerTheme(id, theme, { persist: options.persist ?? true });
        if (options.persist ?? true) {
          game.settings.set(MODULE_ID, "customThemes", savedThemes())
            .catch(err => console.error("Journalinator: could not save theme", err));
        }
        Hooks.callAll("journalinatorThemeRegistered", registered.id, registered);
        return registered;
      },
      list: () => listThemes(),
      get: id => getTheme(id)
    }
  };
}

Hooks.once("ready", async () => {
  await ensureContainers();
  if (game.user.isGM) {
    if ((game.settings.get(MODULE_ID, "schemaVersion") ?? 0) < 1) {
      try {
        const result = await migrateSharedWorld();
        if (result.failed === 0) await game.settings.set(MODULE_ID, "schemaVersion", 1);
      } catch (err) {
        console.error("Journalinator: shared-world migration failed", err);
      }
    }
    await privateStore.orphanMissingUsers();
  }
  registerSocket();
  startExpirySweep();
  startLockResync();
  await vaultStore.init();
  Hooks.callAll("journalinatorRegisterThemes", game.journalinator?.themes);
  Hooks.on("deleteUser", user => {
    if (!game.user.isGM) return;
    privateStore.orphanUser(user.id).catch(err => console.error("Journalinator: private workspace orphan failed", err));
  });
});

Hooks.on("getSceneControlButtons", controls => {
  controls.journalinator = {
    name: "journalinator",
    title: t("JN.Title"),
    icon: "fa-solid fa-note-sticky",
    order: Object.keys(controls).length,
    visible: true,
    activeTool: "open",
    tools: {
      open: {
        name: "open",
        order: 0,
        title: t("JN.Scene.Open"),
        icon: "fa-solid fa-note-sticky",
        button: true,
        onChange: () => {
          // Reuse the open instance instead of stacking a second app with the same id.
          const existing = foundry.applications.instances.get(JournalApp.DEFAULT_OPTIONS.id);
          if (existing) existing.render({ force: true });
          else new JournalApp().render({ force: true });
        }
      }
    }
  };
});
