/**
 * Thin wrapper over Foundry's localization. Call sites stay short, and tests get one seam:
 * when `game.i18n` is absent (plain Node), the key itself is returned.
 */
export function t(key, data) {
  const i18n = globalThis.game?.i18n;
  let text = i18n?.localize ? i18n.localize(key) : key;
  if (data && i18n?.format) text = i18n.format(text, data);
  return text;
}
