import { t } from "../i18n.mjs";

const MODULE_ID = "fvtt-journalinator";

export function registerGmTierSettings() {
  game.settings.register(MODULE_ID, "assistantSecrets", {
    name: t("JN.Settings.AssistantSecretsName"),
    hint: t("JN.Settings.AssistantSecretsHint"),
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
