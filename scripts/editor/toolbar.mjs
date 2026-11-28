/**
 * Editor chrome builders: the required toolbar, writer/autosave row, Profile helper
 * and the untitled-note ghost. Everything here uses screen-sized controls and translation
 * keys; paper scaling and final card CSS belong to T8/T10.
 */

import { FONTS, PAPERS, resolveSkin } from "../skins/registry.mjs";
import { isLayout } from "../layouts/registry.mjs";

function button({ className, label, action, role, pressed }) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.dataset.action = action;
  if (role) element.setAttribute("role", role);
  if (typeof pressed === "boolean") element.setAttribute("aria-checked", String(pressed));
  element.textContent = label;
  // Keeping the caret/selection in the textarea is required even though the button itself
  // still receives click and keyboard activation.
  element.addEventListener("mousedown", event => event.preventDefault());
  return element;
}

function menuItem({ t, value, labelKey, checked, onSelect }) {
  const item = button({
    className: "jn-editor-menu-item",
    label: t(labelKey),
    action: value,
    role: "menuitemradio",
    pressed: checked
  });
  item.dataset.value = value;
  item.addEventListener("click", () => onSelect(value));
  return item;
}

function closeOnOutside(element, isInside, close) {
  const handler = event => {
    if (isInside(event.target)) return;
    close();
  };
  document.addEventListener("pointerdown", handler, true);
  return () => document.removeEventListener("pointerdown", handler, true);
}

/**
 * @param {Object} options
 * @param {Function} options.t
 * @param {(action: "title"|"divider"|"portrait"|"done") => void} options.onAction
 * @param {(layout: "plain"|"profile") => void} options.onLayout
 * @param {(patch: Object) => void} options.onSkinChange
 * @param {() => void} options.onBackgroundChoose
 * @param {() => void} options.onBackgroundRemove
 */
export function createToolbar({
  t,
  onAction,
  onLayout,
  onSkinChange,
  onBackgroundChoose,
  onBackgroundRemove
}) {
  const element = document.createElement("div");
  element.className = "jn-editor-toolbar";
  element.setAttribute("role", "toolbar");
  element.setAttribute("aria-label", t("JN.Editor.Toolbar"));

  const makeAction = (action, labelKey, className = "jn-editor-tool") => {
    const control = button({ className, label: t(labelKey), action });
    control.addEventListener("click", () => onAction(action));
    return control;
  };

  const titleButton = makeAction("title", "JN.Editor.Title");
  const dividerButton = makeAction("divider", "JN.Editor.Divider");
  const portraitButton = makeAction("portrait", "JN.Editor.Portrait");

  const separator = document.createElement("span");
  separator.className = "jn-editor-toolbar-separator";
  separator.setAttribute("role", "separator");
  separator.setAttribute("aria-orientation", "vertical");

  // Layout menu ---------------------------------------------------------------------------
  const layoutWrap = document.createElement("div");
  layoutWrap.className = "jn-editor-menu-wrap";
  layoutWrap.style.position = "relative";
  const layoutButton = makeAction("layout", "JN.Editor.Layout", "jn-editor-tool jn-editor-menu-button");
  layoutButton.setAttribute("aria-haspopup", "menu");
  layoutButton.setAttribute("aria-expanded", "false");
  const layoutMenu = document.createElement("div");
  layoutMenu.className = "jn-editor-menu jn-editor-layout-menu";
  layoutMenu.setAttribute("role", "menu");
  layoutMenu.hidden = true;
  layoutMenu.style.position = "absolute";
  layoutMenu.style.zIndex = "20";
  layoutWrap.append(layoutButton, layoutMenu);

  // Appearance popover --------------------------------------------------------------------
  const appearanceWrap = document.createElement("div");
  appearanceWrap.className = "jn-editor-menu-wrap";
  appearanceWrap.style.position = "relative";
  const appearanceButton = makeAction(
    "appearance",
    "JN.Editor.Appearance",
    "jn-editor-tool jn-editor-menu-button"
  );
  appearanceButton.setAttribute("aria-haspopup", "dialog");
  appearanceButton.setAttribute("aria-expanded", "false");
  const appearancePopover = document.createElement("div");
  appearancePopover.className = "jn-editor-popover jn-editor-appearance";
  appearancePopover.setAttribute("role", "dialog");
  appearancePopover.setAttribute("aria-label", t("JN.Editor.Appearance"));
  appearancePopover.hidden = true;
  appearancePopover.style.position = "absolute";
  appearancePopover.style.zIndex = "20";
  appearanceWrap.append(appearanceButton, appearancePopover);

  const doneButton = makeAction("done", "JN.Editor.Done", "jn-editor-tool jn-editor-done");

  element.append(
    titleButton,
    dividerButton,
    portraitButton,
    separator,
    layoutWrap,
    appearanceWrap,
    doneButton
  );

  let currentLayout = "plain";
  let currentSkin = resolveSkin(null);
  let closeOutside = null;
  let openMenu = null;

  const layoutItems = ["plain", "profile"].map(value => {
    const item = menuItem({
      t,
      value,
      labelKey: value === "profile" ? "JN.Layout.Profile" : "JN.Layout.Plain",
      checked: false,
      onSelect: layout => {
        setOpen(null);
        layoutButton.focus();
        onLayout(layout);
      }
    });
    layoutMenu.appendChild(item);
    return item;
  });

  const renderLayout = () => {
    for (const item of layoutItems) {
      const checked = item.dataset.value === currentLayout;
      item.setAttribute("aria-checked", String(checked));
      item.classList.toggle("is-selected", checked);
    }
    layoutButton.dataset.layout = currentLayout;
  };

  // Appearance: paper ---------------------------------------------------------------------
  const paperRow = document.createElement("div");
  paperRow.className = "jn-editor-appearance-row jn-editor-appearance-paper";
  const paperLabel = document.createElement("div");
  paperLabel.className = "jn-editor-appearance-label";
  paperLabel.textContent = t("JN.Skin.Paper");
  const swatches = document.createElement("div");
  swatches.className = "jn-editor-swatches";
  swatches.setAttribute("role", "radiogroup");
  swatches.setAttribute("aria-label", t("JN.Skin.Paper"));
  const paperButtons = new Map();
  for (const [paperId, paper] of Object.entries(PAPERS)) {
    const swatch = button({
      className: "jn-editor-swatch",
      label: t(paper.labelKey),
      action: paperId,
      role: "radio",
      pressed: false
    });
    swatch.dataset.paper = paperId;
    const dot = document.createElement("span");
    dot.className = "jn-editor-swatch-dot";
    dot.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "jn-editor-swatch-label";
    text.textContent = t(paper.labelKey);
    swatch.replaceChildren(dot, text);
    swatch.addEventListener("click", () => onSkinChange({ paper: paperId }));
    swatches.appendChild(swatch);
    paperButtons.set(paperId, swatch);
  }
  paperRow.append(paperLabel, swatches);

  // Appearance: font ----------------------------------------------------------------------
  const fontRow = document.createElement("div");
  fontRow.className = "jn-editor-appearance-row jn-editor-appearance-font";
  const fontLabel = document.createElement("div");
  fontLabel.className = "jn-editor-appearance-label";
  fontLabel.textContent = t("JN.Skin.Font");
  const fonts = document.createElement("div");
  fonts.className = "jn-editor-fonts";
  fonts.setAttribute("role", "radiogroup");
  fonts.setAttribute("aria-label", t("JN.Skin.Font"));
  const fontButtons = new Map();
  for (const [fontId, font] of Object.entries(FONTS)) {
    const choice = button({
      className: "jn-editor-font-choice",
      label: t(font.labelKey),
      action: fontId,
      role: "radio",
      pressed: false
    });
    choice.dataset.font = fontId;
    choice.addEventListener("click", () => onSkinChange({ font: fontId }));
    fonts.appendChild(choice);
    fontButtons.set(fontId, choice);
  }
  fontRow.append(fontLabel, fonts);

  // Appearance: torn edges ----------------------------------------------------------------
  const tornLabel = document.createElement("label");
  tornLabel.className = "jn-editor-appearance-torn";
  const tornInput = document.createElement("input");
  tornInput.type = "checkbox";
  tornInput.className = "jn-editor-torn";
  tornInput.addEventListener("change", () => onSkinChange({ torn: tornInput.checked }));
  const tornText = document.createElement("span");
  tornText.textContent = t("JN.Skin.Torn");
  tornLabel.append(tornInput, tornText);

  // Appearance: background ----------------------------------------------------------------
  const backgroundRow = document.createElement("div");
  backgroundRow.className = "jn-editor-appearance-row jn-editor-appearance-background";
  const backgroundLabel = document.createElement("div");
  backgroundLabel.className = "jn-editor-appearance-label";
  backgroundLabel.textContent = t("JN.Skin.BackgroundImage");
  const backgroundActions = document.createElement("div");
  backgroundActions.className = "jn-editor-appearance-actions";
  const backgroundChoose = button({
    className: "jn-editor-background-choose",
    label: t("JN.Skin.Choose"),
    action: "background-choose"
  });
  backgroundChoose.addEventListener("click", () => onBackgroundChoose());
  const backgroundRemove = button({
    className: "jn-editor-background-remove",
    label: t("JN.Skin.Remove"),
    action: "background-remove"
  });
  backgroundRemove.addEventListener("click", () => onBackgroundRemove());
  backgroundActions.append(backgroundChoose, backgroundRemove);
  backgroundRow.append(backgroundLabel, backgroundActions);

  appearancePopover.append(paperRow, fontRow, tornLabel, backgroundRow);

  const renderSkin = () => {
    const skin = resolveSkin(currentSkin);
    for (const [paperId, swatch] of paperButtons) {
      const checked = paperId === skin.paper;
      swatch.setAttribute("aria-checked", String(checked));
      swatch.classList.toggle("is-selected", checked);
    }
    for (const [fontId, choice] of fontButtons) {
      const checked = fontId === skin.font;
      choice.setAttribute("aria-checked", String(checked));
      choice.classList.toggle("is-selected", checked);
    }
    tornInput.checked = skin.torn;
    backgroundRemove.disabled = !skin.backgroundImage;
  };

  const setOpen = next => {
    if (closeOutside) {
      closeOutside();
      closeOutside = null;
    }
    openMenu = next;
    const layoutOpen = next === "layout";
    const appearanceOpen = next === "appearance";
    layoutMenu.hidden = !layoutOpen;
    appearancePopover.hidden = !appearanceOpen;
    layoutButton.setAttribute("aria-expanded", String(layoutOpen));
    appearanceButton.setAttribute("aria-expanded", String(appearanceOpen));
    if (next) {
      closeOutside = closeOnOutside(
        next === "layout" ? layoutWrap : appearanceWrap,
        target => (next === "layout" ? layoutWrap : appearanceWrap).contains(target),
        () => closeTransient({ restoreFocus: true })
      );
      if (layoutOpen) {
        (layoutItems.find(item => item.dataset.value === currentLayout) ?? layoutItems[0]).focus();
      } else {
        (paperButtons.get(resolveSkin(currentSkin).paper) ?? paperButtons.values().next().value)?.focus();
      }
    }
  };

  const closeTransient = ({ restoreFocus = true } = {}) => {
    const wasOpen = openMenu;
    setOpen(null);
    if (wasOpen && restoreFocus) {
      (wasOpen === "layout" ? layoutButton : appearanceButton).focus();
    }
    return !!wasOpen;
  };

  layoutButton.addEventListener("click", () => {
    setOpen(openMenu === "layout" ? null : "layout");
  });
  appearanceButton.addEventListener("click", () => {
    setOpen(openMenu === "appearance" ? null : "appearance");
  });

  // Escape/outside are handled by the editor through closeTransient(); this local key
  // listener also keeps the popover usable when focus is inside it.
  const onKeydown = event => {
    if (event.key !== "Escape" || event.isComposing || !openMenu) return;
    event.preventDefault();
    event.stopPropagation();
    closeTransient();
  };
  layoutMenu.addEventListener("keydown", onKeydown);
  appearancePopover.addEventListener("keydown", onKeydown);

  renderLayout();
  renderSkin();

  return {
    element,
    titleButton,
    dividerButton,
    portraitButton,
    layoutButton,
    layoutMenu,
    appearanceButton,
    appearancePopover,
    doneButton,
    setLayout(layout) {
      currentLayout = isLayout(layout) ? layout : "plain";
      renderLayout();
    },
    getLayout() {
      return currentLayout;
    },
    setSkin(skin) {
      currentSkin = resolveSkin(skin);
      renderSkin();
    },
    getSkin() {
      return resolveSkin(currentSkin);
    },
    closeTransient,
    isTransientOpen() {
      return openMenu !== null;
    },
    setDisabled(disabled) {
      for (const control of element.querySelectorAll("button")) {
        if (control === doneButton) continue;
        if (!disabled && control === backgroundRemove) {
          control.disabled = !resolveSkin(currentSkin).backgroundImage;
        } else {
          control.disabled = !!disabled;
        }
      }
    }
  };
}

/**
 * Secondary row: writer identity on the left, autosave status/actions on the right.
 */
export function createSecondaryRow({ t }) {
  const element = document.createElement("div");
  element.className = "jn-editor-subrow";

  const writer = document.createElement("span");
  writer.className = "jn-editor-writer";
  writer.textContent = t("JN.Editor.EditingYou");

  const status = document.createElement("span");
  status.className = "jn-editor-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const text = document.createElement("span");
  text.className = "jn-editor-status-text";
  const actions = document.createElement("span");
  actions.className = "jn-editor-status-actions";
  status.append(text, actions);

  element.append(writer, status);

  return {
    element,
    statusElement: status,
    setStatus({ text: label, state = "idle", actions: buttons = [] } = {}) {
      status.dataset.state = state;
      // Routine Saved/Saving churn is intentionally not announced; failures, lock changes
      // and terminal states are the only status messages screen readers should receive.
      const announce = ["saveFailed", "storageUnavailable", "rejected", "forced", "leaseLost", "denied"]
        .includes(state);
      status.setAttribute("aria-live", announce ? "polite" : "off");
      text.textContent = label ?? "";
      actions.replaceChildren();
      for (const entry of buttons) {
        const control = button({
          className: "jn-editor-status-action",
          label: entry.label,
          action: entry.id
        });
        control.dataset.action = entry.id;
        control.addEventListener("click", () => entry.onClick?.());
        actions.appendChild(control);
      }
    }
  };
}

/**
 * Compact Profile helper below the toolbar. It never enters the paper content and only
 * shows the first applicable issue for the current editor.
 */
export function createProfileHelper({ t, onAction }) {
  const element = document.createElement("div");
  element.className = "jn-editor-profile-helper";
  element.hidden = true;

  const message = document.createElement("div");
  message.className = "jn-editor-profile-message";
  const action = button({
    className: "jn-editor-profile-action",
    label: "",
    action: "profile"
  });
  action.hidden = true;
  const muted = document.createElement("div");
  muted.className = "jn-editor-profile-muted";
  muted.textContent = t("JN.Profile.Fallback");
  element.append(message, action, muted);

  const definitions = {
    "missing-title": { action: "title", labelKey: "JN.Profile.AddTitle" },
    "missing-portrait": { action: "portrait", labelKey: "JN.Profile.InsertPortrait" },
    "invalid-portrait": { action: "portrait", labelKey: "JN.Profile.ChooseImage" }
  };

  action.addEventListener("click", () => {
    const definition = definitions[element.dataset.issue];
    if (definition) onAction(definition.action);
  });

  return {
    element,
    actionButton: action,
    update(issue) {
      if (!issue) {
        element.hidden = true;
        element.dataset.issue = "";
        message.textContent = "";
        action.hidden = true;
        return;
      }
      element.hidden = false;
      element.dataset.issue = issue.code ?? "";
      message.textContent = issue.messageKey ? t(issue.messageKey) : "";
      const definition = definitions[issue.code];
      if (definition) {
        action.hidden = false;
        action.dataset.action = definition.action;
        action.textContent = t(definition.labelKey);
        action.setAttribute("aria-label", t(definition.labelKey));
      } else {
        action.hidden = true;
      }
    }
  };
}

/** Overlay affordance for an untitled card; never part of the saved body. */
export function createAddTitleGhost({ t, onClick }) {
  const ghost = button({
    className: "jn-editor-add-title",
    label: t("JN.Editor.AddTitleGhost"),
    action: "add-title"
  });
  ghost.style.position = "absolute";
  ghost.style.top = "20px";
  ghost.style.left = "20px";
  ghost.style.zIndex = "3";
  ghost.addEventListener("click", () => onClick());
  ghost.hidden = true;
  return ghost;
}
