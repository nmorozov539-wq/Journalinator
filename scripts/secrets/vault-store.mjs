import { getContainerIds } from "../store/containers.mjs";
import {
  generateDataKey, createKeyring, openKeyring, encryptVault, decryptVault, exportRawKey, importRawKey
} from "./crypto.mjs";
import { emptyVault, normalizeVault, reconcileVault } from "./model.mjs";
import { canUseGmTier } from "./access.mjs";

const MODULE_ID = "fvtt-journalinator";
const NOTE_TYPE = `${MODULE_ID}.note`;
const REMEMBER_PREFIX = "journalinator.vaultKey.";

/**
 * The GM's decrypted view of the vault (spec §14). Lives only in GM clients.
 *
 * Storage: two flags on the GM Secrets JournalEntry — `keyring` and `vault` (ciphertext). Both
 * reach every client, which is fine: without the data key they are noise of a padded size.
 *
 * Writes never travel over the module socket (module socket messages are broadcast to every
 * client). A GM edits the vault directly from their own client; every write is a full
 * re-encryption of the vault, queued locally. Two GMs writing in the same instant can still
 * clobber each other at the vault level — acceptable for a GM-only store, and each client
 * reloads the vault as soon as another GM's write arrives.
 *
 * status: "unavailable" (not a GM-tier user) | "absent" (never set up) | "locked" |
 *         "unlocked" | "error" (could not decrypt with the key we had)
 */
class VaultStore {
  status = "unavailable";
  error = null;
  #key = null;
  #keyring = null;
  #data = null;
  #lastBlobIv = null;
  #queue = Promise.resolve();
  #watching = false;

  get data() { return this.#data; }
  get mode() { return this.#keyring?.mode ?? null; }
  get isUnlocked() { return this.status === "unlocked" && !!this.#data; }

  #entry() {
    const ids = getContainerIds();
    return ids?.secrets ? game.journal.get(ids.secrets) ?? null : null;
  }

  #flags() {
    return this.#entry()?.flags?.[MODULE_ID] ?? {};
  }

  #worldId() {
    return game.world?.id ?? "world";
  }

  #emit() {
    Hooks.callAll("journalinatorVaultChanged", this.status);
  }

  async init() {
    if (!canUseGmTier()) {
      this.#forget();
      this.status = "unavailable";
      this.#emit();
      return;
    }
    this.#watch();
    await this.#enqueue(() => this.#refresh());
  }

  #watch() {
    if (this.#watching) return;
    this.#watching = true;
    Hooks.on("updateJournalEntry", (doc, changes) => {
      if (doc.id !== getContainerIds()?.secrets) return;
      if (!changes?.flags?.[MODULE_ID]) return;
      if (!canUseGmTier()) return;
      this.#enqueue(() => this.#refresh());
    });
    Hooks.on("journalinatorGmTierAccessChanged", () => this.init());
  }

  #enqueue(job) {
    const run = this.#queue.then(job);
    this.#queue = run.catch(err => console.error("Journalinator: vault operation failed", err));
    return run;
  }

  /** Re-reads keyring + vault from the document. Never writes, except to tidy via reconcile. */
  async #refresh() {
    const { keyring, vault } = this.#flags();
    if (!keyring) {
      this.#forget();
      this.status = "absent";
      this.#emit();
      return;
    }

    if (!this.#key || this.#keyring?.keyId !== keyring.keyId) {
      this.#key = null;
      this.#keyring = keyring;
      if (keyring.mode === "open") {
        this.#key = await openKeyring(keyring, { worldId: this.#worldId() });
      } else {
        this.#key = await this.#rememberedKey(keyring.keyId);
      }
    }
    this.#keyring = keyring;

    if (!this.#key) {
      this.#data = null;
      this.status = "locked";
      this.#emit();
      return;
    }

    if (vault && vault.iv === this.#lastBlobIv && this.#data) return; // our own write echoing back
    try {
      this.#data = vault ? normalizeVault(await decryptVault(vault, this.#key, { worldId: this.#worldId() })) : emptyVault();
      this.#lastBlobIv = vault?.iv ?? null;
      this.status = "unlocked";
      this.error = null;
    } catch (err) {
      this.#data = null;
      this.status = "error";
      this.error = err.message;
    }
    this.#emit();
  }

  #forget() {
    this.#key = null;
    this.#keyring = null;
    this.#data = null;
    this.#lastBlobIv = null;
  }

  #storage() {
    try { return globalThis.localStorage ?? null; } catch { return null; }
  }

  async #rememberedKey(keyId) {
    const storage = this.#storage();
    if (!storage) return null;
    try {
      const raw = JSON.parse(storage.getItem(REMEMBER_PREFIX + this.#worldId()) ?? "null");
      if (!raw || raw.keyId !== keyId) return null;
      return await importRawKey(raw.raw);
    } catch {
      return null;
    }
  }

  async #remember(keyId, key) {
    const storage = this.#storage();
    if (!storage) return;
    try {
      storage.setItem(REMEMBER_PREFIX + this.#worldId(), JSON.stringify({ keyId, raw: await exportRawKey(key) }));
    } catch { /* storage full or blocked: the key just isn't remembered */ }
  }

  #clearRemembered() {
    try { this.#storage()?.removeItem(REMEMBER_PREFIX + this.#worldId()); } catch { /* ignore */ }
  }

  /**
   * First-time setup and every later keyring change. Always generates a fresh data key and
   * re-encrypts, so an old passphrase (or an "open" key someone already copied) never decrypts
   * future vault versions.
   */
  setKeyring({ mode, passphrase, remember = false }) {
    return this.#enqueue(async () => {
      const entry = this.#entry();
      if (!entry) throw new Error("Journalinator: the GM Secrets container is missing");
      if (this.#flags().keyring && !this.isUnlocked) throw new Error("Journalinator: unlock the vault before changing its key");

      const data = normalizeVault(this.#data ?? emptyVault());
      data.rev = (data.rev ?? 0) + 1;
      const key = await generateDataKey();
      const keyring = await createKeyring(key, { mode, passphrase, worldId: this.#worldId() });
      const blob = await encryptVault(data, key, { keyId: keyring.keyId, worldId: this.#worldId() });

      this.#key = key;
      this.#keyring = keyring;
      this.#data = data;
      this.#lastBlobIv = blob.iv;
      this.status = "unlocked";
      if (mode === "passphrase" && remember) await this.#remember(keyring.keyId, key);
      else this.#clearRemembered();

      await entry.update({
        [`flags.${MODULE_ID}.keyring`]: keyring,
        [`flags.${MODULE_ID}.vault`]: blob
      });
      this.#emit();
    });
  }

  unlock(passphrase, { remember = false } = {}) {
    return this.#enqueue(async () => {
      const { keyring } = this.#flags();
      if (!keyring) throw new Error("Journalinator: the vault has not been set up");
      const key = await openKeyring(keyring, { passphrase, worldId: this.#worldId() });
      this.#key = key;
      this.#keyring = keyring;
      this.#data = null;
      this.#lastBlobIv = null;
      if (remember) await this.#remember(keyring.keyId, key);
      await this.#refresh();
    });
  }

  /** Forgets the key in this browser. Only meaningful for passphrase vaults. */
  lock() {
    return this.#enqueue(async () => {
      this.#clearRemembered();
      if (this.#keyring?.mode === "open") return;
      this.#key = null;
      this.#data = null;
      this.#lastBlobIv = null;
      this.status = this.#flags().keyring ? "locked" : "absent";
      this.#emit();
    });
  }

  /**
   * Applies `fn(draft)` to a copy of the vault, re-encrypts, and writes it. Finished or
   * interrupted declassifications are tidied first (reconcileVault). Returns fn's result.
   * `fn` may be async but must not call mutate() itself.
   */
  mutate(fn) {
    return this.#enqueue(async () => {
      if (!this.isUnlocked) throw new Error("Journalinator: the secrets vault is locked");
      const entry = this.#entry();
      if (!entry) throw new Error("Journalinator: the GM Secrets container is missing");

      const draft = normalizeVault(foundry.utils.deepClone(this.#data));
      reconcileVault(draft, sharedInfo());
      const result = await fn(draft);
      draft.rev = (this.#data.rev ?? 0) + 1;

      const blob = await encryptVault(draft, this.#key, { keyId: this.#keyring.keyId, worldId: this.#worldId() });
      this.#data = draft;
      this.#lastBlobIv = blob.iv;
      this.#emit();
      await entry.update({ [`flags.${MODULE_ID}.vault`]: blob });
      return result;
    });
  }

  /** Runs reconcile on its own (e.g. after a declassification lands) and writes only if something changed. */
  tidy() {
    if (!this.isUnlocked) return Promise.resolve(false);
    const probe = normalizeVault(foundry.utils.deepClone(this.#data));
    if (!reconcileVault(probe, sharedInfo())) return Promise.resolve(false);
    return this.mutate(() => true);
  }
}

/**
 * Describes every shared note page that still exists (trash included), for reconcileVault.
 * Returns null when the shared container is unavailable (unset or not loaded): an empty map
 * would look like "the shared journal has no notes" and make reconcile treat every hidden
 * block and link as an orphan.
 */
function sharedInfo() {
  const ids = getContainerIds();
  const shared = ids ? game.journal.get(ids.shared) : null;
  if (!shared) return null;
  const notes = new Map();
  for (const page of shared?.pages ?? []) {
    if (page.type !== NOTE_TYPE) continue;
    notes.set(page.id, {
      blockIds: new Set((page.system.blocks ?? []).map(b => b.blockId)),
      deleted: !!page.system.deleted
    });
  }
  return { notes };
}

export const vaultStore = new VaultStore();
