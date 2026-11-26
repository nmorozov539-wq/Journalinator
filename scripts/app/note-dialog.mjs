import { t } from "../i18n.mjs";

/**
 * New-note presets. There is no Sticky or Torn entry: a plain new note is automatic
 * (compact/extended follows the content, Memo when extended), while the named presets force
 * extended so the chosen paper is visible immediately.
 */
export const NOTE_PRESETS = Object.freeze({
  auto: {
    labelKey: "JN.Style.Auto", style: "memo", extendedStyle: "memo", forceExtended: false
  },
  memo: {
    labelKey: "JN.Style.Memo", style: "memo", extendedStyle: "memo", forceExtended: true
  },
  document: {
    labelKey: "JN.Style.Document", style: "document", extendedStyle: "document", forceExtended: true
  },
  target: {
    labelKey: "JN.Style.Target", style: "wanted", extendedStyle: "target", forceExtended: true
  }
});

/** Maps a legacy style key or preset value onto one of NOTE_PRESETS. */
export function notePresetKey(style) {
  if (style === "wanted" || style === "target") return "target";
  if (style === "memo" || style === "document") return style;
  return "auto";
}

/** Resolves a creation request into a complete presentation, defaulting to automatic Memo. */
export function noteCreationPresentation({ kind = "note", style, presentation } = {}) {
  const explicit = presentation && typeof presentation === "object" && !Array.isArray(presentation)
    ? { ...presentation } : {};
  const hasExplicitStyle = typeof explicit.extendedStyle === "string";
  const presetKey = notePresetKey(style) !== "auto"
    ? notePresetKey(style)
    : (hasExplicitStyle && explicit.extendedStyle !== "memo" ? explicit.extendedStyle : "auto");
  const extendedStyle = hasExplicitStyle
    ? explicit.extendedStyle
    : (presetKey === "auto" ? "memo" : presetKey);
  const forceExtended = typeof explicit.forceExtended === "boolean"
    ? explicit.forceExtended
    : presetKey !== "auto";
  if (kind === "location") {
    return { ...explicit, extendedStyle: "document", forceExtended: true };
  }
  return { ...explicit, extendedStyle, forceExtended };
}

/** Legacy `system.style` value kept in sync with the presentation for older readers. */
export function noteCreationStyle({ kind = "note", style, presentation } = {}) {
  if (kind === "location") return "document";
  if (style === "target") return "wanted";
  if (typeof style === "string" && style && style !== "auto") return style;
  const extendedStyle = noteCreationPresentation({ kind, style, presentation }).extendedStyle;
  if (extendedStyle === "target") return "wanted";
  return extendedStyle === "document" ? "document" : "memo";
}

/** The default internal title for a preset. Auto still reads as a plain new note. */
export function defaultNoteTitle(kind, style) {
  const preset = notePresetKey(style);
  if (preset === "target") return t("JN.Note.WantedName");
  if (kind === "location") return t("JN.Note.NewLocationTitle");
  if (preset === "memo") return t("JN.Style.Memo");
  if (preset === "document") return t("JN.Style.Document");
  return t("JN.Note.NewNoteTitle");
}

export function promptNewNote(windowTitle, { initialTitle, kind = "note", style } = {}) {
  const initialPreset = notePresetKey(style);
  const options = Object.entries(NOTE_PRESETS).map(([key, definition]) =>
    `<option value="${key}" ${key === initialPreset ? "selected" : ""}>${t(definition.labelKey)}</option>`).join("");
  const initial = foundry.utils.escapeHTML(initialTitle ?? defaultNoteTitle(kind, initialPreset));
  return foundry.applications.api.DialogV2.prompt({
    window: { title: windowTitle },
    content: `<div class="form-group"><label for="jn-new-note-style">${t("JN.Editor.Style")}</label>
      <div class="form-fields"><select id="jn-new-note-style" name="style">${options}</select></div></div>
      <div class="form-group"><label for="jn-new-note-title">${t("JN.Prompt.NoteTitle")}</label>
      <div class="form-fields"><input id="jn-new-note-title" name="noteTitle" type="text" value="${initial}" autofocus></div></div>`,
    render: (_event, dialog) => {
      const select = dialog.element.querySelector('select[name="style"]');
      const input = dialog.element.querySelector('input[name="noteTitle"]');
      let previousDefault = defaultNoteTitle(kind, initialPreset);
      select.addEventListener("change", () => {
        const nextDefault = defaultNoteTitle(kind, select.value);
        if (!input.value.trim() || input.value === previousDefault) input.value = nextDefault;
        previousDefault = nextDefault;
      });
      input.focus();
      input.select();
    },
    ok: {
      label: t("JN.Common.OK"),
      callback: (_event, button) => {
        const { style: selected, noteTitle } = button.form.elements;
        const preset = NOTE_PRESETS[selected.value] ?? NOTE_PRESETS.auto;
        const title = noteTitle.value.trim();
        const defaultTitle = defaultNoteTitle(kind, selected.value);
        return {
          title: title || defaultTitle,
          style: preset.style,
          autoTitle: !title || title === defaultTitle,
          presentation: {
            extendedStyle: preset.extendedStyle,
            forceExtended: preset.forceExtended
          },
          label: ""
        };
      }
    },
    rejectClose: false
  });
}
