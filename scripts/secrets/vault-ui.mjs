import { vaultStore } from "./vault-store.mjs";

const { DialogV2 } = foundry.applications.api;
const esc = text => foundry.utils.escapeHTML(String(text ?? ""));

const MODE_HELP = `
  <p><b>Passphrase (recommended).</b> Secrets are encrypted with a key only your passphrase opens.
  Players' browsers receive the encrypted vault but can't read it. Use something long, like four or
  five random words: anyone who copies the vault can try guesses offline.</p>
  <p><b>No passphrase.</b> Secrets are still encrypted, but the key sits next to them, so a player
  who opens the browser console can read everything. It only stops casual peeking.</p>`;

function keyForm({ requireCurrent = false } = {}) {
  return `
    <div class="jn-vault-form">
      ${MODE_HELP}
      <label><input type="radio" name="mode" value="passphrase" checked> Passphrase</label>
      <label><input type="radio" name="mode" value="open"> No passphrase</label>
      <div class="jn-vault-pass">
        <input type="password" name="passphrase" placeholder="Passphrase" autocomplete="new-password">
        <input type="password" name="confirm" placeholder="Repeat passphrase" autocomplete="new-password">
        <label><input type="checkbox" name="remember"> Remember on this browser</label>
      </div>
      ${requireCurrent ? `<p class="journalinator-meta">Changing this makes a brand-new key. The old passphrase stops working everywhere.</p>` : ""}
    </div>`;
}

function readKeyForm(form) {
  const mode = form.elements.mode.value;
  const passphrase = form.elements.passphrase.value;
  if (mode === "passphrase") {
    if (passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
    if (passphrase !== form.elements.confirm.value) throw new Error("The passphrases don't match.");
  }
  return { mode, passphrase, remember: form.elements.remember.checked };
}

async function promptKey(title, { requireCurrent = false } = {}) {
  return DialogV2.prompt({
    window: { title },
    position: { width: 460 },
    content: keyForm({ requireCurrent }),
    ok: {
      label: "Save",
      callback: (event, button) => {
        try { return readKeyForm(button.form); }
        catch (err) { ui.notifications.warn(err.message); return null; }
      }
    },
    rejectClose: false
  });
}

async function promptUnlock() {
  return DialogV2.prompt({
    window: { title: "Unlock GM Secrets" },
    content: `
      <input type="password" name="passphrase" placeholder="Passphrase" autofocus autocomplete="current-password">
      <label><input type="checkbox" name="remember"> Remember on this browser</label>`,
    ok: {
      label: "Unlock",
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
  catch (err) { ui.notifications.error(err.message); }
}

/** The single entry point the top bar button opens. Shows what fits the vault's current state. */
export async function openVaultDialog() {
  const status = vaultStore.status;

  if (status === "absent") {
    const choice = await promptKey("Set Up GM Secrets");
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
      window: { title: "GM Secrets" },
      content: `<p>The vault couldn't be decrypted: ${esc(vaultStore.error)}</p>
        <p>If another GM just changed the passphrase, lock and unlock again with the new one.</p>`,
      ok: { label: "Lock", callback: () => vaultStore.lock() },
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
    window: { title: "GM Secrets" },
    position: { width: 420 },
    content: `
      <p>${mode === "passphrase" ? "Protected by a passphrase." : "<b>No passphrase:</b> players with the browser console can read these secrets."}</p>
      <p class="journalinator-meta">${counts.notes} secret notes &middot; ${counts.blocks} hidden blocks &middot; ${counts.links} hidden links &middot; ${counts.labels} GM labels</p>`,
    buttons: [
      ...(mode === "passphrase" ? [{ action: "lock", label: "Lock on this browser" }] : []),
      { action: "rekey", label: mode === "passphrase" ? "Change passphrase or mode" : "Add a passphrase" },
      { action: "close", label: "Close", default: true }
    ],
    rejectClose: false
  });

  if (action === "lock") await run(() => vaultStore.lock());
  if (action === "rekey") {
    const choice = await promptKey("Change GM Secrets Key", { requireCurrent: true });
    if (choice) await run(() => vaultStore.setKeyring(choice));
  }
}
