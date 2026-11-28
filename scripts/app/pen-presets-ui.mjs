import { THREAD_PRESET_IDS } from "../link-thread.mjs";
import { builtInPresets, sameStyle } from "../link-pen.mjs";

/**
 * The preset list shared by the right panel and the toolbar's pen menu: built-in presets, the
 * player's saved presets (with delete) and a "save current look" row. Pure markup plus one
 * binder, so both surfaces behave identically.
 */

const summary = (style, t) => {
  const material = t(`JN.Link.MaterialOption.${style.material}`);
  return `${material} · ${Number(style.thickness).toFixed(1)} px · ${Math.round(style.slack * 100)}%`;
};

export function renderPresetList({ pen, current, builtInLabel, t, esc }) {
  const row = (preset, name, removable) => {
    const on = sameStyle(preset.style, current)
      || (preset.builtIn && sameStyle({ ...current, ...preset.style, color: current.color, secondaryColor: current.secondaryColor,
        pattern: preset.style.pattern, ends: preset.style.ends }, current));
    return `<div class="jn-ft-preset-row${on ? " on" : ""}">
      <button type="button" class="jn-ft-preset" data-preset="${esc(preset.id)}"
        title="${esc(summary(preset.style, t))}" aria-pressed="${on}">${esc(name)}</button>
      ${removable ? `<button type="button" class="jn-ft-preset-delete" data-delete="${esc(preset.id)}"
        title="${esc(t("JN.Link.PresetDelete"))}" aria-label="${esc(t("JN.Link.PresetDelete"))}">✕</button>` : ""}
    </div>`;
  };
  const builtIns = builtInPresets().filter(preset => THREAD_PRESET_IDS.includes(preset.id))
    .map(preset => row(preset, builtInLabel(preset.id), false)).join("");
  const mine = pen.presets.map(preset => row({ ...preset, builtIn: false }, preset.name, true)).join("");
  return `
    <div class="jn-ft-presets" role="group" aria-label="${esc(t("JN.Link.Presets"))}">${builtIns}</div>
    ${mine ? `<div class="jn-ft-sub">${esc(t("JN.Link.PresetsMine"))}</div>
      <div class="jn-ft-presets jn-ft-presets-mine">${mine}</div>` : ""}
    <div class="jn-ft-save">
      <input type="text" class="jn-ft-preset-name" maxlength="40"
        placeholder="${esc(t("JN.Link.PresetName"))}" aria-label="${esc(t("JN.Link.PresetName"))}">
      <button type="button" class="jn-ft-preset-save">${esc(t("JN.Link.PresetSave"))}</button>
    </div>`;
}

export function bindPresetList(host, { apply, save, remove }) {
  host.querySelectorAll(".jn-ft-preset").forEach(button => {
    button.onclick = () => apply(button.dataset.preset);
  });
  host.querySelectorAll(".jn-ft-preset-delete").forEach(button => {
    button.onclick = () => remove(button.dataset.delete);
  });
  const name = host.querySelector(".jn-ft-preset-name");
  const commit = () => {
    const value = name.value.trim();
    if (!value) { name.focus?.(); return; }
    save(value);
  };
  host.querySelector(".jn-ft-preset-save").onclick = commit;
  name.onkeydown = event => {
    // Enter saves; keys typed here must not reach the canvas shortcuts (Backspace deletes).
    event.stopPropagation();
    if (event.key === "Enter") { event.preventDefault(); commit(); }
  };
}
