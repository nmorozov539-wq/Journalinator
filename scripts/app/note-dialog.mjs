import { t } from "../i18n.mjs";
import { CARD_STYLES, cardStyleKey } from "../styles/registry.mjs";

export function defaultNoteTitle(kind, style) {
  return t(style === "wanted" ? "JN.Note.WantedName" : style === "memo" ? "JN.Style.Memo"
    : kind === "location" ? "JN.Note.NewLocationTitle" : "JN.Note.NewNoteTitle");
}

export function promptNewNote(windowTitle, { initialTitle, kind = "note", style = kind === "location" ? "document" : "sticky" } = {}) {
  const options = Object.entries(CARD_STYLES).map(([key, definition]) =>
    `<option value="${key}" ${key === cardStyleKey(style) ? "selected" : ""}>${t(definition.labelKey)}</option>`).join("");
  const initial = foundry.utils.escapeHTML(initialTitle ?? defaultNoteTitle(kind, style));
  return foundry.applications.api.DialogV2.prompt({
    window: { title: windowTitle },
    content: `<div class="form-group"><label for="jn-new-note-style">${t("JN.Editor.Style")}</label>
      <div class="form-fields"><select id="jn-new-note-style" name="style">${options}</select></div></div>
      <div class="form-group"><label for="jn-new-note-title">${t("JN.Prompt.NoteTitle")}</label>
      <div class="form-fields"><input id="jn-new-note-title" name="noteTitle" type="text" value="${initial}" autofocus></div></div>`,
    render: (_event, dialog) => {
      const select = dialog.element.querySelector('select[name="style"]');
      const input = dialog.element.querySelector('input[name="noteTitle"]');
      let previousDefault = defaultNoteTitle(kind, style);
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
        const title = noteTitle.value.trim();
        const defaultTitle = defaultNoteTitle(kind, selected.value);
        return { title: title || defaultTitle, style: selected.value, autoTitle: !title || title === defaultTitle };
      }
    },
    rejectClose: false
  });
}
