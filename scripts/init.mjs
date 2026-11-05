import NoteModel from "./data/note-model.mjs";
import LayoutModel from "./data/layout-model.mjs";
import StatsModel from "./data/stats-model.mjs";
import HistoryModel from "./data/history-model.mjs";
import { registerContainerSettings, ensureContainers, registerSidebarHiding } from "./store/containers.mjs";
import { registerSocket } from "./socket.mjs";
import { startExpirySweep, startLockResync } from "./locks.mjs";
import JournalApp from "./app/journal-app.mjs";

const MODULE_ID = "fvtt-journalinator";

Hooks.once("init", () => {
  Object.assign(CONFIG.JournalEntryPage.dataModels, {
    [`${MODULE_ID}.note`]: NoteModel,
    [`${MODULE_ID}.layout`]: LayoutModel,
    [`${MODULE_ID}.stats`]: StatsModel,
    [`${MODULE_ID}.history`]: HistoryModel
  });
  registerContainerSettings();
  registerSidebarHiding();
});

Hooks.once("ready", async () => {
  await ensureContainers();
  registerSocket();
  startExpirySweep();
  startLockResync();
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
        onChange: () => new JournalApp().render(true)
      }
    }
  };
});
