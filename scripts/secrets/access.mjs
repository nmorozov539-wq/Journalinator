const MODULE_ID = "fvtt-journalinator";

export function registerGmTierSettings() {
  game.settings.register(MODULE_ID, "assistantSecrets", {
    name: "Assistant GMs can use GM secrets",
    hint: "Lets Assistant GMs open the secrets vault and see hidden notes. With a passphrase vault they still need the passphrase.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => Hooks.callAll("journalinatorGmTierAccessChanged")
  });
}

/** Full GMs always; Assistant GMs when the world setting allows it. */
export function canUseGmTier(user = game.user) {
  if (!user?.isGM) return false;
  if (user.role >= CONST.USER_ROLES.GAMEMASTER) return true;
  return game.settings.get(MODULE_ID, "assistantSecrets") !== false;
}
