/**
 * Opens Foundry's asset browser and writes the picked path into an input element.
 *
 * Foundry v14 exposes the concrete class as `foundry.applications.apps.FilePicker.implementation`;
 * older builds use the same namespace without `.implementation`, or the legacy global. Keep all
 * three in the fallback chain so the button never becomes a dead end.
 */
export function pickImage(input) {
  const FilePicker = globalThis.foundry?.applications?.apps?.FilePicker;
  const Picker = FilePicker?.implementation ?? FilePicker ?? globalThis.FilePicker;
  if (!Picker || !input) return;

  try {
    const current = input.value?.trim() || "";
    const picker = new Picker({
      type: "image",
      // An external URL is not a data path; start the browser at its last directory instead.
      current: /^https?:\/\//i.test(current) ? "" : current,
      callback: path => {
        input.value = path ?? "";
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.focus();
        input.select?.();
      }
    });
    if (typeof picker.browse === "function") picker.browse();
    else picker.render?.({ force: true });
  } catch (err) {
    console.error("Journalinator: could not open the file picker", err);
  }
}
