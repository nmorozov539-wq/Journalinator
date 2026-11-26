import { pickImage } from "../image-picker.mjs";
import { t } from "../i18n.mjs";

const { DialogV2 } = foundry.applications.api;
const esc = text => foundry.utils.escapeHTML(String(text ?? ""));

/**
 * Asks for a note image: paste an external URL or a Foundry data path, or use Browse to pick
 * a file. Returns the raw string (validation happens in the caller) or null when cancelled.
 */
export async function promptImageSource(title, initial = "", hint = "") {
  return DialogV2.wait({
    window: { title },
    position: { width: 460 },
    content: `
      <div class="jn-image-source">
        <div class="jn-image-source-row">
          <input type="text" name="value" autofocus value="${esc(initial)}">
          <button type="button" class="jn-image-browse">
            <i class="fa-solid fa-folder-open" aria-hidden="true"></i> ${t("JN.Editor.Browse")}
          </button>
        </div>
        ${hint ? `<p class="journalinator-meta">${esc(hint)}</p>` : ""}
      </div>`,
    render: (event, dialog) => {
      const input = dialog.form?.elements?.value ?? dialog.element?.querySelector('[name="value"]');
      dialog.element?.querySelector(".jn-image-browse")?.addEventListener("click", ev => {
        ev.preventDefault();
        pickImage(input);
      });
    },
    buttons: [
      {
        action: "ok",
        label: t("JN.Common.OK"),
        default: true,
        callback: (event, button) => button.form.elements.value.value.trim()
      },
      { action: "cancel", label: t("JN.Common.Cancel"), callback: () => null }
    ],
    rejectClose: false
  });
}
