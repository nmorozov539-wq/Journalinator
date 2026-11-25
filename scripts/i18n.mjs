/**
 * Thin wrapper over Foundry's localization. Call sites stay short, and tests get one seam:
 * when `game.i18n` is absent (plain Node), the key itself is returned.
 */
export function t(key, data) {
  const i18n = globalThis.game?.i18n;
  return i18n?.localize ? i18n.localize(key, data) : key;
}
