import { vaultStore } from "./vault-store.mjs";
import { t } from "../i18n.mjs";

const { DialogV2 } = foundry.applications.api;
const esc = text => foundry.utils.escapeHTML(String(text ?? ""));

function modeHelp() {
  return t("JN.Vault.ModeHelp");
}

/** Maps the few low-level vault errors a user can actually hit to localized text. */
function localizedError(err) {
  const message = String(err?.message ?? err ?? "");
  if (/wrong passphrase/i.test(message)) return t("JN.Vault.WrongPassphrase");
  if (/vault is locked/i.test(message)) return t("JN.Vault.LockedError");
  if (/has not been set up/i.test(message)) return t("JN.Vault.NotSetUp");
  if (/unlock the vault/i.test(message)) return t("JN.Vault.UnlockBeforeRekey");
  if (/passphrase is required/i.test(message)) return t("JN.Vault.PassphraseRequired");
  return message;
}

function keyForm({ requireCurrent = false } = {}) {
  return `
    <div class="jn-vault-form">
      ${modeHelp()}
      <label><input type="radio" name="mode" value="passphrase" checked> ${t("JN.Vault.PassphraseMode")}</label>
      <label><input type="radio" name="mode" value="open"> ${t("JN.Vault.OpenMode")}</label>
      <div class="jn-vault-pass">
        <input type="password" name="passphrase" placeholder="${t("JN.Vault.PassphrasePlaceholder")}" autocomplete="new-password">
        <input type="password" name="confirm" placeholder="${t("JN.Vault.RepeatPlaceholder")}" autocomplete="new-password">
        <label><input type="checkbox" name="remember"> ${t("JN.Vault.Remember")}</label>
      </div>
      ${requireCurrent ? `<p class="journalinator-meta">${t("JN.Vault.RekeyWarning")}</p>` : ""}
    </div>`;
}

function readKeyForm(form) {
  const mode = form.elements.mode.value;
  const passphrase = form.elements.passphrase.value;
  if (mode === "passphrase") {
    if (passphrase.length < 8) throw new Error(t("JN.Vault.MinLength"));
    if (passphrase !== form.elements.confirm.value) throw new Error(t("JN.Vault.Mismatch"));
  }
  return { mode, passphrase, remember: form.elements.remember.checked };
}

async function promptKey(title, { requireCurrent = false } = {}) {
  return DialogV2.prompt({
    window: { title },
    position: { width: 460 },
    content: keyForm({ requireCurrent }),
    ok: {
      label: t("JN.Vault.Save"),
      callback: (event, button) => {
        try { return readKeyForm(button.form); }
        catch (err) { ui.notifications.warn(localizedError(err)); return null; }
      }
    },
    rejectClose: false
  });
}

async function promptUnlock() {
  return DialogV2.prompt({
    window: { title: t("JN.Vault.UnlockTitle") },
    content: `
      <input type="password" name="passphrase" placeholder="${t("JN.Vault.PassphrasePlaceholder")}" autofocus autocomplete="current-password">
      <label><input type="checkbox" name="remember"> ${t("JN.Vault.Remember")}</label>`,
    ok: {
      label: t("JN.Vault.Unlock"),
      callback: (event, button) => ({
        passphrase: button.form.elements.passphrase.value,
        remember: button.form.elements.remember.checked
      })
    },
    rejectClose: false
  });
}

async function run(job) {
  try { await job(); }
  catch (err) { ui.notifications.error(localizedError(err)); }
}

/** The single entry point the top bar button opens. Shows what fits the vault's current state. */
export async function openVaultDialog() {
  const status = vaultStore.status;

  if (status === "absent") {
    const choice = await promptKey(t("JN.Vault.SetupTitle"));
    if (choice) await run(() => vaultStore.setKeyring(choice));
    return;
  }

  if (status === "locked") {
    const choice = await promptUnlock();
    if (choice) await run(() => vaultStore.unlock(choice.passphrase, { remember: choice.remember }));
    return;
  }

  if (status === "error") {
    await DialogV2.prompt({
      window: { title: t("JN.Vault.Title") },
      content: `<p>${t("JN.Vault.ErrorBody", { error: esc(localizedError(vaultStore.error)) })}</p>
        <p>${t("JN.Vault.ErrorHint")}</p>`,
      ok: { label: t("JN.Vault.Lock"), callback: () => vaultStore.lock() },
      rejectClose: false
    });
    return;
  }

  if (status !== "unlocked") return;
  const data = vaultStore.data;
  const counts = {
    notes: Object.keys(data.notes).length,
    blocks: Object.values(data.hiddenBlocks).reduce((n, e) => n + Object.keys(e.blocks ?? {}).length, 0),
    links: Object.values(data.hiddenLinks).reduce((n, l) => n + l.length, 0)
      + Object.values(data.notes).reduce((n, note) => n + (note.links?.length ?? 0), 0),
    labels: Object.keys(data.labels).length
  };
  const mode = vaultStore.mode;
  const action = await DialogV2.wait({
    window: { title: t("JN.Vault.Title") },
    position: { width: 420 },
    content: `
      <p>${mode === "passphrase" ? t("JN.Vault.Protected") : t("JN.Vault.OpenWarning")}</p>
      <p class="journalinator-meta">${t("JN.Vault.Counts", counts)}</p>`,
    buttons: [
      ...(mode === "passphrase" ? [{ action: "lock", label: t("JN.Vault.LockOnBrowser") }] : []),
      { action: "rekey", label: mode === "passphrase" ? t("JN.Vault.ChangeMode") : t("JN.Vault.AddPassphrase") },
      { action: "close", label: t("JN.Common.Close"), default: true }
    ],
    rejectClose: false
  });

  if (action === "lock") await run(() => vaultStore.lock());
  if (action === "rekey") {
    const choice = await promptKey(t("JN.Vault.ChangeKeyTitle"), { requireCurrent: true });
    if (choice) await run(() => vaultStore.setKeyring(choice));
  }
}
