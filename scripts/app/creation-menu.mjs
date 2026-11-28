/**
 * Blank / Document / Profile creation menu.
 *
 * The three entries are creation templates, never stored note types. Choosing one builds the
 * exact body/layout/skin payload and requests the editing lease in the same protocol message,
 * so a rejected creation never leaves an orphan card.
 */

import { TEMPLATES, createNoteFromTemplate, templateSkin } from "../templates.mjs";

export const CREATION_CHOICES = Object.freeze(TEMPLATES.map(template => Object.freeze({
  id: template.id,
  labelKey: template.labelKey,
  descriptionKey: template.descriptionKey,
  body: template.body,
  layout: template.layout,
  skin: templateSkin(template.id),
  focus: template.focus
})));

export function getCreationChoice(id) {
  return CREATION_CHOICES.find(choice => choice.id === id) ?? CREATION_CHOICES[0];
}

/**
 * Complete `createNote` protocol payload. The noteId is intentionally absent: the active GM
 * allocates it, then seeds the skin tilt from that permanent id.
 */
export function buildCreationPayload(id, { x, y, clientSessionId } = {}) {
  const choice = getCreationChoice(id);
  const created = createNoteFromTemplate(choice.id);
  return {
    type: "createNote",
    body: created.body,
    layout: created.layout,
    skin: created.skin,
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    requestEdit: true,
    ...(typeof clientSessionId === "string" && clientSessionId ? { clientSessionId } : {})
  };
}

/**
 * Sends one creation request. `onCreated` is only called for a `noteCreated` reply; a
 * `noteCreateRejected`, timeout or missing reply leaves the board untouched.
 */
export async function createNoteFromMenu({
  templateId,
  x,
  y,
  clientSessionId,
  requestEditReply,
  onCreated
} = {}) {
  const choice = getCreationChoice(templateId);
  const payload = buildCreationPayload(choice.id, { x, y, clientSessionId });
  if (typeof requestEditReply !== "function") return { ok: false, reason: "transport" };
  let reply;
  try {
    reply = await requestEditReply(payload);
  } catch (error) {
    return { ok: false, reason: "transport", error };
  }
  if (!reply || reply.type !== "noteCreated" || typeof reply.noteId !== "string") {
    return { ok: false, reason: reply?.reason ?? reply?.type ?? "rejected", reply };
  }
  const result = {
    ok: true,
    reply,
    template: choice,
    focus: choice.focus,
    note: {
      noteId: reply.noteId,
      revision: Number.isInteger(reply.revision) ? reply.revision : 0,
      body: typeof reply.body === "string" ? reply.body : choice.body,
      layout: reply.layout === "profile" ? "profile" : "plain",
      skin: reply.skin ?? choice.skin
    }
  };
  await onCreated?.(result);
  return result;
}

function closeOnOutside(element, close) {
  const handler = event => {
    if (element.contains(event.target)) return;
    close();
  };
  element.ownerDocument.addEventListener("pointerdown", handler, true);
  return () => element.ownerDocument.removeEventListener("pointerdown", handler, true);
}

/**
 * Opens the small anchored menu used by both `+ Note` and an empty-board double click.
 *
 * @param {Object} options
 * @param {Element|null} [options.anchor] Trigger element, or null for a board point.
 * @param {number} [options.clientX]
 * @param {number} [options.clientY]
 * @param {(id: string) => void} [options.onChoose]
 * @param {(key: string) => string} [options.t]
 */
export function openCreationMenu({
  anchor = null,
  clientX = 0,
  clientY = 0,
  onChoose,
  t = key => key
} = {}) {
  const doc = anchor?.ownerDocument ?? globalThis.document;
  const element = doc.createElement("div");
  element.className = "jn-creation-menu";
  element.setAttribute("role", "menu");
  element.setAttribute("aria-label", t("JN.Creation.MenuTitle"));

  const items = CREATION_CHOICES.map(choice => {
    const item = doc.createElement("button");
    item.type = "button";
    item.className = "jn-creation-choice";
    item.dataset.template = choice.id;
    item.setAttribute("role", "menuitem");
    const label = doc.createElement("span");
    label.className = "jn-creation-choice-label";
    label.textContent = t(choice.labelKey);
    const hint = doc.createElement("small");
    hint.className = "jn-creation-choice-hint";
    hint.textContent = t(choice.descriptionKey);
    item.append(label, hint);
    element.appendChild(item);
    return item;
  });

  let closed = false;
  let removeOutside = null;
  const close = ({ restoreFocus = true } = {}) => {
    if (closed) return;
    closed = true;
    removeOutside?.();
    element.remove();
    doc.removeEventListener("keydown", onKeydown, true);
    if (restoreFocus) anchor?.focus?.({ preventScroll: true });
  };

  const choose = item => {
    if (closed) return;
    const id = item?.dataset?.template;
    close({ restoreFocus: false });
    if (id) onChoose?.(id);
  };

  const focusItem = index => {
    const bounded = Math.max(0, Math.min(items.length - 1, index));
    items[bounded]?.focus({ preventScroll: true });
  };

  const onKeydown = event => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Enter") {
      const active = doc.activeElement?.closest?.(".jn-creation-choice");
      if (!active || !element.contains(active)) return;
      event.preventDefault();
      event.stopPropagation();
      choose(active);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const current = items.indexOf(doc.activeElement?.closest?.(".jn-creation-choice"));
      const delta = event.key === "ArrowDown" ? 1 : -1;
      focusItem(current < 0 ? (delta > 0 ? 0 : items.length - 1) : current + delta);
    }
  };

  for (const item of items) {
    item.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      choose(item);
    });
  }
  element.addEventListener("keydown", onKeydown);
  doc.addEventListener("keydown", onKeydown, true);

  (doc.body ?? anchor?.parentElement).appendChild(element);
  const rect = anchor?.getBoundingClientRect?.();
  const left = Number.isFinite(clientX) && clientX ? clientX : (rect?.left ?? 0);
  const top = Number.isFinite(clientY) && clientY ? clientY : (rect?.bottom ?? 0);
  element.style.left = `${Math.max(8, left)}px`;
  element.style.top = `${Math.max(8, top)}px`;
  removeOutside = closeOnOutside(element, () => close());

  // Keep the menu inside the viewport (8 px inset) after its intrinsic size is known.
  const view = doc.defaultView;
  const rectBox = element.getBoundingClientRect?.();
  if (view && rectBox) {
    const maxLeft = Math.max(8, (view.innerWidth ?? 0) - (rectBox.width ?? 0) - 8);
    const maxTop = Math.max(8, (view.innerHeight ?? 0) - (rectBox.height ?? 0) - 8);
    element.style.left = `${Math.max(8, Math.min(left, maxLeft))}px`;
    element.style.top = `${Math.max(8, Math.min(top, maxTop))}px`;
  }

  focusItem(0);
  return { element, items, close, choose };
}

export default openCreationMenu;
