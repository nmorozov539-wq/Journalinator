/**
 * Read-mode selection toolbar for note cards.
 *
 * Order is fixed by the interface spec: Edit, Layout, Appearance, Auto, More. The module owns
 * only DOM and local interaction state; every mutation is a callback so JournalApp can acquire
 * the short lease and issue the validated socket command. The overlay is screen space and never
 * participates in paper geometry.
 */

import { FONTS, PAPERS, resolveSkin, isPaper, isFont } from "../skins/registry.mjs";

function button({ className, label, action, role, pressed }) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.dataset.action = action;
  if (role) element.setAttribute("role", role);
  if (typeof pressed === "boolean") element.setAttribute("aria-checked", String(pressed));
  element.textContent = label;
  return element;
}

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function createSelectionBar({
  t,
  onEdit,
  onLayout,
  onAppearance,
  onAuto,
  onHistory,
  onSend,
  onCopy,
  onDelete,
  onChooseBackground,
  onLocked
} = {}) {
  const element = document.createElement("div");
  element.className = "jn-selection-bar";
  element.setAttribute("role", "toolbar");
  element.setAttribute("aria-label", t("JN.Selection.Toolbar"));
  element.hidden = true;

  const notice = document.createElement("div");
  notice.className = "jn-selection-notice";
  notice.setAttribute("role", "status");
  notice.hidden = true;

  const edit = button({ className: "jn-selection-button", label: t("JN.Selection.Edit"), action: "edit" });

  const layoutWrap = document.createElement("div");
  layoutWrap.className = "jn-selection-menu-wrap";
  const layoutButton = button({
    className: "jn-selection-button", label: t("JN.Selection.Layout"), action: "layout"
  });
  layoutButton.setAttribute("aria-haspopup", "menu");
  layoutButton.setAttribute("aria-expanded", "false");
  const layoutMenu = document.createElement("div");
  layoutMenu.className = "jn-selection-popover jn-selection-layout";
  layoutMenu.setAttribute("role", "menu");
  layoutMenu.hidden = true;
  const layoutItems = ["plain", "profile"].map(value => {
    const item = button({
      className: "jn-selection-menu-item",
      label: t(value === "profile" ? "JN.Layout.Profile" : "JN.Layout.Plain"),
      action: value,
      role: "menuitemradio",
      pressed: false
    });
    item.dataset.layout = value;
    layoutMenu.appendChild(item);
    return item;
  });
  layoutWrap.append(layoutButton, layoutMenu);

  const appearanceWrap = document.createElement("div");
  appearanceWrap.className = "jn-selection-menu-wrap";
  const appearanceButton = button({
    className: "jn-selection-button", label: t("JN.Selection.Appearance"), action: "appearance"
  });
  appearanceButton.setAttribute("aria-haspopup", "dialog");
  appearanceButton.setAttribute("aria-expanded", "false");
  const appearancePopover = document.createElement("div");
  appearancePopover.className = "jn-selection-popover jn-selection-appearance";
  appearancePopover.setAttribute("role", "dialog");
  appearancePopover.setAttribute("aria-label", t("JN.Selection.Appearance"));
  appearancePopover.hidden = true;
  appearanceWrap.append(appearanceButton, appearancePopover);

  const auto = button({ className: "jn-selection-button", label: t("JN.Selection.Auto"), action: "auto" });
  auto.setAttribute("aria-pressed", "true");

  const moreWrap = document.createElement("div");
  moreWrap.className = "jn-selection-menu-wrap";
  const moreButton = button({
    className: "jn-selection-button", label: t("JN.Selection.More"), action: "more"
  });
  moreButton.setAttribute("aria-haspopup", "menu");
  moreButton.setAttribute("aria-expanded", "false");
  const moreMenu = document.createElement("div");
  moreMenu.className = "jn-selection-popover jn-selection-more";
  moreMenu.setAttribute("role", "menu");
  moreMenu.hidden = true;
  moreWrap.append(moreButton, moreMenu);

  element.append(edit, layoutWrap, appearanceWrap, auto, moreWrap, notice);

  // --- Appearance rows ---------------------------------------------------------------
  const paperRow = document.createElement("div");
  paperRow.className = "jn-selection-row jn-selection-paper";
  paperRow.append(Object.assign(document.createElement("span"), {
    className: "jn-selection-row-label", textContent: t("JN.Skin.Paper")
  }));
  const paperGroup = document.createElement("div");
  paperGroup.className = "jn-selection-swatches";
  paperGroup.setAttribute("role", "radiogroup");
  paperGroup.setAttribute("aria-label", t("JN.Skin.Paper"));
  const paperButtons = new Map();
  for (const [id, paper] of Object.entries(PAPERS)) {
    const choice = button({
      className: "jn-selection-swatch", label: t(paper.labelKey), action: id, role: "radio", pressed: false
    });
    choice.dataset.paper = id;
    paperGroup.appendChild(choice);
    paperButtons.set(id, choice);
  }
  paperRow.appendChild(paperGroup);

  const fontRow = document.createElement("div");
  fontRow.className = "jn-selection-row jn-selection-font";
  fontRow.append(Object.assign(document.createElement("span"), {
    className: "jn-selection-row-label", textContent: t("JN.Skin.Font")
  }));
  const fontGroup = document.createElement("div");
  fontGroup.className = "jn-selection-fonts";
  fontGroup.setAttribute("role", "radiogroup");
  fontGroup.setAttribute("aria-label", t("JN.Skin.Font"));
  const fontButtons = new Map();
  for (const [id, font] of Object.entries(FONTS)) {
    const choice = button({
      className: "jn-selection-font-choice", label: t(font.labelKey), action: id, role: "radio", pressed: false
    });
    choice.dataset.font = id;
    fontGroup.appendChild(choice);
    fontButtons.set(id, choice);
  }
  fontRow.appendChild(fontGroup);

  const tornRow = document.createElement("label");
  tornRow.className = "jn-selection-row jn-selection-torn";
  const tornText = document.createElement("span");
  tornText.className = "jn-selection-row-label";
  tornText.textContent = t("JN.Skin.Torn");
  const tornInput = document.createElement("input");
  tornInput.type = "checkbox";
  tornInput.className = "jn-selection-torn-input";
  tornRow.append(tornText, tornInput);

  const backgroundRow = document.createElement("div");
  backgroundRow.className = "jn-selection-row jn-selection-background";
  backgroundRow.append(Object.assign(document.createElement("span"), {
    className: "jn-selection-row-label", textContent: t("JN.Skin.BackgroundImage")
  }));
  const backgroundActions = document.createElement("div");
  backgroundActions.className = "jn-selection-background-actions";
  const backgroundChoose = button({
    className: "jn-selection-background-choose", label: t("JN.Skin.Choose"), action: "background-choose"
  });
  const backgroundRemove = button({
    className: "jn-selection-background-remove", label: t("JN.Skin.Remove"), action: "background-remove"
  });
  backgroundActions.append(backgroundChoose, backgroundRemove);
  backgroundRow.appendChild(backgroundActions);

  appearancePopover.append(paperRow, fontRow, tornRow, backgroundRow);

  const historyItem = button({
    className: "jn-selection-menu-item", label: t("JN.Selection.History"), action: "history"
  });
  const sendItem = button({
    className: "jn-selection-menu-item", label: t("JN.Transfer.SendTo"), action: "send"
  });
  const copyItem = button({
    className: "jn-selection-menu-item", label: t("JN.Selection.Copy"), action: "copy"
  });
  const deleteItem = button({
    className: "jn-selection-menu-item jn-selection-delete", label: t("JN.Common.Delete"), action: "delete"
  });
  moreMenu.append(historyItem, sendItem, copyItem, deleteItem);

  let current = {
    ids: [], notes: [], lockedIds: [], readOnly: false, cards: {}, signature: "none", open: null
  };

  const doc = () => element.ownerDocument ?? globalThis.document;
  let dismiss = null;
  let keydown = null;

  const removeDismiss = () => {
    if (dismiss) doc().removeEventListener("pointerdown", dismiss, true);
    if (keydown) doc().removeEventListener("keydown", keydown, true);
    dismiss = null;
    keydown = null;
  };

  const setOpen = open => {
    removeDismiss();
    current.open = open;
    layoutMenu.hidden = open !== "layout";
    appearancePopover.hidden = open !== "appearance";
    moreMenu.hidden = open !== "more";
    layoutButton.setAttribute("aria-expanded", String(open === "layout"));
    appearanceButton.setAttribute("aria-expanded", String(open === "appearance"));
    moreButton.setAttribute("aria-expanded", String(open === "more"));
    if (!open) return;
    const wrap = open === "layout" ? layoutWrap : (open === "appearance" ? appearanceWrap : moreWrap);
    dismiss = event => {
      if (wrap.contains(event.target) || element.contains(event.target)) return;
      setOpen(null);
    };
    keydown = event => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(null);
      (open === "layout" ? layoutButton : open === "appearance" ? appearanceButton : moreButton)
        .focus({ preventScroll: true });
    };
    doc().addEventListener("pointerdown", dismiss, true);
    doc().addEventListener("keydown", keydown, true);
  };

  const getIds = () => current.ids;

  const renderAppearance = () => {
    const skins = current.notes.map(note => resolveSkin(note));
    const common = key => {
      const value = skins[0]?.[key];
      return skins.length > 0 && skins.every(skin => skin[key] === value) ? value : null;
    };
    const paper = common("paper");
    const font = common("font");
    for (const [id, choice] of paperButtons) {
      const checked = id === paper;
      choice.setAttribute("aria-checked", String(checked));
      choice.classList.toggle("is-selected", checked);
    }
    for (const [id, choice] of fontButtons) {
      const checked = id === font;
      choice.setAttribute("aria-checked", String(checked));
      choice.classList.toggle("is-selected", checked);
    }
    const torn = common("torn");
    tornInput.checked = torn === true;
    tornInput.indeterminate = torn === null;
    const background = common("backgroundImage");
    backgroundRemove.disabled = !background;
  };

  const renderLayout = () => {
    const layouts = current.notes.map(note => note.system?.layout === "profile" ? "profile" : "plain");
    const common = layouts.length && layouts.every(value => value === layouts[0]) ? layouts[0] : null;
    for (const item of layoutItems) {
      const checked = item.dataset.layout === common;
      item.setAttribute("aria-checked", String(checked));
      item.classList.toggle("is-selected", checked);
    }
    layoutButton.dataset.layout = common ?? "mixed";
  };

  const renderDisabled = () => {
    const ids = getIds();
    const blocked = current.readOnly || current.lockedIds.length > 0;
    edit.disabled = blocked || ids.length !== 1;
    layoutButton.disabled = blocked;
    appearanceButton.disabled = blocked;
    auto.disabled = blocked;
    moreButton.disabled = ids.length === 0;
    for (const item of [historyItem, sendItem, copyItem, deleteItem]) item.disabled = blocked;
    historyItem.disabled = current.readOnly || ids.length !== 1;
    notice.hidden = !(blocked && (current.lockedIds.length > 0));
    if (!notice.hidden) {
      notice.textContent = current.readOnly
        ? t("JN.Selection.ReadOnly")
        : t("JN.Selection.LockedGroup");
    }
    edit.setAttribute("aria-disabled", String(edit.disabled));
  };

  const renderAuto = () => {
    const modes = current.notes.map(note => current.cards?.[note._id]?.sizing?.mode === "manual"
      ? "manual" : "auto");
    const automatic = modes.length > 0 && modes.every(mode => mode === "auto");
    auto.setAttribute("aria-pressed", String(automatic));
    auto.classList.toggle("is-on", automatic);
    const label = automatic ? t("JN.Selection.Auto") : t("JN.Selection.UseAutomaticSizing");
    auto.title = label;
    auto.setAttribute("aria-label", label);
  };

  const onClick = callback => event => {
    event.preventDefault();
    event.stopPropagation();
    if (callback) callback(getIds());
  };

  edit.addEventListener("click", onClick(() => {
    if (!edit.disabled) onEdit?.(current.ids[0]);
  }));
  layoutButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (layoutButton.disabled) return;
    setOpen(current.open === "layout" ? null : "layout");
  });
  appearanceButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (appearanceButton.disabled) return;
    setOpen(current.open === "appearance" ? null : "appearance");
  });
  auto.addEventListener("click", onClick(() => {
    if (auto.disabled) return;
    if (auto.getAttribute("aria-pressed") === "true") return;
    onAuto?.(current.ids);
  }));
  moreButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (moreButton.disabled) return;
    setOpen(current.open === "more" ? null : "more");
  });

  for (const item of layoutItems) {
    item.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (item.disabled) return;
      setOpen(null);
      onLayout?.(current.ids, item.dataset.layout);
    });
  }
  for (const [id, choice] of paperButtons) {
    choice.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (choice.disabled || !isPaper(id)) return;
      onAppearance?.(current.ids, { paper: id });
    });
  }
  for (const [id, choice] of fontButtons) {
    choice.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (choice.disabled || !isFont(id)) return;
      onAppearance?.(current.ids, { font: id });
    });
  }
  tornInput.addEventListener("change", () => {
    if (tornInput.disabled) return;
    onAppearance?.(current.ids, { torn: tornInput.checked });
  });
  backgroundChoose.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (backgroundChoose.disabled) return;
    onChooseBackground?.(current.ids);
  });
  backgroundRemove.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (backgroundRemove.disabled) return;
    onAppearance?.(current.ids, { backgroundImage: null });
  });

  historyItem.addEventListener("click", onClick(() => {
    if (historyItem.disabled) return;
    setOpen(null);
    onHistory?.(current.ids[0]);
  }));
  sendItem.addEventListener("click", onClick(() => {
    if (sendItem.disabled) return;
    setOpen(null);
    onSend?.(current.ids[0]);
  }));
  copyItem.addEventListener("click", onClick(() => {
    if (copyItem.disabled) return;
    setOpen(null);
    onCopy?.(current.ids);
  }));
  deleteItem.addEventListener("click", onClick(() => {
    if (deleteItem.disabled) return;
    setOpen(null);
    onDelete?.(current.ids);
  }));

  return {
    element,
    notice,
    buttons: { edit, layout: layoutButton, appearance: appearanceButton, auto, more: moreButton },
    update({ notes = [], lockedIds = [], readOnly = false, cards = {} } = {}) {
      const ids = notes.map(note => note._id);
      const signature = [
        ids.join(","),
        lockedIds.join(","),
        readOnly ? "1" : "0",
        notes.map(note => `${note.system?.layout ?? "plain"}|${JSON.stringify(note.system?.skin ?? null)}`).join(";"),
        ids.map(id => cards[id]?.sizing?.mode ?? "auto").join(",")
      ].join("::");
      const changed = signature !== current.signature;
      current = { ids, notes, lockedIds, readOnly, cards, signature, open: current.open };
      if (changed && current.open) setOpen(null);
      renderLayout();
      renderAppearance();
      renderAuto();
      renderDisabled();
      if (!ids.length) {
        element.hidden = true;
        return false;
      }
      element.hidden = false;
      return true;
    },
    position(anchor, root) {
      if (element.hidden || !anchor || !root) return;
      const rootRect = root.getBoundingClientRect?.();
      const anchorRect = anchor.getBoundingClientRect?.();
      if (!rootRect || !anchorRect) return;
      const width = element.getBoundingClientRect?.().width ?? element.offsetWidth ?? 0;
      const height = element.getBoundingClientRect?.().height ?? element.offsetHeight ?? 0;
      const margin = 8;
      const gap = 12;
      let left = anchorRect.left - rootRect.left + (anchorRect.width - width) / 2;
      left = Math.max(margin, Math.min(left, Math.max(margin, rootRect.width - width - margin)));
      let top = anchorRect.top - rootRect.top - height - gap;
      if (top < margin) top = anchorRect.bottom - rootRect.top + gap;
      const maxTop = Math.max(margin, rootRect.height - height - margin);
      top = Math.max(margin, Math.min(top, maxTop));
      element.style.left = `${Math.round(left)}px`;
      element.style.top = `${Math.round(top)}px`;
    },
    hide() {
      setOpen(null);
      element.hidden = true;
    },
    isOpen() {
      return current.open !== null;
    },
    getSelectedIds() {
      return [...current.ids];
    }
  };
}

export default createSelectionBar;
