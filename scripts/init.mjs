import NoteModel from "./data/note-model.mjs";
import LayoutModel from "./data/layout-model.mjs";
import StatsModel from "./data/stats-model.mjs";
import HistoryModel from "./data/history-model.mjs";
import { registerContainerSettings, ensureContainers, registerSidebarHiding } from "./store/containers.mjs";
import { registerSocket } from "./socket.mjs";
import { startExpirySweep, startLockResync } from "./locks.mjs";
import JournalApp from "./app/journal-app.mjs";
import { registerGmTierSettings } from "./secrets/access.mjs";
import { vaultStore } from "./secrets/vault-store.mjs";

const MODULE_ID = "fvtt-journalinator";

Hooks.once("init", () => {
  Object.assign(CONFIG.JournalEntryPage.dataModels, {
    [`${MODULE_ID}.note`]: NoteModel,
    [`${MODULE_ID}.layout`]: LayoutModel,
    [`${MODULE_ID}.stats`]: StatsModel,
    [`${MODULE_ID}.history`]: HistoryModel
  });
  registerContainerSettings();
  registerGmTierSettings();
  registerSidebarHiding();
});

Hooks.once("ready", async () => {
  await ensureContainers();
  registerSocket();
  startExpirySweep();
  startLockResync();
  await vaultStore.init();
});

Hooks.on("getSceneControlButtons", controls => {
  controls.journalinator = {
    name: "journalinator",
    title: "Journalinator",
    icon: "fa-solid fa-note-sticky",
    order: Object.keys(controls).length,
    visible: true,
    activeTool: "open",
    tools: {
      open: {
        name: "open",
        order: 0,
        title: "Open Journalinator",
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
