import { getContainerIds } from "./containers.mjs";
import { CARD_STYLES, seedTilt } from "../styles/registry.mjs";
import {
  CARD_SIDES, DEFAULT_CARD_PORTS, MAX_THREAD_PINS, validCardPorts, validLinkPoint, validThreadPin
} from "../card-ports.mjs";
import { normalizeLinkColor } from "../link-colors.mjs";
import { DEFAULT_STAMP_CORNER, STAMP_COLORS, isStampCorner, stampUrl } from "../stamps.mjs";
import {
  resolveAttachment, resolveLinkCosmetics, resolvePresentation, sanitizeCardAnchorsWithMain
} from "../presentation.mjs";
import { t } from "../i18n.mjs";

const MODULE_ID = "fvtt-journalinator";
const PRIVATE_TYPE = "text";
const FLAG = "private";
const MAX_NAME_LENGTH = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_ROUTE_ANCHORS = 24;
const MAX_ANCHOR_ID_LENGTH = 64;
const WORKSPACE_FORMAT = 2;
const NOTE_SCHEMA_VERSION = 1;

const randomID = () => foundry.utils.randomID();
const NONE = () => CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
const OWNER = () => CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;

export function emptyWorkspace() {
  return {
    format: WORKSPACE_FORMAT,
    notes: {},
    layout: { cards: {}, labels: {}, viewport: null },
    trash: []
  };
}

function normalizeBlock(block) {
  const clean = {
    blockId: typeof block?.blockId === "string" && block.blockId ? block.blockId : randomID(),
    text: typeof block?.text === "string" ? block.text : ""
  };
  if (typeof block?.authorId === "string") clean.authorId = block.authorId;
  return clean;
}

function anchorId(value) {
  return typeof value === "string" ? value.slice(0, MAX_ANCHOR_ID_LENGTH) : "";
}

function normalizeRouteAnchors(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const anchors = [];
  for (const anchor of list) {
    if (typeof anchor?.noteId !== "string" || !anchor.noteId) continue;
    if (typeof anchor?.anchorId !== "string" || !anchor.anchorId) continue;
    const key = `${anchor.noteId}:${anchor.anchorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({
      noteId: anchor.noteId.slice(0, MAX_ANCHOR_ID_LENGTH),
      anchorId: anchor.anchorId.slice(0, MAX_ANCHOR_ID_LENGTH)
    });
    if (anchors.length >= MAX_ROUTE_ANCHORS) break;
  }
  return anchors;
}

function normalizeLink(link) {
  const direction = ["none", "one", "two"].includes(link?.direction) ? link.direction : "none";
  const lineStyle = link?.lineStyle === "dashed" ? "dashed" : "solid";
  const cosmetics = resolveLinkCosmetics(link);
  const clean = {
    id: typeof link?.id === "string" && link.id ? link.id : randomID(),
    targetId: typeof link?.targetId === "string" ? link.targetId : "",
    label: typeof link?.label === "string" ? link.label.slice(0, MAX_TITLE_LENGTH) : "",
    direction,
    color: normalizeLinkColor(link?.color),
    lineStyle,
    origin: link?.origin === "typed" ? "typed" : "drawn",
    edited: link?.edited === true,
    createdBy: typeof link?.createdBy === "string" ? link.createdBy : "",
    hint: false,
    sourceAnchorId: anchorId(link?.sourceAnchorId),
    targetAnchorId: anchorId(link?.targetAnchorId),
    routeAnchors: normalizeRouteAnchors(link?.routeAnchors),
    material: cosmetics.material,
    thickness: cosmetics.thickness,
    slack: cosmetics.slack,
    pattern: cosmetics.pattern,
    ends: cosmetics.ends,
    secondaryColor: cosmetics.secondaryColor
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

function normalizeAnchors(anchors, mainPinEnabled = true) {
  return sanitizeCardAnchorsWithMain(anchors, mainPinEnabled);
}

function normalizeCard(card, mainPinEnabled = true) {
  if (!Number.isFinite(card?.x) || !Number.isFinite(card?.y)) return null;
  return {
    x: card.x,
    y: card.y,
    width: Number.isFinite(card.width) && card.width > 0 ? card.width : null,
    height: Number.isFinite(card.height) && card.height > 0 ? card.height : null,
    rotation: Number.isFinite(card.rotation) ? card.rotation : 0,
    ports: validCardPorts(card.ports) ? [...card.ports] : [...DEFAULT_CARD_PORTS],
    anchors: normalizeAnchors(card.anchors, mainPinEnabled)
  };
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

function noteSchema(note, title) {
  const stored = note?.presentation && typeof note.presentation === "object" ? note.presentation : {};
  const presentation = resolvePresentation({
    name: title,
    system: {
      style: note?.style,
      targetHeading: note?.targetHeading,
      label: note?.label,
      presentation: stored
    }
  });
  const hasLabel = typeof note?.label === "string";
  const { label: _ignored, ...presentationFields } = presentation;
  return {
    schemaVersion: Number.isInteger(note?.schemaVersion) && note.schemaVersion > 0
      ? note.schemaVersion : NOTE_SCHEMA_VERSION,
    label: hasLabel
      ? note.label.slice(0, MAX_TITLE_LENGTH)
      : (presentation.nameGenerated ? "" : title.slice(0, MAX_TITLE_LENGTH)),
    presentation: presentationFields,
    attachment: resolveAttachment({ system: { attachment: note?.attachment } })
  };
}

function normalizeNote(note) {
  const style = Object.hasOwn(CARD_STYLES, note?.style) ? note.style : "sticky";
  const kind = note?.kind === "location" ? "location" : "note";
  const title = typeof note?.title === "string" ? note.title.slice(0, MAX_TITLE_LENGTH) : "";
  return {
    id: typeof note?.id === "string" && note.id ? note.id : randomID(),
    title,
    kind,
    style,
    targetHeading: typeof note?.targetHeading === "string" ? note.targetHeading.slice(0, 80) : "",
    ...noteSchema(note, title),
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

function normalizeViewport(viewport) {
  if (!viewport || typeof viewport !== "object") return null;
  return {
    x: Number.isFinite(viewport.x) ? viewport.x : 0,
    y: Number.isFinite(viewport.y) ? viewport.y : 0,
    zoom: Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
  };
}

export function normalizeWorkspace(input) {
  const source = input && typeof input === "object" ? input : {};
  // Formats 1 and 2 share this reader; the normalized result is always format 2.
  const notes = {};
  for (const [id, note] of Object.entries(source.notes && typeof source.notes === "object" ? source.notes : {})) {
    const clean = normalizeNote({ ...note, id });
    notes[clean.id] = clean;
  }
  const cards = {};
  for (const [id, card] of Object.entries(source.layout?.cards ?? {})) {
    const note = notes[id];
    const clean = normalizeCard(card, note ? resolveAttachment(note).mainPinEnabled : false);
    if (clean) cards[id] = clean;
  }
  const labels = {};
  for (const [id, label] of Object.entries(source.layout?.labels ?? {})) {
    labels[id] = normalizeLabel(label);
  }
  const trash = (Array.isArray(source.trash) ? source.trash : []).map(entry => {
    // A trash card without its note must not invent a main anchor: there is no attachment block
    // to tell us whether the note wanted one.
    const hasNote = !!entry?.note && typeof entry.note === "object" && !Array.isArray(entry.note);
    const note = normalizeNote(entry?.note);
    return {
      note,
      card: normalizeCard(entry?.card, hasNote ? resolveAttachment(note).mainPinEnabled : false),
      deletedAt: Number.isFinite(entry?.deletedAt) ? entry.deletedAt : Date.now(),
      undoId: typeof entry?.undoId === "string" ? entry.undoId : null
    };
  });
  return {
    format: WORKSPACE_FORMAT,
    notes,
    layout: {
      cards,
      labels,
      viewport: normalizeViewport(source.layout?.viewport)
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
        schemaVersion: note.schemaVersion,
        label: note.label,
        presentation: note.presentation,
        attachment: note.attachment,
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
    const cleanTitle = String(title ?? "").trim().slice(0, MAX_TITLE_LENGTH);
    const storedTitle = cleanTitle || t("JN.Private.NewNoteTitle");
    const schema = noteSchema({ style: resolvedStyle }, storedTitle);
    const ownerId = game.user?.id ?? "";
    return {
      note: {
        id: randomID(),
        title: storedTitle,
        kind: resolvedKind,
        style: resolvedStyle,
        targetHeading: "",
        ...schema,
        image: null,
        backgroundImage: null,
        blocks: [{ blockId: randomID(), text: "" }],
        links: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      card: {
        x: spot.x,
        y: spot.y,
        width: null,
        height: null,
        rotation: seedTilt(resolvedStyle),
        ports: [...DEFAULT_CARD_PORTS],
        anchors: {
          main: { kind: "main", x: 0.5, y: 0, createdBy: ownerId }
        }
      }
    };
  }
}

export const privateStore = new PrivateStore();
export { MAX_NAME_LENGTH, MAX_TITLE_LENGTH };
