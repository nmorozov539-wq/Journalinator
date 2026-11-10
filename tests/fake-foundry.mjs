/**
 * Just enough of Foundry v14's client surface to run the module's data paths (shared write
 * handler, vault, read layer) in Node. Not a UI harness: the app/editor/canvas classes are not
 * loaded here. Documents apply dotted-path updates and fire the same hooks Foundry does.
 */

import { readFileSync } from "node:fs";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const EN = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
export function randomID(n = 16) {
  let id = "";
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(n));
  for (const b of bytes) id += ALNUM[b % ALNUM.length];
  return id;
}

const hooks = new Map();
let hookSeq = 0;
export const Hooks = {
  on(name, fn) { const id = ++hookSeq; if (!hooks.has(name)) hooks.set(name, new Map()); hooks.get(name).set(id, fn); return id; },
  once(name, fn) { const id = Hooks.on(name, (...a) => { Hooks.off(name, id); fn(...a); }); return id; },
  off(name, id) { hooks.get(name)?.delete(id); },
  callAll(name, ...args) { for (const fn of [...(hooks.get(name)?.values() ?? [])]) fn(...args); return true; },
  call(name, ...args) { return Hooks.callAll(name, ...args); },
  reset() { hooks.clear(); }
};

function applyUpdate(target, changes) {
  for (const [path, value] of Object.entries(changes)) {
    const parts = path.split(".");
    const last = parts.pop();
    let obj = target;
    for (const p of parts) { obj[p] ??= {}; obj = obj[p]; }
    if (last.startsWith("-=")) delete obj[last.slice(2)];
    else obj[last] = structuredClone(value);
  }
}

function expand(changes) {
  const out = {};
  applyUpdate(out, changes);
  return out;
}

function withToObject(system) {
  Object.defineProperty(system, "toObject", { value() { const copy = structuredClone({ ...this }); return copy; }, enumerable: false });
  return system;
}

const NOTE_DEFAULTS = () => ({
  style: "sticky", image: null, blocks: [], links: [], authorId: "", createdAt: 0, updatedAt: 0,
  editCount: 0, contributions: {}, formerNames: [], hint: false, deleted: null
});
const DEFAULTS = {
  "fvtt-journalinator.note": NOTE_DEFAULTS,
  "fvtt-journalinator.layout": () => ({ cards: {}, labels: {}, viewport: null }),
  "fvtt-journalinator.stats": () => ({ activity: {}, sessions: [] }),
  "fvtt-journalinator.history": () => ({ snapshots: {} })
};

export class FakePage {
  constructor(data, parent) {
    this.id = this._id = data._id ?? randomID();
    this.name = data.name;
    this.type = data.type;
    this.parent = parent;
    const system = { ...(DEFAULTS[data.type]?.() ?? {}), ...structuredClone(data.system ?? {}) };
    if (data.type === "fvtt-journalinator.note") {
      system.links = (system.links ?? []).map(l => ({ label: "", direction: "none", color: "", lineStyle: "solid", origin: "drawn", edited: false, createdBy: "", hint: false, ...l }));
    }
    this.system = withToObject(system);
  }
  async update(changes) {
    const data = { name: this.name, system: this.system };
    applyUpdate(data, changes);
    this.name = data.name;
    if (this.type === "fvtt-journalinator.note") {
      this.system.links = (this.system.links ?? []).map(l => ({ hint: false, ...l }));
    }
    Hooks.callAll("updateJournalEntryPage", this, expand(changes));
    return this;
  }
}

class PageCollection extends Map {
  filter(fn) { return [...this.values()].filter(fn); }
  find(fn) { return [...this.values()].find(fn); }
  map(fn) { return [...this.values()].map(fn); }
  [Symbol.iterator]() { return this.values(); }
}

export class FakeEntry {
  constructor(data) {
    this.id = this._id = data._id ?? randomID();
    this.name = data.name;
    this.flags = structuredClone(data.flags ?? {});
    this.ownership = data.ownership ?? {};
    this.pages = new PageCollection();
  }
  async update(changes) {
    const data = { flags: this.flags, name: this.name };
    applyUpdate(data, changes);
    this.flags = data.flags;
    Hooks.callAll("updateJournalEntry", this, expand(changes));
    return this;
  }
}

export const JournalEntryPage = {
  async create(data, { parent, keepId } = {}) {
    const page = new FakePage(keepId ? data : { ...data, _id: undefined }, parent);
    if (parent.pages.has(page.id)) throw new Error("duplicate id");
    parent.pages.set(page.id, page);
    Hooks.callAll("createJournalEntryPage", page);
    return page;
  },
  async deleteDocuments(ids, { parent }) {
    for (const id of ids) { const p = parent.pages.get(id); parent.pages.delete(id); Hooks.callAll("deleteJournalEntryPage", p); }
  }
};

export function makeUser(id, { isGM = false, role = isGM ? 4 : 1, name = id } = {}) {
  return { id, name, isGM, role, color: "#888888", active: true };
}

/**
 * Installs globals. `socketLog` records every module-socket emit as { message, options } so tests
 * can assert what would leave this client.
 */
export function installFoundry({ user, users, worldId = "test-world" }) {
  Hooks.reset();
  const journal = new Map();
  const settings = new Map();
  const notifications = [];
  const socketLog = [];
  const socketHandlers = [];
  const storage = new Map();
  const userMap = new Map(users.map(u => [u.id, u]));

  globalThis.Hooks = Hooks;
  globalThis.JournalEntryPage = JournalEntryPage;
  globalThis.CONST = { USER_ROLES: { PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 }, DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2, OWNER: 3 } };
  globalThis.foundry = {
    utils: {
      randomID,
      deepClone: v => structuredClone(v),
      escapeHTML: s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
    }
  };
  globalThis.ui = {
    notifications: {
      info: m => notifications.push(["info", m]),
      warn: m => notifications.push(["warn", m]),
      error: m => notifications.push(["error", m])
    }
  };
  globalThis.localStorage = {
    getItem: k => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
    key: i => [...storage.keys()][i] ?? null,
    get length() { return storage.size; }
  };
  globalThis.game = {
    user,
    world: { id: worldId },
    i18n: {
      lang: "en",
      localize: key => EN[key] ?? key,
      format: (text, data) => text.replace(/\{(\w+)\}/g, (whole, key) => (data[key] ?? whole)),
      has: key => Object.hasOwn(EN, key)
    },
    journal,
    users: {
      get: id => userMap.get(id),
      get activeGM() { return users.find(u => u.isGM && u.active) ?? null; },
      [Symbol.iterator]: () => userMap.values()
    },
    settings: {
      register() {},
      get: (mod, key) => settings.get(`${mod}.${key}`) ?? (key === "assistantSecrets" ? true : null),
      set: async (mod, key, value) => { settings.set(`${mod}.${key}`, value); return value; }
    },
    socket: {
      emit: (channel, message, options) => socketLog.push({ channel, message: structuredClone(message), options }),
      on: (channel, fn) => socketHandlers.push(fn)
    }
  };
  /** Delivers a module-socket message to this client as if the server relayed it from `senderId`. */
  const deliver = (message, senderId) => { for (const fn of socketHandlers) fn(structuredClone(message), senderId); };
  return { journal, settings, notifications, socketLog, storage, deliver };
}

/** Builds the module's containers the same way ensureContainers does. */
export async function makeContainers(env) {
  const shared = new FakeEntry({ name: "Journalinator: Shared Journal" });
  const history = new FakeEntry({ name: "Journalinator: History" });
  const secrets = new FakeEntry({ name: "Journalinator: GM Secrets" });
  for (const e of [shared, history, secrets]) env.journal.set(e.id, e);
  const layoutPage = await JournalEntryPage.create({ name: "__layout__", type: "fvtt-journalinator.layout", system: {} }, { parent: shared });
  const statsPage = await JournalEntryPage.create({ name: "__stats__", type: "fvtt-journalinator.stats", system: {} }, { parent: shared });
  const historyPage = await JournalEntryPage.create({ name: "__history__", type: "fvtt-journalinator.history", system: {} }, { parent: history });
  const ids = { shared: shared.id, history: history.id, secrets: secrets.id, layoutPage: layoutPage.id, statsPage: statsPage.id, historyPage: historyPage.id };
  await game.settings.set("fvtt-journalinator", "containerIds", ids);
  return { shared, history, secrets, ids };
}
