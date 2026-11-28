import NoteModel from "./data/note-model.mjs";
import LayoutModel from "./data/layout-model.mjs";
import ActivityModel from "./data/activity-model.mjs";
import HistoryModel from "./data/history-model.mjs";
import { registerContainerSettings, ensureContainers, registerSidebarHiding } from "./store/containers.mjs";
import { registerSocket } from "./socket.mjs";
import { registerHistoryHooks } from "./history.mjs";
import { registerActivityHooks } from "./activity.mjs";
import { startEditExpiry, startEditResync } from "./edit-session.mjs";
import JournalApp, { isRestoringSceneControl } from "./app/journal-app.mjs";
import { shouldOpenSceneControl } from "./app/scene-control.mjs";
import { privateStore } from "./store/private-store.mjs";
import { t } from "./i18n.mjs";
import {
  BUILTIN_THEME_IDS, getTheme, isThemeId, listThemes, loadSavedThemes, registerTheme, savedThemes
} from "./styles/themes.mjs";

const MODULE_ID = "fvtt-journalinator";

/**
 * The one Journalinator window this client opened. It is cleared by the app's close hook so a
 * closed instance is never rendered again (Foundry keeps no usable closed instance for us).
 */
let journalApp = null;

Hooks.on("journalinatorAppClosed", app => {
  if (journalApp === app) journalApp = null;
});

/** Existing rendered instance from our reference or Foundry's instance registry. */
function renderedJournalApp() {
  if (journalApp?.rendered) return journalApp;
  const existing = foundry.applications.instances.get(JournalApp.DEFAULT_OPTIONS.id) ?? null;
  if (existing?.rendered) {
    journalApp = existing;
    return existing;
  }
  return null;
}

function openJournalApp() {
  const existing = renderedJournalApp();
  if (existing) {
    existing.bringToFront?.();
    existing.render({ force: true });
    return existing;
  }
  journalApp = new JournalApp();
  journalApp.render({ force: true });
  return journalApp;
}

Hooks.once("init", () => {
  Object.assign(CONFIG.JournalEntryPage.dataModels, {
    [`${MODULE_ID}.note`]: NoteModel,
    [`${MODULE_ID}.layout`]: LayoutModel,
    [`${MODULE_ID}.activity`]: ActivityModel,
    [`${MODULE_ID}.history`]: HistoryModel
  });
  registerContainerSettings();
  game.settings.register(MODULE_ID, "boardTheme", {
    scope: "client", config: false, type: String, default: "stylized"
  });
  // Experimental pin system. World-scoped so every client agrees about whether shared anchors may
  // be created; turning it off never removes stored pins, anchors or links.
  game.settings.register(MODULE_ID, "pinsEnabled", {
    name: t("JN.Settings.PinsEnabled"),
    hint: t("JN.Settings.PinsEnabledHint"),
    scope: "world", config: true, type: Boolean, default: true
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
 * `journalinatorThemeChanged` fires when the applied theme actually changes (not on every render).
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
    await privateStore.orphanMissingUsers();
  }
  registerSocket();
  registerHistoryHooks();
  registerActivityHooks();
  startEditExpiry();
  startEditResync();
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
        onChange: (_event, active) => {
          // Closing the app activates tokens, which deactivates this control: ignore that
          // deactivating onChange and never reopen during the close-time control restore.
          if (isRestoringSceneControl()) return;
          if (!shouldOpenSceneControl(active)) return;
          openJournalApp();
        }
      }
    }
  };
});
