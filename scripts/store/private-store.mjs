import { getContainerIds } from "./containers.mjs";
import { CARD_STYLES, seedTilt } from "../styles/registry.mjs";
import { CARD_SIDES, MAX_THREAD_PINS, validLinkPoint, validThreadPin } from "../card-ports.mjs";
import { normalizeLinkColor } from "../link-colors.mjs";
import { DEFAULT_STAMP_CORNER, STAMP_COLORS, isStampCorner, stampUrl } from "../stamps.mjs";
import { t } from "../i18n.mjs";

const MODULE_ID = "fvtt-journalinator";
const PRIVATE_TYPE = "text";
const FLAG = "private";
const MAX_NAME_LENGTH = 100;
const MAX_TITLE_LENGTH = 200;

const randomID = () => foundry.utils.randomID();
const NONE = () => CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
const OWNER = () => CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;

export function emptyWorkspace() {
  return {
    format: 1,
    notes: {},
    layout: { cards: {}, labels: {}, viewport: null },
    trash: []
  };
}

function normalizeBlock(block) {
  const blockId = typeof block?.blockId === "string" && block.blockId ? block.blockId : randomID();
  return { blockId, text: typeof block?.text === "string" ? block.text : "" };
}

function normalizeLink(link) {
  const direction = ["none", "one", "two"].includes(link?.direction) ? link.direction : "none";
  const lineStyle = link?.lineStyle === "dashed" ? "dashed" : "solid";
  const clean = {
    id: typeof link?.id === "string" && link.id ? link.id : randomID(),
    targetId: typeof link?.targetId === "string" ? link.targetId : "",
    label: typeof link?.label === "string" ? link.label.slice(0, 200) : "",
    direction,
    color: normalizeLinkColor(link?.color),
    lineStyle,
    origin: link?.origin === "typed" ? "typed" : "drawn",
    edited: link?.edited === true,
    createdBy: typeof link?.createdBy === "string" ? link.createdBy : "",
    hint: false
  };
  for (const key of ["sourceSide", "targetSide"]) {
    if (CARD_SIDES.includes(link?.[key])) clean[key] = link[key];
  }
  for (const key of ["sourcePoint", "targetPoint"]) {
    if (validLinkPoint(link?.[key])) clean[key] = { x: link[key].x, y: link[key].y };
  }
  if (Array.isArray(link?.pins)) {
    clean.pins = link.pins.slice(0, MAX_THREAD_PINS).filter(validThreadPin).map(({ x, y }) => ({ x, y }));
  }
  return clean;
}

function normalizeLabel(label) {
  const stamp = typeof label?.stamp === "string" && stampUrl(label.stamp) ? label.stamp : "";
  const color = Object.values(STAMP_COLORS).includes(label?.color) ? label.color : "";
  return {
    text: typeof label?.text === "string" ? label.text.slice(0, 500) : "",
    x: Number.isFinite(label?.x) ? label.x : 0,
    y: Number.isFinite(label?.y) ? label.y : 0,
    size: Number.isFinite(label?.size) ? label.size : 14,
    color,
    stamp,
    noteId: typeof label?.noteId === "string" ? label.noteId : "",
    corner: isStampCorner(label?.corner) ? label.corner : DEFAULT_STAMP_CORNER
  };
}

function normalizeNote(note) {
  const style = Object.hasOwn(CARD_STYLES, note?.style) ? note.style : "sticky";
  const kind = note?.kind === "location" ? "location" : "note";
  return {
    id: typeof note?.id === "string" && note.id ? note.id : randomID(),
    title: typeof note?.title === "string" ? note.title.slice(0, MAX_TITLE_LENGTH) : "",
    kind,
    style,
    targetHeading: typeof note?.targetHeading === "string" ? note.targetHeading.slice(0, 80) : "",
    image: typeof note?.image === "string" ? note.image : null,
    backgroundImage: typeof note?.backgroundImage === "string" ? note.backgroundImage : null,
    blocks: Array.isArray(note?.blocks) && note.blocks.length
      ? note.blocks.map(normalizeBlock)
      : [{ blockId: randomID(), text: "" }],
    links: (Array.isArray(note?.links) ? note.links : []).map(normalizeLink),
    createdAt: Number.isFinite(note?.createdAt) ? note.createdAt : Date.now(),
    updatedAt: Number.isFinite(note?.updatedAt) ? note.updatedAt : Date.now()
  };
}

export function normalizeWorkspace(input) {
  const source = input && typeof input === "object" ? input : {};
  const notes = {};
  for (const [id, note] of Object.entries(source.notes && typeof source.notes === "object" ? source.notes : {})) {
    const clean = normalizeNote({ ...note, id });
    notes[clean.id] = clean;
  }
  const cards = {};
  for (const [id, card] of Object.entries(source.layout?.cards ?? {})) {
    if (!Number.isFinite(card?.x) || !Number.isFinite(card?.y)) continue;
    cards[id] = {
      x: card.x, y: card.y,
      width: Number.isFinite(card.width) && card.width > 0 ? card.width : null,
      height: Number.isFinite(card.height) && card.height > 0 ? card.height : null,
      rotation: Number.isFinite(card.rotation) ? card.rotation : 0
    };
  }
  const labels = {};
  for (const [id, label] of Object.entries(source.layout?.labels ?? {})) {
    labels[id] = normalizeLabel(label);
  }
  const trash = (Array.isArray(source.trash) ? source.trash : []).map(entry => ({
    note: normalizeNote(entry?.note),
    card: entry?.card && Number.isFinite(entry.card.x) && Number.isFinite(entry.card.y) ? entry.card : null,
    deletedAt: Number.isFinite(entry?.deletedAt) ? entry.deletedAt : Date.now(),
    undoId: typeof entry?.undoId === "string" ? entry.undoId : null
  }));
  return {
    format: 1,
    notes,
    layout: {
      cards,
      labels,
      viewport: source.layout?.viewport ?? null
    },
    trash
  };
}

class PrivateStore {
  #container() {
    const ids = getContainerIds();
    return ids?.private ? game.journal.get(ids.private) ?? null : null;
  }

  pages() {
    return [...(this.#container()?.pages ?? [])]
      .filter(page => page.flags?.[MODULE_ID]?.[FLAG]?.ownerUserId !== undefined
        || page.flags?.[MODULE_ID]?.[FLAG]?.state !== undefined
        || page.flags?.[MODULE_ID]?.[FLAG]?.workspace !== undefined);
  }

  flags(page) {
    return page?.flags?.[MODULE_ID]?.[FLAG] ?? {};
  }

  state(page) {
    return this.flags(page).state ?? "orphaned";
  }

  ownerId(page) {
    return this.flags(page).ownerUserId ?? null;
  }

  findActive(userId) {
    return this.pages().find(page => this.ownerId(page) === userId && this.state(page) === "active") ?? null;
  }

  findPending(userId) {
    return this.pages().find(page => this.flags(page).pendingOwnerUserId === userId && this.state(page) === "pending") ?? null;
  }

  findById(pageId) {
    return this.pages().find(page => page.id === pageId) ?? null;
  }

  read(page) {
    const privateFlag = page?.flags?.[MODULE_ID]?.[FLAG] ?? {};
    const raw = privateFlag.workspace ?? page?.system?.workspace;
    let value = raw;
    if (typeof raw === "string") {
      try { value = JSON.parse(raw); } catch { value = null; }
    }
    return normalizeWorkspace(value);
  }

  defaultName(user) {
    return t("JN.Private.DefaultName", { name: user?.name ?? t("JN.Common.Unknown") });
  }

  uniqueName(base, excludeId = null) {
    const clean = String(base ?? "").trim() || t("JN.Private.DefaultName", { name: t("JN.Common.Unknown") });
    const names = new Set(this.pages()
      .filter(page => page.id !== excludeId)
      .map(page => page.name.trim().toLowerCase()));
    if (!names.has(clean.toLowerCase())) return clean;
    let suffix = 2;
    while (names.has(`${clean} ${suffix}`.toLowerCase())) suffix++;
    return `${clean} ${suffix}`;
  }

  async createFor(user) {
    if (!user) throw new Error(t("JN.Private.UserMissing"));
    const existing = this.findActive(user.id) ?? this.findPending(user.id);
    if (existing) return existing;
    const container = this.#container();
    if (!container) throw new Error(t("JN.Private.ContainerMissing"));
    const name = this.uniqueName(this.defaultName(user)).slice(0, MAX_NAME_LENGTH);
    return JournalEntryPage.create({
      name,
      type: PRIVATE_TYPE,
      system: {},
      ownership: { default: NONE(), [user.id]: OWNER() },
      flags: {
        [MODULE_ID]: {
          [FLAG]: {
            ownerUserId: user.id, pendingOwnerUserId: null, state: "active", rev: 0,
            workspace: JSON.stringify(emptyWorkspace())
          }
        }
      }
    }, { parent: container });
  }

  async save(page, workspace, expectedRev = null) {
    const current = this.flags(page);
    const rev = Number.isFinite(current.rev) ? current.rev : 0;
    if (expectedRev !== null && expectedRev !== rev) {
      throw new Error(t("JN.Private.SaveConflict"));
    }
    const clean = normalizeWorkspace(workspace);
    await page.update({
      [`flags.${MODULE_ID}.${FLAG}.workspace`]: JSON.stringify(clean),
      [`flags.${MODULE_ID}.${FLAG}.rev`]: rev + 1
    });
    return { workspace: clean, rev: rev + 1 };
  }

  async rename(page, name) {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error(t("JN.Private.NameEmpty"));
    if (clean.length > MAX_NAME_LENGTH) throw new Error(t("JN.Private.NameTooLong", { max: MAX_NAME_LENGTH }));
    if (this.pages().some(other => other.id !== page.id
        && other.name.trim().toLowerCase() === clean.toLowerCase())) {
      throw new Error(t("JN.Private.NameTaken"));
    }
    await page.update({ name: clean });
    return clean;
  }

  async assign(page, userId) {
    const state = this.state(page);
    if (state === "active" || this.ownerId(page)) throw new Error(t("JN.Private.DetachFirst"));
    const target = game.users.get(userId);
    if (!target) throw new Error(t("JN.Private.UserMissing"));
    if (this.findActive(userId) || this.findPending(userId)) throw new Error(t("JN.Private.AlreadyHas"));
    await page.update({
      [`flags.${MODULE_ID}.${FLAG}.ownerUserId`]: null,
      [`flags.${MODULE_ID}.${FLAG}.pendingOwnerUserId`]: userId,
      [`flags.${MODULE_ID}.${FLAG}.state`]: "pending"
    });
  }

  async detach(page) {
    await page.update({
      [`flags.${MODULE_ID}.${FLAG}.ownerUserId`]: null,
      [`flags.${MODULE_ID}.${FLAG}.pendingOwnerUserId`]: null,
      [`flags.${MODULE_ID}.${FLAG}.state`]: "orphaned",
      ownership: { default: NONE() }
    });
  }

  async accept(page, userId) {
    if (this.flags(page).pendingOwnerUserId !== userId) throw new Error(t("JN.Private.NotYours"));
    if (this.findActive(userId)) throw new Error(t("JN.Private.AlreadyHas"));
    await page.update({
      [`flags.${MODULE_ID}.${FLAG}.ownerUserId`]: userId,
      [`flags.${MODULE_ID}.${FLAG}.pendingOwnerUserId`]: null,
      [`flags.${MODULE_ID}.${FLAG}.state`]: "active",
      ownership: { default: NONE(), [userId]: OWNER() }
    });
  }

  async decline(page, userId) {
    if (this.flags(page).pendingOwnerUserId !== userId) throw new Error(t("JN.Private.NotYours"));
    await page.update({
      [`flags.${MODULE_ID}.${FLAG}.pendingOwnerUserId`]: null,
      [`flags.${MODULE_ID}.${FLAG}.state`]: "orphaned"
    });
  }

  async remove(page) {
    await page.delete();
  }

  /** Keeps the workspace when a user disappears, but marks it ready for admin reassignment. */
  async orphanUser(userId) {
    const affected = this.pages().filter(page =>
      this.ownerId(page) === userId || this.flags(page).pendingOwnerUserId === userId);
    for (const page of affected) {
      await page.update({
        [`flags.${MODULE_ID}.${FLAG}.ownerUserId`]: null,
        [`flags.${MODULE_ID}.${FLAG}.pendingOwnerUserId`]: null,
        [`flags.${MODULE_ID}.${FLAG}.state`]: "orphaned",
        ownership: { default: NONE() }
      });
    }
    return affected.length;
  }

  /** Repairs workspaces whose owner was removed while this GM was offline. */
  async orphanMissingUsers() {
    const existing = new Set([...game.users].map(user => user.id));
    const missing = new Set();
    for (const page of this.pages()) {
      const owner = this.ownerId(page);
      const pending = this.flags(page).pendingOwnerUserId;
      if (owner && !existing.has(owner)) missing.add(owner);
      if (pending && !existing.has(pending)) missing.add(pending);
    }
    let count = 0;
    for (const userId of missing) count += await this.orphanUser(userId);
    return count;
  }

  noteView(page, note) {
    const ownerId = this.ownerId(page) || "";
    return {
      _id: note.id,
      id: note.id,
      name: note.title,
      secret: false,
      system: {
        kind: note.kind,
        style: note.style,
        targetHeading: note.targetHeading,
        image: note.image,
        backgroundImage: note.backgroundImage,
        blocks: note.blocks,
        links: note.links ?? [],
        authorId: ownerId,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        editCount: 0,
        contributions: {},
        hint: false,
        formerNames: [],
        deleted: null
      }
    };
  }

  noteViews(page, workspace = this.read(page)) {
    return Object.values(workspace.notes).map(note => this.noteView(page, note));
  }

  findFreeSpot(cards, w, h, nearX, nearY) {
    for (let r = 0; r < 40; r++) {
      for (let k = 0; k < 8; k++) {
        const x = nearX + Math.cos(k * 0.785) * r * 45;
        const y = nearY + Math.sin(k * 0.785) * r * 45;
        const overlaps = Object.values(cards).some(card => {
          const cw = card.width ?? 200, ch = card.height ?? 90;
          return !(x + w + 16 < card.x || x > card.x + cw + 16 || y + h + 16 < card.y || y > card.y + ch + 16);
        });
        if (!overlaps) return { x, y };
      }
    }
    return { x: nearX, y: nearY };
  }

  makeNote({ title, kind = "note", style = "sticky", x = 0, y = 0, cards }) {
    const resolvedStyle = Object.hasOwn(CARD_STYLES, style) ? style : "sticky";
    const resolvedKind = kind === "location" ? "location" : "note";
    const width = CARD_STYLES[resolvedStyle]?.defaultWidth ?? 190;
    const height = CARD_STYLES[resolvedStyle]?.defaultHeight ?? 90;
    const spot = this.findFreeSpot(cards, width, height, x, y);
    return {
      note: {
        id: randomID(),
        title: String(title ?? "").trim().slice(0, MAX_TITLE_LENGTH) || t("JN.Private.NewNoteTitle"),
        kind: resolvedKind,
        style: resolvedStyle,
        targetHeading: "",
        image: null,
        backgroundImage: null,
        blocks: [{ blockId: randomID(), text: "" }],
        links: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      card: { x: spot.x, y: spot.y, width: null, height: null, rotation: seedTilt(resolvedStyle) }
    };
  }
}

export const privateStore = new PrivateStore();
export { MAX_NAME_LENGTH, MAX_TITLE_LENGTH };
